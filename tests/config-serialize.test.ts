/**
 * Config serialization tests — focus on preserving ${ENV} references on save
 * so a UI save never bakes an env-sourced secret into the file.
 */
import { describe, expect, test } from "bun:test";
import { serializeConfig, validateConfig } from "../src/config.ts";

const ENV = {
  PROXY_INBOUND_KEY: "inbound-secret-abc123",
  BEDROCK_API_KEY: "dev",
  DEEPSEEK_API_KEY: "sk-deepseek-secret-xyz789",
  DASHSCOPE_API_KEY_EU: "sk-ws-eu-secret-longvalue-1234",
  DASHSCOPE_WORKSPACE_ID_EU: "ws-euworkspace9999",
};

function load() {
  // validateConfig receives already-interpolated values (as loadConfig would
  // produce). We simulate that by substituting ENV ourselves.
  const raw = {
    server: { host: "127.0.0.1", port: 8787 },
    inboundAuth: { keys: [ENV.PROXY_INBOUND_KEY] },
    primaryRegion: "us",
    profilePreference: "global",
    refreshIntervalMinutes: 60,
    claudeFallbackToMantle: false,
    regions: [{ key: "us", awsRegion: "us-east-1" }],
    providers: {
      bedrock: {
        credential: ENV.BEDROCK_API_KEY,
        hosts: {
          converse: "bedrock-runtime.{region}.amazonaws.com",
          mantle: "bedrock-mantle.{region}.api.aws",
          control: "bedrock.{region}.amazonaws.com",
        },
      },
      deepseek: {
        type: "anthropic",
        credential: ENV.DEEPSEEK_API_KEY,
        auth: "x-api-key",
        baseUrl: "https://api.deepseek.com/anthropic",
        countTokens: true,
        modelsUrl: "https://api.deepseek.com/v1/models",
      },
      alibaba: {
        type: "anthropic",
        credential: ENV.DASHSCOPE_API_KEY_EU,
        auth: "x-api-key",
        workspaceId: ENV.DASHSCOPE_WORKSPACE_ID_EU,
        hostTemplate: "{workspaceId}.{region}.maas.aliyuncs.com",
        region: "eu-central-1",
        basePath: "/apps/anthropic",
        countTokens: true,
        modelsUrl: `https://${ENV.DASHSCOPE_WORKSPACE_ID_EU}.eu-central-1.maas.aliyuncs.com/compatible-mode/v1/models`,
      },
    },
  };
  return validateConfig(raw);
}

describe("serializeConfig ${ENV} preservation", () => {
  test("with env: secrets are written back as ${VAR} references", () => {
    const out = serializeConfig(load(), ENV);
    const providers = out.providers as Record<string, Record<string, unknown> | undefined>;
    expect(providers.bedrock?.credential).toBe("${BEDROCK_API_KEY}");
    expect(providers.deepseek?.credential).toBe("${DEEPSEEK_API_KEY}");
    expect(providers.alibaba?.credential).toBe("${DASHSCOPE_API_KEY_EU}");
    expect(providers.alibaba?.workspaceId).toBe("${DASHSCOPE_WORKSPACE_ID_EU}");
    // Embedded ref inside a URL is restored too.
    expect(providers.alibaba?.modelsUrl).toBe(
      "https://${DASHSCOPE_WORKSPACE_ID_EU}.eu-central-1.maas.aliyuncs.com/compatible-mode/v1/models",
    );
    // Inbound key too.
    expect((out.inboundAuth as { keys: string[] }).keys[0]).toBe("${PROXY_INBOUND_KEY}");
    // No raw secret leaked into the serialized output.
    const json = JSON.stringify(out);
    expect(json.includes(ENV.DEEPSEEK_API_KEY)).toBe(false);
    expect(json.includes(ENV.DASHSCOPE_API_KEY_EU)).toBe(false);
    expect(json.includes(ENV.PROXY_INBOUND_KEY)).toBe(false);
  });

  test("without env: values are written literally (display path)", () => {
    const out = serializeConfig(load());
    const providers = out.providers as Record<string, Record<string, unknown> | undefined>;
    expect(providers.deepseek?.credential).toBe(ENV.DEEPSEEK_API_KEY);
    expect(providers.alibaba?.workspaceId).toBe(ENV.DASHSCOPE_WORKSPACE_ID_EU);
  });

  test("exact-match works even for short values (e.g. dev sentinel)", () => {
    // "dev" is short but an EXACT match for BEDROCK_API_KEY, so it's safely
    // reverse-mapped to the ref (exact-match can't cause substring collisions).
    const out = serializeConfig(load(), ENV);
    const providers = out.providers as Record<string, Record<string, unknown> | undefined>;
    expect(providers.bedrock?.credential).toBe("${BEDROCK_API_KEY}");
  });
});

