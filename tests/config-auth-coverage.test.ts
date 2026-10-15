/**
 * Coverage-closure tests for src/config.ts and src/auth/token-provider.ts.
 *
 * These exercise the JSONC comment/escape scanner, the host-template origin
 * builder, the structural-vs-missing degradation split, the resilient-load
 * copy-failure fallback, saveConfig round-tripping, and the dev-token
 * provider's failed-mint eviction contract. Everything uses real temp files and
 * real calls — no fabricated payloads or mocked internals.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBedrockTokenProvider } from "../src/auth/token-provider.ts";
import {
  assertSafeExternalOrigin,
  externalProviderOrigin,
  loadConfig,
  loadConfigResilient,
  saveConfig,
  validateConfig,
} from "../src/config.ts";
import { ConfigError } from "../src/errors.ts";

/** Capture console.warn calls made while running the sync `fn`. */
function captureWarn<T>(fn: () => T): { result: T; warnings: string[] } {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = ((...args: unknown[]) => {
    warnings.push(args.map((a) => String(a)).join(" "));
  }) as typeof console.warn;
  try {
    return { result: fn(), warnings };
  } finally {
    console.warn = original;
  }
}

/** Capture console.warn calls made while awaiting `fn`. */
async function captureWarnAsync<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; warnings: string[] }> {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = ((...args: unknown[]) => {
    warnings.push(args.map((a) => String(a)).join(" "));
  }) as typeof console.warn;
  try {
    return { result: await fn(), warnings };
  } finally {
    console.warn = original;
  }
}

