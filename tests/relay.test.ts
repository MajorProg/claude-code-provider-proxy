/**
 * Shared upstream/relay helper tests — hermetic (no network).
 *
 * Covers Task 23 (parseJsonObject / parseUpstreamJson trust-boundary
 * validation) + Task 27 (assertUpstreamOk / relayHeadersFrom).
 */
import { describe, expect, test } from "bun:test";
import { BadRequestError, PayloadTooLargeError, UpstreamError } from "../src/errors.ts";
import type { IRResponse } from "../src/ir/types.ts";
import {
  MAX_TOOL_RESULT_CHARS,
  PASSTHROUGH_RELAY_HEADERS,
  assertInboundLimits,
  assertUpstreamOk,
  coerceToolInput,
  estimateTokensFromChars,
  hasOwn,
  irToAnthropicResponse,
  isCustomTool,
  normalizeImageSource,
  parseJsonObject,
  parseUpstreamJson,
  readBodyWithLimit,
  relayHeadersFrom,
  sanitizeToolCallId,
  toolResultContentToString,
  validateInboundBlock,
} from "../src/paths/relay.ts";
import type { RouteTarget } from "../src/router.ts";

// Minimal RouteTarget stub (only path + invocationId are read by the helpers).
const route = { path: "https://x/model/m/converse", invocationId: "m-1" } as unknown as RouteTarget;

describe("parseJsonObject", () => {
  test("returns the parsed object for a JSON object", () => {
    expect(parseJsonObject('{"a":1,"b":"x"}')).toEqual({ a: 1, b: "x" });
  });

  test("throws BadRequestError on invalid JSON", () => {
    expect(() => parseJsonObject("{not json")).toThrow(BadRequestError);
    expect(() => parseJsonObject("{not json")).toThrow(/not valid JSON/);
  });

  test("throws BadRequestError on a non-object (array / scalar / null)", () => {
    expect(() => parseJsonObject("[1,2,3]")).toThrow(/must be a JSON object/);
    expect(() => parseJsonObject('"a string"')).toThrow(/must be a JSON object/);
    expect(() => parseJsonObject("42")).toThrow(/must be a JSON object/);
    expect(() => parseJsonObject("null")).toThrow(/must be a JSON object/);
  });

  test("uses the provided label in the error message", () => {
    expect(() => parseJsonObject("[]", "Upstream body")).toThrow(
      /Upstream body must be a JSON object/,
    );
  });
});

describe("assertUpstreamOk", () => {
  test("resolves for a 2xx response", async () => {
    const res = new Response("{}", { status: 200 });
    await expect(assertUpstreamOk(res, route)).resolves.toBeUndefined();
  });

  test("throws UpstreamError with body + context for a non-2xx response", async () => {
    const res = new Response('{"error":"nope"}', { status: 503 });
    try {
      await assertUpstreamOk(res, route);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(UpstreamError);
      const ue = err as UpstreamError;
      expect(ue.status).toBe(503);
      expect(ue.upstreamBody).toBe('{"error":"nope"}');
      expect(ue.context).toEqual({ route: route.path, model: route.invocationId });
    }
  });

  test("requireBody: throws when the body is null even on a 2xx", async () => {
    // A 204 has a null body.
    const res = new Response(null, { status: 204 });
    await expect(assertUpstreamOk(res, route, { requireBody: true })).rejects.toBeInstanceOf(
      UpstreamError,
    );
    // Without requireBody, a null-body 2xx is fine.
    await expect(
      assertUpstreamOk(new Response(null, { status: 204 }), route),
    ).resolves.toBeUndefined();
  });
});

describe("parseUpstreamJson", () => {
  test("returns the parsed object for a JSON object body", async () => {
    const res = new Response('{"output":{"x":1}}', { status: 200 });
    expect(await parseUpstreamJson<{ output: { x: number } }>(res, route)).toEqual({
      output: { x: 1 },
    });
  });

  test("throws a 502 UpstreamError on a non-JSON body", async () => {
    const res = new Response("<html>gateway error</html>", { status: 200 });
    await expect(parseUpstreamJson(res, route)).rejects.toMatchObject({ status: 502 });
  });

  test("throws a 502 UpstreamError on a non-object JSON body", async () => {
    const res = new Response("[1,2,3]", { status: 200 });
    await expect(parseUpstreamJson(res, route)).rejects.toMatchObject({ status: 502 });
  });
});

