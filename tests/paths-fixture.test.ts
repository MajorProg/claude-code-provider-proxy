/**
 * Path handler round-trip tests using REAL captured fixtures (hermetic).
 *
 * Each test replays an authentic upstream response (captured live once via
 * scripts/capture-fixtures.ts) through the real handler and asserts the
 * Anthropic-shaped output. This covers the response-side translation
 * (converseResponseToIr / openAIResponseToIr / irToAnthropicResponse), the
 * streaming bridges (Converse eventstream + OpenAI SSE -> Anthropic SSE), and
 * the passthrough relay — the code the live suites exercised, now without cost.
 *
 * Only the outbound fetch boundary is mocked; the translation logic is real.
 */
import { describe, expect, test } from "bun:test";
import { handleConverseMessages } from "../src/paths/converse.ts";
import { handleMantleMessages } from "../src/paths/mantle.ts";
import {
  handlePassthroughCountTokens,
  handlePassthroughMessages,
} from "../src/paths/passthrough.ts";
import type { RouteTarget } from "../src/router.ts";
import { installFetchMock, readFixtureBase64, readFixtureText } from "./helpers/fetch-mock.ts";

const inbound = { get: (n: string) => (n === "anthropic-version" ? "2023-06-01" : null) };

function converseRoute(): RouteTarget {
  return {
    provider: "bedrock",
    backend: "converse",
    translationPath: "converse",
    awsRegion: "us-east-1",
    origin: "https://bedrock-runtime.us-east-1.amazonaws.com",
    path: "https://bedrock-runtime.us-east-1.amazonaws.com/model/nova/converse",
    streamPath: "https://bedrock-runtime.us-east-1.amazonaws.com/model/nova/converse-stream",
    countTokensPath: undefined,
    invocationId: "amazon.nova-lite-v1:0",
    isAnthropic: false,
  };
}

function mantleRoute(): RouteTarget {
  return {
    provider: "bedrock",
    backend: "mantle",
    translationPath: "mantle",
    awsRegion: "us-east-1",
    origin: "https://bedrock-mantle.us-east-1.api.aws",
    path: "https://bedrock-mantle.us-east-1.api.aws/v1/chat/completions",
    streamPath: "https://bedrock-mantle.us-east-1.api.aws/v1/chat/completions",
    countTokensPath: undefined,
    invocationId: "some.mantle-model",
    isAnthropic: false,
  };
}

function passthroughRoute(): RouteTarget {
  const base = "https://bedrock-mantle.us-east-1.api.aws/anthropic/v1/messages";
  return {
    provider: "bedrock",
    backend: "anthropic",
    translationPath: "passthrough",
    awsRegion: "us-east-1",
    origin: "https://bedrock-mantle.us-east-1.api.aws",
    path: base,
    streamPath: base,
    countTokensPath: `${base}/count_tokens`,
    invocationId: "anthropic.claude-sonnet",
    isAnthropic: true,
  };
}

const textReq = {
  model: "x",
  max_tokens: 128,
  messages: [{ role: "user", content: "Reply with exactly: hello fixture" }],
};

describe("Path C (Converse) fixture round-trips", () => {
  test("non-streaming text -> Anthropic message", async () => {
    const mock = installFetchMock({ text: readFixtureText("converse-text.json") });
    try {
      const res = await handleConverseMessages(converseRoute(), "tok", textReq);
      expect(res.status).toBe(200);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json.type).toBe("message");
      expect(json.role).toBe("assistant");
      const content = json.content as Array<{ type: string; text?: string }>;
      expect(content[0]?.type).toBe("text");
      expect(content[0]?.text).toBe("Hello fixture");
      expect(json.stop_reason).toBe("end_turn");
      const usage = json.usage as Record<string, number>;
      expect(usage.input_tokens).toBe(6);
      expect(usage.output_tokens).toBe(3);
    } finally {
      mock.restore();
    }
  });

  test("tool use -> Anthropic tool_use block", async () => {
    const mock = installFetchMock({ text: readFixtureText("converse-tool.json") });
    try {
      const res = await handleConverseMessages(converseRoute(), "tok", textReq);
      const json = (await res.json()) as Record<string, unknown>;
      const content = json.content as Array<{
        type: string;
        name?: string;
        input?: Record<string, unknown>;
      }>;
      expect(content[0]?.type).toBe("tool_use");
      expect(content[0]?.name).toBe("get_weather");
      expect(content[0]?.input).toEqual({ city: "Berlin" });
      expect(json.stop_reason).toBe("tool_use");
    } finally {
      mock.restore();
    }
  });

  test("streaming eventstream -> Anthropic SSE", async () => {
    const bytes = readFixtureBase64("converse-stream.b64");
    const mock = installFetchMock({ stream: bytes, chunks: 5 });
    try {
      const res = await handleConverseMessages(converseRoute(), "tok", {
        ...textReq,
        stream: true,
      });
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const sse = await res.text();
      expect(sse).toContain("event: message_start");
      expect(sse).toContain("event: content_block_delta");
      expect(sse).toContain("event: message_stop");
      // Reconstructed text should include the model's reply.
      expect(sse.toLowerCase()).toContain("hello");
    } finally {
      mock.restore();
    }
  });
});

