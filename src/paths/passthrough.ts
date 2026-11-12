/**
 * Path P — Claude native Anthropic passthrough (DESIGN §6.1).
 *
 * Both bedrock-runtime and bedrock-mantle expose `/anthropic/v1/messages` which
 * accept and return native Anthropic Messages, including streaming SSE, thinking
 * blocks, tool use, vision, and prompt caching. For Claude models we therefore
 * forward the request body nearly unchanged — rewriting the `model` field to the
 * resolved invocation id and stripping the handful of Claude Code ↔
 * Anthropic-public-API extensions the passthrough targets reject (see
 * `withModel` / `stripUnsupportedToolFields`) — and relay the response
 * byte-for-byte. No intermediate representation is involved.
 */
import { BadRequestError } from "../errors.ts";
import { type HeaderReader, buildAnthropicHeaders, postJson } from "../http/upstream.ts";
import { logger } from "../logging/logger.ts";
import type { RouteTarget } from "../router.ts";
import { keepAliveTee } from "../stream/keepalive-tee.ts";
import {
  type JsonObject,
  PASSTHROUGH_RELAY_HEADERS,
  assertUpstreamOk,
  relayHeadersFrom,
} from "./relay.ts";

/**
 * Top-level request fields the native-Anthropic passthrough targets reject.
 *
 * These are Claude Code ↔ Anthropic-public-API extensions that Bedrock's
 * `/anthropic/v1/messages` route (and the external Anthropic-compatible
 * providers) do not accept, failing with `400 <field>: Extra inputs are not
 * permitted`:
 *   - `context_management` — Anthropic's server-side context-editing/compaction
 *     config; unsupported upstream, dropping it just leaves context unmanaged
 *     server-side (Claude Code still manages the window client-side).
 *   - `output_config` — Anthropic structured-output/format config; unsupported
 *     upstream (rejected as `output_config.format`), dropping it falls back to
 *     normal free-form output.
 *
 * Same rationale as the `anthropic-beta` header drop: unconditional removal
 * rather than a maintained allowlist, since none of the passthrough targets
 * implement these and the set drifts as Claude Code evolves. Add new offenders
 * here as they surface.
 */
const UNSUPPORTED_TOP_LEVEL_FIELDS = ["context_management", "output_config"] as const;

/** True for a plain (non-null, non-array) object. */
function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Remove `defer_loading` (top level and nested under `custom`) from one tool
 * schema. Returns the same object when there is nothing to strip, so callers can
 * use identity to decide whether the request changed.
 */
function stripToolLoadingHints(tool: JsonObject): JsonObject {
  let t = tool;

  if ("defer_loading" in t) {
    const { defer_loading: _dropped, ...rest } = t;
    t = rest;
  }

  const custom = t.custom;
  if (isPlainObject(custom) && "defer_loading" in custom) {
    const { defer_loading: _dropped, ...customRest } = custom;
    t = { ...t, custom: customRest };
  }

  return t;
}

/**
 * Strip request fields the upstream native-Anthropic route rejects but that are
 * safe to omit.
 *
 * Two shapes are cleaned:
 *   - top-level extension fields (see `UNSUPPORTED_TOP_LEVEL_FIELDS`);
 *   - `defer_loading` (deferred/lazy tool loading) — a Claude Code tool-schema
 *     field Bedrock rejects as `tools.N.custom.defer_loading`. Claude Code has
 *     placed it both at the tool top level and nested under `custom` across
 *     versions, so we remove both. Dropping it only disables a loading hint; the
 *     tool itself is forwarded unchanged.
 *
 * Mirrors the header-side `anthropic-beta` drop: these are Claude Code ↔
 * Anthropic-public-API niceties that the passthrough targets do not implement.
 */
function stripUnsupportedFields(body: Record<string, unknown>): Record<string, unknown> {
  let next = body;

  // Top-level extension fields.
  for (const field of UNSUPPORTED_TOP_LEVEL_FIELDS) {
    if (field in next) {
      const { [field]: _dropped, ...rest } = next;
      next = rest;
    }
  }

  // Per-tool `defer_loading` (top level and nested under `custom`).
  const tools = next.tools;
  if (Array.isArray(tools)) {
    let toolsChanged = false;
    const sanitized = tools.map((tool) => {
      if (!isPlainObject(tool)) return tool;
      const cleaned = stripToolLoadingHints(tool);
      if (cleaned !== tool) toolsChanged = true;
      return cleaned;
    });
    if (toolsChanged) next = { ...next, tools: sanitized };
  }

  return next;
}