describe("relayHeadersFrom", () => {
  test("copies only the named present headers", () => {
    const res = new Response("ok", {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store", "x-other": "1" },
    });
    expect(relayHeadersFrom(res, PASSTHROUGH_RELAY_HEADERS)).toEqual({
      "content-type": "application/json",
      "cache-control": "no-store",
    });
  });

  test("omits headers that are absent", () => {
    const res = new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
    expect(relayHeadersFrom(res, PASSTHROUGH_RELAY_HEADERS)).toEqual({
      "content-type": "text/plain",
    });
  });
});

describe("irToAnthropicResponse", () => {
  test("maps text/tool_use/tool_result/image blocks + flat usage", () => {
    const ir: IRResponse = {
      role: "assistant",
      content: [
        { type: "text", text: "hi" },
        { type: "tool_use", id: "t1", name: "calc", input: { a: 1 } },
        { type: "tool_result", toolUseId: "t1", content: "42" },
        { type: "image", mediaType: "image/png", data: "AAAA" },
      ],
      stopReason: "end_turn",
      usage: { inputTokens: 5, outputTokens: 7 },
    };
    const out = irToAnthropicResponse(ir, "my-model");
    expect(out.type).toBe("message");
    expect(out.model).toBe("my-model");
    expect(out.stop_reason).toBe("end_turn");
    expect(out.content).toEqual([
      { type: "text", text: "hi" },
      { type: "tool_use", id: "t1", name: "calc", input: { a: 1 } },
      { type: "tool_result", tool_use_id: "t1", content: "42" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
    ]);
    expect(out.usage).toEqual({ input_tokens: 5, output_tokens: 7 });
    expect(String(out.id).startsWith("msg_")).toBe(true);
  });

  test("SR9: emits stop_sequence from the IR when present, else null", () => {
    const base: IRResponse = {
      role: "assistant",
      content: [{ type: "text", text: "x" }],
      stopReason: "stop_sequence",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
    expect(irToAnthropicResponse({ ...base, stopSequence: "BLUE" }, "m").stop_sequence).toBe(
      "BLUE",
    );
    expect(irToAnthropicResponse(base, "m").stop_sequence).toBeNull();
  });

  test("emits cache_read / cache_creation usage only when the IR carries them", () => {
    const ir: IRResponse = {
      role: "assistant",
      content: [{ type: "text", text: "x" }],
      stopReason: "end_turn",
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        cacheReadInputTokens: 3,
        cacheWriteInputTokens: 4,
      },
    };
    const out = irToAnthropicResponse(ir, "m");
    expect(out.usage).toEqual({
      input_tokens: 10,
      output_tokens: 2,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 4,
    });
  });

  test("serializes a thinking block WITH its signature (signed, e.g. Converse)", () => {
    const ir: IRResponse = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "let me reason", signature: "sig-abc" },
        { type: "text", text: "answer" },
      ],
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
    const out = irToAnthropicResponse(ir, "m");
    expect(out.content).toEqual([
      { type: "thinking", thinking: "let me reason", signature: "sig-abc" },
      { type: "text", text: "answer" },
    ]);
  });

  test("serializes a thinking block WITHOUT a signature (unsigned, e.g. OpenAI reasoning)", () => {
    const ir: IRResponse = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "unsigned reasoning" }],
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
    const out = irToAnthropicResponse(ir, "m");
    // No fabricated signature: the key must be absent, not null/empty.
    expect(out.content).toEqual([{ type: "thinking", thinking: "unsigned reasoning" }]);
    const block = (out.content as Record<string, unknown>[])[0];
    expect(block && "signature" in block).toBe(false);
  });
});