describe("Path M (Mantle/OpenAI) fixture round-trips", () => {
  test("non-streaming text -> Anthropic message", async () => {
    const mock = installFetchMock({ text: readFixtureText("openai-text.json") });
    try {
      const res = await handleMantleMessages(mantleRoute(), "tok", textReq);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json.type).toBe("message");
      const content = json.content as Array<{ type: string; text?: string }>;
      expect(content[0]?.type).toBe("text");
      expect(content[0]?.text).toContain("hello fixture");
      expect(json.stop_reason).toBe("end_turn");
      const usage = json.usage as Record<string, number>;
      expect(usage.input_tokens).toBe(13);
      expect(usage.output_tokens).toBe(94);
    } finally {
      mock.restore();
    }
  });

  test("tool use -> Anthropic tool_use block", async () => {
    const mock = installFetchMock({ text: readFixtureText("openai-tool.json") });
    try {
      const res = await handleMantleMessages(mantleRoute(), "tok", textReq);
      const json = (await res.json()) as Record<string, unknown>;
      const content = json.content as Array<{ type: string; name?: string; input?: unknown }>;
      const toolBlock = content.find((b) => b.type === "tool_use");
      expect(toolBlock).toBeDefined();
      expect(toolBlock?.name).toBe("get_weather");
      expect(json.stop_reason).toBe("tool_use");
    } finally {
      mock.restore();
    }
  });

  test("streaming SSE -> Anthropic SSE", async () => {
    const bytes = new TextEncoder().encode(readFixtureText("openai-stream.sse"));
    const mock = installFetchMock({ stream: bytes, chunks: 7 });
    try {
      const res = await handleMantleMessages(mantleRoute(), "tok", { ...textReq, stream: true });
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const sse = await res.text();
      expect(sse).toContain("event: message_start");
      expect(sse).toContain("event: content_block_delta");
      expect(sse).toContain("event: message_stop");
    } finally {
      mock.restore();
    }
  });

  test("sends stream_options.include_usage on the outbound streaming body", async () => {
    const bytes = new TextEncoder().encode(readFixtureText("openai-stream.sse"));
    const mock = installFetchMock({ stream: bytes });
    try {
      const res = await handleMantleMessages(mantleRoute(), "tok", { ...textReq, stream: true });
      await res.text();
      const sent = JSON.parse(mock.requests[0]?.body ?? "{}") as Record<string, unknown>;
      expect(sent.stream).toBe(true);
      expect(sent.stream_options).toEqual({ include_usage: true });
    } finally {
      mock.restore();
    }
  });
});

