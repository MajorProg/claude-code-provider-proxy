import { credentialState } from "../auth/bedrock-mode.ts";
/**
 * Runtime model discovery + catalog + profile resolver (DESIGN §7).
 *
 * The proxy MUST NOT contain any hardcoded model list. All model/region
 * specifics are discovered at startup and refreshed periodically.
 *
 * Discovery sources (all authenticated with the same Bedrock bearer token,
 * verified: control-plane accepts the bearer):
 *   - Converse foundation models: GET {control}/foundation-models
 *   - Converse inference profiles: GET {control}/inference-profiles?type=SYSTEM_DEFINED
 *   - Mantle models:               GET {mantle}/v1/models
 */
import {
  type ProfilePreference,
  type ProxyConfig,
  type RegionKey,
  assertSafeExternalOrigin,
  awsRegionForKey,
  hostForRegion,
} from "../config.ts";
import { ConfigError, ModelNotFoundError } from "../errors.ts";
import { errorMessage, logger } from "../logging/logger.ts";
import { type Backend, isAnthropic } from "./canonical-id.ts";

/** Timeout for a single discovery HTTP request (bounds startup/refresh hangs). */
const DISCOVERY_TIMEOUT_MS = 15_000;

/**
 * PC9: ± jitter applied to each refresh period so multiple proxy instances (and
 * successive refreshes) don't stampede every discovery source in a synchronized
 * burst. A period of `base` becomes a uniform random in `[base·(1-r), base·(1+r)]`.
 */
const REFRESH_JITTER_RATIO = 0.15;

/**
 * PC9: per-source failure cooldown. A source that errors during discovery is
 * skipped for a growing cooldown (base·2^consecutiveFailures, capped) before it
 * is re-attempted, so a flapping/broken source is not re-hit at full cost every
 * refresh cycle. Cleared on the first success.
 */
const SOURCE_COOLDOWN_BASE_MS = 60_000; // 1 min after the first failure
const SOURCE_COOLDOWN_CAP_MS = 30 * 60_000; // capped at 30 min

/** Compute a jittered interval in ms (PC9). Exported for deterministic testing. */
export function jitteredInterval(baseMs: number, rand: () => number = Math.random): number {
  const spread = baseMs * REFRESH_JITTER_RATIO;
  return baseMs - spread + rand() * (2 * spread);
}

/**
 * Tracks consecutive discovery failures per source and derives a cooldown
 * window (PC9). `shouldSkip(source, now)` returns true while a failed source is
 * still cooling down; `recordSuccess`/`recordFailure` update the state.
 */
export class SourceBackoff {
  private readonly failures = new Map<string, { count: number; nextAttemptMs: number }>();

  shouldSkip(source: string, nowMs: number = Date.now()): boolean {
    const s = this.failures.get(source);
    return s !== undefined && nowMs < s.nextAttemptMs;
  }

  recordSuccess(source: string): void {
    this.failures.delete(source);
  }

  recordFailure(source: string, nowMs: number = Date.now()): void {
    const prev = this.failures.get(source);
    const count = (prev?.count ?? 0) + 1;
    const cooldown = Math.min(SOURCE_COOLDOWN_BASE_MS * 2 ** (count - 1), SOURCE_COOLDOWN_CAP_MS);
    this.failures.set(source, { count, nextAttemptMs: nowMs + cooldown });
  }

  /** The cooldown window (ms) a source with `count` consecutive failures gets. */
  static cooldownMs(count: number): number {
    if (count <= 0) return 0;
    return Math.min(SOURCE_COOLDOWN_BASE_MS * 2 ** (count - 1), SOURCE_COOLDOWN_CAP_MS);
  }
}

/**
 * Outcome of one discovery source — either a Bedrock region
 * (`bedrock:<regionKey>`, or `bedrock` when disabled) or an external provider
 * key. Carried on the immutable Catalog snapshot so status endpoints render
 * the same view the discovery loop produced, replaced atomically on refresh.
 */
export interface SourceStatus {
  readonly source: string;
  readonly state: "ok" | "error" | "skipped" | "disabled";
  /** Human-readable detail (error message / skip reason). Absent when ok. */
  readonly detail?: string;
}

