/**
 * The single place that decides whether Bedrock is usable (DESIGN §8.2).
 *
 * Bedrock is OPTIONAL: a fresh install may have no Bedrock credential at all
 * and run on external providers only. This module classifies a configured
 * credential and, when it is usable, builds the region token provider. The
 * decision is env-aware: the "dev" sentinel is only usable when AWS_* env
 * credentials are present.
 *
 * Every consumer (buildRuntime, router, describeAuth, doctor) goes through
 * `resolveBedrockMode` / `isBedrockCredentialUsable` so "disabled" is always
 * classified the same way.
 */
import type { RegionTokenProvider } from "../model/catalog.ts";
import { BEDROCK_DEV_SENTINELS, createBedrockTokenProvider } from "./token-provider.ts";

/** Placeholder marker used by .env.example-style files. */
const PLACEHOLDER_MARKER = "REPLACE_ME";

/**
 * Coarse classification of a provider credential (Bedrock or external) for
 * skip decisions. `empty` and `placeholder` both mean "not configured yet";
 * `dev` and `key` mean "configured" (Bedrock-only distinction).
 */
export type CredentialState = "empty" | "placeholder" | "dev" | "key";

/** Classify a credential WITHOUT consulting the environment (no I/O). */
export function credentialState(credential: string | undefined): CredentialState {
  if (credential === undefined || credential === "") return "empty";
  if (credential.includes(PLACEHOLDER_MARKER)) return "placeholder";
  if (BEDROCK_DEV_SENTINELS.has(credential)) return "dev";
  return "key";
}

/** Whether a credential is usable at all (empty/placeholder ⇒ not configured). */
export function isCredentialSet(credential: string | undefined): boolean {
  const state = credentialState(credential);
  return state === "dev" || state === "key";
}

/** Outcome of the Bedrock-mode decision. */
export type BedrockMode =
  | { readonly enabled: true; readonly tokenProvider: RegionTokenProvider }
  | { readonly enabled: false; readonly reason: string };

/**
 * Classification without token-provider construction. Shared by
 * `resolveBedrockMode` (which adds the provider) and `bedrockDisabledReason`
 * (the cheap hot-path form used by the router).
 */
function classifyBedrock(
  configuredCredential: string | undefined,
  env: Record<string, string | undefined>,
): { enabled: true; credential: string } | { enabled: false; reason: string } {
  const state = credentialState(configuredCredential);
  if (state === "empty") {
    return {
      enabled: false,
      reason:
        'no Bedrock credential configured (set BEDROCK_API_KEY, or credential "dev" with AWS_* env vars, to enable)',
    };
  }
  if (state === "placeholder") {
    return {
      enabled: false,
      reason:
        "Bedrock credential is a placeholder (REPLACE_ME) — set a real BEDROCK_API_KEY to enable",
    };
  }
  if (state === "dev") {
    if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) {
      return {
        enabled: false,
        reason: "dev mode selected but AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY are not set",
      };
    }
    return { enabled: true, credential: "" };
  }
  return { enabled: true, credential: configuredCredential ?? "" };
}

/**
 * Decide whether Bedrock is enabled for `configuredCredential` under `env`:
 *
 * - empty / absent  ⇒ disabled ("no credential configured")
 * - placeholder     ⇒ disabled (never send a known-bogus key upstream — this
 *                     is what turned into a 403 crash loop before)
 * - "dev"/"DEV"     ⇒ enabled iff AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY
 *                     are present, else disabled with a reason
 * - anything else   ⇒ enabled as a long-term key
 *
 * Never throws: an unusable credential yields `{ enabled: false, reason }`
 * and the caller degrades gracefully instead of crashing.
 */
export function resolveBedrockMode(
  configuredCredential: string | undefined,
  env: Record<string, string | undefined> = Bun.env,
): BedrockMode {
  const classified = classifyBedrock(configuredCredential, env);
  if (!classified.enabled) return classified;
  return { enabled: true, tokenProvider: createBedrockTokenProvider(classified.credential, env) };
}

/**
 * The disabled-reason for a Bedrock credential, or undefined when it is
 * usable. The cheap hot-path form of `resolveBedrockMode` (no token-provider
 * construction) — used by the router so a dev-mode provider's token cache is
 * never rebuilt per request.
 */
export function bedrockDisabledReason(
  credential: string | undefined,
  env: Record<string, string | undefined> = Bun.env,
): string | undefined {
  const classified = classifyBedrock(credential, env);
  return classified.enabled ? undefined : classified.reason;
}

/** Cheap boolean form — see `bedrockDisabledReason`. */
export function isBedrockCredentialUsable(
  credential: string | undefined,
  env: Record<string, string | undefined> = Bun.env,
): boolean {
  return bedrockDisabledReason(credential, env) === undefined;
}
