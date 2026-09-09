# Virtual Model Tiers & Provider Key Pools — Design

Status: **implemented** (2026-09-06; hermetic suites `tests/virtual-tiers.test.ts`,
`tests/failover.test.ts`, pool coverage in `config*`/`catalog-graceful`/
`server-dispatch`/`capture-wiring`/`cli-*`). The engine lives in `src/failover.ts`;
tier expansion in `src/router.ts` (`routeCandidates`/`virtualTierStatuses`);
pools validate/serialize in `src/config.ts`. This file is hand-maintained
(the rest of `docs/` is generated code-summary output).

## Problem

- Claude Code wants a small set of quality tiers (fast / workhorse / heavy), but
  the cheapest or best model per tier lives on different providers, and which one
  is *available* changes (quota, rate limits, disabled credentials, regional
  outages).
- A single provider account can have several API keys (e.g. a sponsored key plus
  personal keys) whose quota should be consumed in a chosen order.
- Model ids must never be hardcoded in `src/` (binding repo rule) — tiers and
  pools are pure config.

## Goals

1. Three config-defined **virtual tiers** — `sonnet-like`, `haiku-like`,
   `opus-like` — each an ordered fallback list of real canonical ids spanning
   providers.
2. **Key pools** per provider (and per region entry): an ordered credential
   list with labels, e.g. sponsor key first.
3. **Request-time failover** across keys and tiers, strictly pre-stream, with
   bounded attempts.
4. Zero behavior change for existing configs (single `credential:` = pool of one;
   no `virtualModels` block = no virtual ids).

## Config surface (all in `config.local.jsonc`)

```jsonc
"virtualModels": {
  "sonnet-like": [
    "zai.anthropic.global.glm-5.3",
    "alibaba.anthropic.ap-southeast-1.qwen3-coder-480b-a35b-instruct",
    "bedrock.mantle.us.zai.glm-5"
  ],
  "haiku-like": [
    "zai.anthropic.global.glm-5.3-flash",
    "alibaba.anthropic.ap-southeast-1.qwen3-coder-flash",
    "bedrock.mantle.us.zai.glm-5"
  ],
  "opus-like": [
    "alibaba.anthropic.ap-southeast-1.qwen3.8-max-0902",
    "bedrock.mantle.us.moonshotai.kimi-k2.5",
    "zai.anthropic.global.glm-5.3"
  ]
}
```

Key pools on a provider (and identically inside each `regions` entry):

```jsonc
"zai": {
  "type": "anthropic",
  "credentials": [
    { "credential": "${ZAI_API_KEY}",           "label": "primary" },
    { "credential": "${ZAI_API_KEY_SECONDARY}", "label": "secondary" },
    { "credential": "${ZAI_API_KEY_TERTIARY}",  "label": "tertiary" }
  ],
  "auth": "bearer",
  "baseUrl": "https://api.z.ai/api/anthropic",
  "countTokens": true,
  "modelsUrl": "https://api.z.ai/api/paas/v4/models"
}
```

Validation rules (extend the boot-resilience model — missing info degrades):

- `virtualModels` is optional; tier names are arbitrary config strings (never
  referenced in `src/`); entries must parse as canonical ids.
- A candidate whose env refs resolve empty is dropped from the tier at load with
  a load warning (the provider itself would be `inactiveReason` anyway).
- Pools: entries with empty credentials are filtered; a provider (or region)
  whose pool is entirely empty gets `inactiveReason: "no credentials"`.
  A flat `credential:` remains valid — normalized to a one-entry pool with
  label `"default"`. Incoming `label` values are kept (operator data), but
  labels are metadata only: never used for matching, never a secret.
- `serializeConfig` round-trips both blocks; credentials restored to `${VAR}`
  refs exactly like today (`${VAR}` refs, never literals, on the save path).

## Canonical id form

Virtual ids use the reserved provider name `virtual`:

```
virtual.anthropic.global.sonnet-like
└─provider└backend└prefix┘└─ tier name (arbitrary config string)
```

`route()` recognizes `provider === "virtual"`, expands the tier, and re-routes
the resolved real id through the normal path (P/C/M all work unchanged;
`count_tokens` resolves through the same expansion). `/v1/models` lists virtual
ids alongside real ones; the registry page shows each tier's current resolution.

