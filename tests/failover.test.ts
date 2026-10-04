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
import { UpstreamError } from "../src/errors.ts";
import {
  COOLDOWN_JITTER_MS,
  COOLDOWN_MS,
  CredentialCooldownStore,
  isContextTooLong,
} from "../src/failover.ts";
import { Catalog } from "../src/model/catalog.ts";
import { type Runtime, createFetchHandler } from "../src/server.ts";
import { type FetchMock, installFetchMock } from "./helpers/fetch-mock.ts";

const KEY = "ccpp-failover-key";

const ZAI_POOL = [
  { credential: "primary-key", label: "primary" },
  { credential: "secondary-key", label: "secondary" },
];

function makeConfig(maxFailoverAttempts?: number, zaiAccountScoped?: boolean): ProxyConfig {
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
        ...(zaiAccountScoped ? { accountScoped: true } : {}),
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

  test("non-streaming 429: exactly ONE fetch per attempt (postJson no longer absorbs it)", async () => {
    // A 429 is the upstream's decision about the credential/account, so the
    // engine advances immediately instead of re-sending the body on the same
    // key (which would hammer the rate limiter up to 3x per pool key).
    const mock = installFetchMock([
      { status: 429, json: {} },
      { status: 429, json: {} },
      { status: 200, json: ANTHROPIC_OK },
    ]);
    try {
      const res = await handler()(
        postMessages({ model: TIER, max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
      );
      expect(res.status).toBe(200);
      // zai primary, zai secondary, alibaba — one fetch each, NOT 2 internal
      // retries on top of every attempt.
      expect(mock.requests).toHaveLength(3);
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

// ── isContextTooLong predicate ───────────────────────────────────────────────

describe("isContextTooLong", () => {
  function err400(body: string): UpstreamError {
    return new UpstreamError(400, "Upstream 400", { upstreamBody: body });
  }

  test("Alibaba/Qwen 'Range of input length' body matches", () => {
    const body =
      'event:error\ndata:{"request_id":"x","code":"InvalidParameter","message":"data: {\\"error\\":{\\"code\\":\\"invalid_parameter_error\\",\\"message\\":\\"Range of input length should be [1, 204800]\\"}}"}\n\n';
    expect(isContextTooLong(err400(body))).toBe(true);
  });

  test("OpenAI-compat context_length_exceeded code matches", () => {
    const body = JSON.stringify({
      error: { code: "context_length_exceeded", message: "too long" },
    });
    expect(isContextTooLong(err400(body))).toBe(true);
  });

  test("'prompt is too long' message matches", () => {
    expect(isContextTooLong(err400("prompt is too long for this model"))).toBe(true);
  });

  test("z.ai 1261 'Prompt too long' matches (documented wording has no 'is')", () => {
    expect(isContextTooLong(err400('{"error":{"code":"1261","message":"Prompt too long"}}'))).toBe(
      true,
    );
    expect(isContextTooLong(err400("[1261][Prompt too long][x]"))).toBe(true);
  });

  test("'too many tokens' message matches", () => {
    expect(isContextTooLong(err400("too many tokens in input"))).toBe(true);
  });

  test("'maximum context length' message matches", () => {
    expect(isContextTooLong(err400("This model's maximum context length is 128000 tokens."))).toBe(
      true,
    );
  });

  test("unrelated 400 body does not match", () => {
    expect(
      isContextTooLong(
        err400(
          '{"error":{"type":"invalid_request_error","message":"Extra inputs are not permitted"}}',
        ),
      ),
    ).toBe(false);
  });

  test("non-400 status returns false even with matching body", () => {
    const e = new UpstreamError(429, "Upstream 429", { upstreamBody: "context_length_exceeded" });
    expect(isContextTooLong(e)).toBe(false);
  });
});

// ── context-too-long failover (end-to-end via createFetchHandler) ────────────

describe("context-too-long failover", () => {
  const CONTEXT_TOO_LONG_BODY =
    'event:error\ndata:{"code":"InvalidParameter","message":"Range of input length should be [1, 204800]"}\n\n';

  test("400 context-too-long advances to the next candidate model", async () => {
    const mock = installFetchMock([
      { status: 400, text: CONTEXT_TOO_LONG_BODY },
      { status: 400, text: CONTEXT_TOO_LONG_BODY }, // exhausts both zai keys
      { status: 200, json: ANTHROPIC_OK },
    ]);
    try {
      const res = await handler()(
        postMessages({ model: TIER, max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
      );
      expect(res.status).toBe(200);
      // zai primary, zai secondary (both 400), then alibaba succeeds
      expect(mock.requests.map((r) => r.url)).toEqual([
        "https://api.z.ai/api/anthropic/v1/messages",
        "https://api.z.ai/api/anthropic/v1/messages",
        "https://dashscope-intl.aliyuncs.com/apps/anthropic/v1/messages",
      ]);
    } finally {
      mock.restore();
    }
  });

  test("400 context-too-long on streaming request also advances", async () => {
    const mock = installFetchMock([
      { status: 400, text: CONTEXT_TOO_LONG_BODY },
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
      expect(mock.requests).toHaveLength(2);
      expect(mock.requests[0]?.url).toBe("https://api.z.ai/api/anthropic/v1/messages");
      expect(mock.requests[1]?.url).toBe("https://api.z.ai/api/anthropic/v1/messages");
      expect(mock.requests[1]?.headers.authorization).toBe("Bearer secondary-key");
    } finally {
      mock.restore();
    }
  });

  test("z.ai 1261 'Prompt too long' 400 advances to the next candidate", async () => {
    const ZAI_1261 = {
      status: 400,
      json: {
        type: "error",
        error: {
          type: "invalid_request_error",
          code: "1261",
          message: "[1261][Prompt too long][x]",
        },
      },
    };
    const mock = installFetchMock([ZAI_1261, ZAI_1261, { status: 200, json: ANTHROPIC_OK }]);
    try {
      const res = await handler()(
        postMessages({ model: TIER, max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
      );
      expect(res.status).toBe(200);
      // Both zai keys reject with the documented context-length wording, then
      // the alibaba candidate (larger window) serves.
      expect(mock.requests.map((r) => r.url)).toEqual([
        "https://api.z.ai/api/anthropic/v1/messages",
        "https://api.z.ai/api/anthropic/v1/messages",
        "https://dashscope-intl.aliyuncs.com/apps/anthropic/v1/messages",
      ]);
    } finally {
      mock.restore();
    }
  });

  test("plain (non-context) 400 does NOT advance — relayed immediately", async () => {
    const mock = installFetchMock([
      {
        status: 400,
        json: {
          type: "error",
          error: { type: "invalid_request_error", message: "Extra inputs are not permitted" },
        },
      },
    ]);
    try {
      const res = await handler()(
        postMessages({ model: TIER, max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
      );
      expect(res.status).toBe(400);
      expect(mock.requests).toHaveLength(1); // no failover
    } finally {
      mock.restore();
    }
  });

  test("context-too-long exhaustion relays the last 400", async () => {
    const mock = installFetchMock([{ status: 400, text: CONTEXT_TOO_LONG_BODY }]);
    try {
      const res = await handler()(
        postMessages({ model: TIER, max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
      );
      expect(res.status).toBe(400);
      expect(mock.requests).toHaveLength(3); // zai(2 keys) + alibaba(1 key)
    } finally {
      mock.restore();
    }
  });
});

describe("cross-request 429 cooldown (CredentialCooldownStore)", () => {
  function poolHandlerWithStore(store: CredentialCooldownStore) {
    const runtime = {
      ...makeRuntime(makeConfig()),
      cooldownStore: store,
    } as unknown as Runtime;
    return createFetchHandler(
      () => runtime,
      async () => undefined,
    );
  }

  test("a 429 marks the key; the NEXT request goes straight to the secondary", async () => {
    const store = new CredentialCooldownStore();
    // Request 1 (STREAMING so postJson does not absorb the 429 internally):
    // primary 429s -> marked -> secondary serves.
    let mock = installFetchMock([
      { status: 429, json: {} },
      { status: 200, json: ANTHROPIC_OK },
    ]);
    try {
      const res = await poolHandlerWithStore(store)(
        postMessages({
          model: TIER,
          max_tokens: 16,
          ...STREAMING,
          messages: [{ role: "user", content: "hi" }],
        }),
      );
      expect(res.status).toBe(200);
      expect(mock.requests).toHaveLength(2);
      expect(mock.requests[1]?.headers.authorization).toBe("Bearer secondary-key");
    } finally {
      mock.restore();
    }
    expect(store.isDegraded("zai", "primary")).toBe(true);

    // Request 2: primary is skipped ENTIRELY — one fetch, secondary key.
    mock = installFetchMock([{ status: 200, json: ANTHROPIC_OK }]);
    try {
      const res = await poolHandlerWithStore(store)(
        postMessages({
          model: TIER,
          max_tokens: 16,
          ...STREAMING,
          messages: [{ role: "user", content: "hi" }],
        }),
      );
      expect(res.status).toBe(200);
      expect(mock.requests).toHaveLength(1);
      expect(mock.requests[0]?.headers.authorization).toBe("Bearer secondary-key");
    } finally {
      mock.restore();
    }
    store.clear();
  });

  test("clear() reinstates cooled keys (models the TTL expiry)", async () => {
    const store = new CredentialCooldownStore();
    store.mark("zai", "primary");
    expect(store.isDegraded("zai", "primary")).toBe(true);
    store.clear();
    expect(store.isDegraded("zai", "primary")).toBe(false);

    const mock = installFetchMock([{ status: 200, json: ANTHROPIC_OK }]);
    try {
      const res = await poolHandlerWithStore(store)(
        postMessages({ model: TIER, max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
      );
      expect(res.status).toBe(200);
      // Primary is back at attempt 1.
      expect(mock.requests[0]?.headers.authorization).toBe("Bearer primary-key");
    } finally {
      mock.restore();
    }
  });

  test("a 401 does NOT start a cooldown (only 429 does)", async () => {
    const store = new CredentialCooldownStore();
    const mock = installFetchMock([
      { status: 401, json: {} },
      { status: 200, json: ANTHROPIC_OK },
    ]);
    try {
      const res = await poolHandlerWithStore(store)(
        postMessages({ model: TIER, max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
      );
      expect(res.status).toBe(200);
      expect(store.isDegraded("zai", "primary")).toBe(false);
    } finally {
      mock.restore();
    }
  });

  test("all keys of candidate 1 in cooldown -> its whole provider is skipped", async () => {
    const store = new CredentialCooldownStore();
    store.mark("zai", "primary");
    store.mark("zai", "secondary");
    // zai fully cooled; the tier's next candidate (alibaba) serves on attempt 1.
    const mock = installFetchMock([{ status: 200, json: ANTHROPIC_OK }]);
    try {
      const res = await poolHandlerWithStore(store)(
        postMessages({ model: TIER, max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
      );
      expect(res.status).toBe(200);
      expect(mock.requests).toHaveLength(1);
      expect(mock.requests[0]?.url).toContain("dashscope-intl.aliyuncs.com");
      expect(mock.requests[0]?.headers["x-api-key"]).toBe("alibaba-key");
    } finally {
      mock.restore();
    }
    store.clear();
  });

  test("a DIRECT model id whose provider is fully cooled gets a retryable 429 + Retry-After", async () => {
    const store = new CredentialCooldownStore();
    // Deterministic jitter (rng=0 → COOLDOWN_MS − jitter) so the expected
    // Retry-After window is exact.
    store.mark("zai", "primary", undefined, () => 0);
    store.mark("zai", "secondary", undefined, () => 0);
    const mock = installFetchMock([{ status: 200, json: ANTHROPIC_OK }]);
    try {
      const res = await poolHandlerWithStore(store)(
        postMessages({
          model: "zai.anthropic.global.glm-5.3",
          max_tokens: 16,
          messages: [{ role: "user", content: "hi" }],
        }),
      );
      // A cooldown is a RATE LIMIT, never a 404: clients retry 429s with
      // backoff but treat 404 as fatal (live lesson 2026-10-03/04).
      expect(res.status).toBe(429);
      expect(mock.requests).toHaveLength(0);
      const body = (await res.json()) as { error?: { type?: string; message?: string } };
      expect(body.error?.type).toBe("rate_limit_error");
      expect(body.error?.message).toContain("cooldown");
      expect(body.error?.message).toContain("zai");
      const retryAfter = Number(res.headers.get("retry-after"));
      const expected = Math.ceil((COOLDOWN_MS - COOLDOWN_JITTER_MS) / 1000);
      expect(retryAfter).toBeGreaterThanOrEqual(expected - 2);
      expect(retryAfter).toBeLessThanOrEqual(expected);
    } finally {
      mock.restore();
    }
    store.clear();
  });

  test("a fully-cooled TIER answers 429 naming every cooled provider (the 2026-10-04 incident shape)", async () => {
    const store = new CredentialCooldownStore();
    store.mark("zai", "primary", undefined, () => 0); // ~255s — the earliest
    store.mark("zai", "secondary", undefined, () => 0.5); // ~300s
    store.mark("alibaba", "default", undefined, () => 1); // ~345s
    const mock = installFetchMock([{ status: 200, json: ANTHROPIC_OK }]);
    try {
      const res = await poolHandlerWithStore(store)(
        postMessages({ model: TIER, max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
      );
      expect(res.status).toBe(429);
      expect(mock.requests).toHaveLength(0); // nothing burned on known-benched keys
      const body = (await res.json()) as { error?: { type?: string; message?: string } };
      expect(body.error?.type).toBe("rate_limit_error");
      expect(body.error?.message).toContain("zai");
      expect(body.error?.message).toContain("alibaba");
      // Retry-After reflects the EARLIEST reinstatement (zai primary, ~255s).
      const retryAfter = Number(res.headers.get("retry-after"));
      expect(retryAfter).toBeGreaterThanOrEqual(253);
      expect(retryAfter).toBeLessThanOrEqual(255);
    } finally {
      mock.restore();
    }
    store.clear();
  });

  test("without a store, behavior is unchanged (every request retries primary first)", async () => {
    const runtime = makeRuntime(makeConfig()) as unknown as Runtime;
    const handle = createFetchHandler(
      () => runtime,
      async () => undefined,
    );
    for (const _ of [1, 2]) {
      const mock = installFetchMock([
        { status: 429, json: {} },
        { status: 200, json: ANTHROPIC_OK },
      ]);
      try {
        const res = await handle(
          postMessages({
            model: TIER,
            max_tokens: 16,
            messages: [{ role: "user", content: "hi" }],
          }),
        );
        expect(res.status).toBe(200);
        expect(mock.requests).toHaveLength(2); // primary retried both times
        expect(mock.requests[0]?.headers.authorization).toBe("Bearer primary-key");
      } finally {
        mock.restore();
      }
    }
  });
});

describe("request-completed log enrichment (serving info)", () => {
  /** Capture console lines emitted during fn(); restores the original. */
  async function captureLogs(fn: () => Promise<unknown>): Promise<string[]> {
    const lines: string[] = [];
    const orig = console.log;
    const origWarn = console.warn;
    const origErr = console.error;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    console.warn = console.log as unknown as typeof console.warn;
    console.error = console.log as unknown as typeof console.error;
    try {
      await fn();
    } finally {
      console.log = orig;
      console.warn = origWarn;
      console.error = origErr;
    }
    return lines;
  }

  test("completed line shows requested (virtual), served (real canonical), and key", async () => {
    const mock = installFetchMock([{ status: 200, json: ANTHROPIC_OK }]);
    try {
      const lines = await captureLogs(async () => {
        const res = await handler()(
          postMessages({
            model: TIER,
            max_tokens: 16,
            messages: [{ role: "user", content: "hi" }],
          }),
        );
        expect(res.status).toBe(200);
      });
      const completed = lines.find((l) => l.includes("request completed"));
      expect(completed).toBeDefined();
      expect(completed).toContain("requested=virtual.anthropic.global.sonnet-like");
      expect(completed).toContain("served=zai.anthropic.global.glm-5.3");
      expect(completed).toContain("key=zai/primary");
      // No failover: no attempts field.
      expect(completed?.includes("attempts=")).toBe(false);
    } finally {
      mock.restore();
    }
  });

  test("after failover the completed line names the serving key and attempt count", async () => {
    const store = new CredentialCooldownStore();
    const runtime = { ...makeRuntime(makeConfig()), cooldownStore: store } as unknown as Runtime;
    const handle = createFetchHandler(
      () => runtime,
      async () => undefined,
    );
    const mock = installFetchMock([
      { status: 429, json: {} },
      { status: 200, json: ANTHROPIC_OK },
    ]);
    try {
      const lines = await captureLogs(async () => {
        const res = await handle(
          postMessages({
            model: TIER,
            max_tokens: 16,
            ...STREAMING,
            messages: [{ role: "user", content: "hi" }],
          }),
        );
        expect(res.status).toBe(200);
      });
      const completed = lines.find((l) => l.includes("request completed"));
      expect(completed).toContain("served=zai.anthropic.global.glm-5.3");
      expect(completed).toContain("key=zai/secondary");
      expect(completed).toContain("attempts=2");
      // The advancing warn line carries the requestId for correlation.
      const advancing = lines.find((l) => l.includes("failover attempt failed"));
      expect(advancing).toContain("requestId=");
      expect(advancing).toContain("key=zai/primary");
    } finally {
      mock.restore();
      store.clear();
    }
  });

  test("a non-inference request (health probe) has no serving fields", async () => {
    const lines = await captureLogs(async () => {
      const res = await handler()(new Request("http://localhost/api/hello", { method: "HEAD" }));
      expect(res.status).toBe(204);
    });
    const completed = lines.find((l) => l.includes("request completed"));
    expect(completed).toBeDefined();
    expect(completed?.includes("served=")).toBe(false);
    expect(completed?.includes("key=")).toBe(false);
  });
});

describe("z.ai 1210 conversion-bug failover", () => {
  const ZAI_1210 = {
    status: 400,
    json: {
      type: "error",
      error: {
        type: "invalid_request_error",
        code: "1210",
        message: "[1210][Invalid API parameter, please check the documentation.][x]",
      },
    },
  };

  test("a 400 code-1210 advances (next key, then next candidate)", async () => {
    const mock = installFetchMock([ZAI_1210, ZAI_1210, { status: 200, json: ANTHROPIC_OK }]);
    try {
      const res = await handler()(
        postMessages({ model: TIER, max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
      );
      expect(res.status).toBe(200);
      // Both zai keys rejected -> the alibaba candidate serves.
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

  test("a 400 code-1210 does NOT start a cooldown (shape-specific, not quota)", async () => {
    const store = new CredentialCooldownStore();
    const runtime = { ...makeRuntime(makeConfig()), cooldownStore: store } as unknown as Runtime;
    const handle = createFetchHandler(
      () => runtime,
      async () => undefined,
    );
    const mock = installFetchMock([ZAI_1210, { status: 200, json: ANTHROPIC_OK }]);
    try {
      const res = await handle(
        postMessages({ model: TIER, max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
      );
      expect(res.status).toBe(200);
      expect(store.isDegraded("zai", "primary")).toBe(false);
    } finally {
      mock.restore();
      store.clear();
    }
  });

  test("an unrelated 400 (no code) still relays immediately", async () => {
    const mock = installFetchMock([
      {
        status: 400,
        json: { type: "error", error: { type: "invalid_request_error", message: "bad body" } },
      },
    ]);
    try {
      const res = await handler()(
        postMessages({ model: TIER, max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
      );
      expect(res.status).toBe(400);
      expect(mock.requests).toHaveLength(1);
    } finally {
      mock.restore();
    }
  });

  test("request-error lines carry the serving key + requested model", async () => {
    const mock = installFetchMock([ZAI_1210, ZAI_1210, ZAI_1210]);
    const lines: string[] = [];
    const orig = console.log;
    const origWarn = console.warn;
    const origErr = console.error;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    console.warn = console.log as unknown as typeof console.warn;
    console.error = console.log as unknown as typeof console.error;
    try {
      const res = await handler()(
        postMessages({ model: TIER, max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
      );
      expect(res.status).toBe(400); // all three attempts 1210 -> last relayed
    } finally {
      console.log = orig;
      console.warn = origWarn;
      console.error = origErr;
      mock.restore();
    }
    const errLine = lines.find((l) => l.includes("request error"));
    expect(errLine).toContain("requested=virtual.anthropic.global.sonnet-like");
    expect(errLine).toContain("key=alibaba/default"); // the LAST failing attempt's key
  });
});

describe("quota-reset-aware cooldown (z.ai 1310)", () => {
  // The reset stamp is computed relative to now (3 days out) so the fixture
  // never rots: a hardcoded date eventually falls inside the 24h cooldown
  // clamp and flips the expected expiry from now+24h to the stamp itself.
  // Seconds-precision (the z.ai stamp has no ms) so the parsed epoch is exact.
  const resetAt = new Date((Math.floor(Date.now() / 1000) + 3 * 24 * 60 * 60) * 1000);
  const stamp = resetAt.toISOString().slice(0, 19).replace("T", " "); // z.ai format
  const ZAI_429_RESET = {
    status: 429,
    json: {
      type: "error",
      error: {
        type: "rate_limit_error",
        code: "1310",
        message: `[1310][Weekly/Monthly Limit Exhausted. Your limit will reset at ${stamp}][x]`,
      },
    },
  };

  test("parseQuotaResetAt extracts the UTC stamp as epoch ms", async () => {
    const { parseQuotaResetAt } = await import("../src/failover.ts");
    const body = ZAI_429_RESET.json.error?.message ?? "";
    const parsed = parseQuotaResetAt(body);
    expect(parsed).toBe(Date.parse(resetAt.toISOString()));
    expect(parseQuotaResetAt("[429] slow down")).toBeUndefined();
    expect(parseQuotaResetAt("reset at not-a-date")).toBeUndefined();
  });

  test("a 429 with a reset-at stamp cools the key until (clamped) reset time", async () => {
    const store = new CredentialCooldownStore();
    const runtime = { ...makeRuntime(makeConfig()), cooldownStore: store } as unknown as Runtime;
    const handle = createFetchHandler(
      () => runtime,
      async () => undefined,
    );
    const mock = installFetchMock([ZAI_429_RESET, { status: 200, json: ANTHROPIC_OK }]);
    try {
      const res = await handle(
        postMessages({
          model: TIER,
          max_tokens: 16,
          ...STREAMING,
          messages: [{ role: "user", content: "hi" }],
        }),
      );
      expect(res.status).toBe(200); // failover to secondary served it
    } finally {
      mock.restore();
    }
    expect(store.isDegraded("zai", "primary")).toBe(true);
    // Reset is 2026-09-13 — far beyond the 24h clamp: expiry = now + 24h.
    const until = store.degradedUntil("zai", "primary");
    expect(until).toBeDefined();
    const in24h = Date.now() + 24 * 60 * 60 * 1000;
    expect(until ?? 0).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);
    expect(until ?? 0).toBeLessThanOrEqual(in24h + 5);
    store.clear();
  });

  test("a plain 429 (no stamp) keeps the 5-minute default", async () => {
    const store = new CredentialCooldownStore();
    const runtime = { ...makeRuntime(makeConfig()), cooldownStore: store } as unknown as Runtime;
    const handle = createFetchHandler(
      () => runtime,
      async () => undefined,
    );
    const mock = installFetchMock([
      { status: 429, json: { error: { message: "rate limited" } } },
      { status: 200, json: ANTHROPIC_OK },
    ]);
    try {
      const res = await handle(
        postMessages({
          model: TIER,
          max_tokens: 16,
          ...STREAMING,
          messages: [{ role: "user", content: "hi" }],
        }),
      );
      expect(res.status).toBe(200);
    } finally {
      mock.restore();
    }
    const until = store.degradedUntil("zai", "primary");
    expect(until).toBeDefined();
    // Blind cooldown is jittered ±45s (herd desynchronization).
    expect(until ?? 0).toBeGreaterThan(Date.now() + COOLDOWN_MS - COOLDOWN_JITTER_MS);
    expect(until ?? 0).toBeLessThanOrEqual(Date.now() + COOLDOWN_MS + COOLDOWN_JITTER_MS + 10);
    store.clear();
  });
});

// ── cooldown jitter + earliest reinstatement ─────────────────────────────────

describe("cooldown jitter (herd desynchronization)", () => {
  test("rng extremes pin the blind cooldown to ±COOLDOWN_JITTER_MS", () => {
    const store = new CredentialCooldownStore();
    store.mark("p", "lo", undefined, () => 0);
    store.mark("p", "hi", undefined, () => 1);
    const now = Date.now();
    const lo = store.degradedUntil("p", "lo") ?? 0;
    const hi = store.degradedUntil("p", "hi") ?? 0;
    expect(lo).toBeGreaterThanOrEqual(now + COOLDOWN_MS - COOLDOWN_JITTER_MS - 5);
    expect(lo).toBeLessThanOrEqual(now + COOLDOWN_MS - COOLDOWN_JITTER_MS + 5);
    expect(hi).toBeGreaterThanOrEqual(now + COOLDOWN_MS + COOLDOWN_JITTER_MS - 5);
    expect(hi).toBeLessThanOrEqual(now + COOLDOWN_MS + COOLDOWN_JITTER_MS + 5);
    store.clear();
  });

  test("default rng stays inside the jitter bounds", () => {
    const store = new CredentialCooldownStore();
    store.mark("p", "k");
    const until = store.degradedUntil("p", "k") ?? 0;
    const now = Date.now();
    expect(until).toBeGreaterThanOrEqual(now + COOLDOWN_MS - COOLDOWN_JITTER_MS);
    expect(until).toBeLessThanOrEqual(now + COOLDOWN_MS + COOLDOWN_JITTER_MS);
    store.clear();
  });

  test("a parsed quota-reset stamp stays EXACT (jitter not applied)", () => {
    const store = new CredentialCooldownStore();
    const resetAt = Date.now() + 60 * 60 * 1000; // 1h out (inside the 24h clamp)
    store.mark("p", "k", resetAt, () => 1); // rng=1 would add +45s if misapplied
    const until = store.degradedUntil("p", "k") ?? 0;
    expect(until).toBeGreaterThanOrEqual(resetAt + 60_000 - 10);
    expect(until).toBeLessThanOrEqual(resetAt + 60_000 + 10);
    store.clear();
  });

  test("earliestReinstatementMs = min over the named providers' keys; unknown → undefined", () => {
    const store = new CredentialCooldownStore();
    store.mark("a", "1", undefined, () => 0); // ~255s — earliest
    store.mark("a", "2", undefined, () => 1); // ~345s
    store.mark("b", "1", undefined, () => 0.5); // ~300s
    const ms = store.earliestReinstatementMs(["a", "b"]);
    expect(ms).toBeDefined();
    expect(ms ?? 0).toBeGreaterThanOrEqual(COOLDOWN_MS - COOLDOWN_JITTER_MS - 2000);
    expect(ms ?? 0).toBeLessThanOrEqual(COOLDOWN_MS - COOLDOWN_JITTER_MS + 2000);
    expect(store.earliestReinstatementMs(["nonexistent"])).toBeUndefined();
    store.clear();
  });
});

// ── account-scoped 429 (provider accountScoped: true) ────────────────────────

describe("account-scoped 429 cooldown (provider accountScoped)", () => {
  const resetAt = new Date((Math.floor(Date.now() / 1000) + 3 * 24 * 60 * 60) * 1000);
  const stamp = resetAt.toISOString().slice(0, 19).replace("T", " ");
  const ZAI_1310 = {
    status: 429,
    json: {
      type: "error",
      error: {
        type: "rate_limit_error",
        code: "1310",
        message: `[1310][Weekly/Monthly Limit Exhausted. Your limit will reset at ${stamp}][x]`,
      },
    },
  };
  const ZAI_1313 = {
    status: 429,
    json: {
      type: "error",
      error: {
        type: "rate_limit_error",
        code: "1313",
        message:
          "[1313][Your account's usage pattern does not comply with the Fair Usage Policy][x]",
      },
    },
  };

  function scopedHandler(store: CredentialCooldownStore, accountScoped: boolean) {
    const runtime = {
      ...makeRuntime(makeConfig(undefined, accountScoped)),
      cooldownStore: store,
    } as unknown as Runtime;
    return createFetchHandler(
      () => runtime,
      async () => undefined,
    );
  }

  test("a stamped quota 429 benches the WHOLE pool, not just the failing key", async () => {
    const store = new CredentialCooldownStore();
    const handle = scopedHandler(store, true);
    // Request 1: primary 429s with a stamped body -> every zai key is marked
    // at once. The plan was built upfront, so the secondary attempt still runs
    // (and 429s again — same account); the alibaba candidate serves.
    let mock = installFetchMock([ZAI_1310, ZAI_1310, { status: 200, json: ANTHROPIC_OK }]);
    try {
      const res = await handle(
        postMessages({
          model: TIER,
          max_tokens: 16,
          ...STREAMING,
          messages: [{ role: "user", content: "hi" }],
        }),
      );
      expect(res.status).toBe(200);
      expect(mock.requests).toHaveLength(3);
    } finally {
      mock.restore();
    }
    expect(store.isDegraded("zai", "primary")).toBe(true);
    expect(store.isDegraded("zai", "secondary")).toBe(true);

    // Request 2: zai entirely benched — straight to alibaba, zero zai fetches.
    mock = installFetchMock([{ status: 200, json: ANTHROPIC_OK }]);
    try {
      const res = await handle(
        postMessages({
          model: TIER,
          max_tokens: 16,
          ...STREAMING,
          messages: [{ role: "user", content: "hi" }],
        }),
      );
      expect(res.status).toBe(200);
      expect(mock.requests).toHaveLength(1);
      expect(mock.requests[0]?.headers["x-api-key"]).toBe("alibaba-key");
    } finally {
      mock.restore();
    }
    store.clear();
  });

  test("Fair-Usage 1313 (no reset stamp) also benches the whole pool", async () => {
    const store = new CredentialCooldownStore();
    const handle = scopedHandler(store, true);
    const mock = installFetchMock([ZAI_1313, ZAI_1313, { status: 200, json: ANTHROPIC_OK }]);
    try {
      const res = await handle(
        postMessages({
          model: TIER,
          max_tokens: 16,
          ...STREAMING,
          messages: [{ role: "user", content: "hi" }],
        }),
      );
      expect(res.status).toBe(200);
    } finally {
      mock.restore();
    }
    expect(store.isDegraded("zai", "primary")).toBe(true);
    expect(store.isDegraded("zai", "secondary")).toBe(true);
    store.clear();
  });

  test("WITHOUT the flag, a stamped 429 benches only the offending key", async () => {
    const store = new CredentialCooldownStore();
    const handle = scopedHandler(store, false);
    const mock = installFetchMock([ZAI_1310, { status: 200, json: ANTHROPIC_OK }]);
    try {
      const res = await handle(
        postMessages({
          model: TIER,
          max_tokens: 16,
          ...STREAMING,
          messages: [{ role: "user", content: "hi" }],
        }),
      );
      expect(res.status).toBe(200); // the secondary key still serves
    } finally {
      mock.restore();
    }
    expect(store.isDegraded("zai", "primary")).toBe(true);
    expect(store.isDegraded("zai", "secondary")).toBe(false);
    store.clear();
  });
});
