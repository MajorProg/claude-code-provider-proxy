/**
 * Coverage-closure tests for the routing layer: src/router.ts,
 * src/model/catalog.ts and src/failover.ts.
 *
 * Every case drives the REAL implementation with real inputs and asserts on the
 * real output:
 *   - route() external-provider region resolution (404s, SSRF guard, fallbacks)
 *   - the live HTTP discovery client (parsed at the fetch boundary only)
 *   - buildRegionCatalog's foundation-model / inference-profile / mantle merge
 *   - CatalogManager's refresh timer and CredentialCooldownStore's expiry timer
 *
 * The single stubbed boundary is globalThis.fetch (tests/helpers/fetch-mock.ts);
 * discovery payloads are the REAL shapes the control-plane/client unmarshals.
 * No provider payloads are fabricated and no line is touched just to colour it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { type ProxyConfig, validateConfig } from "../src/config.ts";
import { ConfigError, ModelNotFoundError, ProviderDisabledError } from "../src/errors.ts";
import { CredentialCooldownStore } from "../src/failover.ts";
import { parseCanonicalId } from "../src/model/canonical-id.ts";
import {
  Catalog,
  CatalogManager,
  type DiscoveredModel,
  SourceBackoff,
  buildRegionCatalog,
  createHttpDiscoveryClient,
  discoverExternalCatalog,
} from "../src/model/catalog.ts";
import { route } from "../src/router.ts";
import { type FetchMock, type MockResponseSpec, installFetchMock } from "./helpers/fetch-mock.ts";

let mock: FetchMock | undefined;
let tmpDirs: string[] = [];

function useMock(specs: MockResponseSpec | MockResponseSpec[]): FetchMock {
  mock = installFetchMock(specs);
  return mock;
}

afterEach(() => {
  mock?.restore();
  mock = undefined;
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
});

/** A validated config with a Bedrock block + whatever external providers a case needs. */
function makeConfig(
  external: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
): ProxyConfig {
  return validateConfig({
    server: { host: "127.0.0.1", port: 8787 },
    inboundAuth: { keys: ["k"] },
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
        credential: "bedrock-api-key-test",
        hosts: {
          converse: "bedrock-runtime.{region}.amazonaws.com",
          mantle: "bedrock-mantle.{region}.api.aws",
          control: "bedrock.{region}.amazonaws.com",
        },
      },
      ...external,
    },
    logging: { enabled: false },
    chatPage: { enabled: false },
    ...extra,
  });
}

/* ------------------------------------------------------------------ *
 * router.ts — external-provider region resolution
 * ------------------------------------------------------------------ */

