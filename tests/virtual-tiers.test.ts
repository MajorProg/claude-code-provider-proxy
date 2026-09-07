/**
 * Virtual model tier routing (docs/VIRTUAL_MODELS.md) — hermetic unit tests over the
 * REAL router: tier expansion, ordered availability filtering, descriptive
 * errors, and virtualTierStatuses. Companion e2e failover coverage lives in
 * failover.test.ts; config-level tier validation in config.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { type ProxyConfig, validateConfig } from "../src/config.ts";
import { ModelNotFoundError } from "../src/errors.ts";
import { parseCanonicalId } from "../src/model/canonical-id.ts";
import { Catalog, type DiscoveredModel } from "../src/model/catalog.ts";
import { route, virtualTierStatuses } from "../src/router.ts";

function tierConfig(overrides?: {
  zaiCredential?: string;
  bedrockCredential?: string;
  /** false = omit the virtualModels block entirely. */
  tiers?: boolean;
}): ProxyConfig {
  const tiers = overrides?.tiers !== false;
  return validateConfig({
    server: { host: "127.0.0.1", port: 8787 },
    inboundAuth: { keys: ["k"] },
    primaryRegion: "us",
    profilePreference: "global",
    refreshIntervalMinutes: 60,
    claudeFallbackToMantle: false,
    regions: [{ key: "us", awsRegion: "us-east-1" }],
    providers: {
      bedrock: {
        credential: overrides?.bedrockCredential ?? "bedrock-api-key-test",
        hosts: {
          converse: "bedrock-runtime.{region}.amazonaws.com",
          mantle: "bedrock-mantle.{region}.api.aws",
          control: "bedrock.{region}.amazonaws.com",
        },
      },
      zai: {
        type: "anthropic",
        credential: overrides?.zaiCredential ?? "zai-key",
        auth: "bearer",
        baseUrl: "https://api.z.ai/api/anthropic",
        countTokens: true,
        modelsUrl: "https://api.z.ai/api/paas/v4/models",
      },
    },
    ...(tiers
      ? {
          virtualModels: {
            "sonnet-like": [
              "zai.anthropic.global.glm-5.3",
              "bedrock.converse.us.amazon.nova-lite-v1:0",
            ],
          },
        }
      : {}),
    logging: { enabled: false },
    chatPage: { enabled: false },
  });
}

// A real converse catalog entry so the bedrock candidate ROUTES (routeConverse
// consults the catalog; external candidates do not).
const novaModel: DiscoveredModel = {
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

const TIER_ID = "virtual.anthropic.global.sonnet-like";

describe("route() virtual tiers", () => {
  test("expands to the first available candidate", () => {
    const t = route(tierConfig(), new Catalog([novaModel]), parseCanonicalId(TIER_ID));
    expect(t.provider).toBe("zai");
    expect(t.translationPath).toBe("passthrough");
    expect(t.invocationId).toBe("glm-5.3");
  });

  test("skips an inactive external candidate and falls to the next (bedrock converse)", () => {
    // zai's key unset => provider inactive => skipped; bedrock converse serves.
    const config = tierConfig({ zaiCredential: "" });
    const t = route(config, new Catalog([novaModel]), parseCanonicalId(TIER_ID));
    expect(t.provider).toBe("bedrock");
    expect(t.translationPath).toBe("converse");
  });

  test("skips a bedrock candidate missing from the catalog (converse is catalog-gated)", () => {
    const t = route(tierConfig(), new Catalog([]), parseCanonicalId(TIER_ID));
    expect(t.provider).toBe("zai");
  });

  test("an all-unavailable tier throws ModelNotFoundError naming the tier and reasons", () => {
    const config = tierConfig({ zaiCredential: "", bedrockCredential: "" });
    try {
      route(config, new Catalog([]), parseCanonicalId(TIER_ID));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ModelNotFoundError);
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toContain("sonnet-like");
      expect(msg).toContain("zai.anthropic.global.glm-5.3");
      expect(msg).toContain("bedrock.converse.us.amazon.nova-lite-v1:0");
    }
  });

  test("an unknown tier is a clean 404 naming the configured set", () => {
    try {
      route(tierConfig(), new Catalog([]), parseCanonicalId("virtual.anthropic.global.nope-like"));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ModelNotFoundError);
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toContain("nope-like");
      expect(msg).toContain("sonnet-like");
    }
  });

  test("a non-virtual id behaves exactly as before (single candidate)", () => {
    const t = route(
      tierConfig(),
      new Catalog([]),
      parseCanonicalId("zai.anthropic.global.glm-5.3"),
    );
    expect(t.provider).toBe("zai");
  });
});

describe("virtualTierStatuses", () => {
  test("reports resolution + per-candidate availability", () => {
    const statuses = virtualTierStatuses(tierConfig(), new Catalog([novaModel]));
    expect(statuses).toHaveLength(1);
    const tier = statuses[0];
    expect(tier?.name).toBe("sonnet-like");
    expect(tier?.candidates).toHaveLength(2);
    expect(tier?.available).toEqual([
      "zai.anthropic.global.glm-5.3",
      "bedrock.converse.us.amazon.nova-lite-v1:0",
    ]);
    expect(tier?.resolution).toBe("zai.anthropic.global.glm-5.3");
  });

  test("resolution is null when nothing is available, with reasons recorded", () => {
    const statuses = virtualTierStatuses(
      tierConfig({ zaiCredential: "", bedrockCredential: "" }),
      new Catalog([]),
    );
    const tier = statuses[0];
    expect(tier?.resolution).toBeNull();
    expect(tier?.available).toEqual([]);
    expect(tier?.reasons[0]).toContain("credential pool is empty");
    expect(tier?.reasons[1]).toBeTruthy();
  });

  test("no virtualModels block => empty statuses", () => {
    expect(virtualTierStatuses(tierConfig({ tiers: false }), new Catalog([]))).toEqual([]);
  });
});
