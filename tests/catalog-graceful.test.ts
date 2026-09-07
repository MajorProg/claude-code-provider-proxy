/**
 * Graceful-degradation discovery tests (hermetic).
 *
 * Discovery must NEVER be fatal: a Bedrock region failing (including the
 * primary — the pre-fix crash-loop), a disabled Bedrock (null client), or an
 * external provider being skipped/erroring all yield a Catalog with per-source
 * SourceStatus entries instead of a thrown error. Bedrock-disabled means ZERO
 * network calls. External /models fetches go through the fetch mock (the only
 * mocked boundary); the discovery code under test is the real implementation.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { type ProxyConfig, validateConfig } from "../src/config.ts";
import {
  Catalog,
  CatalogManager,
  type DiscoveryClient,
  SourceBackoff,
  discoverCatalog,
  discoverExternalCatalog,
} from "../src/model/catalog.ts";
import { type FetchMock, type MockResponseSpec, installFetchMock } from "./helpers/fetch-mock.ts";

let mock: FetchMock | undefined;

/** Install a fetch mock for the duration of one test (restored in afterEach). */
function useMock(specs: MockResponseSpec | MockResponseSpec[]): FetchMock {
  mock = installFetchMock(specs);
  return mock;
}

afterEach(() => {
  mock?.restore();
  mock = undefined;
});

function makeConfig(overrides?: {
  bedrockCredential?: string;
  external?: Record<string, unknown>;
}): ProxyConfig {
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
        credential: overrides?.bedrockCredential ?? "bedrock-api-key-test",
        hosts: {
          converse: "bedrock-runtime.{region}.amazonaws.com",
          mantle: "bedrock-mantle.{region}.api.aws",
          control: "bedrock.{region}.amazonaws.com",
        },
      },
      ...(overrides?.external ?? {}),
    },
    logging: { enabled: false, dir: "./logs", systemDir: "system", sessionDir: "sessions" },
    chatPage: { enabled: false },
  });
}

/** Stub client: returns one foundation model per region, or throws for `failRegion`. */
function makeClient(failRegion?: string): { client: DiscoveryClient; calls: string[] } {
  const calls: string[] = [];
  const client = {
    async listFoundationModels(awsRegion: string): Promise<unknown[]> {
      calls.push(`fm:${awsRegion}`);
      if (awsRegion === failRegion) throw new Error("Discovery GET failed: 403");
      return [
        {
          modelId: `vendor.model-${awsRegion}`,
          inferenceTypesSupported: ["ON_DEMAND"],
          modelLifecycle: { status: "ACTIVE" },
        },
      ];
    },
    async listInferenceProfiles(): Promise<unknown[]> {
      return [];
    },
    async listMantleModels(): Promise<unknown[]> {
      return [];
    },
  };
  return { client: client as unknown as DiscoveryClient, calls };
}

const ZAI = {
  zai: {
    type: "anthropic",
    credential: "zai-key",
    auth: "bearer",
    baseUrl: "https://api.z.ai/api/anthropic",
    countTokens: true,
    modelsUrl: "https://api.z.ai/api/paas/v4/models",
  },
};
const ZAI_EMPTY_KEY = {
  zai: {
    type: "anthropic",
    credential: "",
    auth: "bearer",
    baseUrl: "https://api.z.ai/api/anthropic",
    countTokens: true,
    modelsUrl: "https://api.z.ai/api/paas/v4/models",
  },
};

