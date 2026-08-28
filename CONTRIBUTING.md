# Contributing

Thanks for contributing to `claude-code-llm-proxy`. This guide covers
development setup, the repo's standards, and the contribution workflow.
Agent-oriented guidance lives in [`AGENTS.md`](AGENTS.md); a navigable code
summary is in [`docs/index.md`](docs/index.md).

## Table of contents

- [Development setup](#development-setup)
- [Running the proxy](#running-the-proxy)
- [Coding standards](#coding-standards)
- [Testing](#testing)
- [Definition of done](#definition-of-done)
- [Adding an external provider](#adding-an-external-provider)
- [Documentation](#documentation)
- [Security & secrets](#security--secrets)

---

## Development setup

Prerequisites: **[Bun](https://bun.sh)** (see `package.json` / `bun.lock` for
the pinned major version) and, for the container workflow, Docker Desktop.

```bash
bun install
bun run dev        # watch-mode server on http://127.0.0.1:8787
```

Copy the example config and env files on first run (the control script does this
automatically):

```bash
cp .env.example .env
cp config.example.jsonc config.local.jsonc
```

Fill in `PROXY_INBOUND_KEY`, `BEDROCK_API_KEY` (or use `dev` mode with AWS env
creds), and `BIND_IP`. `.env`, `config.local.jsonc`, and AWS credentials are
git-ignored.

---

## Running the proxy

Use the cross-platform Bun CLI (`bun run cli <cmd>`), which supports both a bare
local process (`--local`) and Docker (`--docker`). Quickest inner loop for
development is `bun run dev` (watch mode). See the
[README](README.md#quick-start) for the full command table and run modes.

---

## Coding standards

This repo enforces a strict, tooling-backed style. These points are
**repo-specific** — read them even if you know TypeScript well:

- **Explicit `.ts` import extensions** and `import type` for type-only imports
  (`allowImportingTsExtensions` + `verbatimModuleSyntax`).
- **Strict TypeScript**, including `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`. Index access can be `undefined` — handle it.
- **Biome, 100-char line width.** Lines over 100 chars fail lint. Prefer a
  single template literal over string concatenation (`useTemplate`).
- **No hardcoded model IDs in `src/`.** All model/region specifics come from
  runtime discovery (`src/model/catalog.ts`) or config. Tests may reference
  literal ids.
- **Mocks are limited to the network edge.** Every DI seam has a real
  implementation. The hermetic test lane mocks only the outbound `fetch`
  boundary and replays **real captured upstream responses** (`tests/fixtures/`);
  the live lane hits real endpoints. Never fabricate provider response data.
- **Decouple from `Headers`.** Use the structural `HeaderReader` interface, not
  the global `Headers` type (it resolves ambiguously in tests).

`bun run format` auto-formats `src/` and `tests/`. Run it **before** `lint`
(`lint` only checks `src/`).

---

## Testing

```bash
bun run test:unit
```

Tests are `bun:test` suites under `tests/`, organized per subsystem and per
external provider. They run in two lanes:

- **Hermetic lane** — `bun run test:unit` (also plain `bun test`). The merge
  gate. Mocks only the outbound `fetch` boundary and replays **real captured
  upstream responses** in `tests/fixtures/` — no network, no provider cost.
- **Live lane** — `bun run test:live` (`RUN_LIVE=1 bun test`). Hits real AWS
  Bedrock + external-provider endpoints; requires credentials:

```bash
export AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... AWS_SESSION_TOKEN=...
bun run test:live
```

Re-capture fixtures when an upstream contract changes: `bun run test:capture`
(needs live credentials). Any new behavior MUST come with tests.

---

## Definition of done

A change is complete only when this passes with **zero** errors and warnings:

```bash
bun run format && bun run typecheck && bun run lint && bun run test:unit
```

The live lane (`bun run test:live`) is the ultimate source of truth; run it when
touching a translation path or provider integration and you have credentials.

---

## Adding an external provider

External (non-Bedrock) providers are config-driven — no code change is needed
for a provider that fits an existing path. To add one:

1. Add an entry under `config.providers.external` keyed by provider id, with:
   `type` (`anthropic` → passthrough, or `openai` → mantle translation),
   `auth` (`x-api-key` | `bearer`), `baseUrl` (or `hostTemplate` + `workspaceId`
   + `region` + `basePath`), `countTokens`, and a `modelsUrl` discovery endpoint.
2. Supply the credential via `${ENV}` in `.env` — never a literal key.
3. Add a live test suite (see existing `tests/<provider>.test.ts`).
4. Record verified specifics in [`AGENTS.md`](AGENTS.md) ("Custom Instructions" →
   "Verified facts"), the single source of truth for per-provider quirks.

Model ids are always discovered at runtime from `modelsUrl` — do not hardcode
them. A brand-new outbound *path* (beyond passthrough/converse/mantle) requires
routing in `src/router.ts` and a handler under `src/paths/`.

---

## Documentation

- **[`AGENTS.md`](AGENTS.md)** — binding project rules and live-verified
  per-provider facts (its "Custom Instructions" section). Update it when a
  convention or verified fact changes; it is preserved across doc regenerations.
- **`docs/`** — generated navigable code summary (`index.md` is the entry
  point); regenerate after significant structural changes rather than
  hand-editing.

---

## Security & secrets

- Never commit secrets. Reference them by env-var name (`${VAR}`), never by
  value. The Config UI restores `${ENV}` references on save so resolved secrets
  are never written to disk.
- By default the proxy is bound for LAN-only access: the container publishes its
  port only on `${BIND_IP}` + `127.0.0.1`, never `0.0.0.0`. Preserve this when
  touching `docker-compose.yml` or the Bun CLI (`src/cli/`).
