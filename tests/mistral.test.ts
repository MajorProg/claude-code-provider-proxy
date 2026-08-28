/**
 * Mistral provider tests — `type: "openai"` on the mantle (Anthropic <-> OpenAI)
 * translation path.
 *
 * Unit (no network): router yields a mantle target (isAnthropic:false) pointing
 * at {baseUrl}/chat/completions; buildOpenAIHeaders emits a bearer token.
 *
 * Live (gated on MISTRAL_API_KEY): drives the REAL translation via
 * handleMantleMessages against live api.mistral.ai — Anthropic in, OpenAI
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
    mistral: {
      type: "openai",
      credential: "test-mistral-key",
      auth: "bearer",
      baseUrl: "https://api.mistral.ai/v1",
      countTokens: false,
      modelsUrl: "https://api.mistral.ai/v1/models",
    },
  },
});

const MISTRAL_KEY = process.env.MISTRAL_API_KEY;
const LIVE_MODEL = "mistral-small-latest";

describe("Mistral routing (unit)", () => {
  test("openai -> mantle translation target from baseUrl", () => {
    const id = parseCanonicalId("mistral.openai.global.mistral-small-latest");
    const t = route(CONFIG, new Catalog([]), id);
    expect(t.provider).toBe("mistral");
    expect(t.backend).toBe("openai");
    expect(t.translationPath).toBe("mantle");
    expect(t.isAnthropic).toBe(false);
    expect(t.path).toBe("https://api.mistral.ai/v1/chat/completions");
    expect(t.countTokensPath).toBeUndefined();
    expect(t.invocationId).toBe("mistral-small-latest");
  });

  test("buildOpenAIHeaders emits Authorization: Bearer", () => {
    const h = buildOpenAIHeaders("test-mistral-key");
    expect(h.authorization).toBe("Bearer test-mistral-key");
    expect(h["content-type"]).toBe("application/json");
  });
});

describe.if(liveEnabled() && !!MISTRAL_KEY)("Mistral live via mantle translation", () => {
  const target = route(
    CONFIG,
    new Catalog([]),
    parseCanonicalId(`mistral.openai.global.${LIVE_MODEL}`),
  );

  test("non-streaming: Anthropic in -> OpenAI upstream -> Anthropic out", async () => {
    const body = {
      model: "ignored",
      max_tokens: 64,
      messages: [{ role: "user", content: "Reply with exactly one word: OK" }],
    };
    const res = await handleMantleMessages(target, MISTRAL_KEY as string, body);
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
      max_tokens: 48,
      stream: true,
      messages: [{ role: "user", content: "say hi" }],
    };
    const res = await handleMantleMessages(target, MISTRAL_KEY as string, body);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("event-stream");
    const text = await res.text();
    expect(text).toContain("event: message_start");
    expect(text).toContain("event: message_stop");
  }, 30_000);
});