describe("discoverCatalog graceful degradation", () => {
  test("PRIMARY-region failure is non-fatal and surfaces an error SourceStatus", async () => {
    const { client } = makeClient("us-east-1");
    const config = makeConfig({ external: ZAI });
    const m = useMock([{ status: 200, json: { data: [{ id: "glm-5" }] } }]);
    const catalog = await discoverCatalog(config, client);
    // The non-primary region still contributes its model; zai survived too.
    expect(catalog.models.map((x) => x.nativeModelId)).toEqual(["vendor.model-eu-west-1", "glm-5"]);
    const primary = catalog.sources.find((s) => s.source === "bedrock:us");
    expect(primary?.state).toBe("error");
    expect(primary?.detail).toContain("403");
    const eu = catalog.sources.find((s) => s.source === "bedrock:eu");
    expect(eu?.state).toBe("ok");
    // Only the external /models URL was fetched over HTTP (stub client covers Bedrock).
    expect(m.requests.map((r) => r.url)).toEqual(["https://api.z.ai/api/paas/v4/models"]);
  });

  test("null client (bedrock disabled): zero region discovery, disabled status", async () => {
    const { client, calls } = makeClient();
    const config = makeConfig({ external: ZAI });
    const m = useMock([{ status: 200, json: { data: [{ id: "glm-5" }] } }]);
    const catalog = await discoverCatalog(config, null);
    expect(calls).toEqual([]); // the stub client is never touched
    // No bedrock.* URL was fetched — only the external /models discovery.
    expect(m.requests.map((r) => r.url)).toEqual(["https://api.z.ai/api/paas/v4/models"]);
    expect(catalog.sources).toContainEqual({ source: "bedrock", state: "disabled" });
    expect(catalog.models.map((x) => x.nativeModelId)).toEqual(["glm-5"]);
    expect(client).toBeDefined(); // keep the client reference meaningful
  });

  test("external provider with an empty credential is SKIPPED without a fetch", async () => {
    const config = makeConfig({ external: ZAI_EMPTY_KEY });
    const m = useMock([{ status: 200, json: { data: [{ id: "glm-5" }] } }]);
    const catalog = await discoverCatalog(config, null);
    expect(m.requests).toEqual([]);
    expect(catalog.sources).toEqual([
      { source: "bedrock", state: "disabled" },
      // An empty credential pool now carries the inactiveReason (missing-info
      // wording) instead of the generic "credential unset" skip detail.
      { source: "zai", state: "skipped", detail: expect.stringContaining("credential") },
    ]);
    expect(catalog.models).toEqual([]);
  });

  test("one external provider failing does not affect the others", async () => {
    const config = makeConfig({
      external: {
        eurouter: {
          type: "openai",
          credential: "eurouter-key",
          auth: "bearer",
          baseUrl: "https://api.eurouter.ai/v1",
          countTokens: false,
          modelsUrl: "https://api.eurouter.ai/v1/models",
        },
        ...ZAI,
      },
    });
    // Object.entries order: eurouter first, then zai.
    useMock([
      { status: 503, json: {} },
      { status: 200, json: { data: [{ id: "glm-5" }] } },
    ]);
    const catalog = await discoverCatalog(config, null);
    const states = Object.fromEntries(catalog.sources.map((s) => [s.source, s.state]));
    expect(states.eurouter).toBe("error");
    expect(states.zai).toBe("ok");
    expect(catalog.models.map((x) => x.provider)).toEqual(["zai"]);
  });

  test("CatalogManager.start never throws when every source fails", async () => {
    const { client } = makeClient("us-east-1");
    // Second region also fails: use a client that always throws.
    const failing = {
      async listFoundationModels(): Promise<unknown[]> {
        throw new Error("boom");
      },
      async listInferenceProfiles(): Promise<unknown[]> {
        throw new Error("boom");
      },
      async listMantleModels(): Promise<unknown[]> {
        throw new Error("boom");
      },
    } as unknown as DiscoveryClient;
    const mgr = await CatalogManager.start(makeConfig(), failing);
    expect(mgr.current().models).toEqual([]);
    expect(mgr.current().sources.every((s) => s.state === "error")).toBe(true);
    mgr.stop();
    expect(client).toBeDefined();
  });

  test("an empty Catalog is constructible and queryable", () => {
    const empty = new Catalog([], []);
    expect(empty.models).toEqual([]);
    expect(empty.get("global", "anthropic", "glm-5")).toBeUndefined();
  });

  test("PC9: a source in cooldown is skipped (no fetch) then retried after the window", async () => {
    const config = makeConfig({ external: ZAI });
    const backoff = new SourceBackoff();

    // First cycle: discovery fails -> records a failure + cooldown.
    const m1 = useMock([{ status: 503, json: {} }]);
    const r1 = await discoverExternalCatalog(config, backoff);
    expect(m1.requests).toHaveLength(1); // fetched once
    expect(r1.statuses.find((s) => s.source === "zai")?.state).toBe("error");
    expect(backoff.shouldSkip("zai")).toBe(true);
    m1.restore();

    // Second cycle while still cooling down: NO fetch, status = skipped.
    const m2 = useMock([{ status: 200, json: { data: [{ id: "glm-5" }] } }]);
    const r2 = await discoverExternalCatalog(config, backoff);
    expect(m2.requests).toHaveLength(0); // cooldown -> no network call
    const zaiStatus = r2.statuses.find((s) => s.source === "zai");
    expect(zaiStatus?.state).toBe("skipped");
    expect(zaiStatus?.detail).toContain("cooling down");
  });

  test("a provider with inactiveReason (unset env ref) is skipped with its reason, no fetch", async () => {
    // The fork-port scenario: ${DASHSCOPE_API_KEY_INTL}-style bare refs resolved
    // empty -> validation marks the provider inactive; discovery never dials.
    const config = makeConfig({
      external: {
        alibaba: {
          type: "anthropic",
          credential: "sk-live",
          auth: "x-api-key",
          hostTemplate: "{workspaceId}.{region}.maas.aliyuncs.com",
          workspaceId: "",
          region: "ap-southeast-1",
          basePath: "/apps/anthropic",
          countTokens: true,
          modelsUrl: "https://.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/models",
        },
      },
    });
    expect(config.providers.external.alibaba?.inactiveReason).toBeDefined();
    const m = useMock([{ status: 200, json: { data: [{ id: "qwen3-max" }] } }]);
    const r = await discoverExternalCatalog(config);
    expect(m.requests).toEqual([]);
    const status = r.statuses.find((s) => s.source === "alibaba");
    expect(status?.state).toBe("skipped");
    expect(status?.detail).toContain("workspaceId is empty");
    expect(r.models).toEqual([]);
  });

  test("multi-region: an inactive region is skipped while its sibling still discovers", async () => {
    const config = makeConfig({
      external: {
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
              // EU workspace env unset -> empty workspaceId -> region inactive.
              hostTemplate: "{workspaceId}.eu-central-1.maas.aliyuncs.com",
              workspaceId: "",
              credential: "sk-eu",
              modelsUrl: "https://.eu-central-1.maas.aliyuncs.com/compatible-mode/v1/models",
              billingMode: "payg",
            },
          },
        },
      },
    });
    // Only the healthy region's discovery URL is fetched.
    const m = useMock([{ status: 200, json: { data: [{ id: "qwen3-max" }] } }]);
    const r = await discoverExternalCatalog(config);
    expect(m.requests.map((req) => req.url)).toEqual([
      "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models",
    ]);
    const sg = r.statuses.find((s) => s.source === "alibaba:ap-southeast-1");
    const eu = r.statuses.find((s) => s.source === "alibaba:eu-central-1");
    expect(sg?.state).toBe("ok");
    expect(eu?.state).toBe("skipped");
    expect(eu?.detail).toContain("workspaceId is empty");
    // The Singapore model is discoverable under the region-code prefix.
    expect(r.models.map((x) => `${x.provider}:${x.regionKey}:${x.nativeModelId}`)).toEqual([
      "alibaba:ap-southeast-1:qwen3-max",
    ]);
  });
});

