/**
 * bedrock-mode.ts tests (hermetic, pure classification — no network).
 *
 * Covers the single decision point for "is Bedrock usable": empty/placeholder
 * credentials disable it, the dev sentinel needs AWS env creds, a real key
 * enables it and yields a working token provider.
 */
import { describe, expect, test } from "bun:test";
import {
  bedrockDisabledReason,
  credentialState,
  isBedrockCredentialUsable,
  resolveBedrockMode,
} from "../src/auth/bedrock-mode.ts";
import { BEDROCK_DEV_SENTINELS } from "../src/auth/token-provider.ts";

const AWS_ENV = {
  AWS_ACCESS_KEY_ID: "AKIA-test",
  AWS_SECRET_ACCESS_KEY: "secret",
};

describe("credentialState", () => {
  test("classifies empty / placeholder / dev / key", () => {
    expect(credentialState(undefined)).toBe("empty");
    expect(credentialState("")).toBe("empty");
    expect(credentialState("bedrock-api-key-REPLACE_ME")).toBe("placeholder");
    expect(credentialState("dev")).toBe("dev");
    expect(credentialState("DEV")).toBe("dev");
    expect(credentialState("bedrock-api-key-realkeypayload")).toBe("key");
  });
});

describe("resolveBedrockMode", () => {
  test("empty credential disables with an actionable reason", () => {
    const mode = resolveBedrockMode("", {});
    expect(mode.enabled).toBe(false);
    if (!mode.enabled) expect(mode.reason).toContain("no Bedrock credential");
  });

  test("absent bedrock block (undefined) disables", () => {
    const mode = resolveBedrockMode(undefined, {});
    expect(mode.enabled).toBe(false);
  });

  test("placeholder credential disables without touching the network", () => {
    // This is exactly the pre-fix 403 crash-loop configuration.
    const mode = resolveBedrockMode("bedrock-api-key-REPLACE_ME", {});
    expect(mode.enabled).toBe(false);
    if (!mode.enabled) expect(mode.reason).toContain("placeholder");
  });

  test("dev sentinel without AWS env creds disables with a reason", () => {
    const mode = resolveBedrockMode("dev", {});
    expect(mode.enabled).toBe(false);
    if (!mode.enabled) expect(mode.reason).toContain("AWS_ACCESS_KEY_ID");
  });

  test("dev sentinel with AWS env creds enables and mints per region", async () => {
    const mode = resolveBedrockMode("dev", AWS_ENV);
    expect(mode.enabled).toBe(true);
    if (mode.enabled) {
      const token = await mode.tokenProvider("us-east-1");
      expect(token.startsWith("bedrock-api-key-")).toBe(true);
    }
  });

  test("a real long-term key enables and returns the same key for any region", async () => {
    const mode = resolveBedrockMode("bedrock-api-key-realkeypayload", {});
    expect(mode.enabled).toBe(true);
    if (mode.enabled) {
      expect(await mode.tokenProvider("us-east-1")).toBe("bedrock-api-key-realkeypayload");
      expect(await mode.tokenProvider("eu-west-1")).toBe("bedrock-api-key-realkeypayload");
    }
  });
});

describe("cheap forms", () => {
  test("bedrockDisabledReason is undefined iff usable", () => {
    expect(bedrockDisabledReason("", {})).toContain("no Bedrock credential");
    expect(bedrockDisabledReason("bedrock-api-key-realkeypayload", {})).toBeUndefined();
  });

  test("isBedrockCredentialUsable matches resolveBedrockMode", () => {
    expect(isBedrockCredentialUsable("", {})).toBe(false);
    expect(isBedrockCredentialUsable("bedrock-api-key-REPLACE_ME", {})).toBe(false);
    expect(isBedrockCredentialUsable("dev", {})).toBe(false);
    expect(isBedrockCredentialUsable("dev", AWS_ENV)).toBe(true);
    expect(isBedrockCredentialUsable("bedrock-api-key-realkeypayload", {})).toBe(true);
  });

  test("the sentinel set is exported exactly once (no duplicated constants drift)", () => {
    expect([...BEDROCK_DEV_SENTINELS].sort()).toEqual(["", "DEV", "dev"]);
  });
});
