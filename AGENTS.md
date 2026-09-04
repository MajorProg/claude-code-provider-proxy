# AGENTS.md

Guidance for AI agents (and humans) working in this repository. Read this before
making changes. A navigable code summary lives in
[`docs/index.md`](docs/index.md) — start there to route a question to the right
document without reading every file. This file's **Custom Instructions** section
(below) holds the binding project rules and the live-verified per-provider facts.

---

## What this repo is

An Anthropic-Messages-mode HTTP proxy (Bun + strict TypeScript) that lets Claude
Code drive any AWS Bedrock model — Claude and non-Claude — plus external
providers, behind one Anthropic-compliant endpoint. Inbound is the Anthropic
Messages API; outbound is translated per model. Model availability is
**discovered at runtime** — there is no hardcoded model catalog. **Bedrock is
optional**: with no (or a placeholder) Bedrock credential the proxy runs on
external providers only; no discovery failure is fatal (see Custom
Instructions).

---

## Navigation — where things live

```
src/
  server.ts            HTTP entrypoint (Bun.serve): route table, runtime, hot-reload
  config.ts            Config load + ${ENV} interpolation + validate + serialize
  errors.ts            ProxyError taxonomy (rendered as Anthropic error bodies)
  router.ts            Canonical id -> RouteTarget (selects translation path)
  model/
    canonical-id.ts    parseCanonicalId / formatCanonicalId / isAnthropic
    catalog.ts         Runtime discovery, Catalog, CatalogManager, resolveInvocationId
  ir/types.ts          Provider-neutral intermediate representation (Paths C & M)
  paths/
    passthrough.ts     Path P — Claude / native-Anthropic (relay, no IR)
    converse.ts        Path C — Anthropic <-> Bedrock Converse
    mantle.ts          Path M — Anthropic <-> OpenAI Chat Completions
    relay.ts           Shared trust-boundary + relay helpers; irToAnthropicResponse
  stream/
    anthropic-sse.ts   AnthropicSseEmitter (+ synthetic ping keep-alive)
    converse-events.ts Bedrock binary eventstream decoder -> Anthropic SSE
    openai-sse.ts      OpenAI SSE line parser -> Anthropic SSE
  auth/
    inbound.ts         Validate Claude Code's inbound key (constant-time)
    bedrock-token.ts   Mint short-lived dev Bedrock token (SigV4 via aws4fetch)
    token-provider.ts  Long-term (region-agnostic) vs dev (per-region, cached) token
  http/
    upstream.ts        Outbound fetch + header builders + retry (postJson)
    registry-page.ts / config-page.ts / log-viewer-page.ts / chat-page.ts
    shell.ts / zip.ts  Shared HTML shell; dependency-free ZIP for log exports
  logging/
    log-store.ts       LogStore, TurnRecord, SystemPromptMeta (config-gated)
    capture.ts         Turn capture via transparent stream tee
    logger.ts          Leveled structured logger + request-id correlation
  cli/                 Cross-platform Bun control CLI (setup/up/down/restart/
                       status/logs/config-claude/doctor) — local & Docker modes
tests/                 bun:test suites: hermetic (merge gate) + live, + helpers/
scripts/               capture-fixtures.ts — record real upstream fixtures (live)
docs/                  Generated code summary (index.md is the AI entry point)
bootstrap.sh / .ps1    Tiny shims: install Bun if missing, then run the Bun CLI
```

### Key entry points
- **`src/server.ts` → `main()`** — loads config, builds the `Runtime`
  (token provider + discovery + catalog + log store), starts `Bun.serve`, and
  owns the declarative route table + `reloadRuntime` (serialized, atomic config
  hot-reload). `createFetchHandler(getRuntime, reloadRuntime)` is the testable
  request handler; routing/auth/CSRF is data-driven by the `ROUTES` table.
- **`src/router.ts` → `route()`** — the single point that maps a canonical id to
  an outbound `RouteTarget` and picks the translation path.
- **`src/cli/index.ts` → `main()`** — the operator CLI (`bun run cli <cmd>`).

### The three translation paths
- **P (passthrough)** — Claude on Mantle's native Anthropic route and external
  `type: anthropic` providers. Rewrites only `model`; relays body/SSE verbatim.
