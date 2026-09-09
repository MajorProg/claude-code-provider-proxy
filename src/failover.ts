/**
 * Pre-stream failover engine (docs/VIRTUAL_MODELS.md).
 *
 * Wraps ONE inference attempt — route a candidate, resolve a pool key, run the
 * translation-path handler — in the candidate × key attempt plan and advances
 * on eligible failures. The safety property that makes this correct is the
 * path handlers' shape: they only RETURN after the upstream responded 2xx (an
 * upstream failure throws from `assertUpstreamOk` BEFORE any Response exists),
 * so a retry never follows bytes already sent to the client. Once a handler
 * returns — streaming or not — no further attempts are made.
 *
 * Eligible failures (decided): upstream 401/403/429 (auth rejected, quota,
 * rate limit) and connection-level exhaustion (UpstreamRequestError — every
 * postJson attempt died before headers). NOT eligible: 5xx (never re-sent —
 * a re-sent long generation would double-charge), other 4xx, translation
 * errors, credential resolution. Client aborts rethrow immediately.
 *
 * Order: candidates in config order × their credential pools in config order
 * (next key before next model), always from the top — no cross-request
 * stickiness. Total attempts capped at config.maxFailoverAttempts.
 *
 * Cross-request cooldown: a 429 response marks the offending (provider, key
 * label) pair degraded for COOLDOWN_MS. Subsequent requests skip degraded
 * entries in buildAttempts, so they go straight to the next working key
 * without burning a live attempt on a known-rate-limited credential. The
 * cooldown expires automatically via a TTL map; no restart is needed.
 */
import type { CredentialPoolEntry, ProxyConfig } from "./config.ts";
import { BadRequestError, ProviderDisabledError, UpstreamError } from "./errors.ts";
import { UpstreamRequestError } from "./http/upstream.ts";
import { errorMessage, logger } from "./logging/logger.ts";
import {
  currentRequestContext,
  servingKeyToken,
  updateRequestContext,
} from "./logging/request-context.ts";
import { type CanonicalId, formatCanonicalId } from "./model/canonical-id.ts";
import type { Catalog, RegionTokenProvider } from "./model/catalog.ts";
import { type RouteTarget, VIRTUAL_PROVIDER, route, routeCandidates } from "./router.ts";

/** Statuses that advance to the next attempt (auth rejected / quota / rate limit). */
const FAILOVER_STATUSES: readonly number[] = [401, 403, 429];

/** How long (ms) a key is held out of rotation after receiving a 429. */
const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Cross-request cooldown store for rate-limited credentials.
 *
 * When a (provider, key label) pair receives a 429, it is marked degraded for
 * COOLDOWN_MS. `buildAttempts` skips degraded entries so subsequent requests
 * go straight to the next working key without burning a live attempt. The
 * store holds one live Timer per entry that clears the record on expiry —
 * timers are unref()'d so they never keep the process alive on their own.
 *
 * The key is `"${provider}:${label}"` — label is operator-visible metadata,
 * never the credential value itself.
 */
export class CredentialCooldownStore {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Mark a (provider, label) pair as degraded for COOLDOWN_MS. */
  mark(provider: string, label: string): void {
    const key = `${provider}:${label}`;
    const existing = this.timers.get(key);
    if (existing !== undefined) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(key);
      logger.info("credential cooldown expired, reinstating key", { provider, keyLabel: label });
    }, COOLDOWN_MS);
    // Don't keep the process alive if the server shuts down between requests.
    if (typeof timer === "object" && timer !== null && "unref" in timer) {
      (timer as { unref(): void }).unref();
    }
    this.timers.set(key, timer);
    logger.warn("credential marked degraded (429 cooldown)", {
      provider,
      keyLabel: label,
      cooldownMs: COOLDOWN_MS,
    });
  }

  /** True when this (provider, label) pair is currently in cooldown. */
  isDegraded(provider: string, label: string): boolean {
    return this.timers.has(`${provider}:${label}`);
  }

  /** Clear all cooldowns (used in tests to reset state between cases). */
  clear(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}