describe("serializeConfig bedrock optionality", () => {
  function rawWithoutBedrock() {
    const raw = {
      server: { host: "127.0.0.1", port: 8787 },
      inboundAuth: { keys: ["k"] },
      primaryRegion: "us",
      profilePreference: "global",
      refreshIntervalMinutes: 60,
      claudeFallbackToMantle: false,
      regions: [{ key: "us", awsRegion: "us-east-1" }],
      providers: {
        zai: {
          type: "anthropic",
          credential: "zai-key",
          auth: "bearer",
          baseUrl: "https://api.z.ai/api/anthropic",
          countTokens: true,
          modelsUrl: "https://api.z.ai/api/paas/v4/models",
        },
      },
    };
    return validateConfig(raw);
  }

  test("a config with no bedrock block serializes with NO providers.bedrock key", () => {
    const out = serializeConfig(rawWithoutBedrock(), { ZAI_API_KEY: "zai-key" });
    const providers = out.providers as Record<string, unknown>;
    expect("bedrock" in providers).toBe(false);
    expect(providers.zai).toBeDefined();
  });

  test('an empty bedrock credential round-trips as "" (never a strict ${VAR} ref)', () => {
    // With BEDROCK_API_KEY unset in env, an empty credential must stay "" —
    // restoring "${BEDROCK_API_KEY}" would fail the NEXT boot (bare ref, unset
    // var). buildEnvRefMap skips empty env values, so this holds.
    const raw = {
      server: { host: "127.0.0.1", port: 8787 },
      inboundAuth: { keys: ["k"] },
      primaryRegion: "us",
      profilePreference: "global",
      refreshIntervalMinutes: 60,
      claudeFallbackToMantle: false,
      regions: [{ key: "us", awsRegion: "us-east-1" }],
      providers: {
        bedrock: {
          credential: "",
          hosts: {
            converse: "bedrock-runtime.{region}.amazonaws.com",
            mantle: "bedrock-mantle.{region}.api.aws",
          },
        },
      },
    };
    const out = serializeConfig(validateConfig(raw), {});
    const providers = out.providers as Record<string, Record<string, unknown> | undefined>;
    expect(providers.bedrock?.credential).toBe("");
  });
});

