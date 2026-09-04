/**
 * Path M — Anthropic <-> OpenAI/Mantle translation (DESIGN §6.3), non-streaming.
 *
 * Used by the `bedrock.mantle.*` backend for non-Claude models via Mantle's
 * OpenAI-compatible `/v1/chat/completions` endpoint.
 *
 * Verified OpenAI/Mantle shapes (DESIGN §11):
 *   response: { choices:[{ message:{ content, tool_calls? }, finish_reason }],
 *               usage:{ prompt_tokens, completion_tokens } }
 *   The Mantle `obfuscation` padding field is ignored.
 */
import { assertNever } from "../errors.ts";
import { buildOpenAIHeaders, postJson } from "../http/upstream.ts";
import type { IRContentBlock, IRResponse, IRStopReason } from "../ir/types.ts";
import { logger } from "../logging/logger.ts";
import type { RouteTarget } from "../router.ts";
import { openAiStreamToAnthropicSse } from "../stream/openai-sse.ts";
import { type SchemaDialect, normalizeForIrPaths, normalizeToolSchema } from "./normalize.ts";
import {
  type JsonObject,
  assertUpstreamOk,
  coerceToolInput,
  irToAnthropicResponse,
  normalizeImageSource,
  parseUpstreamJson,
  sanitizeToolCallId,
  toolResultContentToString,
  validateInboundBlock,
} from "./relay.ts";