/**
 * Pattern set for upstream 400 bodies that signal context/input too long.
 *
 * A 400 is normally a hard client error — the same request will fail on every
 * candidate. But "input too long" is context-window-specific: the next
 * candidate in the virtual tier may have a larger context window and succeed.
 * We match the body text (lowercased) against known provider wording so only
 * this narrow class of 400s triggers failover, not malformed-body or
 * unsupported-field rejections.
 *
 * Known provider patterns (verified live or from provider docs):
 *   - Alibaba/Qwen:  "range of input length should be [1, N]"
 *   - OpenAI-compat: error.code === "context_length_exceeded"
 *   - Anthropic-compat: "prompt is too long", "too many tokens"
 *   - Generic:       "input length" + "exceed" (catches "[1, N]" variants)
 */
const CONTEXT_TOO_LONG_PATTERNS: readonly RegExp[] = [
  /context[_\s]length[_\s]exceeded/i,
  /prompt is too long/i,
  /too many tokens/i,
  /input length.*exceed/i,
  /range of input length/i,
  /maximum context length/i,
];

/**
 * True when a 400 UpstreamError's body indicates the context/input was too
 * large for this particular model. Used to make "context too long" failover-
 * eligible so a virtual tier can advance to a candidate with a larger window.
 */
export function isContextTooLong(err: UpstreamError): boolean {
  if (err.status !== 400) return false;
  const body = (err.upstreamBody ?? "").toLowerCase();
  return CONTEXT_TOO_LONG_PATTERNS.some((re) => re.test(body));
}

/**
 * 400 body signatures of KNOWN provider-side conversion bugs — the request
 * itself is valid Anthropic, and another tier candidate can serve it as-is.
 *
 * - z.ai `1210` "Invalid API parameter": a recently-emerged server-side bug in
 *   their Anthropic-compatible converter that rejects occasional valid
 *   request shapes (shape-dependent, not reproducible on demand; see
 *   github.com/zai-org/feedback issue #81 and linked reports). Advancing to
 *   the next candidate serves the identical body fine.
 */
const PROVIDER_BUG_400_PATTERNS: readonly RegExp[] = [/"code"\s*:\s*"1210"/, /\[1210\]/];

/** True when a 400's body matches a known provider-side conversion bug. */
export function isProviderConversionBug(err: UpstreamError): boolean {
  if (err.status !== 400) return false;
  const body = err.upstreamBody ?? "";
  return PROVIDER_BUG_400_PATTERNS.some((re) => re.test(body));
}

/** True when the error qualifies for a failover attempt. */
function isFailoverEligible(err: unknown): boolean {
  if (err instanceof UpstreamError) {
    if (FAILOVER_STATUSES.includes(err.status)) return true;
    // A 400 that signals "input too long" is failover-eligible: the next
    // candidate in the virtual tier may accept a larger context window.
    if (isContextTooLong(err)) return true;
    // A 400 matching a known provider conversion bug: the same valid request
    // succeeds on the next candidate — don't surface the provider's bug.
    if (isProviderConversionBug(err)) return true;
    return false;
  }
  return err instanceof UpstreamRequestError;
}

/**
 * True when an error is a client-driven abort — the inbound request's
 * `AbortSignal` fired because the client closed the connection mid-flight
 * (e.g. the user hit Esc, or a streaming turn was cancelled). Not a proxy
 * fault and there is no client left to serve: never retried, logged quietly.
 * A structural `name` check (not `instanceof DOMException`) keeps this robust
 * across the Error/DOMException shapes Bun surfaces for aborts.
 */
export function isClientDisconnect(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name: unknown }).name === "AbortError"
  );
}

/** What executed: the winning response plus routing/label info for logging. */
export interface FailoverOutcome {
  readonly response: Response;
  readonly target: RouteTarget;
  /** Serving pool entry's label (cost attribution); absent for bedrock targets. */
  readonly keyLabel?: string;
  /** REAL canonical id that served (the tier entry for virtual ids; the request id otherwise). */
  readonly servedModel: string;
  /** 1-based number of attempts consumed. */
  readonly attempts: number;
}