/** A model discovered in a specific region + backend. */
export interface DiscoveredModel {
  /** Provider id: "bedrock" or an external provider key (e.g. "deepseek"). */
  readonly provider: string;
  readonly awsRegion: string;
  /**
   * Region/profile family. For Bedrock: "us" | "eu" | "global".
   * For external providers: "global" (single-endpoint) or region code
   * (multi-regional providers like Alibaba: "ap-southeast-1", "eu-central-1").
   */
  readonly regionKey: string;
  readonly backend: Backend;
  readonly nativeModelId: string;
  readonly isAnthropic: boolean;
  /** Converse only: whether bare on-demand invocation is supported. */
  readonly supportsOnDemand: boolean;
  /** Converse only: resolved inference-profile ids that map to this model. */
  readonly profiles: readonly string[];
  readonly streaming: boolean;
}

/** Raw shapes returned by the discovery sources (subset consumed). */
interface FoundationModelSummary {
  modelId?: string;
  inferenceTypesSupported?: string[];
  responseStreamingSupported?: boolean;
  modelLifecycle?: { status?: string };
}
interface InferenceProfileSummary {
  inferenceProfileId?: string;
  status?: string;
  models?: { modelArn?: string }[];
}
interface MantleModel {
  id?: string;
  status?: string;
}

/**
 * Fetches discovery data for a region. Injectable for testing.
 */
export interface DiscoveryClient {
  listFoundationModels(awsRegion: string): Promise<FoundationModelSummary[]>;
  listInferenceProfiles(awsRegion: string): Promise<InferenceProfileSummary[]>;
  listMantleModels(awsRegion: string): Promise<MantleModel[]>;
}

/** Extract the base foundation-model id from an inference-profile model ARN. */
function baseModelIdFromArn(modelArn: string): string | null {
  // arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-5-...
  const idx = modelArn.indexOf("foundation-model/");
  if (idx === -1) return null;
  return modelArn.slice(idx + "foundation-model/".length);
}

/**
 * Live HTTP discovery client using the Bedrock bearer token (DESIGN §7.1, §8.2).
 */
/**
 * Provides a Bedrock bearer token for a given AWS region.
 *
 * - Production (long-term key): returns the same region-agnostic key for all regions.
 * - Development (short-lived key): mints a region-scoped token per region, since
 *   short-lived Bedrock keys are region-bound (verified: a us-east-1 token is
 *   rejected 403 by the eu-west-1 control-plane).
 */
export type RegionTokenProvider = (awsRegion: string) => Promise<string> | string;

/**
 * Live HTTP discovery client using per-region Bedrock bearer tokens
 * (DESIGN §7.1, §8.2).
 */