describe("coerceToolInput (G10/SEC-10)", () => {
  test("valid JSON object is returned as-is", () => {
    expect(coerceToolInput('{"city":"Paris","n":2}')).toEqual({ city: "Paris", n: 2 });
  });

  test("empty / undefined arguments -> {}", () => {
    expect(coerceToolInput("")).toEqual({});
    expect(coerceToolInput(undefined)).toEqual({});
  });

  test("truncated / malformed JSON -> {}", () => {
    expect(coerceToolInput('{"city":')).toEqual({});
    expect(coerceToolInput("{not valid")).toEqual({});
  });

  test("non-object JSON (string/number/array/null) -> {}", () => {
    expect(coerceToolInput('"just a string"')).toEqual({});
    expect(coerceToolInput("42")).toEqual({});
    expect(coerceToolInput("[1,2,3]")).toEqual({});
    expect(coerceToolInput("null")).toEqual({});
  });
});

describe("estimateTokensFromChars (PC7)", () => {
  test("returns 0 for empty output", () => {
    expect(estimateTokensFromChars(0)).toBe(0);
    expect(estimateTokensFromChars(-5)).toBe(0);
  });

  test("estimates ~1 token per 4 chars, rounding up, min 1", () => {
    expect(estimateTokensFromChars(1)).toBe(1);
    expect(estimateTokensFromChars(4)).toBe(1);
    expect(estimateTokensFromChars(5)).toBe(2);
    expect(estimateTokensFromChars(400)).toBe(100);
  });
});

describe("sanitizeToolCallId (G3/SR8)", () => {
  test("passes an already-valid id through unchanged", () => {
    expect(sanitizeToolCallId("call_abc-123")).toBe("call_abc-123");
  });

  test("replaces disallowed characters with underscore", () => {
    expect(sanitizeToolCallId("toolu:01ABC/xyz.def")).toBe("toolu_01ABC_xyz_def");
  });

  test("is deterministic — a tool_use id and its tool_result id sanitize identically", () => {
    const raw = "toolu_01A#b@c";
    expect(sanitizeToolCallId(raw)).toBe(sanitizeToolCallId(raw));
  });

  test("falls back to a stable placeholder for an empty/all-invalid id", () => {
    expect(sanitizeToolCallId("")).toBe("tool_call");
  });
});

describe("normalizeImageSource (TC6)", () => {
  test("base64 with a supported media_type passes through", () => {
    const out = normalizeImageSource({ type: "base64", media_type: "image/jpeg", data: "abc" });
    expect(out).toEqual({ mediaType: "image/jpeg", data: "abc" });
  });

  test("base64 with an unknown media_type defaults to image/png", () => {
    const out = normalizeImageSource({ type: "base64", media_type: "image/tiff", data: "abc" });
    expect(out?.mediaType).toBe("image/png");
    expect(out?.data).toBe("abc");
  });

  test("url source is normalized (no media_type)", () => {
    const out = normalizeImageSource({ type: "url", url: "https://x/img.png" });
    expect(out).toEqual({ mediaType: "", url: "https://x/img.png" });
  });

  test("malformed / unrecognized sources return undefined", () => {
    expect(normalizeImageSource(null)).toBeUndefined();
    expect(normalizeImageSource({ type: "base64", media_type: "image/png" })).toBeUndefined();
    expect(normalizeImageSource({ type: "url" })).toBeUndefined();
    expect(normalizeImageSource({ type: "other", data: "x" })).toBeUndefined();
  });
});

