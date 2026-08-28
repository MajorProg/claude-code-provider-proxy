/**
 * AnthropicSseEmitter tests (hermetic).
 *
 * Drives the emitter directly and reads its `readable` to assert the exact
 * Anthropic SSE event sequence, plus the fail() error path, the setOnCancel
 * client-disconnect callback, and enqueue-after-close safety.
 */
import { describe, expect, test } from "bun:test";
import { AnthropicSseEmitter } from "../src/stream/anthropic-sse.ts";

/** Collect the whole SSE stream as text. */
async function drain(emitter: AnthropicSseEmitter): Promise<string> {
  return await new Response(emitter.readable).text();
}

describe("AnthropicSseEmitter", () => {
  test("emits a well-formed text turn: start -> block -> delta -> stop -> finish", async () => {
    // Disable pings (interval 0 is treated as default; use a huge interval).
    const e = new AnthropicSseEmitter(1_000_000);
    e.start("my-model", 5);
    const idx = e.startTextBlock();
    e.appendText(idx, "Hello");
    e.appendText(idx, " world");
    e.appendText(idx, ""); // no-op (empty delta)
    e.stopBlock(idx);
    e.finish("end_turn", { outputTokens: 3, inputTokens: 5 });

    const sse = await drain(e);
    expect(sse).toContain("event: message_start");
    expect(sse).toContain('"model":"my-model"');
    expect(sse).toContain("event: content_block_start");
    expect(sse).toContain("event: content_block_delta");
    expect(sse).toContain("Hello");
    expect(sse).toContain("event: content_block_stop");
    expect(sse).toContain("event: message_delta");
    expect(sse).toContain('"stop_reason":"end_turn"');
    expect(sse).toContain("event: message_stop");
  });

  test("tool_use block: start -> input_json_delta -> finish auto-closes open block", async () => {
    const e = new AnthropicSseEmitter(1_000_000);
    e.start("m", 0);
    const idx = e.startToolUseBlock("tool_1", "get_weather");
    e.appendToolInputJson(idx, '{"city":');
    e.appendToolInputJson(idx, '"Berlin"}');
    // Note: no explicit stopBlock — finish() must close the open block.
    e.finish("tool_use", { outputTokens: 2 });

    const sse = await drain(e);
    expect(sse).toContain('"type":"tool_use"');
    expect(sse).toContain("input_json_delta");
    expect(sse).toContain("event: content_block_stop");
    expect(sse).toContain('"stop_reason":"tool_use"');
  });

  test("start() is idempotent (a second call emits no second message_start)", async () => {
    const e = new AnthropicSseEmitter(1_000_000);
    e.start("m", 1);
    e.start("m", 1);
    e.finish("end_turn", { outputTokens: 0 });
    const sse = await drain(e);
    const count = sse.split("event: message_start").length - 1;
    expect(count).toBe(1);
  });

  test("fail() emits an error event then closes", async () => {
    const e = new AnthropicSseEmitter(1_000_000);
    e.start("m", 0);
    e.fail("upstream exploded", "api_error");
    const sse = await drain(e);
    expect(sse).toContain("event: error");
    expect(sse).toContain('"type":"error"');
    expect(sse).toContain("upstream exploded");
    // After fail() the emitter is closed: further writes are ignored.
    e.appendText(0, "late"); // no throw, no output
    e.finish("end_turn", { outputTokens: 1 }); // no-op
  });

  test("fail() after close is a no-op", async () => {
    const e = new AnthropicSseEmitter(1_000_000);
    e.start("m", 0);
    e.finish("end_turn", { outputTokens: 0 });
    // Already closed -> fail should do nothing (no throw).
    e.fail("too late");
    const sse = await drain(e);
    expect(sse).not.toContain("event: error");
  });

  test("setOnCancel fires when the client cancels the readable", async () => {
    const e = new AnthropicSseEmitter(1_000_000);
    let cancelled = false;
    e.setOnCancel(() => {
      cancelled = true;
    });
    e.start("m", 0);
    // Simulate a client disconnect by cancelling the readable.
    await e.readable.cancel();
    expect(cancelled).toBe(true);
    // Writing after cancel is safely ignored (controller is gone).
    e.appendText(0, "ignored");
  });

  test("keeps the stream valid across a silent gap (ping timer active)", async () => {
    // Tiny ping interval so the keep-alive timer ticks during the idle gap.
    // (Whether a ping frame lands depends on consumer backpressure; we assert
    // the stream stays well-formed and completes rather than a specific ping.)
    const e = new AnthropicSseEmitter(5);
    e.start("m", 0);
    e.startTextBlock();
    await new Promise((r) => setTimeout(r, 30));
    e.appendText(0, "hi");
    e.finish("end_turn", { outputTokens: 0 });
    const sse = await drain(e);
    expect(sse).toContain("event: message_start");
    expect(sse).toContain("event: message_stop");
  });
});
