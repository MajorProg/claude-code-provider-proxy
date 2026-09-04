import { readWithIdleTimeout } from "../http/upstream.ts";
import { logger } from "../logging/logger.ts";
/**
 * OpenAI/Mantle SSE -> Anthropic SSE bridge (DESIGN §6.4), Path M streaming.
 *
 * Mantle streams OpenAI chat.completion.chunk events as `data: {json}` SSE lines,
 * terminated by `data: [DONE]`. Unlike Anthropic, OpenAI has NO explicit block
 * boundaries, so this bridge synthesizes content_block_start/stop and maintains
 * block indices. Streamed tool-call argument fragments (verified live: first
 * chunk carries id+name+arg-start, later chunks append arguments) are re-emitted
 * as an ordered `input_json_delta` sequence.
 *
 * Text and tool_use occupy separate Anthropic blocks; a text block (index 0) is
 * opened lazily on first content, tool_use blocks follow by OpenAI tool-call index.
 */
import { mapOpenAIFinishReason } from "../paths/mantle.ts";
import { estimateTokensFromChars, sanitizeToolCallId } from "../paths/relay.ts";
import { AnthropicSseEmitter } from "./anthropic-sse.ts";

interface OpenAIStreamChoice {
  delta?: {
    content?: string | Array<{ type?: string; text?: string }> | null;
    /**
     * Streamed refusal text (SR5). Some OpenAI-compatible providers stream a
     * `refusal` delta instead of `content` when the model declines; surface it
     * as visible text so the refusal isn't silently dropped (mirrors the
     * non-streaming TC7 behavior).
     */
    refusal?: string | null;
    /**
     * Reasoning channel. Bedrock Mantle reasoning models (kimi-thinking,
     * minimax-m2, gpt-oss, …) stream `reasoning`; other OpenAI-compatible
     * backends (vLLM/DeepSeek-R1 builds) use `reasoning_content`. Verified live
     * against Bedrock Mantle 2026-09. Both map to an Anthropic `thinking` block.
     */
    reasoning?: string | null;
    reasoning_content?: string | null;
    tool_calls?: {
      index?: number;
      id?: string;
      function?: { name?: string; arguments?: string };
    }[];
  };
  finish_reason?: string | null;
}
interface OpenAIStreamChunk {
  choices?: OpenAIStreamChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

/**
 * Flatten an OpenAI streaming `delta.content` to plain text (SR5). Most
 * providers send a string, but some send an array of content parts
 * (`[{type:"text",text:"..."}]`); concatenate the text of each part. A null /
 * undefined / non-text shape yields "".
 */
export function deltaContentToText(
  content: string | Array<{ type?: string; text?: string }> | null | undefined,
): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("");
  }
  return "";
}

/**
 * Parse an SSE byte stream into event payload strings, buffering partial lines.
 *
 * SSE-spec-correct (SR6, WHATWG event-stream):
 *   - Multiple `data:` lines within one event are ACCUMULATED and joined with
 *     `\n`; the event is dispatched on a blank line (the event terminator).
 *   - Lines beginning with `:` are comments (e.g. heartbeat) and are ignored.
 *   - A single leading space after the field colon is stripped.
 *
 * Preserves the common OpenAI/Mantle case (one `data: {json}` line followed by a
 * blank line) while also correctly reassembling providers that split a single
 * JSON payload across multiple `data:` lines. Yields one string per event.
 */
export class SseLineParser {
  private buffer = "";
  /** Accumulated `data:` lines for the event currently being built. */
  private dataLines: string[] = [];
  /** Running char count of the event being accumulated (SR7 size guard). */
  private dataEventChars = 0;
  // Per-instance decoder: a shared module-level TextDecoder with {stream:true}
  // carries partial multi-byte UTF-8 state across calls, so sharing it between
  // concurrent streams corrupts interleaved output. One decoder per parser.
  private readonly decoder = new TextDecoder();

  /**
   * SR7: hard cap on the raw unparsed buffer (a pending partial line) AND on the
   * accumulated multi-line event, so a stream that never sends a newline — or a
   * single pathological/adversarial `data:` line — can't grow parser memory
   * without bound. On overflow we throw; the stream read loop's catch fails the
   * stream cleanly (same as an idle-timeout).
   */
  private static readonly MAX_BUFFER_CHARS = 16 * 1024 * 1024; // 16 MiB

