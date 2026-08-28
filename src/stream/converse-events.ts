import { logger } from "../logging/logger.ts";
/**
 * Bedrock ConverseStream -> Anthropic SSE bridge (DESIGN §6.4), Path C streaming.
 *
 * Bedrock's ConverseStream response is the binary `application/vnd.amazon.eventstream`
 * framing (verified live):
 *   [4B total length][4B headers length][4B prelude CRC][headers][JSON payload][4B message CRC]
 * Each frame carries a `:event-type` header naming the Converse event, and a JSON payload.
 *
 * Converse event sequence -> Anthropic SSE mapping (verified DESIGN §11):
 *   messageStart{role}                              -> message_start
 *   contentBlockStart{start.toolUse{id,name}}       -> content_block_start (tool_use)
 *   contentBlockDelta{delta.text}                   -> content_block_delta (text_delta)
 *   contentBlockDelta{delta.toolUse.input "<json>"} -> content_block_delta (input_json_delta)
 *   contentBlockStop{index}                         -> content_block_stop
 *   messageStop{stopReason}                         -> message_delta (stop_reason)
 *   metadata{usage}                                 -> fold usage into message_delta
 *
 * Converse emits no keep-alive events, so the AnthropicSseEmitter injects
 * synthetic pings during silent gaps.
 */
import { mapConverseStopReason } from "../paths/converse.ts";
import { AnthropicSseEmitter } from "./anthropic-sse.ts";

/** A decoded eventstream frame: its `:event-type` and parsed JSON payload. */
export interface EventStreamFrame {
  eventType: string;
  payload: Record<string, unknown>;
}

const textDecoder = new TextDecoder();

/**
 * Incrementally decode `vnd.amazon.eventstream` bytes into frames.
 * Feed chunks via `push`; complete frames are returned. Buffers partial frames.
 */
export class EventStreamDecoder {
  /** Unconsumed partial frame carried across pushes (bounded by one frame). */
  private tail = new Uint8Array(0);

  push(chunk: Uint8Array): EventStreamFrame[] {
    // Concatenate only the (small) carried partial-frame tail with the new
    // chunk — never the whole accumulated stream — so decoding a k-chunk / L-byte
    // response is O(L), not O(L^2).
    let buf: Uint8Array;
    if (this.tail.length === 0) {
      buf = chunk;
    } else {
      buf = new Uint8Array(this.tail.length + chunk.length);
      buf.set(this.tail, 0);
      buf.set(chunk, this.tail.length);
    }

    const frames: EventStreamFrame[] = [];
    let offset = 0;
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

    while (buf.length - offset >= 12) {
      const totalLen = dv.getUint32(offset);
      if (totalLen < 16 || totalLen > 16 * 1024 * 1024) {
        // Corrupt framing; drop the rest to avoid an infinite loop.
        offset = buf.length;
        break;
      }
      if (buf.length - offset < totalLen) break; // wait for more bytes

      const headersLen = dv.getUint32(offset + 4);
      const headersStart = offset + 12;
      const headersEnd = headersStart + headersLen;
      const payloadEnd = offset + totalLen - 4; // minus trailing message CRC

      const eventType = this.readEventType(buf, headersStart, headersEnd);
      const payloadBytes = buf.subarray(headersEnd, payloadEnd);
      let payload: Record<string, unknown> = {};
      if (payloadBytes.length > 0) {
        try {
          payload = JSON.parse(textDecoder.decode(payloadBytes)) as Record<string, unknown>;
        } catch {
          // Malformed frame payload — skip its contents rather than aborting the
          // whole stream. Visible at debug (steady-state stays quiet).
          logger.debug("skipped unparseable Converse event payload");
          payload = {};
        }
      }
      if (eventType) frames.push({ eventType, payload });
      offset += totalLen;
    }

    // Retain only the unconsumed partial frame. Copy it out (slice) so we don't
    // pin the larger `buf`/`chunk` backing store for the stream's lifetime.
    this.tail = offset < buf.length ? buf.slice(offset) : new Uint8Array(0);
    return frames;
  }

  /** Read the `:event-type` string header from a frame's header block. */
  private readEventType(buf: Uint8Array, start: number, end: number): string | undefined {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let ho = start;
    while (ho < end) {
      const nameLen = buf[ho] as number;
      ho += 1;
      const name = textDecoder.decode(buf.subarray(ho, ho + nameLen));
      ho += nameLen;
      const valueType = buf[ho] as number;
      ho += 1;
      // Header value types: 7 = string (2-byte length prefix). Others are rare
      // in Converse event headers; handle string, skip minimally otherwise.
      if (valueType === 7) {
        const vlen = dv.getUint16(ho);
        ho += 2;
        const value = textDecoder.decode(buf.subarray(ho, ho + vlen));
        ho += vlen;
        if (name === ":event-type") return value;
      } else {
        // Unknown/unsupported header value type — cannot safely continue.
        break;
      }
    }
    return undefined;
  }
}

