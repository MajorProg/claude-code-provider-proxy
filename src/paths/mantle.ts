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
import { normalizeForIrPaths } from "./normalize.ts";
import {
  type JsonObject,
  assertUpstreamOk,
  irToAnthropicResponse,
  parseUpstreamJson,
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
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };
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
    message?: { content?: string | null; tool_calls?: OpenAIToolCall[] };
    finish_reason?: string;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/* ------------------------------------------------------------------ *
 * Anthropic  ->  OpenAI request
 * ------------------------------------------------------------------ */

function toolResultContentToString(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        b && typeof b === "object" && "text" in b
          ? String((b as { text: unknown }).text)
          : JSON.stringify(b),
      )
      .join("");
  }
  return JSON.stringify(content);
}

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

  for (const block of msg.content) {
    switch (block.type) {
      case "text":
        // Skip empty text blocks: some clients (e.g. Claude Code) emit
        // `text: ""` placeholders, which add no signal and can trip strict
        // OpenAI-compatible backends. Non-empty text is preserved verbatim.
        if (block.text.length > 0) textParts.push({ type: "text", text: block.text });
        break;
      case "image":
        textParts.push({
          type: "image_url",
          image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
        });
        break;
      case "tool_use":
        toolCalls.push({
          id: block.id,
          type: "function",
          function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
        });
        break;
      case "tool_result":
        toolMessages.push({
          role: "tool",
          tool_call_id: block.tool_use_id,
          content: toolResultContentToString(block.content),
        });
        break;
      default:
        // Exhaustive over AnthropicBlock (compile error on a new variant;
        // throw on an unexpected on-the-wire type).
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
    }
    out.push(assistantMsg);
  } else if (textParts.length > 0) {
    // Collapse pure-text content to a string; keep parts array if images present.
    const allText = textParts.every((p) => p.type === "text");
    out.push({
      role: msg.role,
      content: allText ? textParts.map((p) => (p as { text: string }).text).join("") : textParts,
    });
  }

  // Tool results become their own role:"tool" messages, appended after.
  out.push(...toolMessages);

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
export function anthropicToOpenAIRequest(req: AnthropicRequest, model: string): OpenAIRequestBody {
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
        parameters: t.input_schema,
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
      // No direct Anthropic stop_reason for a content filter; map to end_turn
      // (closest forced-completion). Intentional CONFLATION — documented.
      return "end_turn";
    default:
      // A finish_reason the provider introduced that we don't yet map. Safe to
      // fall back to end_turn, but log it (undefined = normal completion).
      if (reason !== undefined) {
        logger.warn("unmapped OpenAI finish_reason, defaulting to end_turn", { reason });
      }
      return "end_turn";
  }
}

function openAIResponseToIr(res: OpenAIResponse): IRResponse {
  const choice = res.choices?.[0];
  const message = choice?.message;
  const blocks: IRContentBlock[] = [];

  if (typeof message?.content === "string" && message.content.length > 0) {
    blocks.push({ type: "text", text: message.content });
  }
  for (const call of message?.tool_calls ?? []) {
    let input: unknown = {};
    try {
      input = call.function.arguments ? JSON.parse(call.function.arguments) : {};
    } catch {
      // Preserve the raw string if it is not valid JSON.
      input = call.function.arguments;
    }
    blocks.push({ type: "tool_use", id: call.id, name: call.function.name, input });
  }

  const usage = res.usage ?? {};
  return {
    role: "assistant",
    content: blocks,
    stopReason: mapOpenAIFinishReason(choice?.finish_reason),
    usage: {
      inputTokens: usage.prompt_tokens ?? 0,
      outputTokens: usage.completion_tokens ?? 0,
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
  const openaiBody = anthropicToOpenAIRequest(parsed, route.invocationId);
  const headers = buildOpenAIHeaders(bearer);
  const opts = signal ? { signal } : {};

  if (parsed.stream === true) {
    const streamBody = {
      ...openaiBody,
      stream: true,
      stream_options: { include_usage: true },
    };
    const upstream = await postJson(route.streamPath, headers, JSON.stringify(streamBody), opts);
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
