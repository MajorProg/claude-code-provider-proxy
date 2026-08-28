/**
 * Canonical model ID parsing + formatting (DESIGN §4).
 *
 * Format:  <provider>.<backend>.<profilePrefix>.<nativeModelId>
 *
 * The nativeModelId MAY itself contain dots and colons
 * (e.g. "amazon.nova-lite-v1:0"), so parsing MUST split on ONLY the first
 * three dots and treat the remainder as nativeModelId.
 */
import { BadModelIdError } from "../errors.ts";

export type Backend = "converse" | "mantle" | "anthropic" | "openai";

export interface CanonicalId {
  /** e.g. "bedrock" (future: "gemini") */
  readonly provider: string;
  /** translation path selector */
  readonly backend: Backend;
  /** "global" | "us" | "eu" — region + profile family */
  readonly profilePrefix: string;
  /** the provider's real model id (may contain dots/colons) */
  readonly nativeModelId: string;
}

const VALID_BACKENDS: readonly Backend[] = ["converse", "mantle", "anthropic", "openai"];

/**
 * Parse a canonical model id into its four segments.
 * Splits on the first three dots only; everything after the third dot is the
 * nativeModelId, preserving embedded dots and colons.
 */
export function parseCanonicalId(id: string): CanonicalId {
  if (typeof id !== "string" || id.length === 0) throw new BadModelIdError(String(id));

  const first = id.indexOf(".");
  const second = first === -1 ? -1 : id.indexOf(".", first + 1);
  const third = second === -1 ? -1 : id.indexOf(".", second + 1);
  if (first === -1 || second === -1 || third === -1) throw new BadModelIdError(id);

  const provider = id.slice(0, first);
  const backend = id.slice(first + 1, second);
  const profilePrefix = id.slice(second + 1, third);
  const nativeModelId = id.slice(third + 1);

  if (
    provider.length === 0 ||
    backend.length === 0 ||
    profilePrefix.length === 0 ||
    nativeModelId.length === 0
  ) {
    throw new BadModelIdError(id);
  }
  if (!VALID_BACKENDS.includes(backend as Backend)) throw new BadModelIdError(id);

  return {
    provider,
    backend: backend as Backend,
    profilePrefix,
    nativeModelId,
  };
}

/** Format a canonical id from its segments. */
export function formatCanonicalId(parts: CanonicalId): string {
  return `${parts.provider}.${parts.backend}.${parts.profilePrefix}.${parts.nativeModelId}`;
}

/**
 * True when a native model id denotes a Claude / Anthropic model, matched
 * case-insensitively anywhere in the id (DESIGN §5.1). Such models use the
 * native Anthropic passthrough path.
 */
export function isAnthropic(nativeModelId: string): boolean {
  const lower = nativeModelId.toLowerCase();
  return lower.includes("claude") || lower.includes("anthropic");
}
