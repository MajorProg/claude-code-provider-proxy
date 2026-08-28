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
function systemFieldToText(system: unknown): string {
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system
      .map((b) =>
        b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : "",
      )
      .join("");
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

  // 2. Walk messages: hoist system-role text, drop empty turns, keep the rest.
  const rawMessages = Array.isArray(req.messages) ? req.messages : [];
  const messages: NormalizedMessage[] = [];
  for (const m of rawMessages) {
    if (typeof m !== "object" || m === null) continue;
    const msg = m as { role?: unknown; content?: unknown };
    if (msg.role === "system") {
      const text = messageText(msg.content);
      if (text.length > 0) system.push(text);
      continue;
    }
    if (msg.role !== "user" && msg.role !== "assistant") continue;
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

  return { system, messages, tools };
}