describe("serializeConfig multi-region round-trip", () => {
  function regionsConfig() {
    return validateConfig({
      server: { host: "127.0.0.1", port: 8787 },
      inboundAuth: { keys: ["k"] },
      primaryRegion: "us",
      profilePreference: "global",
      refreshIntervalMinutes: 60,
      claudeFallbackToMantle: false,
      regions: [{ key: "us", awsRegion: "us-east-1" }],
      providers: {
        alibaba: {
          type: "anthropic",
          credential: "sk-shared",
          auth: "x-api-key",
          countTokens: true,
          regions: {
            "ap-southeast-1": {
              hostTemplate: "dashscope-intl.aliyuncs.com",
              basePath: "/apps/anthropic",
              modelsUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models",
              billingMode: "token-plan",
            },
            "eu-central-1": {
              hostTemplate: "{workspaceId}.eu-central-1.maas.aliyuncs.com",
              workspaceId: ENV.DASHSCOPE_WORKSPACE_ID_EU,
              credential: ENV.DASHSCOPE_API_KEY_EU,
              modelsUrl: `https://${ENV.DASHSCOPE_WORKSPACE_ID_EU}.eu-central-1.maas.aliyuncs.com/compatible-mode/v1/models`,
              billingMode: "payg",
            },
          },
        },
      },
    });
  }

  test("regions survive serialization (never dropped) and reload as an equal config", () => {
    // Regression: the provider loop used to omit `regions` entirely, so one UI
    // save wiped the multi-region map from config.local.jsonc.
    const out = serializeConfig(regionsConfig(), ENV);
    const providers = out.providers as Record<string, Record<string, unknown> | undefined>;
    const regions = providers.alibaba?.regions as Record<string, Record<string, unknown>>;
    expect(Object.keys(regions)).toEqual(["ap-southeast-1", "eu-central-1"]);
    // Region secrets restored to ${VAR} refs, embedded URL refs restored.
    expect(regions["eu-central-1"]?.credential).toBe("${DASHSCOPE_API_KEY_EU}");
    expect(regions["eu-central-1"]?.workspaceId).toBe("${DASHSCOPE_WORKSPACE_ID_EU}");
    expect(regions["eu-central-1"]?.modelsUrl).toBe(
      "https://${DASHSCOPE_WORKSPACE_ID_EU}.eu-central-1.maas.aliyuncs.com/compatible-mode/v1/models",
    );
    expect(regions["ap-southeast-1"]?.billingMode).toBe("token-plan");
    // No raw region secret leaked.
    expect(JSON.stringify(out).includes(ENV.DASHSCOPE_API_KEY_EU)).toBe(false);
    // The serialized shape reloads to an equivalent config.
    const reloaded = validateConfig(out);
    expect(Object.keys(reloaded.providers.external.alibaba?.regions ?? {})).toEqual([
      "ap-southeast-1",
      "eu-central-1",
    ]);
  });

  test("an inactive region's computed reason is never serialized", () => {
    const cfg = regionsConfig();
    // Degrade the EU region by emptying its workspaceId post-validation would
    // bypass the real path — instead serialize a config whose EU region was
    // validated inactive from raw input:
    const degraded = validateConfig({
      server: { host: "127.0.0.1", port: 8787 },
      inboundAuth: { keys: ["k"] },
      primaryRegion: "us",
      profilePreference: "global",
      refreshIntervalMinutes: 60,
      claudeFallbackToMantle: false,
      regions: [{ key: "us", awsRegion: "us-east-1" }],
      providers: {
        alibaba: {
          type: "anthropic",
          credential: "sk-shared",
          auth: "x-api-key",
          countTokens: true,
          regions: {
            "eu-central-1": {
              hostTemplate: "{workspaceId}.eu-central-1.maas.aliyuncs.com",
              workspaceId: "",
              modelsUrl: "https://.eu-central-1.maas.aliyuncs.com/compatible-mode/v1/models",
            },
          },
        },
      },
    });
    expect(
      degraded.providers.external.alibaba?.regions?.["eu-central-1"]?.inactiveReason,
    ).toContain("workspaceId is empty");
    const out = serializeConfig(degraded, {});
    expect(JSON.stringify(out)).not.toContain("inactiveReason");
    // `cfg` reference kept meaningful: same provider key round-trips.
    const providers = out.providers as Record<string, unknown>;
    expect(providers.alibaba).toBeDefined();
    expect(cfg.providers.external.alibaba?.regions).toBeDefined();
  });

  test("a DEGRADED provider display round-trips through validateConfig (inactive, not fatal)", () => {
    // The UI flow: GET /api/config (display serialize) -> operator saves ->
    // POST the same object back. A degraded provider (empty workspaceId after
    // an unset env ref) must serialize its empty-but-required fields — not
    // OMIT them — or the POST trips the absent-field structural assert and
    // the config becomes unsavable.
    const degraded = validateConfig({
      server: { host: "127.0.0.1", port: 8787 },
      inboundAuth: { keys: ["k"] },
      primaryRegion: "us",
      profilePreference: "global",
      refreshIntervalMinutes: 60,
      claudeFallbackToMantle: false,
      regions: [{ key: "us", awsRegion: "us-east-1" }],
      providers: {
        alibaba: {
          type: "anthropic",
          credential: "",
          auth: "x-api-key",
          hostTemplate: "{workspaceId}.{region}.maas.aliyuncs.com",
          workspaceId: "",
          region: "ap-southeast-1",
          basePath: "/apps/anthropic",
          countTokens: true,
          modelsUrl: "",
        },
      },
    });
    expect(degraded.providers.external.alibaba?.inactiveReason).toContain("workspaceId is empty");
    const displayed = serializeConfig(degraded); // what GET /api/config returns
    // Empty-but-required fields survive as "", not omitted.
    const shown = (displayed.providers as Record<string, Record<string, unknown>>).alibaba;
    expect(shown?.workspaceId).toBe("");
    expect(shown?.modelsUrl).toBe("");
    // And the POST side: revalidating the displayed object stays non-fatal,
    // still inactive with the same reason.
    const reposted = validateConfig(displayed);
    expect(reposted.providers.external.alibaba?.inactiveReason).toContain("workspaceId is empty");
  });

  test("a real env-backed bedrock key still restores the strict ref", () => {
    const raw = {
      server: { host: "127.0.0.1", port: 8787 },
      inboundAuth: { keys: ["k"] },
      primaryRegion: "us",
      profilePreference: "global",
      refreshIntervalMinutes: 60,
      claudeFallbackToMantle: false,
      regions: [{ key: "us", awsRegion: "us-east-1" }],
      providers: {
        bedrock: {
          credential: "bedrock-api-key-realpayload",
          hosts: {
            converse: "bedrock-runtime.{region}.amazonaws.com",
            mantle: "bedrock-mantle.{region}.api.aws",
          },
        },
      },
    };
    const out = serializeConfig(validateConfig(raw), {
      BEDROCK_API_KEY: "bedrock-api-key-realpayload",
    });
    const providers = out.providers as Record<string, Record<string, unknown> | undefined>;
    expect(providers.bedrock?.credential).toBe("${BEDROCK_API_KEY}");
  });
});