/**
 * Content-block types Claude Code's inline-tools / mid-conversation-tool-changes
 * betas use to deliver tool updates mid-conversation.
 */
const INLINE_TOOL_BLOCK_TYPES = new Set(["tool_addition", "tool_removal"]);

/**
 * Normalize Claude Code's inline tool changes for third-party Anthropic-
 * compatible providers (DeepSeek, z.ai).
 *
 * With the `inline-tools-2026-09-15` / `mid-conversation-tool-changes-2026-07-01`
 * betas active, Claude Code inserts a synthetic `role: "system"` message whose
 * content is an array of `tool_addition` / `tool_removal` blocks:
 *
 *   { type: "tool_addition", tool: { type: "tool_definition", definition: {...} } }
 *   { type: "tool_removal",  tool: { type: "tool_reference", name: "..." } }
 *
 * Native Anthropic implements that shape; the external Anthropic-compatible
 * providers implement only part of it (measured against api.deepseek.com):
 *   - `tool_addition` + `tool_definition` → 422 `unknown variant
 *     `tool_definition`, expected `tool_reference``;
 *   - `tool_addition` + `tool_reference` → accepted, but only when the named
 *     tool is already declared in `tools[]` (otherwise 400 "references unknown
 *     tool");
 *   - `tool_removal` → not a known content block at all (422).
 *
 * Rewrite to the subset they do support — the same shape Claude Code itself
 * falls back to when the inline-tools beta is refused: hoist every inline
 * definition into `tools[]`, point each addition at it by reference, and drop
 * removals (there is no per-turn tool set upstream to prune; the tool simply
 * stays declared for the rest of the request).
 *
 * Native Anthropic and Bedrock traffic must NOT be normalized here — they
 * implement the original shape — so callers gate this on `externalAnthropic`.
 */
function hoistInlineToolBlocks(body: JsonObject): JsonObject {
  const messages = body.messages;
  if (!Array.isArray(messages)) return body;

  const definitions = new Map<string, JsonObject>();
  let changed = false;
  const outbound: unknown[] = [];

  for (const message of messages) {
    if (!isPlainObject(message) || !Array.isArray(message.content)) {
      outbound.push(message);
      continue;
    }

    const kept: unknown[] = [];
    let messageChanged = false;
    for (const block of message.content) {
      if (
        !isPlainObject(block) ||
        typeof block.type !== "string" ||
        !INLINE_TOOL_BLOCK_TYPES.has(block.type)
      ) {
        kept.push(block);
        continue;
      }

      changed = true;
      messageChanged = true;
      const tool = isPlainObject(block.tool) ? block.tool : undefined;
      const definition = isPlainObject(tool?.definition) ? tool.definition : undefined;
      const name =
        typeof definition?.name === "string"
          ? definition.name
          : typeof tool?.name === "string"
            ? tool.name
            : undefined;

      if (block.type === "tool_addition") {
        // Definition-carrying blocks are hoisted into `tools[]`; reference-only
        // additions just need the tool to be declared there.
        if (definition && name !== undefined && !definitions.has(name)) {
          definitions.set(name, definition);
        }
        // An unnamed addition cannot be resolved upstream — drop it.
        if (name !== undefined) {
          kept.push({ ...block, tool: { type: "tool_reference", name } });
        }
      }

      // `tool_removal`: unsupported upstream (422); dropping it keeps the tool
      // declared for this request only, which is the closest representable shape.
    }

    // A carrier message that held nothing but inline tool changes has no payload
    // left, and an empty content array is itself invalid upstream.
    if (kept.length === 0 && message.content.length > 0) continue;
    outbound.push(messageChanged ? { ...message, content: kept } : message);
  }

  if (!changed) return body;

  const existing = Array.isArray(body.tools) ? body.tools : [];
  const declared = new Set(
    existing.map((tool) =>
      isPlainObject(tool) && typeof tool.name === "string" ? tool.name : undefined,
    ),
  );
  const hoisted: unknown[] = [];
  for (const [name, definition] of definitions) {
    if (!declared.has(name)) hoisted.push(stripToolLoadingHints(definition));
  }

  const tools =
    hoisted.length > 0 || Array.isArray(body.tools) ? [...existing, ...hoisted] : undefined;
  return tools === undefined
    ? { ...body, messages: outbound }
    : { ...body, messages: outbound, tools };
}

