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
 * 2023-06-01).
 *
 * `anthropic-beta` is deliberately NOT forwarded. It is a Claude Code ↔
 * Anthropic-public-API contract; none of the Path P targets are the Anthropic
 * public API. Bedrock's native `/anthropic/v1/messages` route strictly
 * validates beta flags and rejects unknown ones with `400 invalid beta flag`
 * (Claude Code sends 20+ that Bedrock does not recognise), and the external
 * Anthropic-compatible providers (z.ai/DeepSeek/Alibaba/Moonshot) implement
 * their own subsets rather than Anthropic's beta set. All the features these
 * flags gate (thinking, tool use, vision, prompt caching) are enabled
 * server-side on the passthrough path without the header, so dropping it is
 * both necessary (to stop the 400s) and lossless. A blocklist/allowlist of
 * flag names would drift as Claude Code and providers change; unconditional
 * drop keeps this free of a hardcoded, maintained flag catalog.
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
/**
 * Exponential-backoff with full jitter (PC4). The ceiling doubles per attempt
 * (base, 2·base, 4·base, …) capped at {@link RETRY_BACKOFF_CAP_MS}, then a
 * uniform random in [0, ceiling) is taken ("full jitter", AWS Architecture
 * Blog) — this decorrelates concurrent retriers far better than fixed/linear
 * backoff. Always subordinate to a server `Retry-After` (PC3), which wins.
 */
const RETRY_BACKOFF_BASE_MS = 150;
const RETRY_BACKOFF_CAP_MS = 10_000;
/**
 * Upper bound (ms) on how long we will honor an upstream `Retry-After` before a
 * transient-status retry (PC3). A server can legitimately ask us to wait, but an
 * unbounded (or hostile) value must not hang the request/retry loop, so we cap
 * it. If `Retry-After` exceeds the cap we still wait the cap, not the full value.
 */
const MAX_RETRY_AFTER_MS = 30_000;
/**
 * Time-to-headers timeout (PC1): bounds connect + first byte, i.e. how long we
 * wait for the upstream to RESOLVE the fetch (return response headers). It is
 * cleared the instant the response resolves, so it never limits the lifetime of
 * an actively-streaming body — a long but healthy stream is not killed. Idle
 * gaps WITHIN a stream are bounded separately by {@link readWithIdleTimeout}.
 */
const DEFAULT_TIME_TO_HEADERS_MS = 120_000;
/**
 * Per-chunk idle-read timeout (PC1): the maximum gap allowed BETWEEN streamed
 * chunks. Resets on every chunk, so it protects against a hung/stalled upstream
 * mid-stream without capping total stream duration. Generous enough to cover a
 * slow model's inter-token latency + a long tool "thinking" pause.
 */
export const DEFAULT_STREAM_IDLE_MS = 60_000;