const BASE_RAW = {
  server: { host: "127.0.0.1", port: 8787 },
  inboundAuth: { keys: ["k"] },
  primaryRegion: "us",
  profilePreference: "global",
  refreshIntervalMinutes: 60,
  claudeFallbackToMantle: false,
  regions: [{ key: "us", awsRegion: "us-east-1" }],
  providers: {},
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccpp-configauth-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("loadConfig — JSONC comment + string-escape scanner", () => {
  test("strips a block comment and preserves a backslash escape inside a string", async () => {
    const path = join(dir, "config.local.jsonc");
    // A leading /* block */ comment, a trailing // line comment, and a string
    // holding an escaped backslash — the escape must reach JSON.parse intact.
    writeFileSync(
      path,
      String.raw`/* header block comment */
{
  "server": { "host": "127.0.0.1", "port": 8787 },
  "inboundAuth": { "keys": ["k\\y"] }, // escaped backslash must survive
  "primaryRegion": "us",
  "profilePreference": "global",
  "refreshIntervalMinutes": 60,
  "claudeFallbackToMantle": false,
  "regions": [{ "key": "us", "awsRegion": "us-east-1" }],
  "providers": {}
}`,
    );
    const cfg = await loadConfig(path, {});
    // The scanned text still parsed, and the escape decoded to one backslash.
    expect(cfg.inboundAuth.keys).toEqual(["k\\y"]);
    expect(cfg.primaryRegion).toBe("us");
  });

  test("a file whose processed text is not valid JSON throws ConfigError", async () => {
    const path = join(dir, "config.local.jsonc");
    writeFileSync(path, '{ "broken": } // no value');
    await expect(loadConfig(path, {})).rejects.toThrow(ConfigError);
  });
});

describe("externalProviderOrigin — host-template substitution", () => {
  test("substitutes {workspaceId}/{region}, appends basePath, strips a trailing slash", () => {
    const cfg = validateConfig({
      ...BASE_RAW,
      providers: {
        alibaba: {
          type: "anthropic",
          credential: "sk-test",
          auth: "x-api-key",
          hostTemplate: "{workspaceId}.{region}.maas.aliyuncs.com",
          workspaceId: "ws-1",
          region: "eu-central-1",
          basePath: "/apps/anthropic/",
          countTokens: true,
          modelsUrl: "https://ws-1.eu-central-1.maas.aliyuncs.com/compatible-mode/v1/models",
        },
      },
    });
    const provider = cfg.providers.external.alibaba;
    if (!provider) throw new Error("expected the validated alibaba provider");
    expect(externalProviderOrigin(provider)).toBe(
      "https://ws-1.eu-central-1.maas.aliyuncs.com/apps/anthropic",
    );
  });

  test("a hostTemplate without {region} and without basePath falls back to empty segments", () => {
    const cfg = validateConfig({
      ...BASE_RAW,
      providers: {
        templated: {
          type: "anthropic",
          credential: "sk-test",
          auth: "x-api-key",
          hostTemplate: "{workspaceId}.example.com",
          workspaceId: "ws-2",
          countTokens: true,
          modelsUrl: "https://ws-2.example.com/v1/models",
        },
      },
    });
    const provider = cfg.providers.external.templated;
    if (!provider) throw new Error("expected the validated templated provider");
    // {region} and basePath are absent -> substituted/concatenated as "".
    expect(externalProviderOrigin(provider)).toBe("https://ws-2.example.com");
  });
});

describe("assertSafeExternalOrigin — SSRF guard on credentialed origins", () => {
  test("blocks an IPv4-mapped IPv6 metadata host (the URL parser emits the hex form)", () => {
    // The dotted source form ::ffff:169.254.169.254 is normalized by the WHATWG
    // URL parser to ::ffff:a9fe:a9fe, and THAT hex form is what the guard decodes
    // back to 169.254.169.254 to reject — the IMDS address must never be fetched.
    expect(() => assertSafeExternalOrigin("https://[::ffff:169.254.169.254]/")).toThrow(
      ConfigError,
    );
  });

  test("blocks an RFC-1918 origin", () => {
    expect(() => assertSafeExternalOrigin("https://10.1.2.3")).toThrow(ConfigError);
  });

  test("permits an explicit localhost dev origin and a public https origin", () => {
    expect(() => assertSafeExternalOrigin("http://localhost:9999")).not.toThrow();
    expect(() => assertSafeExternalOrigin("https://api.example.com")).not.toThrow();
  });

  test("an origin that is not a valid URL is rejected", () => {
    expect(() => assertSafeExternalOrigin("not a url")).toThrow(/not a valid URL/);
  });
});

describe("validateConfig — server host + provider degradation edges", () => {
  test("warns (and still validates) when server.host binds all interfaces", () => {
    const { result, warnings } = captureWarn(() =>
      validateConfig({ ...BASE_RAW, server: { host: "0.0.0.0", port: 8787 } }),
    );
    expect(result.server.host).toBe("0.0.0.0");
    expect(warnings.some((w) => w.includes("0.0.0.0"))).toBe(true);
  });

  test("a hostTemplate without a string workspaceId is a fatal structural error", () => {
    expect(() =>
      validateConfig({
        ...BASE_RAW,
        providers: {
          bad: {
            type: "anthropic",
            credential: "sk-test",
            auth: "bearer",
            hostTemplate: "{workspaceId}.example.com",
            countTokens: true,
            modelsUrl: "https://example.com/v1/models",
          },
        },
      }),
    ).toThrow(/workspaceId must be a string/);
  });

  test("an empty baseUrl with no regions is missing info (inactive), not fatal", () => {
    const cfg = validateConfig({
      ...BASE_RAW,
      providers: {
        zai: {
          type: "anthropic",
          credential: "sk-test",
          auth: "bearer",
          baseUrl: "",
          countTokens: false,
          modelsUrl: "https://api.example.com/v1/models",
        },
      },
    });
    expect(cfg.providers.external.zai?.inactiveReason).toContain("baseUrl is empty");
  });
});

describe("loadConfig — dropped virtualModels warn (non-fatal)", () => {
  test("a virtualModels entry that cannot parse is dropped with a warning", async () => {
    const path = join(dir, "config.local.jsonc");
    writeFileSync(
      path,
      JSON.stringify({
        ...BASE_RAW,
        virtualModels: {
          "sonnet-like": ["zai.anthropic.global.glm-5.3", "not-a-canonical-id"],
        },
      }),
    );
    const { result, warnings } = await captureWarnAsync(() => loadConfig(path, {}));
    expect(result.virtualModels).toEqual({ "sonnet-like": ["zai.anthropic.global.glm-5.3"] });
    expect(warnings.some((w) => w.includes('virtualModels["sonnet-like"] dropped'))).toBe(true);
  });
});

describe("loadConfigResilient — example-in-memory fallback when the copy fails", () => {
  test("a copy that fails falls back to loading the example in memory", async () => {
    writeFileSync(join(dir, "config.example.jsonc"), JSON.stringify(BASE_RAW));
    const path = join(dir, "config.local.jsonc");
    // A dangling symlink: stat() sees no file, so the loader tries to copy the
    // example over it — copyFileSync follows the link to a nonexistent parent
    // directory and fails, exercising the in-memory fallback.
    symlinkSync(join(dir, "does-not-exist", "target.jsonc"), path);
    const { result, warnings } = await captureWarnAsync(() => loadConfigResilient(path, {}));
    expect(result.source).toBe("example-memory");
    expect(warnings.some((w) => w.includes("could not create"))).toBe(true);
    expect(result.config.inboundAuth.keys).toEqual(["k"]);
  });
});

describe("saveConfig — persist + reload round-trip", () => {
  test("writes JSON that reloads to the same provider credential", async () => {
    const outPath = join(dir, "saved.json");
    const cfg = validateConfig({
      ...BASE_RAW,
      providers: {
        zai: {
          type: "openai",
          credential: "zai-key",
          auth: "bearer",
          baseUrl: "https://api.z.ai/api/paas/v4",
          countTokens: false,
          modelsUrl: "https://api.z.ai/api/paas/v4/models",
        },
      },
    });
    await saveConfig(outPath, cfg, {});
    const text = await Bun.file(outPath).text();
    expect(text.endsWith("\n")).toBe(true);
    const reloaded = await loadConfig(outPath, {});
    expect(reloaded.providers.external.zai?.credential).toBe("zai-key");
    expect(reloaded.inboundAuth.keys).toEqual(["k"]);
  });
});

describe("createBedrockTokenProvider — failed-mint eviction", () => {
  test("a mint failure propagates and evicts the entry (the next call re-mints)", async () => {
    // The guard in createBedrockTokenProvider only rejects a FALSY credential,
    // so a truthy non-string value passes it and then makes SigV4 signing
    // reject — exercising the catch. The eviction contract is asserted by error
    // IDENTITY: a cached (not evicted) rejected promise would reject with the
    // SAME Error instance on the retry, whereas an evicted entry re-mints and
    // produces a fresh Error.
    const env = {
      AWS_ACCESS_KEY_ID: "AKIA_TEST",
      AWS_SECRET_ACCESS_KEY: Symbol("not-a-string"),
    } as unknown as Record<string, string | undefined>;
    const provider = createBedrockTokenProvider("dev", env);
    // `provider` is typed `Promise<string> | string`; Promise.resolve normalizes
    // the union so `.catch` is well-typed (and behaves identically at runtime).
    const first = await Promise.resolve(provider("us-east-1")).catch((e: unknown) => e);
    const second = await Promise.resolve(provider("us-east-1")).catch((e: unknown) => e);
    expect(first).toBeInstanceOf(Error);
    expect(second).toBeInstanceOf(Error);
    expect(second).not.toBe(first);
  });
});
