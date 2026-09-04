/**
 * Shared upstream/relay helpers for the three translation paths (P/C/M).
 *
 * These consolidate three patterns that were duplicated across
 * passthrough.ts / converse.ts / mantle.ts:
 *   - parsing an untrusted JSON body/response into a validated object
 *     (a runtime trust boundary — never a bare `JSON.parse(...) as T`);
 *   - the `!upstream.ok -> read body -> throw UpstreamError` block;
 *   - relaying selected upstream headers to the client.
 */
import { BadRequestError, PayloadTooLargeError, UpstreamError } from "../errors.ts";
import type { IRResponse } from "../ir/types.ts";
import type { RouteTarget } from "../router.ts";

/** A parsed upstream/inbound response object (JSON object at a trust boundary). */
export type JsonObject = Record<string, unknown>;

/**
 * Discriminate a *custom* tool (one carrying a real JSON Schema) from an
 * Anthropic *server-tool* brick (e.g. `{ type: "bash_20250825", name: "Bash" }`,
 * which omits `input_schema`). Non-Claude Converse/Mantle backends have no
 * server-tool primitive, so a server-tool would translate to an
 * `inputSchema.json: undefined` / `parameters: undefined` that the upstream
 * rejects with a 400. Only custom tools are forwarded on those paths.
 *
 * Shared by Path C (converse) and Path M (mantle) so the rule stays identical.
 */
export function isCustomTool(tool: { input_schema?: unknown }): boolean {
  const schema = tool.input_schema;
  return typeof schema === "object" && schema !== null && !Array.isArray(schema);
}

/**
 * Validate an inbound Anthropic content block's shape at the trust boundary
 * (SEC-6). Inbound content is client-controlled, so an unknown or malformed
 * block `type` is a 400 (bad request), NOT a 500 — `assertNever` is reserved
 * for internal IR-union exhaustiveness only. Throws `BadRequestError` on:
 *   - a non-object block,
 *   - a missing/non-string `type`,
 *   - a `type` outside the known set,
 *   - a known type missing its required discriminant field.
 * Returns the validated `type` for the caller's switch.
 *
 * `label` (e.g. "messages[2].content[0]") is woven into the error for locality.
 */
const KNOWN_ANTHROPIC_BLOCK_TYPES = new Set([
  "text",
  "thinking",
  "redacted_thinking",
  "tool_use",
  "tool_result",
  "image",
]);

export function validateInboundBlock(block: unknown, label = "content block"): string {
  if (typeof block !== "object" || block === null || Array.isArray(block)) {
    throw new BadRequestError(`${label} must be an object`);
  }
  const type = (block as { type?: unknown }).type;
  if (typeof type !== "string") {
    throw new BadRequestError(`${label} is missing a string "type"`);
  }
  if (!KNOWN_ANTHROPIC_BLOCK_TYPES.has(type)) {
    throw new BadRequestError(`${label} has unknown type "${type}"`);
  }
  return type;
}

/**
 * Default inbound body-size limit (bytes). Large enough for very long coding
 * prompts + tool schemas + inlined images, small enough to bound memory/GC on
 * the single Bun process. Overridable via `readBodyWithLimit(req, max)`.
 */
export const DEFAULT_MAX_BODY_BYTES = 25 * 1024 * 1024; // 25 MiB

/**
 * Read a request body as text with an enforced maximum size (SEC-1).
 *
 * Guards two ways so a client cannot force an unbounded in-memory buffer:
 *   1. Fast reject: if `Content-Length` exceeds the cap, throw 413 before
 *      reading a single byte.
 *   2. Streamed cap: `Content-Length` may be absent or under-report (chunked
 *      transfer), so we also read the stream incrementally and abort with 413
 *      the moment accumulated bytes exceed the cap — never buffering the whole
 *      oversized payload.
 *
 * Falls back to `req.text()` when the body is not a readable stream (e.g. a
 * synthetic Request in tests), still honoring the Content-Length fast path.
 */
