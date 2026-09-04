/**
 * Configuration loading + validation (DESIGN §10).
 *
 * - Loads a JSONC config file (comments allowed).
 * - Interpolates ${ENV_VAR} references from the environment.
 * - Validates the shape and fails fast on any invalid value.
 *
 * The config is the ONLY place region/provider specifics live. Source code
 * contains lookups, never hardcoded catalogs (DESIGN §7).
 */
import { ConfigError } from "./errors.ts";

export type RegionKey = "us" | "eu";
export type ProfilePreference = "global" | "regional" | "auto";

export interface RegionConfig {
  readonly key: RegionKey;
  readonly awsRegion: string;
}

export interface BedrockProviderConfig {
  readonly type: "bedrock";
  /**
   * Bedrock API key ("bedrock-api-key-…" long-term) or the "dev" sentinel
   * (mint short-lived tokens from AWS_* env creds). May be EMPTY: an empty or
   * placeholder credential means Bedrock is disabled — the proxy boots and
   * serves external providers only (see src/auth/bedrock-mode.ts).
   */
  readonly credential: string;
  readonly hosts: {
    readonly converse: string;
    readonly mantle: string;
    /** Control-plane host for model/profile discovery (DESIGN §7.1). */
    readonly control: string;
  };
}

/**
 * Standard Bedrock endpoint host templates. Shared by config validation (the
 * optional `hosts.control` default) and the Config UI's "Enable Bedrock"
 * action, so the endpoints are defined exactly once.
 */
export const DEFAULT_BEDROCK_HOSTS: Readonly<{
  converse: string;
  mantle: string;
  control: string;
}> = {
  converse: "bedrock-runtime.{region}.amazonaws.com",
  mantle: "bedrock-mantle.{region}.api.aws",
  control: "bedrock.{region}.amazonaws.com",
};

/** Header auth style for an external (non-Bedrock) provider. */
export type ProviderAuthStyle = "x-api-key" | "bearer";

/**
 * A non-Bedrock, provider-hosted endpoint reached over one of the existing
 * translation paths:
 *   - type "anthropic" -> native Anthropic Messages (passthrough path)
 *   - type "openai"    -> OpenAI Chat Completions (mantle translation path)
 *
 * Single-endpoint providers set a flat `baseUrl`. The credential is the static
 * provider API key (${ENV}-interpolated); no region minting. It may be EMPTY
 * (e.g. `"${ZAI_API_KEY:-}"` before the env var is set) — an empty or
 * placeholder credential means the provider is skipped at discovery time with
 * a warning until the key is set.
 */
export interface ExternalProviderConfig {
  readonly type: "anthropic" | "openai";
  readonly credential: string;
  readonly auth: ProviderAuthStyle;
  /**
   * Base URL WITHOUT a trailing `/v1/messages` or `/chat/completions`.
   * Used for single-endpoint providers. For providers that need a per-workspace
   * / per-region host, set `hostTemplate` + `workspaceId` + `region` instead.
   */
  readonly baseUrl: string;
  /**
   * Optional host template with `{workspaceId}` and `{region}` placeholders
   * (e.g. Alibaba's `{workspaceId}.{region}.maas.aliyuncs.com`). When present,
   * the effective origin is `https://<substituted-host><basePath>` and takes
   * precedence over `baseUrl`.
   */
  readonly hostTemplate?: string;
  /** Path appended after the templated host (e.g. `/apps/anthropic`). */
  readonly basePath?: string;
  /** Value substituted for `{workspaceId}` in `hostTemplate`. */
  readonly workspaceId?: string;
  /** Value substituted for `{region}` in `hostTemplate` (e.g. `eu-central-1`). */
  readonly region?: string;
  /**
   * True if the upstream natively supports Anthropic count_tokens
   * (`{origin}/v1/messages/count_tokens`). Only meaningful for type "anthropic".
   */
  readonly countTokens: boolean;
  /**
   * Opt-in OpenAI strict function-calling (TC3). When true, tool `input_schema`
   * is tightened to the strict dialect (`additionalProperties:false` + full
   * `required` at each object; unsupported keywords stripped) before being sent
   * as `function.parameters`. Only meaningful for type "openai". Defaults false
   * — Bedrock Mantle and lenient providers keep the schema verbatim (live-
   * verified lenient), so tightening is applied ONLY where the target demands it.
   */
  readonly strictTools?: boolean;
  /**
   * Discovery endpoint (an OpenAI-style `/models` URL). Model IDs are fetched
   * from here at runtime — NO model ids are ever hardcoded in source or config
   * (DESIGN §7). This is a discovery endpoint, exactly like Bedrock's control
   * host. Discovery authenticates with a bearer token by convention.
   */
  readonly modelsUrl: string;
}

