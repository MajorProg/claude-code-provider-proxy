/**
 * Router: canonical model id -> outbound target (DESIGN §5).
 *
 * Deterministically maps a parsed canonical id to the upstream host, path,
 * resolved invocation id, and translation path, using the live catalog for
 * model resolution and the config for host/region derivation.
 */
import { bedrockDisabledReason, isCredentialSet } from "./auth/bedrock-mode.ts";
import {
  type CredentialPoolEntry,
  type ProxyConfig,
  type RegionKey,
  assertSafeExternalOrigin,
  awsRegionForPrefix,
  externalProviderOrigin,
  hostForRegion,
} from "./config.ts";
import { ModelNotFoundError, ProviderDisabledError, UnsupportedProviderError } from "./errors.ts";
import { errorMessage } from "./logging/logger.ts";
import { type CanonicalId, isAnthropic, parseCanonicalId } from "./model/canonical-id.ts";
import { type Catalog, resolveInvocationId } from "./model/catalog.ts";

/** Which translation path handles the request (DESIGN §6). */
export type TranslationPath =
  | "passthrough" // Path P — native Anthropic on {backend}/anthropic/v1/messages
  | "converse" // Path C — Anthropic <-> Converse
  | "mantle"; // Path M — Anthropic <-> OpenAI

/** A fully resolved outbound target for a single request. */
export interface RouteTarget {
  readonly provider: string;
  readonly backend: "converse" | "mantle" | "anthropic" | "openai";
  readonly translationPath: TranslationPath;
  readonly awsRegion: string;
  /** Upstream origin, e.g. "https://bedrock-runtime.us-east-1.amazonaws.com". */
  readonly origin: string;
  /** Non-streaming request path. */
  readonly path: string;
  /** Streaming request path (may equal `path` when the body carries the stream flag). */
  readonly streamPath: string;
  /** Path for token counting, when supported (Claude passthrough only). */
  readonly countTokensPath: string | undefined;
  /** The model id to send upstream (resolved profile id or native id). */
  readonly invocationId: string;
  /** True when this model is Claude / native-Anthropic. */
  readonly isAnthropic: boolean;
  /** OpenAI strict function-calling opt-in (TC3); only set for external openai providers. */
  readonly strictTools?: boolean;
  /**
   * Usable (non-empty, non-placeholder) credential pool for external targets,
   * in failover order (docs/VIRTUAL_MODELS.md). Absent for Bedrock targets (their
   * credential is minted per-region by the token provider instead).
   */
  readonly credentials?: readonly CredentialPoolEntry[];
}

/** Map a region-family profilePrefix to a catalog RegionKey. */
function regionKeyForPrefix(config: ProxyConfig, profilePrefix: string): RegionKey {
  if (profilePrefix === "us" || profilePrefix === "eu") return profilePrefix;
  if (profilePrefix === "global") return config.primaryRegion;
  throw new ModelNotFoundError(
    `Unknown profilePrefix "${profilePrefix}" (expected global | us | eu)`,
  );
}

/**
 * Build a RouteTarget, defaulting the fields that vary only by translation
 * path. `awsRegion` defaults to "" (the external-provider sentinel — external
 * providers are region-agnostic); `streamPath` defaults to `path` (Bedrock
 * converse/mantle override it), and `countTokensPath` defaults to undefined.
 */
function makeRoute(
  fields: Omit<RouteTarget, "awsRegion" | "streamPath" | "countTokensPath" | "credentials"> &
    Partial<Pick<RouteTarget, "awsRegion" | "streamPath" | "countTokensPath" | "credentials">>,
): RouteTarget {
  return {
    awsRegion: fields.awsRegion ?? "",
    streamPath: fields.streamPath ?? fields.path,
    countTokensPath: fields.countTokensPath,
    ...fields,
  };
}

