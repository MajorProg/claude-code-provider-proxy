/**
 * Streaming translator tests — LIVE against real Bedrock. No mocks.
 *
 * Validates:
 *   - Anthropic SSE emitter framing + synthetic ping (unit)
 *   - Path C streaming: ConverseStream -> Anthropic SSE (live Nova + tool use)
 *   - Path M streaming: OpenAI SSE -> Anthropic SSE with tool-arg reassembly (live)
 *
 * Required env: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, (AWS_SESSION_TOKEN).
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { generateShortLivedBedrockToken } from "../src/auth/bedrock-token.ts";
import { type ProxyConfig, validateConfig } from "../src/config.ts";
import { parseCanonicalId } from "../src/model/canonical-id.ts";
import { type Catalog, CatalogManager, createHttpDiscoveryClient } from "../src/model/catalog.ts";
import { handleConverseMessages } from "../src/paths/converse.ts";
import { handleMantleMessages } from "../src/paths/mantle.ts";
import { route } from "../src/router.ts";
import { AnthropicSseEmitter, formatSseEvent } from "../src/stream/anthropic-sse.ts";
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
  // so the AnthropicSseEmitter unit describe still runs without AWS credentials.
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

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) out += decoder.decode(value, { stream: true });
  }
  return out;
}

describe("AnthropicSseEmitter (unit)", () => {
  test("formatSseEvent frames correctly", () => {
    expect(formatSseEvent("ping", { type: "ping" })).toBe('event: ping\ndata: {"type":"ping"}\n\n');
  });

  test("emits a well-formed text message stream", async () => {
    const emitter = new AnthropicSseEmitter(60_000); // no pings during this fast test
    const collected = collect(emitter.readable);
    emitter.start("test-model", 5);
    const idx = emitter.startTextBlock();
    emitter.appendText(idx, "Hello");
    emitter.stopBlock(idx);
    emitter.finish("end_turn", { outputTokens: 3 });
    const text = await collected;
    expect(text).toContain("event: message_start");
    expect(text).toContain("event: content_block_start");
    expect(text).toContain('"type":"text_delta","text":"Hello"');
    expect(text).toContain("event: content_block_stop");
    expect(text).toContain('"stop_reason":"end_turn"');
    expect(text).toContain("event: message_stop");
  });

  test("tool_use block emits input_json_delta", async () => {
    const emitter = new AnthropicSseEmitter(60_000);
    const collected = collect(emitter.readable);
    emitter.start("test-model", 1);
    const idx = emitter.startToolUseBlock("t1", "get_weather");
    emitter.appendToolInputJson(idx, '{"city":');
    emitter.appendToolInputJson(idx, '"Paris"}');
    emitter.stopBlock(idx);
    emitter.finish("tool_use", { outputTokens: 2 });
    const text = await collected;
    expect(text).toContain('"type":"tool_use","id":"t1","name":"get_weather"');
    expect(text).toContain('"type":"input_json_delta","partial_json":"{\\"city\\":"');
    expect(text).toContain('"stop_reason":"tool_use"');
  });
});

function novaConverseModel(): string {
  const m = catalog.models.find(
    (x) =>
      x.backend === "converse" && !x.isAnthropic && /nova-(lite|pro|micro)/.test(x.nativeModelId),
  );
  if (!m) throw new Error("no Nova converse model discovered");
  return m.nativeModelId;
}
function mantleToolModel(): string {
  // Prefer a NON-thinking, tool-capable chat model: thinking models (kimi,
  // minimax, deepseek-*-thinking) can spend the entire max_tokens budget on the
  // reasoning block and hit stop_reason=max_tokens BEFORE emitting the tool
  // call, which is a model-behavior artifact, not a translation defect. gpt-oss
  // / qwen / glm emit the tool_call promptly and deterministically.
  const TOOL_CHAT = /gpt-oss|qwen|glm/i;
  const THINKING = /kimi|minimax|thinking/i;
  const VISION_OR_EMBED = /vision|voxtral|gemma|embed|palmyra/i;
  const m = catalog.models.find(
    (x) =>
      x.backend === "mantle" &&
      !x.isAnthropic &&
      TOOL_CHAT.test(x.nativeModelId) &&
      !THINKING.test(x.nativeModelId) &&
      !VISION_OR_EMBED.test(x.nativeModelId),
  );
  return (
    (
      m ??
      catalog.models.find(
        (x) =>
          x.backend === "mantle" &&
          !x.isAnthropic &&
          !THINKING.test(x.nativeModelId) &&
          !VISION_OR_EMBED.test(x.nativeModelId),
      )
    )?.nativeModelId ?? ""
  );
}

describeLive("Path C streaming (ConverseStream -> Anthropic SSE, live)", () => {
  test("non-Claude text streams as Anthropic SSE", async () => {
    const target = route(
      CONFIG,
      catalog,
      parseCanonicalId(`bedrock.converse.us.${novaConverseModel()}`),
    );
    const body = {
      model: "ignored",
      max_tokens: 30,
      stream: true,
      messages: [{ role: "user", content: "Count 1 2 3 then stop" }],
    };
    const res = await handleConverseMessages(target, bearer, body);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("event-stream");
    const text = await collect(res.body as ReadableStream<Uint8Array>);
    expect(text).toContain("event: message_start");
    expect(text).toContain("event: content_block_delta");
    expect(text).toContain('"type":"text_delta"');
    expect(text).toContain("event: message_stop");
    // Regression guard: the Converse stream must fold metadata usage into the
    // final message_delta, including the real input token count (not just 0).
    const deltaLine = text
      .split("\n")
      .find((l) => l.startsWith("data:") && l.includes('"message_delta"'));
    expect(deltaLine).toBeDefined();
    const delta = JSON.parse((deltaLine as string).slice(5)) as {
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    expect(typeof delta.usage?.input_tokens).toBe("number");
    expect(delta.usage?.input_tokens ?? 0).toBeGreaterThan(0);
  });

  test("non-Claude tool use streams tool_use + input_json_delta", async () => {
    const target = route(
      CONFIG,
      catalog,
      parseCanonicalId(`bedrock.converse.us.${novaConverseModel()}`),
    );
    const body = {
      model: "ignored",
      max_tokens: 300,
      stream: true,
      tools: [
        {
          name: "get_weather",
          description: "Get weather",
          input_schema: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      ],
      messages: [{ role: "user", content: "Weather in Paris? Use the tool." }],
    };
    const res = await handleConverseMessages(target, bearer, body);
    const text = await collect(res.body as ReadableStream<Uint8Array>);
    expect(text).toContain('"type":"tool_use"');
    expect(text).toContain("get_weather");
    expect(text).toContain('"type":"input_json_delta"');
  });
});

describeLive("Path M streaming (OpenAI SSE -> Anthropic SSE, live)", () => {
  test("non-Claude text streams as Anthropic SSE", async () => {
    const model = mantleToolModel();
    const target = route(CONFIG, catalog, parseCanonicalId(`bedrock.mantle.us.${model}`));
    const body = {
      model: "ignored",
      max_tokens: 30,
      stream: true,
      messages: [{ role: "user", content: "Count 1 2 3 then stop" }],
    };
    const res = await handleMantleMessages(target, bearer, body);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("event-stream");
    const text = await collect(res.body as ReadableStream<Uint8Array>);
    expect(text).toContain("event: message_start");
    expect(text).toContain('"type":"text_delta"');
    expect(text).toContain("event: message_stop");
  });

  test("non-Claude tool use reassembles arguments into input_json_delta", async () => {
    const model = mantleToolModel();
    const target = route(CONFIG, catalog, parseCanonicalId(`bedrock.mantle.us.${model}`));
    const body = {
      model: "ignored",
      max_tokens: 300,
      stream: true,
      tools: [
        {
          name: "get_weather",
          description: "Get weather",
          input_schema: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      ],
      tool_choice: { type: "any" },
      messages: [{ role: "user", content: "Weather in Paris? Use the tool." }],
    };
    const res = await handleMantleMessages(target, bearer, body);
    const text = await collect(res.body as ReadableStream<Uint8Array>);
    expect(text).toContain('"type":"tool_use"');
    expect(text).toContain("get_weather");
    expect(text).toContain('"type":"input_json_delta"');
  });
});