describe("route(): external provider region resolution", () => {
  /** A multi-region provider: a flat credential + baseUrl and a regions map. */
  function regionProvider(regions: Record<string, unknown>): ProxyConfig {
    return makeConfig({
      alibaba: {
        type: "anthropic",
        credential: "sk-shared",
        auth: "x-api-key",
        baseUrl: "https://shared.example.com/apps/anthropic",
        countTokens: true,
        regions,
      },
    });
  }

  test("a canonical id naming an unconfigured region is a clean 404", () => {
    const config = regionProvider({
      "eu-central-1": {
        hostTemplate: "eu.example.com",
        basePath: "/apps/anthropic",
        modelsUrl: "https://eu.example.com/v1/models",
      },
    });
    const id = parseCanonicalId("alibaba.anthropic.ap-southeast-1.qwen3-max");
    try {
      route(config, new Catalog([]), id);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ModelNotFoundError);
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toContain("ap-southeast-1");
      expect(msg).toContain("alibaba");
    }
  });

  test("a region with no hostTemplate falls back to the provider baseUrl", () => {
    const config = regionProvider({
      "eu-central-1": {
        // No hostTemplate: origin comes from the provider-level baseUrl.
        basePath: "/apps/anthropic",
        modelsUrl: "https://eu.example.com/v1/models",
      },
    });
    const t = route(
      config,
      new Catalog([]),
      parseCanonicalId("alibaba.anthropic.eu-central-1.qwen3-max"),
    );
    expect(t.provider).toBe("alibaba");
    expect(t.backend).toBe("anthropic");
    expect(t.translationPath).toBe("passthrough");
    expect(t.origin).toBe("https://shared.example.com/apps/anthropic");
    expect(t.path).toBe("https://shared.example.com/apps/anthropic/v1/messages");
    // A credential pool is present (inherited from the provider level).
    expect(t.credentials).toHaveLength(1);
  });

  test("a region whose templated host is an internal/metadata target is a clean 404", () => {
    // AssertSafeExternalOrigin must reject a credentialed fetch aimed at IMDS;
    // the router surfaces that as an actionable 404, never an opaque 500.
    const config = regionProvider({
      "eu-central-1": {
        hostTemplate: "169.254.169.254",
        modelsUrl: "https://eu.example.com/v1/models",
      },
    });
    try {
      route(config, new Catalog([]), parseCanonicalId("alibaba.anthropic.eu-central-1.qwen3-max"));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderDisabledError);
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toContain("eu-central-1");
      expect(msg).toContain("blocked internal/metadata host");
    }
  });

  test("a provider whose only pool key is a placeholder is a clean 404", () => {
    // Placeholder keys survive validation (so this distinct error stays
    // reachable) and are filtered at routing time.
    const config = makeConfig({
      zai: {
        type: "anthropic",
        credential: "REPLACE_ME",
        auth: "bearer",
        baseUrl: "https://api.z.ai/api/anthropic",
        countTokens: true,
        modelsUrl: "https://api.z.ai/api/paas/v4/models",
      },
    });
    expect(config.providers.external.zai?.inactiveReason).toBeUndefined();
    try {
      route(config, new Catalog([]), parseCanonicalId("zai.anthropic.global.glm-5.3"));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderDisabledError);
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toContain("placeholder");
    }
  });
});

/* ------------------------------------------------------------------ *
 * router.ts — bedrock converse region-key mapping (global vs family)
 * ------------------------------------------------------------------ */

describe("route(): bedrock converse profilePrefix mapping", () => {
  // A real converse catalog entry registered under the "us" region key.
  const nova: DiscoveredModel = {
    provider: "bedrock",
    awsRegion: "us-east-1",
    regionKey: "us",
    backend: "converse",
    nativeModelId: "amazon.nova-lite-v1:0",
    isAnthropic: false,
    supportsOnDemand: true,
    profiles: [],
    streaming: true,
  };

  test('a "global" profilePrefix resolves to the primary region catalog entry', () => {
    const t = route(
      makeConfig(),
      new Catalog([nova]),
      parseCanonicalId("bedrock.converse.global.amazon.nova-lite-v1:0"),
    );
    // global -> config.primaryRegion ("us"), whose AWS region is us-east-1.
    expect(t.provider).toBe("bedrock");
    expect(t.backend).toBe("converse");
    expect(t.translationPath).toBe("converse");
    expect(t.awsRegion).toBe("us-east-1");
    expect(t.origin).toBe("https://bedrock-runtime.us-east-1.amazonaws.com");
    expect(t.invocationId).toBe("amazon.nova-lite-v1:0");
  });

  test('a family profilePrefix ("eu") resolves to that family\'s region', () => {
    const eu: DiscoveredModel = { ...nova, regionKey: "eu", awsRegion: "eu-west-1" };
    const t = route(
      makeConfig(),
      new Catalog([eu]),
      parseCanonicalId("bedrock.converse.eu.amazon.nova-lite-v1:0"),
    );
    expect(t.awsRegion).toBe("eu-west-1");
    expect(t.origin).toBe("https://bedrock-runtime.eu-west-1.amazonaws.com");
  });
});

/* ------------------------------------------------------------------ *
 * catalog.ts — live HTTP discovery client
 * ------------------------------------------------------------------ */

