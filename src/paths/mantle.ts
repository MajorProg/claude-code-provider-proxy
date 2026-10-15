/**
 * Path M — Anthropic <-> OpenAI/Mantle translation (DESIGN §6.3), non-streaming.
 *
 * Used by the `bedrock.mantle.*` backend for non-Claude models via Mantle's
 * OpenAI-compatible `/v1/chat/completions` endpoint, and by external
 * `type: "openai"` providers.
 *
 * Verified OpenAI/Mantle shapes (DESIGN §11):
 *   response: { choices:[{ message:{ content, tool_calls? }, finish_reason }],
 *               usage:{ prompt_tokens, completion_tokens } }
 *   The Mantle `obfuscation` padding field is ignored.
 *
 * z.ai openai-wire providers (config `zaiWire` block) additionally gain the
 * z.ai-specific request/response semantics ported from the chimera-employee
 * llm-router (audit 2026-10-10): Preserved Thinking (reasoning_content replay
 * + clear_thinking activation), reasoning_effort mapping, request_id
 * correlation, and typed stream-error finish_reason classification.
 */
import type { ZaiWireConfig } from "../config.ts";
import { BadRequestError, UpstreamError, assertNever } from "../errors.ts";
import { buildOpenAIHeaders, postJson } from "../http/upstream.ts";
import type { IRContentBlock, IRResponse, IRStopReason } from "../ir/types.ts";
import { logger } from "../logging/logger.ts";
import { currentRequestContext } from "../logging/request-context.ts";
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
  /**
   * Inbound Anthropic thinking config. On the z.ai openai wire
   * (`zaiWire` config): forced-thinking model families (config
   * `forcedThinkingModels`) cannot honor `disabled` and have the field
   * dropped (logged once per model); optional-thinking z.ai models receive
   * `thinking:{type:"disabled"}` so a client's opt-out is not silently
   * billed as reasoning output. Every OTHER zai-wire request carries
   * `{type:"enabled", clear_thinking:false}` — Preserved Thinking
   * activation. Non-zai-wire lanes ignore the field entirely (legacy drop).
   */
  thinking?: { type?: unknown };
  /**
   * Proxy extension (not part of the Anthropic wire): an effort-ladder value
   * (low|medium|high|xhigh|max) mapped onto z.ai's OpenAI-wire
   * `reasoning_effort` (max|high|low) for `zaiWire` providers whose model
   * matches `reasoningEffortModels`. Never forwarded as-is upstream.
   */
  ccpp_reasoning_effort?: unknown;
  /**
   * Proxy extension (not part of the Anthropic wire): a caller-supplied
   * correlation id forwarded as z.ai's `request_id` (sanitized to 6–64
   * chars, [A-Za-z0-9_-]) so z.ai-side lookups correlate with ours; echoed
   * back to the client as `x-ccpp-upstream-request-id`. When absent, the
   * proxy's own request id is used.
   */
  ccpp_request_id?: unknown;
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
    }
  /** Assistant reasoning artifacts (validated at runtime — untrusted JSON). */
  | { type: "thinking"; thinking?: unknown; signature?: unknown }
  | { type: "redacted_thinking"; data?: unknown };
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
  /**
   * z.ai Preserved Thinking INPUT field: prior-turn assistant reasoning
   * replayed on the corresponding assistant message (z.ai docs: "send back
   * the complete, unmodified reasoning_content"). zai-wire lanes only —
   * unverified on other OpenAI-compatible backends.
   */
  reasoning_content?: string;
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
  /**
   * z.ai openai-wire thinking switch. `clear_thinking: false` activates
   * Preserved Thinking on the standard API endpoint (ships OFF there): z.ai
   * then keeps prior reasoning in cacheable context when we replay
   * `reasoning_content` on assistant messages. zai-wire lanes only.
   */
  thinking?: { type: "enabled" | "disabled"; clear_thinking?: boolean };
  /** z.ai openai-wire reasoning depth (max|high|low). */
  reasoning_effort?: "max" | "high" | "low";
  /** z.ai caller-supplied correlation id (6–64 chars; echoed back by z.ai). */
  request_id?: string;
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
 * z.ai openai-wire controls (config `zaiWire` block)
 * ------------------------------------------------------------------ */

