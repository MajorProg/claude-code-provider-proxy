/**
 * Path C — Anthropic <-> Bedrock Converse translation (DESIGN §6.2), non-streaming.
 *
 * Used by the `bedrock.converse.*` backend for all models (Claude and non-Claude).
 * Translates an Anthropic Messages request into a Converse request, calls
 * `/model/{id}/converse`, and maps the Converse response back to an Anthropic
 * Messages response.
 *
 * Verified Converse shapes (DESIGN §11):
 *   request:  { messages:[{role,content:[{text}|{toolUse}|{toolResult}|{image}]}],
 *               system:[{text}], inferenceConfig:{maxTokens,temperature,topP,stopSequences},
 *               toolConfig:{tools:[{toolSpec:{name,description,inputSchema:{json}}}],toolChoice} }
 *   response: { output:{message:{role,content:[{text}|{toolUse{toolUseId,name,input}}]}},
 *               stopReason, usage:{inputTokens,outputTokens,cacheReadInputTokens?,cacheWriteInputTokens?} }
 */
import { assertNever } from "../errors.ts";
import { buildConverseHeaders, postJson } from "../http/upstream.ts";
import type {
  IRContentBlock,
  IRMessage,
  IRResponse,
  IRStopReason,
  IRToolChoice,
} from "../ir/types.ts";
import { logger } from "../logging/logger.ts";
import type { RouteTarget } from "../router.ts";
import { converseStreamToAnthropicSse } from "../stream/converse-events.ts";
import { normalizeForIrPaths, normalizeToolSchema } from "./normalize.ts";
import {
  type JsonObject,
  assertUpstreamOk,
  irToAnthropicResponse,
  normalizeImageSource,
  parseUpstreamJson,
  toolResultContentToString,
  validateInboundBlock,
} from "./relay.ts";

/* ------------------------------------------------------------------ *
 * Anthropic request  ->  IR
 * ------------------------------------------------------------------ */

interface AnthropicRequest {
  model?: string;
  system?: unknown;
  messages?: AnthropicMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  stream?: boolean;
}
interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicBlock[];
}
type AnthropicBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: unknown; is_error?: boolean }
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string } | { type: "url"; url: string };
    };
interface AnthropicTool {
  name: string;
  description?: string;
  /**
   * JSON Schema for custom tools. Anthropic *server-tools* (e.g.
   * `{ type: "bash_20250825", name: "Bash" }`) omit this entirely — the schema
   * is implied by the versioned `type`. Non-Claude Converse/Mantle backends have
   * no such primitive, so server-tools (no `input_schema`) are dropped on this
   * path; only tools carrying a real schema are forwarded.
   */
  input_schema?: Record<string, unknown>;
  /** Present on Anthropic server-tools (versioned type, e.g. "bash_20250825"). */
  type?: string;
}
type AnthropicToolChoice =
  | { type: "auto" }
  | { type: "any" }
  | { type: "none" }
  | { type: "tool"; name: string };

function anthropicBlockToIr(block: AnthropicBlock): IRContentBlock {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "tool_use":
      return { type: "tool_use", id: block.id, name: block.name, input: block.input };
    case "tool_result":
      return {
        type: "tool_result",
        toolUseId: block.tool_use_id,
        content: toolResultContentToString(block.content),
        ...(block.is_error !== undefined ? { isError: block.is_error } : {}),
      };
    case "image": {
      const img = normalizeImageSource(block.source);
      if (!img) return { type: "text", text: "[unsupported image omitted]" };
      return {
        type: "image",
        mediaType: img.mediaType,
        ...(img.data !== undefined ? { data: img.data } : {}),
        ...(img.url !== undefined ? { url: img.url } : {}),
      };
    }
    default:
      // Exhaustive over AnthropicBlock: a new variant becomes a compile error;
      // an unexpected on-the-wire type throws instead of returning undefined.
      return assertNever(block, "AnthropicBlock.type");
  }
}

