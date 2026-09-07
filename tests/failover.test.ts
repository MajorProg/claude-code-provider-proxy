/**
 * Pre-stream failover (docs/VIRTUAL_MODELS.md) — hermetic, via createFetchHandler
 * with sequenced fetch mocks (the only mocked boundary).
 *
 * Exercises the REAL engine (src/failover.ts), routing (virtual tier
 * expansion + credential pools), and the passthrough handler end to end:
 * 401/403/429 and connect-exhaustion advance (next key → next candidate);
 * 5xx relays immediately; exhaustion relays the LAST error; the attempt cap
 * truncates; count_tokens resolves through tiers; streaming responses are
 * never retried once the handler returns.
 */
import { describe, expect, test } from "bun:test";
import { type ProxyConfig, validateConfig } from "../src/config.ts";
import { Catalog } from "../src/model/catalog.ts";
import { type Runtime, createFetchHandler } from "../src/server.ts";
import { type FetchMock, installFetchMock } from "./helpers/fetch-mock.ts";

const KEY = "ccpp-failover-key";

const ZAI_POOL = [
  { credential: "primary-key", label: "primary" },
  { credential: "secondary-key", label: "secondary" },
];

function makeConfig(maxFailoverAttempts?: number): ProxyConfig {
  return validateConfig({
    server: { host: "127.0.0.1", port: 8787 },
    inboundAuth: { keys: [KEY] },
    primaryRegion: "us",
    profilePreference: "global",
    refreshIntervalMinutes: 60,
    claudeFallbackToMantle: false,
    regions: [{ key: "us", awsRegion: "us-east-1" }],
    providers: {
      zai: {
        type: "anthropic",
        credentials: ZAI_POOL,
        auth: "bearer",
        baseUrl: "https://api.z.ai/api/anthropic",
        countTokens: true,
        modelsUrl: "https://api.z.ai/api/paas/v4/models",
      },
      alibaba: {
        type: "anthropic",
        credential: "alibaba-key",
        auth: "x-api-key",
        baseUrl: "https://dashscope-intl.aliyuncs.com/apps/anthropic",
        countTokens: true,
        modelsUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models",
      },
    },
    virtualModels: {
      "sonnet-like": ["zai.anthropic.global.glm-5.3", "alibaba.anthropic.global.qwen3-max"],
    },
    ...(maxFailoverAttempts !== undefined ? { maxFailoverAttempts } : {}),
    logging: { enabled: false },
    chatPage: { enabled: false },
  });
}

function makeRuntime(config: ProxyConfig): Runtime {
  const catalog = new Catalog([]);
  const runtime = {
    config,
    tokenProvider: null,
    catalogManager: { current: () => catalog, stop: () => {} },
    logStore: { isEnabled: () => false },
  };
  return runtime as unknown as Runtime;
}

function handler(config = makeConfig()) {
  const runtime = makeRuntime(config);
  return createFetchHandler(
    () => runtime,
    async () => undefined,
  );
}