  push(chunk: Uint8Array): string[] {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    if (this.buffer.length > SseLineParser.MAX_BUFFER_CHARS) {
      throw new Error(
        `SSE line buffer exceeded ${SseLineParser.MAX_BUFFER_CHARS} bytes without a line terminator`,
      );
    }
    const payloads: string[] = [];
    // Read-cursor scan: advance `start` per line and slice the remaining buffer
    // ONCE per push, not per line (avoids O(L^2)).
    let start = 0;
    for (;;) {
      const nl = this.buffer.indexOf("\n", start);
      if (nl === -1) break;
      let end = nl;
      if (end > start && this.buffer.charCodeAt(end - 1) === 13) end--; // strip trailing \r
      const line = this.buffer.slice(start, end);
      start = nl + 1;

      if (line.length === 0) {
        // Blank line -> dispatch the accumulated event (if any).
        if (this.dataLines.length > 0) {
          payloads.push(this.dataLines.join("\n"));
          this.dataLines = [];
          this.dataEventChars = 0;
        }
        continue;
      }
      if (line.startsWith(":")) continue; // comment line (e.g. heartbeat)
      if (line.startsWith("data:")) {
        // Strip the field name + a single optional leading space.
        let value = line.slice(5);
        if (value.startsWith(" ")) value = value.slice(1);
        this.dataLines.push(value);
        this.dataEventChars += value.length;
        if (this.dataEventChars > SseLineParser.MAX_BUFFER_CHARS) {
          throw new Error(
            `SSE event accumulated over ${SseLineParser.MAX_BUFFER_CHARS} bytes without a terminator`,
          );
        }
      }
      // Other SSE fields (event:, id:, retry:) are not used by this bridge.
    }
    if (start > 0) this.buffer = this.buffer.slice(start);
    return payloads;
  }

  /**
   * Flush any pending event when the stream ends (SR6 robustness). A
   * well-behaved SSE stream terminates its final event with a blank line, but a
   * provider that closes the connection immediately after the last `data:` line
   * (no trailing blank) would otherwise leave that event un-dispatched. Call
   * once after the read loop completes. Returns the pending payload(s), if any.
   */
  flush(): string[] {
    // Consume any complete trailing line still in the buffer (no newline yet).
    const tail = this.buffer.trimEnd();
    if (tail.length > 0) {
      if (tail.startsWith("data:")) {
        let value = tail.slice(5);
        if (value.startsWith(" ")) value = value.slice(1);
        this.dataLines.push(value);
      }
      this.buffer = "";
    }
    if (this.dataLines.length === 0) return [];
    const payload = this.dataLines.join("\n");
    this.dataLines = [];
    this.dataEventChars = 0;
    return [payload];
  }
}

/**
 * Bridge an OpenAI/Mantle SSE byte stream to an Anthropic SSE Response body.
 */