/**
 * True when a content block carries no usable payload. Empty text blocks
 * (`text: ""`) are sent by some clients (e.g. Claude Code) but rejected by
 * Converse, which requires every content block to be non-empty. Dropping them
 * keeps the request valid without altering semantics.
 */
function isEmptyBlock(block: IRContentBlock): boolean {
  return block.type === "text" && block.text.length === 0;
}

function anthropicMessageToIr(msg: AnthropicMessage): IRMessage {
  if (typeof msg.content === "string") {
    return { role: msg.role, content: [{ type: "text", text: msg.content }] };
  }
  const raw: IRContentBlock[] = [];
  for (const rawBlock of msg.content) {
    // SEC-6: validate inbound (client-controlled) block shape -> 400 on unknown.
    const type = validateInboundBlock(rawBlock, "message content block");
    if (type === "thinking") {
      const b = rawBlock as { thinking?: unknown; signature?: unknown };
      raw.push({
        type: "thinking",
        thinking: typeof b.thinking === "string" ? b.thinking : "",
        ...(typeof b.signature === "string" ? { signature: b.signature } : {}),
      });
      continue;
    }
    // redacted_thinking has no Converse representation; drop it.
    if (type === "redacted_thinking") continue;
    raw.push(anthropicBlockToIr(rawBlock as AnthropicBlock));
  }
  const content = raw.filter((b) => !isEmptyBlock(b));
  return { role: msg.role, content };
}

function anthropicToolChoiceToIr(tc: AnthropicToolChoice | undefined): IRToolChoice | undefined {
  if (!tc) return undefined;
  if (tc.type === "tool") return { type: "tool", name: tc.name };
  return { type: tc.type };
}

/* ------------------------------------------------------------------ *
 * IR  ->  Converse request
 * ------------------------------------------------------------------ */

/** Map an image media type to a Converse image format token. */
function imageFormat(mediaType: string): string {
  const slash = mediaType.indexOf("/");
  return slash === -1 ? mediaType : mediaType.slice(slash + 1);
}

function irBlockToConverse(block: IRContentBlock): Record<string, unknown> {
  switch (block.type) {
    case "text":
      return { text: block.text };
    case "thinking":
      // IR thinking -> Converse reasoningContent. Preserve the signature
      // verbatim when present (Path C / Converse is Claude, so the signature is
      // valid and must round-trip unmodified). An unsigned thinking block
      // (OpenAI-origin) is not expected on the Converse request path, but is
      // still forwarded as reasoning text without a signature.
      return {
        reasoningContent: {
          reasoningText: {
            text: block.thinking,
            ...(block.signature ? { signature: block.signature } : {}),
          },
        },
      };
    case "tool_use":
      return { toolUse: { toolUseId: block.id, name: block.name, input: block.input } };
    case "tool_result":
      return {
        toolResult: {
          toolUseId: block.toolUseId,
          content: [{ text: block.content }],
          ...(block.isError ? { status: "error" } : {}),
        },
      };
    case "image":
      // Converse's image source is bytes-only (no URL support). A base64 image
      // sends its bytes; a url-source image (TC6) has no Converse equivalent, so
      // it degrades to a placeholder text block rather than emitting an invalid
      // `source.bytes: undefined`.
      if (block.data === undefined) {
        return { text: "[image url omitted: not supported by this model]" };
      }
      return {
        image: { format: imageFormat(block.mediaType), source: { bytes: block.data } },
      };
  }
}

interface ConverseRequestBody {
  messages: { role: string; content: Record<string, unknown>[] }[];
  system?: { text: string }[];
  inferenceConfig?: {
    maxTokens?: number;
    temperature?: number;
    topP?: number;
    stopSequences?: string[];
  };
  toolConfig?: {
    tools: { toolSpec: { name: string; description?: string; inputSchema: { json: unknown } } }[];
    toolChoice?: Record<string, unknown>;
  };
}