/** One flattened attempt in the plan. */
interface Attempt {
  readonly target: RouteTarget;
  readonly entry: CredentialPoolEntry | undefined;
  /** Real canonical id of this candidate (tier entry / direct id). */
  readonly sourceId: string;
}

/**
 * Build the attempt plan: virtual ids expand to their ordered candidates;
 * any other id is a single candidate (existing single-id behavior). Each
 * candidate contributes its pool entries in order; pool-less targets
 * (bedrock) contribute one slot — credential resolution stays with the
 * caller's exec via the entry (undefined = mint/handle externally).
 *
 * Entries currently in cooldown are skipped; if ALL entries for a target are
 * degraded the target itself is skipped (produces a log warning). This keeps
 * the attempt count predictable and avoids wasting the cap on known-bad keys.
 */
function buildAttempts(
  config: ProxyConfig,
  catalog: Catalog,
  id: CanonicalId,
  maxAttempts: number,
  cooldownStore?: CredentialCooldownStore | undefined,
): Attempt[] {
  const tierEntries =
    id.provider === VIRTUAL_PROVIDER ? (config.virtualModels?.[id.nativeModelId] ?? []) : null;
  // Per-candidate REAL canonical id (tier entry string, or the request's own
  // id) — logged and recorded as the served model so operators always see what
  // actually answered, never the virtual alias. routeCandidates returns
  // entry-aligned sources for the candidates that routed.
  let targets: readonly RouteTarget[];
  let sourceIds: readonly string[];
  if (tierEntries !== null) {
    const expansion = routeCandidates(config, catalog, tierEntries);
    targets = expansion.targets;
    sourceIds = expansion.sources;
  } else {
    targets = [route(config, catalog, id)];
    sourceIds = [formatCanonicalId(id)];
  }

  const attempts: Attempt[] = [];
  for (let t = 0; t < targets.length; t++) {
    const target = targets[t] as RouteTarget;
    const sourceId = sourceIds[t] ?? formatCanonicalId(id);
    if (target.credentials && target.credentials.length > 0) {
      let skipped = 0;
      for (const entry of target.credentials) {
        if (
          cooldownStore !== undefined &&
          entry.label !== undefined &&
          cooldownStore.isDegraded(target.provider, entry.label)
        ) {
          skipped++;
          continue;
        }
        attempts.push({ target, entry, sourceId });
        if (attempts.length >= maxAttempts) return attempts.slice(0, maxAttempts);
      }
      if (skipped > 0 && skipped === target.credentials.length) {
        logger.warn("all credentials for provider are in cooldown, skipping candidate", {
          provider: target.provider,
          model: target.invocationId,
        });
      }
    } else {
      attempts.push({ target, entry: undefined, sourceId });
      if (attempts.length >= maxAttempts) return attempts.slice(0, maxAttempts);
    }
  }
  return attempts.slice(0, maxAttempts);
}

/**
 * Execute the attempt plan. `exec` performs ONE upstream call for the given
 * target + pool entry (credential resolution and translation-path dispatch
 * stay with the caller, reusing its existing auth logic); anything it throws
 * is classified per the module rules. Exhaustion rethrows the LAST error
 * unchanged — the client sees exactly today's error shape.
 *
 * When a `cooldownStore` is provided, a 429 response marks the offending
 * (provider, key label) pair degraded for COOLDOWN_MS so future requests
 * skip it immediately.
 */
