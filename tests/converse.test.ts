/**
 * Path C (Anthropic <-> Converse) tests — LIVE against real Bedrock. No mocks.
 *
 * Exercises the translator end-to-end against a non-Claude Converse model (Nova)
 * and a Claude model (Converse serves the full Claude catalog), for both plain
 * text and tool use. Also unit-checks the pure mapping helpers.
 *
 * Required env: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, (AWS_SESSION_TOKEN).
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { generateShortLivedBedrockToken } from "../src/auth/bedrock-token.ts";
import { type ProxyConfig, validateConfig } from "../src/config.ts";
import { parseCanonicalId } from "../src/model/canonical-id.ts";
import { type Catalog, CatalogManager, createHttpDiscoveryClient } from "../src/model/catalog.ts";
import {
  anthropicToConverseRequest,
  handleConverseMessages,
  mapConverseStopReason,
} from "../src/paths/converse.ts";
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

describe("anthropicToConverseRequest (pure mapping)", () => {
  test("maps system, messages, inferenceConfig", () => {
    const body = anthropicToConverseRequest({
      model: "x",
      system: "be terse",
      max_tokens: 50,
      temperature: 0.5,
      top_p: 0.9,
      stop_sequences: ["STOP"],
      messages: [{ role: "user", content: "hello" }],
    });
    expect(body.system).toEqual([{ text: "be terse" }]);
    expect(body.messages).toEqual([{ role: "user", content: [{ text: "hello" }] }]);
    expect(body.inferenceConfig).toEqual({
      maxTokens: 50,
      temperature: 0.5,
      topP: 0.9,
      stopSequences: ["STOP"],
    });
  });

  test("maps tools + tool_choice, and tool_use/tool_result blocks", () => {
    const body = anthropicToConverseRequest({
      model: "x",
      max_tokens: 100,
      tools: [{ name: "get_weather", description: "w", input_schema: { type: "object" } }],
      tool_choice: { type: "any" },
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "get_weather", input: { city: "Paris" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "sunny" }],
        },
      ],
    });
    expect(body.toolConfig?.tools[0]?.toolSpec.name).toBe("get_weather");
    expect(body.toolConfig?.tools[0]?.toolSpec.inputSchema.json).toEqual({ type: "object" });
    expect(body.toolConfig?.toolChoice).toEqual({ any: {} });
    expect(body.messages[0]?.content[0]).toEqual({
      toolUse: { toolUseId: "t1", name: "get_weather", input: { city: "Paris" } },
    });
    expect(body.messages[1]?.content[0]).toEqual({
      toolResult: { toolUseId: "t1", content: [{ text: "sunny" }] },
    });
  });
});

describe("mapConverseStopReason", () => {
  test.each([
    ["end_turn", "end_turn"],
    ["tool_use", "tool_use"],
    ["max_tokens", "max_tokens"],
    ["stop_sequence", "stop_sequence"],
    ["content_filtered", "end_turn"],
    ["unknown", "end_turn"],
  ])("%s -> %s", (input, expected) => {
    expect(mapConverseStopReason(input)).toBe(expected as ReturnType<typeof mapConverseStopReason>);
  });
});

function firstConverseNonClaude(): string {
  // Prefer a Nova model (verified text/chat + tool capable via Converse). Some
  // catalog entries are embeddings/vision-only and reject Converse chat.
  const nova = catalog.models.find(
    (x) =>
      x.backend === "converse" &&
      !x.isAnthropic &&
      /nova-(lite|pro|micro)/.test(x.nativeModelId) &&
      (x.profiles.length > 0 || x.supportsOnDemand),
  );
  if (nova) return nova.nativeModelId;
  const m = catalog.models.find(
    (x) =>
      x.backend === "converse" && !x.isAnthropic && (x.profiles.length > 0 || x.supportsOnDemand),
  );
  if (!m) throw new Error("no non-Claude converse model discovered");
  return m.nativeModelId;
}

describeLive("Path C live (Converse)", () => {
  test("non-Claude (converse) non-streaming text -> Anthropic message", async () => {
    const model = firstConverseNonClaude();
    const target = route(CONFIG, catalog, parseCanonicalId(`bedrock.converse.us.${model}`));
    const body = {
      model: "ignored",
      max_tokens: 16,
      messages: [{ role: "user", content: "Reply with exactly: PONG" }],
    };
    const res = await handleConverseMessages(target, bearer, body);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.type).toBe("message");
    expect(json.role).toBe("assistant");
    expect(Array.isArray(json.content)).toBe(true);
    expect(typeof (json.usage as Record<string, unknown>).input_tokens).toBe("number");
    expect(["end_turn", "max_tokens", "stop_sequence", "tool_use"]).toContain(json.stop_reason);
  });

  test("non-Claude (converse) tool use -> Anthropic tool_use block", async () => {
    // Use a Nova model — verified tool-capable via Converse (DESIGN §11). Not all
    // non-Claude converse models support tool use (embeddings/vision-only, etc.).
    const nova = catalog.models.find(
      (x) =>
        x.backend === "converse" &&
        !x.isAnthropic &&
        /nova-(lite|pro|micro)/.test(x.nativeModelId) &&
        (x.profiles.length > 0 || x.supportsOnDemand),
    );
    if (!nova) throw new Error("no Nova converse model discovered for tool-use test");
    const target = route(
      CONFIG,
      catalog,
      parseCanonicalId(`bedrock.converse.us.${nova.nativeModelId}`),
    );
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
      messages: [{ role: "user", content: "What is the weather in Paris? Use the tool." }],
    };
    const res = await handleConverseMessages(target, bearer, body);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { content: { type: string; name?: string }[] };
    const toolUse = json.content.find((b) => b.type === "tool_use");
    expect(toolUse).toBeDefined();
    expect(toolUse?.name).toBe("get_weather");
  });

  test("Claude via Converse non-streaming -> Anthropic message", async () => {
    const claude = catalog.models.find((m) => m.backend === "converse" && m.isAnthropic);
    if (!claude) throw new Error("no Claude converse model discovered");
    const target = route(
      CONFIG,
      catalog,
      parseCanonicalId(`bedrock.converse.us.${claude.nativeModelId}`),
    );
    const body = {
      model: "ignored",
      max_tokens: 16,
      messages: [{ role: "user", content: "Reply with exactly: PONG" }],
    };
    const res = await handleConverseMessages(target, bearer, body);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.type).toBe("message");
    expect(Array.isArray(json.content)).toBe(true);
  });
});