function irToolChoiceToConverse(tc: IRToolChoice): Record<string, unknown> | undefined {
  switch (tc.type) {
    case "auto":
      return { auto: {} };
    case "any":
      return { any: {} };
    case "tool":
      return { tool: { name: tc.name } };
    case "none":
      // Converse has no explicit "none"; omit toolChoice to let the model decide.
      return undefined;
  }
}

/** Build the Converse request body from a parsed Anthropic request. */
export function anthropicToConverseRequest(req: AnthropicRequest): ConverseRequestBody {
  const normalized = normalizeForIrPaths(req as Record<string, unknown>);

  // Normalized messages are user/assistant only, empty turns already dropped.
  const kept = normalized.messages
    .map((m) => anthropicMessageToIr({ role: m.role, content: m.content } as AnthropicMessage))
    .filter((m) => m.content.length > 0);

  // TC4: Converse REQUIRES strictly alternating user/assistant roles and rejects
  // two consecutive same-role messages (ValidationException). Anthropic inbound
  // can legitimately contain consecutive same-role turns, and normalization can
  // *create* adjacency by dropping an empty turn between two same-role turns.
  // Merge consecutive same-role turns by concatenating their content blocks.
  const merged: typeof kept = [];
  for (const m of kept) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) {
      merged[merged.length - 1] = { role: last.role, content: [...last.content, ...m.content] };
    } else {
      merged.push(m);
    }
  }

  const messages = merged.map((m) => ({
    role: m.role,
    content: m.content.map(irBlockToConverse),
  }));

  const body: ConverseRequestBody = { messages };

  // System = dedicated prompt + any hoisted system-role messages (in order).
  if (normalized.system.length > 0) {
    body.system = [{ text: normalized.system.join("\n\n") }];
  }

  const inferenceConfig: NonNullable<ConverseRequestBody["inferenceConfig"]> = {};
  if (typeof req.max_tokens === "number") inferenceConfig.maxTokens = req.max_tokens;
  if (typeof req.temperature === "number") inferenceConfig.temperature = req.temperature;
  if (typeof req.top_p === "number") inferenceConfig.topP = req.top_p;
  if (Array.isArray(req.stop_sequences) && req.stop_sequences.length > 0) {
    inferenceConfig.stopSequences = req.stop_sequences;
  }
  if (Object.keys(inferenceConfig).length > 0) body.inferenceConfig = inferenceConfig;

  // Tools are already filtered to custom-only by the normalizer.
  if (normalized.tools.length > 0) {
    const tools = normalized.tools.map((t) => ({
      toolSpec: {
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
        inputSchema: { json: normalizeToolSchema(t.input_schema, "converse") },
      },
    }));
    const toolChoiceIr = anthropicToolChoiceToIr(req.tool_choice);
    const toolChoice = toolChoiceIr ? irToolChoiceToConverse(toolChoiceIr) : undefined;
    body.toolConfig = { tools, ...(toolChoice ? { toolChoice } : {}) };
  }

  return body;
}

/* ------------------------------------------------------------------ *
 * Converse response  ->  Anthropic response
 * ------------------------------------------------------------------ */

interface ConverseResponse {
  output?: { message?: { role?: string; content?: ConverseResponseBlock[] } };
  stopReason?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheWriteInputTokens?: number;
  };
}
type ConverseResponseBlock =
  | { text: string }
  | { toolUse: { toolUseId: string; name: string; input: unknown } }
  | { reasoningContent: { reasoningText?: { text?: string; signature?: string } } };

/** Map a Converse stopReason to the canonical Anthropic stop reason. */
export function mapConverseStopReason(reason: string | undefined): IRStopReason {
  switch (reason) {
    case "end_turn":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "stop_sequence":
      return "stop_sequence";
    case "content_filtered":
      // Anthropic `refusal` stop reason (2025/2026) is the closest match for a
      // filtered response — surface it rather than conflating with end_turn.
      return "refusal";
    default:
      // A stop reason the Converse API introduced that we don't yet map.
      // Falling back to end_turn is safe, but log it so the gap is visible
      // (undefined = normal streaming completion, not logged).
      if (reason !== undefined) {
        logger.warn("unmapped Converse stopReason, defaulting to end_turn", { reason });
      }
      return "end_turn";
  }
}

