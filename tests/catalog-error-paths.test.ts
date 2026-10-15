/**
 * Catalog discovery error-path tests (hermetic).
 *
 * `createHttpDiscoveryClient`'s `getJson` reads the response body of a NON-ok
 * discovery response with `await res.text().catch(() => "")`: reading the error
 * body is best-effort, so a body read that REJECTS (a truncated/reset stream)
 * must be swallowed and the code must fall through to the typed
 * `Discovery GET ... failed: <status>` error — not surface the raw read
 * failure. That defensive catch is the single function this file covers.
 *
 * The real guarantee under test (documented in `discoverCatalog`'s doc comment)
 * is that a discovery failure is NEVER fatal: a failing source degrades to an
 * `error` `SourceStatus` while sibling sources and the boot are unaffected.
 * These tests drive the REAL client + REAL `discoverCatalog` through the real
 * rejection path and assert on the real observable outcome — the error detail
 * proves the swallow happened (it carries the discovery error, not the read
 * failure), and a healthy sibling region still discovers models.
 */
import { describe, expect, test } from "bun:test";
import { validateConfig } from "../src/config.ts";
import { Catalog, createHttpDiscoveryClient, discoverCatalog } from "../src/model/catalog.ts";
import { installFetchMock } from "./helpers/fetch-mock.ts";

/** Bedrock-enabled config over the given regions (mirrors tests/catalog.test.ts). */
function configWith(regions: { key: string; awsRegion: string }[]) {
  return validateConfig({
    server: { host: "127.0.0.1", port: 8787 },
    inboundAuth: { keys: ["test"] },
    primaryRegion: "us",
    profilePreference: "global",
    refreshIntervalMinutes: 60,
    claudeFallbackToMantle: false,
    regions,
    providers: {
      bedrock: {
        credential: "unused-here",
        hosts: {
          converse: "bedrock-runtime.{region}.amazonaws.com",
          mantle: "bedrock-mantle.{region}.api.aws",
          control: "bedrock.{region}.amazonaws.com",
        },
      },
    },
  });
}

/**
 * Install a fetch stub whose NON-ok response rejects when its body is read.
 * `ok: false` drives `getJson` into the error branch; `text()` returning a
 * REJECTED promise is what exercises the `.catch(() => "")`. Returned as a
 * Response-shaped object so no real body machinery is involved.
 */
function installBodyRejectingFetch() {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    // Keep the url referenced so a stray non-discovery fetch is visible rather
    // than silently swallowed.
    void url;
    return {
      ok: false,
      status: 403,
      async text(): Promise<string> {
        throw new Error("simulated discovery body read failure");
      },
    } as unknown as Response;
  }) as typeof fetch;
  return {
    restore(): void {
      globalThis.fetch = original;
    },
  };
}

/** A well-formed discovery body carrying all three sources' payloads. */
const HEALTHY_DISCOVERY_BODY = {
  modelSummaries: [
    {
      modelId: "anthropic.claude-sonnet-4-5-v1:0",
      inferenceTypesSupported: ["ON_DEMAND"],
      responseStreamingSupported: true,
    },
  ],
  inferenceProfileSummaries: [
    {
      inferenceProfileId: "global.anthropic.claude-sonnet-4-5-v1:0",
      status: "ACTIVE",
      models: [
        {
          modelArn: "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-5-v1:0",
        },
      ],
    },
  ],
  data: [{ id: "amazon.titan-text-lite-v1", status: "available" }],
};