describe("discovery credential pools", () => {
  function poolConfig(credentials: unknown): ProxyConfig {
    return makeConfig({
      external: {
        zai: {
          type: "anthropic",
          credentials,
          auth: "bearer",
          baseUrl: "https://api.z.ai/api/anthropic",
          countTokens: true,
          modelsUrl: "https://api.z.ai/api/paas/v4/models",
        },
      },
    });
  }

  test("primary key 401 -> discovery advances to the secondary key (ok, models found)", async () => {
    const config = poolConfig([
      { credential: "rejected-key", label: "primary" },
      { credential: "working-key", label: "secondary" },
    ]);
    const m = useMock([
      { status: 401, json: {} },
      { status: 200, json: { data: [{ id: "glm-5" }] } },
    ]);
    const r = await discoverExternalCatalog(config);
    expect(m.requests).toHaveLength(2);
    // Each attempt presented its own key (bearer by /models convention).
    expect(m.requests[0]?.headers.authorization).toBe("Bearer rejected-key");
    expect(m.requests[1]?.headers.authorization).toBe("Bearer working-key");
    expect(r.statuses.find((s) => s.source === "zai")?.state).toBe("ok");
    expect(r.models.map((x) => x.nativeModelId)).toEqual(["glm-5"]);
  });

  test("403 also advances the pool; exhaustion yields an error status naming the count", async () => {
    const config = poolConfig([
      { credential: "k1", label: "a" },
      { credential: "k2", label: "b" },
    ]);
    const m = useMock([
      { status: 403, json: {} },
      { status: 403, json: {} },
    ]);
    const r = await discoverExternalCatalog(config);
    expect(m.requests).toHaveLength(2);
    const status = r.statuses.find((s) => s.source === "zai");
    expect(status?.state).toBe("error");
    expect(status?.detail).toContain("HTTP 403");
    expect(status?.detail).toContain("2 pool key(s)");
  });

  test("a non-auth non-ok status does NOT advance keys (key-independent failure)", async () => {
    const config = poolConfig([
      { credential: "k1", label: "a" },
      { credential: "k2", label: "b" },
    ]);
    const m = useMock([{ status: 503, json: {} }]);
    const r = await discoverExternalCatalog(config);
    expect(m.requests).toHaveLength(1);
    expect(r.statuses.find((s) => s.source === "zai")?.detail).toBe("discovery returned HTTP 503");
  });

  test("placeholder-only pool is skipped without a fetch", async () => {
    const config = poolConfig([{ credential: "REPLACE_ME" }]);
    const m = useMock([{ status: 200, json: { data: [{ id: "glm-5" }] } }]);
    const r = await discoverExternalCatalog(config);
    expect(m.requests).toEqual([]);
    expect(r.statuses.find((s) => s.source === "zai")?.state).toBe("skipped");
  });

  test("region discovery walks the region-owned pool", async () => {
    const config = makeConfig({
      external: {
        alibaba: {
          type: "anthropic",
          credential: "provider-key",
          auth: "x-api-key",
          countTokens: true,
          regions: {
            "ap-southeast-1": {
              hostTemplate: "dashscope-intl.aliyuncs.com",
              basePath: "/apps/anthropic",
              modelsUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models",
              credentials: [
                { credential: "region-rejected", label: "token-plan" },
                { credential: "region-working" },
              ],
            },
          },
        },
      },
    });
    const m = useMock([
      { status: 401, json: {} },
      { status: 200, json: { data: [{ id: "qwen3-max" }] } },
    ]);
    const r = await discoverExternalCatalog(config);
    expect(m.requests.map((req) => req.headers.authorization)).toEqual([
      "Bearer region-rejected",
      "Bearer region-working",
    ]);
    expect(r.statuses.find((s) => s.source === "alibaba:ap-southeast-1")?.state).toBe("ok");
    expect(r.models.map((x) => x.nativeModelId)).toEqual(["qwen3-max"]);
  });
});