function postMessages(body: Record<string, unknown>, key = KEY): Request {
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const TIER = "virtual.anthropic.global.sonnet-like";
const ANTHROPIC_OK = {
  type: "message",
  role: "assistant",
  content: [{ type: "text", text: "OK" }],
  usage: { input_tokens: 3, output_tokens: 1 },
};

/** Streaming: postJson does NOT retry transient statuses — one fetch per attempt. */
const STREAMING = { stream: true };

describe("pre-stream failover via createFetchHandler", () => {
  test("401 advances to the next KEY of the same model; auth headers prove it", async () => {
    const mock: FetchMock = installFetchMock([
      { status: 401, json: { error: { message: "bad key" } } },
      { status: 200, json: ANTHROPIC_OK },
    ]);
    try {
      const res = await handler()(
        postMessages({ model: TIER, max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
      );
      expect(res.status).toBe(200);
      expect(mock.requests).toHaveLength(2);
      // Same model/origin both times — only the key changed.
      expect(mock.requests[0]?.url).toBe("https://api.z.ai/api/anthropic/v1/messages");
      expect(mock.requests[1]?.url).toBe("https://api.z.ai/api/anthropic/v1/messages");
      expect(mock.requests[0]?.headers.authorization).toBe("Bearer primary-key");
      expect(mock.requests[1]?.headers.authorization).toBe("Bearer secondary-key");
    } finally {
      mock.restore();
    }
  });

  test("429 advances to the next CANDIDATE model (streaming: one fetch per attempt)", async () => {
    const mock = installFetchMock([
      { status: 429, json: { error: { message: "rate limited" } } },
      { status: 429, json: { error: { message: "rate limited" } } },
      { status: 200, json: ANTHROPIC_OK },
    ]);
    try {
      const res = await handler()(
        postMessages({
          model: TIER,
          max_tokens: 16,
          ...STREAMING,
          messages: [{ role: "user", content: "hi" }],
        }),
      );
      expect(res.status).toBe(200);
      // Both pool keys of candidate 1 rejected, then candidate 2 (alibaba) serves.
      expect(mock.requests.map((r) => r.url)).toEqual([
        "https://api.z.ai/api/anthropic/v1/messages",
        "https://api.z.ai/api/anthropic/v1/messages",
        "https://dashscope-intl.aliyuncs.com/apps/anthropic/v1/messages",
      ]);
      expect(mock.requests[2]?.headers["x-api-key"]).toBe("alibaba-key");
    } finally {
      mock.restore();
    }
  });

  test("connect exhaustion advances to the next attempt (key)", async () => {
    // postJson retries network errors 3x per attempt — three error specs exhaust
    // zai's primary key at the connect level; the next attempt (zai secondary)
    // succeeds on its first try.
    const mock = installFetchMock([
      { error: "connect ECONNREFUSED" },
      { error: "connect ECONNREFUSED" },
      { error: "connect ECONNREFUSED" },
      { status: 200, json: ANTHROPIC_OK },
    ]);
    try {
      const res = await handler()(
        postMessages({ model: TIER, max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
      );
      expect(res.status).toBe(200);
      expect(mock.requests).toHaveLength(4);
      expect(mock.requests[3]?.url).toBe("https://api.z.ai/api/anthropic/v1/messages");
      expect(mock.requests[3]?.headers.authorization).toBe("Bearer secondary-key");
    } finally {
      mock.restore();
    }
  });

  test("exhaustion relays the LAST upstream error unchanged", async () => {
    const mock = installFetchMock([{ status: 401, json: { error: { message: "no" } } }]);
    try {
      const res = await handler()(
        postMessages({ model: TIER, max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
      );
      expect(res.status).toBe(401);
      // Plan = zai(2 keys) + alibaba(1 key) = 3 attempts, all clamped to 401.
      expect(mock.requests).toHaveLength(3);
      const body = (await res.json()) as { error?: { message?: string } };
      expect(body.error?.message).toContain("Upstream 401");
    } finally {
      mock.restore();
    }
  });

  test("5xx does NOT fail over — relayed immediately, single fetch", async () => {
    const mock = installFetchMock([{ status: 503, json: { error: { message: "boom" } } }]);
    try {
      const res = await handler()(
        postMessages({
          model: TIER,
          max_tokens: 16,
          ...STREAMING,
          messages: [{ role: "user", content: "hi" }],
        }),
      );
      expect(res.status).toBe(503);
      expect(mock.requests).toHaveLength(1);
    } finally {
      mock.restore();
    }
  });

  test("maxFailoverAttempts truncates the plan", async () => {
    const mock = installFetchMock([{ status: 401, json: {} }]);
    try {
      const res = await handler(makeConfig(2))(
        postMessages({ model: TIER, max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
      );
      expect(res.status).toBe(401);
      expect(mock.requests).toHaveLength(2); // not 4
    } finally {
      mock.restore();
    }
  });

  test("count_tokens through a virtual tier failovers across keys", async () => {
    const mock = installFetchMock([
      { status: 401, json: {} },
      { status: 200, json: { input_tokens: 42 } },
    ]);
    try {
      const res = await handler()(
        new Request("http://localhost/v1/messages/count_tokens", {
          method: "POST",
          headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
          body: JSON.stringify({
            model: TIER,
            messages: [{ role: "user", content: "how many tokens?" }],
          }),
        }),
      );
      expect(res.status).toBe(200);
      expect(mock.requests).toHaveLength(2);
      expect(mock.requests[0]?.url).toBe("https://api.z.ai/api/anthropic/v1/messages/count_tokens");
      expect(mock.requests[1]?.headers.authorization).toBe("Bearer secondary-key");
      const body = (await res.json()) as { input_tokens?: number };
      expect(body.input_tokens).toBe(42);
    } finally {
      mock.restore();
    }
  });

  test("count_tokens with no passthrough candidate keeps the classic 400", async () => {
    // A tier whose only candidate is an openai-backend provider: no count endpoint.
    const config = validateConfig({
      server: { host: "127.0.0.1", port: 8787 },
      inboundAuth: { keys: [KEY] },
      primaryRegion: "us",
      profilePreference: "global",
      refreshIntervalMinutes: 60,
      claudeFallbackToMantle: false,
      regions: [{ key: "us", awsRegion: "us-east-1" }],
      providers: {
        mistral: {
          type: "openai",
          credential: "mistral-key",
          auth: "bearer",
          baseUrl: "https://api.mistral.ai/v1",
          countTokens: false,
          modelsUrl: "https://api.mistral.ai/v1/models",
        },
      },
      virtualModels: { "openai-only": ["mistral.openai.global.mistral-small"] },
      logging: { enabled: false },
      chatPage: { enabled: false },
    });
    const res = await handler(config)(
      new Request("http://localhost/v1/messages/count_tokens", {
        method: "POST",
        headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: "virtual.anthropic.global.openai-only",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    );
    expect(res.status).toBe(400);
  });
});