## Resolution algorithm (per request)

1. Candidates = tier list, in config order, filtered at **routing time** to
   those that are *available*: provider present + not `inactiveReason` +
   credential pool non-empty + model present in the live catalog (for
   bedrock candidates) / provider active (external candidates).
2. For each candidate, its provider's key pool in config order.
3. Serve the first (candidate × key) combination that succeeds; see failover.

**Always primary first, with a 429 cooldown (implemented).** Every request
re-walks the list from the top — EXCEPT keys currently in cooldown: a 429
marks the (provider, key-label) pair degraded for 5 minutes
(`CredentialCooldownStore` in src/failover.ts, unref'd TTL timers, shared
across hot-reloads), and `buildAttempts` skips degraded entries. A key whose
whole provider-pool is cooled is skipped as a candidate; a direct-model
request against a fully-cooled provider gets an actionable 404 ("all keys in
429 cooldown; retry shortly"). The cooldown TTL is the reinstate mechanism —
a recovered key returns to primary automatically. 401/403 never start a
cooldown (those are mis-configured keys, not quota).

## Request-time failover (decided)

- **Triggers:** upstream `401 / 403 / 429` or connection-level failure
  (ECONNREFUSED, DNS, TLS, timeout on *connect*). NOT 5xx (avoids re-sending —
  and double-charging — long generations). One narrow 400 exception: a body
  matching known "context/input too long" wording (`isContextTooLong` —
  provider phrasings like "range of input length should be [1, N]",
  "context_length_exceeded", "prompt is too long") IS failover-eligible: the
  next tier candidate may have a larger context window and succeed.
- **Only before first byte reaches the client.** Once SSE streaming has begun,
  errors relay to the client as today; no mid-stream model or key switching.
  The existing `assertUpstreamOk` throw (paths/relay.ts) is the natural hook:
  a failure there means nothing was streamed yet.
- **Order of advancement:** next key (same model) → next candidate model → next
  provider, strictly in config order. Total attempts capped (default 4,
  config knob `maxFailoverAttempts`).
- Exhaustion surfaces the LAST upstream error to the client, unchanged in shape
  from today's relayed errors; the attempt chain (candidate + key label per
  attempt) is logged.

## Discovery with pools