/* ------------------------------------------------------------------ *
 * Anthropic request types (shared shape with Path C's inbound view)
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
   * `{ type: "bash_20250825", name: "Bash" }`) omit this — the schema is implied
   * by the versioned `type`. OpenAI/Mantle backends have no such primitive, so
   * server-tools (no `input_schema`) are dropped on this path; forwarding one
   * would emit `parameters: undefined`, which the upstream rejects with a 400.
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

/* ------------------------------------------------------------------ *
 * OpenAI request/response types (subset consumed)
 * ------------------------------------------------------------------ */

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | OpenAIContentPart[] | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}
type OpenAIContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };
interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
interface OpenAIRequestBody {
  model: string;
  messages: OpenAIMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string[];
  tools?: {
    type: "function";
    function: { name: string; description?: string; parameters: unknown };
  }[];
  tool_choice?: "auto" | "required" | "none" | { type: "function"; function: { name: string } };
}
interface OpenAIResponse {
  choices?: {
    message?: {
      content?: string | null;
      /** Reasoning text (Bedrock Mantle: `reasoning`; vLLM: `reasoning_content`). */
      reasoning?: string | null;
      reasoning_content?: string | null;
      /** Structured refusal string (present on 2026 OpenAI-compat responses). */
      refusal?: string | null;
      tool_calls?: OpenAIToolCall[];
    };
    finish_reason?: string;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    // OpenAI-compat prompt caching: cached_tokens is the subset of
    // prompt_tokens served from cache (SR4). Surfaced as Anthropic
    // cache_read_input_tokens.
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

/* ------------------------------------------------------------------ *
 * Anthropic  ->  OpenAI request
 * ------------------------------------------------------------------ */

/**
 * Convert one Anthropic message into one or more OpenAI messages.
 *
 * Anthropic packs tool_use (assistant) and tool_result (user) into content
 * blocks; OpenAI represents these as assistant.tool_calls and separate
 * role:"tool" messages, so a single Anthropic message can expand to several.
 */
function anthropicMessageToOpenAI(msg: AnthropicMessage): OpenAIMessage[] {
  if (typeof msg.content === "string") {
    return [{ role: msg.role, content: msg.content }];
  }

  const textParts: OpenAIContentPart[] = [];
  const toolCalls: OpenAIToolCall[] = [];
  const toolMessages: OpenAIMessage[] = [];

  for (const rawBlock of msg.content) {
    // SEC-6: validate inbound (client-controlled) block shape -> 400 on unknown,
    // rather than letting an unexpected type reach assertNever (500).
    const type = validateInboundBlock(rawBlock, "message content block");
    // thinking / redacted_thinking have no OpenAI Chat-Completions input form;
    // drop them (they are assistant-reasoning artifacts, not user input).
    if (type === "thinking" || type === "redacted_thinking") continue;
    const block = rawBlock as AnthropicBlock;
    switch (block.type) {
      case "text":
        // Skip empty text blocks: some clients (e.g. Claude Code) emit
        // `text: ""` placeholders, which add no signal and can trip strict
        // OpenAI-compatible backends. Non-empty text is preserved verbatim.
        if (block.text.length > 0) textParts.push({ type: "text", text: block.text });
        break;
      case "image": {
        const img = normalizeImageSource(block.source);
        if (!img) break; // unrecognized image source — drop gracefully
        // OpenAI image_url accepts a data: URI (base64) universally. A url-source
        // image passes its URL through: real OpenAI + most external providers
        // accept an http(s) URL, while Bedrock Mantle accepts data:/S3 URLs only
        // (LIVE-VERIFIED: a plain http URL -> 400 "Only inline image data URLs
        // and S3 URLs are supported"). We pass through rather than fetch-and-
        // inline (server-side fetch of an arbitrary URL is an SSRF vector); an
        // unsupported URL surfaces as a clean, relayed upstream 400.
        const url = img.url !== undefined ? img.url : `data:${img.mediaType};base64,${img.data}`;
        textParts.push({ type: "image_url", image_url: { url } });
        break;
      }
      case "tool_use":
        toolCalls.push({
          id: sanitizeToolCallId(block.id),
          type: "function",
          function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
        });
        break;
      case "tool_result":
        toolMessages.push({
          role: "tool",
          tool_call_id: sanitizeToolCallId(block.tool_use_id),
          content: toolResultContentToString(block.content),
        });
        break;
      default:
        // Unreachable: validateInboundBlock already rejected unknown types with
        // a 400, and thinking/redacted_thinking are handled above. This throws
        // (500) only on a genuine internal drift, which is the correct signal.
        assertNever(block, "AnthropicBlock.type");
    }
  }

  const out: OpenAIMessage[] = [];

  // Emit the primary message (assistant with tool_calls, or user/assistant text).
  if (msg.role === "assistant" && toolCalls.length > 0) {
    const assistantMsg: OpenAIMessage = { role: "assistant", tool_calls: toolCalls };
    // OpenAI allows accompanying text content alongside tool_calls.
    if (textParts.length > 0) {
      assistantMsg.content = textParts.every((p) => p.type === "text")
        ? textParts.map((p) => (p as { text: string }).text).join("")
        : textParts;
    } else {
      // TC8: with tool_calls and no text, OpenAI expects content:null explicitly
      // (not omitted or ""). Strict OpenAI-compatible backends validate this.
      assistantMsg.content = null;
    }
    out.push(assistantMsg);
    // Any tool_result blocks on an assistant turn (unusual) still follow it.
    out.push(...toolMessages);
  } else {
    // User (or plain assistant) turn. G1: `role:"tool"` messages MUST immediately
    // follow the preceding assistant `tool_calls` (OpenAI contract) — so tool
    // results come FIRST, then any user text. Emitting the text message before
    // the tool results would insert a `role:"user"` turn between the assistant
    // tool_calls and its results, which strict OpenAI-compatible backends reject
    // ("messages with role 'tool' must be a response to a preceding message with
    // 'tool_calls'").
    out.push(...toolMessages);
    if (textParts.length > 0) {
      const allText = textParts.every((p) => p.type === "text");
      out.push({
        role: msg.role,
        content: allText ? textParts.map((p) => (p as { text: string }).text).join("") : textParts,
      });
    }
  }

  // A message with only tool_result blocks and nothing else still yields the
  // tool messages; if somehow empty, emit an empty user message to stay valid.
  if (out.length === 0) out.push({ role: msg.role, content: "" });

  return out;
}

function anthropicToolChoiceToOpenAI(
  tc: AnthropicToolChoice | undefined,
): OpenAIRequestBody["tool_choice"] | undefined {
  if (!tc) return undefined;
  switch (tc.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "none":
      return "none";
    case "tool":
      return { type: "function", function: { name: tc.name } };
  }
}

/** Build the OpenAI request body from a parsed Anthropic request. */
export function anthropicToOpenAIRequest(
  req: AnthropicRequest,
  model: string,
  dialect: SchemaDialect = "openai",
): OpenAIRequestBody {
  const normalized = normalizeForIrPaths(req as Record<string, unknown>);
  const messages: OpenAIMessage[] = [];

  // System = dedicated prompt + hoisted system-role messages, as one leading
  // OpenAI system message.
  if (normalized.system.length > 0) {
    messages.push({ role: "system", content: normalized.system.join("\n\n") });
  }

  for (const m of normalized.messages) {
    messages.push(
      ...anthropicMessageToOpenAI({ role: m.role, content: m.content } as AnthropicMessage),
    );
  }

  const body: OpenAIRequestBody = { model, messages };
  if (typeof req.max_tokens === "number") body.max_tokens = req.max_tokens;
  if (typeof req.temperature === "number") body.temperature = req.temperature;
  if (typeof req.top_p === "number") body.top_p = req.top_p;
  if (Array.isArray(req.stop_sequences) && req.stop_sequences.length > 0) {
    body.stop = req.stop_sequences;
  }
  // Tools already filtered to custom-only by the normalizer.
  if (normalized.tools.length > 0) {
    body.tools = normalized.tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
        parameters: normalizeToolSchema(t.input_schema, dialect),
      },
    }));
    const tc = anthropicToolChoiceToOpenAI(req.tool_choice);
    if (tc !== undefined) body.tool_choice = tc;
  }
  return body;
}

