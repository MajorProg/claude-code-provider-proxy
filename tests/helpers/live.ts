/**
 * Live-test lane helper.
 *
 * Live suites hit real provider endpoints (AWS Bedrock control-plane +
 * runtime, and external providers) using credentials from the environment.
 * They are inherently non-hermetic: they can fail on expired session tokens,
 * provider 429s, or network timeouts. To keep the merge gate (`bun run
 * test:unit`) deterministic, live suites are SKIPPED by default and only run
 * when explicitly opted in via `RUN_LIVE=1` (the `test:live` lane).
 *
 * Usage in a live suite:
 *
 *   import { describeLive, awsCreds } from "./helpers/live.ts";
 *   describeLive("route (against live catalog)", () => {
 *     // ... tests. Inside beforeAll, call awsCreds() for typed creds.
 *   });
 *
 * When live is not enabled the whole block is registered with `describe.skip`,
 * so no `beforeAll` runs and nothing hits the network — the suite reports as
 * skipped, never failed.
 */
import { describe } from "bun:test";

/** True when the live lane is explicitly enabled AND AWS creds are present. */
export function liveEnabled(): boolean {
  if (process.env.RUN_LIVE !== "1") return false;
  return Boolean(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
}

/**
 * `describe` that runs only in the live lane; otherwise `describe.skip`.
 * Keeps live suites from failing the hermetic merge gate on missing creds or
 * flaky provider endpoints.
 */
export function describeLive(name: string, fn: () => void): void {
  (liveEnabled() ? describe : describe.skip)(name, fn);
}

export interface AwsCreds {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/**
 * Read AWS credentials from the environment for a live suite's `beforeAll`.
 * Only ever called inside a `describeLive` block, so if this throws the live
 * lane was misconfigured (RUN_LIVE=1 without creds) — fail loudly.
 */
export function awsCreds(): AwsCreds {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("Live tests require AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY");
  }
  const sessionToken = process.env.AWS_SESSION_TOKEN;
  return { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) };
}

/**
 * True when a given external-provider API key is present. Live external-provider
 * suites use this to skip individually (a provider key may be absent even when
 * AWS creds are present).
 */
export function providerKeyPresent(envVar: string): boolean {
  return Boolean(process.env[envVar]);
}