/** Options for {@link postJson}. */
export interface PostJsonOptions {
  maxRetries?: number;
  /**
   * Time-to-headers timeout in ms (PC1). Bounds waiting for the upstream to
   * return response headers; does NOT bound a streaming body's lifetime.
   */
  timeoutMs?: number;
  /** Inbound request signal — aborting the client request aborts the upstream. */
  signal?: AbortSignal;
  /**
   * Whether to retry on a transient upstream *status* (429/5xx) by replaying the
   * request body (PC2). Default `true` for non-streaming requests. Streaming
   * callers MUST pass `false`: a transient status means the upstream already
   * received (and may have partially processed) the request, so replaying the
   * body risks a duplicated/double-billed generation. Pre-response *connection*
   * errors (thrown before any response) are still retried regardless, since no
   * processing occurred.
   */
  retryTransientStatus?: boolean;
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
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIME_TO_HEADERS_MS;
  const retryTransientStatus = options.retryTransientStatus ?? true;
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
    // PC1: this timer bounds only time-to-headers. We clear it the moment fetch
    // resolves (headers arrived), so a long streaming body is never aborted by
    // it; inter-chunk idle is bounded separately by readWithIdleTimeout.
    const timer = setTimeout(
      () => controller.abort(new Error("Upstream timed out waiting for response headers")),
      timeoutMs,
    );
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
      // Headers arrived — stop the time-to-headers timer immediately so it can
      // never fire against the streaming body that follows.
      clearTimeout(timer);
      if (isTransientStatus(res.status) && retryTransientStatus && attempt < maxRetries) {
        // PC3: honor a server-provided Retry-After (capped) over our own
        // backoff. Falls back to jittered backoff when the header is absent.
        const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
        const delayMs =
          retryAfterMs !== undefined
            ? Math.min(retryAfterMs, MAX_RETRY_AFTER_MS)
            : backoffDelay(attempt);
        logger.warn("upstream transient status, retrying", {
          url,
          status: res.status,
          attempt: attempt + 1,
          maxRetries,
          delayMs,
          retryAfter: retryAfterMs !== undefined,
        });
        // Release the connection without buffering the discarded body.
        await res.body?.cancel().catch(() => {});
        await sleep(delayMs);
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

/**
 * Exponential backoff with full jitter (PC4): ceiling = min(base·2^attempt,
 * cap); returns a uniform random in [0, ceiling). Exported for testing the
 * bounds (the value itself is random).
 */
export function backoffDelay(attempt: number): number {
  const ceiling = Math.min(RETRY_BACKOFF_BASE_MS * 2 ** attempt, RETRY_BACKOFF_CAP_MS);
  return Math.random() * ceiling;
}

/** The exponential ceiling for a given attempt (PC4), for test assertions. */
export function backoffCeilingMs(attempt: number): number {
  return Math.min(RETRY_BACKOFF_BASE_MS * 2 ** attempt, RETRY_BACKOFF_CAP_MS);
}

/**
 * Parse an HTTP `Retry-After` header into a delay in ms (PC3), supporting both
 * forms from RFC 9110 §10.2.3: delta-seconds (e.g. `"120"`) and an HTTP-date
 * (e.g. `"Wed, 21 Oct 2026 07:28:00 GMT"`). Returns `undefined` when the header
 * is absent or unparseable. A past date or negative delta clamps to 0. The
 * caller is responsible for capping the returned value.
 *
 * @param value  The raw header value (or null/undefined when absent).
 * @param nowMs  Current epoch ms (injectable for deterministic testing).
 */
export function parseRetryAfter(
  value: string | null | undefined,
  nowMs: number = Date.now(),
): number | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  // delta-seconds: a bare non-negative integer.
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  // HTTP-date form.
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return undefined;
  return Math.max(0, dateMs - nowMs);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Best-effort connection warming (PC5). Bun pools outbound connections with TCP
 * keep-alive by default, so subsequent requests to the same origin reuse a live
 * socket; the only cold cost is the first request's DNS + TCP + TLS. This resolves
 * DNS and establishes the TCP/TLS connection ahead of time via Bun's
 * `fetch.preconnect` (a Bun extension) so the first real message-path request
 * finds a warm socket. It is entirely best-effort: unsupported runtimes, bad
 * URLs, and connection failures are swallowed (a failed warm-up must never
 * affect correctness — the real request will just pay the cold cost).
 *
 * @param origin  An absolute URL whose origin should be pre-connected.
 */
export function preconnectOrigin(
  origin: string,
  preconnectFn: ((url: string) => void) | undefined = (
    fetch as unknown as { preconnect?: (url: string) => void }
  ).preconnect,
): void {
  try {
    if (typeof preconnectFn !== "function") return; // non-Bun runtime — no-op
    // Normalize to the origin (scheme + host + port); preconnect ignores path.
    const u = new URL(origin);
    preconnectFn(u.origin);
  } catch {
    // best-effort only — never throw from a warm-up
  }
}

/**
 * Read the next chunk from a stream reader, bounded by a per-chunk idle timeout
 * (PC1). Resets implicitly on each call, so it caps the gap BETWEEN chunks —
 * protecting against a hung mid-stream upstream — without limiting total stream
 * duration. On idle timeout it cancels the reader and throws, so the caller's
 * existing catch path fails the stream cleanly.
 *
 * @param reader  The stream reader to read from.
 * @param idleMs  Max ms to wait for the next chunk (default DEFAULT_STREAM_IDLE_MS).
 */
/** The result shape of a stream reader's `read()` (avoids a DOM-lib dependency). */
export type StreamReadResult<T> = { done: false; value: T } | { done: true; value?: undefined };

export async function readWithIdleTimeout<T>(
  reader: { read(): Promise<StreamReadResult<T>>; cancel(reason?: unknown): Promise<void> },
  idleMs: number = DEFAULT_STREAM_IDLE_MS,
): Promise<StreamReadResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const idle = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`Upstream stream idle for more than ${idleMs}ms`);
      void reader.cancel(err).catch(() => {});
      reject(err);
    }, idleMs);
  });
  try {
    return await Promise.race([reader.read(), idle]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