/* ------------------------------------------------------------------ *
 * OpenAI response  ->  Anthropic
 * ------------------------------------------------------------------ */

/** Map an OpenAI finish_reason to the canonical Anthropic stop reason. */
export function mapOpenAIFinishReason(reason: string | undefined): IRStopReason {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      // Anthropic exposes a first-class `refusal` stop reason (2025/2026); map
      // to it rather than conflating a filtered/refused response with a normal
      // `end_turn`, so Claude Code can distinguish a refusal from a completion.
      return "refusal";
    default:
      // A finish_reason the provider introduced that we don't yet map. Safe to
      // fall back to end_turn, but log it (undefined = normal completion).
      if (reason !== undefined) {
        logger.warn("unmapped OpenAI finish_reason, defaulting to end_turn", { reason });
      }
      return "end_turn";
  }
}

export function openAIResponseToIr(res: OpenAIResponse): IRResponse {
  const choice = res.choices?.[0];
  const message = choice?.message;
  const blocks: IRContentBlock[] = [];

  // Reasoning -> thinking block, FIRST (R2 + R4 ordering: thinking -> text ->
  // tool_use). `reasoning` (Bedrock Mantle) primary, `reasoning_content`
  // (vLLM/DeepSeek-R1) fallback. Unsigned (OpenAI-origin) -> no signature.
  const reasoning = message?.reasoning ?? message?.reasoning_content;
  if (typeof reasoning === "string" && reasoning.length > 0) {
    blocks.push({ type: "thinking", thinking: reasoning });
  }

  if (typeof message?.content === "string" && message.content.length > 0) {
    blocks.push({ type: "text", text: message.content });
  }
  // TC7: surface a structured refusal as visible text so the client sees WHY the
  // model declined, rather than an empty/normal-looking turn. The stop reason is
  // separately mapped to `refusal` via mapOpenAIFinishReason(content_filter).
  if (typeof message?.refusal === "string" && message.refusal.length > 0) {
    blocks.push({ type: "text", text: message.refusal });
  }
  for (const call of message?.tool_calls ?? []) {
    // G10/SEC-10: tool_use.input MUST be a JSON object for the Anthropic client.
    // Truncated or malformed arguments degrade to {} (never a raw string or a
    // non-object), so a downstream consumer never has to defend against it.
    blocks.push({
      type: "tool_use",
      id: call.id,
      name: call.function.name,
      input: coerceToolInput(call.function.arguments),
    });
  }

  const usage = res.usage ?? {};
  const cachedTokens = usage.prompt_tokens_details?.cached_tokens;
  return {
    role: "assistant",
    content: blocks,
    stopReason: mapOpenAIFinishReason(choice?.finish_reason),
    usage: {
      inputTokens: usage.prompt_tokens ?? 0,
      outputTokens: usage.completion_tokens ?? 0,
      // SR4: OpenAI-compat exposes cached prompt tokens (read hits) only; there
      // is no cache-creation counter, so cacheWriteInputTokens stays unset.
      ...(typeof cachedTokens === "number" ? { cacheReadInputTokens: cachedTokens } : {}),
    },
  };
}

/* ------------------------------------------------------------------ *
 * Handler
 * ------------------------------------------------------------------ */

/**
 * Handle a `/v1/messages` request via Path M (OpenAI/Mantle translation), non-streaming.
 */
export async function handleMantleMessages(
  route: RouteTarget,
  bearer: string,
  body: JsonObject,
  signal?: AbortSignal,
): Promise<Response> {
  const parsed = body as AnthropicRequest;
  const openaiBody = anthropicToOpenAIRequest(
    parsed,
    route.invocationId,
    route.strictTools ? "openai-strict" : "openai",
  );
  const headers = buildOpenAIHeaders(bearer);
  const opts = signal ? { signal } : {};

  if (parsed.stream === true) {
    const streamBody = {
      ...openaiBody,
      stream: true,
      stream_options: { include_usage: true },
    };
    const streamOpts = { ...opts, retryTransientStatus: false };
    const upstream = await postJson(
      route.streamPath,
      headers,
      JSON.stringify(streamBody),
      streamOpts,
    );
    await assertUpstreamOk(upstream, route, { requireBody: true });
    const body = upstream.body as ReadableStream<Uint8Array>;
    const sse = openAiStreamToAnthropicSse(body, parsed.model ?? route.invocationId);
    return new Response(sse, {
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
    });
  }

  const upstream = await postJson(route.path, headers, JSON.stringify(openaiBody), opts);
  await assertUpstreamOk(upstream, route);

  const openaiJson = await parseUpstreamJson<OpenAIResponse>(upstream, route);
  const ir = openAIResponseToIr(openaiJson);
  const anthropicBody = irToAnthropicResponse(ir, parsed.model ?? route.invocationId);
  return Response.json(anthropicBody);
}