/** Resolve an external (non-Bedrock) provider target (Path P or Path M). */
function routeExternal(config: ProxyConfig, id: CanonicalId): RouteTarget {
  const provider = config.providers.external[id.provider];
  if (!provider) throw new UnsupportedProviderError(id.provider);

  // Missing-info provider (unset env ref left its host/URL empty) — clean 404
  // with the validation-time reason, BEFORE any origin construction (the
  // degenerate host would otherwise throw an opaque ConfigError).
  if (provider.inactiveReason) {
    throw new ProviderDisabledError(id.provider, provider.inactiveReason);
  }

  // Multi-region provider: select region from profilePrefix
  let origin: string;
  let pool: readonly CredentialPoolEntry[];

  if (provider.regions) {
    // profilePrefix = region code (e.g., "ap-southeast-1")
    const region = provider.regions[id.profilePrefix];
    if (!region) {
      throw new ModelNotFoundError(
        `Region "${id.profilePrefix}" not configured for provider "${id.provider}"`,
      );
    }
    // Missing-info region (unset env ref) — same actionable 404 as a disabled
    // provider, naming the region.
    if (region.inactiveReason) {
      throw new ProviderDisabledError(
        id.provider,
        `region ${id.profilePrefix}: ${region.inactiveReason}`,
      );
    }

    // Build region-specific origin (SSRF-guarded like the provider-level path:
    // an operator-set template must not aim a credentialed fetch at internal
    // hosts; a ConfigError here would otherwise surface as an opaque 500).
    if (region.hostTemplate) {
      const host = region.hostTemplate
        .replaceAll("{workspaceId}", region.workspaceId ?? "")
        .replaceAll("{region}", region.region ?? "");
      origin = `https://${host}${region.basePath ?? ""}`.replace(/\/+$/, "");
      try {
        assertSafeExternalOrigin(origin);
      } catch (err) {
        throw new ProviderDisabledError(
          id.provider,
          `region ${id.profilePrefix}: ${errorMessage(err)}`,
        );
      }
    } else {
      // Fallback to provider-level baseUrl if region has no hostTemplate
      origin = provider.baseUrl;
    }
    // Region-owned pool when configured; otherwise inherit the provider's.
    pool = region.credentials ?? provider.credentials;
  } else {
    // Single-endpoint provider (existing logic)
    origin = externalProviderOrigin(provider);
    pool = provider.credentials;
  }

  // Usable pool = non-empty, non-placeholder entries (placeholder entries
  // survive validation so the distinct placeholder error below stays reachable).
  const usable = pool.filter((e) => isCredentialSet(e.credential));

  // Configured but inactive (empty/placeholder pool, e.g. "${VAR:-}" before the
  // env var is set) — a distinct, actionable error.
  if (usable.length === 0) {
    throw new ProviderDisabledError(
      id.provider,
      "credential is unset or a placeholder; set the provider API key and reload",
    );
  }

  if (provider.type === "anthropic") {
    // Native Anthropic — passthrough (Path P). Single global endpoint.
    return makeRoute({
      provider: id.provider,
      backend: "anthropic",
      translationPath: "passthrough",
      origin,
      path: `${origin}/v1/messages`,
      countTokensPath: provider.countTokens ? `${origin}/v1/messages/count_tokens` : undefined,
      invocationId: id.nativeModelId,
      isAnthropic: true,
      credentials: usable,
    });
  }
  // type === "openai" — Anthropic <-> OpenAI translation (Path M). The baseUrl
  // already includes any provider-specific prefix (e.g. Gemini's /v1beta/openai).
  return makeRoute({
    provider: id.provider,
    backend: "openai",
    translationPath: "mantle",
    origin,
    path: `${origin}/chat/completions`,
    invocationId: id.nativeModelId,
    isAnthropic: false,
    credentials: usable,
    ...(provider.strictTools ? { strictTools: true } : {}),
  });
}