describe("catalog discovery error paths (hermetic)", () => {
  test("a non-ok response whose text() rejects is swallowed: the region degrades, never throws", async () => {
    const config = configWith([{ key: "us", awsRegion: "us-east-1" }]);
    const client = createHttpDiscoveryClient(config, () => "test-token");
    const stub = installBodyRejectingFetch();
    try {
      // The documented guarantee: discovery failure is NEVER fatal.
      const catalog = await discoverCatalog(config, client);
      expect(catalog).toBeInstanceOf(Catalog);

      // The region degrades to an error source (no boot crash, no models).
      const status = catalog.sources.find((s) => s.source === "bedrock:us");
      expect(status?.state).toBe("error");

      // The detail proves the `.catch(() => "")` ran: it is the DISCOVERY error
      // (with the empty-body slot), NOT the raw body-read rejection. Had the
      // catch been absent, the rejected `text()` error would have escaped as
      // the region's detail here.
      expect(status?.detail).toContain("foundation-models");
      expect(status?.detail).toContain("failed: 403");
      expect(status?.detail).not.toContain("simulated discovery body read failure");
      // Empty body fallback: the template leaves exactly one trailing space.
      expect(status?.detail?.endsWith("403 ")).toBe(true);

      expect(catalog.models).toHaveLength(0);
    } finally {
      stub.restore();
    }
  });

  test("a failing (even primary) region does not take down a healthy sibling region", async () => {
    const config = configWith([
      { key: "us", awsRegion: "us-east-1" }, // primary — forced to fail
      { key: "eu", awsRegion: "eu-west-1" }, // healthy sibling
    ]);
    const client = createHttpDiscoveryClient(config, () => "test-token");

    const original = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("us-east-1")) {
        // Failing region: non-ok AND a rejecting body read.
        return {
          ok: false,
          status: 403,
          async text(): Promise<string> {
            throw new Error("simulated discovery body read failure");
          },
        } as unknown as Response;
      }
      // Healthy region: a real, parseable discovery response.
      return new Response(JSON.stringify(HEALTHY_DISCOVERY_BODY), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const catalog = await discoverCatalog(config, client);

      // Both sources reported, independently: us errored, eu discovered ok.
      expect(catalog.sources).toContainEqual({ source: "bedrock:eu", state: "ok" });
      const usStatus = catalog.sources.find((s) => s.source === "bedrock:us");
      expect(usStatus?.state).toBe("error");
      expect(usStatus?.detail).toContain("failed: 403");
      expect(usStatus?.detail).not.toContain("simulated discovery body read failure");

      // The healthy region's models are all present and belong to eu only.
      expect(catalog.models.length).toBeGreaterThan(0);
      expect(catalog.models.every((m) => m.regionKey === "eu")).toBe(true);
      expect(catalog.get("eu", "converse", "anthropic.claude-sonnet-4-5-v1:0")).toBeDefined();
      expect(catalog.get("eu", "mantle", "amazon.titan-text-lite-v1")).toBeDefined();
    } finally {
      globalThis.fetch = original;
    }
  });

  test("the happy path parses models end-to-end and hits the real discovery endpoints", async () => {
    const config = configWith([{ key: "us", awsRegion: "us-east-1" }]);
    const client = createHttpDiscoveryClient(config, () => "test-token");

    // A single spec is replayed for every call (the mock repeats the last one),
    // and the body carries all three sources' keys so the assertion does not
    // depend on the concurrent call ORDER.
    const mock = installFetchMock({ json: HEALTHY_DISCOVERY_BODY });
    try {
      const catalog = await discoverCatalog(config, client);

      const converse = catalog.get("us", "converse", "anthropic.claude-sonnet-4-5-v1:0");
      expect(converse).toBeDefined();
      expect(converse?.isAnthropic).toBe(true);
      expect(converse?.supportsOnDemand).toBe(true);
      expect(converse?.profiles).toContain("global.anthropic.claude-sonnet-4-5-v1:0");

      const mantle = catalog.get("us", "mantle", "amazon.titan-text-lite-v1");
      expect(mantle).toBeDefined();
      expect(mantle?.isAnthropic).toBe(false);

      expect(catalog.sources).toContainEqual({ source: "bedrock:us", state: "ok" });

      // Real discovery endpoints were hit with the bearer token attached.
      const urls = mock.requests.map((r) => r.url);
      expect(urls.some((u) => u.endsWith("/foundation-models"))).toBe(true);
      expect(urls.some((u) => u.includes("/inference-profiles?type=SYSTEM_DEFINED"))).toBe(true);
      expect(urls.some((u) => u.endsWith("/v1/models"))).toBe(true);
      expect(
        mock.requests.every((r) => (r.headers.authorization ?? "").startsWith("Bearer ")),
      ).toBe(true);
    } finally {
      mock.restore();
    }
  });
});
