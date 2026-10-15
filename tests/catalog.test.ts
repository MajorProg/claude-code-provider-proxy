/**
 * Catalog tests.
 *
 * The live suite (`describeLive`) performs real discovery against live AWS
 * Bedrock (control-plane + Mantle) using credentials from the environment, and
 * a short-lived Bedrock bearer token generated the same way production does.
 * Required env: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, (AWS_SESSION_TOKEN);
 * absent those it is skipped.
 *
 * The hermetic block at the bottom unit-tests `resolveInvocationId` directly
 * (no network, no fixtures) — it pins the profile-ORDERING and refusal branches
 * that the live suite only reaches opportunistically.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { generateShortLivedBedrockToken } from "../src/auth/bedrock-token.ts";
import { validateConfig } from "../src/config.ts";
import { ModelNotFoundError } from "../src/errors.ts";
import {
  Catalog,
  type DiscoveredModel,
  type DiscoveryClient,
  buildRegionCatalog,
  createHttpDiscoveryClient,
  discoverCatalog,
  discoverExternalCatalog,
  resolveInvocationId,
} from "../src/model/catalog.ts";
import { awsCreds, describeLive } from "./helpers/live.ts";

const CONFIG = validateConfig({
  server: { host: "127.0.0.1", port: 8787 },
  inboundAuth: { keys: ["test"] },
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
      credential: "unused-here",
      hosts: {
        converse: "bedrock-runtime.{region}.amazonaws.com",
        mantle: "bedrock-mantle.{region}.api.aws",
        control: "bedrock.{region}.amazonaws.com",
      },
    },
  },
});

let client: DiscoveryClient;

describeLive("live discovery (real Bedrock endpoints)", () => {
  beforeAll(() => {
    const { accessKeyId, secretAccessKey, sessionToken } = awsCreds();
    // Per-region token provider: short-lived Bedrock keys are region-scoped, so
    // mint one per region (production long-term keys would return a single key).
    client = createHttpDiscoveryClient(CONFIG, (awsRegion) =>
      generateShortLivedBedrockToken({
        credentials: { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) },
        region: awsRegion,
        expiresInSeconds: 900,
      }),
    );
  });

  test("us-east-1 returns real foundation models, profiles, and mantle models", async () => {
    const [fm, ip, mm] = await Promise.all([
      client.listFoundationModels("us-east-1"),
      client.listInferenceProfiles("us-east-1"),
      client.listMantleModels("us-east-1"),
    ]);
    expect(fm.length).toBeGreaterThan(0);
    expect(ip.length).toBeGreaterThan(0);
    expect(mm.length).toBeGreaterThan(0);

    const catalog = buildRegionCatalog("us", "us-east-1", fm, ip, mm);
    expect(catalog.length).toBeGreaterThan(0);

    // There must be both converse and mantle entries.
    expect(catalog.some((m) => m.backend === "converse")).toBe(true);
    expect(catalog.some((m) => m.backend === "mantle")).toBe(true);

    // At least one Anthropic converse model exists and resolves to a profile.
    const claudeConverse = catalog.find((m) => m.backend === "converse" && m.isAnthropic);
    expect(claudeConverse).toBeDefined();
    if (claudeConverse) {
      const invocationId = resolveInvocationId(claudeConverse, "global");
      // Anthropic models are inference-profile only -> must resolve to a profile prefix.
      expect(invocationId.startsWith("global.") || invocationId.startsWith("us.")).toBe(true);
    }
  });

  test("discoverCatalog builds a cross-region catalog (us + eu) with per-source statuses", async () => {
    const catalog = await discoverCatalog(CONFIG, client);
    expect(catalog).toBeInstanceOf(Catalog);
    expect(catalog.models.length).toBeGreaterThan(0);

    // Both region families represented now that tokens are per-region.
    const regions = new Set(catalog.models.map((m) => m.regionKey));
    expect(regions.has("us")).toBe(true);
    expect(regions.has("eu")).toBe(true);

    // Discovery is non-fatal by contract: every source reports a status, and
    // both live regions must have discovered ok.
    expect(catalog.sources).toContainEqual({ source: "bedrock:us", state: "ok" });
    expect(catalog.sources).toContainEqual({ source: "bedrock:eu", state: "ok" });

    // Look up a known-present model by exact native id via the catalog index.
    const anyMantleUs = catalog.models.find((m) => m.regionKey === "us" && m.backend === "mantle");
    expect(anyMantleUs).toBeDefined();
    if (anyMantleUs) {
      const found = catalog.get("us", "mantle", anyMantleUs.nativeModelId);
      expect(found?.nativeModelId).toBe(anyMantleUs.nativeModelId);
    }
  });

  test("resolveInvocationId prefers global profile when preference=global", async () => {
    const fm = await client.listFoundationModels("us-east-1");
    const ip = await client.listInferenceProfiles("us-east-1");
    const catalog = buildRegionCatalog("us", "us-east-1", fm, ip, []);

    // Find a converse model that has BOTH a global.* and us.* profile.
    const dual = catalog.find(
      (m) =>
        m.profiles.some((p) => p.startsWith("global.")) &&
        m.profiles.some((p) => p.startsWith("us.")),
    );
    expect(dual).toBeDefined();
    if (dual) {
      expect(resolveInvocationId(dual, "global").startsWith("global.")).toBe(true);
      expect(resolveInvocationId(dual, "regional").startsWith("us.")).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Hermetic unit tests for resolveInvocationId (no network, no fixtures).
 *
 * Every OTHER hermetic DiscoveredModel in the suite is built with
 * profiles: [] + supportsOnDemand: true, so the global-vs-regional profile
 * ORDERING and the no-profile refusal branch never execute in the merge gate.
 * Yet Claude on Bedrock is inference-profile-only and REJECTS bare ids: if the
 * ordering regressed, every Claude request would 400 while CI stayed green.
 * These tests pin both branches directly.
 * ------------------------------------------------------------------ */

