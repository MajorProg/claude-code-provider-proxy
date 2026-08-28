# Workflows

Key runtime processes, end to end.

---

## 1. Startup & runtime construction

```mermaid
sequenceDiagram
    participant M as main()
    participant CFG as loadConfig
    participant BR as buildRuntime
    participant TP as createBedrockTokenProvider
    participant DC as createHttpDiscoveryClient
    participant CM as CatalogManager.start

    M->>CFG: load JSONC + interpolate ${ENV} + validate
    CFG-->>M: ProxyConfig
    M->>BR: buildRuntime(config)
    BR->>TP: token provider (long-term key or dev minter)
    BR->>DC: discovery client (uses token provider)
    BR->>CM: initial discovery (fail-fast on primary region)
    CM-->>BR: CatalogManager (refresh scheduled, unref'd timer)
    BR-->>M: Runtime {config, tokenProvider, catalogManager, logStore}
    M->>M: Bun.serve(...) on HOST:PORT
```

Primary-region discovery failure aborts startup. Non-primary and external
provider discovery failures are logged and skipped.

---

## 2. Inference request (`POST /v1/messages`)

The inbound body is parsed **once** (`parseJsonObject(await req.text())`) at the
trust boundary; the resulting object is threaded through `runInference` (which
reads `model`, routes, and dispatches) and reused for capture — no handler
re-parses the body.

```mermaid
flowchart TD
    A["Receive request"] --> B["authenticateInbound (401 on fail)"]
    B --> C["parseJsonObject(await req.text()) — parse body ONCE"]
    C --> R["runInference(config, catalog, tokenProvider, parsed, headers, signal)"]
    R --> D["modelFromBody(parsed) → parseCanonicalId"]
    D --> E["route(config, catalog, id) → RouteTarget"]
    E --> F{"provider bedrock?"}
    F -->|yes| G["tokenProvider(awsRegion) → bearer, x-api-key style"]
    F -->|no external| H["static provider credential + configured auth style"]
    G --> I{"translationPath"}
    H --> I
    I -->|passthrough| P["handlePassthroughMessages — rewrite model, relay (parsed)"]
    I -->|converse| C2["handleConverseMessages — Anthropic⇄Converse via IR (parsed)"]
    I -->|mantle| M2["handleMantleMessages — Anthropic⇄OpenAI via IR (parsed)"]
    P --> Z["Anthropic Response"]
    C2 --> Z
    M2 --> Z
    Z --> L{"logging enabled?"}
    L -->|yes| T["maybeCaptureTurn (tee, reuses parsed) → LogStore"]
    L -->|no| RR["relay to client"]
    T --> RR
```

The internal chat endpoint (`POST /api/chat`) reuses the same `runInference` +
`maybeCaptureTurn` machinery: it parses its own `{model, system?, messages,
stream?}` body with `parseJsonObject`, builds a standard Anthropic request
object, and dispatches with the server-side credential.

---

## 3. Translation — Path C (Converse), non-streaming

```mermaid
sequenceDiagram
    participant H as handleConverseMessages
    participant IR as IR translators
    participant UP as postJson
    participant BR as bedrock-runtime

    H->>IR: anthropicToConverseRequest(body)
    H->>UP: POST /model/{id}/converse (Bearer)
    UP->>BR: Converse request
    BR-->>UP: Converse response (JSON)
    UP-->>H: response
    H->>IR: converseResponseToIr → irToAnthropicResponse
    H-->>H: Anthropic JSON response
```

Path M (Mantle) is analogous via `anthropicToOpenAIRequest` /
`openAIResponseToIr`, calling `/v1/chat/completions`.

---

## 4. Streaming translation → Anthropic SSE

```mermaid
sequenceDiagram
    participant UP as upstream stream
    participant DEC as decoder/parser
    participant EM as AnthropicSseEmitter
    participant CC as Claude Code

    Note over EM: emits message_start, content_block_*,<br/>message_delta, message_stop, ping
    UP-->>DEC: bytes (binary eventstream OR OpenAI data: lines)
    DEC->>EM: startTextBlock / appendText / startToolUseBlock / appendToolInputJson / finish
    EM-->>CC: event: <type>\ndata: <json>\n\n
    Note over EM,CC: synthetic ping during silent gaps (~5s)<br/>so Claude Code does not abort long pauses
```

