import { describe, expect, test } from "bun:test";
import {
  assertSafeExternalOrigin,
  awsRegionForPrefix,
  hostForRegion,
  loadConfig,
  validateConfig,
} from "../src/config.ts";
import { ConfigError } from "../src/errors.ts";

describe("request limits config (SEC-4)", () => {
  test("applies defaults when the limits block is absent", () => {
    const cfg = validateConfig(VALID_RAW);
    expect(cfg.limits.maxMessages).toBe(100_000);
    expect(cfg.limits.maxContentBlocksPerMessage).toBe(10_000);
    expect(cfg.limits.maxTools).toBe(1_000);
  });

  test("honors explicit limits and fills missing fields with defaults", () => {
    const cfg = validateConfig({ ...VALID_RAW, limits: { maxMessages: 5 } });
    expect(cfg.limits.maxMessages).toBe(5);
    expect(cfg.limits.maxTools).toBe(1_000); // default preserved
  });

  test("rejects a non-positive limit", () => {
    expect(() => validateConfig({ ...VALID_RAW, limits: { maxTools: 0 } })).toThrow(ConfigError);
    expect(() => validateConfig({ ...VALID_RAW, limits: { maxMessages: -1 } })).toThrow(
      ConfigError,
    );
  });
});

describe("logging captureTimeoutMs config (PC8)", () => {
  test("defaults to 120000ms when absent", () => {
    const cfg = validateConfig(VALID_RAW);
    expect(cfg.logging.captureTimeoutMs).toBe(120_000);
  });

  test("honors an explicit positive integer", () => {
    const cfg = validateConfig({
      ...VALID_RAW,
      logging: { enabled: false, captureTimeoutMs: 30_000 },
    });
    expect(cfg.logging.captureTimeoutMs).toBe(30_000);
  });

  test("falls back to the default for non-positive / non-integer values", () => {
    for (const bad of [0, -1, 1.5, "60000"]) {
      const cfg = validateConfig({
        ...VALID_RAW,
        logging: { enabled: false, captureTimeoutMs: bad },
      });
      expect(cfg.logging.captureTimeoutMs).toBe(120_000);
    }
  });
});

describe("assertSafeExternalOrigin (SEC-9 SSRF guard)", () => {
  test("allows public https origins", () => {
    expect(() => assertSafeExternalOrigin("https://api.openai.com/v1")).not.toThrow();
    expect(() =>
      assertSafeExternalOrigin("https://generativelanguage.googleapis.com"),
    ).not.toThrow();
    // Explicit localhost is permitted for local dev.
    expect(() => assertSafeExternalOrigin("http://localhost:1234")).not.toThrow();
  });

  test("blocks cloud-metadata + link-local (169.254.0.0/16, incl IPv4-mapped)", () => {
    expect(() => assertSafeExternalOrigin("https://169.254.169.254/latest/meta-data")).toThrow(
      ConfigError,
    );
    expect(() => assertSafeExternalOrigin("https://[::ffff:169.254.169.254]")).toThrow(ConfigError);
  });

  test("blocks loopback + RFC-1918 ranges", () => {
    expect(() => assertSafeExternalOrigin("https://127.0.0.1")).toThrow(ConfigError);
    expect(() => assertSafeExternalOrigin("https://[::1]")).toThrow(ConfigError);
    expect(() => assertSafeExternalOrigin("https://10.0.0.7")).toThrow(ConfigError);
    expect(() => assertSafeExternalOrigin("https://172.16.5.5")).toThrow(ConfigError);
    expect(() => assertSafeExternalOrigin("https://192.168.1.50")).toThrow(ConfigError);
    expect(() => assertSafeExternalOrigin("https://0.0.0.0")).toThrow(ConfigError);
  });

  test("allows public IPs adjacent to private ranges", () => {
    expect(() => assertSafeExternalOrigin("https://172.15.0.1")).not.toThrow();
    expect(() => assertSafeExternalOrigin("https://172.32.0.1")).not.toThrow();
    expect(() => assertSafeExternalOrigin("https://11.0.0.1")).not.toThrow();
  });

  test("throws on a malformed URL", () => {
    expect(() => assertSafeExternalOrigin("not a url")).toThrow(ConfigError);
  });
});

const VALID_RAW = {
  server: { host: "127.0.0.1", port: 8787 },
  inboundAuth: { keys: ["secret-key"] },
  primaryRegion: "us",
  profilePreference: "global",
  refreshIntervalMinutes: 60,
  claudeFallbackToMantle: false,
  regions: [
    { key: "us", awsRegion: "us-east-1" },
    { key: "eu", awsRegion: "eu-west-1" },
  ],
  providers: {
    bedrock: {
      credential: "bedrock-api-key-xxx",
      hosts: {
        converse: "bedrock-runtime.{region}.amazonaws.com",
        mantle: "bedrock-mantle.{region}.api.aws",
      },
    },
  },
};

