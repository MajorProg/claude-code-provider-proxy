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
import { normalizeForIrPaths } from "./normalize.ts";
import {
  type JsonObject,
  assertUpstreamOk,
  irToAnthropicResponse,
  parseUpstreamJson,
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
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };
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

/** Stringify tool_result content (string, or array of text blocks, or JSON). */
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
    case "image":
      return { type: "image", mediaType: block.source.media_type, data: block.source.data };
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
  const raw: IRContentBlock[] =
    typeof msg.content === "string"
      ? [{ type: "text", text: msg.content }]
      : msg.content.map(anthropicBlockToIr);
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

  const messages = kept.map((m) => ({
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
        inputSchema: { json: t.input_schema },
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
  | { toolUse: { toolUseId: string; name: string; input: unknown } };

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
      // No direct Anthropic stop_reason exists for a content filter; we map to
      // end_turn (closest forced-completion). This intentionally CONFLATES a
      // filtered response with a normal completion — documented, not a bug.
      return "end_turn";
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

function converseResponseToIr(res: ConverseResponse): IRResponse {
  const blocks: IRContentBlock[] = [];
  for (const b of res.output?.message?.content ?? []) {
    if ("text" in b) {
      blocks.push({ type: "text", text: b.text });
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
  return {
    role: "assistant",
    content: blocks,
    stopReason: mapConverseStopReason(res.stopReason),
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
    const upstream = await postJson(route.streamPath, headers, JSON.stringify(converseBody), opts);
    await assertUpstreamOk(upstream, route, { requireBody: true });
    const body = upstream.body as ReadableStream<Uint8Array>;
    const sse = converseStreamToAnthropicSse(body, parsed.model ?? route.invocationId);
    return new Response(sse, {
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
    });
  }

  const upstream = await postJson(route.path, headers, JSON.stringify(converseBody), opts);
  await assertUpstreamOk(upstream, route);

  const converseJson = await parseUpstreamJson<ConverseResponse>(upstream, route);
  const ir = converseResponseToIr(converseJson);
  const anthropicBody = irToAnthropicResponse(ir, parsed.model ?? route.invocationId);
  return Response.json(anthropicBody);
}