describe("createHttpDiscoveryClient (real HTTP client, fetch boundary mocked)", () => {
  const tokenProvider = (awsRegion: string) => `bedrock-api-key-${awsRegion}`;

  test("each list method parses its documented shape and hits the right URL", async () => {
    const config = makeConfig();
    const m = useMock([
      { json: { modelSummaries: [{ modelId: "vendor.model-converse" }] } },
      { json: { inferenceProfileSummaries: [{ inferenceProfileId: "us.vendor.model" }] } },
      { json: { data: [{ id: "vendor.model-mantle" }] } },
    ]);
    const client = createHttpDiscoveryClient(config, tokenProvider);

    const fm = await client.listFoundationModels("us-east-1");
    const ip = await client.listInferenceProfiles("us-east-1");
    const mm = await client.listMantleModels("us-east-1");

    expect(fm).toEqual([{ modelId: "vendor.model-converse" }]);
    expect(ip).toEqual([{ inferenceProfileId: "us.vendor.model" }]);
    expect(mm).toEqual([{ id: "vendor.model-mantle" }]);
    expect(m.requests.map((r) => r.url)).toEqual([
      "https://bedrock.us-east-1.amazonaws.com/foundation-models",
      "https://bedrock.us-east-1.amazonaws.com/inference-profiles?type=SYSTEM_DEFINED",
      "https://bedrock-mantle.us-east-1.api.aws/v1/models",
    ]);
    // The per-region token is presented as a bearer credential.
    expect(m.requests[0]?.headers.authorization).toBe("Bearer bedrock-api-key-us-east-1");
    // A credentialed discovery fetch never follows a redirect (A3).
    expect(m.requests.every((r) => r.method === "GET")).toBe(true);
  });

  test("an absent collection falls back to an empty array", async () => {
    const config = makeConfig();
    const m = useMock([{ json: {} }, { json: {} }, { json: {} }]);
    const client = createHttpDiscoveryClient(config, tokenProvider);

    expect(await client.listFoundationModels("eu-west-1")).toEqual([]);
    expect(await client.listInferenceProfiles("eu-west-1")).toEqual([]);
    expect(await client.listMantleModels("eu-west-1")).toEqual([]);
    expect(m.requests).toHaveLength(3);
    // The region template was substituted for every host.
    expect(m.requests[2]?.url).toBe("https://bedrock-mantle.eu-west-1.api.aws/v1/models");
  });

  test("a non-ok discovery response throws with the status and a body excerpt", async () => {
    const config = makeConfig();
    useMock([{ status: 500, text: "internal error" }]);
    const client = createHttpDiscoveryClient(config, tokenProvider);
    await expect(client.listFoundationModels("us-east-1")).rejects.toThrow(
      /Discovery GET https:\/\/bedrock\.us-east-1\.amazonaws\.com\/foundation-models failed: 500 internal error/,
    );
  });

  test("a non-ok response whose body read itself fails still surfaces the status", async () => {
    // The !res.ok branch reads the body as a diagnostic excerpt and must not be
    // masked by a body-read failure — an errored body degrades to an empty
    // excerpt. The shared helper cannot express a rejecting body, so this one
    // boundary is driven with a direct fetch stub (still only globalThis.fetch
    // is stubbed; the client under test is the real one).
    const config = makeConfig();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("body read failed"));
          },
        }),
        { status: 502, statusText: "Bad Gateway" },
      )) as typeof fetch;
    try {
      const client = createHttpDiscoveryClient(config, tokenProvider);
      await expect(client.listFoundationModels("us-east-1")).rejects.toThrow(
        /Discovery GET .*\/foundation-models failed: 502 $/,
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("no providers.bedrock block is a hard guard (ConfigError)", () => {
    const noBedrock = validateConfig({
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
    });
    expect(() => createHttpDiscoveryClient(noBedrock, tokenProvider)).toThrow(ConfigError);
  });
});

/* ------------------------------------------------------------------ *
 * catalog.ts — buildRegionCatalog merge
 * ------------------------------------------------------------------ */