describe("assertInboundLimits (SEC-4)", () => {
  const limits = { maxMessages: 3, maxContentBlocksPerMessage: 2, maxTools: 2 };

  test("passes a request within all caps", () => {
    expect(() =>
      assertInboundLimits(
        {
          messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
          tools: [{ name: "t", input_schema: {} }],
        },
        limits,
      ),
    ).not.toThrow();
  });

  test("rejects too many messages", () => {
    const messages = Array.from({ length: 4 }, () => ({ role: "user", content: "x" }));
    expect(() => assertInboundLimits({ messages }, limits)).toThrow(BadRequestError);
    expect(() => assertInboundLimits({ messages }, limits)).toThrow(/exceeding the 3 limit/);
  });

  test("rejects too many content blocks in a message", () => {
    const content = [
      { type: "text", text: "a" },
      { type: "text", text: "b" },
      { type: "text", text: "c" },
    ];
    expect(() => assertInboundLimits({ messages: [{ role: "user", content }] }, limits)).toThrow(
      /content blocks, exceeding/,
    );
  });

  test("rejects too many tools", () => {
    const tools = [{ name: "a" }, { name: "b" }, { name: "c" }];
    expect(() => assertInboundLimits({ tools }, limits)).toThrow(/tools, exceeding the 2 limit/);
  });

  test("ignores non-array messages/tools (shape validated elsewhere)", () => {
    expect(() => assertInboundLimits({ messages: "nope", tools: 5 }, limits)).not.toThrow();
  });
});

describe("SEC-3 DoS guards", () => {
  test("rejects JSON nested deeper than the depth limit (400)", () => {
    let deep = "true";
    for (let i = 0; i < 80; i++) deep = `{"a":${deep}}`;
    expect(() => parseJsonObject(deep)).toThrow(BadRequestError);
    expect(() => parseJsonObject(deep)).toThrow(/nests deeper than/);
  });

  test("accepts JSON within the depth limit", () => {
    let ok = "1";
    for (let i = 0; i < 10; i++) ok = `{"a":${ok}}`;
    expect(() => parseJsonObject(ok)).not.toThrow();
  });

  test("truncates an oversized tool-result string with a marker", () => {
    const huge = "x".repeat(MAX_TOOL_RESULT_CHARS + 10_000);
    const out = toolResultContentToString(huge);
    expect(out.length).toBeLessThan(huge.length);
    expect(out).toContain("tool result truncated");
    expect(out.startsWith("x".repeat(100))).toBe(true);
  });

  test("leaves a normal tool-result untouched", () => {
    expect(toolResultContentToString("small result")).toBe("small result");
  });
});

describe("parseJsonObject prototype-pollution guard (SEC-2)", () => {
  test("strips __proto__ and does not pollute Object.prototype", () => {
    const obj = parseJsonObject('{"a":1,"__proto__":{"polluted":true}}');
    expect(obj.a).toBe(1);
    expect(Object.hasOwn(obj, "__proto__")).toBe(false);
    // Nothing leaked onto the global prototype.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test("strips constructor/prototype keys anywhere in the tree", () => {
    const obj = parseJsonObject(
      '{"messages":[{"role":"user","constructor":"x","nested":{"prototype":"y","ok":1}}]}',
    ) as { messages: Array<Record<string, unknown>> };
    const m = obj.messages[0] as Record<string, unknown>;
    expect(Object.hasOwn(m, "constructor")).toBe(false);
    const nested = m.nested as Record<string, unknown>;
    expect(Object.hasOwn(nested, "prototype")).toBe(false);
    expect(nested.ok).toBe(1);
  });

  test("hasOwn ignores inherited keys", () => {
    const obj = parseJsonObject('{"real":1}');
    expect(hasOwn(obj, "real")).toBe(true);
    expect(hasOwn(obj, "toString")).toBe(false); // inherited, not own
  });
});

describe("readBodyWithLimit (SEC-1)", () => {
  test("returns the body when under the limit", async () => {
    const req = new Request("http://x/", { method: "POST", body: '{"a":1}' });
    expect(await readBodyWithLimit(req, 1024)).toBe('{"a":1}');
  });

  test("fast-rejects via Content-Length before reading (413)", async () => {
    const req = {
      headers: { get: (n: string) => (n === "content-length" ? "999999" : null) },
      text: async () => {
        throw new Error("must not read the body when Content-Length over limit");
      },
    };
    await expect(readBodyWithLimit(req, 1024)).rejects.toThrow(PayloadTooLargeError);
    await expect(readBodyWithLimit(req, 1024)).rejects.toThrow(/exceeds the 1024-byte limit/);
  });

  test("streamed cap: aborts a chunked body that exceeds the limit (413)", async () => {
    // A stream with no Content-Length that emits more than the cap.
    const big = new Uint8Array(4096).fill(65);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(big);
        c.enqueue(big);
        c.close();
      },
    });
    const req = {
      headers: { get: () => null },
      body: stream,
      text: async () => "unused",
    };
    await expect(readBodyWithLimit(req, 4096)).rejects.toThrow(PayloadTooLargeError);
  });
});