/**
 * Compute the effective origin (scheme + host + basePath, no trailing slash)
 * for an external provider: a substituted host template when present, else the
 * flat baseUrl.
 */
export function externalProviderOrigin(p: ExternalProviderConfig): string {
  const origin = externalProviderOriginRaw(p);
  assertSafeExternalOrigin(origin);
  return origin;
}

function externalProviderOriginRaw(p: ExternalProviderConfig): string {
  if (p.hostTemplate) {
    const host = p.hostTemplate
      .replaceAll("{workspaceId}", p.workspaceId ?? "")
      .replaceAll("{region}", p.region ?? "");
    return `https://${host}${p.basePath ?? ""}`.replace(/\/+$/, "");
  }
  return p.baseUrl;
}

/**
 * SSRF guard (SEC-9): reject an external-provider origin whose host resolves to
 * a private, link-local, loopback, or cloud-metadata address. Both runtime
 * discovery and the message-path handlers fetch this origin **with a provider
 * credential attached**, so an operator-set `baseUrl`/`hostTemplate` pointing at
 * `https://169.254.169.254` (IMDS) or an RFC-1918 host would otherwise be a
 * credentialed SSRF on the hot path. `isSecureExternalUrl` only enforces the
 * scheme; this enforces the host.
 *
 * Loopback over plain http is still allowed by `isSecureExternalUrl` for local
 * dev against a mock; that narrow case is permitted here too (explicit
 * localhost), but a *credentialed https* origin pointing at an internal IP is
 * rejected.
 */
export function assertSafeExternalOrigin(origin: string): void {
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    throw new ConfigError(`External provider origin is not a valid URL: "${origin}"`);
  }
  if (isBlockedHost(host)) {
    throw new ConfigError(
      `External provider origin "${origin}" resolves to a blocked internal/metadata host ("${host}")`,
    );
  }
}

/**
 * True when a hostname is a private/link-local/loopback/metadata target that a
 * credentialed proxy must not fetch. Matches literal IPv4/IPv6 forms (the SSRF
 * vectors that don't require DNS); DNS-based rebinding is out of scope for a
 * config-time check. An explicit "localhost" literal is permitted for local dev.
 */
function isBlockedHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (h === "localhost") return false; // explicit local dev, allowed

  // IPv6 loopback / link-local / unique-local.
  if (h === "::1") return true;
  if (h.startsWith("fe80:") || h.startsWith("fe80::")) return true; // link-local
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true; // fc00::/7 unique-local
  // IPv4-mapped IPv6. The URL parser normalizes ::ffff:169.254.169.254 to the
  // hex form ::ffff:a9fe:a9fe, so handle BOTH the dotted and hex tails.
  const mappedDotted = h.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  const mappedHex = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  let v4 = h;
  if (mappedDotted) {
    v4 = mappedDotted[1] as string;
  } else if (mappedHex) {
    const hi = Number.parseInt(mappedHex[1] as string, 16);
    const lo = Number.parseInt(mappedHex[2] as string, 16);
    v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }

  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v4);
  if (!m) return false; // not an IP literal -> allowed (public DNS name)
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 127) return true; // loopback 127.0.0.0/8
  if (a === 10) return true; // RFC-1918 10.0.0.0/8
  if (a === 169 && b === 254) return true; // link-local / IMDS 169.254.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC-1918 172.16.0.0/12
  if (a === 192 && b === 168) return true; // RFC-1918 192.168.0.0/16
  if (a === 0) return true; // 0.0.0.0/8
  return false;
}

