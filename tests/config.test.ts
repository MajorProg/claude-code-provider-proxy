import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertSafeExternalOrigin,
  awsRegionForPrefix,
  hostForRegion,
  loadConfig,
  serializeConfig,
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

  test("empty inbound keys mint an ephemeral key (marked, frozen)", () => {
    const raw = structuredClone(VALID_RAW);
    (raw.inboundAuth as { keys: string[] }).keys = [];
    const cfg = validateConfig(raw);
    expect(cfg.inboundAuth.keys).toHaveLength(1);
    expect(cfg.inboundAuth.keys[0]).toMatch(/^ccpp-ephemeral-[0-9a-f]{32}$/);
    expect(cfg.inboundAuth.ephemeralKey).toBe(true);
    expect(Object.isFrozen(cfg)).toBe(true);
  });

  test("empty-string key entries are filtered; real keys survive alongside", () => {
    const raw = structuredClone(VALID_RAW);
    (raw.inboundAuth as { keys: string[] }).keys = ["", "secret-key", ""];
    const cfg = validateConfig(raw);
    expect(cfg.inboundAuth.keys).toEqual(["secret-key"]);
    expect(cfg.inboundAuth.ephemeralKey).toBeUndefined();
  });

  test("an ephemeral-prefixed entry is stripped and re-minted (stale artifact)", () => {
    const raw = structuredClone(VALID_RAW);
    (raw.inboundAuth as { keys: string[] }).keys = ["ccpp-ephemeral-deadbeef"];
    const cfg = validateConfig(raw);
    // A fresh key was minted (different random value), never the stale one.
    expect(cfg.inboundAuth.keys[0]).toMatch(/^ccpp-ephemeral-[0-9a-f]{32}$/);
    expect(cfg.inboundAuth.keys[0] === "ccpp-ephemeral-deadbeef").toBe(false);
    expect(cfg.inboundAuth.ephemeralKey).toBe(true);
  });

  test("two validations mint different ephemeral keys", () => {
    const raw = structuredClone(VALID_RAW);
    (raw.inboundAuth as { keys: string[] }).keys = [];
    const a = validateConfig(structuredClone(raw));
    const b = validateConfig(structuredClone(raw));
    expect(a.inboundAuth.keys[0]).not.toBe(b.inboundAuth.keys[0]);
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
    expect(cfg.providers.external.zai?.credentials).toEqual([]);
    // Empty pool = missing info: the provider deactivates with a reason.
    expect(cfg.providers.external.zai?.inactiveReason).toContain("credential pool is empty");
  });

  test("flat credential normalizes to a one-entry pool labeled default", () => {
    const raw = structuredClone(VALID_RAW) as typeof VALID_RAW & {
      providers: Record<string, unknown>;
    };
    raw.providers.zai = {
      type: "anthropic",
      credential: "zai-key",
      auth: "bearer",
      baseUrl: "https://api.z.ai/api/anthropic",
      countTokens: true,
      modelsUrl: "https://api.z.ai/api/paas/v4/models",
    };
    const cfg = validateConfig(raw);
    expect(cfg.providers.external.zai?.credentials).toEqual([
      { credential: "zai-key", label: "default" },
    ]);
    expect(cfg.providers.external.zai?.credential).toBe("zai-key");
    expect(cfg.providers.external.zai?.inactiveReason).toBeUndefined();
  });

  test("a credentials array wins over a flat credential; empty entries filtered; labels + names kept", () => {
    const raw = structuredClone(VALID_RAW) as typeof VALID_RAW & {
      providers: Record<string, unknown>;
    };
    raw.providers.zai = {
      type: "anthropic",
      credential: "flat-ignored",
      credentials: [
        { credential: "", label: "unset-env-ref" },
        { credential: "primary-key", label: "primary", name: "Chimera Developer 2" },
        "not-a-record",
        { credential: "secondary-key", name: "" },
      ],
      auth: "bearer",
      baseUrl: "https://api.z.ai/api/anthropic",
      countTokens: true,
      modelsUrl: "https://api.z.ai/api/paas/v4/models",
    };
    const cfg = validateConfig(raw);
    expect(cfg.providers.external.zai?.credentials).toEqual([
      { credential: "primary-key", label: "primary", name: "Chimera Developer 2" },
      { credential: "secondary-key" },
    ]);
    expect(cfg.providers.external.zai?.credential).toBe("primary-key");
  });

  test("a provider with NO credential field at all is inactive, not fatal (pool-only shape)", () => {
    const raw = structuredClone(VALID_RAW) as typeof VALID_RAW & {
      providers: Record<string, unknown>;
    };
    raw.providers.zai = {
      type: "anthropic",
      auth: "bearer",
      baseUrl: "https://api.z.ai/api/anthropic",
      countTokens: true,
      modelsUrl: "https://api.z.ai/api/paas/v4/models",
    };
    const cfg = validateConfig(raw);
    expect(cfg.providers.external.zai?.credentials).toEqual([]);
    expect(cfg.providers.external.zai?.inactiveReason).toContain("credential pool is empty");
  });

  test("an entirely-empty credentials array deactivates the provider", () => {
    const raw = structuredClone(VALID_RAW) as typeof VALID_RAW & {
      providers: Record<string, unknown>;
    };
    raw.providers.zai = {
      type: "anthropic",
      credentials: [{ credential: "" }, { credential: "" }],
      auth: "bearer",
      baseUrl: "https://api.z.ai/api/anthropic",
      countTokens: true,
      modelsUrl: "https://api.z.ai/api/paas/v4/models",
    };
    const cfg = validateConfig(raw);
    expect(cfg.providers.external.zai?.credentials).toEqual([]);
    expect(cfg.providers.external.zai?.inactiveReason).toContain("credential pool is empty");
  });

  test("hostTemplate with an EMPTY workspaceId deactivates the provider (not fatal)", () => {
    // The fork-port scenario: ${DASHSCOPE_WORKSPACE_ID_INTL} resolved empty.
    const raw = structuredClone(VALID_RAW) as typeof VALID_RAW & {
      providers: Record<string, unknown>;
    };
    raw.providers.alibaba = {
      type: "anthropic",
      credential: "sk-secret",
      auth: "x-api-key",
      hostTemplate: "{workspaceId}.{region}.maas.aliyuncs.com",
      workspaceId: "",
      region: "ap-southeast-1",
      basePath: "/apps/anthropic",
      countTokens: true,
      modelsUrl: "https://.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/models",
    };
    const cfg = validateConfig(raw);
    expect(cfg.providers.external.alibaba?.inactiveReason).toContain("workspaceId is empty");
  });

  test("empty modelsUrl deactivates the provider (not fatal)", () => {
    const raw = structuredClone(VALID_RAW) as typeof VALID_RAW & {
      providers: Record<string, unknown>;
    };
    raw.providers.zai = {
      type: "anthropic",
      credential: "sk-secret",
      auth: "bearer",
      baseUrl: "https://api.z.ai/api/anthropic",
      countTokens: true,
      modelsUrl: "",
    };
    const cfg = validateConfig(raw);
    expect(cfg.providers.external.zai?.inactiveReason).toContain("modelsUrl is empty");
  });

  test("an incoming inactiveReason field is ignored (computed, never trusted)", () => {
    const raw = structuredClone(VALID_RAW) as typeof VALID_RAW & {
      providers: Record<string, unknown>;
    };
    raw.providers.zai = {
      type: "anthropic",
      credential: "sk-secret",
      auth: "bearer",
      baseUrl: "https://api.z.ai/api/anthropic",
      countTokens: true,
      modelsUrl: "https://api.z.ai/api/paas/v4/models",
      inactiveReason: "attacker-supplied reason",
    };
    const cfg = validateConfig(raw);
    expect(cfg.providers.external.zai?.inactiveReason).toBeUndefined();
  });
});