/** Resolve a `bedrock.converse.*` target (Path C — Converse translation). */
function routeConverse(config: ProxyConfig, catalog: Catalog, id: CanonicalId): RouteTarget {
  const bedrock = config.providers.bedrock;
  if (!bedrock) throw new ProviderDisabledError("bedrock", "no providers.bedrock block configured");
  const awsRegion = awsRegionForPrefix(config, id.profilePrefix);
  const regionKey = regionKeyForPrefix(config, id.profilePrefix);
  const origin = `https://${hostForRegion(bedrock.hosts.converse, awsRegion)}`;

  // The converse backend ALWAYS uses the Converse API (Path C), for Claude and
  // non-Claude alike. Converse serves the full Claude catalog, and the backend
  // is chosen explicitly by the canonical id — no cross-backend fallback
  // (DESIGN §5.3, §5.4). Native Anthropic passthrough is reserved for mantle.
  const model = catalog.get(regionKey, "converse", id.nativeModelId);
  if (!model) {
    throw new ModelNotFoundError(
      `Model "${id.nativeModelId}" not found for converse in region "${awsRegion}"`,
    );
  }
  const invocationId = resolveInvocationId(model, config.profilePreference);
  const encoded = encodeURIComponent(invocationId);
  return makeRoute({
    provider: "bedrock",
    backend: "converse",
    translationPath: "converse",
    awsRegion,
    origin,
    path: `${origin}/model/${encoded}/converse`,
    streamPath: `${origin}/model/${encoded}/converse-stream`,
    invocationId,
    isAnthropic: isAnthropic(id.nativeModelId),
  });
}

/** Resolve a `bedrock.mantle.*` target (Path P for Claude, Path M otherwise). */
function routeMantle(config: ProxyConfig, id: CanonicalId): RouteTarget {
  const bedrock = config.providers.bedrock;
  if (!bedrock) throw new ProviderDisabledError("bedrock", "no providers.bedrock block configured");
  const awsRegion = awsRegionForPrefix(config, id.profilePrefix);
  const origin = `https://${hostForRegion(bedrock.hosts.mantle, awsRegion)}`;

  if (isAnthropic(id.nativeModelId)) {
    // Path P — native Anthropic passthrough on Mantle. Bare native id works.
    return makeRoute({
      provider: "bedrock",
      backend: "mantle",
      translationPath: "passthrough",
      awsRegion,
      origin,
      path: `${origin}/anthropic/v1/messages`,
      countTokensPath: `${origin}/anthropic/v1/messages/count_tokens`,
      invocationId: id.nativeModelId,
      isAnthropic: true,
    });
  }
  // Path M — Anthropic <-> OpenAI on Mantle. Bare native id.
  return makeRoute({
    provider: "bedrock",
    backend: "mantle",
    translationPath: "mantle",
    awsRegion,
    origin,
    path: `${origin}/v1/chat/completions`,
    invocationId: id.nativeModelId,
    isAnthropic: false,
  });
}

/**
 * Reserved provider token for virtual model tiers (docs/VIRTUAL_MODELS.md):
 * `virtual.anthropic.global.<tier>` expands to the tier's candidate list.
 * A provider token like "bedrock", never a model id — nothing hardcoded.
 */
export const VIRTUAL_PROVIDER = "virtual";

/** One tier's routing-time view (for /v1/models, status, registry). */
export interface VirtualTierStatus {
  readonly name: string;
  /** Full candidate list in config order (verbatim). */
  readonly candidates: readonly string[];
  /** Candidates that currently route (availability-filtered, config order). */
  readonly available: readonly string[];
  /** First available candidate's canonical id, or null when none route. */
  readonly resolution: string | null;
  /** Per-candidate skip reason for the unavailable ones (parallel to candidates). */
  readonly reasons: readonly (string | undefined)[];
}

/**
 * Expand an ordered candidate list into RouteTargets, recording (not throwing)
 * why each unavailable candidate was skipped. Used directly by the failover
 * engine: candidate availability is evaluated per request, always primary
 * first (no cross-request stickiness).
 */