/**
 * Deep-rewrite the one non-portable regex escape that fails whole requests on
 * the external Anthropic-compatible providers.
 *
 * A JSON-Schema `pattern` is compiled by the *provider*, not by us. `\0` (NUL)
 * is a legal ECMAScript escape but not a legal escape in the provider's engine,
 * and DeepSeek rejects the entire request when it meets one:
 *
 *   400 Invalid schema for function 'mcp__control-mcp__agent_mint':
 *       "^\\/[^\\0]+$" is not a "regex"
 *
 * `\x00` means the same thing and is accepted (measured against
 * api.deepseek.com; `\012`-style octal escapes are rejected there too), so this
 * rewrites the escape rather than dropping the pattern — a value-level,
 * semantics-preserving repair. Only `\0` not followed by a digit is touched, so
 * an octal-looking `\012` is left exactly as sent rather than being silently
 * reinterpreted into a different character.
 *
 * Nothing else is rewritten. Other constructs are either accepted by that
 * validator (a lookahead was measured to pass) or are genuinely different
 * expressions upstream, where guessing a replacement would change validation
 * semantics. Those are the MCP server's bug to fix, and `chimera-control-mcp`'s
 * schema test guards its own surface against them.
 */
function rewriteNulEscapes(value: unknown, onRewrite: () => void): unknown {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((child) => {
      const rewritten = rewriteNulEscapes(child, onRewrite);
      if (rewritten !== child) changed = true;
      return rewritten;
    });
    return changed ? next : value;
  }

  if (!isPlainObject(value)) return value;

  let changed = false;
  const next: JsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    let out = child;
    if (key === "pattern" && typeof child === "string") {
      const replaced = child.replace(/\\0(?![0-9])/g, "\\x00");
      if (replaced !== child) {
        onRewrite();
        out = replaced;
      }
    } else {
      out = rewriteNulEscapes(child, onRewrite);
    }
    if (out !== child) changed = true;
    next[key] = out;
  }
  return changed ? next : value;
}

/**
 * Apply `rewriteNulEscapes` to every tool schema in the request, for external
 * Anthropic-compatible targets only. Returns the original body when nothing
 * was rewritten, so the caller's single-clone accounting (PC6) still holds.
 */
function normalizeExternalToolPatterns(body: JsonObject): JsonObject {
  const tools = body.tools;
  if (!Array.isArray(tools)) return body;

  let rewrites = 0;
  const next = rewriteNulEscapes(tools, () => {
    rewrites += 1;
  });
  if (rewrites === 0) return body;

  logger.debug("rewrote non-portable \\0 escapes in tool schema patterns", { rewrites });
  return { ...body, tools: next };
}

/**
 * Rewrite the `model` field and strip request fields the passthrough targets
 * reject (see `stripUnsupportedFields`).
 *
 * PC6: this is a near-verbatim path, so avoid redundant O(body) copies. We clone
 * the caller's body AT MOST ONCE: `stripUnsupportedFields` already returns a
 * fresh object only when it actually dropped a field (otherwise the original),
 * so — to always set `model` without mutating the shared `parsed` body the
 * logging tee reads (TC9) — we mutate the stripped object in place only when it
 * is a fresh clone, and otherwise make the single shallow clone here.
 */
export function withModel(
  body: Record<string, unknown>,
  invocationId: string,
  options: { readonly externalAnthropic?: boolean } = {},
): Record<string, unknown> {
  let stripped = stripUnsupportedFields(body);
  if (options.externalAnthropic) {
    // Hoist first, so definitions that arrived inline are repaired too.
    stripped = normalizeExternalToolPatterns(hoistInlineToolBlocks(stripped));
  }
  if (stripped !== body) {
    // `stripped` is already a fresh, non-shared clone — safe to mutate in place.
    stripped.model = invocationId;
    return stripped;
  }
  // Nothing was stripped; make exactly one shallow clone to set `model` without
  // touching the shared caller body.
  return { ...body, model: invocationId };
}

