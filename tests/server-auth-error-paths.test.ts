/**
 * Error-path coverage for describeAuth (GET /api/config/auth) in src/server.ts.
 *
 * The dev-sigv4 branch validates that a short-lived Bedrock token CAN be minted
 * but returns METADATA ONLY — never the minted token itself. When the mint
 * THROWS it must degrade to a metadata-only description with tokenAvailable
 * false, NOT fail the request. tests/server-coverage.test.ts:360 only drives the
 * mint SUCCESS path, so the failure catch is otherwise uncovered.
 *
 * Driving that catch requires the mint to reject. A real AWS/WebCrypto failure
 * is not inducible in-process (the function's own guards are satisfied by a
 * valid dev config, and aws4fetch's signer does not throw for the fixed, valid
 * presign URL), so the outbound mint is replaced with a PASS-THROUGH double:
 * every call delegates to the real SigV4 implementation EXCEPT while
 * `mintShouldFail` is set, when it rejects. The double is process-global and
 * irreversible (bun's `mock.restore()` does not undo `mock.module`), but
 * because it always delegates, every other suite keeps the real implementation.
 *
 * The handler itself is REAL — createFetchHandler with a stubbed Runtime, the
 * same documented seam tests/server-coverage.test.ts and
 * tests/server-dispatch.test.ts use. Assertions are on the real HTTP status +
 * JSON body, and on the documented invariant that the minted token never
 * appears.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mock } from "bun:test";
import type { GenerateTokenOptions } from "../src/auth/bedrock-token.ts";
import * as bedrockToken from "../src/auth/bedrock-token.ts";
import { type ProxyConfig, validateConfig } from "../src/config.ts";
import { CredentialCooldownStore } from "../src/failover.ts";
import type { LogStore } from "../src/logging/log-store.ts";
import { Catalog } from "../src/model/catalog.ts";
import { type Runtime, createFetchHandler } from "../src/server.ts";

const KEY = "ccpp-server-auth-error-paths-key";
const BASE = "http://localhost";

/** The mint-failure message the double rejects with; asserted verbatim in the body. */
const MINT_FAILURE_MESSAGE = "simulated dev Bedrock token mint failure";

/**
 * Set only while the failure-path request is in flight; otherwise the double
 * delegates to the real implementation so no other suite is affected.
 */
let mintShouldFail = false;

// Capture the REAL implementations BEFORE the module is replaced. The `import *`
// binding is live and would itself retarget to the double once mock.module runs
// (delegating to the live binding would recurse infinitely); a top-level `const`
// copies the original function values.
const realGenerateToken = bedrockToken.generateShortLivedBedrockToken;
const realResolveCredential = bedrockToken.resolveBedrockCredential;

// Pass-through module double (see the file header for why this is safe).
mock.module("../src/auth/bedrock-token.ts", () => ({
  resolveBedrockCredential: realResolveCredential,
  generateShortLivedBedrockToken: async (options: GenerateTokenOptions) => {
    if (mintShouldFail) throw new Error(MINT_FAILURE_MESSAGE);
    return realGenerateToken(options);
  },
}));

afterAll(() => {
  mintShouldFail = false;
});

const DISABLED_STORE = { isEnabled: () => false } as unknown as LogStore;

/** A dev-mode Bedrock config (credential "dev"), external providers absent. */
function devConfig(): ProxyConfig {
  return validateConfig({
    server: { host: "127.0.0.1", port: 8787 },
    inboundAuth: { keys: [KEY] },
    primaryRegion: "us",
    profilePreference: "global",
    refreshIntervalMinutes: 60,
    claudeFallbackToMantle: false,
    regions: [{ key: "us", awsRegion: "us-east-1" }],
    providers: {
      bedrock: {
        credential: "dev",
        hosts: {
          converse: "bedrock-runtime.{region}.amazonaws.com",
          mantle: "bedrock-mantle.{region}.api.aws",
          control: "bedrock.{region}.amazonaws.com",
        },
      },
    },
    logging: { enabled: false },
    chatPage: { enabled: true },
  });
}

function handlerFor(config: ProxyConfig): (req: Request) => Promise<Response> {
  const runtime = {
    config,
    tokenProvider: async () => "unused-by-the-auth-description-route",
    catalogManager: { current: () => new Catalog([]), stop: () => {} },
    logStore: DISABLED_STORE,
    cooldownStore: new CredentialCooldownStore(),
  } as unknown as Runtime;
  return createFetchHandler(
    () => runtime,
    async () => undefined,
  );
}

function authRequest(): Request {
  return new Request(`${BASE}/api/config/auth`, {
    headers: { authorization: `Bearer ${KEY}` },
  });
}

interface AuthBody {
  bedrock: {
    mode: string;
    tokenAvailable?: boolean;
    error?: string;
    region?: string;
    awsPresent?: Record<string, boolean>;
  };
}

describe("describeAuth dev-sigv4 MINT-FAILURE path", () => {
  // dev mode is only "enabled" (and so only reaches the mint) with AWS creds
  // present in the environment — resolveBedrockMode gates on this (bedrock-mode.ts).
  const saved: { accessKeyId: string | undefined; secretAccessKey: string | undefined } = {
    accessKeyId: undefined,
    secretAccessKey: undefined,
  };
  beforeEach(() => {
    saved.accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    saved.secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
    process.env.AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
    process.env.AWS_SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
  });
  afterEach(() => {
    // Restore by empty string, never the `delete` operator (noDelete lint).
    process.env.AWS_ACCESS_KEY_ID = saved.accessKeyId ?? "";
    process.env.AWS_SECRET_ACCESS_KEY = saved.secretAccessKey ?? "";
    mintShouldFail = false;
  });

  test("a throwing mint degrades to metadata-only 200, never failing the request", async () => {
    mintShouldFail = true;
    const res = await handlerFor(devConfig())(authRequest());

    // The request still succeeds — a failed mint must not surface as an error.
    expect(res.status).toBe(200);
    const text = await res.text();
    const json = JSON.parse(text) as AuthBody;

    // Degraded, but still identified as the dev-sigv4 mode.
    expect(json.bedrock.mode).toBe("dev-sigv4");
    expect(json.bedrock.tokenAvailable).toBe(false);
    // The REAL error was surfaced — and it is the MINT failure, not the guard's
    // "AWS credentials not present" throw: the config satisfied the guard and
    // failed deeper, in the mint itself.
    expect(json.bedrock.error).toBe(MINT_FAILURE_MESSAGE);
    // Metadata is still reported alongside the failure.
    expect(json.bedrock.region).toBe("us-east-1");
    expect(json.bedrock.awsPresent?.AWS_ACCESS_KEY_ID).toBe(true);
    expect(json.bedrock.awsPresent?.AWS_SECRET_ACCESS_KEY).toBe(true);
    // The invariant holds even on the failure path: the minted token is never
    // returned (there is none here — but the response must never carry one).
    expect(text.includes("bedrock-api-key-")).toBe(false);
  });

  test("the same config WITHOUT the forced mint failure mints successfully (control)", async () => {
    mintShouldFail = false;
    const res = await handlerFor(devConfig())(authRequest());
    expect(res.status).toBe(200);
    const text = await res.text();
    const json = JSON.parse(text) as AuthBody;
    expect(json.bedrock.mode).toBe("dev-sigv4");
    expect(json.bedrock.tokenAvailable).toBe(true);
    // Even on success the token is never echoed (metadata-only by design).
    expect(text.includes("bedrock-api-key-")).toBe(false);
  });
});
