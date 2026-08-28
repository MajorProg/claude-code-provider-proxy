/**
 * Outbound HTTP helpers (DESIGN §9, §8.2).
 *
 * Centralizes calling upstream providers: injects the outbound Bedrock bearer
 * credential and forwards the Anthropic protocol headers the upstream needs.
 */
import { errorMessage, logger } from "../logging/logger.ts";

const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";

/** Minimal header reader (decoupled from DOM/undici/Bun Headers types). */
export interface HeaderReader {
  get(name: string): string | null;
}

/**
 * Build outbound headers for the native Anthropic passthrough route (Path P).
 *
 * Used for `bedrock.mantle.*` Claude models via Mantle's `/anthropic/v1/messages`
 * (`x-api-key`) and for external native-Anthropic providers (DeepSeek/Alibaba use
 * `x-api-key`; z.ai uses `bearer`). Forwards `anthropic-version` (default
 * 2023-06-01) and `anthropic-beta` verbatim when present (DESIGN §6.1).
 *
 * @param authStyle "x-api-key" (default) or "bearer" (Authorization: Bearer).
 */
export function buildAnthropicHeaders(
  inbound: HeaderReader,
  bearerToken: string,
  authStyle: "x-api-key" | "bearer" = "x-api-key",
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": inbound.get("anthropic-version") ?? DEFAULT_ANTHROPIC_VERSION,
  };
  if (authStyle === "bearer") {
    headers.authorization = `Bearer ${bearerToken}`;
  } else {
    headers["x-api-key"] = bearerToken;
  }
  const beta = inbound.get("anthropic-beta");
  if (beta) headers["anthropic-beta"] = beta;
  return headers;
}

/**
 * Build outbound headers for the Converse route (Path C).
 *
 * The Converse route REQUIRES `Authorization: Bearer <token>` and rejects
 * `x-api-key` with 403 (live-verified, DESIGN §5.5).
 */
export function buildConverseHeaders(bearerToken: string): Record<string, string> {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${bearerToken}`,
  };
}

/**
 * Build outbound headers for the Mantle OpenAI route (Path M).
 * Accepts either header style; we use `Authorization: Bearer` (DESIGN §5.5).
 */
export function buildOpenAIHeaders(bearerToken: string): Record<string, string> {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${bearerToken}`,
  };
}

/** Transient failures worth a brief retry (network hiccups, throttling, 5xx). */
function isTransientStatus(status: number): boolean {
  return TRANSIENT_STATUS_CODES.has(status);
}

/** Retry/timeout policy constants (named rather than inline magic numbers). */
const TRANSIENT_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const RETRY_BACKOFF_BASE_MS = 150;
const RETRY_JITTER_RATIO = 0.3;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 120_000;

/** Options for {@link postJson}. */
export interface PostJsonOptions {
  maxRetries?: number;
  /** Per-attempt timeout in ms (aborts a stalled upstream). */
  timeoutMs?: number;
  /** Inbound request signal — aborting the client request aborts the upstream. */
  signal?: AbortSignal;
}

/**
 * POST a JSON body to an upstream URL with the given headers.
 *
 * Each attempt is bounded by a timeout (AbortController) so a stalled upstream
 * cannot hang the request/retry loop indefinitely or leak the socket; an
 * optional inbound `signal` propagates client disconnects to the upstream fetch.
 * Retries a small number of times on transient network errors and transient
 * upstream statuses (429/5xx) with jittered linear backoff. Non-transient
 * responses (including 4xx other than 429) are returned immediately for the
 * caller to handle and relay unmodified.
 */
export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: string,
  options: PostJsonOptions = {},
): Promise<Response> {
  const maxRetries = options.maxRetries ?? 2;
  const timeoutMs = options.timeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // If the client already went away, stop before spending another attempt.
    if (options.signal?.aborted) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new Error("Request aborted by client");
    }
    const controller = new AbortController();
    const onAbort = (): void => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new Error("Upstream request timed out")),
      timeoutMs,
    );
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
      if (isTransientStatus(res.status) && attempt < maxRetries) {
        logger.warn("upstream transient status, retrying", {
          url,
          status: res.status,
          attempt: attempt + 1,
          maxRetries,
        });
        // Release the connection without buffering the discarded body.
        await res.body?.cancel().catch(() => {});
        await sleep(backoffDelay(attempt));
        continue;
      }
      return res;
    } catch (err) {
      lastError = err;
      // A client-driven abort is terminal — don't retry it.
      if (options.signal?.aborted) throw err;
      if (attempt < maxRetries) {
        logger.warn("upstream request error, retrying", {
          url,
          attempt: attempt + 1,
          maxRetries,
          message: errorMessage(err),
        });
        await sleep(backoffDelay(attempt));
      }
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }
  throw new Error(`Upstream request failed for ${url} after ${maxRetries + 1} attempts`, {
    cause: lastError,
  });
}

/** Linear backoff with ±30% jitter to avoid a thundering herd against a 429. */
function backoffDelay(attempt: number): number {
  const base = RETRY_BACKOFF_BASE_MS * (attempt + 1);
  return base + Math.random() * base * RETRY_JITTER_RATIO;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
