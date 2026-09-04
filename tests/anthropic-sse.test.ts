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

  test("SR3: periodic non-terminal message_delta reports cumulative usage", async () => {
    // Huge ping interval, tiny usage interval so the usage timer ticks.
    const e = new AnthropicSseEmitter(1_000_000, 5);
    // Consume incrementally in the background so the stream isn't under
    // backpressure — this mirrors a live client draining the SSE, letting the
    // periodic usage timer actually emit.
    const reader = e.readable.getReader();
    const dec = new TextDecoder();
    let sse = "";
    const consume = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) sse += dec.decode(value, { stream: true });
      }
    })();

    e.start("m", 7);
    const idx = e.startTextBlock();
    e.appendText(idx, "some output text");
    e.updateUsage(4, 7); // decoder reports best-effort progress
    await new Promise((r) => setTimeout(r, 40)); // let the usage timer tick
    e.finish("end_turn", { outputTokens: 9, inputTokens: 7 });
    await consume;

    // A non-terminal usage delta (stop_reason:null) with the interim count.
    const periodicUsage = sse.match(
      /"delta":\{"stop_reason":null,"stop_sequence":null\},"usage":\{"output_tokens":4/,
    );
    expect(periodicUsage).not.toBeNull();
    // Terminal usage is authoritative (9, not the interim 4).
    expect(sse).toContain(
      '"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":9',
    );
  });

  test("SR3: fail() surfaces best-effort accrued usage before the error", async () => {
    const e = new AnthropicSseEmitter(1_000_000, 1_000_000); // no timer ticks
    e.start("m", 3);
    e.startTextBlock();
    e.updateUsage(11, 3);
    e.fail("upstream died mid-stream");

    const sse = await drain(e);
    // Best-effort usage delta emitted before the error.
    const usageIdx = sse.indexOf('"usage":{"output_tokens":11');
    const errorIdx = sse.indexOf("event: error");
    expect(usageIdx).toBeGreaterThanOrEqual(0);
    expect(errorIdx).toBeGreaterThan(0);
    expect(usageIdx).toBeLessThan(errorIdx);
  });

  test("SR3: usage delta is coalesced (no emit without updateUsage or on no change)", async () => {
    const e = new AnthropicSseEmitter(1_000_000, 5);
    e.start("m", 0); // no updateUsage called
    e.startTextBlock();
    await new Promise((r) => setTimeout(r, 25));
    e.finish("end_turn", { outputTokens: 0 });
    const sse = await drain(e);
    // Only the terminal message_delta — no interim usage-only deltas.
    const deltaCount = sse.split("event: message_delta").length - 1;
    expect(deltaCount).toBe(1);
  });

  test("SR4: finish() surfaces cache tokens in the terminal message_delta", async () => {
    const e = new AnthropicSseEmitter(1_000_000, 1_000_000);
    e.start("m", 100);
    e.startTextBlock();
    e.finish("end_turn", {
      outputTokens: 5,
      inputTokens: 100,
      cacheReadInputTokens: 80,
      cacheWriteInputTokens: 20,
    });
    const sse = await drain(e);
    expect(sse).toContain('"cache_read_input_tokens":80');
    expect(sse).toContain('"cache_creation_input_tokens":20');
  });

  test("SR4: cache tokens from updateUsage flow into finish when not passed explicitly", async () => {
    const e = new AnthropicSseEmitter(1_000_000, 1_000_000);
    e.start("m", 100);
    e.startTextBlock();
    e.updateUsage(5, 100, { cacheReadInputTokens: 64 });
    e.finish("end_turn", { outputTokens: 5, inputTokens: 100 });
    const sse = await drain(e);
    expect(sse).toContain('"cache_read_input_tokens":64');
    expect(sse).not.toContain("cache_creation_input_tokens");
  });

  test("SR9: finish() emits the matched stop_sequence in the terminal message_delta", async () => {
    const e = new AnthropicSseEmitter(1_000_000, 1_000_000);
    e.start("m", 5);
    e.startTextBlock();
    e.finish("stop_sequence", { outputTokens: 3 }, "BLUE");
    const sse = await drain(e);
    expect(sse).toContain('"stop_reason":"stop_sequence","stop_sequence":"BLUE"');
  });

  test("SR2: emits a ping immediately after message_start (liveness before first block)", async () => {
    const e = new AnthropicSseEmitter(1_000_000, 1_000_000); // no timer-driven pings
    e.start("m", 0);
    const idx = e.startTextBlock();
    e.appendText(idx, "hi");
    e.finish("end_turn", { outputTokens: 1 });
    const sse = await drain(e);
    // The ping must appear right after message_start, before content_block_start.
    const pingIdx = sse.indexOf("event: ping");
    const blockIdx = sse.indexOf("event: content_block_start");
    expect(pingIdx).toBeGreaterThanOrEqual(0);
    expect(pingIdx).toBeLessThan(blockIdx);
  });

  test("SR1: a single long-lived timer pings on an idle gap (no per-event churn)", async () => {
    // Tiny ping interval; consume incrementally so backpressure clears and the
    // idle-gap ping can land.
    const e = new AnthropicSseEmitter(5);
    const reader = e.readable.getReader();
    const dec = new TextDecoder();
    let sse = "";
    const consume = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) sse += dec.decode(value, { stream: true });
      }
    })();
    e.start("m", 0);
    e.startTextBlock();
    // Idle for several ping intervals -> the single timer should emit ping(s).
    await new Promise((r) => setTimeout(r, 40));
    e.finish("end_turn", { outputTokens: 0 });
    await consume;
    // The immediate SR2 ping + at least one idle-gap ping from the single timer.
    const pingCount = sse.split("event: ping").length - 1;
    expect(pingCount).toBeGreaterThanOrEqual(2);
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