/* ------------------------------------------------------------------ *
 * Converse frames -> Anthropic SSE
 * ------------------------------------------------------------------ */

interface ContentBlockDelta {
  contentBlockIndex?: number;
  delta?: { text?: string; toolUse?: { input?: string } };
}
interface ContentBlockStart {
  contentBlockIndex?: number;
  start?: { toolUse?: { toolUseId?: string; name?: string } };
}

/**
 * Bridge a ConverseStream byte stream to an Anthropic SSE Response body.
 *
 * @param upstreamBody  The upstream ConverseStream response body (binary eventstream).
 * @param model         Model id to report in message_start.
 * @param inputTokensSeed Optional known input token count for the message_start seed.
 * @returns A ReadableStream<Uint8Array> of Anthropic SSE.
 */
export function converseStreamToAnthropicSse(
  upstreamBody: ReadableStream<Uint8Array>,
  model: string,
  inputTokensSeed = 0,
): ReadableStream<Uint8Array> {
  const emitter = new AnthropicSseEmitter();
  const decoder = new EventStreamDecoder();

  // Map Converse contentBlockIndex -> emitter block index, and remember kind.
  const blockIndexMap = new Map<number, number>();
  let outputTokens = 0;
  let inputTokens = inputTokensSeed;
  let stopReason: ReturnType<typeof mapConverseStopReason> = "end_turn";
  let started = false;

  const ensureStarted = (): void => {
    if (!started) {
      emitter.start(model, inputTokensSeed);
      started = true;
    }
  };

  const pump = async (): Promise<void> => {
    const reader = upstreamBody.getReader();
    // Client disconnect -> abort the upstream Bedrock read.
    emitter.setOnCancel(() => {
      void reader.cancel().catch(() => {});
    });
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        for (const frame of decoder.push(value)) {
          handleFrame(frame);
        }
      }
      ensureStarted();
      emitter.finish(stopReason, { outputTokens, inputTokens });
    } catch (err) {
      ensureStarted();
      await reader.cancel(err).catch(() => {});
      emitter.fail(err instanceof Error ? err.message : "stream error");
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // Already released (e.g. after cancel()) — ignore.
      }
    }
  };

  const handleFrame = (frame: EventStreamFrame): void => {
    switch (frame.eventType) {
      case "messageStart": {
        ensureStarted();
        break;
      }
      case "contentBlockStart": {
        ensureStarted();
        const p = frame.payload as ContentBlockStart;
        const cbi = p.contentBlockIndex ?? 0;
        const toolUse = p.start?.toolUse;
        if (toolUse) {
          const idx = emitter.startToolUseBlock(toolUse.toolUseId ?? "", toolUse.name ?? "");
          blockIndexMap.set(cbi, idx);
        }
        break;
      }
      case "contentBlockDelta": {
        ensureStarted();
        const p = frame.payload as ContentBlockDelta;
        const cbi = p.contentBlockIndex ?? 0;
        if (p.delta?.text !== undefined) {
          // Open a text block lazily if none exists for this converse index.
          let idx = blockIndexMap.get(cbi);
          if (idx === undefined) {
            idx = emitter.startTextBlock();
            blockIndexMap.set(cbi, idx);
          }
          emitter.appendText(idx, p.delta.text);
        } else if (p.delta?.toolUse?.input !== undefined) {
          const idx = blockIndexMap.get(cbi);
          if (idx !== undefined) emitter.appendToolInputJson(idx, p.delta.toolUse.input);
        }
        break;
      }
      case "contentBlockStop": {
        const p = frame.payload as { contentBlockIndex?: number };
        const cbi = p.contentBlockIndex ?? 0;
        const idx = blockIndexMap.get(cbi);
        if (idx !== undefined) {
          emitter.stopBlock(idx);
          blockIndexMap.delete(cbi);
        }
        break;
      }
      case "messageStop": {
        const p = frame.payload as { stopReason?: string };
        stopReason = mapConverseStopReason(p.stopReason);
        break;
      }
      case "metadata": {
        const p = frame.payload as { usage?: { inputTokens?: number; outputTokens?: number } };
        if (typeof p.usage?.outputTokens === "number") outputTokens = p.usage.outputTokens;
        if (typeof p.usage?.inputTokens === "number") inputTokens = p.usage.inputTokens;
        break;
      }
      default:
        break;
    }
  };

  void pump();
  return emitter.readable;
}
