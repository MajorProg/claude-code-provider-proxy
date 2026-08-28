/**
 * CLI bootstrap.ts tests (hermetic; real temp files, no network/spawns).
 *
 * Covers config-file creation from examples and idempotent auth-token
 * generation/rotation. bootstrapPaths is pure; ensureConfigFiles/ensureAuthToken
 * operate on a temp project root.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BootstrapPaths,
  bootstrapPaths,
  ensureAuthToken,
  ensureConfigFiles,
} from "../src/cli/bootstrap.ts";
import { getEnvValue } from "../src/cli/env.ts";

let root: string;
let paths: BootstrapPaths;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ccpp-boot-"));
  paths = bootstrapPaths(root);
  // Seed the committed examples the bootstrap copies from. The inbound key uses
  // the real shipped placeholder so ensureAuthToken treats it as "unset".
  writeFileSync(
    paths.envExample,
    "PROXY_INBOUND_KEY=change-me-to-a-strong-random-string\nPORT=8787\n",
  );
  writeFileSync(paths.configExample, '{ "primaryRegion": "us" }\n');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("bootstrapPaths", () => {
  test("derives standard file paths under the root", () => {
    expect(paths.env).toBe(join(root, ".env"));
    expect(paths.envExample).toBe(join(root, ".env.example"));
    expect(paths.config).toBe(join(root, "config.local.jsonc"));
    expect(paths.configExample).toBe(join(root, "config.example.jsonc"));
  });
});

describe("ensureConfigFiles", () => {
  test("creates .env and config.local.jsonc from examples when missing", () => {
    const { createdEnv } = ensureConfigFiles(paths);
    expect(createdEnv).toBe(true);
    expect(existsSync(paths.env)).toBe(true);
    expect(existsSync(paths.config)).toBe(true);
    expect(readFileSync(paths.config, "utf8")).toContain("primaryRegion");
  });

  test("is idempotent: does not report createdEnv on a second run", () => {
    ensureConfigFiles(paths);
    const second = ensureConfigFiles(paths);
    expect(second.createdEnv).toBe(false);
  });

  test("throws a clear error when .env.example is missing", () => {
    rmSync(paths.envExample, { force: true });
    expect(() => ensureConfigFiles(paths)).toThrow(/\.env\.example not found/);
  });

  test("throws when config.example.jsonc is missing (after .env is created)", () => {
    rmSync(paths.configExample, { force: true });
    expect(() => ensureConfigFiles(paths)).toThrow(/config\.example\.jsonc not found/);
  });
});

describe("ensureAuthToken", () => {
  test("generates a token when the key is the shipped placeholder", () => {
    ensureConfigFiles(paths);
    const token = ensureAuthToken(paths, false);
    expect(token.startsWith("ccpp_")).toBe(true);
    expect(getEnvValue(paths.env, "PROXY_INBOUND_KEY")).toBe(token);
  });

  test("preserves an existing real token (no rotate)", () => {
    ensureConfigFiles(paths);
    writeFileSync(paths.env, "PROXY_INBOUND_KEY=ccpp_existing_real_token_value\nPORT=8787\n");
    const token = ensureAuthToken(paths, false);
    expect(token).toBe("ccpp_existing_real_token_value");
  });

  test("rotate replaces an existing real token with a fresh one", () => {
    ensureConfigFiles(paths);
    writeFileSync(paths.env, "PROXY_INBOUND_KEY=ccpp_existing_real_token_value\n");
    const rotated = ensureAuthToken(paths, true);
    expect(rotated).not.toBe("ccpp_existing_real_token_value");
    expect(rotated.startsWith("ccpp_")).toBe(true);
  });
});
