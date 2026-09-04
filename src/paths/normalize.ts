/**
 * Path-neutral inbound normalization for the IR-based translation paths
 * (Path C — Converse, Path M — OpenAI/Mantle).
 *
 * Claude Code and other clients send an Anthropic request that is valid for the
 * *native* Anthropic route (Path P, relayed verbatim) but contains shapes the
 * non-Anthropic backends reject:
 *
 *   1. `role: "system"` messages injected into the `messages` array
 *      (`<system-reminder>` blocks). Neither Converse nor OpenAI accept a system
 *      turn in the conversation; the text belongs in the system prompt.
 *   2. Empty text blocks (`{ type: "text", text: "" }`) — Converse rejects an
 *      empty/whitespace content block outright.
 *   3. Anthropic *server-tools* (`{ type: "bash_20250825", name: "Bash" }`, no
 *      `input_schema`) — no equivalent on Converse/OpenAI; forwarding one emits
 *      an `undefined` schema the upstream rejects with a 400.
 *
 * This module performs all three normalizations ONCE, producing a cleaned view
 * that both C and M consume. The per-path *output* mapping (system -> Converse
 * `system[]` vs a leading OpenAI system message) stays in each translator, as do
 * backend-specific rules (e.g. Converse's "must end on a user turn").
 *
 * Path P (passthrough) MUST NOT use this — it relays the body verbatim so the
 * native Anthropic route keeps full fidelity (server-tools, reminders, etc.).
 */
import { logger } from "../logging/logger.ts";
import { isCustomTool } from "./relay.ts";

/** A conversation turn after normalization: user/assistant only. */
export interface NormalizedMessage {
  readonly role: "user" | "assistant";
  readonly content: unknown;
}

/** A custom tool that survived server-tool filtering (guaranteed schema). */
export interface NormalizedTool {
  readonly name: string;
  readonly description?: string;
  readonly input_schema: Record<string, unknown>;
}

/** The path-neutral, cleaned request consumed by the IR translators. */
export interface NormalizedRequest {
  /** System text parts, in order: dedicated `system` first, then hoisted ones. */
  readonly system: string[];
  /** User/assistant turns only (system-role hoisted out, empty turns dropped). */
  readonly messages: NormalizedMessage[];
  /** Custom tools only (Anthropic server-tools removed). */
  readonly tools: NormalizedTool[];
}

/** Flatten an Anthropic `system` field (string or block array) to plain text. */
export function systemFieldToText(system: unknown): string {
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    const texts: string[] = [];
    let dropped = 0;
    for (const b of system) {
      if (b && typeof b === "object" && "text" in b) {
        const t = (b as { text: unknown }).text;
        if (typeof t === "string") {
          texts.push(t);
          continue;
        }
      }
      dropped++;
    }
    if (dropped > 0) {
      // TC5: a system prompt may contain non-text blocks (e.g. an image, or a
      // malformed entry). We can't fold those into the flat system string, so
      // they are dropped — surface it at debug rather than silently.
      logger.debug("dropped non-text system prompt block(s)", { dropped, total: system.length });
    }
    // TC5: join with a consistent blank-line separator (was "" — which glued
    // adjacent system blocks together, e.g. two paragraphs becoming one).
    return texts.join("\n\n");
  }
  return "";
}

/** Extract the plain text of a message's content (string or block array). */
function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        b && typeof b === "object" && "type" in b && (b as { type: unknown }).type === "text"
          ? String((b as { text?: unknown }).text ?? "")
          : "",
      )
      .join("");
  }
  return "";
}

/** True when a content block is an empty text block (no usable payload). */
function isEmptyTextBlock(block: unknown): boolean {
  return (
    typeof block === "object" &&
    block !== null &&
    (block as { type?: unknown }).type === "text" &&
    String((block as { text?: unknown }).text ?? "").length === 0
  );
}

/**
 * Drop empty text blocks from a message's content. A string content is returned
 * as-is (empty strings are handled at the message level). Returns the filtered
 * content and whether any usable content remains.
 */
function stripEmptyBlocks(content: unknown): { content: unknown; hasContent: boolean } {
  if (typeof content === "string") {
    return { content, hasContent: content.length > 0 };
  }
  if (Array.isArray(content)) {
    const filtered = content.filter((b) => !isEmptyTextBlock(b));
    return { content: filtered, hasContent: filtered.length > 0 };
  }
  // Unknown content shape: keep it (translators decide how to handle).
  return { content, hasContent: content !== undefined && content !== null };
}

