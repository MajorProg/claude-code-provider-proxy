/**
 * Alibaba / Qwen (DashScope Model Studio) provider tests.
 *
 * Uses the legacy shared international endpoint (single flat baseUrl, native
 * Anthropic passthrough, x-api-key) — the simplest working form. The per-
 * workspace regional domains are an optional future optimization.
 *
 * Unit (no network): router yields a native-Anthropic passthrough target and
 * the header builder emits x-api-key.
 *
 * Live (gated on DASHSCOPE_API_KEY_INTL): non-streaming + streaming /v1/messages
 * and count_tokens round-trips against dashscope-intl.aliyuncs.com. No mocks.
 */
import { describe, expect, test } from "bun:test";
import { type ProxyConfig, validateConfig } from "../src/config.ts";
import { buildAnthropicHeaders } from "../src/http/upstream.ts";
import { parseCanonicalId } from "../src/model/canonical-id.ts";
import { Catalog } from "../src/model/catalog.ts";
import { route } from "../src/router.ts";
import { liveEnabled } from "./helpers/live.ts";

const BASE = "https://dashscope-intl.aliyuncs.com/apps/anthropic";

const CONFIG: ProxyConfig = validateConfig({
  server: { host: "127.0.0.1", port: 8787 },
  inboundAuth: { keys: ["test"] },
  primaryRegion: "us",
  profilePreference: "global",
  refreshIntervalMinutes: 60,
  claudeFallbackToMantle: false,
  regions: [{ key: "us", awsRegion: "us-east-1" }],
  providers: {
    bedrock: {
      credential: "unused",
      hosts: {
        converse: "bedrock-runtime.{region}.amazonaws.com",
        mantle: "bedrock-mantle.{region}.api.aws",
        control: "bedrock.{region}.amazonaws.com",
      },
    },
    alibaba: {
      type: "anthropic",
      credential: "test-dashscope-key",
      auth: "x-api-key",
      baseUrl: BASE,
      countTokens: true,
      modelsUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models",
    },
  },
});

const DASHSCOPE_KEY = process.env.DASHSCOPE_API_KEY_INTL;
const HDR = { get: () => null };
const LIVE_MODEL = "qwen3-max";

describe("Alibaba routing (unit)", () => {
  test("native-Anthropic passthrough target from baseUrl", () => {
    const id = parseCanonicalId("alibaba.anthropic.global.qwen3-max");
    const t = route(CONFIG, new Catalog([]), id);
    expect(t.provider).toBe("alibaba");
    expect(t.backend).toBe("anthropic");
    expect(t.translationPath).toBe("passthrough");
    expect(t.isAnthropic).toBe(true);
    expect(t.path).toBe(`${BASE}/v1/messages`);
    expect(t.countTokensPath).toBe(`${BASE}/v1/messages/count_tokens`);
    expect(t.invocationId).toBe("qwen3-max");
  });

  test("buildAnthropicHeaders emits x-api-key", () => {
    const h = buildAnthropicHeaders(HDR, "test-dashscope-key", "x-api-key");
    expect(h["x-api-key"]).toBe("test-dashscope-key");
    expect(h.authorization).toBeUndefined();
  });
});

describe.if(liveEnabled() && !!DASHSCOPE_KEY)("Alibaba live (dashscope-intl)", () => {
  const headers = {
    "content-type": "application/json",
    "x-api-key": DASHSCOPE_KEY as string,
    "anthropic-version": "2023-06-01",
  };

  test("non-streaming /v1/messages returns a well-formed Anthropic message", async () => {
    const res = await fetch(`${BASE}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: LIVE_MODEL,
        max_tokens: 64,
        messages: [{ role: "user", content: "Reply with exactly one word: OK" }],
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      type?: string;
      content?: unknown[];
      usage?: { input_tokens?: number };
    };
    expect(json.type).toBe("message");
    expect(Array.isArray(json.content)).toBe(true);
    expect(typeof json.usage?.input_tokens).toBe("number");
  }, 30_000);

  test("streaming /v1/messages emits native Anthropic SSE", async () => {
    const res = await fetch(`${BASE}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: LIVE_MODEL,
        max_tokens: 32,
        stream: true,
        messages: [{ role: "user", content: "count 1 2 3" }],
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("event-stream");
    const text = await res.text();
    // Alibaba emits "event:message_start" (no space); match either form.
    expect(/event:\s?message_start/.test(text)).toBe(true);
    expect(/event:\s?message_stop/.test(text)).toBe(true);
  }, 30_000);

  test("count_tokens returns an input_tokens number", async () => {
    const res = await fetch(`${BASE}/v1/messages/count_tokens`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: LIVE_MODEL,
        messages: [{ role: "user", content: "how many tokens is this?" }],
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { input_tokens?: number };
    expect(typeof json.input_tokens).toBe("number");
    expect(json.input_tokens ?? 0).toBeGreaterThan(0);
  }, 30_000);
});
