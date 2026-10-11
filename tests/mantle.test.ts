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
import type { ZaiWireConfig } from "../src/config.ts";
import { UpstreamError } from "../src/errors.ts";
import { parseCanonicalId } from "../src/model/canonical-id.ts";
import { type Catalog, CatalogManager, createHttpDiscoveryClient } from "../src/model/catalog.ts";
import {
  anthropicToOpenAIRequest,
  classifyZaiStreamFinishError,
  handleMantleMessages,
  isZaiForcedThinkingModel,
  mapEffortToReasoningEffort,
  mapOpenAIFinishReason,
  openAIResponseToIr,
  sanitizeZaiRequestId,
  zaiSupportsReasoningEffort,
} from "../src/paths/mantle.ts";
import type { RouteTarget } from "../src/router.ts";
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

// ─── z.ai openai-wire (zaiWire config block): thinking/effort/request ───────
// Ported from the chimera-employee llm-router (audit 2026-10-10). Model
// capability patterns live in CONFIG, never in source — this fixture mirrors
// the z.ai research shipped in config.example.jsonc.

const ZAI_WIRE: ZaiWireConfig = {
  forcedThinkingModels: ["^glm-4\\.7(?![\\d])", "^glm-5\\.3(?![\\d])"],
  reasoningEffortModels: ["^glm-5\\.[2-9]", "^glm-[6-9]"],
};

describe("anthropicToOpenAIRequest zai wire — thinking controls", () => {
  test("zai wire always carries the Preserved Thinking activation object", () => {
    // Plain request, no thinking config at all.
    const body = anthropicToOpenAIRequest(
      { messages: [{ role: "user", content: "hi" }] },
      "glm-5.3-flash",
      "openai",
      { zaiWire: ZAI_WIRE },
    );
    expect(body.thinking).toEqual({ type: "enabled", clear_thinking: false });
    // Explicit enabled keeps the same activation shape.
    const enabled = anthropicToOpenAIRequest(
      { messages: [{ role: "user", content: "hi" }], thinking: { type: "enabled" } },
      "glm-5.3-flash",
      "openai",
      { zaiWire: ZAI_WIRE },
    );
    expect(enabled.thinking).toEqual({ type: "enabled", clear_thinking: false });
    // Non-zai wires never see a thinking object.
    const other = anthropicToOpenAIRequest(
      { messages: [{ role: "user", content: "hi" }] },
      "glm-5.3-flash",
    );
    expect(other.thinking).toBeUndefined();
  });

  test("thinking:{type:disabled} forwards verbatim on optional-thinking models", () => {
    const body = anthropicToOpenAIRequest(
      { messages: [{ role: "user", content: "hi" }], thinking: { type: "disabled" } },
      "glm-5-turbo",
      "openai",
      { zaiWire: ZAI_WIRE },
    );
    expect(body.thinking).toEqual({ type: "disabled" });
  });

  test("thinking:{type:disabled} is dropped on FORCED-thinking models — activation instead", () => {
    for (const model of ["glm-4.7", "glm-5.3", "glm-5.3-flash", "glm-5.3-flashx"]) {
      const body = anthropicToOpenAIRequest(
        { messages: [{ role: "user", content: "hi" }], thinking: { type: "disabled" } },
        model,
        "openai",
        { zaiWire: ZAI_WIRE },
      );
      // The disable is unconditionally dropped (forced); the zai wire still
      // carries the Preserved Thinking activation object.
      expect(body.thinking).toEqual({ type: "enabled", clear_thinking: false });
    }
    // Adjacent-but-different ids are NOT forced (a lookahead, not a prefix):
    // the disable forwards verbatim — and NEVER gains clear_thinking (that
    // pairing is not documented).
    const adjacent = anthropicToOpenAIRequest(
      { messages: [{ role: "user", content: "hi" }], thinking: { type: "disabled" } },
      "glm-5.31",
      "openai",
      { zaiWire: ZAI_WIRE },
    );
    expect(adjacent.thinking).toEqual({ type: "disabled" });
  });

  test("non-zai wires never receive thinking or reasoning_effort", () => {
    const body = anthropicToOpenAIRequest(
      {
        messages: [{ role: "user", content: "hi" }],
        thinking: { type: "disabled" },
        ccpp_reasoning_effort: "high",
      },
      "glm-5.3-flash",
    );
    expect(body.thinking).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
  });
});

