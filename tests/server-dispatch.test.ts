/**
 * Full server dispatch round-trip (hermetic) — drives createFetchHandler with a
 * REAL catalog + REAL fixtures, mocking only the outbound fetch boundary.
 *
 * This exercises the end-to-end glue that the path-level fixture tests don't:
 * inbound auth -> parse-once -> canonical-id parse -> route() -> translation
 * handler -> Response, for POST /v1/messages and /v1/messages/count_tokens, plus
 * GET /v1/models. It complements management-auth.test.ts (auth/CSRF matrix) and
 * paths-fixture.test.ts (per-handler translation).
 */
import { describe, expect, test } from "bun:test";
import { type ProxyConfig, validateConfig } from "../src/config.ts";
import { Catalog, type DiscoveredModel } from "../src/model/catalog.ts";
import { type Runtime, createFetchHandler, errorResponse } from "../src/server.ts";
import { installFetchMock, readFixtureText } from "./helpers/fetch-mock.ts";

const KEY = "ccpp-dispatch-key";

function makeConfig(): ProxyConfig {
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
        credential: "long-term-secret",
        hosts: {
          converse: "bedrock-runtime.{region}.amazonaws.com",
          mantle: "bedrock-mantle.{region}.api.aws",
          control: "bedrock.{region}.amazonaws.com",
        },
      },
    },
    logging: { enabled: false, dir: "./logs", systemDir: "system", sessionDir: "sessions" },
    chatPage: { enabled: true },
  });
}

// A real Converse model (on-demand, bare id) so route() resolves without profiles.
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

function makeRuntime(config: ProxyConfig): Runtime {
  const catalog = new Catalog([novaModel]);
  const runtime = {
    config,
    tokenProvider: async () => "test-bearer",
    catalogManager: { current: () => catalog, stop: () => {} },
    logStore: { isEnabled: () => false },
  };
  return runtime as unknown as Runtime;
}

function handler() {
  const config = makeConfig();
  const runtime = makeRuntime(config);
  return createFetchHandler(
    () => runtime,
    async () => {},
  );
}

function post(path: string, body: unknown, key = KEY): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const CID = "bedrock.converse.us.amazon.nova-lite-v1:0";

describe("POST /v1/messages end-to-end (Converse via fixture)", () => {
  test("authenticated request translates a Converse response to an Anthropic message", async () => {
    const mock = installFetchMock({ text: readFixtureText("converse-text.json") });
    try {
      const res = await handler()(
        post("/v1/messages", {
          model: CID,
          max_tokens: 64,
          messages: [{ role: "user", content: "hi" }],
        }),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json.type).toBe("message");
      expect(json.role).toBe("assistant");
      const content = json.content as Array<{ type: string; text?: string }>;
      expect(content[0]?.text).toBe("Hello fixture");
      // The outbound call went to the converse endpoint with a Bearer token.
      expect(mock.requests[0]?.url).toContain("/converse");
      expect(mock.requests[0]?.headers.authorization).toBe("Bearer test-bearer");
    } finally {
      mock.restore();
    }
  });

  test("SEC-1: an oversized inbound body is rejected with 413 (before parse)", async () => {
    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${KEY}`,
        "content-type": "application/json",
        "content-length": String(50 * 1024 * 1024), // 50 MiB > 25 MiB cap
      },
      body: JSON.stringify({
        model: CID,
        max_tokens: 8,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    const res = await handler()(req);
    expect(res.status).toBe(413);
    const json = (await res.json()) as { type: string; error?: { type: string } };
    expect(json.type).toBe("error");
    expect(json.error?.type).toBe("invalid_request_error");
  });

  test("missing inbound key -> 401 (no upstream call)", async () => {
    const mock = installFetchMock({ text: "{}" });
    try {
      const res = await handler()(
        new Request("http://localhost/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: CID, messages: [] }),
        }),
      );
      expect(res.status).toBe(401);
      expect(mock.requests).toHaveLength(0);
    } finally {
      mock.restore();
    }
  });

  test("a non-object body -> 400 (trust-boundary parse)", async () => {
    const mock = installFetchMock({ text: "{}" });
    try {
      const res = await handler()(
        new Request("http://localhost/v1/messages", {
          method: "POST",
          headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
          body: '"not an object"',
        }),
      );
      expect(res.status).toBe(400);
      expect(mock.requests).toHaveLength(0);
    } finally {
      mock.restore();
    }
  });

  test("an unknown model id -> error status, no successful message", async () => {
    const mock = installFetchMock({ text: "{}" });
    try {
      const res = await handler()(
        post("/v1/messages", {
          model: "bedrock.converse.us.does.not-exist",
          messages: [{ role: "user", content: "hi" }],
        }),
      );
      expect(res.status).toBeGreaterThanOrEqual(400);
    } finally {
      mock.restore();
    }
  });

  test("relays an upstream 500 as an error (Converse)", async () => {
    const mock = installFetchMock({ status: 500, text: "upstream boom" });
    try {
      const res = await handler()(
        post("/v1/messages", {
          model: CID,
          max_tokens: 64,
          messages: [{ role: "user", content: "hi" }],
        }),
      );
      expect(res.status).toBeGreaterThanOrEqual(500);
    } finally {
      mock.restore();
    }
  });
});

describe("GET /v1/models", () => {
  test("lists the discovered model with its canonical id (no auth required)", async () => {
    const res = await handler()(new Request("http://localhost/v1/models", { method: "GET" }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data?: Array<{ id: string }> };
    const ids = (json.data ?? []).map((m) => m.id);
    expect(ids.some((id) => id.includes("nova-lite"))).toBe(true);
  });
});

describe("errorResponse SEC-7 (generic message + stable id for unexpected errors)", () => {
  test("does NOT leak a raw Error.message for a non-ProxyError; returns a reference id", async () => {
    const secret = "connect ECONNREFUSED 10.0.0.5:5432 (internal db)";
    const res = errorResponse(new Error(secret));
    expect(res.status).toBe(500);
    const json = (await res.json()) as { type: string; error: { type: string; message: string } };
    expect(json.type).toBe("error");
    expect(json.error.type).toBe("api_error");
    // The internal detail must NOT appear in the client body.
    expect(json.error.message).not.toContain(secret);
    expect(json.error.message).not.toContain("ECONNREFUSED");
    expect(json.error.message).not.toContain("10.0.0.5");
    // A stable correlation id IS present so the operator can find it in logs.
    expect(json.error.message).toMatch(/reference: [0-9a-f-]{36}/);
  });

  test("still surfaces a ProxyError's own (safe) message", async () => {
    const { BadRequestError } = await import("../src/errors.ts");
    const res = errorResponse(new BadRequestError("messages must be an array"));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toBe("messages must be an array");
  });
});