/** Compile + memoize a model regex source (config strings, compiled once). */
const regexCache = new Map<string, RegExp>();
function compiledModelRegexes(sources: readonly string[]): RegExp[] {
  return sources.map((src) => {
    let re = regexCache.get(src);
    if (re === undefined) {
      re = new RegExp(src);
      regexCache.set(src, re);
    }
    return re;
  });
}

/** True when `model` matches one of the config's forced-thinking patterns. */
export function isZaiForcedThinkingModel(model: string, cfg: ZaiWireConfig): boolean {
  return compiledModelRegexes(cfg.forcedThinkingModels).some((re) => re.test(model));
}

/** True when `model` matches one of the config's reasoning_effort patterns. */
export function zaiSupportsReasoningEffort(model: string, cfg: ZaiWireConfig): boolean {
  return compiledModelRegexes(cfg.reasoningEffortModels).some((re) => re.test(model));
}

/**
 * Effort ladder (low|medium|high|xhigh|max) → z.ai `reasoning_effort`
 * (max|high|low). Unknown values map to undefined (never forwarded — an
 * invalid value would 400 upstream).
 */
const EFFORT_TO_REASONING_EFFORT: Readonly<Record<string, "max" | "high" | "low">> = {
  low: "low",
  medium: "high",
  high: "high",
  xhigh: "max",
  max: "max",
};

export function mapEffortToReasoningEffort(effort: string): "max" | "high" | "low" | undefined {
  return EFFORT_TO_REASONING_EFFORT[effort];
}

/** Forced-thinking drop notices fire ONCE per model, not per request. */
const forcedThinkingDropLogged = new Set<string>();

/* ------------------------------------------------------------------ *
 * z.ai stream-error finish_reasons
 * ------------------------------------------------------------------ */

/**
 * z.ai surfaces abnormal in-flight termination INSIDE the SSE stream as
 * `finish_reason` values, not HTTP codes (z.ai docs, Errors "Streaming note"
 * + chat-completion finish_reason enum): network_error, sensitive,
 * model_context_window_exceeded. Left unclassified they end the stream
 * looking like a normal completion (the generic mapper defaults unknown
 * reasons to end_turn) — a silent data-loss failure mode.
 */
export type ZaiStreamErrorKind = "transient" | "refusal" | "context_overflow";

/** Typed classification for one z.ai error finish_reason. */
export interface ZaiStreamErrorClassification {
  readonly kind: ZaiStreamErrorKind;
  /** Anthropic-wire error type for the typed surface (event or thrown error). */
  readonly anthropicErrorType: "api_error" | "invalid_request_error" | "request_too_large";
  /** Human-readable message; the z.ai finish_reason is always preserved. */
  readonly message: string;
}

const ZAI_STREAM_ERROR_FINISH_REASONS: ReadonlyMap<string, ZaiStreamErrorClassification> = new Map([
  [
    "network_error",
    {
      kind: "transient",
      anthropicErrorType: "api_error",
      message:
        "z.ai upstream network error (finish_reason=network_error): transient — retriable upstream class",
    },
  ],
  [
    "sensitive",
    {
      kind: "refusal",
      anthropicErrorType: "invalid_request_error",
      message:
        "z.ai content filter terminated the stream (finish_reason=sensitive): non-retriable — revise the prompt",
    },
  ],
  [
    "model_context_window_exceeded",
    {
      kind: "context_overflow",
      anthropicErrorType: "request_too_large",
      message:
        "z.ai context window exceeded (finish_reason=model_context_window_exceeded): non-retriable — reduce the prompt",
    },
  ],
]);

/** Classify a z.ai error finish_reason; undefined for normal/unknown reasons. */
export function classifyZaiStreamFinishError(
  reason: string,
): ZaiStreamErrorClassification | undefined {
  return ZAI_STREAM_ERROR_FINISH_REASONS.get(reason);
}

/* ------------------------------------------------------------------ *
 * z.ai request_id passthrough
 * ------------------------------------------------------------------ */

/** z.ai request_id wire limits (z.ai chat-completion docs). */
export const ZAI_REQUEST_ID_MIN_CHARS = 6;
export const ZAI_REQUEST_ID_MAX_CHARS = 64;

