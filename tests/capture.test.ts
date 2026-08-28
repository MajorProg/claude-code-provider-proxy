/**
 * Behavioral tests for AnthropicStreamAccumulator (src/logging/capture.ts).
 *
 * The accumulator reconstructs the assistant turn (content blocks + usage +
 * stop_reason) from an Anthropic SSE stream for the log store. It is fed
 * decoded SSE text chunks via push() and assembled via content()/fields.
 *
 * Covers Task 2 (F4): multi-block text+tool_use reassembly, usage/stop_reason
 * extraction, the 8 MiB truncation DoS-guard, and malformed tool-JSON
 * tolerance (fallback to the raw string). Hermetic — no network.
 */
import { describe, expect, test } from "bun:test";
import { AnthropicStreamAccumulator, summarizeTools } from "../src/logging/capture.ts";

/** Serialize an event as an Anthropic SSE `event:`/`data:` frame. */
function sse(type: string, payload: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

describe("AnthropicStreamAccumulator", () => {
  test("reassembles multiple content blocks (text + tool_use) in order", () => {
    const acc = new AnthropicStreamAccumulator();
    acc.push(sse("message_start", { message: { usage: { input_tokens: 11 } } }));
    // Block 0: text, split across two deltas.
    acc.push(sse("content_block_start", { index: 0, content_block: { type: "text" } }));
    acc.push(
      sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Hello" } }),
    );
    acc.push(
      sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: ", world" } }),
    );
    // Block 1: tool_use, partial_json split across deltas.
    acc.push(
      sse("content_block_start", {
        index: 1,
        content_block: { type: "tool_use", id: "toolu_1", name: "get_weather" },
      }),
    );
    acc.push(
      sse("content_block_delta", {
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"city":' },
      }),
    );
    acc.push(
      sse("content_block_delta", {
        index: 1,
        delta: { type: "input_json_delta", partial_json: '"Berlin"}' },
      }),
    );
    acc.push(
      sse("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } }),
    );

    const blocks = acc.content();
    expect(blocks).toEqual([
      { type: "text", text: "Hello, world" },
      { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Berlin" } },
    ]);
    expect(acc.inputTokens).toBe(11);
    expect(acc.outputTokens).toBe(7);
    expect(acc.stopReason).toBe("tool_use");
  });

  test("handles SSE frames split across push() boundaries mid-line", () => {
    const acc = new AnthropicStreamAccumulator();
    const frame = sse("content_block_start", { index: 0, content_block: { type: "text" } });
    // Feed the frame one character at a time — the buffer must survive partial lines.
    for (const ch of frame) acc.push(ch);
    acc.push(sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: "ok" } }));
    expect(acc.content()).toEqual([{ type: "text", text: "ok" }]);
  });

  test("extracts input tokens reported only in message_delta (OpenAI/Mantle style)", () => {
    const acc = new AnthropicStreamAccumulator();
    acc.push(sse("message_start", { message: { usage: {} } }));
    acc.push(sse("content_block_start", { index: 0, content_block: { type: "text" } }));
    acc.push(sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: "hi" } }));
    acc.push(
      sse("message_delta", {
        delta: { stop_reason: "end_turn" },
        usage: { input_tokens: 42, output_tokens: 3 },
      }),
    );
    expect(acc.inputTokens).toBe(42);
    expect(acc.outputTokens).toBe(3);
    expect(acc.stopReason).toBe("end_turn");
  });

  test("tolerates malformed tool JSON by falling back to the raw string", () => {
    const acc = new AnthropicStreamAccumulator();
    acc.push(
      sse("content_block_start", {
        index: 0,
        content_block: { type: "tool_use", id: "toolu_x", name: "broken" },
      }),
    );
    acc.push(
      sse("content_block_delta", {
        index: 0,
        delta: { type: "input_json_delta", partial_json: "{not valid json" },
      }),
    );
    const blocks = acc.content() as Array<{ type: string; input: unknown }>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe("tool_use");
    // Un-parseable JSON is preserved verbatim rather than dropped.
    expect(blocks[0]?.input).toBe("{not valid json");
  });

  test("ignores non-JSON data lines without throwing", () => {
    const acc = new AnthropicStreamAccumulator();
    acc.push("data: [DONE]\n\n");
    acc.push(": this is an SSE comment / keep-alive\n\n");
    acc.push(sse("content_block_start", { index: 0, content_block: { type: "text" } }));
    acc.push(sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: "x" } }));
    expect(acc.content()).toEqual([{ type: "text", text: "x" }]);
  });

  test("trips the truncation cap and appends a synthetic truncation marker", () => {
    const acc = new AnthropicStreamAccumulator();
    acc.push(sse("content_block_start", { index: 0, content_block: { type: "text" } }));
    // Push > 8 MiB of text across chunks to exceed MAX_CAPTURE_CHARS.
    const chunk = "a".repeat(1024 * 1024); // 1 MiB
    for (let i = 0; i < 9; i++) {
      acc.push(
        sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: chunk } }),
      );
    }
    // Further pushes after truncation are ignored (no unbounded growth).
    acc.push(sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: "more" } }));

    const blocks = acc.content() as Array<{ type: string; text?: string }>;
    const marker = blocks[blocks.length - 1];
    expect(marker?.type).toBe("text");
    expect(marker?.text).toContain("capture truncated");
  });

  test("empty stream yields no blocks and default usage", () => {
    const acc = new AnthropicStreamAccumulator();
    expect(acc.content()).toEqual([]);
    expect(acc.inputTokens).toBe(0);
    expect(acc.outputTokens).toBe(0);
    expect(acc.stopReason).toBeNull();
  });
});

describe("summarizeTools", () => {
  test("splits custom tools from Anthropic server-tools", () => {
    const trace = summarizeTools([
      { type: "bash_20250825", name: "Bash" },
      { name: "Read", input_schema: { type: "object" } },
      { type: "web_search_20250305", name: "web_search" },
    ]);
    expect(trace?.customTools).toEqual(["Read"]);
    expect(trace?.droppedServerTools).toEqual([
      { name: "Bash", type: "bash_20250825" },
      { name: "web_search", type: "web_search_20250305" },
    ]);
  });

  test("returns undefined when no tools are offered", () => {
    expect(summarizeTools(undefined)).toBeUndefined();
    expect(summarizeTools([])).toBeUndefined();
  });

  test("tolerates malformed tool entries without throwing", () => {
    const trace = summarizeTools([null, 42, "x", { input_schema: { type: "object" } }]);
    // Only the last (a valid custom tool with no name) is counted.
    expect(trace?.customTools).toEqual(["(unnamed)"]);
    expect(trace?.droppedServerTools).toEqual([]);
  });

  test("a server-tool without a type field records type: undefined", () => {
    const trace = summarizeTools([{ name: "Weird" }]);
    expect(trace?.droppedServerTools).toEqual([{ name: "Weird", type: undefined }]);
  });
});