/** A DiscoveredModel literal (the idiom from tests/virtual-tiers.test.ts), with
 *  Claude-shaped defaults overridable per case. */
function discovered(overrides: Partial<DiscoveredModel>): DiscoveredModel {
  return {
    provider: "bedrock",
    awsRegion: "us-east-1",
    regionKey: "us",
    backend: "converse",
    nativeModelId: "anthropic.claude-x-v1:0",
    isAnthropic: true,
    supportsOnDemand: false,
    profiles: [],
    streaming: true,
    ...overrides,
  };
}

describe("resolveInvocationId (hermetic)", () => {
  test("prefers global under preference=global, regional under preference=regional", () => {
    const model = discovered({
      profiles: ["global.anthropic.claude-x-v1:0", "us.anthropic.claude-x-v1:0"],
    });
    expect(resolveInvocationId(model, "global")).toBe("global.anthropic.claude-x-v1:0");
    expect(resolveInvocationId(model, "regional")).toBe("us.anthropic.claude-x-v1:0");
    // "auto" behaves as global-first.
    expect(resolveInvocationId(model, "auto")).toBe("global.anthropic.claude-x-v1:0");
  });

  test("a model with exactly one profile resolves to it under either preference", () => {
    const onlyRegional = discovered({ profiles: ["us.anthropic.claude-x-v1:0"] });
    expect(resolveInvocationId(onlyRegional, "global")).toBe("us.anthropic.claude-x-v1:0");
    expect(resolveInvocationId(onlyRegional, "regional")).toBe("us.anthropic.claude-x-v1:0");

    const onlyGlobal = discovered({ profiles: ["global.anthropic.claude-x-v1:0"] });
    expect(resolveInvocationId(onlyGlobal, "global")).toBe("global.anthropic.claude-x-v1:0");
    expect(resolveInvocationId(onlyGlobal, "regional")).toBe("global.anthropic.claude-x-v1:0");
  });

  test("a foreign region-family profile is not the family match (match is regionKey-scoped)", () => {
    // regionKey "eu" but the only profile is a "us." one: neither the global nor
    // the eu-family candidate exists, and on-demand is off -> refuse.
    const model = discovered({
      regionKey: "eu",
      awsRegion: "eu-west-1",
      profiles: ["us.anthropic.claude-x-v1:0"],
    });
    expect(() => resolveInvocationId(model, "global")).toThrow(ModelNotFoundError);
  });

  test("no profile and no on-demand support THROWS ModelNotFoundError", () => {
    const model = discovered({ profiles: [], supportsOnDemand: false });
    expect(() => resolveInvocationId(model, "global")).toThrow(ModelNotFoundError);
    try {
      resolveInvocationId(model, "global");
      expect.unreachable();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toContain("no inference profile and no on-demand support");
    }
  });

  test("no profile but on-demand support resolves to the bare native id", () => {
    const model = discovered({ profiles: [], supportsOnDemand: true });
    expect(resolveInvocationId(model, "global")).toBe("anthropic.claude-x-v1:0");
    expect(resolveInvocationId(model, "regional")).toBe("anthropic.claude-x-v1:0");
  });
});

