import { describe, expect, test } from "bun:test";
import {
  generateShortLivedBedrockToken,
  resolveBedrockCredential,
} from "../src/auth/bedrock-token.ts";
import { ConfigError } from "../src/errors.ts";

// Synthetic, obviously-fake credentials — NOT real AWS keys and deliberately
// not in AWS key format. They only exercise the SigV4 signing algorithm, which
// does not validate key shape.
const CREDS = {
  accessKeyId: "TEST-ACCESS-KEY-ID-NOT-REAL",
  secretAccessKey: "test-secret-not-real-0000000000000000000",
  sessionToken: "test-session-token-not-real",
};

function decodeToken(token: string): string {
  const b64 = token.slice("bedrock-api-key-".length);
  return Buffer.from(b64, "base64").toString("utf-8");
}

describe("generateShortLivedBedrockToken", () => {
  test("produces a token with the correct prefix and version suffix", async () => {
    const token = await generateShortLivedBedrockToken({
      credentials: CREDS,
      region: "us-east-1",
      expiresInSeconds: 3600,
    });
    expect(token.startsWith("bedrock-api-key-")).toBe(true);

    const decoded = decodeToken(token);
    expect(decoded.endsWith("&Version=1")).toBe(true);
    // Presigned URL (protocol stripped) for the CallWithBearerToken action.
    expect(decoded.startsWith("bedrock.amazonaws.com/")).toBe(true);
    expect(decoded).toContain("Action=CallWithBearerToken");
    expect(decoded).toContain("X-Amz-Algorithm=AWS4-HMAC-SHA256");
    expect(decoded).toContain("X-Amz-Signature=");
    expect(decoded).toContain("X-Amz-Expires=3600");
    // Session token must be embedded when provided.
    expect(decoded).toContain("X-Amz-Security-Token=");
  });

  test("works without a session token (long-term IAM creds)", async () => {
    const token = await generateShortLivedBedrockToken({
      credentials: { accessKeyId: CREDS.accessKeyId, secretAccessKey: CREDS.secretAccessKey },
      region: "eu-west-1",
    });
    const decoded = decodeToken(token);
    expect(decoded).toContain("X-Amz-Credential=");
    expect(decoded).not.toContain("X-Amz-Security-Token=");
  });

  test("rejects out-of-range expiry", async () => {
    await expect(
      generateShortLivedBedrockToken({
        credentials: CREDS,
        region: "us-east-1",
        expiresInSeconds: 0,
      }),
    ).rejects.toThrow(ConfigError);
    await expect(
      generateShortLivedBedrockToken({
        credentials: CREDS,
        region: "us-east-1",
        expiresInSeconds: 43201,
      }),
    ).rejects.toThrow(ConfigError);
  });

  test("rejects missing credentials", async () => {
    await expect(
      generateShortLivedBedrockToken({
        credentials: { accessKeyId: "", secretAccessKey: "" },
        region: "us-east-1",
      }),
    ).rejects.toThrow(ConfigError);
  });
});

describe("resolveBedrockCredential", () => {
  test("passes through a configured long-term key", () => {
    expect(resolveBedrockCredential("bedrock-api-key-longterm")).toBe("bedrock-api-key-longterm");
  });
  test("throws on empty credential", () => {
    expect(() => resolveBedrockCredential("")).toThrow(ConfigError);
  });
});
