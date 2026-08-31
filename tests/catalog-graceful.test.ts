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
  discoverCatalog,
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
      { source: "zai", state: "skipped", detail: expect.stringContaining("credential unset") },
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
});
