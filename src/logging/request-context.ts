/**
 * Per-request serving context (cross-cutting log enrichment).
 *
 * The fetch-handler wrapper opens one mutable record per request (keyed by
 * requestId via AsyncLocalStorage); the failover engine records WHICH
 * provider/key/model actually served as attempts resolve, and the
 * "request completed" log line reads it back — so every completed request
 * shows the real canonical model and the serving key (e.g.
 * `served=zai.anthropic.global.glm-5.3 key=zai/secondary`), not just the
 * virtual tier the client asked for.
 *
 * All fields are metadata only: key LABELS, never credential values (the
 * logger contract — see logger.ts). Stores are absent when a dispatcher is
 * driven directly (tests); every accessor no-ops then.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestServingInfo {
  /** Correlation id of the inbound request (from createFetchHandler). */
  requestId?: string;
  /** Canonical id the client asked for (may be a virtual tier id). */
  requestedModel?: string;
  /** REAL canonical id that served the request (resolved tier candidate). */
  servedModel?: string;
  /** Serving provider id (e.g. "zai"). */
  provider?: string;
  /** Serving pool-entry label (e.g. "secondary"); absent for bedrock. */
  keyLabel?: string;
  /** 1-based attempts consumed (failover depth). */
  attempts?: number;
}

export const requestContext = new AsyncLocalStorage<RequestServingInfo>();

/**
 * Merge fields into the CURRENT request's record (no-op when called outside a
 * request scope — e.g. unit tests driving dispatchers directly).
 */
export function updateRequestContext(patch: Partial<RequestServingInfo>): void {
  const store = requestContext.getStore();
  if (store !== undefined) Object.assign(store, patch);
}

/** The current request's serving record, if any (read by log emitters). */
export function currentRequestContext(): RequestServingInfo | undefined {
  return requestContext.getStore();
}

/** Compact serving token for log lines: "provider/label" or "provider". */
export function servingKeyToken(provider: string, keyLabel?: string): string {
  return keyLabel !== undefined && keyLabel !== "" ? `${provider}/${keyLabel}` : provider;
}
