/**
 * ${ENV} interpolation tests (hermetic; real temp files through loadConfig).
 *
 * Covers both reference forms:
 *   - bare ${VAR}        — strict: unset OR empty fails the load
 *   - ${VAR:-default}    — bash-like default; empty default allowed (the
 *                          "provider configured but inactive" form)
 * Only real loadConfig runs are exercised — the interpolation is not tested
 * through a fabricated parser.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { ConfigError } from "../src/errors.ts";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccpp-interp-"));
  path = join(dir, "config.local.jsonc");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write a minimal valid config whose bedrock credential is `credential`. */
function writeConfig(credential: string): void {
  writeFileSync(
    path,
    `{
      "server": { "host": "127.0.0.1", "port": 8787 },
      "inboundAuth": { "keys": ["k"] },
      "primaryRegion": "us",
      "profilePreference": "global",
      "refreshIntervalMinutes": 60,
      "claudeFallbackToMantle": false,
      "regions": [{ "key": "us", "awsRegion": "us-east-1" }],
      "providers": {
        "bedrock": {
          "credential": "${credential}",
          "hosts": {
            "converse": "bedrock-runtime.{region}.amazonaws.com",
            "mantle": "bedrock-mantle.{region}.api.aws"
          }
        }
      }
    }`,
  );
}

describe("bare ${VAR} (strict)", () => {
  test("substitutes a set env var", async () => {
    writeConfig("${TEST_BEDROCK_KEY}");
    const cfg = await loadConfig(path, { TEST_BEDROCK_KEY: "bedrock-api-key-abc" });
    expect(cfg.providers.bedrock?.credential).toBe("bedrock-api-key-abc");
  });

  test("fails fast when the env var is unset", async () => {
    writeConfig("${TEST_BEDROCK_KEY}");
    await expect(loadConfig(path, {})).rejects.toThrow(ConfigError);
  });

  test("fails fast when the env var is set but EMPTY", async () => {
    writeConfig("${TEST_BEDROCK_KEY}");
    await expect(loadConfig(path, { TEST_BEDROCK_KEY: "" })).rejects.toThrow(ConfigError);
  });

  test("escapes quote and backslash in env values into valid JSON", async () => {
    writeConfig("${TEST_QUOTED_KEY}");
    const cfg = await loadConfig(path, { TEST_QUOTED_KEY: 'be"d\\rock' });
    expect(cfg.providers.bedrock?.credential).toBe('be"d\\rock');
  });
});

describe("${VAR:-default} (bash-like default)", () => {
  test("unset env var resolves to the default", async () => {
    writeConfig("${TEST_BEDROCK_KEY:-bedrock-api-key-fallback}");
    const cfg = await loadConfig(path, {});
    expect(cfg.providers.bedrock?.credential).toBe("bedrock-api-key-fallback");
  });

  test("empty env var also resolves to the default", async () => {
    writeConfig("${TEST_BEDROCK_KEY:-bedrock-api-key-fallback}");
    const cfg = await loadConfig(path, { TEST_BEDROCK_KEY: "" });
    expect(cfg.providers.bedrock?.credential).toBe("bedrock-api-key-fallback");
  });

  test("a set env var wins over the default", async () => {
    writeConfig("${TEST_BEDROCK_KEY:-bedrock-api-key-fallback}");
    const cfg = await loadConfig(path, { TEST_BEDROCK_KEY: "bedrock-api-key-real" });
    expect(cfg.providers.bedrock?.credential).toBe("bedrock-api-key-real");
  });

  test("an EMPTY default is allowed (the disabled-provider form)", async () => {
    writeConfig("${TEST_BEDROCK_KEY:-}");
    const cfg = await loadConfig(path, {});
    expect(cfg.providers.bedrock?.credential).toBe("");
  });

  test("a default containing // (URL) survives JSONC comment stripping", async () => {
    // In-string content must not be treated as a comment — verified against a
    // real https:// URL default inside a quoted JSON string.
    writeFileSync(
      path,
      `{
        "server": { "host": "127.0.0.1", "port": 8787 },
        "inboundAuth": { "keys": ["k"] },
        "primaryRegion": "us",
        "profilePreference": "global",
        "refreshIntervalMinutes": 60,
        "claudeFallbackToMantle": false,
        "regions": [{ "key": "us", "awsRegion": "us-east-1" }],
        "providers": {
          "zai": {
            "type": "anthropic",
            "credential": "key",
            "auth": "bearer",
            "baseUrl": "\${TEST_BASE:-https://api.z.ai/api/anthropic}",
            "countTokens": true,
            "modelsUrl": "\${TEST_MODELS:-https://api.z.ai/api/paas/v4/models}"
          }
        }
      }`,
    );
    const cfg = await loadConfig(path, {});
    expect(cfg.providers.external.zai?.baseUrl).toBe("https://api.z.ai/api/anthropic");
    expect(cfg.providers.external.zai?.modelsUrl).toBe("https://api.z.ai/api/paas/v4/models");
  });
});
