/**
 * z.ai (GLM) provider tests.
 *
 * Unit (no network): router produces a native-Anthropic passthrough target for
 * a z.ai canonical id, and the Anthropic header builder emits Authorization:
 * Bearer for auth "bearer".
 *
 * Live (gated on ZAI_API_KEY): real non-streaming + streaming /v1/messages
 * round-trips and a count_tokens round-trip against api.z.ai. No mocks
 * (AGENTS.md rule #1).
 */
import { describe, expect, test } from "bun:test";
import { type ProxyConfig, validateConfig } from "../src/config.ts";
import { buildAnthropicHeaders } from "../src/http/upstream.ts";
import { parseCanonicalId } from "../src/model/canonical-id.ts";
import { Catalog } from "../src/model/catalog.ts";
import { route } from "../src/router.ts";
import { liveEnabled } from "./helpers/live.ts";

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
    zai: {
      type: "anthropic",
      credential: "test-zai-key",
      auth: "bearer",
      baseUrl: "https://api.z.ai/api/anthropic",
      countTokens: true,
      modelsUrl: "https://api.z.ai/api/paas/v4/models",
    },
  },
});

const ZAI_KEY = process.env.ZAI_API_KEY;
const HDR = { get: () => null };

describe("z.ai routing (unit)", () => {
  test("native-Anthropic passthrough target from baseUrl", () => {
    const id = parseCanonicalId("zai.anthropic.global.glm-4.6");
    const t = route(CONFIG, new Catalog([]), id);
    expect(t.provider).toBe("zai");
    expect(t.backend).toBe("anthropic");
    expect(t.translationPath).toBe("passthrough");
    expect(t.isAnthropic).toBe(true);
    expect(t.origin).toBe("https://api.z.ai/api/anthropic");
    expect(t.path).toBe("https://api.z.ai/api/anthropic/v1/messages");
    expect(t.countTokensPath).toBe("https://api.z.ai/api/anthropic/v1/messages/count_tokens");
    // Dotted native id survives the first-three-dots split.
    expect(t.invocationId).toBe("glm-4.6");
  });

  test("buildAnthropicHeaders emits Authorization: Bearer for z.ai", () => {
    const h = buildAnthropicHeaders(HDR, "test-zai-key", "bearer");
    expect(h.authorization).toBe("Bearer test-zai-key");
    expect(h["x-api-key"]).toBeUndefined();
    expect(h["content-type"]).toBe("application/json");
  });
});

describe.if(liveEnabled() && !!ZAI_KEY)("z.ai live (api.z.ai)", () => {
  const base = "https://api.z.ai/api/anthropic";
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${ZAI_KEY as string}`,
    "anthropic-version": "2023-06-01",
  };

  test("non-streaming /v1/messages returns a well-formed Anthropic message", async () => {
    const res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "glm-4.6",
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
    const res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "glm-4.6",
        max_tokens: 32,
        stream: true,
        messages: [{ role: "user", content: "count 1 2 3" }],
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("event-stream");
    const text = await res.text();
    expect(text).toContain("event: message_start");
    expect(text).toContain("event: message_stop");
  }, 30_000);

  test("count_tokens returns an input_tokens number", async () => {
    const res = await fetch(`${base}/v1/messages/count_tokens`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "glm-4.6",
        messages: [{ role: "user", content: "how many tokens is this?" }],
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { input_tokens?: number };
    expect(typeof json.input_tokens).toBe("number");
    expect(json.input_tokens ?? 0).toBeGreaterThan(0);
  }, 30_000);
});