describe("Path P (passthrough) fixture round-trips", () => {
  test("non-streaming relays native Anthropic body + rewrites model outbound", async () => {
    const mock = installFetchMock({ text: readFixtureText("anthropic-text.json") });
    try {
      const res = await handlePassthroughMessages(passthroughRoute(), inbound, "tok", textReq);
      expect(res.status).toBe(200);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json.type).toBe("message");
      expect(json.role).toBe("assistant");
      // Outbound body must carry the resolved invocation id, not the inbound "x".
      const sent = JSON.parse(mock.requests[0]?.body ?? "{}") as Record<string, unknown>;
      expect(sent.model).toBe("anthropic.claude-sonnet");
    } finally {
      mock.restore();
    }
  });

  test("drops anthropic-beta and strips context_management + tool defer_loading on the outbound request", async () => {
    // Inbound carries an anthropic-beta header + a tools array with defer_loading
    // both at the tool top level and nested under `custom` — the two shapes
    // Claude Code has used. Bedrock's native Anthropic route rejects both.
    const inboundWithBeta = {
      get: (n: string) => {
        if (n === "anthropic-version") return "2023-06-01";
        if (n === "anthropic-beta")
          return "fine-grained-tool-streaming-2025-05-14,context-1m-2025-08-07";
        return null;
      },
    };
    const reqWithTools = {
      ...textReq,
      context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
      output_config: { format: { type: "json_schema", schema: {} } },
      tools: [
        {
          name: "get_weather",
          defer_loading: true,
          input_schema: { type: "object", properties: {} },
          custom: { defer_loading: false, extra: "keep" },
        },
        { type: "bash_20250825", name: "Bash" },
      ],
    };
    const mock = installFetchMock({ text: readFixtureText("anthropic-text.json") });
    try {
      const res = await handlePassthroughMessages(
        passthroughRoute(),
        inboundWithBeta,
        "tok",
        reqWithTools,
      );
      expect(res.status).toBe(200);

      // Header: anthropic-beta must NOT be forwarded upstream.
      expect(mock.requests[0]?.headers["anthropic-beta"]).toBeUndefined();
      // anthropic-version is still forwarded.
      expect(mock.requests[0]?.headers["anthropic-version"]).toBe("2023-06-01");

      // Body: defer_loading stripped in both positions; everything else intact.
      const sent = JSON.parse(mock.requests[0]?.body ?? "{}") as Record<string, unknown>;
      // Top-level context_management must be stripped.
      expect("context_management" in sent).toBe(false);
      expect("output_config" in sent).toBe(false);
      const tools = sent.tools as Array<Record<string, unknown>>;
      const first = tools[0] ?? {};
      expect("defer_loading" in first).toBe(false);
      const custom = (first.custom ?? {}) as Record<string, unknown>;
      expect("defer_loading" in custom).toBe(false);
      expect(custom.extra).toBe("keep");
      expect(first.name).toBe("get_weather");
      // Untouched tool (server-tool brick) passes through unchanged.
      expect(tools[1]).toEqual({ type: "bash_20250825", name: "Bash" });
    } finally {
      mock.restore();
    }
  });

  test("streaming relays the native Anthropic SSE verbatim", async () => {
    const bytes = new TextEncoder().encode(readFixtureText("anthropic-stream.sse"));
    const mock = installFetchMock({ stream: bytes, chunks: 4 });
    try {
      const res = await handlePassthroughMessages(passthroughRoute(), inbound, "tok", {
        ...textReq,
        stream: true,
      });
      const sse = await res.text();
      expect(sse).toContain("event: message_start");
      expect(sse).toContain("data:");
    } finally {
      mock.restore();
    }
  });

  test("count_tokens relays input_tokens", async () => {
    const mock = installFetchMock({ text: readFixtureText("anthropic-count.json") });
    try {
      const res = await handlePassthroughCountTokens(passthroughRoute(), inbound, "tok", textReq);
      expect(res.status).toBe(200);
      const json = (await res.json()) as Record<string, number>;
      expect(json.input_tokens).toBe(19);
    } finally {
      mock.restore();
    }
  });

  test("count_tokens on a model without a countTokensPath -> 400 (no upstream call)", async () => {
    const noCount = { ...passthroughRoute(), countTokensPath: undefined };
    const mock = installFetchMock({ text: "{}" });
    try {
      await expect(handlePassthroughCountTokens(noCount, inbound, "tok", textReq)).rejects.toThrow(
        /count_tokens is not supported/,
      );
      expect(mock.requests).toHaveLength(0);
    } finally {
      mock.restore();
    }
  });

  test("relays an upstream error status + body (does not translate)", async () => {
    const mock = installFetchMock({
      status: 429,
      json: { type: "error", error: { type: "rate_limit_error", message: "slow down" } },
    });
    try {
      await expect(
        handlePassthroughMessages(passthroughRoute(), inbound, "tok", textReq),
      ).rejects.toThrow();
    } finally {
      mock.restore();
    }
  });
});