- **C (converse)** — any `bedrock.converse.*` model, via the IR.
- **M (mantle)** — non-Claude on Mantle and external `type: openai` providers,
  via the IR.

---

## Repo-specific tools & config-discoverable facts

- **Bun control CLI** (`src/cli/`, `bun run cli <cmd>`) is the single operator
  surface — `setup`/`up`/`down`/`restart`/`status`/`logs`/`config-claude`/
  `doctor`, in `--local` (bare Bun process) or `--docker` (compose) mode.
  `bootstrap.sh` / `bootstrap.ps1` are tiny shims that only install Bun then hand
  off to the CLI (there are no other shell scripts). `setup` auto-generates the
  shared `PROXY_INBOUND_KEY` and auto-derives `BIND_IP`; the Claude Code model
  ids live in `.env` (`ANTHROPIC_MODEL`/`ANTHROPIC_SMALL_FAST_MODEL`), never in
  `src/`.
- **Biome** (`biome.json`): 100-char line width — long lines fail lint. `format`
  targets `src/` **and** `tests/`; `lint` targets `src/` only.
- **tsconfig**: `allowImportingTsExtensions` + `verbatimModuleSyntax` require
  explicit `.ts` import extensions and `import type` for type-only imports.
  Strict flags include `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
- **Docker/compose**: the port is published only on `${BIND_IP}` (LAN) +
  `127.0.0.1`, never `0.0.0.0`. Compose requires `BIND_IP` and
  `PROXY_INBOUND_KEY` (both `:?`-gated); `BEDROCK_API_KEY` is optional
  (`:-`-gated, empty disables Bedrock). In `--local` mode `BIND_IP` becomes the
  server `HOST` bind.
- **Config**: `config.local.jsonc` (JSONC) with `${ENV}` interpolation — bare
  `${VAR}` fails fast when unset/empty, `${VAR:-default}` (bash-like, empty
  default allowed) is the "configured but inactive until the env var is set"
  form; secrets are restored to `${ENV}` form on UI save. `.env`,
  `config.local.jsonc`, and AWS creds are git-ignored.
- **Bedrock is optional** (`src/auth/bedrock-mode.ts`): an absent
  `providers.bedrock` block, an empty/placeholder (`REPLACE_ME`) credential, or
  `dev` without AWS env creds ⇒ Bedrock disabled (external providers only); the
  decision is never fatal. Discovery failures (any region, incl. primary) are
  non-fatal — each source gets a `SourceStatus` (`ok|error|skipped|disabled`)
  on the immutable `Catalog`, surfaced in `/status.json` + `/api/config/status`
  + `doctor`. Requests for a disabled provider get a clean 404
  `ProviderDisabledError`; `Runtime.tokenProvider` is `| null` when disabled.
- **Declarative route table**: `server.ts` matches requests against a `ROUTES`
  array (`{method, match, requiresAuth, requiresCsrf?, handler}` with
  `exact()`/`prefix()` matchers), so auth + CSRF policy is data-driven per route,
  not scattered through the handler. `POST /api/config` and `POST /api/chat`
  additionally require the `x-ccpp-csrf` header + same-origin `Origin`; HTML
  pages carry a CSP + `nosniff` + `no-referrer`.
- **Trust-boundary/relay helpers**: `paths/relay.ts` centralizes untrusted-JSON
  parsing (`parseJsonObject`/`parseUpstreamJson`), the upstream-error relay
  (`assertUpstreamOk`), header relaying, and the shared `irToAnthropicResponse`
  serializer used by both Path C and Path M — prefer these over ad-hoc
  `JSON.parse(...) as T` at any boundary.
- **Two-lane tests + fixtures**: the hermetic merge gate (`bun run test:unit`)
  mocks only `globalThis.fetch` and replays real captured upstream responses in
  `tests/fixtures/`; regenerate them with `bun run test:capture`
  (`scripts/capture-fixtures.ts`, needs live creds). The live lane is
  `RUN_LIVE=1 bun test` (`test:live`).

---

## Custom Instructions

<!-- This section is for human and agent-maintained operational knowledge.
     Add repo-specific conventions, gotchas, and workflow rules here.
     This section is preserved exactly as-is when re-running codebase-summary. -->

### Non-negotiable rules

1. **No placeholders, no shortcuts; real logic, real data.** Every
   dependency-injection interface MUST have a real production implementation,
   and tests MUST exercise real translation/routing/streaming code — never
   fabricated logic or hand-invented "expected" provider payloads. Two test
   lanes are supported:
   - **Live lane** (`RUN_LIVE=1 bun test`) hits real provider endpoints using
     env credentials. This is the ultimate source of truth and MUST stay green.
   - **Hermetic lane** (`bun run test:unit`, the merge gate) mocks ONLY the
     outbound HTTP boundary (`globalThis.fetch`) and replays **real upstream
     responses captured once from live endpoints** (`tests/fixtures/`, produced
     by `scripts/capture-fixtures.ts`). This gives full behavioral coverage with
     no ongoing provider cost. The mock is limited to the network edge; all code
     under test is the real implementation, and fixtures are authentic captured
     data (never fabricated). Re-capture fixtures when provider contracts change.
2. **Zero errors, zero warnings.** `bun run typecheck` and `bun run lint` MUST
   both exit 0 before any task is considered done.
3. **No hardcoded model catalogs.** Model/region specifics are discovered at
   runtime (`src/model/catalog.ts`) or read from config. Never embed literal
   model IDs in `src/` (tests may reference them).
4. **Never commit secrets.** `.env`, `config.local.jsonc`, and AWS credentials
   are git-ignored. Reference secrets by env-var name, never by value.

### Toolchain & definition of done

- Runtime: **Bun** (see `package.json` / lockfile). TypeScript is strict.
- `bun run typecheck` — `tsc --noEmit`, strict + `noUncheckedIndexedAccess` +
  `exactOptionalPropertyTypes` + `verbatimModuleSyntax`.
- `bun run lint` — Biome. `bun run format` — Biome auto-format (**run before
  lint**; long lines >100 fail lint).
- `bun test` — runs unit and live tests. Live tests need
  `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (+ `AWS_SESSION_TOKEN`), and the
  relevant external-provider API keys for provider-specific suites.