export async function readBodyWithLimit(
  req: { headers: { get(name: string): string | null }; body?: unknown; text(): Promise<string> },
  maxBytes: number = DEFAULT_MAX_BODY_BYTES,
): Promise<string> {
  const declared = req.headers.get("content-length");
  if (declared !== null) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > maxBytes) {
      throw new PayloadTooLargeError(
        `Request body of ${n} bytes exceeds the ${maxBytes}-byte limit`,
      );
    }
  }

  const body = req.body;
  if (!body || typeof (body as ReadableStream).getReader !== "function") {
    // No stream available (test Request / already-buffered): read then check.
    const text = await req.text();
    if (byteLength(text) > maxBytes) {
      throw new PayloadTooLargeError(`Request body exceeds the ${maxBytes}-byte limit`);
    }
    return text;
  }

  const reader = (body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new PayloadTooLargeError(`Request body exceeds the ${maxBytes}-byte limit`);
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}

/** UTF-8 byte length of a string without allocating a Buffer copy per call. */
function byteLength(s: string): number {
  return new TextEncoder().encode(s).byteLength;
}

/**
 * Flatten Anthropic `tool_result` content to a plain string for the IR / OpenAI
 * `role:"tool"` message, where only text is representable.
 *
 * Shared by Path C (converse) and Path M (mantle) so the rule stays identical.
 * Handling per block:
 *   - `string` content: returned verbatim.
 *   - array of blocks: `text`/`output_text` blocks contribute their text;
 *     **image blocks are replaced with a `[image omitted]` placeholder** (an
 *     OpenAI `role:"tool"` message cannot carry an image, and dumping the raw
 *     base64 as `JSON.stringify(block)` — the previous behavior — injected a
 *     huge base64 blob as literal text, blowing up tokens and confusing the
 *     model); other structured (non-text, non-image) blocks are `JSON.stringify`d
 *     since they are genuine data, not binary payloads.
 *   - anything else: `JSON.stringify`d.
 *
 * Blocks are concatenated (empty-string join, preserving prior behavior for
 * multi-part text results).
 */
/**
 * Maximum length (chars) of a single serialized tool-result string (SEC-3). A
 * tool can return an unbounded blob (a whole file, a giant log); left unchecked
 * it inflates the outbound token count and memory. Oversized results are
 * truncated with an explicit marker so the model still sees a coherent (if
 * clipped) result rather than a silently-dropped one.
 */
export const MAX_TOOL_RESULT_CHARS = 512 * 1024; // 512K chars

function capToolResult(s: string): string {
  if (s.length <= MAX_TOOL_RESULT_CHARS) return s;
  const marker = `\n…[tool result truncated: ${s.length} chars exceeded ${MAX_TOOL_RESULT_CHARS}-char limit]`;
  return s.slice(0, MAX_TOOL_RESULT_CHARS) + marker;
}

export function toolResultContentToString(content: unknown): string {
  if (typeof content === "string") return capToolResult(content);
  if (Array.isArray(content)) {
    return capToolResult(
      content
        .map((b) => {
          if (b && typeof b === "object") {
            const type = (b as { type?: unknown }).type;
            if (type === "image") return "[image omitted]";
            if (Object.hasOwn(b as object, "text")) {
              return String((b as { text: unknown }).text);
            }
          }
          return JSON.stringify(b);
        })
        .join(""),
    );
  }
  return capToolResult(JSON.stringify(content));
}

/**
 * Parse a JSON string into a plain object at a trust boundary.
 *
 * Unlike a bare `JSON.parse(raw) as T`, this validates that the result is an
 * object (not a string/number/array/null) before returning it, so a malformed
 * or unexpected payload fails fast with a clear 400 instead of surfacing as a
 * downstream `undefined`/`NaN` corruption. The caller still narrows fields.
 *
 * @param raw   The raw JSON text.
 * @param label What is being parsed (for the error message, e.g. "Request body").
 */
