/**
 * EUrouter provider tests — EU data-residency router, `type: "openai"` on the
 * mantle (Anthropic <-> OpenAI) translation path.
 *
 * Unit (no network): router yields a mantle target (isAnthropic:false) pointing
 * at {baseUrl}/chat/completions; buildOpenAIHeaders emits a bearer token.
 *
 * Live (gated on EUROUTER_API_KEY): drives the REAL translation via
 * handleMantleMessages against live api.eurouter.ai — Anthropic in, OpenAI
 * upstream, Anthropic out. No mocks (AGENTS.md rule #1).
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
    eurouter: {
      type: "openai",
      credential: "test-eurouter-key",
      auth: "bearer",
      baseUrl: "https://api.eurouter.ai/v1",
      countTokens: false,
      modelsUrl: "https://api.eurouter.ai/v1/models",
    },
  },
});

const EUROUTER_KEY = process.env.EUROUTER_API_KEY;
const LIVE_MODEL = "qwen3.6-27b";

describe("EUrouter routing (unit)", () => {
  test("openai -> mantle translation target from baseUrl", () => {
    const id = parseCanonicalId("eurouter.openai.global.qwen3.6-27b");
    const t = route(CONFIG, new Catalog([]), id);
    expect(t.provider).toBe("eurouter");
    expect(t.backend).toBe("openai");
    expect(t.translationPath).toBe("mantle");
    expect(t.isAnthropic).toBe(false);
    expect(t.path).toBe("https://api.eurouter.ai/v1/chat/completions");
    expect(t.countTokensPath).toBeUndefined();
    expect(t.invocationId).toBe("qwen3.6-27b");
  });

  test("buildOpenAIHeaders emits Authorization: Bearer", () => {
    const h = buildOpenAIHeaders("test-eurouter-key");
    expect(h.authorization).toBe("Bearer test-eurouter-key");
    expect(h["content-type"]).toBe("application/json");
  });
});

describe.if(liveEnabled() && !!EUROUTER_KEY)("EUrouter live via mantle translation", () => {
  const target = route(
    CONFIG,
    new Catalog([]),
    parseCanonicalId(`eurouter.openai.global.${LIVE_MODEL}`),
  );

  test("non-streaming: Anthropic in -> OpenAI upstream -> Anthropic out", async () => {
    const body = {
      model: "ignored",
      max_tokens: 128,
      messages: [{ role: "user", content: "Reply with exactly one word: OK" }],
    };
    const res = await handleMantleMessages(target, EUROUTER_KEY as string, body);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      type?: string;
      content?: { type?: string }[];
      usage?: { output_tokens?: number };
    };
    expect(json.type).toBe("message");
    expect(Array.isArray(json.content)).toBe(true);
    expect(typeof json.usage?.output_tokens).toBe("number");
  }, 30_000);

  test("streaming: OpenAI SSE -> Anthropic SSE", async () => {
    const body = {
      model: "ignored",
      max_tokens: 64,
      stream: true,
      messages: [{ role: "user", content: "say hi" }],
    };
    const res = await handleMantleMessages(target, EUROUTER_KEY as string, body);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("event-stream");
    const text = await res.text();
    expect(text).toContain("event: message_start");
    expect(text).toContain("event: message_stop");
  }, 30_000);
});
