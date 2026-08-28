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
import { AnthropicSseEmitter } from "./anthropic-sse.ts";

interface OpenAIStreamChoice {
  delta?: {
    content?: string | null;
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
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * Parse an SSE byte stream into `data:` payload strings (one per event),
 * buffering partial lines. Yields the raw payload after `data: `.
 */
export class SseLineParser {
  private buffer = "";
  // Per-instance decoder: a shared module-level TextDecoder with {stream:true}
  // carries partial multi-byte UTF-8 state across calls, so sharing it between
  // concurrent streams corrupts interleaved output. One decoder per parser.
  private readonly decoder = new TextDecoder();

  push(chunk: Uint8Array): string[] {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    const payloads: string[] = [];
    // SSE events are separated by blank lines, but Mantle emits one event per
    // line as `data: {...}`. Read-cursor scan: advance `start` per line and
    // slice the remaining buffer ONCE per push, not per line (avoids O(L^2)).
    let start = 0;
    for (;;) {
      const nl = this.buffer.indexOf("\n", start);
      if (nl === -1) break;
      let end = nl;
      if (end > start && this.buffer.charCodeAt(end - 1) === 13) end--; // strip trailing \r
      const line = this.buffer.slice(start, end);
      start = nl + 1;
      if (line.startsWith("data:")) {
        payloads.push(line.slice(5).trimStart());
      }
    }
    if (start > 0) this.buffer = this.buffer.slice(start);
    return payloads;
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
  let textBlockIndex: number | undefined;
  // OpenAI tool-call index -> emitter block index.
  const toolBlocks = new Map<number, number>();
  let stopReason: ReturnType<typeof mapOpenAIFinishReason> = "end_turn";
  let outputTokens = 0;
  let inputTokens = 0;

  const ensureStarted = (): void => {
    if (!started) {
      emitter.start(model, inputTokensSeed);
      started = true;
    }
  };

  const closeAllBlocks = (): void => {
    if (textBlockIndex !== undefined) {
      emitter.stopBlock(textBlockIndex);
      textBlockIndex = undefined;
    }
    for (const idx of toolBlocks.values()) emitter.stopBlock(idx);
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
    const choice = chunk.choices?.[0];
    if (!choice) return;

    const content = choice.delta?.content;
    if (typeof content === "string" && content.length > 0) {
      if (textBlockIndex === undefined) textBlockIndex = emitter.startTextBlock();
      emitter.appendText(textBlockIndex, content);
    }

    for (const tc of choice.delta?.tool_calls ?? []) {
      const oaiIndex = tc.index ?? 0;
      let blockIdx = toolBlocks.get(oaiIndex);
      if (blockIdx === undefined) {
        // First fragment for this tool call carries id + name.
        blockIdx = emitter.startToolUseBlock(tc.id ?? "", tc.function?.name ?? "");
        toolBlocks.set(oaiIndex, blockIdx);
      }
      const argFragment = tc.function?.arguments;
      if (argFragment) emitter.appendToolInputJson(blockIdx, argFragment);
    }

    if (choice.finish_reason) {
      stopReason = mapOpenAIFinishReason(choice.finish_reason);
    }
  };

  const pump = async (): Promise<void> => {
    const reader = upstreamBody.getReader();
    // Client disconnect -> abort the upstream read so we stop consuming tokens.
    emitter.setOnCancel(() => {
      void reader.cancel().catch(() => {});
    });
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        for (const payload of parser.push(value)) {
          if (payload === "[DONE]") continue;
          let chunk: OpenAIStreamChunk;
          try {
            chunk = JSON.parse(payload) as OpenAIStreamChunk;
          } catch {
            // Skip an unparseable SSE data chunk rather than aborting the stream.
            // Visible at debug (steady-state stays quiet).
            logger.debug("skipped unparseable OpenAI SSE chunk");
            continue;
          }
          handleChunk(chunk);
        }
      }
      ensureStarted();
      closeAllBlocks();
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

  void pump();
  return emitter.readable;
}