/**
 * Sanitize a caller id to z.ai's request_id limits: 6–64 chars from a
 * header/token-safe charset. Disallowed characters are stripped; a result
 * below the minimum (nothing usable left) falls back to a fresh UUID (valid
 * charset + length, correlation discoverable via the forwarding log); an
 * over-long id is truncated at the limit. Pure — never throws.
 */
export function sanitizeZaiRequestId(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, "");
  if (cleaned.length < ZAI_REQUEST_ID_MIN_CHARS) {
    return crypto.randomUUID();
  }
  return cleaned.length > ZAI_REQUEST_ID_MAX_CHARS
    ? cleaned.slice(0, ZAI_REQUEST_ID_MAX_CHARS)
    : cleaned;
}

/**
 * zai-wire gating for {@link anthropicToOpenAIRequest}: the z.ai-specific
 * request fields (`thinking`, `reasoning_effort`, `request_id`,
 * preserved-thinking replay) are only proven against api.z.ai — other
 * OpenAI-compatible backends (Bedrock Mantle, mistral, …) must not receive
 * them.
 */
export interface ZaiWireOptions {
  zaiWire: ZaiWireConfig;
  /**
   * Correlation id source: the inbound `ccpp_request_id` extension when the
   * client sent one, else the proxy's own request id. Forwarded (sanitized)
   * as z.ai's `request_id`.
   */
  requestId?: string | undefined;
}

