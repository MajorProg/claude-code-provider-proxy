/**
 * route() Bedrock path selection — HERMETIC.
 *
 * tests/router.test.ts wraps its whole body in `describeLive`, so NO hermetic
 * test asserts the bedrock path-selection branches. A swap in routeMantle's
 * isAnthropic branch would send Claude through the OpenAI translator and break
 * every Claude-on-Mantle request with CI green. These tests exercise the REAL
 * route() with a fixed `new Catalog([...])` + `validateConfig({...})`.
 */
import { describe, expect, test } from "bun:test";
import { type ProxyConfig, validateConfig } from "../src/config.ts";
import { parseCanonicalId } from "../src/model/canonical-id.ts";
import { Catalog, type DiscoveredModel } from "../src/model/catalog.ts";
import { route } from "../src/router.ts";

const CLAUDE = "anthropic.claude-x-v1:0";
const NOVA = "amazon.nova-lite-v1:0";

function cfg(): ProxyConfig {
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
        credential: "long-term-secret",
        hosts: {
          converse: "bedrock-runtime.{region}.amazonaws.com",
          mantle: "bedrock-mantle.{region}.api.aws",
          control: "bedrock.{region}.amazonaws.com",
        },
      },
    },
    logging: { enabled: false },
    chatPage: { enabled: false },
  });
}

function discovered(overrides: Partial<DiscoveredModel>): DiscoveredModel {
  return {
    provider: "bedrock",
    awsRegion: "us-east-1",
    regionKey: "us",
    backend: "converse",
    nativeModelId: CLAUDE,
    isAnthropic: true,
    supportsOnDemand: false,
    profiles: [],
    streaming: true,
    ...overrides,
  };
}

// Claude on Converse is inference-profile-only -> resolvable via a profile.
const converseClaude = discovered({ profiles: [`us.${CLAUDE}`] });
const converseNova = discovered({
  nativeModelId: NOVA,
  isAnthropic: false,
  supportsOnDemand: true,
  profiles: [],
});

describe("route() bedrock path selection (hermetic)", () => {
  test("Claude on bedrock.mantle.* -> Path P passthrough + count_tokens path", () => {
    const t = route(cfg(), new Catalog([]), parseCanonicalId(`bedrock.mantle.us.${CLAUDE}`));
    expect(t.provider).toBe("bedrock");
    expect(t.backend).toBe("mantle");
    expect(t.translationPath).toBe("passthrough");
    expect(t.isAnthropic).toBe(true);
    expect(t.path).toBe("https://bedrock-mantle.us-east-1.api.aws/anthropic/v1/messages");
    expect(t.countTokensPath).toBe(
      "https://bedrock-mantle.us-east-1.api.aws/anthropic/v1/messages/count_tokens",
    );
    // Mantle's native Anthropic route takes the bare id (no profile resolution).
    expect(t.invocationId).toBe(CLAUDE);
  });

  test("non-Claude on bedrock.mantle.* -> Path M (OpenAI translation), no count_tokens", () => {
    const t = route(cfg(), new Catalog([]), parseCanonicalId(`bedrock.mantle.us.${NOVA}`));
    expect(t.backend).toBe("mantle");
    expect(t.translationPath).toBe("mantle");
    expect(t.isAnthropic).toBe(false);
    expect(t.path).toBe("https://bedrock-mantle.us-east-1.api.aws/v1/chat/completions");
    expect(t.countTokensPath).toBeUndefined();
    expect(t.invocationId).toBe(NOVA);
  });

  test("Claude on bedrock.converse.* -> Path C (Converse), NOT passthrough", () => {
    const t = route(
      cfg(),
      new Catalog([converseClaude]),
      parseCanonicalId(`bedrock.converse.us.${CLAUDE}`),
    );
    expect(t.provider).toBe("bedrock");
    expect(t.backend).toBe("converse");
    expect(t.translationPath).toBe("converse");
    expect(t.isAnthropic).toBe(true);
    expect(t.origin).toBe("https://bedrock-runtime.us-east-1.amazonaws.com");
    expect(t.path).toContain("/model/");
    expect(t.path.endsWith("/converse")).toBe(true);
    expect(t.streamPath.endsWith("/converse-stream")).toBe(true);
    expect(t.countTokensPath).toBeUndefined();
    // Inference-profile-only -> resolved to the profile id, never the bare id.
    expect(t.invocationId).toBe(`us.${CLAUDE}`);
  });

  test("non-Claude on bedrock.converse.* -> Path C, isAnthropic false, bare id", () => {
    const t = route(
      cfg(),
      new Catalog([converseNova]),
      parseCanonicalId(`bedrock.converse.us.${NOVA}`),
    );
    expect(t.translationPath).toBe("converse");
    expect(t.isAnthropic).toBe(false);
    expect(t.path.endsWith("/converse")).toBe(true);
    expect(t.invocationId).toBe(NOVA);
  });

  test("global profilePrefix resolves to the PRIMARY region host", () => {
    const t = route(cfg(), new Catalog([]), parseCanonicalId(`bedrock.mantle.global.${NOVA}`));
    expect(t.awsRegion).toBe("us-east-1");
  });

  test("eu profilePrefix resolves to the eu-west-1 host", () => {
    const t = route(cfg(), new Catalog([]), parseCanonicalId(`bedrock.mantle.eu.${NOVA}`));
    expect(t.awsRegion).toBe("eu-west-1");
    expect(t.origin).toContain("eu-west-1");
  });
});