export function routeCandidates(
  config: ProxyConfig,
  catalog: Catalog,
  entries: readonly string[],
): { targets: RouteTarget[]; reasons: readonly (string | undefined)[] } {
  const targets: RouteTarget[] = [];
  const reasons: (string | undefined)[] = [];
  for (const entry of entries) {
    try {
      const parsed = parseCanonicalId(entry);
      targets.push(route(config, catalog, parsed));
      reasons.push(undefined);
    } catch (err) {
      // Unavailable candidate: record why, keep walking. Availability here is
      // exactly as strict as routing itself — no extra catalog checks.
      reasons.push(err instanceof Error ? err.message : String(err));
    }
  }
  return { targets, reasons };
}

/**
 * Resolve a `virtual.anthropic.global.<tier>` id to its first AVAILABLE
 * candidate's target (docs/VIRTUAL_MODELS.md resolution step 1). The failover
 * engine uses {@link routeCandidates} for the full ordered list.
 *
 * @throws ModelNotFoundError naming the tier and every candidate's skip reason.
 */
function routeVirtual(config: ProxyConfig, catalog: Catalog, id: CanonicalId): RouteTarget {
  const entries = config.virtualModels?.[id.nativeModelId];
  if (entries === undefined) {
    throw new ModelNotFoundError(
      `Unknown virtual model tier "${id.nativeModelId}" (configured: ${
        Object.keys(config.virtualModels ?? {}).join(", ") || "none"
      })`,
    );
  }
  const { targets, reasons } = routeCandidates(config, catalog, entries);
  const first = targets[0];
  if (first !== undefined) return first;
  const why = entries.map((entry, i) => `${entry}: ${reasons[i] ?? "unavailable"}`).join("; ");
  throw new ModelNotFoundError(
    `Virtual tier "${id.nativeModelId}" has no available candidate (${why})`,
  );
}

/** Routing-time status of every configured virtual tier. */
export function virtualTierStatuses(config: ProxyConfig, catalog: Catalog): VirtualTierStatus[] {
  const out: VirtualTierStatus[] = [];
  for (const [name, entries] of Object.entries(config.virtualModels ?? {})) {
    const { reasons } = routeCandidates(config, catalog, entries);
    const available = entries.filter((_, i) => reasons[i] === undefined);
    out.push({
      name,
      candidates: entries,
      available,
      resolution: available[0] ?? null,
      reasons,
    });
  }
  return out;
}

/**
 * Resolve a canonical id to a concrete outbound target. Thin dispatcher over
 * the per-backend resolvers.
 *
 * @throws UnsupportedProviderError when the provider is not configured.
 * @throws ProviderDisabledError when the provider is configured but inactive
 *   (no usable credential — e.g. Bedrock without a key, or an external
 *   provider whose `${VAR:-}` credential is still unset).
 * @throws ModelNotFoundError when the model is not in the catalog for the
 *   target region/backend, or cannot be invoked there.
 */
export function route(config: ProxyConfig, catalog: Catalog, id: CanonicalId): RouteTarget {
  // Virtual tiers expand to their first available candidate.
  if (id.provider === VIRTUAL_PROVIDER) return routeVirtual(config, catalog, id);
  // External providers are driven by config provider `type`, not the model string.
  if (id.provider !== "bedrock") return routeExternal(config, id);
  // Bedrock guard BEFORE the per-backend resolvers: routeMantle does not
  // consult the catalog, so a disabled Bedrock would otherwise only fail
  // later (at auth resolution) with a confusing error.
  const disabledReason = bedrockDisabledReason(config.providers.bedrock?.credential);
  if (disabledReason !== undefined) throw new ProviderDisabledError("bedrock", disabledReason);
  if (id.backend === "converse") return routeConverse(config, catalog, id);
  return routeMantle(config, id); // backend === "mantle"
}
