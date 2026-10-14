import { describe, expect, test } from "bun:test";
/**
 * docker-compose env coverage — guards against the drift that silently
 * benched two z.ai pool keys (live 2026-10-12): config.example.jsonc gained
 * `${ZAI_API_KEY_QUATERNARY:-}` / `${ZAI_API_KEY_QUINARY:-}` refs, but the
 * compose `environment:` block was never extended, so inside the container
 * those refs resolved EMPTY and validation dropped the pool entries — the
 * proxy ran on 3 keys while .env held 5, with no error anywhere.
 *
 * Invariant: every `${VAR}` (or `${VAR:-…}`) referenced by the example config
 * must be mapped in docker-compose.yml's environment block. `${ENV}` /
 * `${VAR}` are documentation placeholders, not real refs. HOST/PORT/
 * CONFIG_PATH and the AWS_* trio are proxy-side settings, not config refs —
 * they don't appear in the example config and are not checked.
 */
import { readFileSync } from "node:fs";

const exampleConfig = readFileSync("config.example.jsonc", "utf8");
const compose = readFileSync("docker-compose.yml", "utf8");

function exampleEnvRefs(): Set<string> {
  const refs = [...exampleConfig.matchAll(/\$\{([A-Z_][A-Z0-9_]*)(?:::-?)?/g)].flatMap((m) =>
    m[1] === undefined ? [] : [m[1]],
  );
  return new Set(refs.filter((r) => r !== "ENV" && r !== "VAR"));
}

function composeEnvNames(): Set<string> {
  // environment: block entries look like `      NAME: "${NAME:-}"`.
  const names = [...compose.matchAll(/^ {6}([A-Z_][A-Z0-9_]*):/gm)].flatMap((m) =>
    m[1] === undefined ? [] : [m[1]],
  );
  return new Set(names);
}

describe("docker-compose environment covers config.example.jsonc env refs", () => {
  test("every referenced ${VAR} is mapped into the container", () => {
    const missing = [...exampleEnvRefs()].filter((name) => !composeEnvNames().has(name));
    expect(missing).toEqual([]);
  });

  test("the shipped five-key zai pool is fully mapped (the 2026-10-12 drift)", () => {
    const mapped = composeEnvNames();
    for (const name of [
      "ZAI_API_KEY",
      "ZAI_API_KEY_SECONDARY",
      "ZAI_API_KEY_TERTIARY",
      "ZAI_API_KEY_QUATERNARY",
      "ZAI_API_KEY_QUINARY",
    ]) {
      expect(mapped.has(name)).toBe(true);
    }
  });
});