/**
 * Normalize an inbound Anthropic request (parsed JSON object) for the IR paths.
 * Pure and path-neutral; never mutates the input.
 */
export function normalizeForIrPaths(req: Record<string, unknown>): NormalizedRequest {
  const system: string[] = [];

  // 1. Dedicated system prompt first (if any, non-empty).
  const dedicated = systemFieldToText(req.system);
  if (dedicated.length > 0) system.push(dedicated);

  // 2. Walk messages: hoist LEADING system-role text into the system prompt,
  //    drop empty turns, keep the rest. SEC-5: only a system-role message that
  //    appears BEFORE the first user turn is trusted as system-prompt material.
  //    A `role: "system"` message injected AFTER the conversation has started is
  //    not silently promoted into the authoritative system prompt (that would
  //    let mid-conversation content escalate its trust); it is demoted to a
  //    normal user turn so its text is still delivered but clearly attributed to
  //    the conversation, not the system prompt.
  const rawMessages = Array.isArray(req.messages) ? req.messages : [];
  const messages: NormalizedMessage[] = [];
  let seenUserTurn = false;
  for (const m of rawMessages) {
    if (typeof m !== "object" || m === null) continue;
    const msg = m as { role?: unknown; content?: unknown };
    if (msg.role === "system") {
      const text = messageText(msg.content);
      if (text.length === 0) continue;
      if (!seenUserTurn) {
        // Leading system message: trusted, hoist into the system prompt.
        system.push(text);
      } else {
        // Mid-conversation system message: demote to a user turn (trust-preserving).
        messages.push({ role: "user", content: text });
      }
      continue;
    }
    if (msg.role !== "user" && msg.role !== "assistant") continue;
    if (msg.role === "user") seenUserTurn = true;
    const { content, hasContent } = stripEmptyBlocks(msg.content);
    if (!hasContent) continue;
    messages.push({ role: msg.role, content });
  }

  // 3. Keep only custom tools (server-tools have no Converse/OpenAI equivalent).
  const rawTools = Array.isArray(req.tools) ? req.tools : [];
  const tools: NormalizedTool[] = [];
  for (const t of rawTools) {
    if (typeof t !== "object" || t === null) continue;
    const tool = t as { name?: unknown; description?: unknown; input_schema?: unknown };
    if (!isCustomTool(tool)) continue;
    tools.push({
      name: typeof tool.name === "string" ? tool.name : "",
      ...(typeof tool.description === "string" ? { description: tool.description } : {}),
      input_schema: tool.input_schema as Record<string, unknown>,
    });
  }

  // 4. Reconcile tool_use <-> tool_result across turns (G2). Strict backends
  //    (verified live: Bedrock Mantle's Mistral rejects "Unexpected role 'tool'
  //    after role 'user'"; Anthropic 400s on both dangling and orphan) require
  //    every assistant tool_use to be answered by a tool_result in the next
  //    turn, and every tool_result to reference a known tool_use.
  const reconciled = reconcileToolBlocks(messages);

  return { system, messages: reconciled, tools };
}

/** Collect the `tool_use` ids declared in a message's content. */
function toolUseIds(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const ids: string[] = [];
  for (const b of content) {
    if (
      b &&
      typeof b === "object" &&
      (b as { type?: unknown }).type === "tool_use" &&
      typeof (b as { id?: unknown }).id === "string"
    ) {
      ids.push((b as { id: string }).id);
    }
  }
  return ids;
}

/** Collect the `tool_result` `tool_use_id`s referenced in a message's content. */
function toolResultIds(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const ids: string[] = [];
  for (const b of content) {
    if (
      b &&
      typeof b === "object" &&
      (b as { type?: unknown }).type === "tool_result" &&
      typeof (b as { tool_use_id?: unknown }).tool_use_id === "string"
    ) {
      ids.push((b as { tool_use_id: string }).tool_use_id);
    }
  }
  return ids;
}

/** A synthetic tool_result block for a dangling tool_use id. */
function syntheticToolResult(id: string): {
  type: "tool_result";
  tool_use_id: string;
  content: string;
} {
  return {
    type: "tool_result",
    tool_use_id: id,
    content: "Tool result unavailable (not provided).",
  };
}

