/**
 * DeepSeek provider tests.
 *
 * Unit tests (no network): router produces the correct native-Anthropic
 * passthrough target for a DeepSeek canonical id, and the Anthropic header
 * builder emits x-api-key.
 *
 * Live tests (gated on DEEPSEEK_API_KEY, mirroring the AWS-gated live tests):
 * real non-streaming + streaming /v1/messages round-trips and a count_tokens
 * round-trip against api.deepseek.com. No mocks (AGENTS.md rule #1).
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
    deepseek: {
      type: "anthropic",
      credential: "test-deepseek-key",
      auth: "x-api-key",
      baseUrl: "https://api.deepseek.com/anthropic",
      countTokens: true,
      modelsUrl: "https://api.deepseek.com/v1/models",
    },
  },
});

const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;
const HDR = { get: () => null };

describe("DeepSeek routing (unit)", () => {
  test("native-Anthropic passthrough target from baseUrl", () => {
    const id = parseCanonicalId("deepseek.anthropic.global.deepseek-v4-flash");
    const t = route(CONFIG, new Catalog([]), id);
    expect(t.provider).toBe("deepseek");
    expect(t.backend).toBe("anthropic");
    expect(t.translationPath).toBe("passthrough");
    expect(t.isAnthropic).toBe(true);
    expect(t.origin).toBe("https://api.deepseek.com/anthropic");
    expect(t.path).toBe("https://api.deepseek.com/anthropic/v1/messages");
    expect(t.streamPath).toBe("https://api.deepseek.com/anthropic/v1/messages");
    // countTokens: true in config -> a count_tokens path is exposed.
    expect(t.countTokensPath).toBe("https://api.deepseek.com/anthropic/v1/messages/count_tokens");
    // The native model id is sent verbatim (no profile resolution).
    expect(t.invocationId).toBe("deepseek-v4-flash");
  });

  test("buildAnthropicHeaders emits x-api-key for DeepSeek", () => {
    const h = buildAnthropicHeaders(HDR, "test-deepseek-key", "x-api-key");
    expect(h["x-api-key"]).toBe("test-deepseek-key");
    expect(h.authorization).toBeUndefined();
    expect(h["content-type"]).toBe("application/json");
  });
});

describe.if(liveEnabled() && !!DEEPSEEK_KEY)("DeepSeek live (api.deepseek.com)", () => {
  const base = "https://api.deepseek.com/anthropic";
  const headers = {
    "content-type": "application/json",
    "x-api-key": DEEPSEEK_KEY as string,
    "anthropic-version": "2023-06-01",
  };

  test("non-streaming /v1/messages returns a well-formed Anthropic message", async () => {
    const res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        max_tokens: 64,
        messages: [{ role: "user", content: "Reply with exactly one word: OK" }],
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      type?: string;
      content?: { type?: string }[];
      usage?: { input_tokens?: number };
    };
    expect(json.type).toBe("message");
    expect(Array.isArray(json.content)).toBe(true);
    expect(typeof json.usage?.input_tokens).toBe("number");
  });

  test("streaming /v1/messages emits native Anthropic SSE", async () => {
    const res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "deepseek-v4-flash",
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
  });

  test("count_tokens returns an input_tokens number", async () => {
    const res = await fetch(`${base}/v1/messages/count_tokens`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        messages: [{ role: "user", content: "how many tokens is this?" }],
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { input_tokens?: number };
    expect(typeof json.input_tokens).toBe("number");
    expect(json.input_tokens ?? 0).toBeGreaterThan(0);
  });
});