export interface LoggingConfig {
  readonly enabled: boolean;
  readonly dir: string;
  readonly systemDir: string;
  readonly sessionDir: string;
  /**
   * Wall-clock backstop (ms) on the detached streaming log-capture branch (PC8).
   * The log branch is a follower — normally cancelled when the client branch
   * ends — so this only caps a hung upstream whose client branch never ends.
   * Defaults to {@link DEFAULT_LOG_CAPTURE_TIMEOUT_MS} when absent.
   */
  readonly captureTimeoutMs: number;
}

/** Default backstop for the streaming log-capture branch (PC8). */
export const DEFAULT_LOG_CAPTURE_TIMEOUT_MS = 2 * 60 * 1000;

export interface ChatPageConfig {
  readonly enabled: boolean;
}

export interface ProxyConfig {
  readonly server: { readonly host: string; readonly port: number };
  readonly inboundAuth: { readonly keys: readonly string[] };
  readonly primaryRegion: RegionKey;
  readonly profilePreference: ProfilePreference;
  readonly refreshIntervalMinutes: number;
  readonly claudeFallbackToMantle: boolean;
  readonly regions: readonly RegionConfig[];
  readonly providers: {
    /**
     * Optional: an absent block, or one with an empty/placeholder credential,
     * disables Bedrock — the proxy runs on external providers only.
     */
    readonly bedrock?: BedrockProviderConfig;
    /** Additional non-Bedrock providers, keyed by provider id (e.g. "deepseek"). */
    readonly external: Readonly<Record<string, ExternalProviderConfig>>;
  };
  readonly logging: LoggingConfig;
  readonly chatPage: ChatPageConfig;
  /** Inbound request resource caps (SEC-4). Always present (defaults applied). */
  readonly limits: RequestLimits;
}

/**
 * Configurable caps on inbound request size dimensions (SEC-4). These bound the
 * O(n) work every downstream pass (normalize/translate/serialize) does, so a
 * single crafted request can't exhaust CPU/memory. Defaults are generous —
 * far above any real Claude Code session — so legitimate traffic is unaffected.
 */
export interface RequestLimits {
  readonly maxMessages: number;
  readonly maxContentBlocksPerMessage: number;
  readonly maxTools: number;
}

export const DEFAULT_REQUEST_LIMITS: RequestLimits = {
  maxMessages: 100_000,
  maxContentBlocksPerMessage: 10_000,
  maxTools: 1_000,
};

const VALID_REGION_KEYS: readonly RegionKey[] = ["us", "eu"];
const VALID_PROFILE_PREFERENCES: readonly ProfilePreference[] = ["global", "regional", "auto"];

