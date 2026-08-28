/**
 * Bedrock region-token-provider tests — hermetic (env injected, no network).
 *
 * Security-relevant: the provider decides between a region-agnostic long-term
 * key and dev-mode SigV4 minting. The long-term and error paths are fully
 * hermetic (no AWS call). We do NOT invoke the dev-mode minting function
 * (that would sign/return a token without hitting the network, but we keep the
 * suite free of any crypto/AWS surface by only asserting it returns a function
 * and that the missing-creds guard throws).
 */
import { describe, expect, test } from "bun:test";
import { createBedrockTokenProvider } from "../src/auth/token-provider.ts";
import { ConfigError } from "../src/errors.ts";

describe("createBedrockTokenProvider (long-term key)", () => {
  test("returns the same region-agnostic key for every region", async () => {
    const provider = createBedrockTokenProvider("bedrock-api-key-longterm", {});
    const a = await provider("us-east-1");
    const b = await provider("eu-west-1");
    expect(a).toBe("bedrock-api-key-longterm");
    expect(b).toBe("bedrock-api-key-longterm");
  });
});

describe("createBedrockTokenProvider (dev sentinel)", () => {
  test("throws ConfigError when the credential is a dev sentinel and AWS creds are absent", () => {
    for (const sentinel of ["", "dev", "DEV"]) {
      expect(() => createBedrockTokenProvider(sentinel, {})).toThrow(ConfigError);
    }
  });

  test("returns a per-region minting function when dev sentinel + AWS creds present", () => {
    const provider = createBedrockTokenProvider("dev", {
      AWS_ACCESS_KEY_ID: "AKIA_TEST",
      AWS_SECRET_ACCESS_KEY: "secret_test",
    });
    // A function is returned; we do not call it (avoids minting a token here).
    expect(typeof provider).toBe("function");
  });

  test("dev sentinel with only a partial credential set still throws", () => {
    expect(() => createBedrockTokenProvider("dev", { AWS_ACCESS_KEY_ID: "AKIA_only" })).toThrow(
      ConfigError,
    );
  });

  test("caches the minted token per region (de-dups repeat + concurrent calls)", async () => {
    const provider = createBedrockTokenProvider("dev", {
      AWS_ACCESS_KEY_ID: "AKIA_TEST",
      AWS_SECRET_ACCESS_KEY: "secret_test",
    });
    // SigV4 signing is local (no network). Two calls for the same region return
    // the identical cached token; a different region mints a distinct token.
    const [a1, a2] = await Promise.all([provider("us-east-1"), provider("us-east-1")]);
    expect(a1).toBe(a2);
    const b = await provider("eu-west-1");
    expect(b).not.toBe(a1); // region-scoped: different presigned host/region
    // A third call for the cached region still returns the same token.
    expect(await provider("us-east-1")).toBe(a1);
  });
});