Definition of done for any task:

```
bun run format && bun run typecheck && bun run lint && bun test
```

All must pass with zero errors/warnings, and any new behavior must have tests.

### Conventions & known gotchas

- **Imports:** use explicit `.ts` extensions (`allowImportingTsExtensions` +
  `verbatimModuleSyntax`). Use `import type` for type-only imports.
- **Headers type collision:** `new Request()` in tests can resolve to
  `undici-types` `Headers`, which lacks Bun's `toJSON/count/getAll`. Do **not**
  annotate params as the global `Headers`. Use a structural type
  (`interface HeaderReader { get(name): string | null }`). See `src/auth/inbound.ts`.
- **Biome `useTemplate`:** forbids string concatenation — use a single template
  literal.
- **`bun run format` targets `src/` and `tests/`; `bun run lint` targets `src/`
  only.** Keep `tests/` clean regardless.
- **Timers:** the `setInterval` used for catalog refresh is `unref()`'d so it
  never keeps the process alive on its own (see `CatalogManager`).

### Verified provider facts

These are confirmed against live endpoints; treat them as the source of truth
when wiring or debugging a provider.

**Bedrock**
- One **Bedrock bearer token** authenticates all routes on both backends **and**
  the control-plane (`/foundation-models`, `/inference-profiles`). Discovery and
  inference share the same credential.
- **Short-lived** Bedrock tokens are **region-scoped** (a `us-east-1` token is
  rejected `403` by the `eu-west-1` control-plane). Use a per-region token
  provider. A **long-term** key is region-agnostic (recommended for production).
- **Claude on Mantle's OpenAI route is rejected**; Claude uses the native
  `/anthropic/v1/messages` route (works on both `bedrock-runtime` and
  `bedrock-mantle`).
- **Inference-profile-only models** (Claude, some Llama) reject bare IDs; resolve
  to a `global.*` or `<region>.*` profile. `ON_DEMAND` models accept bare IDs.
- Default regions by measured coverage: **`us-east-1`** (richest) + **`eu-west-1`**
  (richest EU with both backends). `eu-west-3` has no Mantle endpoint.