describe("validateConfig", () => {
  test("accepts a valid config and freezes it", () => {
    const cfg = validateConfig(structuredClone(VALID_RAW));
    expect(cfg.primaryRegion).toBe("us");
    expect(cfg.regions).toHaveLength(2);
    expect(Object.isFrozen(cfg)).toBe(true);
  });

  test("rejects invalid port", () => {
    const bad = structuredClone(VALID_RAW);
    (bad.server as { port: number }).port = 0;
    expect(() => validateConfig(bad)).toThrow(ConfigError);
  });

  test("rejects empty inbound keys", () => {
    const bad = structuredClone(VALID_RAW);
    (bad.inboundAuth as { keys: string[] }).keys = [];
    expect(() => validateConfig(bad)).toThrow(ConfigError);
  });

  test("rejects primaryRegion with no matching region entry", () => {
    const bad = structuredClone(VALID_RAW);
    bad.regions = [{ key: "eu", awsRegion: "eu-west-1" }];
    expect(() => validateConfig(bad)).toThrow(ConfigError);
  });

  test("rejects duplicate region keys", () => {
    const bad = structuredClone(VALID_RAW);
    bad.regions = [
      { key: "us", awsRegion: "us-east-1" },
      { key: "us", awsRegion: "us-west-2" },
    ];
    expect(() => validateConfig(bad)).toThrow(ConfigError);
  });

  test("rejects host template without {region}", () => {
    const bad = structuredClone(VALID_RAW);
    bad.providers.bedrock.hosts.converse = "bedrock-runtime.us-east-1.amazonaws.com";
    expect(() => validateConfig(bad)).toThrow(ConfigError);
  });

  test("rejects invalid profilePreference", () => {
    const bad = structuredClone(VALID_RAW);
    (bad as { profilePreference: string }).profilePreference = "sometimes";
    expect(() => validateConfig(bad)).toThrow(ConfigError);
  });

  test("rejects refreshIntervalMinutes out of [1,1440]", () => {
    const tooBig = structuredClone(VALID_RAW);
    tooBig.refreshIntervalMinutes = 600000;
    expect(() => validateConfig(tooBig)).toThrow(ConfigError);
    const zero = structuredClone(VALID_RAW);
    zero.refreshIntervalMinutes = 0;
    expect(() => validateConfig(zero)).toThrow(ConfigError);
  });

  test("rejects a credentialed external provider on http:// (non-localhost)", () => {
    const bad = structuredClone(VALID_RAW) as typeof VALID_RAW & {
      providers: Record<string, unknown>;
    };
    bad.providers.insecure = {
      type: "openai",
      credential: "sk-secret",
      auth: "bearer",
      baseUrl: "http://api.example.com/v1",
      countTokens: false,
      modelsUrl: "http://api.example.com/v1/models",
    };
    expect(() => validateConfig(bad)).toThrow(ConfigError);
  });

  test("accepts an external provider on https://", () => {
    const ok = structuredClone(VALID_RAW) as typeof VALID_RAW & {
      providers: Record<string, unknown>;
    };
    ok.providers.deepseek = {
      type: "anthropic",
      credential: "sk-secret",
      auth: "x-api-key",
      baseUrl: "https://api.deepseek.com/anthropic",
      countTokens: true,
      modelsUrl: "https://api.deepseek.com/v1/models",
    };
    const cfg = validateConfig(ok);
    expect(cfg.providers.external.deepseek?.baseUrl).toBe("https://api.deepseek.com/anthropic");
  });

  test("accepts a host-templated provider when all placeholders resolve (Task 34)", () => {
    const ok = structuredClone(VALID_RAW) as typeof VALID_RAW & {
      providers: Record<string, unknown>;
    };
    ok.providers.alibaba = {
      type: "anthropic",
      credential: "sk-secret",
      auth: "x-api-key",
      hostTemplate: "{workspaceId}.{region}.maas.aliyuncs.com",
      workspaceId: "ws-123",
      region: "eu-central-1",
      basePath: "/apps/anthropic",
      countTokens: true,
      modelsUrl: "https://ws-123.eu-central-1.maas.aliyuncs.com/compatible-mode/v1/models",
    };
    const cfg = validateConfig(ok);
    expect(cfg.providers.external.alibaba?.hostTemplate).toBe(
      "{workspaceId}.{region}.maas.aliyuncs.com",
    );
  });

  test("rejects a hostTemplate whose {region} placeholder has no value (Task 34)", () => {
    const bad = structuredClone(VALID_RAW) as typeof VALID_RAW & {
      providers: Record<string, unknown>;
    };
    bad.providers.alibaba = {
      type: "anthropic",
      credential: "sk-secret",
      auth: "x-api-key",
      hostTemplate: "{workspaceId}.{region}.maas.aliyuncs.com",
      workspaceId: "ws-123",
      // region intentionally omitted -> {region} would substitute to ""
      countTokens: true,
      modelsUrl: "https://ws-123.maas.aliyuncs.com/compatible-mode/v1/models",
    };
    expect(() => validateConfig(bad)).toThrow(ConfigError);
  });

  test("rejects a hostTemplate with an unknown placeholder (Task 34)", () => {
    const bad = structuredClone(VALID_RAW) as typeof VALID_RAW & {
      providers: Record<string, unknown>;
    };
    bad.providers.alibaba = {
      type: "anthropic",
      credential: "sk-secret",
      auth: "x-api-key",
      hostTemplate: "{workspaceId}.{zone}.maas.aliyuncs.com",
      workspaceId: "ws-123",
      region: "eu-central-1",
      countTokens: true,
      modelsUrl: "https://ws-123.maas.aliyuncs.com/compatible-mode/v1/models",
    };
    expect(() => validateConfig(bad)).toThrow(ConfigError);
  });

  test("accepts a config with no bedrock provider (external-only)", () => {
    const raw = structuredClone(VALID_RAW);
    (raw.providers as { bedrock?: unknown }).bedrock = undefined;
    const cfg = validateConfig(raw);
    expect(cfg.providers.bedrock).toBeUndefined();
  });

  test("accepts an empty bedrock credential (bedrock disabled)", () => {
    const raw = structuredClone(VALID_RAW);
    raw.providers.bedrock.credential = "";
    const cfg = validateConfig(raw);
    expect(cfg.providers.bedrock?.credential).toBe("");
  });

  test("accepts an empty external credential (provider skipped until key set)", () => {
    const raw = structuredClone(VALID_RAW) as typeof VALID_RAW & {
      providers: Record<string, unknown>;
    };
    raw.providers.zai = {
      type: "anthropic",
      credential: "",
      auth: "bearer",
      baseUrl: "https://api.z.ai/api/anthropic",
      countTokens: true,
      modelsUrl: "https://api.z.ai/api/paas/v4/models",
    };
    const cfg = validateConfig(raw);
    expect(cfg.providers.external.zai?.credential).toBe("");
  });
});

