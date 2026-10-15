/**
 * Instruction-surface fingerprint for the turn-logging subsystem.
 *
 * A turn's "prompt surface" — everything that steers the model before the
 * conversation itself — is fingerprinted as ONE unit over three parts:
 *   (a) the dedicated system prompt (`system`),
 *   (b) the FULL tool definitions the request offered: `name`, `description`,
 *       `input_schema` and a server-tool's `type` (the schema, not just a
 *       name — closing the gap where only tool names were stored),
 *   (c) injected instruction blocks lifted out of the conversation (a
 *       `<system-reminder>` envelope, and other tagged instruction envelopes),
 *       which are otherwise indistinguishable from ordinary user turns.
 *
 * A change in ANY of the three yields a new {@link PromptSurface.hash}. The hash
 * is sha256 over a canonical, key-sorted JSON serialization of the three parts,
 * so object-key ordering and JSON whitespace never perturb it.
 *
 * PURE: no I/O, no filesystem, no SQLite, no store/writer imports. This runs on
 * the request path for EVERY turn, so every shape is handled defensively — a
 * missing system, missing tools, unknown content-block types, non-string content
 * and (pathologically) a cyclic value must never throw.
 */
import { createHash } from "node:crypto";
import type { PromptSurface } from "./log-types.ts";

/**
 * The tag names recognised as INJECTED INSTRUCTION ENVELOPES. The primary is
 * Claude Code's `<system-reminder>`; the family is deliberately small so that
 * ordinary prose which merely mentions an XML-ish tag is not misread as an
 * injected instruction. Length for length the list is ordered longest-name-first
 * (the regex alternation backtracks, but this keeps the common case exact).
 *
 * An injected instruction block is defined EXACTLY as the inner text of one of
 * these envelopes, found inside a message's text content:
 *   - a message whose `content` is a string, or
 *   - any `{ text: string }` content block (a `type:"text"` turn, etc.).
 * The closing tag must repeat the opening tag name; a missing closing tag (an
 * envelope truncated mid-stream) is tolerated by capturing to the end of the
 * segment. An opening tag may carry attributes (`<instructions foo="1">`).
 * Tool-result content is intentionally NOT scanned (only `.text` is read), so a
 * reminder quoted inside a tool output does not masquerade as an injection.
 * Matching is case-insensitive.
 */
export const INSTRUCTION_ENVELOPE_TAGS: readonly string[] = [
  "system-reminder",
  "system_reminder",
  "instructions",
  "instruction",
];

const TAG_ALTERNATION = INSTRUCTION_ENVELOPE_TAGS.join("|");

/**
 * Envelope matcher: group 1 is the tag name (back-referenced by the close tag),
 * group 2 is the enclosed text. `(?:\s[^>]*)?` tolerates attributes; the
 * alternation `(?:</\1>|$)` matches a closed envelope or, failing that, an
 * unclosed envelope running to the end of the segment (JS `$` matches only at
 * end-of-input without the `m` flag, so this never swallows a trailing newline).
 */
const ENVELOPE_PATTERN = new RegExp(
  `<(${TAG_ALTERNATION})(?:\\s[^>]*)?>([\\s\\S]*?)(?:</\\1>|$)`,
  "gi",
);

/** Recursion cap / cycle-breaker depth for canonical serialization. */
const MAX_CANON_DEPTH = 64;

/** The instruction-surface inputs a turn's request carries. */
export interface PromptSurfaceInput {
  /** The dedicated Anthropic `system` field: a string or a block array. */
  readonly system: unknown;
  /** The Anthropic `tools` array (custom + server tools). */
  readonly tools: unknown;
  /** The full Anthropic `messages` array as sent by the client. */
  readonly messages: unknown;
}

/**
 * Compute the {@link PromptSurface} for a request: the canonical system/tools/
 * injected JSON and their combined sha256. Pure; never throws on any input.
 */
export function computePromptSurface(input: PromptSurfaceInput): PromptSurface {
  const systemValue = normalizeSystem(input.system);
  const toolsValue = normalizeTools(input.tools);
  const injectedValue = extractInjections(input.messages);

  const systemJson = canonicalJson(systemValue);
  const toolsJson = canonicalJson(toolsValue);
  const injectedJson = canonicalJson(injectedValue);

  // The hash input is itself a canonical, key-sorted JSON object over the three
  // parts (keys `injected` < `system` < `tools`), so a byte moving across a part
  // boundary cannot alias two different surfaces to one digest.
  const hashInput = `{"injected":${injectedJson},"system":${systemJson},"tools":${toolsJson}}`;

  return {
    hash: sha256Hex(hashInput),
    systemJson,
    toolsJson,
    injectedJson,
    systemBytes: utf8Bytes(systemJson),
    toolsBytes: utf8Bytes(toolsJson),
  };
}

