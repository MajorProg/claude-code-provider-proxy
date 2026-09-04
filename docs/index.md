# Code Summary Index — `claude-code-provider-proxy`

> **For AI assistants:** This is the primary knowledge-base entry point. Load
> **this file first**. It summarizes each document and tells you which to open
> for a given question, so you rarely need to read source files to answer.
> This `docs/` set is a navigable summary derived from the source; the root
> [`AGENTS.md`](../AGENTS.md) holds the binding project rules and the
> live-verified per-provider facts.

---

## What this project is

An Anthropic-Messages-mode HTTP proxy (Bun + TypeScript) that lets Claude Code
drive any AWS Bedrock model — Claude and non-Claude — plus external providers,
behind one Anthropic-compliant endpoint. It translates the inbound Anthropic
Messages protocol to whichever backend/format each model needs, with **runtime
model discovery** (no hardcoded catalog).

---

## How to use this knowledge base

1. Start here to identify the relevant document(s).
2. Open the specific file for detail.
3. For binding project rules and live-verified per-provider specifics, see the
   root [`AGENTS.md`](../AGENTS.md) (its "Custom Instructions" section).

---

## Document map

| Document | Read it when you need… | Key contents |
|---|---|---|
| [`codebase_info.md`](codebase_info.md) | Orientation, tech stack, directory layout | Purpose, stack table, repo structure diagram, source-directory map, entry points, the two test lanes. |
| [`architecture.md`](architecture.md) | System design, request lifecycle, the 3 paths | System-context & sequence diagrams, the declarative route table, path-selection flowchart, the relay/trust-boundary layer, IR overview, discovery flow, design patterns, security boundaries (auth + CSRF + CSP). |
| [`components.md`](components.md) | What a specific module does | Per-file responsibilities and key exported symbols across all subsystems (incl. `logging/logger.ts` and `paths/relay.ts`), plus a component dependency graph. |
| [`interfaces.md`](interfaces.md) | HTTP API, DI seams, outbound headers, errors | Full route table (with auth + CSRF marking + HTML security headers), routing internals (`Route`/`exact`/`prefix`/`createFetchHandler`), inbound auth contract, `HeaderReader`/`DiscoveryClient`/`RegionTokenProvider`/`RouteTarget`, outbound header styles, error taxonomy (incl. `UnsupportedProviderError`, `assertNever`, `ProxyError {cause}`). |
| [`data_models.md`](data_models.md) | Data structures & types | Canonical id, IR types (response/blocks/enums — no `IRRequest`/`IRTool`), discovery/catalog models, config model, logging records, captured-fixture data model. |
| [`workflows.md`](workflows.md) | How a process runs end to end | Startup, inference (parse-body-once), Path C/M translation, streaming SSE, discovery/refresh, serialized config hot-reload, log capture (disconnect + timeout cancel), dev token minting, and the two test lanes. |
| [`dependencies.md`](dependencies.md) | External deps & upstream services | `aws4fetch`, Bun built-ins, dev + test-infra tooling (capture-fixtures, fetch-mock, live helper), Bedrock + external provider matrix, deployment deps, dependency + mocking policy. |
| [`threat_model.md`](threat_model.md) | Security review: trust boundaries, controls, accepted risks | Trust-boundary diagram, assets, controls in place, the two accepted-by-design exposures, out-of-scope non-goals, hardening steps for untrusted networks. |
| [`improvements.md`](improvements.md) | Verified improvement backlog for the connector + streaming | **Part 1** — research-vs-code gap analysis for Path M (OpenAI⇄Anthropic): reasoning/thinking mapping (`reasoning_content`→`thinking`), block ordering, tool-call reconciliation/id-sanitization, Path P keep-alive (180s watchdog), Converse signed-thinking, confirmed non-issues. **Part 2** — a 4-agent deep audit adding streaming (SR), translation-correctness (TC), performance/cost (PC), and security/robustness (SEC) findings, with a cross-cutting synthesis and revised global priority. Each item has impact, confidence, code location, evidence, recommendation. |

---

## Question → document routing