export async function executeWithFailover(opts: {
  config: ProxyConfig;
  catalog: Catalog;
  tokenProvider: RegionTokenProvider | null;
  canonicalId: CanonicalId;
  signal?: AbortSignal | undefined;
  exec: (ctx: { target: RouteTarget; entry: CredentialPoolEntry | undefined }) => Promise<Response>;
  /** count_tokens mode: keep only passthrough targets with a countTokensPath. */
  countTokensOnly?: boolean | undefined;
  /** Cross-request cooldown store; when present, 429s mark keys degraded. */
  cooldownStore?: CredentialCooldownStore | undefined;
}): Promise<FailoverOutcome> {
  const { config, catalog, canonicalId, signal, exec, cooldownStore } = opts;
  let attempts = buildAttempts(
    config,
    catalog,
    canonicalId,
    config.maxFailoverAttempts,
    cooldownStore,
  );
  if (opts.countTokensOnly) {
    attempts = attempts.filter(
      (a) => a.target.translationPath === "passthrough" && a.target.countTokensPath !== undefined,
    );
  }
  if (attempts.length === 0) {
    // count_tokens keeps its classic error when no candidate supports it;
    // otherwise route() (or routeVirtual) re-runs for its descriptive throw —
    // an empty plan means a fully-unavailable virtual tier.
    if (opts.countTokensOnly) {
      throw new BadRequestError("count_tokens is not supported for this backend/model");
    }
    const t = route(config, catalog, canonicalId);
    // route() succeeded, yet the plan is empty: every usable pool key of the
    // (first available) target is sitting in 429 cooldown. Actionable 404,
    // not an opaque 500.
    throw new ProviderDisabledError(
      t.provider,
      `all credential-pool keys are in 429 cooldown (~${Math.round(COOLDOWN_MS / 1000)}s); retry shortly`,
    );
  }

  let lastError: unknown;
  for (let i = 0; i < attempts.length; i++) {
    const { target, entry, sourceId } = attempts[i] as Attempt;
    // Correlate engine lines with the inbound request (absent in unit tests).
    const reqId = currentRequestContext()?.requestId;
    try {
      const response = await exec({ target, entry });
      const keyLabel = entry?.label ?? (entry !== undefined ? "default" : undefined);
      const logFields = {
        ...(reqId !== undefined ? { requestId: reqId } : {}),
        provider: target.provider,
        model: sourceId,
        ...(keyLabel !== undefined ? { key: servingKeyToken(target.provider, keyLabel) } : {}),
        attempt: i + 1,
      };
      if (i > 0) logger.info("upstream selected after failover", logFields);
      else logger.debug("upstream selected", logFields);
      // Record what actually served so the request-completed line (and any
      // future metrics) sees the real model + key, never the virtual alias.
      updateRequestContext({
        servedModel: sourceId,
        provider: target.provider,
        ...(keyLabel !== undefined ? { keyLabel } : {}),
        attempts: i + 1,
      });
      return {
        response,
        target,
        attempts: i + 1,
        servedModel: sourceId,
        ...(keyLabel !== undefined ? { keyLabel } : {}),
      };
    } catch (err) {
      if (isClientDisconnect(err) || signal?.aborted) throw err;
      lastError = err;
      // Record the ATTEMPTED key even on failure, so error log lines attribute
      // the failure to a key (the relayed error's route/model match this).
      if (entry !== undefined) {
        updateRequestContext({
          provider: target.provider,
          keyLabel: entry.label ?? "default",
        });
      }
      // Mark the key degraded on a 429 so future requests skip it immediately.
      if (
        cooldownStore !== undefined &&
        err instanceof UpstreamError &&
        err.status === 429 &&
        entry?.label !== undefined
      ) {
        cooldownStore.mark(target.provider, entry.label);
      }
      if (!isFailoverEligible(err) || i === attempts.length - 1) throw err;
      logger.warn("failover attempt failed, advancing", {
        ...(reqId !== undefined ? { requestId: reqId } : {}),
        attempt: i + 1,
        of: attempts.length,
        provider: target.provider,
        model: sourceId,
        ...(entry?.label ? { key: servingKeyToken(target.provider, entry.label) } : {}),
        status: err instanceof UpstreamError ? err.status : undefined,
        error: errorMessage(err),
      });
    }
  }
  throw lastError; // unreachable (the loop always returns or throws) — for the type checker
}