/**
 * Handle a `/v1/messages` request for a Claude model via passthrough.
 *
 * @param route     Resolved passthrough target (must be translationPath "passthrough").
 * @param inbound   Inbound request headers (for anthropic-version).
 * @param bearer    Outbound Bedrock bearer credential.
 * @param parsed    The inbound request body, already parsed once by the caller.
 * @returns A Response mirroring the upstream (JSON or SSE stream) to relay to the client.
 */
export async function handlePassthroughMessages(
  route: RouteTarget,
  inbound: HeaderReader,
  bearer: string,
  parsed: JsonObject,
  authStyle: "x-api-key" | "bearer" = "x-api-key",
  signal?: AbortSignal,
): Promise<Response> {
  const streaming = parsed.stream === true;
  const outboundBody = JSON.stringify(withModel(parsed, route.invocationId, route));
  const headers = buildAnthropicHeaders(inbound, bearer, authStyle);
  const url = streaming ? route.streamPath : route.path;

  // PC2: a message body is NEVER replayed on a status code — streaming OR
  // non-streaming. A 5xx/429 the upstream returns AFTER it has begun (or
  // finished) processing the request (e.g. a 502/504 emitted once the model
  // generated) would be replayed as a second, double-billed generation, so
  // `retryTransientStatus` is off on both faces. Pre-response CONNECTION errors
  // (thrown before any response) are still retried regardless — they are
  // independent of this flag.
  //
  // `retryRateLimit: false`: 429s are the failover engine's business — a rate
  // limit is a decision about the credential/account, not a transport blip, so
  // re-sending the same body on the same throttled key just hammers the limiter.
  const opts = {
    ...(signal ? { signal } : {}),
    retryTransientStatus: false,
    retryRateLimit: false,
  };
  const upstream = await postJson(url, headers, outboundBody, opts);

  // Relay upstream errors with their body preserved (DESIGN §9.1).
  await assertUpstreamOk(upstream, route);

  // Relay response — including SSE — with upstream content-type + cache-control.
  const relayHeaders = relayHeadersFrom(upstream, PASSTHROUGH_RELAY_HEADERS);
  // P1: for a streaming passthrough, wrap the verbatim upstream body in a
  // byte-preserving keep-alive idle-tee. Path P injects no synthetic pings of
  // its own, so a long silent tool/thinking gap on a provider that doesn't ping
  // would trip Claude Code's ~180s idle watchdog. The tee passes all bytes
  // through unchanged and only interleaves standard `event: ping` frames into
  // idle gaps. Non-streaming responses are returned as-is.
  const relayBody = streaming && upstream.body ? keepAliveTee(upstream.body) : upstream.body;
  return new Response(relayBody, { status: upstream.status, headers: relayHeaders });
}

/**
 * Handle a `/v1/messages/count_tokens` request for a Claude model via passthrough.
 */
export async function handlePassthroughCountTokens(
  route: RouteTarget,
  inbound: HeaderReader,
  bearer: string,
  parsed: JsonObject,
  authStyle: "x-api-key" | "bearer" = "x-api-key",
  signal?: AbortSignal,
): Promise<Response> {
  if (!route.countTokensPath) {
    throw new BadRequestError("count_tokens is not supported for this model");
  }

  const outboundBody = JSON.stringify(withModel(parsed, route.invocationId, route));
  const headers = buildAnthropicHeaders(inbound, bearer, authStyle);
  const upstream = await postJson(route.countTokensPath, headers, outboundBody, {
    ...(signal ? { signal } : {}),
    retryRateLimit: false,
  });

  await assertUpstreamOk(upstream, route);
  // Relay the same headers as the messages path (content-type + cache-control)
  // — previously count_tokens dropped cache-control, an accidental divergence.
  const relayHeaders = relayHeadersFrom(upstream, PASSTHROUGH_RELAY_HEADERS);
  return new Response(upstream.body, { status: upstream.status, headers: relayHeaders });
}
