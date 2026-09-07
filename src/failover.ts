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
 */
import type { CredentialPoolEntry, ProxyConfig } from "./config.ts";
import { BadRequestError, UpstreamError } from "./errors.ts";
import { UpstreamRequestError } from "./http/upstream.ts";
import { errorMessage, logger } from "./logging/logger.ts";
import type { CanonicalId } from "./model/canonical-id.ts";
import type { Catalog, RegionTokenProvider } from "./model/catalog.ts";
import { type RouteTarget, VIRTUAL_PROVIDER, route, routeCandidates } from "./router.ts";

/** Statuses that advance to the next attempt (auth rejected / quota / rate limit). */
const FAILOVER_STATUSES: readonly number[] = [401, 403, 429];

/** True when the error qualifies for a failover attempt. */
function isFailoverEligible(err: unknown): boolean {
  if (err instanceof UpstreamError) return FAILOVER_STATUSES.includes(err.status);
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
  /** 1-based number of attempts consumed. */
  readonly attempts: number;
}

/** One flattened attempt in the plan. */
interface Attempt {
  readonly target: RouteTarget;
  readonly entry: CredentialPoolEntry | undefined;
}

/**
 * Build the attempt plan: virtual ids expand to their ordered candidates;
 * any other id is a single candidate (existing single-id behavior). Each
 * candidate contributes its pool entries in order; pool-less targets
 * (bedrock) contribute one slot — credential resolution stays with the
 * caller's exec via the entry (undefined = mint/handle externally).
 */
function buildAttempts(
  config: ProxyConfig,
  catalog: Catalog,
  id: CanonicalId,
  maxAttempts: number,
): Attempt[] {
  const tierEntries =
    id.provider === VIRTUAL_PROVIDER ? (config.virtualModels?.[id.nativeModelId] ?? []) : null;
  const targets =
    tierEntries !== null
      ? routeCandidates(config, catalog, tierEntries).targets
      : [route(config, catalog, id)];

  const attempts: Attempt[] = [];
  for (const target of targets) {
    if (target.credentials && target.credentials.length > 0) {
      for (const entry of target.credentials) attempts.push({ target, entry });
    } else {
      attempts.push({ target, entry: undefined });
    }
    if (attempts.length >= maxAttempts) return attempts.slice(0, maxAttempts);
  }
  return attempts.slice(0, maxAttempts);
}

/**
 * Execute the attempt plan. `exec` performs ONE upstream call for the given
 * target + pool entry (credential resolution and translation-path dispatch
 * stay with the caller, reusing its existing auth logic); anything it throws
 * is classified per the module rules. Exhaustion rethrows the LAST error
 * unchanged — the client sees exactly today's error shape.
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
}): Promise<FailoverOutcome> {
  const { config, catalog, canonicalId, signal, exec } = opts;
  let attempts = buildAttempts(config, catalog, canonicalId, config.maxFailoverAttempts);
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
    route(config, catalog, canonicalId);
    throw new Error("unreachable: route() returned no attempts");
  }

  let lastError: unknown;
  for (let i = 0; i < attempts.length; i++) {
    const { target, entry } = attempts[i] as Attempt;
    try {
      const response = await exec({ target, entry });
      const logFields = {
        provider: target.provider,
        model: target.invocationId,
        ...(entry?.label ? { keyLabel: entry.label } : {}),
        attempt: i + 1,
      };
      if (i > 0) logger.info("upstream selected after failover", logFields);
      else logger.debug("upstream selected", logFields);
      return {
        response,
        target,
        attempts: i + 1,
        ...(entry?.label ? { keyLabel: entry.label } : {}),
      };
    } catch (err) {
      if (isClientDisconnect(err) || signal?.aborted) throw err;
      lastError = err;
      if (!isFailoverEligible(err) || i === attempts.length - 1) throw err;
      logger.warn("failover attempt failed, advancing", {
        attempt: i + 1,
        of: attempts.length,
        provider: target.provider,
        model: target.invocationId,
        ...(entry?.label ? { keyLabel: entry.label } : {}),
        status: err instanceof UpstreamError ? err.status : undefined,
        error: errorMessage(err),
      });
    }
  }
  throw lastError; // unreachable (the loop always returns or throws) — for the type checker
}