/**
 * Cheap hash accessor for the hot path: given a turn that ALREADY carries a
 * computed prompt surface (or an explicit `promptVersion`), return just the hash
 * without rebuilding the canonical payload. Returns null when neither is set.
 *
 * `promptVersion` wins when present so a writer-assigned version always matches
 * the row it was linked from, even if it was computed elsewhere.
 */
export function promptVersionOf(turn: {
  readonly promptVersion?: string | null;
  readonly promptSurface?: PromptSurface | null;
}): string | null {
  if (typeof turn.promptVersion === "string" && turn.promptVersion.length > 0) {
    return turn.promptVersion;
  }
  return turn.promptSurface?.hash ?? null;
}

/* ---------------- normalization ---------------- */

/**
 * Collapse every "no system" spelling (absent, null, empty string, empty block
 * array) to `null` so equivalent requests fingerprint identically. Any other
 * shape passes through to be canonicalized as-is.
 */
function normalizeSystem(system: unknown): unknown {
  if (system === undefined || system === null) return null;
  if (typeof system === "string") return system.length > 0 ? system : null;
  if (Array.isArray(system)) return system.length > 0 ? system : null;
  return system;
}

/**
 * Reduce the tool list to the instruction-bearing fields of each tool —
 * `name`, `description`, `input_schema` and a server-tool `type` — dropping
 * transport-only keys (e.g. `cache_control`) so a cache marker never bumps the
 * fingerprint. Array ORDER is preserved (tool order is part of the surface).
 * Non-object entries are skipped rather than throwing.
 */
function normalizeTools(tools: unknown): unknown[] {
  if (!Array.isArray(tools)) return [];
  const normalized: unknown[] = [];
  for (const tool of tools) {
    if (tool === null || typeof tool !== "object" || Array.isArray(tool)) continue;
    const source = tool as Record<string, unknown>;
    const picked: Record<string, unknown> = {};
    if (source.name !== undefined) picked.name = source.name;
    if (source.description !== undefined) picked.description = source.description;
    if (source.input_schema !== undefined) picked.input_schema = source.input_schema;
    if (source.type !== undefined) picked.type = source.type;
    normalized.push(picked);
  }
  return normalized;
}

/**
 * Extract, normalize, dedupe and sort the injected instruction blocks from the
 * conversation (see {@link INSTRUCTION_ENVELOPE_TAGS} for the exact definition).
 * Every message is scanned regardless of role; only `.text` content is read.
 */
function extractInjections(messages: unknown): string[] {
  if (!Array.isArray(messages)) return [];
  const found = new Set<string>();
  for (const message of messages) {
    for (const segment of messageTextSegments(message)) {
      for (const match of segment.matchAll(ENVELOPE_PATTERN)) {
        const inner = match[2];
        if (typeof inner !== "string") continue;
        const normalized = inner.replace(/\s+/g, " ").trim();
        if (normalized.length > 0) found.add(normalized);
      }
    }
  }
  // Sort for a stable canonical order independent of message traversal quirks.
  return [...found].sort();
}

/**
 * The plain-text segments of a message's content. Only string content and
 * `{ text: string }` blocks are read; a `tool_result`'s own content is
 * deliberately excluded so tool output cannot masquerade as an injection.
 */
function messageTextSegments(message: unknown): string[] {
  if (message === null || typeof message !== "object") return [];
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  const segments: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      segments.push(block);
      continue;
    }
    if (block !== null && typeof block === "object") {
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string") segments.push(text);
    }
  }
  return segments;
}

/* ---------------- canonical JSON + hashing ---------------- */

/** Canonical JSON: key-sorted objects, `undefined` members dropped, no spaces. */
function canonicalJson(value: unknown): string {
  return canonicalize(value, 0, new WeakSet<object>());
}

/**
 * Deterministic JSON serialization: object keys sorted, `undefined`-valued
 * members omitted, array holes/undefined rendered as `null`, non-finite numbers
 * as `null`. Reference cycles and over-deep nesting degrade to `null` rather
 * than recursing forever (this must never throw on the request path).
 */
function canonicalize(value: unknown, depth: number, seen: WeakSet<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      return Number.isFinite(value) ? String(value) : "null";
    case "boolean":
      return value ? "true" : "false";
    case "bigint":
      return value.toString();
    case "object":
      break;
    default:
      // undefined | function | symbol: not representable in JSON.
      return "null";
  }
  if (depth >= MAX_CANON_DEPTH) return "null";
  const object = value as object;
  if (seen.has(object)) return "null"; // break reference cycles defensively
  seen.add(object);
  try {
    if (Array.isArray(object)) {
      return `[${object.map((item) => canonicalize(item, depth + 1, seen)).join(",")}]`;
    }
    const record = object as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    const members = keys.map(
      (key) => `${JSON.stringify(key)}:${canonicalize(record[key], depth + 1, seen)}`,
    );
    return `{${members.join(",")}}`;
  } finally {
    seen.delete(object);
  }
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function utf8Bytes(input: string): number {
  return Buffer.byteLength(input, "utf8");
}