/* ------------------------------------------------------------------ *
 * External discovery redirect policy (A3), hermetic.
 *
 * A /models discovery fetch attaches a provider credential. If it followed a
 * provider-issued 3xx, that credential would be re-sent to an attacker-chosen
 * host (blind SSRF with a credential). The fetch must therefore set
 * `redirect: "manual"` and never fetch the Location. These tests pin both.
 * ------------------------------------------------------------------ */

/** A config with a single external provider whose modelsUrl is the given URL. */
function externalConfig(modelsUrl: string) {
  return validateConfig({
    server: { host: "127.0.0.1", port: 8787 },
    inboundAuth: { keys: ["test"] },
    primaryRegion: "us",
    profilePreference: "global",
    refreshIntervalMinutes: 60,
    claudeFallbackToMantle: false,
    regions: [{ key: "us", awsRegion: "us-east-1" }],
    providers: {
      ext: {
        type: "anthropic",
        credential: "secret-key",
        auth: "x-api-key",
        baseUrl: "https://api.example.com/v1",
        modelsUrl,
      },
    },
  });
}

/** Swap in a fetch spy that records the URL and the `redirect` init per call. */
function spyFetch(responder: () => Response) {
  const original = globalThis.fetch;
  const calls: { url: string; redirect: RequestInit["redirect"] }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, redirect: init?.redirect });
    return responder();
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

describe("external discovery never follows a redirect (A3)", () => {
  test("the credentialed /models fetch sets redirect: 'manual'", async () => {
    const spy = spyFetch(
      () =>
        new Response(JSON.stringify({ data: [{ id: "models/m1" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    try {
      const { models, statuses } = await discoverExternalCatalog(
        externalConfig("https://api.example.com/v1/models"),
      );
      expect(spy.calls).toHaveLength(1);
      expect(spy.calls[0]?.redirect).toBe("manual");
      // The OpenAI-style `models/` namespace is stripped to the bare id.
      expect(models.map((m) => m.nativeModelId)).toContain("m1");
      expect(statuses).toContainEqual({ source: "ext", state: "ok" });
    } finally {
      spy.restore();
    }
  });

  test("a 3xx is refused, not followed: the Location is never fetched and the source errors", async () => {
    const spy = spyFetch(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://169.254.169.254/latest/meta-data/" },
        }),
    );
    try {
      const { models, statuses } = await discoverExternalCatalog(
        externalConfig("https://api.example.com/v1/models"),
      );
      // Exactly ONE request — the redirect target is never fetched.
      expect(spy.calls).toHaveLength(1);
      expect(spy.calls[0]?.url).toBe("https://api.example.com/v1/models");
      expect(models).toHaveLength(0);
      const status = statuses.find((s) => s.source === "ext");
      expect(status?.state).toBe("error");
    } finally {
      spy.restore();
    }
  });
});