| If asked about… | Consult |
|---|---|
| "What is this / how is it laid out?" | `codebase_info.md` |
| "How does a request flow?" / "the three translation paths" | `architecture.md`, `workflows.md` |
| "What does `<file/module>` do?" | `components.md` |
| "What HTTP endpoints exist?" / "how is auth done?" | `interfaces.md` |
| "What's the shape of the IR / a model id / config / logs?" | `data_models.md` |
| "How does discovery / hot-reload / streaming / token minting work?" | `workflows.md` |
| "How is the request body validated / upstream errors relayed?" | `components.md` + `interfaces.md` (`paths/relay.ts`) |
| "How does logging / request-id correlation work?" | `components.md` (`logging/logger.ts`), `workflows.md` |
| "How are tests structured? live vs hermetic? fixtures?" | `workflows.md` (testing lanes), `dependencies.md` (test infra) |
| "What does it depend on?" / "which external providers?" | `dependencies.md` |
| "What's the security model / trust boundary / accepted risks?" | `threat_model.md` (+ root `AGENTS.md`) |
| "How can the OpenAI⇄Anthropic connector / streaming be improved?" | `improvements.md` |
| "How do I run / operate the proxy (setup, start, modes)?" | `workflows.md` (operator lifecycle), `codebase_info.md` (CLI) |
| "Binding project rules / provider-specific quirk (DeepSeek, Gemini, Alibaba, …)" | root [`AGENTS.md`](../AGENTS.md) "Custom Instructions" |

---

## Core concepts (glossary)

| Term | Meaning |
|---|---|
| **Canonical id** | `<provider>.<backend>.<profilePrefix>.<nativeModelId>`; parsed by splitting on the first three dots only. |
| **Backend** | `converse \| mantle \| anthropic \| openai` — selects the translation path. |
| **Path P (passthrough)** | Claude / native-Anthropic; body relayed near-verbatim (only `model` rewritten). |
| **Path C (converse)** | Anthropic ⇄ Bedrock Converse, via the IR. |
| **Path M (mantle)** | Anthropic ⇄ OpenAI Chat Completions, via the IR. |
| **IR** | Provider-neutral intermediate representation (`src/ir/types.ts`) shared by Paths C and M. |
| **Catalog** | Immutable snapshot of runtime-discovered models; refreshed on a timer by `CatalogManager`. |
| **Inference profile** | Bedrock `global.*`/regional profile id required by inference-profile-only models. |
| **Mantle** | Bedrock's `bedrock-mantle` backend (OpenAI-compatible + native Anthropic route). |
| **Relay layer** | `paths/relay.ts` — shared trust-boundary helpers (`parseJsonObject`, `parseUpstreamJson`, `assertUpstreamOk`, `relayHeadersFrom`) + the shared `irToAnthropicResponse` serializer. |
| **Route table** | Declarative `Route[]` in `server.ts` (`{method, match, requiresAuth, requiresCsrf?, handler}`) matched by `exact()`/`prefix()`; drives auth + CSRF gating. |
| **Two test lanes** | Hermetic merge gate (`bun run test:unit`, mocks only `globalThis.fetch`, replays real captured fixtures) + opt-in live lane (`RUN_LIVE=1 bun test`). |

---

## Example queries this KB can answer

- *"Which file selects the translation path, and how?"* → `router.ts`; see
  `architecture.md` path-selection flowchart + `components.md`.
- *"How does the proxy keep long streaming responses from being aborted?"* →
  synthetic ping in `AnthropicSseEmitter`; see `workflows.md` §4 + `components.md`.
- *"Where do model ids come from?"* → runtime discovery in `model/catalog.ts`;
  see `workflows.md` §5 + `dependencies.md`.
- *"What HTTP status does an unparseable model id return?"* → `400`
  `invalid_request_error` (`BadModelIdError`); see `interfaces.md` error taxonomy.
- *"How is a dev Bedrock token minted without a long-term key?"* → SigV4-presign
  via `aws4fetch`; see `workflows.md` §8 + `components.md` (`auth/bedrock-token.ts`).

---

## Maintenance

Regenerate this set after significant structural changes. The root
[`AGENTS.md`](../AGENTS.md) "Custom Instructions" section holds the binding
project rules and verified facts; keep those current
by hand (they are preserved across regenerations).