/** Strip `//` line comments and `/* *​/` block comments from JSONC text. */
function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let stringQuote = "";
  let inLine = false;
  let inBlock = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    const next = i + 1 < text.length ? (text[i + 1] as string) : "";

    if (inLine) {
      if (ch === "\n") {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      if (ch === "*" && next === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === "\\") {
        // Preserve escaped char verbatim.
        if (next) {
          out += next;
          i++;
        }
        continue;
      }
      if (ch === stringQuote) {
        inString = false;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      stringQuote = ch;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLine = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlock = true;
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Matches ${VAR} and ${VAR:-default} references (bash-like). The default may be
 * empty (`${VAR:-}`); it cannot itself contain `}` (the regex stops at the
 * first one).
 */
const ENV_REF = /\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g;

/**
 * Replace ${ENV_VAR} / ${ENV_VAR:-default} tokens with values from `env`.
 *
 * - Bare ${VAR} fails fast when unset OR empty (DESIGN §10).
 * - ${VAR:-default} substitutes the literal default instead — the default may
 *   be empty, which expresses "configured but inactive until the env var is
 *   set" (empty provider credentials are skipped at discovery time).
 *
 * Env values are runtime data, so they are escaped for the surrounding JSON
 * string; default text is file-source and inserted verbatim.
 */
function interpolateEnv(text: string, env: Record<string, string | undefined>): string {
  return text.replace(ENV_REF, (_match, name: string, fallback: string | undefined) => {
    const value = env[name];
    if (value !== undefined && value !== "") {
      // Escape characters that would break the surrounding JSON string.
      return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    }
    if (fallback !== undefined) return fallback;
    throw new ConfigError(`Config references unset environment variable: \${${name}}`);
  });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ConfigError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Assert `value` is a non-empty string and return it narrowed to `string`.
 * Collapses the repeated `assert(typeof x === "string" && x.length > 0, ...)`
 * + later cast pattern into one call that both checks and narrows.
 */
function assertNonEmptyString(value: unknown, path: string): string {
  assert(typeof value === "string" && value.length > 0, `${path} must be a non-empty string`);
  return value;
}

/**
 * Assert `value` is a string (possibly empty) and return it narrowed. Used for
 * credentials that may legitimately be empty — "provider disabled until the
 * key is set" — where emptiness is a runtime skip decision, not a config error.
 */
function assertString(value: unknown, path: string): string {
  assert(typeof value === "string", `${path} must be a string`);
  return value;
}

/** Return `value` when it is a non-empty string, else `fallback`. */
function stringOrDefault(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

/**
 * A credentialed external URL must be https:// so the provider API key is not
 * sent over plaintext. http:// is allowed only for an explicit localhost host
 * (local development against a mock/proxy).
 */
function isSecureExternalUrl(url: string): boolean {
  if (/^https:\/\//i.test(url)) return true;
  return /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])([:/]|$)/i.test(url);
}

// --- Per-section validators (each returns its typed slice of ProxyConfig) ---

function validateServer(raw: unknown): { host: string; port: number } {
  assert(isRecord(raw), "config.server must be an object");
  const host = assertNonEmptyString(raw.host, "config.server.host");
  // `0.0.0.0` binds every interface (incl. VPN/public). It's only appropriate
  // inside the container (compose publishes it on the LAN IP only). Warn if it
  // appears in the config's own host field.
  if (host === "0.0.0.0") {
    console.warn(
      "config.server.host is 0.0.0.0 (all interfaces). Prefer 127.0.0.1 or the LAN ${BIND_IP}; reserve 0.0.0.0 for the container, published only on BIND_IP by compose.",
    );
  }
  const { port } = raw;
  assert(
    typeof port === "number" && Number.isInteger(port) && port > 0 && port < 65536,
    "config.server.port must be an integer in (0, 65536)",
  );
  return { host, port };
}

function validateInboundAuth(raw: unknown): { keys: string[] } {
  assert(isRecord(raw), "config.inboundAuth must be an object");
  const keys = raw.keys;
  assert(
    Array.isArray(keys) && keys.length > 0,
    "config.inboundAuth.keys must be a non-empty array",
  );
  for (const k of keys) {
    assertNonEmptyString(k, "config.inboundAuth.keys entry");
  }
  return { keys: [...(keys as string[])] };
}

function validateRegions(raw: unknown, primaryRegion: RegionKey): RegionConfig[] {
  assert(Array.isArray(raw) && raw.length > 0, "config.regions must be a non-empty array");
  const regions: RegionConfig[] = [];
  const seenKeys = new Set<string>();
  for (const r of raw) {
    assert(isRecord(r), "config.regions entries must be objects");
    assert(
      VALID_REGION_KEYS.includes(r.key as RegionKey),
      `config.regions[].key must be one of ${VALID_REGION_KEYS.join(", ")}`,
    );
    const awsRegion = assertNonEmptyString(r.awsRegion, "config.regions[].awsRegion");
    assert(!seenKeys.has(r.key as string), `config.regions has duplicate key: ${r.key}`);
    seenKeys.add(r.key as string);
    regions.push({ key: r.key as RegionKey, awsRegion });
  }
  assert(
    seenKeys.has(primaryRegion),
    `config.primaryRegion "${primaryRegion}" has no matching entry in config.regions`,
  );
  return regions;
}

function validateBedrockProvider(raw: unknown): BedrockProviderConfig {
  assert(isRecord(raw), "config.providers.bedrock must be an object");
  // Credential may be empty (=> Bedrock disabled; see BedrockProviderConfig).
  const credential = assertString(raw.credential, "config.providers.bedrock.credential");
  assert(isRecord(raw.hosts), "config.providers.bedrock.hosts must be an object");
  const converse = raw.hosts.converse;
  const mantle = raw.hosts.mantle;
  assert(
    typeof converse === "string" && converse.includes("{region}"),
    "config.providers.bedrock.hosts.converse must be a string containing {region}",
  );
  assert(
    typeof mantle === "string" && mantle.includes("{region}"),
    "config.providers.bedrock.hosts.mantle must be a string containing {region}",
  );
  // Control-plane host is optional; default to the standard Bedrock endpoint.
  const control = raw.hosts.control ?? DEFAULT_BEDROCK_HOSTS.control;
  assert(
    typeof control === "string" && control.includes("{region}"),
    "config.providers.bedrock.hosts.control must be a string containing {region}",
  );
  return { type: "bedrock", credential, hosts: { converse, mantle, control } };
}

const VALID_EXTERNAL_TYPES = ["anthropic", "openai"] as const;
const VALID_AUTH_STYLES: readonly ProviderAuthStyle[] = ["x-api-key", "bearer"];

function validateExternalProvider(key: string, raw: unknown): ExternalProviderConfig {
  const where = `config.providers.${key}`;
  assert(isRecord(raw), `${where} must be an object`);
  const ptype = raw.type;
  assert(
    VALID_EXTERNAL_TYPES.includes(ptype as (typeof VALID_EXTERNAL_TYPES)[number]),
    `${where}.type must be one of ${VALID_EXTERNAL_TYPES.join(", ")}`,
  );
  const credential = assertString(raw.credential, `${where}.credential`);
  const auth = raw.auth;
  assert(
    VALID_AUTH_STYLES.includes(auth as ProviderAuthStyle),
    `${where}.auth must be one of ${VALID_AUTH_STYLES.join(", ")}`,
  );
  const hasHostTemplate = typeof raw.hostTemplate === "string";
  if (hasHostTemplate) {
    const hostTemplate = raw.hostTemplate as string;
    assertNonEmptyString(
      raw.workspaceId,
      `${where}.workspaceId (required when hostTemplate is set)`,
    );
    // Every {placeholder} in the template must be a known key AND have a
    // non-empty value, so the origin never silently substitutes to "" at load.
    const known: Record<string, unknown> = {
      workspaceId: raw.workspaceId,
      region: raw.region,
    };
    for (const match of hostTemplate.matchAll(/\{([^}]+)\}/g)) {
      const placeholder = match[1] as string;
      assert(
        placeholder in known,
        `${where}.hostTemplate has unknown placeholder {${placeholder}} (expected {workspaceId} or {region})`,
      );
      assertNonEmptyString(
        known[placeholder],
        `${where}.${placeholder} (required by hostTemplate placeholder {${placeholder}})`,
      );
    }
  } else {
    assert(
      typeof raw.baseUrl === "string" && isSecureExternalUrl(raw.baseUrl),
      `${where}.baseUrl must be an https:// URL (http:// allowed only for localhost)`,
    );
  }
  assert(
    typeof raw.modelsUrl === "string" && isSecureExternalUrl(raw.modelsUrl),
    `${where}.modelsUrl must be an https:// discovery URL (http:// allowed only for localhost)`,
  );
  return {
    type: ptype as "anthropic" | "openai",
    credential,
    auth: auth as ProviderAuthStyle,
    baseUrl: typeof raw.baseUrl === "string" ? raw.baseUrl.replace(/\/+$/, "") : "",
    ...(typeof raw.hostTemplate === "string" ? { hostTemplate: raw.hostTemplate } : {}),
    ...(typeof raw.basePath === "string" ? { basePath: raw.basePath } : {}),
    ...(typeof raw.workspaceId === "string" ? { workspaceId: raw.workspaceId } : {}),
    ...(typeof raw.region === "string" ? { region: raw.region } : {}),
    countTokens: raw.countTokens === true,
    ...(raw.strictTools === true ? { strictTools: true } : {}),
    modelsUrl: raw.modelsUrl,
  };
}

function validateExternalProviders(
  providers: Record<string, unknown>,
): Record<string, ExternalProviderConfig> {
  const external: Record<string, ExternalProviderConfig> = {};
  for (const [key, rawProvider] of Object.entries(providers)) {
    if (key === "bedrock") continue;
    external[key] = validateExternalProvider(key, rawProvider);
  }
  return external;
}

function validateLogging(raw: unknown): LoggingConfig {
  const rawLogging = isRecord(raw) ? raw : {};
  const rawTimeout = rawLogging.captureTimeoutMs;
  const captureTimeoutMs =
    typeof rawTimeout === "number" && Number.isInteger(rawTimeout) && rawTimeout > 0
      ? rawTimeout
      : DEFAULT_LOG_CAPTURE_TIMEOUT_MS;
  return {
    enabled: rawLogging.enabled === true,
    dir: stringOrDefault(rawLogging.dir, "./logs"),
    systemDir: stringOrDefault(rawLogging.systemDir, "system"),
    sessionDir: stringOrDefault(rawLogging.sessionDir, "sessions"),
    captureTimeoutMs,
  };
}

/** Validate a parsed object into a typed, frozen ProxyConfig. */
export function validateConfig(raw: unknown): ProxyConfig {
  assert(isRecord(raw), "Config root must be an object");

  const server = validateServer(raw.server);
  const inboundAuth = validateInboundAuth(raw.inboundAuth);

  assert(
    VALID_REGION_KEYS.includes(raw.primaryRegion as RegionKey),
    `config.primaryRegion must be one of ${VALID_REGION_KEYS.join(", ")}`,
  );
  const primaryRegion = raw.primaryRegion as RegionKey;

  assert(
    VALID_PROFILE_PREFERENCES.includes(raw.profilePreference as ProfilePreference),
    `config.profilePreference must be one of ${VALID_PROFILE_PREFERENCES.join(", ")}`,
  );

  // refreshIntervalMinutes — bounded so a typo (e.g. 600000) can't effectively
  // disable refresh, and 0/negative can't produce a hot-spin interval.
  assert(
    typeof raw.refreshIntervalMinutes === "number" &&
      Number.isFinite(raw.refreshIntervalMinutes) &&
      raw.refreshIntervalMinutes >= 1 &&
      raw.refreshIntervalMinutes <= 1440,
    "config.refreshIntervalMinutes must be a number in [1, 1440]",
  );

  assert(
    typeof raw.claudeFallbackToMantle === "boolean",
    "config.claudeFallbackToMantle must be a boolean",
  );

  const regions = validateRegions(raw.regions, primaryRegion);

  assert(isRecord(raw.providers), "config.providers must be an object");
  // An absent bedrock block disables Bedrock (external providers only).
  const bedrock =
    raw.providers.bedrock === undefined
      ? undefined
      : validateBedrockProvider(raw.providers.bedrock);
  const external = validateExternalProviders(raw.providers);

  const config: ProxyConfig = {
    server,
    inboundAuth,
    primaryRegion,
    profilePreference: raw.profilePreference as ProfilePreference,
    refreshIntervalMinutes: raw.refreshIntervalMinutes,
    claudeFallbackToMantle: raw.claudeFallbackToMantle,
    regions,
    providers: { ...(bedrock ? { bedrock } : {}), external },
    logging: validateLogging(raw.logging),
    chatPage: { enabled: isRecord(raw.chatPage) && raw.chatPage.enabled === true },
    limits: validateLimits(raw.limits),
  };
  return Object.freeze(config);
}

/**
 * Validate the optional `limits` block (SEC-4). Absent block or absent field
 * falls back to `DEFAULT_REQUEST_LIMITS`. Each provided value must be a positive
 * integer.
 */
function validateLimits(raw: unknown): RequestLimits {
  if (raw === undefined) return DEFAULT_REQUEST_LIMITS;
  assert(isRecord(raw), "config.limits must be an object");
  const pos = (v: unknown, name: string, dflt: number): number => {
    if (v === undefined) return dflt;
    assert(
      typeof v === "number" && Number.isInteger(v) && v > 0,
      `config.limits.${name} must be a positive integer`,
    );
    return v;
  };
  return {
    maxMessages: pos(raw.maxMessages, "maxMessages", DEFAULT_REQUEST_LIMITS.maxMessages),
    maxContentBlocksPerMessage: pos(
      raw.maxContentBlocksPerMessage,
      "maxContentBlocksPerMessage",
      DEFAULT_REQUEST_LIMITS.maxContentBlocksPerMessage,
    ),
    maxTools: pos(raw.maxTools, "maxTools", DEFAULT_REQUEST_LIMITS.maxTools),
  };
}

/** Resolve a concrete AWS region for a region key. */
export function awsRegionForKey(config: ProxyConfig, key: RegionKey): string {
  const match = config.regions.find((r) => r.key === key);
  if (!match) throw new ConfigError(`No AWS region configured for key "${key}"`);
  return match.awsRegion;
}

/**
 * Map a canonical-id profilePrefix to a concrete AWS region (DESIGN §5.2).
 * "global" resolves to the configured primary region.
 */
export function awsRegionForPrefix(config: ProxyConfig, profilePrefix: string): string {
  if (profilePrefix === "global") return awsRegionForKey(config, config.primaryRegion);
  if (profilePrefix === "us" || profilePrefix === "eu") {
    return awsRegionForKey(config, profilePrefix);
  }
  throw new ConfigError(`Unknown profilePrefix "${profilePrefix}" (expected global | us | eu)`);
}

/** Substitute {region} in a templated host string. */
export function hostForRegion(template: string, awsRegion: string): string {
  return template.replaceAll("{region}", awsRegion);
}

/**
 * Load, interpolate, and validate config from a JSONC file.
 * @param path Path to the config file.
 * @param env  Environment used for ${ENV} interpolation (defaults to Bun.env).
 */
export async function loadConfig(
  path: string,
  env: Record<string, string | undefined> = Bun.env,
): Promise<ProxyConfig> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new ConfigError(`Config file not found: ${path}`);
  }
  const rawText = await file.text();
  const interpolated = interpolateEnv(stripJsonComments(rawText), env);
  let parsed: unknown;
  try {
    parsed = JSON.parse(interpolated);
  } catch (err) {
    throw new ConfigError("Config file is not valid JSON after processing", { cause: err });
  }
  return validateConfig(parsed);
}

/**
 * Build a reverse map from an env value to its `${VAR}` reference, for secret-
 * preserving serialization. Only vars with a unique, non-empty value are
 * included (ambiguous shared values are skipped to avoid mis-substitution).
 * Longer values first so the most specific match wins during replacement.
 */
function buildEnvRefMap(env: Record<string, string | undefined>): [string, string][] {
  const byValue = new Map<string, string[]>();
  for (const [name, value] of Object.entries(env)) {
    if (!value) continue;
    const list = byValue.get(value) ?? [];
    list.push(name);
    byValue.set(value, list);
  }
  const pairs: [string, string][] = [];
  for (const [value, names] of byValue) {
    if (names.length === 1) pairs.push([value, `\${${names[0]}}`]);
  }
  // Replace longer literals first (avoids partial shadowing).
  pairs.sort((a, b) => b[0].length - a[0].length);
  return pairs;
}

/**
 * Restore a single-value field: if the whole string exactly equals a known env
 * value, return its `${VAR}` reference. Exact-match is safe even for short
 * values (no substring collisions). Used for credential / workspaceId / keys.
 */
function restoreExact(s: string, refs: [string, string][]): string {
  for (const [value, ref] of refs) {
    if (s === value) return ref;
  }
  return s;
}

/**
 * Restore composite fields (e.g. a modelsUrl that embeds `${WORKSPACE_ID}`):
 * substring-replace known env values with their refs. Guarded to values >= 8
 * chars to avoid accidental substring collisions in URLs.
 */
function restoreEmbedded(s: string, refs: [string, string][]): string {
  let out = s;
  for (const [value, ref] of refs) {
    if (value.length >= 8 && out.includes(value)) out = out.split(value).join(ref);
  }
  return out;
}

/**
 * Serialize a validated ProxyConfig back to the raw config-file object shape.
 *
 * When `env` is provided, credential / workspaceId / inbound keys that came from
 * `${ENV}` interpolation are written back as their `${VAR}` references instead
 * of the resolved literal secret (exact-match), and composite fields like
 * modelsUrl have embedded env values restored — so a UI save preserves
 * env-driven config and never persists a secret meant to live in the
 * environment. Values not sourced from env are written literally (LAN pod).
 */
export function serializeConfig(
  config: ProxyConfig,
  env?: Record<string, string | undefined>,
): Record<string, unknown> {
  const refs = env ? buildEnvRefMap(env) : [];
  const exact = (s: string): string => (refs.length ? restoreExact(s, refs) : s);
  const embed = (s: string): string => (refs.length ? restoreEmbedded(s, refs) : s);

  // Bedrock is optional: an absent block serializes with no `bedrock` key, and
  // a present-with-empty credential round-trips as "" (never as a strict
  // `${VAR}` ref — buildEnvRefMap skips empty env values, so the next boot of
  // a key-less setup still loads).
  const providers: Record<string, unknown> = {};
  if (config.providers.bedrock) {
    providers.bedrock = {
      type: "bedrock",
      credential: exact(config.providers.bedrock.credential),
      hosts: {
        converse: config.providers.bedrock.hosts.converse,
        mantle: config.providers.bedrock.hosts.mantle,
        control: config.providers.bedrock.hosts.control,
      },
    };
  }
  for (const [key, p] of Object.entries(config.providers.external)) {
    providers[key] = {
      type: p.type,
      credential: exact(p.credential),
      auth: p.auth,
      ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
      ...(p.hostTemplate ? { hostTemplate: p.hostTemplate } : {}),
      ...(p.basePath ? { basePath: p.basePath } : {}),
      ...(p.workspaceId ? { workspaceId: exact(p.workspaceId) } : {}),
      ...(p.region ? { region: p.region } : {}),
      countTokens: p.countTokens,
      ...(p.strictTools ? { strictTools: true } : {}),
      modelsUrl: embed(p.modelsUrl),
    };
  }
  return {
    server: { host: config.server.host, port: config.server.port },
    inboundAuth: { keys: config.inboundAuth.keys.map((k) => exact(k)) },
    primaryRegion: config.primaryRegion,
    profilePreference: config.profilePreference,
    refreshIntervalMinutes: config.refreshIntervalMinutes,
    claudeFallbackToMantle: config.claudeFallbackToMantle,
    regions: config.regions.map((r) => ({ key: r.key, awsRegion: r.awsRegion })),
    providers,
    logging: {
      enabled: config.logging.enabled,
      dir: config.logging.dir,
      systemDir: config.logging.systemDir,
      sessionDir: config.logging.sessionDir,
      captureTimeoutMs: config.logging.captureTimeoutMs,
    },
    chatPage: { enabled: config.chatPage.enabled },
    limits: {
      maxMessages: config.limits.maxMessages,
      maxContentBlocksPerMessage: config.limits.maxContentBlocksPerMessage,
      maxTools: config.limits.maxTools,
    },
  };
}

/**
 * Persist a validated config to a plain-JSON file.
 *
 * Writes in place (single full-buffer write) rather than temp+rename. This is
 * required for bind-mounted config files (the common Docker case): the mount is
 * the file inode itself, so a sibling temp+rename would fail on a non-writable
 * parent directory and would detach the mount even if it succeeded. The content
 * is serialized fully in memory first, so a failed serialize never truncates
 * the existing file.
 *
 * `env` (defaults to Bun.env) is used to restore `${ENV}` references for
 * secrets so a save never bakes an env-sourced secret into the file.
 *
 * Note: writes JSON (not JSONC) — comments in the original file are not
 * preserved, which is expected once the file is UI-managed.
 */
export async function saveConfig(
  path: string,
  config: ProxyConfig,
  env: Record<string, string | undefined> = Bun.env,
): Promise<void> {
  const json = `${JSON.stringify(serializeConfig(config, env), null, 2)}\n`;
  await Bun.write(path, json);
}
