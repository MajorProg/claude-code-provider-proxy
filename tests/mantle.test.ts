/**
 * Path M (Anthropic <-> OpenAI/Mantle) tests — LIVE against real Bedrock. No mocks.
 *
 * Exercises the translator end-to-end against a non-Claude Mantle model for text
 * and tool use, plus pure mapping unit checks.
 *
 * Required env: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, (AWS_SESSION_TOKEN).
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { generateShortLivedBedrockToken } from "../src/auth/bedrock-token.ts";
import { type ProxyConfig, validateConfig } from "../src/config.ts";
import { parseCanonicalId } from "../src/model/canonical-id.ts";
import { type Catalog, CatalogManager, createHttpDiscoveryClient } from "../src/model/catalog.ts";
import {
  anthropicToOpenAIRequest,
  handleMantleMessages,
  mapOpenAIFinishReason,
  openAIResponseToIr,
} from "../src/paths/mantle.ts";
import { route } from "../src/router.ts";
import { awsCreds, describeLive, liveEnabled } from "./helpers/live.ts";

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
  },
});

let catalog: Catalog;
let bearer: string;

beforeAll(async () => {
  // Top-level beforeAll runs regardless of describe.skip; no-op in the unit lane
  // so the pure-mapping describes below still run without AWS credentials.
  if (!liveEnabled()) return;
  const { accessKeyId, secretAccessKey, sessionToken } = awsCreds();
  bearer = await generateShortLivedBedrockToken({
    credentials: { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) },
    region: "us-east-1",
    expiresInSeconds: 900,
  });
  const client = createHttpDiscoveryClient(CONFIG, () => bearer);
  const mgr = await CatalogManager.start(CONFIG, client);
  catalog = mgr.current();
  mgr.stop();
});

describe("anthropicToOpenAIRequest (pure mapping)", () => {
  test("system -> leading system message; text messages -> content strings", () => {
    const body = anthropicToOpenAIRequest(
      {
        system: "be terse",
        max_tokens: 40,
        temperature: 0.2,
        top_p: 0.8,
        stop_sequences: ["STOP"],
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
        ],
      },
      "zai.glm-5",
    );
    expect(body.model).toBe("zai.glm-5");
    expect(body.messages[0]).toEqual({ role: "system", content: "be terse" });
    expect(body.messages[1]).toEqual({ role: "user", content: "hi" });
    expect(body.messages[2]).toEqual({ role: "assistant", content: "hello" });
    expect(body.max_tokens).toBe(40);
    expect(body.temperature).toBe(0.2);
    expect(body.top_p).toBe(0.8);
    expect(body.stop).toEqual(["STOP"]);
  });

  test("tool_use -> assistant.tool_calls; tool_result -> role:tool message", () => {
    const body = anthropicToOpenAIRequest(
      {
        max_tokens: 100,
        tools: [{ name: "get_weather", description: "w", input_schema: { type: "object" } }],
        tool_choice: { type: "any" },
        messages: [
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "t1", name: "get_weather", input: { city: "Paris" } },
            ],
          },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "sunny" }] },
        ],
      },
      "zai.glm-5",
    );
    expect(body.tools?.[0]).toEqual({
      type: "function",
      function: { name: "get_weather", description: "w", parameters: { type: "object" } },
    });
    expect(body.tool_choice).toBe("required");
    const assistant = body.messages.find((m) => m.role === "assistant");
    expect(assistant?.tool_calls?.[0]).toEqual({
      id: "t1",
      type: "function",
      function: { name: "get_weather", arguments: JSON.stringify({ city: "Paris" }) },
    });
    const toolMsg = body.messages.find((m) => m.role === "tool");
    expect(toolMsg).toEqual({ role: "tool", tool_call_id: "t1", content: "sunny" });
  });

  test("G1: user turn with tool_result + text emits role:tool BEFORE user text", () => {
    const body = anthropicToOpenAIRequest(
      {
        max_tokens: 50,
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "t1", name: "get", input: {} }],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "t1", content: "42" },
              { type: "text", text: "now what?" },
            ],
          },
        ],
      },
      "m",
    );
    // Sequence: assistant(tool_calls) -> tool(result) -> user(text). The tool
    // message must immediately follow the assistant tool_calls (OpenAI contract).
    const roles = body.messages.map((m) => m.role);
    expect(roles).toEqual(["assistant", "tool", "user"]);
    expect(body.messages[1]).toEqual({ role: "tool", tool_call_id: "t1", content: "42" });
    expect(body.messages[2]).toEqual({ role: "user", content: "now what?" });
  });

  test("tool_choice mapping variants", () => {
    const base = { max_tokens: 10, tools: [{ name: "x", input_schema: {} }], messages: [] };
    expect(
      anthropicToOpenAIRequest({ ...base, tool_choice: { type: "auto" } }, "m").tool_choice,
    ).toBe("auto");
    expect(
      anthropicToOpenAIRequest({ ...base, tool_choice: { type: "none" } }, "m").tool_choice,
    ).toBe("none");
    expect(
      anthropicToOpenAIRequest({ ...base, tool_choice: { type: "tool", name: "x" } }, "m")
        .tool_choice,
    ).toEqual({ type: "function", function: { name: "x" } });
  });
});

describe("mapOpenAIFinishReason", () => {
  test.each([
    ["stop", "end_turn"],
    ["tool_calls", "tool_use"],
    ["length", "max_tokens"],
    ["content_filter", "refusal"],
    ["unknown", "end_turn"],
  ])("%s -> %s", (input, expected) => {
    expect(mapOpenAIFinishReason(input)).toBe(expected as ReturnType<typeof mapOpenAIFinishReason>);
  });
});

describe("openAIResponseToIr — refusal (TC7)", () => {
  test("surfaces message.refusal as text and maps content_filter -> refusal", () => {
    const ir = openAIResponseToIr({
      choices: [
        {
          message: { content: null, refusal: "I can't help with that." },
          finish_reason: "content_filter",
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 6 },
    });
    expect(ir.stopReason).toBe("refusal");
    const text = ir.content.find((b) => b.type === "text");
    expect(text && "text" in text ? text.text : undefined).toBe("I can't help with that.");
  });

  test("reasoning field becomes a leading thinking block (R2)", () => {
    const ir = openAIResponseToIr({
      choices: [
        { message: { content: "42", reasoning: "17*23=391... wait" }, finish_reason: "stop" },
      ],
    });
    expect(ir.content[0]?.type).toBe("thinking");
    expect(ir.stopReason).toBe("end_turn");
  });

  test("SR4: prompt_tokens_details.cached_tokens maps to cacheReadInputTokens", () => {
    const ir = openAIResponseToIr({
      choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 64 },
      },
    });
    expect(ir.usage.inputTokens).toBe(100);
    expect(ir.usage.cacheReadInputTokens).toBe(64);
    // No cache-creation counter exists on the OpenAI-compat wire.
    expect(ir.usage.cacheWriteInputTokens).toBeUndefined();
  });

  test("SR4: absent cached_tokens leaves cache fields unset", () => {
    const ir = openAIResponseToIr({
      choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    });
    expect(ir.usage.cacheReadInputTokens).toBeUndefined();
  });
});

function firstMantleNonClaude(): string {
  // Prefer a known chat-capable text model. Some discovered mantle models are
  // vision-/embedding-only (e.g. gemma-*-e2b, voxtral, *-vision) and reject the
  // /v1/chat/completions route with a 400 ("isn't supported on this route"),
  // and catalog ordering is non-deterministic — so pick deterministically.
  const CHAT = /gpt-oss|qwen|glm|kimi|deepseek|minimax/i;
  const VISION_OR_EMBED = /vision|voxtral|gemma|embed|palmyra/i;
  const preferred = catalog.models.find(
    (x) =>
      x.backend === "mantle" &&
      !x.isAnthropic &&
      CHAT.test(x.nativeModelId) &&
      !VISION_OR_EMBED.test(x.nativeModelId),
  );
  if (preferred) return preferred.nativeModelId;
  const m = catalog.models.find(
    (x) => x.backend === "mantle" && !x.isAnthropic && !VISION_OR_EMBED.test(x.nativeModelId),
  );
  if (!m) throw new Error("no non-Claude mantle chat model discovered");
  return m.nativeModelId;
}

describeLive("Path M live (Mantle OpenAI)", () => {
  test("non-Claude (mantle) non-streaming text -> Anthropic message", async () => {
    const model = firstMantleNonClaude();
    const target = route(CONFIG, catalog, parseCanonicalId(`bedrock.mantle.us.${model}`));
    const body = {
      model: "ignored",
      max_tokens: 16,
      messages: [{ role: "user", content: "Reply with exactly: PONG" }],
    };
    const res = await handleMantleMessages(target, bearer, body);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.type).toBe("message");
    expect(json.role).toBe("assistant");
    expect(Array.isArray(json.content)).toBe(true);
    expect(typeof (json.usage as Record<string, unknown>).input_tokens).toBe("number");
    expect(["end_turn", "max_tokens", "stop_sequence", "tool_use", "refusal"]).toContain(
      json.stop_reason,
    );
  });

  test("non-Claude (mantle) tool use -> Anthropic tool_use block", async () => {
    // Find a capable chat model; prefer GLM/Qwen which support tool calling.
    const preferred = catalog.models.find(
      (x) =>
        x.backend === "mantle" &&
        !x.isAnthropic &&
        /glm|qwen|gpt-oss|deepseek|kimi/i.test(x.nativeModelId),
    );
    const model = preferred?.nativeModelId ?? firstMantleNonClaude();
    const target = route(CONFIG, catalog, parseCanonicalId(`bedrock.mantle.us.${model}`));
    const body = {
      model: "ignored",
      max_tokens: 300,
      tools: [
        {
          name: "get_weather",
          description: "Get current weather for a city",
          input_schema: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      ],
      tool_choice: { type: "any" },
      messages: [{ role: "user", content: "What is the weather in Paris? Use the tool." }],
    };
    const res = await handleMantleMessages(target, bearer, body);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      content: { type: string; name?: string; input?: unknown }[];
    };
    const toolUse = json.content.find((b) => b.type === "tool_use");
    expect(toolUse).toBeDefined();
    expect(toolUse?.name).toBe("get_weather");
    // input must be parsed JSON (object), not a raw string.
    expect(typeof toolUse?.input).toBe("object");
  });
});