export function createHttpDiscoveryClient(
  config: ProxyConfig,
  tokenProvider: RegionTokenProvider,
): DiscoveryClient {
  const hosts = config.providers.bedrock?.hosts;
  if (!hosts) {
    // Only reachable when Bedrock is enabled (buildRuntime checks first);
    // kept as a hard guard so a future caller can't dereference undefined.
    throw new ConfigError("Bedrock discovery requires a configured providers.bedrock block");
  }

  async function getJson<T>(url: string, awsRegion: string): Promise<T> {
    const token = await tokenProvider(awsRegion);
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Discovery GET ${url} failed: ${res.status} ${body.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }

  return {
    async listFoundationModels(awsRegion) {
      const host = hostForRegion(hosts.control, awsRegion);
      const data = await getJson<{ modelSummaries?: FoundationModelSummary[] }>(
        `https://${host}/foundation-models`,
        awsRegion,
      );
      return data.modelSummaries ?? [];
    },
    async listInferenceProfiles(awsRegion) {
      const host = hostForRegion(hosts.control, awsRegion);
      const data = await getJson<{ inferenceProfileSummaries?: InferenceProfileSummary[] }>(
        `https://${host}/inference-profiles?type=SYSTEM_DEFINED`,
        awsRegion,
      );
      return data.inferenceProfileSummaries ?? [];
    },
    async listMantleModels(awsRegion) {
      const host = hostForRegion(hosts.mantle, awsRegion);
      const data = await getJson<{ data?: MantleModel[] }>(`https://${host}/v1/models`, awsRegion);
      return data.data ?? [];
    },
  };
}

/** Build the DiscoveredModel list for a single region from raw discovery data. */
export function buildRegionCatalog(
  regionKey: RegionKey,
  awsRegion: string,
  foundationModels: FoundationModelSummary[],
  inferenceProfiles: InferenceProfileSummary[],
  mantleModels: MantleModel[],
): DiscoveredModel[] {
  // Map baseModelId -> set of profile ids that route to it.
  const profilesByBase = new Map<string, string[]>();
  for (const p of inferenceProfiles) {
    if (!p.inferenceProfileId || p.status !== "ACTIVE") continue;
    for (const m of p.models ?? []) {
      if (!m.modelArn) continue;
      const base = baseModelIdFromArn(m.modelArn);
      if (!base) continue;
      const list = profilesByBase.get(base) ?? [];
      if (!list.includes(p.inferenceProfileId)) list.push(p.inferenceProfileId);
      profilesByBase.set(base, list);
    }
  }

  const out: DiscoveredModel[] = [];

  // Converse models (foundation models).
  for (const fm of foundationModels) {
    if (!fm.modelId) continue;
    if (fm.modelLifecycle?.status && fm.modelLifecycle.status !== "ACTIVE") continue;
    const inf = fm.inferenceTypesSupported ?? [];
    out.push({
      provider: "bedrock",
      awsRegion,
      regionKey,
      backend: "converse",
      nativeModelId: fm.modelId,
      isAnthropic: isAnthropic(fm.modelId),
      supportsOnDemand: inf.includes("ON_DEMAND"),
      profiles: profilesByBase.get(fm.modelId) ?? [],
      streaming: fm.responseStreamingSupported ?? false,
    });
  }

  // Mantle models.
  for (const mm of mantleModels) {
    if (!mm.id) continue;
    if (mm.status && mm.status !== "available") continue;
    out.push({
      provider: "bedrock",
      awsRegion,
      regionKey,
      backend: "mantle",
      nativeModelId: mm.id,
      isAnthropic: isAnthropic(mm.id),
      supportsOnDemand: true, // Mantle invokes by id directly
      profiles: [],
      streaming: true,
    });
  }

  return out;
}

/**
 * Discover external (non-Bedrock) provider models at runtime by fetching each
 * provider's configured `modelsUrl` (an OpenAI-style `/models` endpoint). NO
 * model ids are hardcoded anywhere — they come from the live endpoint, exactly
 * like Bedrock discovery. Each model becomes a single `global`-prefix entry
 * addressable as `<provider>.<backend>.global.<nativeModelId>`.
 *
 * A provider whose credential is unset/placeholder is skipped WITHOUT a
 * network call (`skipped` status) — that is the "configured but inactive"
 * state of `"${VAR:-}"` defaults. A provider whose discovery fails gets an
 * `error` status; neither ever fails the caller (best-effort).
 */
export async function discoverExternalCatalog(
  config: ProxyConfig,
  backoff?: SourceBackoff,
): Promise<{
  models: DiscoveredModel[];
  statuses: SourceStatus[];
}> {
  const out: DiscoveredModel[] = [];
  const statuses: SourceStatus[] = [];
  const entries = Object.entries(config.providers.external);
  await Promise.all(
    entries.map(async ([providerKey, provider]) => {
      const backend: Backend = provider.type === "anthropic" ? "anthropic" : "openai";

      // Multi-region provider: discover from each configured region
      if (provider.regions) {
        await Promise.all(
          Object.entries(provider.regions).map(async ([regionCode, region]) => {
            const sourceId = `${providerKey}:${regionCode}`;
            const cred = region.credential ?? provider.credential;

            const credState = credentialState(cred);
            if (credState === "empty" || credState === "placeholder") {
              logger.warn("region credential unset, skipping discovery", {
                provider: providerKey,
                region: regionCode,
              });
              statuses.push({
                source: sourceId,
                state: "skipped",
                detail: "credential unset or placeholder for region",
              });
              return;
            }

            if (backoff?.shouldSkip(sourceId)) {
              statuses.push({
                source: sourceId,
                state: "skipped",
                detail: "cooling down after discovery failure (PC9 backoff)",
              });
              return;
            }

            try {
              assertSafeExternalOrigin(region.modelsUrl);
              const res = await fetch(region.modelsUrl, {
                headers: { authorization: `Bearer ${cred}` },
                signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
              });

              if (!res.ok) {
                // Workspace hosts may 404 on /api/v1/models (Singapore does)
                // Log but don\'t fail - other regions may work
                logger.warn("region discovery returned non-ok", {
                  provider: providerKey,
                  region: regionCode,
                  status: res.status,
                });
                backoff?.recordFailure(sourceId);
                statuses.push({
                  source: sourceId,
                  state: "error",
                  detail: `discovery returned HTTP ${res.status}`,
                });
                return;
              }

              const data = (await res.json()) as { data?: { id?: string }[] };
              for (const m of data.data ?? []) {
                if (!m.id) continue;
                const nativeModelId = m.id.startsWith("models/")
                  ? m.id.slice("models/".length)
                  : m.id;

                out.push({
                  provider: providerKey,
                  awsRegion: "",
                  regionKey: regionCode, // ← Region code instead of "global"
                  backend,
                  nativeModelId,
                  isAnthropic: provider.type === "anthropic",
                  supportsOnDemand: true,
                  profiles: [],
                  streaming: true,
                });
              }

              backoff?.recordSuccess(sourceId);
              statuses.push({ source: sourceId, state: "ok" });
            } catch (err) {
              logger.error("region discovery failed", {
                provider: providerKey,
                region: regionCode,
                message: errorMessage(err),
              });
              backoff?.recordFailure(sourceId);
              statuses.push({
                source: sourceId,
                state: "error",
                detail: errorMessage(err),
              });
            }
          }),
        );
        return; // Exit early - multi-region handling complete
      }

      // Single-endpoint provider (existing logic)
      const credState = credentialState(provider.credential);
      if (credState === "empty" || credState === "placeholder") {
        logger.warn("external provider credential unset, skipping discovery", {
          provider: providerKey,
        });
        statuses.push({
          source: providerKey,
          state: "skipped",
          detail: "credential unset or placeholder — set the provider API key to activate",
        });
        return;
      }
      // PC9: a source that keeps failing is put on a growing cooldown so we
      // don't re-hit a broken/flapping endpoint at full cost every refresh.
      if (backoff?.shouldSkip(providerKey)) {
        statuses.push({
          source: providerKey,
          state: "skipped",
          detail: "cooling down after a recent discovery failure (PC9 backoff)",
        });
        return;
      }
      // The modelsUrl is an OpenAI-style /models endpoint, which by convention
      // authenticates with a bearer token — even for providers whose message
      // path uses x-api-key (e.g. Alibaba's compatible-mode /models rejects
      // x-api-key with 401 but accepts bearer; DeepSeek accepts both). Bearer is
      // the safe universal choice for discovery, independent of message auth.
      const headers: Record<string, string> = {
        authorization: `Bearer ${provider.credential}`,
      };
      try {
        // SEC-9: block a credentialed discovery fetch to an internal/metadata
        // host (the modelsUrl is operator-configured and may differ from the
        // message-path origin, so it is guarded independently).
        assertSafeExternalOrigin(provider.modelsUrl);
        const res = await fetch(provider.modelsUrl, {
          headers,
          signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
        });
        if (!res.ok) {
          logger.error("provider discovery returned non-ok, skipping", {
            provider: providerKey,
            status: res.status,
          });
          backoff?.recordFailure(providerKey);
          statuses.push({
            source: providerKey,
            state: "error",
            detail: `discovery returned HTTP ${res.status}`,
          });
          return;
        }
        const data = (await res.json()) as { data?: { id?: string }[] };
        for (const m of data.data ?? []) {
          if (!m.id) continue;
          // Some OpenAI-compatible /models endpoints namespace ids (e.g. Gemini
          // returns "models/gemini-3.6-flash" but chat/completions wants the
          // bare "gemini-3.6-flash"). Normalize to the bare id.
          const nativeModelId = m.id.startsWith("models/") ? m.id.slice("models/".length) : m.id;
          out.push({
            provider: providerKey,
            awsRegion: "",
            regionKey: "global",
            backend,
            nativeModelId,
            isAnthropic: provider.type === "anthropic",
            supportsOnDemand: true,
            profiles: [],
            streaming: true,
          });
        }
        backoff?.recordSuccess(providerKey);
        statuses.push({ source: providerKey, state: "ok" });
      } catch (err) {
        // A provider dropping out of discovery is a capability-loss event
        // (its models silently vanish from the catalog) — log at error.
        logger.error("provider discovery failed, skipping", {
          provider: providerKey,
          message: errorMessage(err),
        });
        backoff?.recordFailure(providerKey);
        statuses.push({
          source: providerKey,
          state: "error",
          detail: errorMessage(err),
        });
      }
    }),
  );
  return { models: out, statuses };
}

/** Key used to look up a discovered model. */
function catalogKey(regionKey: string, backend: Backend, nativeModelId: string): string {
  return `${regionKey}|${backend}|${nativeModelId}`;
}

/**
 * The in-memory catalog across all configured regions. Immutable snapshot;
 * a refresh produces a new Catalog instance.
 */
export class Catalog {
  private readonly byKey: Map<string, DiscoveredModel>;
  readonly models: readonly DiscoveredModel[];
  /** Per-source discovery outcomes (Bedrock regions + external providers). */
  readonly sources: readonly SourceStatus[];

  constructor(models: DiscoveredModel[], sources: readonly SourceStatus[] = []) {
    this.models = models;
    this.sources = sources;
    this.byKey = new Map();
    for (const m of models) {
      this.byKey.set(catalogKey(m.regionKey, m.backend, m.nativeModelId), m);
    }
  }

  get(regionKey: string, backend: Backend, nativeModelId: string): DiscoveredModel | undefined {
    return this.byKey.get(catalogKey(regionKey, backend, nativeModelId));
  }
}

/**
 * Resolve the Converse invocation id for a discovered model (DESIGN §7.3).
 *
 *   1. profilePreference === "global" and a global.* profile exists -> use it
 *   2. a <regionFamily>.* profile exists                            -> use it
 *   3. supportsOnDemand                                             -> bare id
 *   4. otherwise                                                    -> throw
 *
 * "auto" behaves as: prefer global, else region family, else bare.
 * "regional" prefers the region-family profile before global.
 */
export function resolveInvocationId(model: DiscoveredModel, preference: ProfilePreference): string {
  const globalProfile = model.profiles.find((p) => p.startsWith("global."));
  const familyProfile = model.profiles.find((p) => p.startsWith(`${model.regionKey}.`));

  const ordered: (string | undefined)[] =
    preference === "regional" ? [familyProfile, globalProfile] : [globalProfile, familyProfile];

  for (const candidate of ordered) {
    if (candidate) return candidate;
  }
  if (model.supportsOnDemand) return model.nativeModelId;

  throw new ModelNotFoundError(
    `Model "${model.nativeModelId}" is not usable in region "${model.awsRegion}": no inference profile and no on-demand support`,
  );
}

/**
 * Discover all configured sources and build a Catalog.
 *
 * NEVER throws for discovery failures — Bedrock is optional and any region
 * (including the primary) failing degrades to that region's models being
 * absent, with an `error` SourceStatus surfaced to /status.json and
 * /api/config/status. A crash here would put the container in a restart loop
 * and take the (still-working) external providers and the config UI down
 * with it. `client === null` means Bedrock is disabled: no region discovery
 * happens at all (zero network calls).
 */
export async function discoverCatalog(
  config: ProxyConfig,
  client: DiscoveryClient | null,
  backoff?: SourceBackoff,
): Promise<Catalog> {
  const sources: SourceStatus[] = [];
  const all: DiscoveredModel[] = [];

  if (client === null) {
    sources.push({ source: "bedrock", state: "disabled" });
  } else {
    // Discover all regions concurrently: total latency becomes max(region)
    // rather than sum(region). Failures (any region, incl. primary) are
    // logged and skipped (best-effort).
    const perRegion = await Promise.all(
      config.regions.map(async (region): Promise<DiscoveredModel[]> => {
        const awsRegion = awsRegionForKey(config, region.key);
        try {
          const [fm, ip, mm] = await Promise.all([
            client.listFoundationModels(awsRegion),
            client.listInferenceProfiles(awsRegion),
            client.listMantleModels(awsRegion),
          ]);
          return buildRegionCatalog(region.key, awsRegion, fm, ip, mm);
        } catch (err) {
          // A region dropping out means its models vanish from the catalog —
          // capability loss, log at error (but don't fail startup).
          logger.error("region discovery failed, skipping", {
            region: awsRegion,
            message: errorMessage(err),
          });
          sources.push({
            source: `bedrock:${region.key}`,
            state: "error",
            detail: errorMessage(err),
          });
          return [];
        }
      }),
    );
    all.push(...perRegion.flat());
    for (const region of config.regions) {
      if (!sources.some((s) => s.source === `bedrock:${region.key}`)) {
        sources.push({ source: `bedrock:${region.key}`, state: "ok" });
      }
    }
  }

  // Discover external (non-Bedrock) provider models at runtime from each
  // provider's configured discovery endpoint (DESIGN §7 — no hardcoded ids).
  const external = await discoverExternalCatalog(config, backoff);
  all.push(...external.models);
  sources.push(...external.statuses);
  return new Catalog(all, sources);
}

/**
 * Holds the current catalog and refreshes it periodically. On refresh failure
 * the previous catalog is retained (DESIGN §7.4).
 */
export class CatalogManager {
  private catalog: Catalog;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** In-flight refresh, if any (single-flight guard). */
  private refreshing: Promise<void> | undefined;
  /** Set by stop(); a late-resolving refresh must not write into a dead manager. */
  private stopped = false;
  /** PC9: per-source discovery cooldown state, persistent across refreshes. */
  private readonly backoff = new SourceBackoff();

  private constructor(
    initial: Catalog,
    private readonly config: ProxyConfig,
    private readonly client: DiscoveryClient | null,
  ) {
    this.catalog = initial;
  }

  /**
   * Perform initial discovery and return a started manager. Discovery
   * failures never throw (see discoverCatalog); `client === null` means
   * Bedrock is disabled and only external providers are discovered.
   */
  static async start(config: ProxyConfig, client: DiscoveryClient | null): Promise<CatalogManager> {
    const initial = await discoverCatalog(config, client);
    const mgr = new CatalogManager(initial, config, client);
    mgr.scheduleRefresh();
    return mgr;
  }

  current(): Catalog {
    return this.catalog;
  }

  private scheduleRefresh(): void {
    // PC9: jittered self-rescheduling timer (not a fixed setInterval) so
    // multiple proxy instances — and successive refreshes — do not fire in a
    // synchronized burst against every discovery source at once. Each period is
    // the configured interval ± REFRESH_JITTER_RATIO.
    const baseMs = this.config.refreshIntervalMinutes * 60_000;
    const next = jitteredInterval(baseMs);
    this.timer = setTimeout(() => {
      void this.refresh().finally(() => {
        if (!this.stopped) this.scheduleRefresh();
      });
    }, next);
    // Do not keep the process alive solely for refresh.
    if (typeof this.timer === "object" && this.timer && "unref" in this.timer) {
      (this.timer as { unref: () => void }).unref();
    }
  }

  /**
   * Rediscover the catalog. Single-flight: overlapping calls (a slow refresh
   * outlasting the interval, or a manual trigger racing a tick) share the one
   * in-flight promise, so a slower discovery can never resolve last and
   * overwrite a newer catalog with stale data. A refresh that resolves after
   * stop() is discarded (the stopped flag guards the assignment).
   */
  async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        const next = await discoverCatalog(this.config, this.client, this.backoff);
        if (!this.stopped) this.catalog = next;
      } catch (err) {
        // Refresh failure is a staleness/capability risk (catalog stops
        // tracking new models) — log at error, but keep serving the last good
        // catalog rather than going dark.
        logger.error("catalog refresh failed, keeping previous catalog", {
          message: errorMessage(err),
        });
      }
    })().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
