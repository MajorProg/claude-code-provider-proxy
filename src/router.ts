/**
 * Router: canonical model id -> outbound target (DESIGN §5).
 *
 * Deterministically maps a parsed canonical id to the upstream host, path,
 * resolved invocation id, and translation path, using the live catalog for
 * model resolution and the config for host/region derivation.
 */
import { bedrockDisabledReason, isCredentialSet } from "./auth/bedrock-mode.ts";
import {
  type ProxyConfig,
  type RegionKey,
  awsRegionForPrefix,
  externalProviderOrigin,
  hostForRegion,
} from "./config.ts";
import { ModelNotFoundError, ProviderDisabledError, UnsupportedProviderError } from "./errors.ts";
import { type CanonicalId, isAnthropic } from "./model/canonical-id.ts";
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
  fields: Omit<RouteTarget, "awsRegion" | "streamPath" | "countTokensPath"> &
    Partial<Pick<RouteTarget, "awsRegion" | "streamPath" | "countTokensPath">>,
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
  // Configured but inactive (empty/placeholder credential, e.g. "${VAR:-}"
  // before the env var is set) — a distinct, actionable error.
  if (!isCredentialSet(provider.credential)) {
    throw new ProviderDisabledError(
      id.provider,
      "credential is unset or a placeholder; set the provider API key and reload",
    );
  }
  const origin = externalProviderOrigin(provider);

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
