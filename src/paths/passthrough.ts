/**
 * Path P — Claude native Anthropic passthrough (DESIGN §6.1).
 *
 * Both bedrock-runtime and bedrock-mantle expose `/anthropic/v1/messages` which
 * accept and return native Anthropic Messages, including streaming SSE, thinking
 * blocks, tool use, vision, and prompt caching. For Claude models we therefore
 * forward the request body essentially unchanged — rewriting ONLY the `model`
 * field to the resolved invocation id — and relay the response byte-for-byte.
 * No intermediate representation is involved.
 */
import { BadRequestError } from "../errors.ts";
import { type HeaderReader, buildAnthropicHeaders, postJson } from "../http/upstream.ts";
import type { RouteTarget } from "../router.ts";
import {
  type JsonObject,
  PASSTHROUGH_RELAY_HEADERS,
  assertUpstreamOk,
  relayHeadersFrom,
} from "./relay.ts";

/** Rewrite only the `model` field of a parsed Anthropic request body. */
function withModel(body: Record<string, unknown>, invocationId: string): Record<string, unknown> {
  return { ...body, model: invocationId };
}

/**
 * Handle a `/v1/messages` request for a Claude model via passthrough.
 *
 * @param route     Resolved passthrough target (must be translationPath "passthrough").
 * @param inbound   Inbound request headers (for anthropic-version / anthropic-beta).
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

  const upstream = await postJson(url, headers, outboundBody, signal ? { signal } : {});

  // Relay upstream errors with their body preserved (DESIGN §9.1).
  await assertUpstreamOk(upstream, route);

  // Relay response — including SSE — with upstream content-type + cache-control.
  const relayHeaders = relayHeadersFrom(upstream, PASSTHROUGH_RELAY_HEADERS);
  return new Response(upstream.body, { status: upstream.status, headers: relayHeaders });
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