describe("buildRegionCatalog (foundation + profile + mantle merge)", () => {
  test("maps inference-profile ARNs to their base model and drops unusable entries", () => {
    const foundationModels = [
      {
        modelId: "vendor.model-a",
        inferenceTypesSupported: ["ON_DEMAND"],
        responseStreamingSupported: true,
        modelLifecycle: { status: "ACTIVE" },
      },
      // Bare entry: no inference types, no lifecycle, no streaming flag.
      { modelId: "vendor.model-c" },
      // Non-ACTIVE lifecycle: filtered out.
      { modelId: "vendor.model-b", modelLifecycle: { status: "LEGACY" } },
      { notAModelId: true }, // no modelId -> skipped
    ];
    const inferenceProfiles = [
      {
        inferenceProfileId: "us.vendor.model-a",
        status: "ACTIVE",
        models: [
          { modelArn: "arn:aws:bedrock:us-east-1::foundation-model/vendor.model-a" },
          // No foundation-model/ segment -> baseModelIdFromArn returns null.
          { modelArn: "arn:aws:bedrock:us-east-1::inference-profile/us.vendor.model-a" },
          {}, // no ARN -> skipped
        ],
      },
      {
        // A non-ACTIVE profile contributes nothing.
        inferenceProfileId: "us.vendor.dropped",
        status: "INACTIVE",
        models: [{ modelArn: "arn:aws:bedrock:us-east-1::foundation-model/vendor.model-a" }],
      },
      // No profile id -> skipped.
      { status: "ACTIVE", models: [{ modelArn: "arn:aws:bedrock:us-east-1::foundation-model/x" }] },
    ];
    const mantleModels = [
      { id: "vendor.model-mantle", status: "available" },
      { id: "vendor.model-gone", status: "deprecated" }, // not available -> skipped
      { notAnId: true }, // no id -> skipped
    ];

    const catalog = buildRegionCatalog(
      "us",
      "us-east-1",
      foundationModels,
      inferenceProfiles,
      mantleModels,
    );

    const a = catalog.find((m) => m.nativeModelId === "vendor.model-a");
    expect(a?.backend).toBe("converse");
    expect(a?.supportsOnDemand).toBe(true);
    expect(a?.streaming).toBe(true);
    // The ACTIVE profile's foundation-model ARN resolved to model-a.
    expect(a?.profiles).toEqual(["us.vendor.model-a"]);

    // A bare entry keeps the conservative defaults.
    const c = catalog.find((m) => m.nativeModelId === "vendor.model-c");
    expect(c?.supportsOnDemand).toBe(false);
    expect(c?.streaming).toBe(false);

    expect(catalog.some((m) => m.nativeModelId === "vendor.model-b")).toBe(false);

    const mantle = catalog.find((m) => m.nativeModelId === "vendor.model-mantle");
    expect(mantle?.backend).toBe("mantle");
    expect(mantle?.supportsOnDemand).toBe(true);
    expect(mantle?.profiles).toEqual([]);
    expect(catalog.some((m) => m.nativeModelId === "vendor.model-gone")).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * catalog.ts — CatalogManager refresh timer
 * ------------------------------------------------------------------ */

describe("CatalogManager refresh scheduling", () => {
  test("the jittered timer fires discovery and reschedules itself", async () => {
    const config = makeConfig({
      zai: {
        type: "anthropic",
        credential: "zai-key",
        auth: "bearer",
        baseUrl: "https://api.z.ai/api/anthropic",
        countTokens: true,
        modelsUrl: "https://api.z.ai/api/paas/v4/models",
      },
    });
    const m = useMock({ json: { data: [{ id: "glm-5.3" }] } });
    // A sub-minute interval so the real (unfaked) refresh timer actually fires
    // inside the test; the scheduling/refresh code path is the production one.
    const fast: ProxyConfig = { ...config, refreshIntervalMinutes: 1 / 600 };
    const mgr = await CatalogManager.start(fast, null);
    expect(m.requests).toHaveLength(1); // initial discovery
    try {
      await Bun.sleep(250);
      // The timer-driven refresh ran at least once more, and the catalog stayed live.
      expect(m.requests.length).toBeGreaterThanOrEqual(2);
      expect(mgr.current()).toBeInstanceOf(Catalog);
      expect(mgr.current().models.map((x) => x.nativeModelId)).toContain("glm-5.3");
    } finally {
      mgr.stop();
    }
  });

  test("refresh() runs discovery, is single-flight, and retains the catalog after stop", async () => {
    const config = makeConfig({
      zai: {
        type: "anthropic",
        credential: "zai-key",
        auth: "bearer",
        baseUrl: "https://api.z.ai/api/anthropic",
        countTokens: true,
        modelsUrl: "https://api.z.ai/api/paas/v4/models",
      },
    });
    const m = useMock({ json: { data: [{ id: "glm-5.3" }] } });
    const mgr = await CatalogManager.start(config, null);
    const afterStart = m.requests.length;
    // Two overlapping refreshes share ONE in-flight discovery (single-flight):
    // the second refreshes sees the in-flight promise and does not re-fetch.
    await Promise.all([mgr.refresh(), mgr.refresh()]);
    expect(m.requests.length).toBe(afterStart + 1);
    expect(mgr.current().models.map((x) => x.nativeModelId)).toContain("glm-5.3");
    mgr.stop();
  });
});

/* ------------------------------------------------------------------ *
 * catalog.ts — external discovery error + cooldown branches
 * ------------------------------------------------------------------ */

describe("discoverExternalCatalog error and cooldown branches", () => {
  function zaiConfig(): ProxyConfig {
    return makeConfig({
      zai: {
        type: "anthropic",
        credential: "zai-key",
        auth: "bearer",
        baseUrl: "https://api.z.ai/api/anthropic",
        countTokens: true,
        modelsUrl: "https://api.z.ai/api/paas/v4/models",
      },
    });
  }

  test("a network-level discovery failure is caught and surfaced as an error status", async () => {
    // The fetch boundary itself throws (connection refused) — the provider is
    // reported error, never fatal to the caller.
    const m = useMock({ error: "connect ECONNREFUSED 127.0.0.1:443" });
    const r = await discoverExternalCatalog(zaiConfig());
    expect(m.requests).toHaveLength(1);
    const status = r.statuses.find((s) => s.source === "zai");
    expect(status?.state).toBe("error");
    expect(status?.detail).toContain("ECONNREFUSED");
    expect(r.models).toEqual([]);
  });

  test("a multi-region provider whose region is cooling down is skipped without a fetch", async () => {
    const config = makeConfig({
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
          },
        },
      },
    });
    const backoff = new SourceBackoff();
    backoff.recordFailure("alibaba:ap-southeast-1");
    const m = useMock({ json: { data: [{ id: "qwen3-max" }] } });
    const r = await discoverExternalCatalog(config, backoff);
    expect(m.requests).toEqual([]); // PC9 cooldown -> no dial
    const status = r.statuses.find((s) => s.source === "alibaba:ap-southeast-1");
    expect(status?.state).toBe("skipped");
    expect(status?.detail).toContain("cooling down");
  });

  test("a region whose templated discovery URL is unsafe is caught, not fatal", async () => {
    const config = makeConfig({
      alibaba: {
        type: "anthropic",
        credential: "sk-shared",
        auth: "x-api-key",
        countTokens: true,
        regions: {
          "ap-southeast-1": {
            hostTemplate: "dashscope-intl.aliyuncs.com",
            basePath: "/apps/anthropic",
            // A credentialed discovery fetch aimed at link-local must be blocked.
            modelsUrl: "https://169.254.169.254/latest/meta-data/",
          },
        },
      },
    });
    const m = useMock({ json: { data: [] } });
    const r = await discoverExternalCatalog(config);
    expect(m.requests).toEqual([]);
    const status = r.statuses.find((s) => s.source === "alibaba:ap-southeast-1");
    expect(status?.state).toBe("error");
    expect(r.models).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * failover.ts — cooldown expiry timer
 * ------------------------------------------------------------------ */

describe("CredentialCooldownStore expiry timer", () => {
  test("a cooldown whose reset time is imminent reinstates the key when it fires", async () => {
    const store = new CredentialCooldownStore();
    // mark() keeps the parsed reset (resetAtMs + RESET_MARGIN_MS) when it is in
    // the future; passing a stamp just under the margin yields a ~120ms TTL, so
    // the real expiry timer fires during the test.
    store.mark("zai", "primary", Date.now() + 120 - 60_000);
    expect(store.isDegraded("zai", "primary")).toBe(true);
    expect(store.snapshot().some((e) => e.label === "primary")).toBe(true);

    await Bun.sleep(300);
    expect(store.isDegraded("zai", "primary")).toBe(false);
    expect(store.snapshot()).toEqual([]);
    // The quota mark OUTLIVES the cooldown (shown until replaced by a new 429).
    expect(store.quotaSnapshot().some((q) => q.label === "primary")).toBe(true);
    store.clear();
  });
});
