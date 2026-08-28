/**
 * Inbound authentication (DESIGN §8.1) — "auth on our side".
 *
 * Claude Code presents the proxy's key via ANTHROPIC_AUTH_TOKEN, which arrives
 * as `Authorization: Bearer <key>` and/or `x-api-key: <key>`. We validate it
 * against the configured inbound key(s) and reject mismatches with 401.
 *
 * This key is unrelated to any provider credential; it only gates access to
 * the proxy. The real provider credential is injected outbound (DESIGN §8.2).
 *
 * NOTE (documented in README): client-side, ANTHROPIC_API_KEY MUST be empty or
 * Claude Code prefers it over ANTHROPIC_AUTH_TOKEN and bypasses the gateway.
 */
import { UnauthorizedError } from "../errors.ts";
import { logger } from "../logging/logger.ts";

/** Reused across all comparisons — a fresh TextEncoder per call is wasteful. */
const utf8Encoder = new TextEncoder();

/** Minimal structural view of headers we depend on (decouples from DOM/undici/Bun Headers types). */
export interface HeaderReader {
  get(name: string): string | null;
}

/** Extract the presented credential from request headers, if any. */
export function extractInboundCredential(headers: HeaderReader): string | null {
  const auth = headers.get("authorization");
  if (auth) {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match?.[1]) return match[1].trim();
  }
  const apiKey = headers.get("x-api-key");
  if (apiKey && apiKey.trim().length > 0) return apiKey.trim();
  return null;
}

/**
 * Constant-time string comparison to avoid leaking key length/content via
 * timing. Compares full length regardless of early mismatch.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const aBytes = utf8Encoder.encode(a);
  const bBytes = utf8Encoder.encode(b);
  // Compare against the max length so timing does not reveal which is longer.
  const len = Math.max(aBytes.length, bBytes.length);
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < len; i++) {
    const av = i < aBytes.length ? (aBytes[i] as number) : 0;
    const bv = i < bBytes.length ? (bBytes[i] as number) : 0;
    diff |= av ^ bv;
  }
  return diff === 0;
}

/**
 * Validate the request's inbound credential against the configured keys.
 * @throws UnauthorizedError when no credential is presented or none match.
 */
export function authenticateInbound(headers: HeaderReader, allowedKeys: readonly string[]): void {
  const presented = extractInboundCredential(headers);
  if (presented === null) {
    logger.warn("auth failure", { reason: "missing_credential" });
    throw new UnauthorizedError("Missing credential (expected Authorization: Bearer or x-api-key)");
  }
  // Check every key (no early return) so a match/no-match decision does not
  // short-circuit in a timing-observable way.
  let matched = false;
  for (const key of allowedKeys) {
    if (constantTimeEquals(presented, key)) matched = true;
  }
  if (!matched) {
    // Security event — never log the presented credential value.
    logger.warn("auth failure", { reason: "invalid_credential" });
    throw new UnauthorizedError("Invalid credential");
  }
}