describe("validateInboundBlock (SEC-6)", () => {
  test("accepts known block types (incl. the real Claude thinking shape)", () => {
    expect(validateInboundBlock({ type: "text", text: "x" })).toBe("text");
    expect(validateInboundBlock({ type: "tool_use", id: "t", name: "n", input: {} })).toBe(
      "tool_use",
    );
    expect(validateInboundBlock({ type: "tool_result", tool_use_id: "t", content: "" })).toBe(
      "tool_result",
    );
    expect(validateInboundBlock({ type: "image", source: {} })).toBe("image");
    // Real Claude-on-Bedrock thinking block shape (live-verified): type/thinking/signature.
    expect(validateInboundBlock({ type: "thinking", thinking: "r", signature: "sig" })).toBe(
      "thinking",
    );
    expect(validateInboundBlock({ type: "redacted_thinking", data: "x" })).toBe(
      "redacted_thinking",
    );
  });

  test("throws BadRequestError (400) on an unknown type", () => {
    expect(() => validateInboundBlock({ type: "wat" })).toThrow(BadRequestError);
    expect(() => validateInboundBlock({ type: "wat" })).toThrow(/unknown type "wat"/);
  });

  test("throws BadRequestError on a missing/non-string type or non-object block", () => {
    expect(() => validateInboundBlock({})).toThrow(/missing a string "type"/);
    expect(() => validateInboundBlock({ type: 7 })).toThrow(/missing a string "type"/);
    expect(() => validateInboundBlock("nope")).toThrow(/must be an object/);
    expect(() => validateInboundBlock(null)).toThrow(/must be an object/);
    expect(() => validateInboundBlock([])).toThrow(/must be an object/);
  });

  test("weaves the label into the error", () => {
    expect(() => validateInboundBlock({ type: "x" }, "messages[2].content[0]")).toThrow(
      /messages\[2\]\.content\[0\] has unknown type/,
    );
  });
});

describe("toolResultContentToString (TC2)", () => {
  test("string content is returned verbatim", () => {
    expect(toolResultContentToString("hello")).toBe("hello");
  });

  test("array of text blocks concatenates their text", () => {
    expect(
      toolResultContentToString([
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ]),
    ).toBe("ab");
  });

  test("image block becomes a [image omitted] placeholder, NOT a base64 JSON dump", () => {
    const out = toolResultContentToString([
      { type: "text", text: "see:" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "AAAAref-base64-blob" },
      },
    ]);
    expect(out).toBe("see:[image omitted]");
    // The raw base64 data must NOT leak into the text.
    expect(out).not.toContain("AAAAref-base64-blob");
    expect(out).not.toContain("base64");
  });

  test("non-text, non-image structured blocks are still JSON-stringified", () => {
    expect(toolResultContentToString([{ type: "json", value: { k: 1 } }])).toBe(
      JSON.stringify({ type: "json", value: { k: 1 } }),
    );
  });
});

describe("isCustomTool", () => {
  test("true for a tool with an object input_schema", () => {
    expect(isCustomTool({ input_schema: { type: "object" } })).toBe(true);
    expect(isCustomTool({ input_schema: {} })).toBe(true);
  });

  test("false for Anthropic server-tools (no input_schema)", () => {
    expect(isCustomTool({} as { input_schema?: unknown })).toBe(false);
    expect(isCustomTool({ input_schema: undefined })).toBe(false);
  });

  test("false for non-object schemas (null/array/scalar)", () => {
    expect(isCustomTool({ input_schema: null })).toBe(false);
    expect(isCustomTool({ input_schema: [] })).toBe(false);
    expect(isCustomTool({ input_schema: "x" as unknown })).toBe(false);
  });
});