describe("validateConfig — multi-region providers", () => {
  const ALIBABA_REGIONS = {
    "ap-southeast-1": {
      hostTemplate: "dashscope-intl.aliyuncs.com",
      basePath: "/apps/anthropic",
      modelsUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models",
      billingMode: "token-plan",
    },
    "eu-central-1": {
      hostTemplate: "{workspaceId}.eu-central-1.maas.aliyuncs.com",
      workspaceId: "ws-eu",
      credential: "sk-eu",
      modelsUrl: "https://ws-eu.eu-central-1.maas.aliyuncs.com/compatible-mode/v1/models",
      billingMode: "payg",
    },
  };

  /** Regions-only alibaba (no baseUrl, no provider-level modelsUrl). */
  function alibabaRaw(regions: unknown): Record<string, unknown> {
    const raw = structuredClone(VALID_RAW) as typeof VALID_RAW & {
      providers: Record<string, unknown>;
    };
    raw.providers.alibaba = {
      type: "anthropic",
      credential: "sk-shared",
      auth: "x-api-key",
      countTokens: true,
      regions,
    };
    return raw;
  }

  test("regions map survives validateConfig with per-region fields intact", () => {
    // Regression: the return object used to drop `regions` entirely, making
    // the multi-region routing feature unreachable from a file-loaded config.
    const cfg = validateConfig(alibabaRaw(ALIBABA_REGIONS));
    const regions = cfg.providers.external.alibaba?.regions;
    expect(regions).toBeDefined();
    expect(Object.keys(regions ?? {})).toEqual(["ap-southeast-1", "eu-central-1"]);
    expect(regions?.["eu-central-1"]?.workspaceId).toBe("ws-eu");
    expect(regions?.["eu-central-1"]?.credential).toBe("sk-eu");
    expect(regions?.["ap-southeast-1"]?.billingMode).toBe("token-plan");
    expect(cfg.providers.external.alibaba?.inactiveReason).toBeUndefined();
  });

  test("regions-only provider (no baseUrl) validates — the documented multi-region shape", () => {
    const cfg = validateConfig(alibabaRaw(ALIBABA_REGIONS));
    expect(cfg.providers.external.alibaba?.baseUrl).toBe("");
    expect(cfg.providers.external.alibaba?.modelsUrl).toBe("");
    expect(cfg.providers.external.alibaba?.inactiveReason).toBeUndefined();
  });

  test("an inactive sibling region does not kill the active one", () => {
    const regions = {
      "ap-southeast-1": {
        hostTemplate: "dashscope-intl.aliyuncs.com",
        basePath: "/apps/anthropic",
        modelsUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models",
      },
      // EU workspace vars unset: empty workspaceId deactivates only this region.
      "eu-central-1": {
        hostTemplate: "{workspaceId}.eu-central-1.maas.aliyuncs.com",
        workspaceId: "",
        credential: "sk-eu",
        modelsUrl: "https://.eu-central-1.maas.aliyuncs.com/compatible-mode/v1/models",
      },
    };
    const cfg = validateConfig(alibabaRaw(regions));
    const r = cfg.providers.external.alibaba?.regions;
    expect(r?.["ap-southeast-1"]?.inactiveReason).toBeUndefined();
    expect(r?.["eu-central-1"]?.inactiveReason).toContain("workspaceId is empty");
  });

  test("region with a bad billingMode stays fatal (structural)", () => {
    const regions = {
      "ap-southeast-1": {
        hostTemplate: "dashscope-intl.aliyuncs.com",
        modelsUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models",
        billingMode: "subscription",
      },
    };
    expect(() => validateConfig(alibabaRaw(regions))).toThrow(ConfigError);
  });

  test("region with an empty modelsUrl deactivates only that region", () => {
    const regions = {
      "ap-southeast-1": {
        hostTemplate: "dashscope-intl.aliyuncs.com",
        modelsUrl: "",
      },
    };
    const cfg = validateConfig(alibabaRaw(regions));
    expect(cfg.providers.external.alibaba?.regions?.["ap-southeast-1"]?.inactiveReason).toContain(
      "modelsUrl is empty",
    );
  });

  test("region pool absent inherits the provider pool (no credentials field emitted)", () => {
    const cfg = validateConfig(alibabaRaw(ALIBABA_REGIONS));
    expect(
      cfg.providers.external.alibaba?.regions?.["ap-southeast-1"]?.credentials,
    ).toBeUndefined();
    expect(cfg.providers.external.alibaba?.regions?.["ap-southeast-1"]?.credential).toBeUndefined();
  });

  test("region-owned pool: flat normalizes, credentials array wins, empty deactivates region", () => {
    const regions = {
      "ap-southeast-1": {
        hostTemplate: "dashscope-intl.aliyuncs.com",
        modelsUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models",
        credentials: [{ credential: "sg-key-1", label: "token-plan" }, { credential: "sg-key-2" }],
      },
      "eu-central-1": {
        hostTemplate: "{workspaceId}.eu-central-1.maas.aliyuncs.com",
        workspaceId: "ws-eu",
        modelsUrl: "https://ws-eu.eu-central-1.maas.aliyuncs.com/compatible-mode/v1/models",
        credential: "eu-flat-key",
      },
      "us-east-1": {
        hostTemplate: "{workspaceId}.us-east-1.maas.aliyuncs.com",
        workspaceId: "ws-us",
        modelsUrl: "https://ws-us.us-east-1.maas.aliyuncs.com/compatible-mode/v1/models",
        credentials: [{ credential: "" }],
      },
    };
    const cfg = validateConfig(alibabaRaw(regions));
    const r = cfg.providers.external.alibaba?.regions;
    expect(r?.["ap-southeast-1"]?.credentials).toEqual([
      { credential: "sg-key-1", label: "token-plan" },
      { credential: "sg-key-2" },
    ]);
    expect(r?.["ap-southeast-1"]?.credential).toBe("sg-key-1");
    expect(r?.["eu-central-1"]?.credentials).toEqual([
      { credential: "eu-flat-key", label: "default" },
    ]);
    expect(r?.["us-east-1"]?.inactiveReason).toContain("credential pool is empty");
  });
});

