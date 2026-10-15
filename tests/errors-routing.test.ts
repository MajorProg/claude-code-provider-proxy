/**
 * Routing error taxonomy — HERMETIC.
 *
 * route() must distinguish "provider not configured" (UnsupportedProviderError)
 * from "provider configured but currently inactive" (ProviderDisabledError).
 * Before this, UnsupportedProviderError (src/errors.ts:96, thrown
 * src/router.ts:94) had NO test at any level.
 */
import { describe, expect, test } from "bun:test";
import { type ProxyConfig, validateConfig } from "../src/config.ts";
import { ProviderDisabledError, UnsupportedProviderError } from "../src/errors.ts";
import { parseCanonicalId } from "../src/model/canonical-id.ts";
import { Catalog } from "../src/model/catalog.ts";
import { route } from "../src/router.ts";

function cfg(): ProxyConfig {
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
        credential: "long-term-secret",
        hosts: {
          converse: "bedrock-runtime.{region}.amazonaws.com",
          mantle: "bedrock-mantle.{region}.api.aws",
          control: "bedrock.{region}.amazonaws.com",
        },
      },
      // Configured but INACTIVE: an empty credential leaves the pool unusable.
      zai: {
        type: "anthropic",
        credential: "",
        auth: "bearer",
        baseUrl: "https://api.z.ai/api/anthropic",
        countTokens: true,
        modelsUrl: "https://api.z.ai/api/paas/v4/models",
      },
    },
    logging: { enabled: false },
    chatPage: { enabled: false },
  });
}

describe("route() unsupported provider (hermetic)", () => {
  test("an unconfigured provider throws UnsupportedProviderError", () => {
    expect(() =>
      route(cfg(), new Catalog([]), parseCanonicalId("nosuch.anthropic.global.some-model")),
    ).toThrow(UnsupportedProviderError);
  });

  test("it renders as a 404 not_found_error naming the provider", () => {
    try {
      route(cfg(), new Catalog([]), parseCanonicalId("nosuch.anthropic.global.some-model"));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedProviderError);
      if (!(err instanceof UnsupportedProviderError)) return;
      expect(err.status).toBe(404);
      expect(err.type).toBe("not_found_error");
      expect(err.message).toContain("nosuch");
      expect(err.toAnthropicBody()).toEqual({
        type: "error",
        error: { type: "not_found_error", message: expect.stringContaining("nosuch") },
      });
    }
  });

  test("a CONFIGURED-but-inactive provider is ProviderDisabledError, a DISTINCT class", () => {
    let disabled: unknown;
    try {
      route(cfg(), new Catalog([]), parseCanonicalId("zai.anthropic.global.glm-5.3"));
      expect.unreachable();
    } catch (err) {
      disabled = err;
    }
    expect(disabled).toBeInstanceOf(ProviderDisabledError);
    // "known provider, not active" is NOT "unknown provider".
    expect(disabled).not.toBeInstanceOf(UnsupportedProviderError);
    // The two classes are disjoint in both directions.
    expect(new UnsupportedProviderError("x")).not.toBeInstanceOf(ProviderDisabledError);
  });
});
