# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

The import above pulls in `AGENTS.md`, which contains the binding project rules
(non-negotiable rules, toolchain/definition-of-done, conventions/gotchas,
verified per-provider facts, security/threat model) — read it in full. The
notes below are a quick-reference supplement, not a replacement.

## Commands

```bash
bun install
bun run dev              # watch-mode server, http://127.0.0.1:8787
bun run typecheck        # tsc --noEmit, strict
bun run format           # biome --write, targets src/ AND tests/ (run before lint)
bun run lint             # biome check, targets src/ ONLY
bun run test:unit        # hermetic lane (== `bun test`, the merge/CI gate, no network)
bun run test:live        # live lane, RUN_LIVE=1, needs real provider creds
bun run test:capture     # scripts/capture-fixtures.ts — re-record tests/fixtures/ (needs live creds)
```

Definition of done for any change: `bun run format && bun run typecheck && bun run lint && bun test` — all zero errors/warnings.

Run a single test file: `bun test tests/converse.test.ts` (append `RUN_LIVE=1` for
suites gated on live credentials, e.g. `RUN_LIVE=1 bun test tests/alibaba.test.ts`).

Operator CLI (separate from the dev loop above): `bun run cli <setup|up|down|restart|status|logs|config-claude|doctor> [--local|--docker]`.

## Architecture

Inbound is always the Anthropic Messages API (`POST /v1/messages`, etc.).
`src/router.ts::route()` parses the canonical model id
(`<provider>.<backend>.<profilePrefix>.<nativeModelId>`, see
`src/model/canonical-id.ts`) and picks one of three outbound translation paths:

- **Path P — passthrough** (`src/paths/passthrough.ts`): Claude models on
  Bedrock Mantle's native `/anthropic/v1/messages` route, and external
  providers with `type: anthropic`. Body/SSE relayed near-verbatim (only
  `model` is rewritten) — no IR involved.
- **Path C — converse** (`src/paths/converse.ts`): any `bedrock.converse.*`
  model, via Bedrock's Converse API + binary eventstream
  (`src/stream/converse-events.ts`).
- **Path M — mantle** (`src/paths/mantle.ts`): non-Claude models on Bedrock
  Mantle, and external providers with `type: openai`, via OpenAI Chat
  Completions + SSE (`src/stream/openai-sse.ts`).

Paths C and M both translate through a shared provider-neutral intermediate
representation (`src/ir/types.ts`); `src/paths/relay.ts` centralizes the
trust-boundary helpers both use (JSON parsing at the network edge, upstream
error relay, and the shared `irToAnthropicResponse` serializer).

`src/server.ts::main()` wires up the `Runtime` (token provider + model
discovery + `Catalog` + `LogStore`), starts `Bun.serve`, and dispatches through
a declarative `ROUTES` table (`{method, match, requiresAuth, requiresCsrf?, handler}`)
so auth/CSRF policy is data-driven rather than scattered through handlers.
Model availability is discovered at runtime (`src/model/catalog.ts`,
refreshed on a timer) — **there is no hardcoded model catalog anywhere in
`src/`**; per-provider credentials/hosts come from `config.local.jsonc`
(`${ENV}`-interpolated, git-ignored).

For anything beyond this summary — full request/streaming/discovery
sequences, the config hot-reload flow, the threat model, and per-file
responsibilities — consult [`docs/index.md`](docs/index.md) before reading
source directly; it routes questions to the right generated doc
(`architecture.md`, `components.md`, `interfaces.md`, `workflows.md`, etc.).