describe("validateConfig — virtualModels + maxFailoverAttempts", () => {
  const TIER_RAW = {
    server: { host: "127.0.0.1", port: 8787 },
    inboundAuth: { keys: ["k"] },
    primaryRegion: "us",
    profilePreference: "global",
    refreshIntervalMinutes: 60,
    claudeFallbackToMantle: false,
    regions: [{ key: "us", awsRegion: "us-east-1" }],
    providers: {},
  };

  test("valid tier entries are preserved in config order", () => {
    const cfg = validateConfig({
      ...TIER_RAW,
      virtualModels: {
        "sonnet-like": ["zai.anthropic.global.glm-5.3", "bedrock.mantle.us.zai.glm-5"],
      },
    });
    expect(cfg.virtualModels).toEqual({
      "sonnet-like": ["zai.anthropic.global.glm-5.3", "bedrock.mantle.us.zai.glm-5"],
    });
  });

  test("unparseable / non-string / nested-virtual entries are dropped, not fatal", () => {
    const cfg = validateConfig({
      ...TIER_RAW,
      virtualModels: {
        "sonnet-like": [
          "zai.anthropic.global.glm-5.3",
          "not-a-canonical-id",
          42,
          "virtual.anthropic.global.haiku-like",
        ],
      },
    });
    expect(cfg.virtualModels).toEqual({ "sonnet-like": ["zai.anthropic.global.glm-5.3"] });
  });

  test("a tier left empty is dropped; an emptied block is omitted entirely", () => {
    expect(
      validateConfig({ ...TIER_RAW, virtualModels: { "sonnet-like": ["nope"] } }).virtualModels,
    ).toBeUndefined();
    expect(validateConfig({ ...TIER_RAW, virtualModels: {} }).virtualModels).toBeUndefined();
    expect(validateConfig(TIER_RAW).virtualModels).toBeUndefined();
  });

  test("maxFailoverAttempts defaults to 8 and validates [1, 16]", () => {
    expect(validateConfig(TIER_RAW).maxFailoverAttempts).toBe(8);
    expect(validateConfig({ ...TIER_RAW, maxFailoverAttempts: 2 }).maxFailoverAttempts).toBe(2);
    for (const bad of [0, -1, 1.5, "4", 17]) {
      expect(() => validateConfig({ ...TIER_RAW, maxFailoverAttempts: bad })).toThrow(ConfigError);
    }
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

  test("example config with NO env boots: empty creds + ephemeral inbound key + warning", async () => {
    // The zero-env scenario: PROXY_INBOUND_KEY unset (bare ref) mints an
    // ephemeral key; ${VAR:-} provider creds resolve empty. No crash.
    const cfg = await loadConfig("config.example.jsonc", {});
    expect(cfg.inboundAuth.ephemeralKey).toBe(true);
    expect(cfg.inboundAuth.keys[0]).toMatch(/^ccpp-ephemeral-[0-9a-f]{32}$/);
    expect(cfg.providers.bedrock?.credential).toBe("");
    expect(cfg.loadWarnings).toEqual(["PROXY_INBOUND_KEY"]);
  });

  test("missing file throws ConfigError", async () => {
    await expect(loadConfig("nope.jsonc", {})).rejects.toThrow(ConfigError);
  });
});

// zaiWire (z.ai OpenAI-wire controls): model regex sources validated at load,
// preserved verbatim through serialization.
describe("validateConfig — zaiWire", () => {
  const ZAI_RAW = {
    ...structuredClone(VALID_RAW),
    providers: {
      bedrock: VALID_RAW.providers.bedrock,
      zai: {
        type: "openai",
        credential: "k",
        auth: "bearer",
        baseUrl: "https://api.z.ai/api/paas/v4",
        countTokens: false,
        modelsUrl: "https://api.z.ai/api/paas/v4/models",
        zaiWire: {
          forcedThinkingModels: ["^glm-4\\.7(?![\\d])", "^glm-5\\.3(?![\\d])"],
          reasoningEffortModels: ["^glm-5\\.[2-9]", "^glm-[6-9]"],
        },
      },
    },
  };

  test("parses the regex lists and round-trips them verbatim", () => {
    const cfg = validateConfig(structuredClone(ZAI_RAW));
    const zai = cfg.providers.external.zai;
    expect(zai?.zaiWire?.forcedThinkingModels).toEqual([
      "^glm-4\\.7(?![\\d])",
      "^glm-5\\.3(?![\\d])",
    ]);
    const round = serializeConfig(cfg);
    const zaiRound = (round.providers as Record<string, { zaiWire?: unknown }>).zai;
    expect(zaiRound?.zaiWire).toEqual(cfg.providers.external.zai?.zaiWire);
    // A re-validation of the serialized form accepts it unchanged.
    const cfg2 = validateConfig(structuredClone(round));
    expect(cfg2.providers.external.zai?.zaiWire ?? null).toEqual(zai?.zaiWire ?? null);
  });

  test("an empty zaiWire block defaults both lists to []", () => {
    const raw = structuredClone(ZAI_RAW);
    (raw.providers as { zai: { zaiWire: unknown } }).zai.zaiWire = {};
    const cfg = validateConfig(raw);
    expect(cfg.providers.external.zai?.zaiWire).toEqual({
      forcedThinkingModels: [],
      reasoningEffortModels: [],
    });
  });

  test("an invalid regex fails fast (ConfigError names the path)", () => {
    const raw = structuredClone(ZAI_RAW);
    (
      raw.providers as { zai: { zaiWire: { forcedThinkingModels: string[] } } }
    ).zai.zaiWire.forcedThinkingModels = ["([unclosed"];
    expect(() => validateConfig(raw)).toThrow(/zaiWire\.forcedThinkingModels/);
  });

  test("a non-array list is a structural error", () => {
    const raw = structuredClone(ZAI_RAW);
    (
      raw.providers as unknown as { zai: { zaiWire: { reasoningEffortModels: number } } }
    ).zai.zaiWire.reasoningEffortModels = 7;
    expect(() => validateConfig(raw)).toThrow(ConfigError);
  });
});

// Per-type provider switches (countTokens / strictTools): asserted as booleans
// the same way accountScoped is, so a quoted "true" fails fast instead of
// validating and silently disabling the feature.
describe("validateConfig — boolean provider flags fail fast on a non-boolean type", () => {
  function providerRaw(extra: Record<string, unknown>) {
    const raw = structuredClone(VALID_RAW) as typeof VALID_RAW & {
      providers: Record<string, unknown>;
    };
    raw.providers.zai = {
      type: "anthropic",
      credential: "k",
      auth: "bearer",
      baseUrl: "https://api.z.ai/api/anthropic",
      modelsUrl: "https://api.z.ai/api/paas/v4/models",
      ...extra,
    };
    return raw;
  }

  test('a quoted countTokens ("true") is a structural error, not a silent disable', () => {
    expect(() => validateConfig(providerRaw({ countTokens: "true" }))).toThrow(
      /countTokens must be a boolean/,
    );
  });

  test('a quoted strictTools ("true") is a structural error', () => {
    expect(() => validateConfig(providerRaw({ strictTools: "true" }))).toThrow(
      /strictTools must be a boolean/,
    );
  });

  test("absent and real booleans still validate (strictTools omitted when falsy)", () => {
    const absent = validateConfig(providerRaw({}));
    expect(absent.providers.external.zai?.countTokens).toBe(false);
    expect(absent.providers.external.zai?.strictTools).toBeUndefined();

    const real = validateConfig(providerRaw({ countTokens: true, strictTools: true }));
    expect(real.providers.external.zai?.countTokens).toBe(true);
    expect(real.providers.external.zai?.strictTools).toBe(true);

    // A false strictTools validates but is OMITTED from the result (optional
    // field, omit-if-absent shape preserved).
    const falsy = validateConfig(providerRaw({ countTokens: false, strictTools: false }));
    expect(falsy.providers.external.zai?.strictTools).toBeUndefined();
  });
});

// A field read by only one provider `type` (router.ts wires each per-type)
// validates on the wrong type but is NEVER read. loadConfig reports it as a
// non-fatal load warning (surfaced in /status.json, /api/config/status, doctor)
// so an operator does not believe a feature is on when it never runs.
describe("loadConfig — misplaced per-type provider fields warn (non-fatal)", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ccpp-misplaced-"));
    path = join(dir, "config.local.jsonc");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeProviders(providersJson: string): void {
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
        "providers": { ${providersJson} }
      }`,
    );
  }

  test('zaiWire on a type "anthropic" provider warns (names field + provider)', async () => {
    writeProviders(`"anthropicp": {
      "type": "anthropic",
      "credential": "k",
      "auth": "bearer",
      "baseUrl": "https://api.example.com/anthropic",
      "countTokens": true,
      "modelsUrl": "https://api.example.com/v1/models",
      "zaiWire": { "forcedThinkingModels": ["^glm-5"], "reasoningEffortModels": ["^glm-5"] }
    }`);
    const cfg = await loadConfig(path, {});
    const warnings = cfg.loadWarnings ?? [];
    const zaiWireWarning = warnings.find((w) => w.includes("providers.anthropicp.zaiWire"));
    expect(zaiWireWarning).toBeDefined();
    expect(zaiWireWarning).toContain('type "anthropic"');
    expect(zaiWireWarning).toContain('only read for type "openai"');
  });

  test('zaiWire on a type "openai" provider does NOT warn', async () => {
    writeProviders(`"zai": {
      "type": "openai",
      "credential": "k",
      "auth": "bearer",
      "baseUrl": "https://api.z.ai/api/paas/v4",
      "countTokens": false,
      "modelsUrl": "https://api.z.ai/api/paas/v4/models",
      "zaiWire": { "forcedThinkingModels": ["^glm-5"], "reasoningEffortModels": ["^glm-5"] }
    }`);
    const cfg = await loadConfig(path, {});
    expect(cfg.loadWarnings).toBeUndefined();
  });

  test('countTokens: true on a type "openai" provider warns', async () => {
    writeProviders(`"oa": {
      "type": "openai",
      "credential": "k",
      "auth": "bearer",
      "baseUrl": "https://api.example.com/v1",
      "countTokens": true,
      "modelsUrl": "https://api.example.com/v1/models"
    }`);
    const cfg = await loadConfig(path, {});
    expect((cfg.loadWarnings ?? []).some((w) => w.includes("providers.oa.countTokens"))).toBe(true);
  });

  test('strictTools on a type "anthropic" provider warns', async () => {
    writeProviders(`"anthropicp": {
      "type": "anthropic",
      "credential": "k",
      "auth": "bearer",
      "baseUrl": "https://api.example.com/anthropic",
      "countTokens": true,
      "modelsUrl": "https://api.example.com/v1/models",
      "strictTools": true
    }`);
    const cfg = await loadConfig(path, {});
    expect(
      (cfg.loadWarnings ?? []).some((w) => w.includes("providers.anthropicp.strictTools")),
    ).toBe(true);
  });

  test("a well-typed provider produces no warning (loadWarnings undefined)", async () => {
    writeProviders(`"zai": {
      "type": "anthropic",
      "credential": "k",
      "auth": "bearer",
      "baseUrl": "https://api.z.ai/api/anthropic",
      "countTokens": true,
      "modelsUrl": "https://api.z.ai/api/paas/v4/models"
    }`);
    const cfg = await loadConfig(path, {});
    expect(cfg.loadWarnings).toBeUndefined();
  });
});