describe("serializeConfig credential pools", () => {
  const BASE = {
    server: { host: "127.0.0.1", port: 8787 },
    inboundAuth: { keys: ["k"] },
    primaryRegion: "us",
    profilePreference: "global",
    refreshIntervalMinutes: 60,
    claudeFallbackToMantle: false,
    regions: [{ key: "us", awsRegion: "us-east-1" }],
    logging: { enabled: false },
    chatPage: { enabled: false },
  };

  test("single-key config round-trips as a flat credential (no churn)", () => {
    const cfg = validateConfig({
      ...BASE,
      providers: {
        zai: {
          type: "anthropic",
          credential: ENV.DEEPSEEK_API_KEY,
          auth: "bearer",
          baseUrl: "https://api.z.ai/api/anthropic",
          countTokens: true,
          modelsUrl: "https://api.z.ai/api/paas/v4/models",
        },
      },
    });
    const out = serializeConfig(cfg, ENV);
    const zai = (out.providers as Record<string, Record<string, unknown>>).zai;
    expect(zai?.credential).toBe("${DEEPSEEK_API_KEY}");
    expect(zai?.credentials).toBeUndefined();
  });

  test("multi-entry pool round-trips with labels and per-entry ${ENV} restore", () => {
    const cfg = validateConfig({
      ...BASE,
      providers: {
        zai: {
          type: "anthropic",
          credentials: [
            { credential: ENV.PROXY_INBOUND_KEY, label: "primary" },
            { credential: ENV.DEEPSEEK_API_KEY, label: "secondary" },
          ],
          auth: "bearer",
          baseUrl: "https://api.z.ai/api/anthropic",
          countTokens: true,
          modelsUrl: "https://api.z.ai/api/paas/v4/models",
        },
      },
    });
    const out = serializeConfig(cfg, ENV);
    const zai = (out.providers as Record<string, Record<string, unknown>>).zai;
    expect(zai?.credentials).toEqual([
      { credential: "${PROXY_INBOUND_KEY}", label: "primary" },
      { credential: "${DEEPSEEK_API_KEY}", label: "secondary" },
    ]);
    expect(zai?.credential).toBeUndefined();
    // No pool secret leaked literally.
    expect(JSON.stringify(out).includes(ENV.DEEPSEEK_API_KEY)).toBe(false);
  });

  test("a labeled singleton stays an array; an unlabeled one flattens", () => {
    const cfg = validateConfig({
      ...BASE,
      providers: {
        a: {
          type: "anthropic",
          credentials: [{ credential: "lone-key", label: "sponsor" }],
          auth: "bearer",
          baseUrl: "https://a.example.com",
          countTokens: false,
          modelsUrl: "https://a.example.com/models",
        },
        b: {
          type: "anthropic",
          credentials: [{ credential: "lone-key-2" }],
          auth: "bearer",
          baseUrl: "https://b.example.com",
          countTokens: false,
          modelsUrl: "https://b.example.com/models",
        },
      },
    });
    const out = serializeConfig(cfg, {});
    const providers = out.providers as Record<string, Record<string, unknown>>;
    expect(providers.a?.credentials).toEqual([{ credential: "lone-key", label: "sponsor" }]);
    expect(providers.b?.credential).toBe("lone-key-2");
    expect(providers.b?.credentials).toBeUndefined();
  });

  test('an empty pool round-trips as credential:"" (next boot still loads)', () => {
    const cfg = validateConfig({
      ...BASE,
      providers: {
        zai: {
          type: "anthropic",
          credential: "",
          auth: "bearer",
          baseUrl: "https://api.z.ai/api/anthropic",
          countTokens: true,
          modelsUrl: "https://api.z.ai/api/paas/v4/models",
        },
      },
    });
    const out = serializeConfig(cfg, {});
    const zai = (out.providers as Record<string, Record<string, unknown>>).zai;
    expect(zai?.credential).toBe("");
    // And it reloads to the same shape.
    expect(validateConfig(out).providers.external.zai?.credentials).toEqual([]);
  });

  test("region pool round-trips; an inherited region stays credential-less", () => {
    const cfg = validateConfig({
      ...BASE,
      providers: {
        alibaba: {
          type: "anthropic",
          credential: "provider-key",
          auth: "x-api-key",
          countTokens: true,
          regions: {
            "ap-southeast-1": {
              hostTemplate: "dashscope-intl.aliyuncs.com",
              modelsUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models",
              credentials: [{ credential: ENV.DASHSCOPE_API_KEY_EU, label: "token-plan" }],
            },
            "eu-central-1": {
              hostTemplate: "{workspaceId}.eu-central-1.maas.aliyuncs.com",
              workspaceId: ENV.DASHSCOPE_WORKSPACE_ID_EU,
              modelsUrl: `https://${ENV.DASHSCOPE_WORKSPACE_ID_EU}.eu-central-1.maas.aliyuncs.com/compatible-mode/v1/models`,
            },
          },
        },
      },
    });
    const out = serializeConfig(cfg, ENV);
    const regions = (out.providers as Record<string, Record<string, unknown>>).alibaba
      ?.regions as Record<string, Record<string, unknown>>;
    expect(regions["ap-southeast-1"]?.credentials).toEqual([
      { credential: "${DASHSCOPE_API_KEY_EU}", label: "token-plan" },
    ]);
    expect("credentials" in (regions["eu-central-1"] ?? {})).toBe(false);
    expect("credential" in (regions["eu-central-1"] ?? {})).toBe(false);
  });
});

