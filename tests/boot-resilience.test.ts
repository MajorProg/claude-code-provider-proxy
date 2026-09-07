/**
 * Boot-resilience tests (hermetic; real files + real loadConfigResilient).
 *
 * The server must BOOT with zero information: no config file (bootstrap tiers),
 * no env vars (bare ${VAR} refs resolve empty + warnings), no provider keys
 * (providers inactive). Missing info degrades — it never crashes the boot.
 * Real temp dirs and the real example file are used throughout.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfigResilient } from "../src/config.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccpp-boot-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("loadConfigResilient bootstrap tiers", () => {
  test("existing file loads from 'file'", async () => {
    writeFileSync(
      join(dir, "config.local.jsonc"),
      `{
        "server": { "host": "127.0.0.1", "port": 8787 },
        "inboundAuth": { "keys": ["k"] },
        "primaryRegion": "us", "profilePreference": "global",
        "refreshIntervalMinutes": 60, "claudeFallbackToMantle": false,
        "regions": [{ "key": "us", "awsRegion": "us-east-1" }],
        "providers": {}
      }`,
    );
    const { config, source } = await loadConfigResilient(join(dir, "config.local.jsonc"), {});
    expect(source).toBe("file");
    expect(config.inboundAuth.keys).toEqual(["k"]);
  });

  test("missing file + example present: example is COPIED to the path and loads", async () => {
    // Real example file (shipped template) copied into the temp dir.
    cpSync("config.example.jsonc", join(dir, "config.example.jsonc"));
    const path = join(dir, "config.local.jsonc");
    const { config, source } = await loadConfigResilient(path, {});
    expect(source).toBe("copied-example");
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).isFile()).toBe(true);
    // The example's bare ${PROXY_INBOUND_KEY} resolved empty -> ephemeral key.
    expect(config.inboundAuth.ephemeralKey).toBe(true);
    expect(config.loadWarnings).toEqual(["PROXY_INBOUND_KEY"]);
  });

  test("DIRECTORY at the config path (Docker bind-mount artifact): in-memory example, never written", async () => {
    cpSync("config.example.jsonc", join(dir, "config.example.jsonc"));
    const path = join(dir, "config.local.jsonc");
    mkdirSync(path); // the artifact compose creates when the host file is missing
    const { config, source } = await loadConfigResilient(path, {});
    expect(source).toBe("example-memory");
    expect(statSync(path).isDirectory()).toBe(true); // untouched
    expect(config.inboundAuth.ephemeralKey).toBe(true);
  });

  test("no file, no example: built-in default boots with zero providers + ephemeral key", async () => {
    const { config, source } = await loadConfigResilient(join(dir, "config.local.jsonc"), {});
    expect(source).toBe("default");
    expect(config.providers.bedrock).toBeUndefined();
    expect(Object.keys(config.providers.external)).toEqual([]);
    expect(config.inboundAuth.ephemeralKey).toBe(true);
    expect(config.inboundAuth.keys[0]).toMatch(/^ccpp-ephemeral-[0-9a-f]{32}$/);
    expect(config.logging.enabled).toBe(false); // no new fatal path on read-only fs
  });

  test("two boots mint DIFFERENT ephemeral keys", async () => {
    const a = await loadConfigResilient(join(dir, "config.local.jsonc"), {});
    const b = await loadConfigResilient(join(dir, "config.local.jsonc"), {});
    expect(a.source).toBe("default");
    expect(b.source).toBe("default");
    expect(a.config.inboundAuth.keys[0]).not.toBe(b.config.inboundAuth.keys[0]);
  });
});

describe("loadConfigResilient with a fork-style alibaba config (the crash report)", () => {
  /**
   * The exact shape ported from the fork working copy: bare ${DASHSCOPE_*} refs
   * in credential/workspaceId/modelsUrl. With those env vars unset the OLD
   * loader threw ("Config references unset environment variable") — the boot
   * crashed. Now: warnings + provider inactive, server can boot.
   */
  const ALIBABA_CONFIG = `{
    "server": { "host": "127.0.0.1", "port": 8787 },
    "inboundAuth": { "keys": ["k"] },
    "primaryRegion": "us",
    "profilePreference": "global",
    "refreshIntervalMinutes": 60,
    "claudeFallbackToMantle": false,
    "regions": [{ "key": "us", "awsRegion": "us-east-1" }],
    "providers": {
      "alibaba": {
        "type": "anthropic",
        "credential": "\${DASHSCOPE_API_KEY_INTL}",
        "auth": "x-api-key",
        "hostTemplate": "{workspaceId}.{region}.maas.aliyuncs.com",
        "basePath": "/apps/anthropic",
        "workspaceId": "\${DASHSCOPE_WORKSPACE_ID_INTL}",
        "region": "ap-southeast-1",
        "countTokens": true,
        "modelsUrl": "https://\${DASHSCOPE_WORKSPACE_ID_INTL}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/models"
      }
    }
  }`;

  test("boots with the DASHSCOPE env vars unset: warnings + inactiveReason, no throw", async () => {
    const path = join(dir, "config.local.jsonc");
    writeFileSync(path, ALIBABA_CONFIG);
    const { config, source } = await loadConfigResilient(path, {});
    expect(source).toBe("file");
    expect(config.loadWarnings).toEqual(["DASHSCOPE_API_KEY_INTL", "DASHSCOPE_WORKSPACE_ID_INTL"]);
    const alibaba = config.providers.external.alibaba;
    expect(alibaba?.inactiveReason).toContain("workspaceId is empty");
  });

  test("with the env vars set the same config activates the provider", async () => {
    const path = join(dir, "config.local.jsonc");
    writeFileSync(path, ALIBABA_CONFIG);
    const { config } = await loadConfigResilient(path, {
      DASHSCOPE_API_KEY_INTL: "sk-test",
      DASHSCOPE_WORKSPACE_ID_INTL: "ws-test",
    });
    const alibaba = config.providers.external.alibaba;
    expect(alibaba?.credential).toBe("sk-test");
    expect(alibaba?.workspaceId).toBe("ws-test");
    expect(alibaba?.inactiveReason).toBeUndefined();
    expect(config.loadWarnings).toBeUndefined();
  });
});
