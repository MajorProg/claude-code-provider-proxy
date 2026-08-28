/**
 * Moonshot / Kimi provider tests — native-Anthropic passthrough (`type:
 * "anthropic"`) with bearer auth. No native count_tokens on this surface.
 *
 * Unit (no network): router produces the correct native-Anthropic passthrough
 * target (no count_tokens path since countTokens:false); the Anthropic header
 * builder emits Authorization: Bearer for the "bearer" auth style.
 *
 * Live (gated on MOONSHOT_API_KEY): real non-streaming + streaming /v1/messages
 * round-trips against api.moonshot.ai/anthropic. No mocks (AGENTS.md rule #1).
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
    moonshot: {
      type: "anthropic",
      credential: "test-moonshot-key",
      auth: "bearer",
      baseUrl: "https://api.moonshot.ai/anthropic",
      countTokens: false,
      modelsUrl: "https://api.moonshot.ai/v1/models",
    },
  },
});

const MOONSHOT_KEY = process.env.MOONSHOT_API_KEY;
const HDR = { get: () => null };
const LIVE_MODEL = "kimi-k2.6";

describe("Moonshot routing (unit)", () => {
  test("native-Anthropic passthrough target; no count_tokens", () => {
    const id = parseCanonicalId("moonshot.anthropic.global.kimi-k2.6");
    const t = route(CONFIG, new Catalog([]), id);
    expect(t.provider).toBe("moonshot");
    expect(t.backend).toBe("anthropic");
    expect(t.translationPath).toBe("passthrough");
    expect(t.isAnthropic).toBe(true);
    expect(t.origin).toBe("https://api.moonshot.ai/anthropic");
    expect(t.path).toBe("https://api.moonshot.ai/anthropic/v1/messages");
    expect(t.streamPath).toBe("https://api.moonshot.ai/anthropic/v1/messages");
    // countTokens: false -> no count_tokens path exposed.
    expect(t.countTokensPath).toBeUndefined();
    expect(t.invocationId).toBe("kimi-k2.6");
  });

  test("buildAnthropicHeaders emits Authorization: Bearer for bearer auth", () => {
    const h = buildAnthropicHeaders(HDR, "test-moonshot-key", "bearer");
    expect(h.authorization).toBe("Bearer test-moonshot-key");
    expect(h["x-api-key"]).toBeUndefined();
    expect(h["content-type"]).toBe("application/json");
  });
});

describe.if(liveEnabled() && !!MOONSHOT_KEY)("Moonshot live (api.moonshot.ai/anthropic)", () => {
  const base = "https://api.moonshot.ai/anthropic";
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${MOONSHOT_KEY as string}`,
    "anthropic-version": "2023-06-01",
  };

  test("non-streaming /v1/messages returns a well-formed Anthropic message", async () => {
    const res = await fetch(`${base}/v1/messages`, {
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
      content?: { type?: string }[];
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
        model: LIVE_MODEL,
        max_tokens: 32,
        stream: true,
        messages: [{ role: "user", content: "count 1 2 3" }],
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("event-stream");
    const text = await res.text();
    expect(text).toMatch(/event:\s?message_start/);
    expect(text).toMatch(/event:\s?message_stop/);
  }, 30_000);
});
