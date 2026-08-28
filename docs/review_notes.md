# Documentation Review Notes

> Consistency + completeness review of the `docs/` set after the refactor that
> introduced the leveled logger, the relay/trust-boundary layer, the declarative
> route table, CSRF/CSP hardening, and the two-lane (live + hermetic) test model.
> This file is advisory — it records what was checked, remaining gaps, and
> recommendations. It is not part of the knowledge base an agent must load.

---

## Consistency check

Cross-document terms were reconciled after the update:

- **"No mocks" claims removed.** The old docs (and README/AGENTS) asserted tests
  never mock. That is no longer accurate: the hermetic lane mocks the outbound
  `globalThis.fetch` boundary and replays **real captured upstream fixtures**.
  All `docs/` files now describe the two-lane model consistently; no residual
  "no mocks" phrasing remains in `docs/`.
- **IR types.** `IRTool` (unused) and any `IRRequest` wrapper are **not** part of
  `src/ir/types.ts`. `data_models.md` states this explicitly, and the
  `architecture.md` IR diagram was corrected to show the request side mapping
  directly into the provider schema (no `IRRequest` node).
- **`irToAnthropicResponse` single source.** Documented in `components.md`,
  `interfaces.md`, `architecture.md`, and `workflows.md` as living in
  `paths/relay.ts` and shared by both `converse.ts` and `mantle.ts` (the local
  duplicates were removed).
- **Route table + auth/CSRF.** `interfaces.md` (route table + routing internals)
  and `architecture.md` (route flowchart + security boundaries) agree on the
  `Route` shape, `exact()`/`prefix()` matchers, `authenticateManagement`,
  `assertCsrf` (`x-ccpp-csrf` + same-origin `Origin`) on `POST /api/config` and
  `POST /api/chat`, and the CSP/`nosniff`/`no-referrer` headers on HTML pages.
- **Error taxonomy.** `UnsupportedProviderError`, `assertNever`, `ProxyError`
  `{cause}`, and `UpstreamError` `{upstreamBody, context}` are described the same
  way in `components.md` and `interfaces.md`.

No contradictions were found across the refreshed set. The root
[`AGENTS.md`](../AGENTS.md) "Custom Instructions" remain the binding source for
project rules and per-provider verified facts and were not modified by this
regeneration (only the auto-generated navigation above that section).

---

## Completeness gaps

These are known, deliberate limitations rather than documentation defects — they
are recorded so they are not mistaken for omissions.

1. **CLI process-orchestration is not unit-tested.** `src/cli/index.ts`
   command handlers (`cmdUp`/`cmdDown`/`localUp`/`compose`/…), `src/cli/deps.ts`,
   and the spawn wrappers in `src/cli/util.ts` shell out to `bun`/`docker`/
   installers and cannot be exercised hermetically without real subprocesses.
   The **pure** CLI logic (arg parsing, `.env` read/write, BIND_IP derivation,
   pid/path/port/model helpers, config/token bootstrap, Claude-settings backup)
   **is** unit-tested. `writeClaudeSettings` targets the real
   `~/.claude/settings.json`, so only its backup seam is covered.

2. **External-provider fixtures are not captured.** `tests/fixtures/` holds real
   Bedrock Converse / OpenAI / native-Anthropic responses. External providers
   (DeepSeek, z.ai, Gemini, Alibaba, EUrouter, Mistral, Moonshot) reuse the same
   translation paths, so they are covered structurally by the Bedrock fixtures +
   per-provider routing unit tests; their live suites remain the source of truth
   for provider-specific quirks. Per-provider hermetic fixtures could be added
   with `scripts/capture-fixtures.ts` if a provider contract needs pinning.

3. **A few defensive branches are intentionally uncovered.** Guard clauses such
   as the detached-task `.catch` in `capture.ts` and unreachable `switch`
   defaults are not force-tested, to avoid exercising dead code purely for a
   coverage metric.

---

## Recommendations

- **Re-capture fixtures when a provider contract changes.** Run
  `bun run test:capture` (with live creds) after any upstream schema change so
  the hermetic lane keeps replaying authentic data.
- **Keep `AGENTS.md` "Custom Instructions" hand-maintained.** It is preserved
  verbatim across regenerations; the verified-provider-facts table and threat
  model should be updated there by hand when provider behavior is re-verified.
- **Regenerate this `docs/` set after structural changes** (new module,
  new route, new translation path), not after routine edits.
- If external-provider behavior needs hermetic pinning, extend
  `scripts/capture-fixtures.ts` to capture one fixture per provider `type`
  (`anthropic` and `openai`) rather than one per provider.