- **Images (TC6, live-verified):** Converse accepts an image only as base64
  `image.source.bytes` (a JSON base64 string) with a `format` token derived from
  the media type — it has **no URL image support**, so a `url`-source Anthropic
  image degrades to a placeholder text block. Mantle's OpenAI route accepts
  `image_url` as a **data: URI or an S3 URL only** — a plain `http(s)` image URL
  is rejected `400 "Only inline image data URLs and S3 URLs are supported"`, so a
  `url`-source image is passed through (correct for real OpenAI / external
  providers that accept http URLs) and surfaces a clean relayed 400 on Mantle;
  we never server-side-fetch a URL to inline it (SSRF). Inbound `media_type` is
  validated against {png,jpeg,gif,webp}, defaulting an unknown base64 media type
  to `image/png`.

**External (non-Bedrock) providers**
- Providers are a keyed map under `config.providers`; each non-`bedrock` entry
  carries a `type` discriminator: `anthropic` (native Anthropic → passthrough
  path) or `openai` (OpenAI Chat Completions → mantle translation path). Drive
  path selection off `type`, **not** the model-name substring.
- **No model ids in source OR config.** External providers supply a `modelsUrl`
  (an OpenAI-style `/models` discovery endpoint); ids are fetched at runtime and
  refreshed on the same cadence as Bedrock. `modelsUrl` is a discovery endpoint,
  exactly like Bedrock's `hosts.control`.
- Canonical id backends: `converse | mantle | anthropic | openai`. External
  models are single-endpoint → `profilePrefix = global`, addressable as
  `<provider>.anthropic.global.<model>` (or `.openai.`).
- Credential resolver is per-provider: Bedrock uses region-aware token minting;
  external providers return their static config API key. Header auth style is
  `auth: "x-api-key" | "bearer"` (`buildAnthropicHeaders(..., authStyle)`).
- **Discovery always uses bearer.** External-provider `/models` discovery sends
  `Authorization: Bearer` regardless of the provider's message-path `auth` —
  some providers reject `x-api-key` on `/models` (`401`), but the OpenAI
  `/models` convention is bearer, which all providers accept.
- **Host templating** (for workspace/regional domains, e.g. Alibaba): a provider
  may set `hostTemplate` (`{workspaceId}`/`{region}` placeholders) + `workspaceId`
  + `region` + `basePath` instead of a flat `baseUrl`; `externalProviderOrigin()`
  builds the origin.

Per-provider, verified live:

| Provider | `type` | Auth | Endpoint | `count_tokens` | Discovery | Notes |
|---|---|---|---|---|---|---|
| DeepSeek | anthropic | x-api-key | `api.deepseek.com/anthropic` | ✅ | `api.deepseek.com/v1/models` | Single global endpoint. |
| z.ai / GLM | anthropic | bearer | `api.z.ai/api/anthropic` | ✅ | `api.z.ai/api/paas/v4/models` | Single global endpoint. |
| Gemini | openai | bearer | `generativelanguage.googleapis.com/v1beta/openai` | ❌ | `.../v1beta/openai/models` | Discovery returns `models/gemini-…`; the `models/` prefix is stripped. |
| Alibaba / Qwen | anthropic | x-api-key | `dashscope-intl.aliyuncs.com/apps/anthropic` | ✅ | `.../compatible-mode/v1/models` | Host-templated; EU (Frankfurt) by default. |
| EUrouter | openai | bearer | `api.eurouter.ai/v1` | ❌ | `.../v1/models` | EU data-residency router (not openrouter.ai). |
| Mistral | openai | bearer | `api.mistral.ai/v1` | ❌ | `.../v1/models` | OpenAI-compatible. |
| Moonshot / Kimi | anthropic | bearer | `api.moonshot.ai/anthropic` | ❌ | `api.moonshot.ai/v1/models` | Returns `thinking` blocks. |

### Security & configuration

- **`${ENV}` preserved on UI save.** `saveConfig` restores `${VAR}` references
  for secret fields (exact-match for credentials/workspaceId/keys;
  embedded-restore for URLs) so a save never bakes a resolved secret into
  `config.local.jsonc`. `GET /api/config` still returns resolved values for
  display only.
- **LAN-only bind.** The container listens on `0.0.0.0:8787` internally, but the
  host publishes the port **only** on `${BIND_IP}` (LAN IPv4) + `127.0.0.1` —
  never `0.0.0.0`. Compose requires `BIND_IP`; the Bun CLI auto-derives it
  (RFC-1918, physical interface, excluding VPN/virtual NICs) and writes it to
  `.env`. In `--local` mode it becomes the server `HOST` bind. This keeps the
  service off VPN/public interfaces at the network layer.