- **Converse** streams binary `vnd.amazon.eventstream` frames decoded by
  `EventStreamDecoder`.
- **Mantle/OpenAI** streams `data: {json}` lines (terminated by `data: [DONE]`)
  parsed by `SseLineParser`; block boundaries are synthesized (OpenAI has none)
  and tool-call argument fragments re-emitted as `input_json_delta`.
- **Passthrough** relays the upstream Anthropic SSE unchanged.

---

## 5. Runtime discovery & refresh

```mermaid
flowchart LR
    START["CatalogManager.start"] --> DISC["discoverCatalog (all regions + external)"]
    DISC --> SNAP["new immutable Catalog"]
    SNAP --> TIMER["scheduleRefresh (setInterval, unref'd)"]
    TIMER -->|every refreshIntervalMinutes| DISC2["discoverCatalog"]
    DISC2 -->|success| SWAP["swap catalog"]
    DISC2 -->|failure| KEEP["keep previous catalog + warn"]
```

---

## 6. Config hot-reload (`POST /api/config`)

`reloadRuntime` is serialized by a single-flight `createSerializer()` mutex
(a promise chain), so concurrent `POST /api/config` calls apply strictly in
order — no interleave, no lost reload, no leaked `CatalogManager` timer. The
new runtime is **validated and fully built (including discovery) BEFORE the
config is persisted**, so a build/validation failure never writes a broken
config that would brick the next boot. On success the single runtime reference
is swapped atomically, then exactly the replaced `CatalogManager` and `LogStore`
are stopped (symmetric lifecycle). If `saveConfig` fails after the build, the
just-built runtime's `CatalogManager` is stopped and the running runtime is left
untouched.

```mermaid
sequenceDiagram
    participant UI as Config UI
    participant SR as serializeReload (single-flight mutex)
    participant V as validateConfig
    participant BR as buildRuntime (token + discovery + catalog + store)
    participant S as saveConfig
    participant RT as runtime reference

    UI->>SR: POST /api/config (raw config)
    SR->>V: validateConfig(raw)  %% throws → running runtime untouched
    SR->>BR: buildRuntime(next)  %% build + discover BEFORE persist; throws → untouched
    SR->>S: saveConfig (restore ${ENV} for secrets)
    Note over SR,S: save fails → stop just-built catalog, keep running runtime
    SR->>RT: atomic single-reference swap (runtime = newRuntime)
    SR->>RT: previous.catalogManager.stop(); previous.logStore.stop()
    SR-->>UI: { ok: true }
```

`saveConfig` restores `${VAR}` references for secret fields so a resolved secret
is never persisted to `config.local.jsonc`.

---

## 7. Log capture (best-effort tee)

```mermaid
flowchart TD
    R["Anthropic Response from path handler"] --> S{"streaming?"}
    S -->|no| J["parse JSON clone → TurnRecord (detached)"]
    S -->|yes| T["tee SSE: client branch relays, log branch accumulates"]
    T --> A["AnthropicStreamAccumulator → content, stop_reason, usage"]
    J --> W["LogStore.recordTurn / recordSystemPrompt"]
    A --> W
    W --> N["never blocks/alters client response"]
```

The detached streaming log-branch pump is bounded two ways so it can never
outlive the useful request: the log-branch reader is cancelled when the inbound
`req.signal` aborts (client disconnect) **and** by a wall-clock timeout
(`LOG_BRANCH_TIMEOUT_MS`, hung/slow upstream). Without these, a disconnected
client would leave the tee'd log branch pulling the upstream to completion —
holding the socket open and burning tokens/cost. A separate `MAX_CAPTURE_CHARS`
cap bounds accumulator memory (content past the cap is marked truncated).

```mermaid
sequenceDiagram
    participant CL as client branch
    participant LB as log branch (detached)
    participant ACC as AnthropicStreamAccumulator
    participant SIG as req.signal / timeout

    Note over CL: relayed to client verbatim
    LB->>ACC: read() loop → push(decoded chunk)
    SIG-->>LB: abort (client disconnect) OR timeout → reader.cancel()
    ACC->>ACC: content() + stopReason + usage
    LB->>LB: recordSystemPrompt + recordTurn (best-effort)
    Note over LB: finally: clearTimeout, remove abort listener, releaseLock
```

---

## 8. Dev token minting (local, no long-term key)