describe("region + host helpers", () => {
  const cfg = validateConfig(structuredClone(VALID_RAW));

  test("global prefix resolves to primary region", () => {
    expect(awsRegionForPrefix(cfg, "global")).toBe("us-east-1");
  });
  test("us/eu prefixes resolve to their region", () => {
    expect(awsRegionForPrefix(cfg, "us")).toBe("us-east-1");
    expect(awsRegionForPrefix(cfg, "eu")).toBe("eu-west-1");
  });
  test("unknown prefix throws", () => {
    expect(() => awsRegionForPrefix(cfg, "ap")).toThrow(ConfigError);
  });
  test("hostForRegion substitutes {region}", () => {
    expect(hostForRegion("bedrock-mantle.{region}.api.aws", "eu-west-1")).toBe(
      "bedrock-mantle.eu-west-1.api.aws",
    );
  });
});

describe("loadConfig (JSONC + env interpolation)", () => {
  test("loads example config with env vars set", async () => {
    const cfg = await loadConfig("config.example.jsonc", {
      PROXY_INBOUND_KEY: "inbound-123",
      BEDROCK_API_KEY: "bedrock-api-key-abc",
    });
    expect(cfg.inboundAuth.keys[0]).toBe("inbound-123");
    expect(cfg.providers.bedrock?.credential).toBe("bedrock-api-key-abc");
    expect(cfg.primaryRegion).toBe("us");
  });

  test("example config loads with NO provider keys (bedrock + zai skipped, not fatal)", async () => {
    // The fresh-clone path: only the inbound key exists. ${VAR:-} defaults make
    // the unset provider keys resolve empty instead of failing the config.
    const cfg = await loadConfig("config.example.jsonc", { PROXY_INBOUND_KEY: "inbound-123" });
    expect(cfg.providers.bedrock?.credential).toBe("");
    expect(cfg.providers.external.zai?.credential).toBe("");
  });

  test("fails fast when a referenced env var is unset", async () => {
    await expect(loadConfig("config.example.jsonc", {})).rejects.toThrow(ConfigError);
  });

  test("missing file throws ConfigError", async () => {
    await expect(loadConfig("nope.jsonc", {})).rejects.toThrow(ConfigError);
  });
});