describe("serializeConfig virtualModels + maxFailoverAttempts", () => {
  const BASE = {
    server: { host: "127.0.0.1", port: 8787 },
    inboundAuth: { keys: ["k"] },
    primaryRegion: "us",
    profilePreference: "global",
    refreshIntervalMinutes: 60,
    claudeFallbackToMantle: false,
    regions: [{ key: "us", awsRegion: "us-east-1" }],
    providers: {},
    logging: { enabled: false },
    chatPage: { enabled: false },
    virtualModels: {
      "sonnet-like": ["zai.anthropic.global.glm-5.3", "bedrock.mantle.us.zai.glm-5"],
    },
    maxFailoverAttempts: 3,
  };

  test("round-trips verbatim (order and entries preserved)", () => {
    const cfg = validateConfig(structuredClone(BASE));
    const out = serializeConfig(cfg, {});
    expect(out.virtualModels).toEqual(BASE.virtualModels);
    expect(out.maxFailoverAttempts).toBe(3);
    // Reload equivalence.
    expect(validateConfig(out).virtualModels).toEqual(BASE.virtualModels);
  });

  test("absent block stays absent; default attempts serialize as the default", () => {
    const { virtualModels: _vm, maxFailoverAttempts: _m, ...rest } = BASE;
    const cfg = validateConfig(rest);
    const out = serializeConfig(cfg, {});
    expect("virtualModels" in out).toBe(false);
    expect(out.maxFailoverAttempts).toBe(4);
  });
});