Discovery uses the first pool credential; on a 401 it advances to the next key
for that attempt. SourceStatus stays per source as today. (A dead primary key
therefore doesn't blank the catalog.)

## Observability

- Every `request completed` log line carries the serving truth: the canonical
  id the client asked for (`requested=`, the virtual tier when applicable),
  the REAL canonical id that answered (`served=`), the serving pool key
  (`key=zai/secondary`), and the failover depth (`attempts=2`). The
  `requestId` correlates these with the per-attempt `failover attempt failed`
  / `upstream selected` lines. (AsyncLocalStorage context in
  src/logging/request-context.ts; key LABELS only, never values.)
- The **serving key's label** (never its value) is attached to the request log
  and the LogStore TurnRecord — cost attribution per key ("how much of today
  ran on the sponsor key").
- `/status.json` + `/api/config/status`: per-tier current resolution; per-pool
  state (key labels + which is primary). Registry page renders both.
- Virtual ids appear in `/v1/models` with an `aliasOf` field naming the current
  resolution.

## Claude Code integration — the full env-var family

The proxy CLI (`bun run cli config-claude` / `setup`) propagates the complete
model-variable family into Claude Code settings (verified against
code.claude.com/docs/en/model-config, 2026-09-06):

| Variable | Role | Pin (recommended) |
|---|---|---|
| `ANTHROPIC_MODEL` | Session model (3rd priority) | `virtual.anthropic.global.sonnet-like` |
| `ANTHROPIC_DEFAULT_MODEL` | Lowest-priority default (v2.1.236+) | `virtual.anthropic.global.sonnet-like` |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | `sonnet` alias + opusplan execution | `virtual.anthropic.global.sonnet-like` |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | `haiku` alias + background tasks | `virtual.anthropic.global.haiku-like` |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | `opus` alias + **auto-fallback target on third-party providers** | `virtual.anthropic.global.opus-like` |
| `ANTHROPIC_DEFAULT_FABLE_MODEL` | `fable` alias | (leave unset — no fable-tier provider) |
| `CLAUDE_CODE_SUBAGENT_MODEL` | Subagents / teammates / workflows | `virtual.anthropic.global.haiku-like` |
| `ANTHROPIC_CUSTOM_MODEL_OPTION` (+`_NAME`/`_DESCRIPTION`) | One extra `/model` picker entry, validation skipped | expose `virtual.anthropic.global.opus-like` |
| `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL_NAME` / `_DESCRIPTION` / `_SUPPORTED_CAPABILITIES` | Display name + capability declaration (`thinking`, `effort`, …) for third-party gateways | set per-tier to match GLM/Qwen reality |

Notes baked into the CLI template:

- `ANTHROPIC_SMALL_FAST_MODEL` is **deprecated** → the template writes
  `ANTHROPIC_DEFAULT_HAIKU_MODEL` and warns when it finds the old var
  (existing `settings.json.*` snapshots should be migrated).
- `ANTHROPIC_DEFAULT_OPUS_MODEL` matters beyond the alias: on third-party
  providers Claude Code's automatic classifier fallback lands on the opus
  resolution — pinning it means fallbacks land on `opus-like` instead of
  erroring against Anthropic-native ids the providers don't have.
- The `[1m]` context suffix is per-variable; leave it off unless a tier's
  models genuinely support 1M (`CLAUDE_CODE_MAX_CONTEXT_TOKENS` remains the
  authoritative cap the CLI already propagates).

## Security / threat model

- Key **labels** are operator metadata: logged and shown in UI; key **values**
  never logged, never in `/status.json` (public), only in the auth-gated
  `GET /api/config` like all resolved secrets today.
- Pools don't change the SSRF posture: origins still resolve through
  `assertSafeExternalOrigin`; failover only rotates credentials/tiers, never
  hosts beyond what config already declares.
- `POST /api/config` round-trips pools/tiers like any config; `${ENV}` restore
  keeps secrets out of the file. Empty-pool providers degrade via
  `inactiveReason` — a UI save cannot brick the next boot.

## Testing (hermetic; mock only `globalThis.fetch`)

- Config: pools normalize (single → 1-entry), empties filtered, round-trip
  serialization; tier candidates dropped when refs empty.
- Router: `virtual.anthropic.global.<tier>` expands to first available;
  unavailable candidates skipped (catalog + inactiveReason fixtures).
- Failover: sequenced fetch mocks — `401 then 200` (same model, next key),
  `429 → next model`, connect-error → next candidate, exhaustion → last error
  relayed; streaming-started case does NOT retry; attempt cap enforced.
- Discovery: primary key 401 → discovery succeeds with secondary key.
- Server surfaces: `/status.json` tier resolution + pool labels, no values;
  `/v1/models` includes virtual ids.

## Implementation outline (files)

1. `src/config.ts` — validate/serialize `virtualModels` + credential pools
   (provider & region), normalize single `credential` to a pool.
2. `src/router.ts` — reserved `virtual` provider; tier expansion +
   availability filter; RouteTarget carries the candidate's credential pool.
3. `src/paths/relay.ts` + `src/paths/*` — pre-stream failover loop
   (401/403/429/connect, ≤ `maxFailoverAttempts`), key-label logging.
4. `src/model/catalog.ts` — pool-aware discovery.
5. `src/server.ts` + `src/http/registry-page.ts` + `src/http/config-page.ts` —
   status/UI surfaces, `/v1/models` alias entries.
6. `src/cli/` — full env-var family in `config-claude`/`setup` (+ deprecation
   warning for `ANTHROPIC_SMALL_FAST_MODEL`).
7. Tests + `AGENTS.md` (Custom Instructions: pools, virtual ids, failover
   semantics) + regenerate `docs/`.

Prerequisite config work (not code): add the `alibaba` Singapore block to
`config.local.jsonc` (fork-verified form, `ap-southeast-1` workspace +
`${DASHSCOPE_API_KEY_INTL}`/`${DASHSCOPE_WORKSPACE_ID_INTL}` — already in
`.env`), since two of the three tiers reference it.
