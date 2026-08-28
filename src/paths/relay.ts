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
import { BadRequestError, UpstreamError } from "../errors.ts";
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
export function parseJsonObject(raw: string, label = "Request body"): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BadRequestError(`${label} is not valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new BadRequestError(`${label} must be a JSON object`);
  }
  return parsed as JsonObject;
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
    parsed = await upstream.json();
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
      case "tool_use":
        return { type: "tool_use", id: b.id, name: b.name, input: b.input };
      case "tool_result":
        return { type: "tool_result", tool_use_id: b.toolUseId, content: b.content };
      case "image":
        return {
          type: "image",
          source: { type: "base64", media_type: b.mediaType, data: b.data },
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
    stop_sequence: null,
    usage,
  };
}
