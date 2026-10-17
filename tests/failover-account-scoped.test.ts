/**
 * Account-scoped 429 short-circuit — hermetic, via createFetchHandler with
 * sequenced fetch mocks (the only mocked boundary). Exercises the REAL engine
 * (src/failover.ts).
 *
 * When a provider opts into `accountScoped` and a 429 body proves an
 * ACCOUNT-level block (stamped quota exhaustion / Fair-Usage 1313), the WHOLE
 * pool is benched at once. The in-flight attempt plan was built BEFORE the loop
 * (one attempt per pool key), so without a short-circuit the request would still
 * send one 429-triggering upstream call per remaining key — exactly the cascade
 * the flag exists to prevent. These tests pin the short-circuit: at most ONE
 * upstream request per benched provider, then advance to the next provider.
 */
import { describe, expect, test } from "bun:test";
import { type ProxyConfig, validateConfig } from "../src/config.ts";
import { CredentialCooldownStore } from "../src/failover.ts";
import { Catalog } from "../src/model/catalog.ts";
import { type Runtime, createFetchHandler } from "../src/server.ts";
import { installFetchMock } from "./helpers/fetch-mock.ts";

const KEY = "ccpp-account-scoped-key";

const ZAI_POOL = [
  { credential: "k1", label: "k1" },
  { credential: "k2", label: "k2" },
  { credential: "k3", label: "k3" },
];

/** z.ai Fair-Usage 1313: an ACCOUNT-level block with no reset stamp. */
const ZAI_1313 = {
  status: 429,
  json: {
    type: "error",
    error: {
      type: "rate_limit_error",
      code: "1313",
      message: "[1313][Your account's usage pattern does not comply with the Fair Usage Policy][x]",
    },
  },
};

const ANTHROPIC_OK = {
  type: "message",
  role: "assistant",
  content: [{ type: "text", text: "OK" }],
  usage: { input_tokens: 3, output_tokens: 1 },
};

const STREAMING = { stream: true };
const TIER = "virtual.anthropic.global.sonnet-like";

function makeConfig(opts: {
  accountScoped: boolean;
  /** False = the tier has ONLY the multi-key zai candidate. */
  withAlibaba: boolean;
}): ProxyConfig {
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
        ...(opts.accountScoped ? { accountScoped: true } : {}),
        auth: "bearer",
        baseUrl: "https://api.z.ai/api/anthropic",
        countTokens: true,
        modelsUrl: "https://api.z.ai/api/paas/v4/models",
      },
      ...(opts.withAlibaba
        ? {
            alibaba: {
              type: "anthropic",
              credential: "alibaba-key",
              auth: "x-api-key",
              baseUrl: "https://dashscope-intl.aliyuncs.com/apps/anthropic",
              countTokens: true,
              modelsUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models",
            },
          }
        : {}),
    },
    virtualModels: {
      "sonnet-like": [
        "zai.anthropic.global.glm-5.3",
        ...(opts.withAlibaba ? ["alibaba.anthropic.global.qwen3-max"] : []),
      ],
    },
    logging: { enabled: false },
    chatPage: { enabled: false },
  });
}

function handlerWithStore(config: ProxyConfig, store: CredentialCooldownStore) {
  const runtime = {
    config,
    tokenProvider: null,
    catalogManager: { current: () => new Catalog([]), stop: () => {} },
    logStore: { isEnabled: () => false, captureActive: () => false },
    cooldownStore: store,
  } as unknown as Runtime;
  return createFetchHandler(
    () => runtime,
    async () => undefined,
  );
}

function postMessages(body: Record<string, unknown>): Request {
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("account-scoped 429 short-circuits the in-flight plan", () => {
  test("one account-scoped 429 => exactly ONE request per provider, not one per key", async () => {
    const store = new CredentialCooldownStore();
    const handle = handlerWithStore(makeConfig({ accountScoped: true, withAlibaba: true }), store);
    // The mock returns spec[0] (the 429) then spec[1] (200) for the remainder.
    // Fixed: zai k1 429s (account benched) -> k2/k3 skipped -> alibaba takes the
    // 200. Buggy: zai k1 429s, then zai k2 consumes the 200 and serves — two zai
    // requests and alibaba never reached. Counting requests BY PROVIDER is the
    // discriminator (queue position is not fixed across the two behaviors).
    const mock = installFetchMock([ZAI_1313, { status: 200, json: ANTHROPIC_OK }]);
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
      const zaiRequests = mock.requests.filter((r) => r.url.includes("api.z.ai"));
      const alibabaRequests = mock.requests.filter((r) => r.url.includes("dashscope-intl"));
      // Exactly ONE zai request (the account only needs to tell us once)...
      expect(zaiRequests).toHaveLength(1);
      // ...and the next PROVIDER serves (not the next zai key).
      expect(alibabaRequests).toHaveLength(1);
      expect(alibabaRequests[0]?.headers["x-api-key"]).toBe("alibaba-key");
    } finally {
      mock.restore();
    }
    // The whole pool was benched (so SUBSEQUENT requests also skip zai).
    expect(store.isDegraded("zai", "k1")).toBe(true);
    expect(store.isDegraded("zai", "k2")).toBe(true);
    expect(store.isDegraded("zai", "k3")).toBe(true);
    store.clear();
  });

  test("when the benched provider is the only candidate, one request then the 429 is rethrown", async () => {
    const store = new CredentialCooldownStore();
    const handle = handlerWithStore(makeConfig({ accountScoped: true, withAlibaba: false }), store);
    const mock = installFetchMock([ZAI_1313]);
    try {
      const res = await handle(
        postMessages({
          model: TIER,
          max_tokens: 16,
          ...STREAMING,
          messages: [{ role: "user", content: "hi" }],
        }),
      );
      // No provider left to advance to: the last (only) error is relayed.
      expect(res.status).toBe(429);
      expect(mock.requests).toHaveLength(1); // no cascade across k2/k3
    } finally {
      mock.restore();
    }
    store.clear();
  });

  test("WITHOUT accountScoped the per-key cascade is unchanged (k1 then k2 then serve)", async () => {
    const store = new CredentialCooldownStore();
    const handle = handlerWithStore(makeConfig({ accountScoped: false, withAlibaba: true }), store);
    // Not account-scoped: a 429 benches only the offending key, so the engine
    // advances to the next KEY (k2) — the short-circuit must not apply here.
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
      // k1 429s, k2 429s (one key at a time), then k3 serves — NOT a jump to
      // alibaba, proving the per-key path is untouched.
      expect(mock.requests.map((r) => r.url)).toEqual([
        "https://api.z.ai/api/anthropic/v1/messages",
        "https://api.z.ai/api/anthropic/v1/messages",
        "https://api.z.ai/api/anthropic/v1/messages",
      ]);
      expect(mock.requests[0]?.headers.authorization).toBe("Bearer k1");
      expect(mock.requests[1]?.headers.authorization).toBe("Bearer k2");
      expect(mock.requests[2]?.headers.authorization).toBe("Bearer k3");
    } finally {
      mock.restore();
    }
    expect(store.isDegraded("zai", "k1")).toBe(true);
    expect(store.isDegraded("zai", "k2")).toBe(true);
    expect(store.isDegraded("zai", "k3")).toBe(false); // served, so not benched
    store.clear();
  });
});