/** Per-message translation options (threaded from {@link ZaiWireOptions}). */
interface MessageTranslateOptions {
  /** True on zai-wire lanes: assistant thinking blocks replay as
   * `reasoning_content` (Preserved Thinking). */
  preserveThinking: boolean;
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
function anthropicMessageToOpenAI(
  msg: AnthropicMessage,
  opts?: MessageTranslateOptions,
): OpenAIMessage[] {
  if (typeof msg.content === "string") {
    return [{ role: msg.role, content: msg.content }];
  }

  const textParts: OpenAIContentPart[] = [];
  const toolCalls: OpenAIToolCall[] = [];
  const toolMessages: OpenAIMessage[] = [];
  // Preserved-thinking replay: the turn's reasoning runs, in block order.
  const reasoningParts: string[] = [];

  for (const rawBlock of msg.content) {
    // SEC-6: validate inbound (client-controlled) block shape -> 400 on unknown,
    // rather than letting an unexpected type reach assertNever (500).
    validateInboundBlock(rawBlock, "message content block");
    const block = rawBlock as AnthropicBlock;
    switch (block.type) {
      case "thinking":
      case "redacted_thinking":
        // thinking / redacted_thinking have no GENERIC OpenAI Chat-Completions
        // input form; they are assistant-reasoning artifacts, not user input.
        // EXCEPTION — z.ai Preserved Thinking: replaying the assistant's prior
        // reasoning_content across turns boosts agent-loop quality AND cache-hit
        // rates on the repeated prefix (z.ai thinking-mode guide: "keep the
        // thinking blocks intact and send them back alongside the tool
        // results"). The wire contract is strict — only COMPLETE, UNMODIFIED,
        // IN-ORDER runs match. So:
        //   - zai-wire lanes forward assistant thinking-block text
        //     (concatenated in block order — the sequence the model generated
        //     for that turn);
        //   - redacted_thinking NEVER replays (an opaque placeholder can never
        //     match the model's original sequence — forwarding an edited run
        //     is exactly what the docs warn degrades performance);
        //   - every other lane (and user-role turns) keeps DROPPING both —
        //     reasoning_content-as-input is unverified outside z.ai. (Path C /
        //     Converse is a different translator and natively forwards
        //     reasoning as Converse reasoningContent blocks — unchanged.)
        if (
          opts?.preserveThinking === true &&
          msg.role === "assistant" &&
          block.type === "thinking"
        ) {
          const t = block.thinking;
          if (typeof t === "string" && t.length > 0) reasoningParts.push(t);
        }
        continue;
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
  // Preserved-thinking replay: the concatenated in-order reasoning text for
  // THIS assistant turn — attached to the primary assistant message.
  const reasoning = reasoningParts.join("");

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
    // The reasoning that preceded this turn's tool calls rides along
    // ("keep the thinking blocks intact and send them back alongside the tool
    // results" — z.ai thinking-mode guide, Interleaved Thinking).
    if (reasoning !== "") assistantMsg.reasoning_content = reasoning;
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
        // A plain assistant turn keeps its replayed reasoning attached.
        ...(reasoning !== "" ? { reasoning_content: reasoning } : {}),
      });
    }
  }

  // A message with only tool_result blocks and nothing else still yields the
  // tool messages; if somehow empty, emit an empty user message to stay valid.
  // A thinking-ONLY assistant turn keeps its replayed reasoning attached.
  if (out.length === 0) {
    out.push({
      role: msg.role,
      content: "",
      ...(reasoning !== "" ? { reasoning_content: reasoning } : {}),
    });
  }

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
  zaiOpts?: ZaiWireOptions,
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
      ...anthropicMessageToOpenAI({ role: m.role, content: m.content } as AnthropicMessage, {
        // zai-wire lanes replay assistant thinking blocks as reasoning_content.
        preserveThinking: zaiOpts !== undefined,
      }),
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
  // z.ai openai-wire thinking/effort controls — gated on the zaiWire config:
  // only api.z.ai has verified these fields, and a strict OpenAI-compatible
  // backend would reject an unknown parameter outright.
  if (zaiOpts !== undefined) {
    const cfg = zaiOpts.zaiWire;
    let forwardedDisabled = false;
    if (req.thinking?.type === "disabled") {
      if (isZaiForcedThinkingModel(model, cfg)) {
        // FORCED-thinking families (config forcedThinkingModels): z.ai cannot
        // disable it — drop the request field and say so once per model.
        if (!forcedThinkingDropLogged.has(model)) {
          forcedThinkingDropLogged.add(model);
          logger.warn("zai_forced_thinking_disable_dropped", { model });
        }
      } else {
        body.thinking = { type: "disabled" };
        forwardedDisabled = true;
      }
    }
    if (!forwardedDisabled) {
      // Preserved Thinking activation: the standard API endpoint ships it
      // OFF — clear_thinking:false turns it ON, pairing with the
      // assistant-message reasoning_content replay above. zai-wire lanes
      // always: agent loops are this lane's workload, and per the z.ai
      // thinking-mode guide the cache-hit + quality win outweighs the
      // dropped-block input savings. Never combined with an explicitly
      // disabled turn (that pairing is not documented — left untouched).
      body.thinking = { type: "enabled", clear_thinking: false };
    }
    const effort =
      typeof req.ccpp_reasoning_effort === "string" ? req.ccpp_reasoning_effort : undefined;
    if (effort !== undefined) {
      const mapped = mapEffortToReasoningEffort(effort);
      if (mapped === undefined) {
        // An invalid ladder value is never forwarded (it would 400 upstream).
        logger.warn("zai_reasoning_effort_invalid_ladder_value", { effort });
      } else if (zaiSupportsReasoningEffort(model, cfg)) {
        body.reasoning_effort = mapped;
        logger.debug("zai_reasoning_effort_mapped", { effort, reasoning_effort: mapped, model });
      } else {
        logger.debug("zai_reasoning_effort_unsupported_model", { effort, model });
      }
    }
    // Correlation id — the caller's (or the proxy's) request id rides the
    // wire as z.ai's request_id (echoed back by z.ai, greppable both sides).
    if (zaiOpts.requestId !== undefined && zaiOpts.requestId.length > 0) {
      body.request_id = sanitizeZaiRequestId(zaiOpts.requestId);
    }
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
  const zaiWire = route.zaiWire;
  // zai-wire correlation id: the caller's extension when present, else the
  // proxy's own request id (8 hex — within z.ai's 6–64 char limit).
  const callerRequestId =
    typeof parsed.ccpp_request_id === "string" && parsed.ccpp_request_id.length > 0
      ? parsed.ccpp_request_id
      : currentRequestContext()?.requestId;
  const openaiBody = anthropicToOpenAIRequest(
    parsed,
    route.invocationId,
    route.strictTools ? "openai-strict" : "openai",
    zaiWire !== undefined ? { zaiWire, requestId: callerRequestId } : undefined,
  );
  if (zaiWire !== undefined && typeof parsed.max_tokens !== "number") {
    // z.ai defaults a missing max_tokens to a very large output budget
    // (research: 65,536 tokens) — a quota bomb on an unbounded generation.
    // The Anthropic wire REQUIRES max_tokens, so this is a spec-correct 400.
    throw new BadRequestError(
      "max_tokens is required on this route (a missing field would default to a very large upstream output budget)",
    );
  }
  const headers = buildOpenAIHeaders(bearer);
  // PC2: a message body is NEVER replayed on a status code (streaming or not) —
  // a 5xx after the model generated would be a second billed generation. 429s
  // are owned by the failover engine (see passthrough.ts). Connection-level
  // retries (a throw before any response) are unaffected.
  const opts = {
    ...(signal ? { signal } : {}),
    retryTransientStatus: false,
    retryRateLimit: false,
  };
  // The upstream correlation id (set on zai-wire lanes) rides the request
  // body AND the response headers — logged here so a z.ai-side lookup
  // correlates with our request id end-to-end.
  const upstreamRequestId = zaiWire !== undefined ? openaiBody.request_id : undefined;
  if (upstreamRequestId !== undefined) {
    logger.info("zai_upstream_request", {
      request_id: upstreamRequestId,
      model: route.invocationId,
      stream: parsed.stream === true,
    });
  }
  // Echoed onto the client-facing response for end-to-end correlation.
  const responseHeaders: Record<string, string> =
    upstreamRequestId !== undefined ? { "x-ccpp-upstream-request-id": upstreamRequestId } : {};

  if (parsed.stream === true) {
    const streamBody = {
      ...openaiBody,
      stream: true,
      stream_options: { include_usage: true },
    };
    const upstream = await postJson(route.streamPath, headers, JSON.stringify(streamBody), opts);
    await assertUpstreamOk(upstream, route, { requireBody: true });
    const body = upstream.body as ReadableStream<Uint8Array>;
    // zai-wire lanes surface abnormal in-stream termination as finish_reason
    // values — classified into typed Anthropic-wire error events by the bridge.
    const sse = openAiStreamToAnthropicSse(
      body,
      parsed.model ?? route.invocationId,
      0,
      zaiWire !== undefined,
    );
    return new Response(sse, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        ...responseHeaders,
      },
    });
  }

  // 429s are owned by the failover engine (see passthrough.ts) — a message body
  // is never replayed on a status code (PC2), connection retries unaffected.
  const upstream = await postJson(route.path, headers, JSON.stringify(openaiBody), opts);
  await assertUpstreamOk(upstream, route);

  const openaiJson = await parseUpstreamJson<OpenAIResponse>(upstream, route);
  // zai-wire (non-streaming): the same abnormal-termination finish_reasons
  // arrive on the JSON face. Classified and thrown as a TYPED UpstreamError
  // with the z.ai reason preserved — never a normal-looking end_turn.
  if (zaiWire !== undefined) {
    const reason = openaiJson.choices?.[0]?.finish_reason;
    const zaiErr = reason !== undefined ? classifyZaiStreamFinishError(reason) : undefined;
    if (zaiErr !== undefined) {
      logger.error("zai_finish_reason_error", {
        finish_reason: reason,
        kind: zaiErr.kind,
        model: route.invocationId,
        stream: false,
      });
      throw new UpstreamError(502, zaiErr.message, {
        upstreamBody: JSON.stringify(openaiJson),
        context: { provider: route.provider, finish_reason: reason, kind: zaiErr.kind },
      });
    }
  }

  const ir = openAIResponseToIr(openaiJson);
  // OpenAI-wire prompt_tokens INCLUDES the cached subset; the Anthropic-facing
  // body must EXCLUDE it (Anthropic semantics) — the emitter subtracts when
  // told the IR carries the inclusive form. (Converse/passthrough are
  // already exclusive; they never pass this flag.)
  const anthropicBody = irToAnthropicResponse(ir, parsed.model ?? route.invocationId, {
    inputTokensIncludeCached: true,
  });
  return Response.json(anthropicBody, { headers: responseHeaders });
}
