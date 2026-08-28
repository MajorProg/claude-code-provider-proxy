/**
 * Gemini provider tests — the first external `type: "openai"` provider, which
 * rides the mantle (Anthropic <-> OpenAI) translation path.
 *
 * Unit (no network): router yields a mantle target (isAnthropic:false) pointing
 * at {baseUrl}/chat/completions, and buildOpenAIHeaders emits a bearer token.
 *
 * Live (gated on GEMINI_API_KEY): drives the REAL translation via
 * handleMantleMessages against live Gemini — an Anthropic request is translated
 * to OpenAI, sent upstream, and the OpenAI response/stream is translated back to
 * Anthropic. Asserts Anthropic-shaped output (not raw upstream). No mocks.
 */
import { describe, expect, test } from "bun:test";
import { type ProxyConfig, validateConfig } from "../src/config.ts";
import { buildOpenAIHeaders } from "../src/http/upstream.ts";
import { parseCanonicalId } from "../src/model/canonical-id.ts";
import { Catalog } from "../src/model/catalog.ts";
import { handleMantleMessages } from "../src/paths/mantle.ts";
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
    gemini: {
      type: "openai",
      credential: "test-gemini-key",
      auth: "bearer",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      countTokens: false,
      modelsUrl: "https://generativelanguage.googleapis.com/v1beta/openai/models",
    },
  },
});

const GEMINI_KEY = process.env.GEMINI_API_KEY;
// A current, non-retired Gemini model on the OpenAI-compat surface.
const LIVE_MODEL = "gemini-3.6-flash";

describe("Gemini routing (unit)", () => {
  test("openai -> mantle translation target from baseUrl", () => {
    const id = parseCanonicalId("gemini.openai.global.gemini-3.6-flash");
    const t = route(CONFIG, new Catalog([]), id);
    expect(t.provider).toBe("gemini");
    expect(t.backend).toBe("openai");
    expect(t.translationPath).toBe("mantle");
    expect(t.isAnthropic).toBe(false);
    expect(t.path).toBe("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
    // No native count_tokens on this surface.
    expect(t.countTokensPath).toBeUndefined();
    expect(t.invocationId).toBe("gemini-3.6-flash");
  });

  test("buildOpenAIHeaders emits Authorization: Bearer", () => {
    const h = buildOpenAIHeaders("test-gemini-key");
    expect(h.authorization).toBe("Bearer test-gemini-key");
    expect(h["content-type"]).toBe("application/json");
  });
});

describe.if(liveEnabled() && !!GEMINI_KEY)("Gemini live via mantle translation", () => {
  const target = route(
    CONFIG,
    new Catalog([]),
    parseCanonicalId(`gemini.openai.global.${LIVE_MODEL}`),
  );

  test("non-streaming: Anthropic in -> OpenAI upstream -> Anthropic out", async () => {
    const body = {
      model: "ignored",
      max_tokens: 500,
      messages: [{ role: "user", content: "Reply with exactly one word: OK" }],
    };
    const res = await handleMantleMessages(target, GEMINI_KEY as string, body);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      type?: string;
      content?: { type?: string }[];
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    expect(json.type).toBe("message");
    expect(Array.isArray(json.content)).toBe(true);
    expect(typeof json.usage?.output_tokens).toBe("number");
  }, 30_000);

  test("streaming: OpenAI SSE -> Anthropic SSE", async () => {
    const body = {
      model: "ignored",
      max_tokens: 300,
      stream: true,
      messages: [{ role: "user", content: "say hi" }],
    };
    const res = await handleMantleMessages(target, GEMINI_KEY as string, body);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("event-stream");
    const text = await res.text();
    expect(text).toContain("event: message_start");
    expect(text).toContain("event: message_stop");
  }, 30_000);
});