- **Prompt caching.** Provider-native prompt caching needs no code: the
  passthrough path forwards `cache_control` markers verbatim, and OpenAI-type
  providers cache automatically. Gateway-side semantic response caching is
  intentionally not implemented (leakage risk, low hit rate for coding).

### Threat model (operator-trust boundary)

The management surface (`/api/config*`, `/api/logs/*`, `/api/chat`, and the
`/config`/`/logs`/`/chat` HTML shells' API calls) is gated behind the inbound
key (`authenticateInbound`); `POST /api/config` and `POST /api/chat` additionally
require the CSRF header + same-origin `Origin`. Within that gate, two exposures
are **accepted by design** — the holder of a valid inbound key is treated as a
trusted operator. Both are called out here so they are not mistaken for defects:

1. **`GET /api/config` returns fully-resolved secrets to any valid-key holder.**
   The response includes the resolved Bedrock credential, external-provider API
   keys, and the inbound keys themselves in cleartext — this is intentional so
   the operator can view/edit the keys they manage (reveal-on-demand in the UI;
   `${ENV}` form is restored on save so resolved values are never persisted to
   `config.local.jsonc`). The short-lived minted SigV4 dev token is the one
   exception: `describeAuth` returns metadata only (mode/region/expiry/awsPresent),
   never the token, since it is regenerable. **Blast radius:** a single leaked
   inbound key lets an attacker enumerate *every* other configured
   key/provider secret. Treat the inbound key as a high-value credential; rotate
   it (`bun run cli setup --rotate`) if exposure is suspected. If operators are
   *not* trusted, mask secrets in the GET response (last-4) instead of returning
   resolved values — this is deliberately not done today.

2. **Authenticated config-write == blind SSRF-with-credential.** An authenticated
   operator can `POST /api/config` setting an external provider's `modelsUrl` /
   `baseUrl` to an arbitrary host; runtime discovery then fetches that URL **with
   a Bearer credential attached**, and message-path handlers fetch derived paths.
   `isSecureExternalUrl` enforces `https://` (which blocks plain-HTTP
   `localhost`→metadata probes), but internal/link-local **HTTPS** hosts (e.g.
   `https://169.254.169.254`, RFC-1918 ranges) remain reachable. This is inherent
   to a *configurable* proxy and is admin-gated. If operators are untrusted, add
   an origin allow/deny list for discovery + message fetches (block link-local /
   RFC-1918 / metadata IPs) — deliberately not done today, as the operator is
   trusted and the LAN bind limits reachability.

3. **Trust-preserving system-hoisting (SEC-5).** The IR-path normalizer
   (`normalize.ts`, Paths C/M only — Path P relays verbatim) hoists a
   `role: "system"` message into the top-level system prompt **only when it
   appears before the first user turn**. A `role: "system"` message that arrives
   *after* the conversation has started (e.g. an injected mid-conversation
   `<system-reminder>`) is **not** elevated to system-prompt trust — it is
   demoted to a `user` turn so its text is still delivered but attributed to the
   conversation, not the authoritative system prompt (OWASP LLM01 mitigation).
   This depends on TC4's same-role merge: a demoted trailing system message can
   produce consecutive user turns, which the Converse mapper coalesces
   (live-verified: Bedrock Converse accepts the merged result 200 OK).

### Token generation (dev/testing)

A short-lived Bedrock API key is a SigV4-presigned `CallWithBearerToken`
request, base64-encoded and prefixed `bedrock-api-key-`. Implemented in
`src/auth/bedrock-token.ts` via `aws4fetch`. Production uses a long-term key from
config; the proxy never needs to mint keys in production.

### When adding a provider

1. Add the provider entry under `config.providers` with its credential + hosts
   (or a `modelsUrl` discovery endpoint for an external provider).
2. Add discovery (or a static capability source) — still no hardcoded model IDs.
3. Add routing in `src/router.ts` and, if a new path is needed, a translation
   handler under `src/paths/`.
4. Add tests (live where possible), and record verified specifics in this file's
   "Verified provider facts" table.

## Steering

See [Steering](.ktools/steering/) for project guidelines.
