/**
 * Anthropic SSE emitter + synthetic ping keep-alive (DESIGN §6.4).
 *
 * Emits the Anthropic Messages streaming event grammar with correct
 * `event: <type>\ndata: <json>\n\n` framing:
 *   message_start, content_block_start, content_block_delta,
 *   content_block_stop, message_delta, message_stop, ping
 *
 * The emitter builds a ReadableStream<Uint8Array> and injects synthetic
 * `ping` events during silent gaps. This is mandatory when translating from
 * an upstream that emits no keep-alives of its own (Bedrock ConverseStream),
 * since Claude Code aborts a stream that goes silent for 300s; a ping cadence
 * well under that keeps long "thinking" pauses alive.
 */

import type { IRStopReason } from "../ir/types.ts";

const encoder = new TextEncoder();

/** Default synthetic-ping cadence (ms) during silent gaps. */
export const DEFAULT_PING_INTERVAL_MS = 5_000;

/** Serialize a single SSE event with Anthropic framing. */
export function formatSseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Drives an Anthropic Messages SSE response.
 *
 * Typical lifecycle:
 *   start(model, inputTokens)
 *   startTextBlock() / appendText() ... stopBlock()
 *   startToolUseBlock(id, name) / appendToolInputJson() ... stopBlock()
 *   finish(stopReason, outputTokens)
 *
 * The class exposes `readable` (a ReadableStream<Uint8Array>) to hand to a
 * Response. Writes are enqueued; a timer injects pings when idle.
 */
export class AnthropicSseEmitter {
  readonly readable: ReadableStream<Uint8Array>;
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  private nextIndex = 0;
  private openBlockIndex: number | undefined;
  private started = false;
  private readonly pingIntervalMs: number;
  /** Invoked when the client cancels the readable (disconnect); lets the pump
   *  abort the upstream reader so we stop paying for tokens/sockets. */
  private onCancel: (() => void) | undefined;

  constructor(pingIntervalMs: number = DEFAULT_PING_INTERVAL_MS) {
    this.pingIntervalMs = pingIntervalMs;
    this.readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
      cancel: () => {
        this.cleanup();
        this.onCancel?.();
      },
    });
  }

  /** Register a callback fired when the client cancels the stream. */
  setOnCancel(fn: () => void): void {
    this.onCancel = fn;
  }

  private write(event: string, data: unknown): void {
    if (this.closed) return;
    if (!this.safeEnqueue(encoder.encode(formatSseEvent(event, data)))) return;
    this.resetPingTimer();
  }

  /**
   * Enqueue bytes, guarding against a closed/errored controller (e.g. the
   * client disconnected). A synchronous throw here would otherwise surface as
   * an uncaught rejection in a detached forwarding task; instead we treat it as
   * an implicit close and tear down. Returns false if the enqueue did not land.
   */
  private safeEnqueue(bytes: Uint8Array): boolean {
    if (this.closed) return false;
    try {
      this.controller.enqueue(bytes);
      return true;
    } catch {
      this.cleanup();
      return false;
    }
  }

  private resetPingTimer(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.closed) return;
    this.pingTimer = setInterval(() => {
      if (this.closed) return;
      // Skip if the consumer is applying backpressure or has gone away.
      if (typeof this.controller.desiredSize === "number" && this.controller.desiredSize <= 0) {
        return;
      }
      // Synthetic keep-alive during silent gaps (guarded like every enqueue).
      this.safeEnqueue(encoder.encode(formatSseEvent("ping", { type: "ping" })));
    }, this.pingIntervalMs);
    if (this.pingTimer && typeof this.pingTimer === "object" && "unref" in this.pingTimer) {
      (this.pingTimer as { unref: () => void }).unref();
    }
  }

  /** Idempotent teardown: clear the ping timer, mark closed, close the stream. */
  private cleanup(closeController = false): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = undefined;
    const wasClosed = this.closed;
    this.closed = true;
    if (closeController && !wasClosed) {
      try {
        this.controller.close();
      } catch {
        // already closed/errored by the consumer — nothing to do.
      }
    }
  }

  /** Emit `message_start` with an empty content array and a usage seed. */
  start(model: string, inputTokens: number, id?: string): void {
    if (this.started) return;
    this.started = true;
    const messageId = id ?? `msg_${crypto.randomUUID().replace(/-/g, "")}`;
    this.write("message_start", {
      type: "message_start",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: 0 },
      },
    });
  }

  /** Open a text content block; returns its index. */
  startTextBlock(): number {
    const index = this.nextIndex++;
    this.openBlockIndex = index;
    this.write("content_block_start", {
      type: "content_block_start",
      index,
      content_block: { type: "text", text: "" },
    });
    return index;
  }

  /** Append text to the currently open text block. */
  appendText(index: number, text: string): void {
    if (text.length === 0) return;
    this.write("content_block_delta", {
      type: "content_block_delta",
      index,
      delta: { type: "text_delta", text },
    });
  }

  /** Open a tool_use content block; returns its index. */
  startToolUseBlock(id: string, name: string): number {
    const index = this.nextIndex++;
    this.openBlockIndex = index;
    this.write("content_block_start", {
      type: "content_block_start",
      index,
      content_block: { type: "tool_use", id, name, input: {} },
    });
    return index;
  }

  /** Append a partial JSON fragment to the currently open tool_use block. */
  appendToolInputJson(index: number, partialJson: string): void {
    if (partialJson.length === 0) return;
    this.write("content_block_delta", {
      type: "content_block_delta",
      index,
      delta: { type: "input_json_delta", partial_json: partialJson },
    });
  }

  /** Close the block at `index`. */
  stopBlock(index: number): void {
    this.write("content_block_stop", { type: "content_block_stop", index });
    if (this.openBlockIndex === index) this.openBlockIndex = undefined;
  }

  /**
   * Emit `message_delta` (stop reason + usage) then `message_stop`, and close.
   * `inputTokens` is optional: some upstreams (OpenAI/Mantle streams) only
   * report prompt tokens at the end, so we surface them here in addition to
   * the `message_start` seed.
   */
  finish(stopReason: IRStopReason, usage: { outputTokens: number; inputTokens?: number }): void {
    if (this.closed) return;
    // Close any still-open block defensively.
    if (this.openBlockIndex !== undefined) {
      this.stopBlock(this.openBlockIndex);
    }
    const usageOut: Record<string, number> = { output_tokens: usage.outputTokens };
    if (typeof usage.inputTokens === "number") usageOut.input_tokens = usage.inputTokens;
    this.write("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: usageOut,
    });
    this.write("message_stop", { type: "message_stop" });
    this.cleanup(true);
  }

  /** Abort the stream with an error event, then close. */
  fail(message: string, errorType = "api_error"): void {
    if (this.closed) return;
    this.write("error", { type: "error", error: { type: errorType, message } });
    this.cleanup(true);
  }
}
