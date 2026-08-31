/**
 * Catalog discovery tests — LIVE ONLY. No mocks, no fixtures.
 *
 * These tests perform real discovery against live AWS Bedrock (control-plane +
 * Mantle) using credentials from the environment, and a short-lived Bedrock
 * bearer token generated the same way production does.
 *
 * Required env: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, (AWS_SESSION_TOKEN).
 * If these are absent the suite fails loudly rather than fabricating data.
 */
import { beforeAll, expect, test } from "bun:test";
import { generateShortLivedBedrockToken } from "../src/auth/bedrock-token.ts";
import { validateConfig } from "../src/config.ts";
import {
  Catalog,
  type DiscoveryClient,
  buildRegionCatalog,
  createHttpDiscoveryClient,
  discoverCatalog,
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