describe("anthropicToOpenAIRequest zai wire — Preserved Thinking replay", () => {
  test("assistant thinking blocks replay as reasoning_content on the assistant message", () => {
    const body = anthropicToOpenAIRequest(
      {
        messages: [
          { role: "user", content: "first" },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "step one, " },
              { type: "text", text: "answer one" },
            ],
          },
          { role: "user", content: "second" },
        ],
      },
      "glm-4.7",
      "openai",
      { zaiWire: ZAI_WIRE },
    );
    // system absent; messages: user, assistant(reasoning+text), user.
    const assistant = body.messages.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    expect(assistant?.reasoning_content).toBe("step one, ");
    expect(assistant?.content).toBe("answer one");
    expect(body.messages.filter((m) => "reasoning_content" in m)).toHaveLength(1);
  });

  test("consecutive thinking blocks concatenate in order (unmodified sequence)", () => {
    const body = anthropicToOpenAIRequest(
      {
        messages: [
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "part A " },
              { type: "thinking", thinking: "part B" },
              { type: "text", text: "done" },
            ],
          },
        ],
      },
      "glm-4.7",
      "openai",
      { zaiWire: ZAI_WIRE },
    );
    expect(body.messages[0]?.reasoning_content).toBe("part A part B");
  });

  test("thinking + tool_use on one assistant turn — reasoning rides the tool_calls message", () => {
    const body = anthropicToOpenAIRequest(
      {
        messages: [
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "plan the call" },
              { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Berlin" } },
            ],
          },
        ],
      },
      "glm-4.7",
      "openai",
      { zaiWire: ZAI_WIRE },
    );
    const assistant = body.messages[0];
    expect(assistant?.role).toBe("assistant");
    expect(assistant?.reasoning_content).toBe("plan the call");
    expect(assistant?.content).toBeNull(); // TC8
    expect(assistant?.tool_calls?.[0]?.function?.name).toBe("get_weather");
  });

  test("a thinking-ONLY assistant turn still emits its replayed reasoning", () => {
    const body = anthropicToOpenAIRequest(
      {
        messages: [
          { role: "user", content: "q" },
          { role: "assistant", content: [{ type: "thinking", thinking: "silent deliberation" }] },
          { role: "user", content: "go on" },
        ],
      },
      "glm-4.7",
      "openai",
      { zaiWire: ZAI_WIRE },
    );
    const assistant = body.messages[1];
    expect(assistant?.role).toBe("assistant");
    expect(assistant?.reasoning_content).toBe("silent deliberation");
  });

  test("redacted_thinking NEVER replays, and user-role thinking stays dropped", () => {
    const body = anthropicToOpenAIRequest(
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "thinking", thinking: "not assistant" },
              { type: "text", text: "q" },
            ],
          },
          {
            role: "assistant",
            content: [
              { type: "redacted_thinking", data: "opaque", signature: "sig" } as never,
              { type: "thinking", thinking: "real reasoning" },
              { type: "text", text: "a" },
            ],
          },
        ],
      },
      "glm-4.7",
      "openai",
      { zaiWire: ZAI_WIRE },
    );
    const user = body.messages[0];
    expect(user && "reasoning_content" in user).toBe(false);
    expect(body.messages[1]?.reasoning_content).toBe("real reasoning");
  });

  test("non-zai lanes keep dropping thinking blocks on replay (legacy behavior)", () => {
    const body = anthropicToOpenAIRequest(
      {
        messages: [
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "dropped off-lane" },
              { type: "text", text: "answer" },
            ],
          },
        ],
      },
      "some-openai-model",
    );
    expect(JSON.stringify(body.messages)).not.toContain("reasoning_content");
    expect(JSON.stringify(body.messages)).not.toContain("dropped off-lane");
  });
});

describe("anthropicToOpenAIRequest zai wire — effort + request_id", () => {
  test("ccpp_reasoning_effort maps onto z.ai reasoning_effort (ladder → max|high|low)", () => {
    const cases = [
      ["low", "low"],
      ["medium", "high"],
      ["high", "high"],
      ["xhigh", "max"],
      ["max", "max"],
    ] as const;
    for (const [effort, expected] of cases) {
      const body = anthropicToOpenAIRequest(
        { messages: [{ role: "user", content: "hi" }], ccpp_reasoning_effort: effort },
        "glm-5.3-flash",
        "openai",
        { zaiWire: ZAI_WIRE },
      );
      expect(body.reasoning_effort).toBe(expected);
    }
  });

  test("reasoning_effort is NOT emitted for models outside the config patterns", () => {
    for (const model of ["glm-4.7", "glm-4.6", "glm-5", "glm-5.1"]) {
      const body = anthropicToOpenAIRequest(
        { messages: [{ role: "user", content: "hi" }], ccpp_reasoning_effort: "high" },
        model,
        "openai",
        { zaiWire: ZAI_WIRE },
      );
      expect(body.reasoning_effort).toBeUndefined();
    }
  });

  test("an invalid ladder value in the extension is never forwarded", () => {
    const body = anthropicToOpenAIRequest(
      { messages: [{ role: "user", content: "hi" }], ccpp_reasoning_effort: "ultra" },
      "glm-5.3-flash",
      "openai",
      { zaiWire: ZAI_WIRE },
    );
    expect(body.reasoning_effort).toBeUndefined();
  });

  test("request_id rides the zai wire sanitized; non-zai wires never receive it", () => {
    const zai = anthropicToOpenAIRequest(
      { messages: [{ role: "user", content: "hi" }] },
      "glm-5.3-flash",
      "openai",
      { zaiWire: ZAI_WIRE, requestId: "req_abc-123" },
    );
    expect(zai.request_id).toBe("req_abc-123");
    const other = anthropicToOpenAIRequest(
      { messages: [{ role: "user", content: "hi" }], ccpp_request_id: "req_never-forwarded" },
      "some-openai-model",
    );
    expect("request_id" in other).toBe(false);
  });
});