```mermaid
flowchart LR
    CRED{"config credential == dev/empty?"} -->|no| LONG["return long-term key (all regions)"]
    CRED -->|yes| ENV{"AWS_* env present?"}
    ENV -->|no| ERR["ConfigError"]
    ENV -->|yes| MINT["generateShortLivedBedrockToken (per region)"]
    MINT --> SIG["aws4fetch SigV4-presign CallWithBearerToken"]
    SIG --> TOK["base64 + prefix 'bedrock-api-key-'"]
```

Short-lived tokens are region-scoped, so one is minted per region; a long-term
key is region-agnostic.

---

## 9. Operator lifecycle (control CLI)

The CLI (`src/cli/`, `bun run cli <cmd>`, or via `bootstrap.sh`/`.ps1`) drives
setup and run in `--local` (bare Bun) or `--docker` (compose) mode.

```mermaid
flowchart TD
    BOOT["bootstrap.sh / .ps1"] -->|install Bun if missing| CLI["bun run cli <cmd>"]
    CLI --> SETUP["setup"]
    SETUP --> DEPS["check Bun/Docker; install Claude Code"]
    SETUP --> CFG["copy .env + config.local.jsonc from examples"]
    SETUP --> TOK["ensure/rotate PROXY_INBOUND_KEY"]
    SETUP --> BIND["derive + persist BIND_IP"]
    SETUP --> CLA["write ~/.claude/settings.json (backup first)"]
    CLI --> UP["up / start"]
    UP --> MODE{"mode"}
    MODE -->|local| LP["spawn detached bun run src/server.ts (pid file)"]
    MODE -->|docker| DC["docker compose up -d --build (publish on BIND_IP + 127.0.0.1)"]
    CLI --> DOWN["down / stop → kill pid | compose down"]
    CLI --> DOC["doctor → deps, .env/config, BIND_IP checks"]
```

- `setup` is idempotent and never overwrites an existing real auth token unless
  `--rotate` is passed.
- Docker mode **requires** a `BIND_IP`; local mode binds the server directly to
  the derived LAN IP (falling back to `127.0.0.1`).
- Client model ids (`ANTHROPIC_MODEL`/`ANTHROPIC_SMALL_FAST_MODEL`) are read
  from `.env`, keeping model ids out of `src/`.

---

## 12. Testing lanes

Two lanes exercise the **real** translation/routing/streaming code; the mock is
confined to the outbound HTTP boundary (`globalThis.fetch`), and the fixtures it
replays are authentic captured upstream responses (never fabricated).

- **Hermetic lane (merge gate)** — `bun run test:unit` (`bun test`). Live suites
  register themselves via `describeLive` (`tests/helpers/live.ts`) and become
  `describe.skip` unless `RUN_LIVE=1`, so this lane touches no network. The
  fixture suites install the `globalThis.fetch` mock from
  `tests/helpers/fetch-mock.ts` and replay `tests/fixtures/*` (`.json` bodies,
  `.sse` text streams, base64 `.b64` binary eventstreams) through the real
  handlers — deterministic, zero provider cost.
- **Live lane (source of truth)** — `bun run test:live` (`RUN_LIVE=1 bun test`).
  `describeLive` runs only when `RUN_LIVE=1` **and** AWS creds are present;
  `awsCreds()` reads them in `beforeAll`, and `providerKeyPresent()` lets
  external-provider suites skip individually when a provider key is absent. This
  lane hits real endpoints and is the ultimate source of truth.

```mermaid
flowchart LR
    CAP["bun run test:capture<br/>(scripts/capture-fixtures.ts)"] -->|records raw upstream| FIX["tests/fixtures/*.json|.sse|.b64"]
    FIX --> HERM["Hermetic: bun run test:unit"]
    HERM --> FM["fetch-mock.ts replays fixtures via globalThis.fetch"]
    FM --> REAL["real handlers (Path P/C/M) run"]
    LIVE["Live: RUN_LIVE=1 bun test"] --> ENDP["real provider endpoints (creds from env)"]
    ENDP -.re-capture on contract change.-> CAP
```

The capture step (`bun run test:capture` → `scripts/capture-fixtures.ts`) is run
manually with live creds; it drives the real handlers against live Bedrock while
wrapping `globalThis.fetch` to record the raw pre-translation upstream bodies
into `tests/fixtures/`. Re-run it when a provider's upstream contract changes.
