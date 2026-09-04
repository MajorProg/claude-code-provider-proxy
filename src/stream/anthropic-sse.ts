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
 * since Claude Code aborts a stream that goes silent for 180s (claude-code
 * #85322/#88900, 2026); the 5s ping cadence stays well under that to keep long
 * "thinking" pauses alive.
 */

import type { IRStopReason } from "../ir/types.ts";

const encoder = new TextEncoder();

/** Default synthetic-ping cadence (ms) during silent gaps. */
export const DEFAULT_PING_INTERVAL_MS = 5_000;

/**
 * Default cadence (ms) for incremental cumulative-usage `message_delta`s
 * (SR3). A stream that dies before `finish()` otherwise reports zero output
 * usage; periodic best-effort usage lets a live cost meter (`chat-page.ts`)
 * track spend as it accrues. The terminal `finish()` `message_delta` stays
 * authoritative.
 */
export const DEFAULT_USAGE_INTERVAL_MS = 5_000;

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
  private readonly usageIntervalMs: number;
  /** SR3: latest best-effort cumulative usage, surfaced on periodic ticks and
   *  on early death (fail/cancel). Reported by decoders via updateUsage(). */
  private runningOutputTokens = 0;
  private runningInputTokens: number | undefined;
  private runningCacheReadTokens: number | undefined;
  private runningCacheWriteTokens: number | undefined;
  private usageReported = false;
  private lastEmittedOutputTokens = -1;
  private usageTimer: ReturnType<typeof setInterval> | undefined;
  /** SR1: timestamp of the last enqueued event; the single ping interval pings
   *  only when the idle gap since this exceeds the ping interval. */
  private lastWriteAt = Date.now();
  /** Invoked when the client cancels the readable (disconnect); lets the pump
   *  abort the upstream reader so we stop paying for tokens/sockets. */
  private onCancel: (() => void) | undefined;

  constructor(
    pingIntervalMs: number = DEFAULT_PING_INTERVAL_MS,
    usageIntervalMs: number = DEFAULT_USAGE_INTERVAL_MS,
  ) {
    this.pingIntervalMs = pingIntervalMs;
    this.usageIntervalMs = usageIntervalMs;
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

  /**
   * SR3: record the latest best-effort cumulative usage. Decoders call this as
   * output accrues so a periodic `message_delta` (and any early-death
   * best-effort usage) reflects real progress. This never emits by itself; the
   * cadence timer and fail/cancel paths do the emitting.
   */
  updateUsage(
    outputTokens: number,
    inputTokens?: number,
    cache?: { cacheReadInputTokens?: number; cacheWriteInputTokens?: number },
  ): void {
    if (outputTokens > this.runningOutputTokens) this.runningOutputTokens = outputTokens;
    if (typeof inputTokens === "number") this.runningInputTokens = inputTokens;
    if (typeof cache?.cacheReadInputTokens === "number") {
      this.runningCacheReadTokens = cache.cacheReadInputTokens;
    }
    if (typeof cache?.cacheWriteInputTokens === "number") {
      this.runningCacheWriteTokens = cache.cacheWriteInputTokens;
    }
    this.usageReported = true;
  }

  /**
   * Emit a non-terminal cumulative-usage `message_delta` (empty delta, usage
   * only). Coalesced: skips when nothing changed since the last emit or under
   * backpressure. The terminal `finish()` `message_delta` remains authoritative.
   */
  private emitUsageDelta(force = false): void {
    if (this.closed || !this.started || !this.usageReported) return;
    if (this.runningOutputTokens === this.lastEmittedOutputTokens) return;
    if (
      !force &&
      typeof this.controller.desiredSize === "number" &&
      this.controller.desiredSize <= 0
    ) {
      return; // consumer applying backpressure — skip this periodic tick
    }
    const usageOut: Record<string, number> = { output_tokens: this.runningOutputTokens };
    if (typeof this.runningInputTokens === "number") {
      usageOut.input_tokens = this.runningInputTokens;
    }
    if (typeof this.runningCacheReadTokens === "number") {
      usageOut.cache_read_input_tokens = this.runningCacheReadTokens;
    }
    if (typeof this.runningCacheWriteTokens === "number") {
      usageOut.cache_creation_input_tokens = this.runningCacheWriteTokens;
    }
    this.write("message_delta", {
      type: "message_delta",
      delta: { stop_reason: null, stop_sequence: null },
      usage: usageOut,
    });
    this.lastEmittedOutputTokens = this.runningOutputTokens;
  }

  private startUsageTimer(): void {
    if (this.usageTimer) clearInterval(this.usageTimer);
    if (this.closed || this.usageIntervalMs <= 0) return;
    this.usageTimer = setInterval(() => this.emitUsageDelta(), this.usageIntervalMs);
    if (this.usageTimer && typeof this.usageTimer === "object" && "unref" in this.usageTimer) {
      (this.usageTimer as { unref: () => void }).unref();
    }
  }

  private write(event: string, data: unknown): void {
    if (this.closed) return;
    if (!this.safeEnqueue(encoder.encode(formatSseEvent(event, data)))) return;
    // SR1: record activity for the single long-lived ping timer to observe,
    // instead of tearing down and recreating a timer on every event.
    this.lastWriteAt = Date.now();
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

  /**
   * SR1: start ONE long-lived ping interval for the stream's lifetime. It fires
   * a synthetic keep-alive only when the gap since the last write exceeds the
   * ping interval — so an active stream never emits a ping, and we avoid the
   * per-event clearInterval/setInterval churn of the old design (which created
   * and destroyed a timer on every single SSE event).
   */
  private startPingTimer(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.closed) return;
    this.pingTimer = setInterval(() => {
      if (this.closed) return;
      // Only ping after a genuine silent gap; an actively-writing stream resets
      // lastWriteAt on every event so this stays false.
      if (Date.now() - this.lastWriteAt < this.pingIntervalMs) return;
      // Skip if the consumer is applying backpressure or has gone away.
      if (typeof this.controller.desiredSize === "number" && this.controller.desiredSize <= 0) {
        return;
      }
      // Synthetic keep-alive during silent gaps (guarded like every enqueue).
      if (this.safeEnqueue(encoder.encode(formatSseEvent("ping", { type: "ping" })))) {
        this.lastWriteAt = Date.now();
      }
    }, this.pingIntervalMs);
    if (this.pingTimer && typeof this.pingTimer === "object" && "unref" in this.pingTimer) {
      (this.pingTimer as { unref: () => void }).unref();
    }
  }

  /** Idempotent teardown: clear the ping timer, mark closed, close the stream. */
  private cleanup(closeController = false): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = undefined;
    if (this.usageTimer) clearInterval(this.usageTimer);
    this.usageTimer = undefined;
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
    this.runningInputTokens = inputTokens;
    this.startUsageTimer();
    this.startPingTimer();
    // SR2: emit one ping immediately after message_start so a client sees
    // liveness before the first content block (models can take seconds to
    // produce the first token, especially with a long "thinking" prelude).
    this.safeEnqueue(encoder.encode(formatSseEvent("ping", { type: "ping" })));
  }

  /**
   * Open a `thinking` content block; returns its index. Anthropic requires a
   * thinking block, when present, to be the FIRST block of the assistant turn
   * (thinking → text → tool_use), so callers must open it before any text/tool
   * block (R4 ordering).
   */
  startThinkingBlock(): number {
    const index = this.nextIndex++;
    this.openBlockIndex = index;
    this.write("content_block_start", {
      type: "content_block_start",
      index,
      content_block: { type: "thinking", thinking: "" },
    });
    return index;
  }

  /** Append reasoning text to the currently open thinking block. */
  appendThinking(index: number, text: string): void {
    if (text.length === 0) return;
    this.write("content_block_delta", {
      type: "content_block_delta",
      index,
      delta: { type: "thinking_delta", thinking: text },
    });
  }

  /**
   * Append a thinking `signature` to the open thinking block (emitted just
   * before `content_block_stop`, per the Anthropic/Bedrock streaming grammar).
   * Only used when the source provider supplies a real signature (Path C /
   * Converse). MUST NOT be fabricated for unsigned (OpenAI-origin) reasoning.
   */
  appendSignature(index: number, signature: string): void {
    if (signature.length === 0) return;
    this.write("content_block_delta", {
      type: "content_block_delta",
      index,
      delta: { type: "signature_delta", signature },
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
  finish(
    stopReason: IRStopReason,
    usage: {
      outputTokens: number;
      inputTokens?: number;
      cacheReadInputTokens?: number;
      cacheWriteInputTokens?: number;
    },
    stopSequence?: string,
  ): void {
    if (this.closed) return;
    // Close any still-open block defensively.
    if (this.openBlockIndex !== undefined) {
      this.stopBlock(this.openBlockIndex);
    }
    const usageOut: Record<string, number> = { output_tokens: usage.outputTokens };
    if (typeof usage.inputTokens === "number") usageOut.input_tokens = usage.inputTokens;
    // SR4: prefer an explicit terminal cache count, else the last best-effort
    // value recorded via updateUsage().
    const cacheRead = usage.cacheReadInputTokens ?? this.runningCacheReadTokens;
    const cacheWrite = usage.cacheWriteInputTokens ?? this.runningCacheWriteTokens;
    if (typeof cacheRead === "number") usageOut.cache_read_input_tokens = cacheRead;
    if (typeof cacheWrite === "number") usageOut.cache_creation_input_tokens = cacheWrite;
    this.write("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: stopSequence ?? null },
      usage: usageOut,
    });
    this.write("message_stop", { type: "message_stop" });
    this.cleanup(true);
  }

  /** Abort the stream with an error event, then close. */
  fail(message: string, errorType = "api_error"): void {
    if (this.closed) return;
    // SR3: surface best-effort accrued usage before the terminal error so a
    // stream that dies mid-flight doesn't report zero output usage.
    this.emitUsageDelta(true);
    this.write("error", { type: "error", error: { type: errorType, message } });
    this.cleanup(true);
  }
}