describe("zai capability matchers (config regex patterns)", () => {
  test("isZaiForcedThinkingModel: glm-4.7 and the glm-5.3 family", () => {
    for (const m of ["glm-4.7", "glm-4.7-flash", "glm-5.3", "glm-5.3-flash", "glm-5.3-flashx"]) {
      expect(isZaiForcedThinkingModel(m, ZAI_WIRE)).toBe(true);
    }
    for (const m of [
      "glm-4.6",
      "glm-5",
      "glm-5.1",
      "glm-5.2",
      "glm-5-turbo",
      "glm-4.75",
      "glm-5.31",
    ]) {
      expect(isZaiForcedThinkingModel(m, ZAI_WIRE)).toBe(false);
    }
  });

  test("zaiSupportsReasoningEffort: glm-5.2 and newer only", () => {
    for (const m of ["glm-5.2", "glm-5.3", "glm-5.3-flash", "glm-5.3-flashx", "glm-6"]) {
      expect(zaiSupportsReasoningEffort(m, ZAI_WIRE)).toBe(true);
    }
    for (const m of ["glm-4.7", "glm-5", "glm-5.1", "glm-5-turbo", "qwen3.8-max"]) {
      expect(zaiSupportsReasoningEffort(m, ZAI_WIRE)).toBe(false);
    }
  });

  test("mapEffortToReasoningEffort: full ladder, unknown → undefined", () => {
    expect(mapEffortToReasoningEffort("low")).toBe("low");
    expect(mapEffortToReasoningEffort("medium")).toBe("high");
    expect(mapEffortToReasoningEffort("high")).toBe("high");
    expect(mapEffortToReasoningEffort("xhigh")).toBe("max");
    expect(mapEffortToReasoningEffort("max")).toBe("max");
    expect(mapEffortToReasoningEffort("ultra")).toBeUndefined();
  });
});

describe("classifyZaiStreamFinishError (pure)", () => {
  test("each z.ai error finish_reason classifies with a typed Anthropic surface", () => {
    const network = classifyZaiStreamFinishError("network_error");
    expect(network?.kind).toBe("transient");
    expect(network?.anthropicErrorType).toBe("api_error");
    expect(network?.message).toContain("network_error");

    const sensitive = classifyZaiStreamFinishError("sensitive");
    expect(sensitive?.kind).toBe("refusal");
    expect(sensitive?.anthropicErrorType).toBe("invalid_request_error");
    expect(sensitive?.message).toContain("sensitive");

    const overflow = classifyZaiStreamFinishError("model_context_window_exceeded");
    expect(overflow?.kind).toBe("context_overflow");
    expect(overflow?.anthropicErrorType).toBe("request_too_large");
    expect(overflow?.message).toContain("model_context_window_exceeded");
  });

  test("normal and unknown reasons classify to undefined", () => {
    for (const r of ["stop", "tool_calls", "length", "content_filter", "something_new"]) {
      expect(classifyZaiStreamFinishError(r)).toBeUndefined();
    }
  });
});

describe("sanitizeZaiRequestId (pure)", () => {
  test("a valid id passes through unchanged", () => {
    expect(sanitizeZaiRequestId("req_abc-123")).toBe("req_abc-123");
    expect(sanitizeZaiRequestId("a".repeat(64))).toBe("a".repeat(64));
    expect(sanitizeZaiRequestId("123456")).toBe("123456"); // exactly the minimum
  });

  test("disallowed characters are stripped", () => {
    expect(sanitizeZaiRequestId("req.abc/def:ghi")).toBe("reqabcdefghi");
  });

  test("an over-long id truncates at 64", () => {
    expect(sanitizeZaiRequestId("r".repeat(100))).toBe("r".repeat(64));
  });

  test("a result below the 6-char minimum falls back to a fresh UUID (valid shape)", () => {
    const out = sanitizeZaiRequestId("a.b/c"); // nothing usable survives
    expect(out).toMatch(/^[0-9a-f-]{36}$/);
    expect(out.length).toBeGreaterThanOrEqual(6);
  });
});

