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
      if (typeof tool !== "object" || tool === null || Array.isArray(tool)) return tool;
      let t = tool as Record<string, unknown>;

      if ("defer_loading" in t) {
        const { defer_loading: _dropped, ...rest } = t;
        t = rest;
        toolsChanged = true;
      }

      const custom = t.custom;
      if (
        typeof custom === "object" &&
        custom !== null &&
        !Array.isArray(custom) &&
        "defer_loading" in (custom as Record<string, unknown>)
      ) {
        const { defer_loading: _dropped, ...customRest } = custom as Record<string, unknown>;
        t = { ...t, custom: customRest };
        toolsChanged = true;
      }

      return t;
    });
    if (toolsChanged) next = { ...next, tools: sanitized };
  }

  return next;
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
): Record<string, unknown> {
  const stripped = stripUnsupportedFields(body);
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
  const outboundBody = JSON.stringify(withModel(parsed, route.invocationId));
  const headers = buildAnthropicHeaders(inbound, bearer, authStyle);
  const url = streaming ? route.streamPath : route.path;

  // PC2: never replay a streaming request body on a transient status (the
  // upstream may already be generating); non-streaming keeps default retries.
  const opts = {
    ...(signal ? { signal } : {}),
    ...(streaming ? { retryTransientStatus: false } : {}),
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

  const outboundBody = JSON.stringify(withModel(parsed, route.invocationId));
  const headers = buildAnthropicHeaders(inbound, bearer, authStyle);
  const upstream = await postJson(
    route.countTokensPath,
    headers,
    outboundBody,
    signal ? { signal } : {},
  );

  await assertUpstreamOk(upstream, route);
  // Relay the same headers as the messages path (content-type + cache-control)
  // — previously count_tokens dropped cache-control, an accidental divergence.
  const relayHeaders = relayHeadersFrom(upstream, PASSTHROUGH_RELAY_HEADERS);
  return new Response(upstream.body, { status: upstream.status, headers: relayHeaders });
}