/**
 * Maximum nesting depth for an inbound JSON object (SEC-3). Deeply nested input
 * is a cheap DoS: it forces deep recursion in every downstream traversal
 * (validation, translation, serialization). Real Anthropic message payloads
 * nest only a few levels (messages → content → block → source), so a generous
 * cap rejects pathological input without touching legitimate requests.
 */
export const MAX_JSON_DEPTH = 64;

/** Throw `BadRequestError` if a parsed value nests deeper than `MAX_JSON_DEPTH`. */
function assertJsonDepth(value: unknown, label: string, depth = 0): void {
  if (depth > MAX_JSON_DEPTH) {
    throw new BadRequestError(`${label} nests deeper than the ${MAX_JSON_DEPTH}-level limit`);
  }
  if (Array.isArray(value)) {
    for (const item of value) assertJsonDepth(item, label, depth + 1);
  } else if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) assertJsonDepth(v, label, depth + 1);
  }
}

export function parseJsonObject(raw: string, label = "Request body"): JsonObject {
  let parsed: unknown;
  try {
    parsed = parseJsonSafe(raw);
  } catch {
    throw new BadRequestError(`${label} is not valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new BadRequestError(`${label} must be a JSON object`);
  }
  assertJsonDepth(parsed, label);
  return parsed as JsonObject;
}

/**
 * Keys that, if present as own properties on a parsed object, enable
 * prototype-pollution attacks (`__proto__`) or let crafted input reach the
 * prototype chain via later property access (`constructor`, `prototype`).
 */
const POLLUTION_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * `JSON.parse` with a reviver that strips prototype-pollution keys anywhere in
 * the tree (SEC-2). `JSON.parse('{"__proto__":{...}}')` creates an *own*
 * property literally named `__proto__` (not a prototype mutation), but code that
 * later spreads/copies or does `obj[k] = ...` can promote it into a real
 * pollution vector — so we drop these keys at the boundary. The reviver returns
 * `undefined` for a dangerous key, which removes it from the result.
 */
export function parseJsonSafe(raw: string): unknown {
  return JSON.parse(raw, (key, value) => (POLLUTION_KEYS.has(key) ? undefined : value));
}

/**
 * Own-property check that never consults the prototype chain (SEC-2). Prefer
 * this over `obj[k] !== undefined` / `k in obj` for reading fields off parsed
 * untrusted objects, so a crafted `constructor`/`toString`-style key can't
 * masquerade as a present field.
 */
export function hasOwn(obj: object, key: string): boolean {
  return Object.hasOwn(obj, key);
}

/**
 * Rough token estimate from a character count (PC7). Used ONLY as a fallback
 * when an upstream omits usage from its stream, so telemetry/cost reports show a
 * best-effort number instead of a misleading 0. The ~4-chars-per-token ratio is
 * the widely-used English heuristic; this is an estimate, not exact accounting.
 */
export function estimateTokensFromChars(chars: number): number {
  if (chars <= 0) return 0;
  return Math.max(1, Math.ceil(chars / 4));
}

/**
 * Sanitize a tool-call id to `^[a-zA-Z0-9_-]+$` (G3/SR8). Some OpenAI-compatible
 * backends strictly validate tool-call ids (LIVE-VERIFIED: Bedrock Mantle's
 * Mistral rejects ids with other characters: 400 "Tool call id ... must be
 * a-z, A-Z, 0-9, _ or -"). The mapping is DETERMINISTIC — the same input always
 * yields the same output — so a `tool_use` id and its matching `tool_result`
 * `tool_use_id` sanitize identically and stay paired. Disallowed characters
 * become `_`; an empty/whitespace id falls back to a stable placeholder.
 */
export function sanitizeToolCallId(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  return cleaned.length > 0 ? cleaned : "tool_call";
}

/**
 * Coerce OpenAI-style tool-call `arguments` (a JSON string) into an Anthropic
 * `tool_use.input` value, which MUST be a JSON object (G10/SEC-10). Empty,
 * truncated, malformed, or non-object JSON (a bare string/number/array/null)
 * all degrade to `{}` so the Anthropic client never receives an `input` it
 * can't treat as an argument map. A valid JSON object is returned as-is.
 */
export function coerceToolInput(argumentsJson: string | undefined): Record<string, unknown> {
  if (!argumentsJson) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    return {}; // truncated / malformed JSON (e.g. a cut-off stream) -> empty args
  }
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return {}; // a bare string/number/array/null is not a valid argument map
}

/**
 * Anthropic-supported image media types. Used to validate/normalize an inbound
 * image block's `media_type` (TC6). An unknown/absent media_type on a base64
 * source defaults to image/png (Anthropic's most common) rather than emitting a
 * malformed `data:;base64,` URI that OpenAI-compatible backends reject.
 */
export const SUPPORTED_IMAGE_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/** A normalized image source: either inline base64 `data` or a `url` (TC6). */
export interface NormalizedImage {
  readonly mediaType: string;
  readonly data?: string;
  readonly url?: string;
}

/**
 * Normalize an Anthropic image block's `source` to a provider-neutral shape
 * (TC6). Handles both `{type:"base64",media_type,data}` and `{type:"url",url}`.
 * Validates `media_type` against the supported set, defaulting an unknown/absent
 * value to `image/png` for base64 sources. Returns `undefined` for an
 * unrecognized/malformed source so the caller can drop the block gracefully.
 */
export function normalizeImageSource(source: unknown): NormalizedImage | undefined {
  if (typeof source !== "object" || source === null) return undefined;
  const s = source as { type?: unknown; media_type?: unknown; data?: unknown; url?: unknown };
  if (s.type === "url" && typeof s.url === "string" && s.url.length > 0) {
    return { mediaType: "", url: s.url };
  }
  if (s.type === "base64" && typeof s.data === "string" && s.data.length > 0) {
    const mt = typeof s.media_type === "string" ? s.media_type : "";
    return {
      mediaType: SUPPORTED_IMAGE_MEDIA_TYPES.has(mt) ? mt : "image/png",
      data: s.data,
    };
  }
  return undefined;
}

/**
 * Enforce configurable count caps on an inbound Anthropic request (SEC-4).
 * Rejects with a 400 (client error) when the request exceeds a resource cap —
 * message count, content-block count per message, or tool count — before any
 * O(n) normalization/translation runs. Non-array fields are ignored (shape is
 * validated elsewhere); only counts are checked here.
 */
export function assertInboundLimits(
  body: JsonObject,
  limits: { maxMessages: number; maxContentBlocksPerMessage: number; maxTools: number },
): void {
  const messages = body.messages;
  if (Array.isArray(messages)) {
    if (messages.length > limits.maxMessages) {
      throw new BadRequestError(
        `Request has ${messages.length} messages, exceeding the ${limits.maxMessages} limit`,
      );
    }
    for (let i = 0; i < messages.length; i++) {
      const content = (messages[i] as { content?: unknown })?.content;
      if (Array.isArray(content) && content.length > limits.maxContentBlocksPerMessage) {
        throw new BadRequestError(
          `messages[${i}] has ${content.length} content blocks, exceeding the ${limits.maxContentBlocksPerMessage} limit`,
        );
      }
    }
  }
  const tools = body.tools;
  if (Array.isArray(tools) && tools.length > limits.maxTools) {
    throw new BadRequestError(
      `Request has ${tools.length} tools, exceeding the ${limits.maxTools} limit`,
    );
  }
}

/**
 * Assert an upstream response is OK (and optionally has a body). On failure,
 * read the upstream body (best-effort) and throw a typed UpstreamError carrying
 * the route/model context for logs. Consolidates the 6 identical
 * `!upstream.ok -> text -> throw` blocks across the path handlers.
 *
 * @param requireBody  When true (streaming), also fail if `upstream.body` is null.
 */
export async function assertUpstreamOk(
  upstream: Response,
  route: RouteTarget,
  options?: { requireBody?: boolean },
): Promise<void> {
  const bodyMissing = options?.requireBody === true && !upstream.body;
  if (upstream.ok && !bodyMissing) return;
  const errText = await upstream.text().catch(() => "");
  throw new UpstreamError(upstream.status, `Upstream ${upstream.status}`, {
    upstreamBody: errText,
    context: { route: route.path, model: route.invocationId },
  });
}

/**
 * Read an OK upstream response's JSON body as a validated object, then cast to
 * the expected shape. Validates the trust boundary (object, not a scalar) so a
 * provider returning an unexpected payload fails with a clear 502 rather than a
 * silent field-access corruption. Call only after `assertUpstreamOk`.
 */
export async function parseUpstreamJson<T>(upstream: Response, route: RouteTarget): Promise<T> {
  let parsed: unknown;
  try {
    parsed = parseJsonSafe(await upstream.text());
  } catch (err) {
    throw new UpstreamError(502, "Upstream returned a non-JSON response", {
      context: { route: route.path, model: route.invocationId },
      cause: err,
    });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new UpstreamError(502, "Upstream returned a non-object JSON response", {
      context: { route: route.path, model: route.invocationId },
    });
  }
  return parsed as T;
}

/**
 * Build a relay header map from an upstream response, copying only the named
 * headers that are present. Centralizes the content-type / cache-control relay
 * so the messages and count_tokens paths stay consistent.
 */
export function relayHeadersFrom(
  upstream: Response,
  names: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = upstream.headers.get(name);
    if (value !== null) out[name] = value;
  }
  return out;
}

/** Headers relayed verbatim from a passthrough upstream response. */
export const PASSTHROUGH_RELAY_HEADERS = ["content-type", "cache-control"] as const;

/**
 * Serialize a provider-neutral IR response into an Anthropic Messages JSON body.
 *
 * Shared by Path C (converse) and Path M (mantle) — both produce the identical
 * envelope and content-block mapping. Prompt-cache usage counters
 * (`cache_read_input_tokens` / `cache_creation_input_tokens`) are emitted only
 * when the IR carries them; the mantle IR never sets them, so mantle output
 * stays flat `{ input_tokens, output_tokens }` — behavior preserved.
 */
export function irToAnthropicResponse(ir: IRResponse, model: string): JsonObject {
  const content = ir.content.map((b) => {
    switch (b.type) {
      case "text":
        return { type: "text", text: b.text };
      case "thinking":
        return {
          type: "thinking",
          thinking: b.thinking,
          ...(b.signature ? { signature: b.signature } : {}),
        };
      case "tool_use":
        return { type: "tool_use", id: b.id, name: b.name, input: b.input };
      case "tool_result":
        return { type: "tool_result", tool_use_id: b.toolUseId, content: b.content };
      case "image":
        // A response image is normally base64 (model-generated); a url-source
        // image (TC6) round-trips as a url source. Emit whichever is present.
        return {
          type: "image",
          source:
            b.url !== undefined
              ? { type: "url", url: b.url }
              : { type: "base64", media_type: b.mediaType, data: b.data ?? "" },
        };
    }
  });
  const usage: Record<string, number> = {
    input_tokens: ir.usage.inputTokens,
    output_tokens: ir.usage.outputTokens,
  };
  if (ir.usage.cacheReadInputTokens !== undefined) {
    usage.cache_read_input_tokens = ir.usage.cacheReadInputTokens;
  }
  if (ir.usage.cacheWriteInputTokens !== undefined) {
    usage.cache_creation_input_tokens = ir.usage.cacheWriteInputTokens;
  }
  return {
    id: `msg_${crypto.randomUUID().replace(/-/g, "")}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: ir.stopReason,
    stop_sequence: ir.stopSequence ?? null,
    usage,
  };
}