// ─── zai wire against the real handler (fetch stubbed at the boundary) ──────

describe("handleMantleMessages zai wire", () => {
  const ZAI_TARGET: RouteTarget = {
    provider: "zai",
    backend: "openai",
    translationPath: "mantle",
    awsRegion: "",
    origin: "https://zai.test",
    path: "https://zai.test/api/paas/v4/chat/completions",
    streamPath: "https://zai.test/api/paas/v4/chat/completions",
    countTokensPath: undefined,
    invocationId: "glm-5.3-flash",
    isAnthropic: false,
    zaiWire: ZAI_WIRE,
  };

  test("non-streaming: z.ai error finish_reasons throw typed UpstreamErrors, reason preserved", async () => {
    const realFetch = globalThis.fetch;
    const cases = [
      ["sensitive", "refusal"],
      ["network_error", "transient"],
      ["model_context_window_exceeded", "context_overflow"],
    ] as const;
    try {
      for (const [reason, kind] of cases) {
        globalThis.fetch = (async () =>
          Response.json({
            choices: [{ message: { content: "partial" }, finish_reason: reason }],
            usage: { prompt_tokens: 5, completion_tokens: 2 },
          })) as typeof fetch;
        let thrown: unknown;
        try {
          await handleMantleMessages(ZAI_TARGET, "k", {
            messages: [{ role: "user", content: "hi" }],
            max_tokens: 16,
          });
        } catch (err) {
          thrown = err;
        }
        expect(thrown).toBeInstanceOf(UpstreamError);
        const e = thrown as UpstreamError;
        expect(e.message).toContain(reason);
        expect((e.context as Record<string, unknown>).kind).toBe(kind);
        // The raw upstream body is preserved for relay.
        expect(e.upstreamBody).toContain(reason);
      }
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("non-streaming: request_id rides the body and echoes on the response header", async () => {
    const realFetch = globalThis.fetch;
    let outboundBody = "";
    try {
      globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
        outboundBody = String(init?.body);
        return Response.json({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 2 },
        });
      }) as typeof fetch;
      const res = await handleMantleMessages(ZAI_TARGET, "k", {
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 16,
        ccpp_request_id: "req_abc-123",
      });
      expect(res.status).toBe(200);
      expect(JSON.parse(outboundBody).request_id).toBe("req_abc-123");
      expect(res.headers.get("x-ccpp-upstream-request-id")).toBe("req_abc-123");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("streaming: z.ai network_error finish_reason → typed error event, partial content flushed, header echoed", async () => {
    const realFetch = globalThis.fetch;
    const sse = [
      'data: {"choices":[{"delta":{"content":"par"},"index":0}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"network_error","index":0}]}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    try {
      globalThis.fetch = (async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(new TextEncoder().encode(sse));
              c.close();
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        )) as typeof fetch;
      const res = await handleMantleMessages(ZAI_TARGET, "k", {
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 16,
        stream: true,
        ccpp_request_id: "req_stream-1",
      });
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      expect(res.headers.get("x-ccpp-upstream-request-id")).toBe("req_stream-1");
      const text = await res.text();
      expect(text).toContain("event: error");
      expect(text).toContain("network_error");
      expect(text).toContain('"type":"api_error"');
      // The accrued partial content was flushed before the error — no
      // silent data loss.
      expect(text).toContain("par");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("a missing max_tokens on the zai wire answers a spec-correct 400 (no 65k default)", async () => {
    const realFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => Response.json({})) as typeof fetch;
      let thrown: unknown;
      try {
        await handleMantleMessages(ZAI_TARGET, "k", {
          messages: [{ role: "user", content: "hi" }],
        });
      } catch (err) {
        thrown = err;
      }
      expect((thrown as { status?: number }).status).toBe(400);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("non-streaming: usage subtracts the cached subset from input_tokens (inclusive form)", async () => {
    const realFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () =>
        Response.json({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 1700,
            completion_tokens: 7,
            prompt_tokens_details: { cached_tokens: 1650 },
          },
        })) as typeof fetch;
      const res = await handleMantleMessages(ZAI_TARGET, "k", {
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 16,
      });
      const body = (await res.json()) as { usage: Record<string, number> };
      expect(body.usage.input_tokens).toBe(50); // 1700 - 1650
      expect(body.usage.cache_read_input_tokens).toBe(1650);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