export function converseResponseToIr(
  res: ConverseResponse,
  requestStopSequences?: readonly string[],
): IRResponse {
  const blocks: IRContentBlock[] = [];
  for (const b of res.output?.message?.content ?? []) {
    if ("text" in b) {
      blocks.push({ type: "text", text: b.text });
    } else if ("reasoningContent" in b) {
      // C1: Claude-on-Converse emits reasoningContent.reasoningText{text,
      // signature}. Carry it into an IRThinkingBlock, preserving the REAL
      // signature so it round-trips to the Anthropic client verbatim (the
      // signature is what lets the client resubmit the thinking block on a
      // follow-up turn). An empty/absent reasoning text is skipped.
      const rt = b.reasoningContent.reasoningText;
      const text = rt?.text ?? "";
      if (text.length > 0) {
        blocks.push({
          type: "thinking",
          thinking: text,
          ...(rt?.signature ? { signature: rt.signature } : {}),
        });
      }
    } else if ("toolUse" in b) {
      blocks.push({
        type: "tool_use",
        id: b.toolUse.toolUseId,
        name: b.toolUse.name,
        input: b.toolUse.input,
      });
    }
  }
  const usage = res.usage ?? {};
  const stopReason = mapConverseStopReason(res.stopReason);
  // SR9: Bedrock Converse reports stopReason:"stop_sequence" but does NOT return
  // which configured sequence matched (verified live — no field on the response
  // or the streaming messageStop frame). We can surface it only when the match
  // is unambiguous: exactly one sequence was configured.
  const matchedStopSequence =
    stopReason === "stop_sequence" && requestStopSequences?.length === 1
      ? requestStopSequences[0]
      : undefined;
  return {
    role: "assistant",
    content: blocks,
    stopReason,
    ...(matchedStopSequence !== undefined ? { stopSequence: matchedStopSequence } : {}),
    usage: {
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      ...(usage.cacheReadInputTokens !== undefined
        ? { cacheReadInputTokens: usage.cacheReadInputTokens }
        : {}),
      ...(usage.cacheWriteInputTokens !== undefined
        ? { cacheWriteInputTokens: usage.cacheWriteInputTokens }
        : {}),
    },
  };
}

/* ------------------------------------------------------------------ *
 * Handler
 * ------------------------------------------------------------------ */

/**
 * Handle a `/v1/messages` request via Path C (Converse translation), non-streaming.
 */
export async function handleConverseMessages(
  route: RouteTarget,
  bearer: string,
  body: JsonObject,
  signal?: AbortSignal,
): Promise<Response> {
  const parsed = body as AnthropicRequest;
  const converseBody = anthropicToConverseRequest(parsed);
  const headers = buildConverseHeaders(bearer);
  const streaming = parsed.stream === true;
  const opts = signal ? { signal } : {};

  if (streaming) {
    const streamOpts = { ...opts, retryTransientStatus: false };
    const upstream = await postJson(
      route.streamPath,
      headers,
      JSON.stringify(converseBody),
      streamOpts,
    );
    await assertUpstreamOk(upstream, route, { requireBody: true });
    const body = upstream.body as ReadableStream<Uint8Array>;
    const sse = converseStreamToAnthropicSse(
      body,
      parsed.model ?? route.invocationId,
      0,
      parsed.stop_sequences,
    );
    return new Response(sse, {
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
    });
  }

  const upstream = await postJson(route.path, headers, JSON.stringify(converseBody), opts);
  await assertUpstreamOk(upstream, route);

  const converseJson = await parseUpstreamJson<ConverseResponse>(upstream, route);
  const ir = converseResponseToIr(converseJson, parsed.stop_sequences);
  const anthropicBody = irToAnthropicResponse(ir, parsed.model ?? route.invocationId);
  return Response.json(anthropicBody);
}
