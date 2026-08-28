/**
 * Shared upstream/relay helper tests — hermetic (no network).
 *
 * Covers Task 23 (parseJsonObject / parseUpstreamJson trust-boundary
 * validation) + Task 27 (assertUpstreamOk / relayHeadersFrom).
 */
import { describe, expect, test } from "bun:test";
import { BadRequestError, UpstreamError } from "../src/errors.ts";
import type { IRResponse } from "../src/ir/types.ts";
import {
  PASSTHROUGH_RELAY_HEADERS,
  assertUpstreamOk,
  irToAnthropicResponse,
  isCustomTool,
  parseJsonObject,
  parseUpstreamJson,
  relayHeadersFrom,
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
