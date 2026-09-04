import { readWithIdleTimeout } from "../http/upstream.ts";
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
import { estimateTokensFromChars } from "../paths/relay.ts";
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
      // `vnd.amazon.eventstream` header value types. Headers appear in an
      // arbitrary order and non-string types (timestamp/byte/bool/…) can precede
      // `:event-type`, so we must advance past EVERY value type by its correct
      // length — aborting on the first non-string header silently drops the
      // whole frame (which could be a real contentBlockDelta / messageStop).
      switch (valueType) {
        case 0: // bool true  — 0-byte value
        case 1: // bool false — 0-byte value
          break;
        case 2: // byte
          ho += 1;
          break;
        case 3: // short
          ho += 2;
          break;
        case 4: // integer
          ho += 4;
          break;
        case 5: // long
          ho += 8;
          break;
        case 6: {
          // byte array — 2-byte length prefix + N bytes
          const blen = dv.getUint16(ho);
          ho += 2 + blen;
          break;
        }
        case 7: {
          // string — 2-byte length prefix + N bytes
          const vlen = dv.getUint16(ho);
          ho += 2;
          const value = textDecoder.decode(buf.subarray(ho, ho + vlen));
          ho += vlen;
          if (name === ":event-type") return value;
          break;
        }
        case 8: // timestamp — 8-byte epoch millis
          ho += 8;
          break;
        case 9: // UUID — 16 bytes
          ho += 16;
          break;
        default:
          // Genuinely unknown value type: we cannot know its length, so we can
          // no longer safely advance. Stop scanning this frame's headers.
          return undefined;
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
  delta?: {
    text?: string;
    toolUse?: { input?: string };
    // C1: Converse streams Claude reasoning as reasoningContent deltas — a text
    // fragment, then a trailing signature fragment.
    reasoningContent?: { text?: string; signature?: string };
  };
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
  requestStopSequences?: readonly string[],
): ReadableStream<Uint8Array> {
  const emitter = new AnthropicSseEmitter();
  const decoder = new EventStreamDecoder();

  // Map Converse contentBlockIndex -> emitter block index, and remember kind.
  const blockIndexMap = new Map<number, number>();
  let outputTokens = 0;
  let inputTokens = inputTokensSeed;
  // PC7: accumulate emitted output characters for a token estimate fallback if
  // the Converse metadata usage frame never arrives.
  let outputChars = 0;
  let cacheReadTokens: number | undefined;
  let cacheWriteTokens: number | undefined;
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
        const { done, value } = await readWithIdleTimeout(reader);
        if (done) break;
        if (!value) continue;
        for (const frame of decoder.push(value)) {
          handleFrame(frame);
          // SR3: keep the emitter's best-effort cumulative usage current.
          const runningOutput =
            outputTokens > 0 ? outputTokens : estimateTokensFromChars(outputChars);
          emitter.updateUsage(runningOutput, inputTokens > 0 ? inputTokens : undefined, {
            ...(cacheReadTokens !== undefined ? { cacheReadInputTokens: cacheReadTokens } : {}),
            ...(cacheWriteTokens !== undefined ? { cacheWriteInputTokens: cacheWriteTokens } : {}),
          });
        }
      }
      ensureStarted();
      const finalOutputTokens =
        outputTokens > 0 ? outputTokens : estimateTokensFromChars(outputChars);
      // SR9: Converse's messageStop reports stopReason only, not the matched
      // sequence (verified live). Surface it only when unambiguous — a single
      // configured stop sequence + stopReason "stop_sequence".
      const matchedStopSequence =
        stopReason === "stop_sequence" && requestStopSequences?.length === 1
          ? requestStopSequences[0]
          : undefined;
      emitter.finish(
        stopReason,
        {
          outputTokens: finalOutputTokens,
          inputTokens,
          ...(cacheReadTokens !== undefined ? { cacheReadInputTokens: cacheReadTokens } : {}),
          ...(cacheWriteTokens !== undefined ? { cacheWriteInputTokens: cacheWriteTokens } : {}),
        },
        matchedStopSequence,
      );
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
        if (p.delta?.reasoningContent !== undefined) {
          // C1: Converse reasoning delta -> Anthropic thinking block. Open a
          // thinking block lazily for this converse index; append the text
          // fragment and preserve the REAL signature verbatim when it arrives.
          let idx = blockIndexMap.get(cbi);
          if (idx === undefined) {
            idx = emitter.startThinkingBlock();
            blockIndexMap.set(cbi, idx);
          }
          const rc = p.delta.reasoningContent;
          if (typeof rc.text === "string" && rc.text.length > 0) {
            emitter.appendThinking(idx, rc.text);
            outputChars += rc.text.length;
          }
          if (typeof rc.signature === "string" && rc.signature.length > 0) {
            emitter.appendSignature(idx, rc.signature);
          }
        } else if (p.delta?.text !== undefined) {
          // Open a text block lazily if none exists for this converse index.
          let idx = blockIndexMap.get(cbi);
          if (idx === undefined) {
            idx = emitter.startTextBlock();
            blockIndexMap.set(cbi, idx);
          }
          emitter.appendText(idx, p.delta.text);
          outputChars += p.delta.text.length;
        } else if (p.delta?.toolUse?.input !== undefined) {
          const idx = blockIndexMap.get(cbi);
          if (idx !== undefined) emitter.appendToolInputJson(idx, p.delta.toolUse.input);
          outputChars += p.delta.toolUse.input.length;
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
        const p = frame.payload as {
          usage?: {
            inputTokens?: number;
            outputTokens?: number;
            cacheReadInputTokens?: number;
            cacheWriteInputTokens?: number;
          };
        };
        if (typeof p.usage?.outputTokens === "number") outputTokens = p.usage.outputTokens;
        if (typeof p.usage?.inputTokens === "number") inputTokens = p.usage.inputTokens;
        if (typeof p.usage?.cacheReadInputTokens === "number") {
          cacheReadTokens = p.usage.cacheReadInputTokens;
        }
        if (typeof p.usage?.cacheWriteInputTokens === "number") {
          cacheWriteTokens = p.usage.cacheWriteInputTokens;
        }
        break;
      }
      default:
        break;
    }
  };

  void pump();
  return emitter.readable;
}