export function openAiStreamToAnthropicSse(
  upstreamBody: ReadableStream<Uint8Array>,
  model: string,
  inputTokensSeed = 0,
): ReadableStream<Uint8Array> {
  const emitter = new AnthropicSseEmitter();
  const parser = new SseLineParser();

  let started = false;
  let thinkingBlockIndex: number | undefined;
  let textBlockIndex: number | undefined;
  // OpenAI tool-call index -> streamed tool-call state (SR8). The Anthropic
  // block is opened lazily once an id is known; arg fragments arriving before
  // the id are buffered in `pendingArgs`.
  interface ToolCallEntry {
    blockIdx: number | undefined;
    pendingArgs: string;
    name: string;
  }
  const toolBlocks = new Map<number, ToolCallEntry>();
  let stopReason: ReturnType<typeof mapOpenAIFinishReason> = "end_turn";
  // SR11: set once a finish_reason arrives; late trailing deltas are then
  // ignored so they can't reopen content out of R4 order.
  let finished = false;
  let outputTokens = 0;
  let inputTokens = 0;
  let cacheReadTokens: number | undefined;
  // PC7: accumulate emitted output characters (text + thinking + tool args) so
  // we can estimate output tokens if the upstream never sends usage.
  let outputChars = 0;

  const ensureStarted = (): void => {
    if (!started) {
      emitter.start(model, inputTokensSeed);
      started = true;
    }
  };

  // R4 ordering: a thinking block must precede text/tool_use. As soon as any
  // text or tool content begins, close the open thinking block so the emitted
  // order is thinking -> text -> tool_use.
  const closeThinking = (): void => {
    if (thinkingBlockIndex !== undefined) {
      emitter.stopBlock(thinkingBlockIndex);
      thinkingBlockIndex = undefined;
    }
  };

  // G5: close an open text block. Anthropic requires the text content_block_stop
  // BEFORE a following tool_use content_block_start, so when text and a tool_call
  // interleave (even within one chunk) the text block is closed first.
  const closeText = (): void => {
    if (textBlockIndex !== undefined) {
      emitter.stopBlock(textBlockIndex);
      textBlockIndex = undefined;
    }
  };

  const closeAllBlocks = (): void => {
    closeThinking();
    closeText();
    for (const entry of toolBlocks.values()) {
      // SR8: a tool call that streamed args/name but never an id still needs a
      // block so its arguments aren't silently dropped — open it now with a
      // stable synthetic id derived from the accumulated name.
      if (entry.blockIdx === undefined) {
        entry.blockIdx = emitter.startToolUseBlock(
          sanitizeToolCallId(entry.name || "tool_call"),
          entry.name,
        );
        if (entry.pendingArgs.length > 0) {
          emitter.appendToolInputJson(entry.blockIdx, entry.pendingArgs);
          entry.pendingArgs = "";
        }
      }
      emitter.stopBlock(entry.blockIdx);
    }
    toolBlocks.clear();
  };

  const handleChunk = (chunk: OpenAIStreamChunk): void => {
    ensureStarted();
    if (typeof chunk.usage?.completion_tokens === "number") {
      outputTokens = chunk.usage.completion_tokens;
    }
    if (typeof chunk.usage?.prompt_tokens === "number") {
      inputTokens = chunk.usage.prompt_tokens;
    }
    if (typeof chunk.usage?.prompt_tokens_details?.cached_tokens === "number") {
      cacheReadTokens = chunk.usage.prompt_tokens_details.cached_tokens;
    }
    const choice = chunk.choices?.[0];
    if (!choice) return;

    // SR11: once a finish_reason has been seen, the assistant turn is complete.
    // Some providers emit trailing/duplicate deltas after it; applying them
    // would reopen content (e.g. a text block AFTER tool_use) and violate the
    // Anthropic thinking->text->tool_use ordering (R4). Ignore late deltas —
    // but still let a terminal usage-only chunk update token counts (handled
    // above, before this guard).
    if (finished) return;

    // Reasoning channel -> Anthropic thinking block (R1). `reasoning` (Bedrock
    // Mantle) primary, `reasoning_content` (vLLM/DeepSeek-R1) fallback. Opened
    // lazily and kept as index 0 until text/tool content arrives. No signature
    // is fabricated (OpenAI-origin reasoning is unsigned).
    const reasoning = choice.delta?.reasoning ?? choice.delta?.reasoning_content;
    if (typeof reasoning === "string" && reasoning.length > 0) {
      // Only open thinking while no text/tool block has started yet (ordering).
      if (textBlockIndex === undefined && toolBlocks.size === 0) {
        if (thinkingBlockIndex === undefined) thinkingBlockIndex = emitter.startThinkingBlock();
        emitter.appendThinking(thinkingBlockIndex, reasoning);
        outputChars += reasoning.length;
      }
    }

    const content = deltaContentToText(choice.delta?.content);
    if (content.length > 0) {
      // SR11/R4: never OPEN a text block once a tool block has started — that
      // would place text after tool_use. Append to an already-open text block
      // (interleaved text before the tool is fine); otherwise drop the late text.
      if (textBlockIndex !== undefined) {
        emitter.appendText(textBlockIndex, content);
        outputChars += content.length;
      } else if (toolBlocks.size === 0) {
        closeThinking(); // thinking -> text ordering
        textBlockIndex = emitter.startTextBlock();
        emitter.appendText(textBlockIndex, content);
        outputChars += content.length;
      }
    }

    // SR5: a streamed refusal surfaces as visible text (not silently dropped),
    // mirroring the non-streaming TC7 refusal-as-text behavior.
    const refusal = choice.delta?.refusal;
    if (typeof refusal === "string" && refusal.length > 0) {
      if (textBlockIndex !== undefined) {
        emitter.appendText(textBlockIndex, refusal);
        outputChars += refusal.length;
      } else if (toolBlocks.size === 0) {
        closeThinking();
        textBlockIndex = emitter.startTextBlock();
        emitter.appendText(textBlockIndex, refusal);
        outputChars += refusal.length;
      }
    }

    for (const tc of choice.delta?.tool_calls ?? []) {
      closeThinking(); // thinking -> tool_use ordering
      closeText(); // G5: text -> tool_use ordering (stop text before the tool)
      const oaiIndex = tc.index ?? 0;
      let entry = toolBlocks.get(oaiIndex);
      if (entry === undefined) {
        entry = { blockIdx: undefined, pendingArgs: "", name: "" };
        toolBlocks.set(oaiIndex, entry);
      }
      if (tc.function?.name) entry.name = tc.function.name;
      const rawId = tc.id;
      if (entry.blockIdx === undefined && typeof rawId === "string" && rawId.length > 0) {
        // SR8: id now known -> open the block with the sanitized id (G3) and
        // flush any argument fragments that arrived before the id.
        entry.blockIdx = emitter.startToolUseBlock(sanitizeToolCallId(rawId), entry.name);
        if (entry.pendingArgs.length > 0) {
          emitter.appendToolInputJson(entry.blockIdx, entry.pendingArgs);
          entry.pendingArgs = "";
        }
      }
      const argFragment = tc.function?.arguments;
      if (argFragment) {
        outputChars += argFragment.length;
        if (entry.blockIdx === undefined) {
          entry.pendingArgs += argFragment; // buffer until the block opens
        } else {
          emitter.appendToolInputJson(entry.blockIdx, argFragment);
        }
      }
    }

    if (choice.finish_reason) {
      stopReason = mapOpenAIFinishReason(choice.finish_reason);
      finished = true; // SR11: subsequent late deltas are ignored (R4 ordering)
    }

    // SR3: keep the emitter's best-effort cumulative usage current so a
    // periodic message_delta (and any early-death usage) reflects progress.
    // Prefer real upstream output tokens; fall back to the char estimate.
    const runningOutput = outputTokens > 0 ? outputTokens : estimateTokensFromChars(outputChars);
    emitter.updateUsage(runningOutput, inputTokens > 0 ? inputTokens : undefined, {
      ...(cacheReadTokens !== undefined ? { cacheReadInputTokens: cacheReadTokens } : {}),
    });
  };

  const pump = async (): Promise<void> => {
    const reader = upstreamBody.getReader();
    // Client disconnect -> abort the upstream read so we stop consuming tokens.
    emitter.setOnCancel(() => {
      void reader.cancel().catch(() => {});
    });
    try {
      const processPayload = (payload: string): void => {
        if (payload === "[DONE]") return;
        let chunk: OpenAIStreamChunk;
        try {
          chunk = JSON.parse(payload) as OpenAIStreamChunk;
        } catch {
          // Skip an unparseable SSE data chunk rather than aborting the stream.
          // Visible at debug (steady-state stays quiet).
          logger.debug("skipped unparseable OpenAI SSE chunk");
          return;
        }
        handleChunk(chunk);
      };
      for (;;) {
        const { done, value } = await readWithIdleTimeout(reader);
        if (done) break;
        if (!value) continue;
        for (const payload of parser.push(value)) processPayload(payload);
      }
      // Flush a final event that lacked a trailing blank-line terminator (SR6).
      for (const payload of parser.flush()) processPayload(payload);
      ensureStarted();
      closeAllBlocks();
      // PC7: if the upstream never reported usage, estimate output tokens from
      // the accumulated output characters so telemetry isn't a misleading 0.
      const finalOutputTokens =
        outputTokens > 0 ? outputTokens : estimateTokensFromChars(outputChars);
      emitter.finish(stopReason, {
        outputTokens: finalOutputTokens,
        inputTokens,
        ...(cacheReadTokens !== undefined ? { cacheReadInputTokens: cacheReadTokens } : {}),
      });
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

  void pump();
  return emitter.readable;
}