/**
 * Reconcile tool_use/tool_result pairing, returning a NEW message list (G2):
 *   - **Inject** a synthetic `tool_result` (placeholder content) for any
 *     assistant `tool_use` that has no matching `tool_result` in the immediately
 *     following user turn — a dangling tool_use otherwise becomes an assistant
 *     `tool_calls` with no answering `role:"tool"` message and 400s on strict
 *     backends.
 *   - **Prune** any `tool_result` whose `tool_use_id` does not correspond to a
 *     `tool_use` in the immediately preceding assistant turn (orphan).
 *
 * Only adjacent assistant->user pairs are reconciled, mirroring Anthropic's own
 * "tool_result must respond to tool_use in the previous turn" rule. Pure — never
 * mutates the input messages or their content arrays.
 */
function reconcileToolBlocks(messages: NormalizedMessage[]): NormalizedMessage[] {
  const out: NormalizedMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) continue;
    if (msg.role !== "assistant") {
      out.push(msg);
      continue;
    }
    const pending = toolUseIds(msg.content);
    out.push(msg);
    if (pending.length === 0) continue;

    const pendingSet = new Set(pending);
    const next = messages[i + 1];
    if (next && next.role === "user" && Array.isArray(next.content)) {
      // Prune orphan tool_result blocks (reference an id not in this turn).
      const pruned = (next.content as unknown[]).filter((b) => {
        if (b && typeof b === "object" && (b as { type?: unknown }).type === "tool_result") {
          const id = (b as { tool_use_id?: unknown }).tool_use_id;
          return typeof id === "string" && pendingSet.has(id);
        }
        return true;
      });
      const present = new Set(toolResultIds(pruned));
      const missing = pending.filter((id) => !present.has(id));
      // Synthetic results precede any user text (matches OpenAI/Converse order).
      const merged = [...missing.map(syntheticToolResult), ...pruned];
      out.push({ role: "user", content: merged });
      i += 1; // consumed the next message
    } else {
      // No following user turn: insert one carrying synthetic results.
      out.push({ role: "user", content: pending.map(syntheticToolResult) });
    }
  }
  return out;
}

/**
 * Target JSON-Schema dialect for a tool's `input_schema` (TC3).
 *
 * - `"converse"` — Bedrock Converse. LIVE-VERIFIED to accept a full Anthropic
 *   input_schema verbatim ($schema, additionalProperties, enum, nested objects,
 *   $ref/$defs, const, type-arrays), so this is a conservative pass-through: we
 *   only strip the top-level `$schema` meta-key (a dialect declaration, not a
 *   constraint) to avoid any validator that treats an unknown draft URI as an
 *   error. No structural tightening.
 * - `"openai"` — OpenAI Chat Completions (Mantle + external `type:openai`),
 *   non-strict. LIVE-VERIFIED lenient on Mantle (gpt-oss accepts every edge
 *   keyword). Same conservative pass-through as Converse.
 * - `"openai-strict"` — OpenAI *strict* function-calling. Requires, at EVERY
 *   object node: `additionalProperties:false` and every declared property listed
 *   in `required`; and forbids several keywords ($schema, format, default,
 *   $ref/$defs, unevaluatedProperties, const). Applied ONLY when a target opts
 *   into strict mode (a lenient backend keeps the untightened schema).
 */
export type SchemaDialect = "converse" | "openai" | "openai-strict";

/** Keywords a strict OpenAI validator rejects; stripped in `openai-strict`. */
const OPENAI_STRICT_UNSUPPORTED = new Set([
  "$schema",
  "$id",
  "$ref",
  "$defs",
  "definitions",
  "format",
  "default",
  "unevaluatedProperties",
  "patternProperties",
  "const",
]);

/**
 * Normalize a tool `input_schema` for a target dialect (TC3). Pure — returns a
 * new object, never mutates the input. Non-object inputs are returned as-is.
 */
export function normalizeToolSchema(schema: unknown, dialect: SchemaDialect): unknown {
  if (schema === null || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) {
    return schema.map((item) => normalizeToolSchema(item, dialect));
  }
  const src = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const strict = dialect === "openai-strict";

  for (const [key, value] of Object.entries(src)) {
    // Both non-strict dialects strip only the top-level meta `$schema` URI; the
    // strict dialect strips the wider unsupported-keyword set.
    if (key === "$schema" && !strict) continue;
    if (strict && OPENAI_STRICT_UNSUPPORTED.has(key)) continue;
    out[key] = normalizeToolSchema(value, dialect);
  }

  if (strict && out.type === "object") {
    // Strict mode: forbid extra properties and require every declared property.
    out.additionalProperties = false;
    if (out.properties !== null && typeof out.properties === "object") {
      out.required = Object.keys(out.properties as Record<string, unknown>);
    }
  }
  return out;
}
