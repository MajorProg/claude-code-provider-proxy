/**
 * HTTP server entrypoint (DESIGN §9).
 *
 * Wires config loading, outbound token provisioning, and live model discovery,
 * and serves:
 *   - GET  /                         registry status page (HTML)
 *   - GET  /status.json              registry snapshot (JSON)
 *   - GET  /v1/models                discovered canonical model ids
 *   - POST /v1/messages              inference (translation paths P/C/M)
 *   - POST /v1/messages/count_tokens token counting
 *   - HEAD /api/hello                connection-warming probe -> 204
 *
 * All inference translation handlers (Paths P/C/M) are fully wired. All
 * model/registry data shown is real, discovered at runtime — never hardcoded.
 *
 * Auth surfaces (DESIGN §8.1): the inference endpoints AND the entire
 * management/observability surface (/config, /api/config*, /logs, /api/logs/*,
 * /api/chat) require the inbound key. LAN-only bind is an additional mitigation,
 * not the access control itself.
 */
import { credentialState, resolveBedrockMode } from "./auth/bedrock-mode.ts";
import { generateShortLivedBedrockToken } from "./auth/bedrock-token.ts";
import { authenticateInbound } from "./auth/inbound.ts";
import { BEDROCK_DEV_SENTINELS } from "./auth/token-provider.ts";
import {
  type ProxyConfig,
  loadConfig,
  saveConfig,
  serializeConfig,
  validateConfig,
} from "./config.ts";
import {
  BadRequestError,
  ProviderDisabledError,
  ProxyError,
  UnauthorizedError,
  UpstreamError,
} from "./errors.ts";
import { renderChatPageHtml } from "./http/chat-page.ts";
import { renderConfigPageHtml } from "./http/config-page.ts";
import { renderLogViewerHtml } from "./http/log-viewer-page.ts";
import { buildRegistrySnapshot, renderRegistryHtml } from "./http/registry-page.ts";
import { ZipLimitError, buildZip } from "./http/zip.ts";
import { type CaptureContext, captureTurn, summarizeTools } from "./logging/capture.ts";
import { LogStore } from "./logging/log-store.ts";
import { errorMessage, logger, newRequestId } from "./logging/logger.ts";
import { formatCanonicalId, parseCanonicalId } from "./model/canonical-id.ts";
import {
  type Catalog,
  CatalogManager,
  type RegionTokenProvider,
  createHttpDiscoveryClient,
} from "./model/catalog.ts";
import { handleConverseMessages } from "./paths/converse.ts";
import { handleMantleMessages } from "./paths/mantle.ts";
import { handlePassthroughCountTokens, handlePassthroughMessages } from "./paths/passthrough.ts";
import { type JsonObject, parseJsonObject } from "./paths/relay.ts";
import { route } from "./router.ts";

const CONFIG_PATH = Bun.env.CONFIG_PATH ?? "config.local.jsonc";

/** Default max_tokens for the built-in chat test page when the body omits it. */
const DEFAULT_CHAT_MAX_TOKENS = 1024;

/** Parse the bind port from env with a NaN/range guard (fail fast, not a silent NaN). */
function resolvePort(): number {
  const raw = Bun.env.PORT;
  if (raw === undefined || raw === "") return 8787;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n >= 65536) {
    throw new Error(`Invalid PORT env value "${raw}": must be an integer in (0, 65536)`);
  }
  return n;
}
const PORT = resolvePort();
// Effective bind host: explicit HOST env (set to the LAN ${BIND_IP} by the CLI
// in local mode, or by compose in Docker) wins; otherwise fall back to the
// config's server.host (see main()); final fallback is loopback.
const HOST_ENV = Bun.env.HOST;

/** Max chars of an upstream error body to include in a single log line. */
const MAX_UPSTREAM_BODY_LOG_CHARS = 2000;

/** Truncate an upstream body for logging so one bad response can't flood logs. */
function truncateForLog(body: string): string {
  return body.length > MAX_UPSTREAM_BODY_LOG_CHARS
    ? `${body.slice(0, MAX_UPSTREAM_BODY_LOG_CHARS)}…[+${body.length - MAX_UPSTREAM_BODY_LOG_CHARS} chars]`
    : body;
}

/**
 * True when an error is a client-driven abort — the inbound request's
 * `AbortSignal` fired because Claude Code closed the connection mid-flight
 * (e.g. the user hit Esc, or a streaming turn was cancelled). This propagates
 * through the upstream fetch as a `DOMException` named "AbortError". It is not
 * a proxy fault: there is no client left to receive a response, so it must be
 * logged quietly rather than dumped as an unhandled error with a full stack.
 * A structural `name` check (not `instanceof DOMException`) keeps this robust
 * across the different Error/DOMException shapes Bun surfaces for aborts.
 */
function isClientDisconnect(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name: unknown }).name === "AbortError"
  );
}

function errorResponse(
  err: unknown,
  ctx?: { requestId?: string; method?: string; path?: string },
): Response {
  // A client disconnect (inbound request aborted) is expected, not a failure.
  // The socket is already gone, so the returned Response is never delivered;
  // log at info without a stack and return a benign 499-style body.
  if (isClientDisconnect(err)) {
    logger.info("request aborted by client", {
      requestId: ctx?.requestId,
      method: ctx?.method,
      path: ctx?.path,
    });
    return Response.json(
      { type: "error", error: { type: "api_error", message: "Client closed request" } },
      { status: 499 },
    );
  }
  if (err instanceof ProxyError) {
    const base = {
      requestId: ctx?.requestId,
      method: ctx?.method,
      path: ctx?.path,
      status: err.status,
      type: err.type,
      message: err.message,
      // Upstream failures carry route/model context; surface it in logs only
      // (never in the client body). Undefined fields are dropped by the logger.
      ...(err instanceof UpstreamError ? err.context : {}),
      // The upstream error body is the single most useful diagnostic for an
      // Upstream 4xx/5xx (e.g. "input_schema required"). Log it (truncated) so
      // a rejected translation is never invisible. Never sent in the client body.
      ...(err instanceof UpstreamError && err.upstreamBody
        ? { upstreamBody: truncateForLog(err.upstreamBody) }
        : {}),
    };
    if (err.status >= 500) {
      // Server-side failures (config, upstream 5xx) — error level + full cause.
      logger.error("request error", base);
      if (err.cause !== undefined) console.error(err.cause);
    } else {
      // Client/routing errors (4xx) are expected — warn without a stack.
      logger.warn("request error", base);
    }
    return Response.json(err.toAnthropicBody(), { status: err.status });
  }
  // Unexpected (non-ProxyError) errors — log at error with the full stack.
  logger.error("unhandled request error", {
    requestId: ctx?.requestId,
    method: ctx?.method,
    path: ctx?.path,
    message: errorMessage(err),
  });
  console.error(err); // full stack/cause for diagnosis
  const message = err instanceof Error ? err.message : "Internal error";
  return Response.json({ type: "error", error: { type: "api_error", message } }, { status: 500 });
}

/**
 * Gate the management/observability API (config, logs, chat) behind the same
 * inbound key that protects inference. Returning resolved credentials to the
 * config UI is only acceptable because this check runs first — an
 * unauthenticated network client can neither read nor overwrite the config,
 * whether reached over loopback or the LAN (e.g. a Docker-published port).
 * The HTML shells that call these endpoints are public markup carrying no
 * secret; they attach the key from the browser session on each fetch.
 * Throws UnauthorizedError (-> 401) when the key is missing/invalid.
 */
function authenticateManagement(req: Request, config: ProxyConfig): void {
  authenticateInbound(req.headers, config.inboundAuth.keys);
}

/**
 * Content-Security-Policy for the served HTML pages. The pages load Alpine +
 * a markdown renderer from a CDN and use inline <script>/<style> (Alpine
 * x-data attributes and the inlined page scripts), so 'unsafe-inline' is
 * required for script/style; everything else is locked down. connect-src is
 * 'self' (all API calls are same-origin). This hardens the credential-reveal
 * DOM surface addressed by the XSS-escaping work.
 */
const CSP_HEADER =
  "default-src 'self'; " +
  // Tailwind Play CDN + Alpine load from these hosts; Tailwind's JIT uses eval,
  // and Alpine x-data attributes + inlined page scripts need 'unsafe-inline'.
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.tailwindcss.com https://cdn.jsdelivr.net; " +
  // Tailwind Play injects a <style> tag at runtime, so style needs the CDN + inline.
  "style-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com; " +
  "img-src 'self' data:; " +
  "connect-src 'self'; " +
  "font-src 'self' data:; " +
  "object-src 'none'; " +
  "base-uri 'none'; " +
  "frame-ancestors 'none'";

/**
 * CSRF defense for state-changing management POSTs. Even though the endpoint
 * requires the inbound key, a browser that has the key in sessionStorage could
 * be driven by a malicious page — but only same-origin script can read that key
 * AND set the custom header below (a cross-origin form/simple request cannot
 * set `x-ccpp-csrf` without a CORS preflight the server never approves). We
 * also reject a cross-origin `Origin` header when present. Throws Unauthorized
 * (-> 401) on failure.
 */
const CSRF_HEADER = "x-ccpp-csrf";
function assertCsrf(req: Request, url: { origin?: string }): void {
  if (req.headers.get(CSRF_HEADER) === null) {
    throw new UnauthorizedError("Missing CSRF header");
  }
  // If the browser sent an Origin, it must match this server's origin.
  const origin = req.headers.get("origin");
  if (origin !== null && url.origin !== undefined && origin !== url.origin) {
    throw new UnauthorizedError("Cross-origin request rejected");
  }
}

/**
 * Serialize async critical sections via a promise chain. Each call runs only
 * after the previous one settles, so concurrent callers cannot interleave.
 * (Failures are isolated: one rejection does not poison the chain.)
 */
export function createSerializer(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    // Keep the chain alive but swallow settlement so a rejection here does not
    // reject the next queued task.
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

/** Extract the required `model` field from an already-parsed request body. */
function modelFromBody(parsed: JsonObject): string {
  if (typeof parsed.model !== "string" || parsed.model.length === 0) {
    throw new BadRequestError("Request is missing a string `model` field");
  }
  return parsed.model;
}

/**
 * Resolve the outbound credential + header auth style for a route target.
 * Bedrock uses the region-aware token provider; external providers use their
 * static config API key + configured header style. Shared by the inference and
 * count-tokens dispatchers (identical logic in both before this extraction).
 * `tokenProvider` is null when Bedrock is disabled — unreachable for external
 * targets, and a clean ProviderDisabledError for bedrock ones.
 */
async function resolveOutboundAuth(
  config: ProxyConfig,
  tokenProvider: RegionTokenProvider | null,
  target: ReturnType<typeof route>,
): Promise<{ bearer: string; authStyle: "x-api-key" | "bearer" }> {
  const externalProvider = config.providers.external[target.provider];
  if (externalProvider) {
    return { bearer: externalProvider.credential, authStyle: externalProvider.auth };
  }
  // Defense-in-depth: route() already rejects bedrock targets when disabled.
  if (!tokenProvider) {
    throw new ProviderDisabledError("bedrock", "no usable Bedrock credential configured");
  }
  return { bearer: await tokenProvider(target.awsRegion), authStyle: "x-api-key" };
}

/**
 * Best-effort turn capture shared by the two capturing dispatchers
 * (/v1/messages and /api/chat). Returns the (possibly tee'd) response
 * unchanged when logging is disabled; otherwise wraps it so the turn is
 * recorded transparently without blocking the client.
 */
function maybeCaptureTurn(
  store: LogStore,
  response: Response,
  ctx: CaptureContext,
  signal?: AbortSignal,
): Response {
  return store.isEnabled() ? captureTurn(store, ctx, response, signal) : response;
}

/**
 * Core inference: parse model, route, dispatch to the translation path.
 * Auth is handled by callers (the public endpoint authenticates; the internal
 * chat endpoint is gated separately). Returns the Anthropic-shaped Response and
 * the resolved routing info (for logging).
 */
async function runInference(
  config: ProxyConfig,
  catalog: Catalog,
  tokenProvider: RegionTokenProvider | null,
  parsed: JsonObject,
  inboundHeaders: { get(name: string): string | null },
  signal?: AbortSignal,
): Promise<{
  response: Response;
  canonicalId: ReturnType<typeof parseCanonicalId>;
  target: ReturnType<typeof route>;
}> {
  const canonicalId = parseCanonicalId(modelFromBody(parsed));
  const target = route(config, catalog, canonicalId);
  logger.debug("routing decision", {
    provider: target.provider,
    backend: target.backend,
    translationPath: target.translationPath,
    region: target.awsRegion || undefined,
    invocationId: target.invocationId,
  });

  // Credential + auth style: Bedrock uses the region-aware token provider;
  // external providers use their static config API key + configured header style.
  const { bearer, authStyle } = await resolveOutboundAuth(config, tokenProvider, target);

  let response: Response;
  switch (target.translationPath) {
    case "passthrough":
      response = await handlePassthroughMessages(
        target,
        inboundHeaders,
        bearer,
        parsed,
        authStyle,
        signal,
      );
      break;
    case "converse":
      response = await handleConverseMessages(target, bearer, parsed, signal);
      break;
    case "mantle":
      response = await handleMantleMessages(target, bearer, parsed, signal);
      break;
  }
  return { response, canonicalId, target };
}

/** Dispatch POST /v1/messages to the correct translation path. */
async function dispatchMessages(
  config: ProxyConfig,
  catalog: Catalog,
  tokenProvider: RegionTokenProvider | null,
  store: LogStore,
  req: Request,
): Promise<Response> {
  authenticateInbound(req.headers, config.inboundAuth.keys);
  const requestedAt = new Date().toISOString();
  // Parse the inbound body ONCE here; thread the parsed object through
  // inference and capture (no re-parse in extractModel/safeParse/the handler).
  const parsed = parseJsonObject(await req.text());
  const { response, canonicalId, target } = await runInference(
    config,
    catalog,
    tokenProvider,
    parsed,
    req.headers,
    req.signal,
  );

  // Best-effort capture (no-op when logging disabled). Never blocks/alters
  // the client response beyond a transparent stream tee. Reuses the parsed body.
  const toolTrace = summarizeTools(parsed.tools);
  return maybeCaptureTurn(
    store,
    response,
    {
      sessionId: req.headers.get("x-claude-code-session-id") ?? `anon-${crypto.randomUUID()}`,
      canonicalModel: formatCanonicalId(canonicalId),
      invocationModel: target.invocationId,
      backend: target.backend,
      translationPath: target.translationPath,
      system: parsed.system,
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
      ...(toolTrace ? { tools: toolTrace } : {}),
      requestedAt,
    },
    req.signal,
  );
}

/**
 * Internal chat endpoint (POST /api/chat) for the built-in test page.
 *
 * Reuses the same route + translation machinery and the server-side Bedrock
 * credential — the credential itself is never present in the browser. Because
 * this runs real inference on the server-side credential, it requires the
 * inbound key (gated by the caller via authenticateManagement) in addition to
 * config.chatPage.enabled. Body: { model, system?, messages, stream? }.
 */
async function dispatchChat(
  config: ProxyConfig,
  catalog: Catalog,
  tokenProvider: RegionTokenProvider | null,
  store: LogStore,
  req: Request,
): Promise<Response> {
  if (!config.chatPage.enabled) {
    return Response.json({ error: "chat page disabled" }, { status: 404 });
  }
  const requestedAt = new Date().toISOString();
  // Parse at the trust boundary (uniform with dispatchMessages/CountTokens):
  // rejects non-object bodies with a clean 400 rather than a downstream cast.
  const raw = parseJsonObject(await req.text(), "Chat body") as {
    model?: string;
    system?: unknown;
    messages?: unknown;
    stream?: boolean;
    max_tokens?: number;
  };
  if (typeof raw.model !== "string") throw new BadRequestError("chat requires a `model`");
  // Build a standard Anthropic request object the translation paths understand.
  const body: JsonObject = {
    model: raw.model,
    system: raw.system ?? "You are a helpful assistant.",
    messages: Array.isArray(raw.messages) ? raw.messages : [],
    max_tokens: typeof raw.max_tokens === "number" ? raw.max_tokens : DEFAULT_CHAT_MAX_TOKENS,
    stream: raw.stream === true,
  };
  const noHeaders = { get: () => null };
  const { response, canonicalId, target } = await runInference(
    config,
    catalog,
    tokenProvider,
    body,
    noHeaders,
    req.signal,
  );

  return maybeCaptureTurn(
    store,
    response,
    {
      sessionId: "chat-ui",
      canonicalModel: formatCanonicalId(canonicalId),
      invocationModel: target.invocationId,
      backend: target.backend,
      translationPath: target.translationPath,
      system: raw.system ?? "You are a helpful assistant.",
      messages: Array.isArray(raw.messages) ? raw.messages : [],
      requestedAt,
    },
    req.signal,
  );
}

/** Build a ZIP download Response from log entries. */
function zipResponse(entries: { name: string; content: string }[], baseName: string): Response {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `${baseName}-${stamp}.zip`;
  let zip: Uint8Array;
  try {
    zip = buildZip(entries.map((e) => ({ name: e.name, data: e.content })));
  } catch (err) {
    if (err instanceof ZipLimitError) {
      // Too large / too many entries for a v2.0 ZIP — 413 instead of a silently
      // corrupt archive. The operator can narrow the export range and retry.
      logger.warn("zip export exceeded limits", { message: err.message });
      return Response.json(
        { type: "error", error: { type: "request_too_large", message: err.message } },
        { status: 413 },
      );
    }
    throw err;
  }
  // buildZip returns a fresh ArrayBuffer-backed Uint8Array — no extra copy needed.
  return new Response(zip, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}

/**
 * Describe effective outbound auth per provider (for the Config page).
 *
 * Bedrock: if a real long-term key is configured, report it (resolved value —
 * this endpoint is gated by authenticateManagement, so an authenticated admin
 * may see the key they manage here). If the credential is the "dev"/empty
 * sentinel, we validate that a SigV4 token CAN be minted from the AWS env
 * credentials but return only METADATA (mode/region/expiry/awsPresent) — never
 * the token itself, since it is short-lived, regenerable, and never needs to be
 * displayed or copied.
 * External providers: report their resolved credential (again, gated).
 */
async function describeAuth(config: ProxyConfig): Promise<Response> {
  const bedrockCred = config.providers.bedrock?.credential;
  const primaryAwsRegion = config.regions.find((r) => r.key === config.primaryRegion)?.awsRegion;

  let bedrock: Record<string, unknown>;
  // Disabled (absent block, empty/placeholder credential, or dev mode without
  // AWS creds) is a first-class mode — surfaced, never a credential leak.
  const mode = resolveBedrockMode(bedrockCred);
  if (!mode.enabled) {
    bedrock = { mode: "disabled", reason: mode.reason, region: primaryAwsRegion };
  } else if (bedrockCred !== undefined && !BEDROCK_DEV_SENTINELS.has(bedrockCred)) {
    bedrock = { mode: "long-term-key", credential: bedrockCred, region: primaryAwsRegion };
  } else {
    const env = Bun.env;
    const awsPresent = {
      AWS_ACCESS_KEY_ID: Boolean(env.AWS_ACCESS_KEY_ID),
      AWS_SECRET_ACCESS_KEY: Boolean(env.AWS_SECRET_ACCESS_KEY),
      AWS_SESSION_TOKEN: Boolean(env.AWS_SESSION_TOKEN),
    };
    const expiresInSeconds = 3600;
    try {
      if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY || !primaryAwsRegion) {
        throw new Error("AWS credentials not present in environment");
      }
      // Mint to prove it works, but do NOT return the token — metadata only.
      await generateShortLivedBedrockToken({
        credentials: {
          accessKeyId: env.AWS_ACCESS_KEY_ID,
          secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
          ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}),
        },
        region: primaryAwsRegion,
        expiresInSeconds,
      });
      bedrock = {
        mode: "dev-sigv4",
        tokenAvailable: true,
        region: primaryAwsRegion,
        awsPresent,
        expiresInSeconds,
        mintedAt: new Date().toISOString(),
      };
    } catch (err) {
      bedrock = {
        mode: "dev-sigv4",
        tokenAvailable: false,
        error: errorMessage(err),
        region: primaryAwsRegion,
        awsPresent,
      };
    }
  }

  const external: Record<string, unknown> = {};
  for (const [key, p] of Object.entries(config.providers.external)) {
    external[key] = {
      type: p.type,
      auth: p.auth,
      credential: p.credential,
      state: credentialState(p.credential),
    };
  }
  return Response.json({ bedrock, external });
}

/** Dispatch POST /v1/messages/count_tokens (supported for Claude passthrough). */
async function dispatchCountTokens(
  config: ProxyConfig,
  catalog: Catalog,
  tokenProvider: RegionTokenProvider | null,
  req: Request,
): Promise<Response> {
  authenticateInbound(req.headers, config.inboundAuth.keys);
  const parsed = parseJsonObject(await req.text());
  const canonicalId = parseCanonicalId(modelFromBody(parsed));
  const target = route(config, catalog, canonicalId);

  if (target.translationPath === "passthrough" && target.countTokensPath) {
    const { bearer, authStyle } = await resolveOutboundAuth(config, tokenProvider, target);
    return handlePassthroughCountTokens(target, req.headers, bearer, parsed, authStyle, req.signal);
  }
  // Non-passthrough backends have no native Anthropic count endpoint; Claude Code
  // falls back to counting via the messages endpoint, so 404 is acceptable here.
  throw new BadRequestError("count_tokens is not supported for this backend/model");
}

/** Mutable runtime built from a config; swapped atomically on hot-reload. */
export interface Runtime {
  config: ProxyConfig;
  tokenProvider: RegionTokenProvider | null;
  catalogManager: CatalogManager;
  logStore: LogStore;
}

/**
 * Build a Runtime (token provider + discovery + catalog + log store) from a
 * config. Bedrock is optional: an unusable/absent credential disables it (no
 * Bedrock discovery at all) and the proxy runs on external providers; a
 * discovery failure degrades the catalog instead of throwing, so this only
 * fails for genuinely fatal problems (unwritable log dir, invalid config).
 */
export async function buildRuntime(config: ProxyConfig): Promise<Runtime> {
  const mode = resolveBedrockMode(config.providers.bedrock?.credential);
  if (!mode.enabled) {
    logger.error("Bedrock provider disabled — running on external providers only", {
      reason: mode.reason,
    });
  }
  const discoveryClient = mode.enabled
    ? createHttpDiscoveryClient(config, mode.tokenProvider)
    : null;
  const catalogManager = await CatalogManager.start(config, discoveryClient);
  if (catalogManager.current().models.length === 0) {
    logger.error(
      "No models discovered — serving an empty catalog. Set a provider key (e.g. in .env, " +
        "then restart) or fix credentials via the config UI at /config",
    );
  }
  const logStore = new LogStore(config.logging);
  await logStore.verifyWritable();
  return {
    config,
    tokenProvider: mode.enabled ? mode.tokenProvider : null,
    catalogManager,
    logStore,
  };
}

/**
 * Per-request context passed to every route handler. Bundles the live runtime
 * references (swapped atomically on hot-reload) plus the parsed request/URL and
 * any path parameters captured by the matcher. This lets each handler be a
 * small, independently testable function instead of a branch in a mega-if.
 */
interface RouteContext {
  req: Request;
  /** Structural URL view (avoids the DOM-vs-Bun `URL` lib collision; see AGENTS.md). */
  url: { searchParams: { get(name: string): string | null } };
  method: string;
  config: ProxyConfig;
  tokenProvider: RegionTokenProvider | null;
  catalogManager: CatalogManager;
  logStore: LogStore;
  reloadRuntime: (rawConfig: unknown) => Promise<void>;
  /** Path segments captured after a route's prefix (already decodeURIComponent'd). */
  params: string[];
}

type RouteHandler = (ctx: RouteContext) => Response | Promise<Response>;

/**
 * A declarative route. `match` returns captured path params (possibly empty)
 * when the route applies to a pathname, or `null` to skip. `requiresAuth`
 * gates the handler behind the inbound management key BEFORE it runs.
 */
interface Route {
  method: string;
  /** Human-readable label for the route (diagnostics / future metrics). */
  name: string;
  match: (pathname: string) => string[] | null;
  requiresAuth: boolean;
  /** State-changing management POSTs also require the CSRF header + Origin check. */
  requiresCsrf?: boolean;
  handler: RouteHandler;
}

/** Exact-path matcher (optionally accepting several equivalent paths). */
function exact(...paths: string[]): (pathname: string) => string[] | null {
  return (pathname) => (paths.includes(pathname) ? [] : null);
}

/**
 * Prefix matcher that captures the remaining path as `/`-split, non-empty,
 * decodeURIComponent'd segments. Used for the log system-hash / session routes.
 */
function prefix(base: string): (pathname: string) => string[] | null {
  return (pathname) => {
    if (!pathname.startsWith(base)) return null;
    return pathname
      .slice(base.length)
      .split("/")
      .filter((p) => p.length > 0)
      .map(decodeURIComponent);
  };
}

const htmlHeaders = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": CSP_HEADER,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
} as const;
const notFound = () =>
  Response.json(
    { type: "error", error: { type: "not_found_error", message: "Unknown route" } },
    { status: 404 },
  );

// --- Per-group route handlers (extracted from the former mega-if) ----------

function handleRegistryPage({ config, catalogManager }: RouteContext): Response {
  const snapshot = buildRegistrySnapshot(config, catalogManager.current());
  return new Response(renderRegistryHtml(snapshot, config.chatPage.enabled), {
    headers: htmlHeaders,
  });
}

function handleRegistryJson({ config, catalogManager }: RouteContext): Response {
  return Response.json(buildRegistrySnapshot(config, catalogManager.current()));
}

function handleModelsList({ catalogManager }: RouteContext): Response {
  const data = catalogManager
    .current()
    .models.map((m) => ({
      id: formatCanonicalId({
        provider: m.provider,
        backend: m.backend,
        profilePrefix: m.regionKey,
        nativeModelId: m.nativeModelId,
      }),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return Response.json({ data });
}

async function handleLogsSystemList({ logStore }: RouteContext): Promise<Response> {
  return Response.json({ data: await logStore.listSystemPrompts() });
}

async function handleLogsExportSystem({ logStore }: RouteContext): Promise<Response> {
  return zipResponse(await logStore.exportSystemPrompts(), "system-prompts");
}

async function handleLogsExportSessions({ url, logStore }: RouteContext): Promise<Response> {
  const rangeParam = url.searchParams.get("range") ?? "all";
  const range = rangeParam === "today" || rangeParam === "1h" ? rangeParam : "all";
  return zipResponse(await logStore.exportSessionTurns(range), `sessions-${range}`);
}

async function handleLogsSystemDetail({ params, logStore }: RouteContext): Promise<Response> {
  const hash = params[0] ?? "";
  const rec = await logStore.getSystemPrompt(hash);
  return rec ? Response.json(rec) : Response.json({ error: "not found" }, { status: 404 });
}

async function handleLogsSessionsList({ logStore }: RouteContext): Promise<Response> {
  return Response.json({ data: await logStore.listSessions() });
}

async function handleLogsSessionDetail({ params, logStore }: RouteContext): Promise<Response> {
  // Route-level allow-list (defense-in-depth before LogStore): the session
  // segment is strictly [A-Za-z0-9_-] (no dots -> no '..'); the turn segment
  // allows dots for the timestamped filename but still no slashes.
  const sessionOk = params[0] !== undefined && /^[a-zA-Z0-9_-]+$/.test(params[0]);
  const turnOk = params[1] === undefined || /^[a-zA-Z0-9._-]+$/.test(params[1]);
  if (!sessionOk || !turnOk) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  if (params.length === 1 && params[0]) {
    return Response.json({ data: await logStore.listTurns(params[0]) });
  }
  if (params.length === 2 && params[0] && params[1]) {
    const turn = await logStore.getTurn(params[0], params[1]);
    return turn ? Response.json(turn) : Response.json({ error: "not found" }, { status: 404 });
  }
  return Response.json({ error: "not found" }, { status: 404 });
}

function handleMessages({ config, catalogManager, tokenProvider, logStore, req }: RouteContext) {
  return dispatchMessages(config, catalogManager.current(), tokenProvider, logStore, req);
}

function handleCountTokens({ config, catalogManager, tokenProvider, req }: RouteContext) {
  return dispatchCountTokens(config, catalogManager.current(), tokenProvider, req);
}

function handleChatDispatch({
  config,
  catalogManager,
  tokenProvider,
  logStore,
  req,
}: RouteContext) {
  return dispatchChat(config, catalogManager.current(), tokenProvider, logStore, req);
}

function handleConfigGet({ config }: RouteContext): Response {
  // Resolved values for display/edit — safe only because this route requires
  // auth (an unauthenticated client is rejected before the handler runs).
  return Response.json(serializeConfig(config));
}

function handleConfigStatus({ config, catalogManager }: RouteContext): Response {
  const cat = catalogManager.current();
  // Join the catalog's per-source discovery outcomes so the status view shows
  // WHY a region/provider has no models (disabled / error / skipped), not just
  // that it doesn't.
  const sources = new Map(cat.sources.map((s) => [s.source, s]));
  const bedrockMode = resolveBedrockMode(config.providers.bedrock?.credential);
  const regions = config.regions.map((r) => {
    const models = cat.models.filter((m) => m.provider === "bedrock" && m.regionKey === r.key);
    const src = sources.get(`bedrock:${r.key}`);
    return {
      key: r.key,
      awsRegion: r.awsRegion,
      active: models.length > 0,
      total: models.length,
      converse: models.filter((m) => m.backend === "converse").length,
      mantle: models.filter((m) => m.backend === "mantle").length,
      ...(!bedrockMode.enabled ? { disabled: true } : {}),
      ...(src?.detail ? { error: src.detail } : {}),
    };
  });
  const external = Object.entries(config.providers.external).map(([key, p]) => {
    const models = cat.models.filter((m) => m.provider === key);
    const src = sources.get(key);
    return {
      key,
      type: p.type,
      baseUrl: p.baseUrl,
      active: models.length > 0,
      total: models.length,
      state: (src?.state ?? "skipped") as "ok" | "error" | "skipped" | "disabled",
      ...(src?.detail ? { detail: src.detail } : {}),
    };
  });
  return Response.json({
    bedrock: bedrockMode.enabled
      ? { enabled: true }
      : { enabled: false, reason: bedrockMode.reason },
    regions,
    external,
    totalModels: cat.models.length,
  });
}

async function handleConfigSave({ req, reloadRuntime }: RouteContext): Promise<Response> {
  await reloadRuntime(await req.json());
  return Response.json({ ok: true, message: "Config saved and hot-reloaded." });
}

/**
 * The declarative route table. Order matters only for overlapping prefixes:
 * the more specific exact routes precede their prefix siblings (e.g.
 * `/api/logs/system` before `/api/logs/system/`). Auth gates are carried per
 * route so the table — not a mid-chain conditional — is the single source of
 * truth for which surfaces require the inbound key.
 *
 * Auth policy (DESIGN §8.1): the management/observability API endpoints
 * (`/api/config*`, `/api/logs/*`, `/api/chat`) require the inbound key. The
 * HTML shells (`/config`, `/logs`, `/chat`) stay public — they are static
 * markup carrying no secret; the browser attaches the key from session storage
 * on each fetch (a bearer header can't ride a top-level navigation, so gating
 * the page route would lock out the operator, including over a Docker LAN).
 * The inference endpoints self-authenticate inside their dispatchers.
 */
const ROUTES: Route[] = [
  // Connection-warming probe (DESIGN §9.4).
  {
    method: "HEAD",
    name: "hello",
    match: exact("/api/hello"),
    requiresAuth: false,
    handler: () => new Response(null, { status: 204 }),
  },
  // Public registry / discovery surface.
  {
    method: "GET",
    name: "registry",
    match: exact("/", "/status"),
    requiresAuth: false,
    handler: handleRegistryPage,
  },
  {
    method: "GET",
    name: "status.json",
    match: exact("/status.json"),
    requiresAuth: false,
    handler: handleRegistryJson,
  },
  {
    method: "GET",
    name: "models",
    match: exact("/v1/models"),
    requiresAuth: false,
    handler: handleModelsList,
  },
  // Inference (dispatchers self-authenticate with the inbound key).
  {
    method: "POST",
    name: "messages",
    match: exact("/v1/messages"),
    requiresAuth: false,
    handler: handleMessages,
  },
  {
    method: "POST",
    name: "count_tokens",
    match: exact("/v1/messages/count_tokens"),
    requiresAuth: false,
    handler: handleCountTokens,
  },
  // Management HTML shells — public markup, no embedded secret.
  {
    method: "GET",
    name: "logs-page",
    match: exact("/logs"),
    requiresAuth: false,
    handler: ({ config }) =>
      new Response(renderLogViewerHtml(config.chatPage.enabled), { headers: htmlHeaders }),
  },
  {
    method: "GET",
    name: "config-page",
    match: exact("/config"),
    requiresAuth: false,
    handler: ({ config }) =>
      new Response(renderConfigPageHtml(config.chatPage.enabled), { headers: htmlHeaders }),
  },
  // Log observability API — gated.
  {
    method: "GET",
    name: "logs-system",
    match: exact("/api/logs/system"),
    requiresAuth: true,
    handler: handleLogsSystemList,
  },
  {
    method: "GET",
    name: "logs-export-system",
    match: exact("/api/logs/export/system"),
    requiresAuth: true,
    handler: handleLogsExportSystem,
  },
  {
    method: "GET",
    name: "logs-export-sessions",
    match: exact("/api/logs/export/sessions"),
    requiresAuth: true,
    handler: handleLogsExportSessions,
  },
  {
    method: "GET",
    name: "logs-system-detail",
    match: prefix("/api/logs/system/"),
    requiresAuth: true,
    handler: handleLogsSystemDetail,
  },
  {
    method: "GET",
    name: "logs-sessions",
    match: exact("/api/logs/sessions"),
    requiresAuth: true,
    handler: handleLogsSessionsList,
  },
  {
    method: "GET",
    name: "logs-session-detail",
    match: prefix("/api/logs/sessions/"),
    requiresAuth: true,
    handler: handleLogsSessionDetail,
  },
  // Config management API — gated.
  {
    method: "GET",
    name: "config-get",
    match: exact("/api/config"),
    requiresAuth: true,
    handler: handleConfigGet,
  },
  {
    method: "GET",
    name: "config-status",
    match: exact("/api/config/status"),
    requiresAuth: true,
    handler: handleConfigStatus,
  },
  {
    method: "POST",
    name: "config-save",
    match: exact("/api/config"),
    requiresAuth: true,
    requiresCsrf: true,
    handler: handleConfigSave,
  },
  {
    method: "GET",
    name: "config-auth",
    match: exact("/api/config/auth"),
    requiresAuth: true,
    handler: ({ config }) => describeAuth(config),
  },
  // Chat test API — gated (dispatcher also enforces config.chatPage.enabled).
  // CSRF-gated like config-save: it runs real server-side-credentialed
  // inference, so a same-origin-ish page must not be able to drive it.
  {
    method: "POST",
    name: "chat",
    match: exact("/api/chat"),
    requiresAuth: true,
    requiresCsrf: true,
    handler: handleChatDispatch,
  },
];

/**
 * Build the HTTP request handler. Extracted from `main()` so routing (and its
 * auth gates) is unit-testable without `Bun.serve` or live discovery: a test
 * can construct a Runtime with a stub catalog and drive plain `Request`s
 * through the returned handler.
 *
 * @param getRuntime  reads the live runtime (swapped atomically on hot-reload)
 * @param reloadRuntime validates + persists + hot-reloads a posted config
 */
export function createFetchHandler(
  getRuntime: () => Runtime,
  reloadRuntime: (rawConfig: unknown) => Promise<void>,
): (req: Request) => Promise<Response> {
  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;
    const method = req.method.toUpperCase();
    const requestId = newRequestId();
    const startedAt = Date.now();
    logger.debug("request received", { requestId, method, path: pathname });

    try {
      const runtime = getRuntime(); // live reference (swapped on reload)
      // The chat page is opt-in; register its shell route only when enabled so
      // a disabled deployment returns 404 (the /api/chat dispatcher likewise
      // enforces the flag). Kept out of the static table to avoid a stale flag.
      const chatPageRoute: Route | undefined = runtime.config.chatPage.enabled
        ? {
            method: "GET",
            name: "chat-page",
            match: exact("/chat"),
            requiresAuth: false,
            handler: () => new Response(renderChatPageHtml(), { headers: htmlHeaders }),
          }
        : undefined;

      let matched: { route: Route; params: string[] } | undefined;
      for (const route of chatPageRoute ? [...ROUTES, chatPageRoute] : ROUTES) {
        if (route.method !== method) continue;
        const params = route.match(pathname);
        if (params !== null) {
          matched = { route, params };
          break;
        }
      }

      let res: Response;
      if (!matched) {
        res = notFound();
      } else {
        if (matched.route.requiresAuth) {
          authenticateManagement(req, runtime.config);
        }
        if (matched.route.requiresCsrf) {
          assertCsrf(req, url);
        }
        const ctx: RouteContext = {
          req,
          url,
          method,
          config: runtime.config,
          tokenProvider: runtime.tokenProvider,
          catalogManager: runtime.catalogManager,
          logStore: runtime.logStore,
          reloadRuntime,
          params: matched.params,
        };
        res = await matched.route.handler(ctx);
      }

      const isApi = pathname.startsWith("/v1/") || pathname.startsWith("/api/");
      logger[isApi ? "info" : "debug"]("request completed", {
        requestId,
        method,
        path: pathname,
        route: matched?.route.name,
        status: res.status,
        latencyMs: Date.now() - startedAt,
      });
      return res;
    } catch (err) {
      return errorResponse(err, { requestId, method, path: pathname });
    }
  };
}

async function main(): Promise<void> {
  const initialConfig: ProxyConfig = await loadConfig(CONFIG_PATH);
  const bedrockMode = resolveBedrockMode(initialConfig.providers.bedrock?.credential);
  if (bedrockMode.enabled) {
    console.log(
      `Discovering models across regions: ${initialConfig.regions.map((r) => r.awsRegion).join(", ")}…`,
    );
  } else {
    console.log(`Bedrock disabled (${bedrockMode.reason}); discovering external providers only…`);
  }
  // Single mutable reference, swapped atomically on reload (readers snapshot it).
  let runtime: Runtime = await buildRuntime(initialConfig);
  console.log(
    `Discovery complete: ${runtime.catalogManager.current().models.length} models loaded.`,
  );
  if (runtime.logStore.isEnabled()) {
    console.log(`Logging enabled: writing to ${runtime.config.logging.dir} (viewer at /logs).`);
  }

  const serializeReload = createSerializer();

  /**
   * Validate + hot-reload + persist a new config. Serialized so concurrent
   * POST /api/config calls apply in order (no interleave, no lost reload, no
   * leaked CatalogManager timer). Ordering matters: the new runtime is built
   * and validated BEFORE saveConfig, so a build failure never persists a broken
   * config that would brick the next boot. On success: swap the single runtime
   * reference atomically, then stop exactly the manager we replaced. Throws on
   * invalid config (leaving the running runtime untouched).
   */
  function reloadRuntime(rawConfig: unknown): Promise<void> {
    return serializeReload(async () => {
      const next = validateConfig(rawConfig);
      // Build + validate the runtime FIRST (may throw); only persist on success.
      const newRuntime = await buildRuntime(next);
      const previous = runtime;
      try {
        await saveConfig(CONFIG_PATH, next);
      } catch (err) {
        // Persist failed: discard the just-built runtime (stop its timer) and
        // keep the running one untouched.
        newRuntime.catalogManager.stop();
        throw err;
      }
      runtime = newRuntime; // atomic single-reference swap
      previous.catalogManager.stop(); // stop exactly the replaced manager
      previous.logStore.stop(); // symmetric lifecycle: stop the replaced store too
      console.log(
        `Config hot-reloaded: ${runtime.catalogManager.current().models.length} models across ${runtime.config.regions.map((r) => r.awsRegion).join(", ")}.`,
      );
    });
  }

  const handler = createFetchHandler(() => runtime, reloadRuntime);
  // Bind host: explicit HOST env (LAN ${BIND_IP} in local mode / compose in
  // Docker) wins; otherwise the validated config's server.host; else loopback.
  const host = HOST_ENV ?? runtime.config.server.host ?? "127.0.0.1";
  const server = Bun.serve({
    hostname: host,
    port: PORT,
    fetch: handler,
  });

  console.log(
    `claude-code-provider-proxy listening on http://${server.hostname}:${server.port} (registry at /)`,
  );
}

// Only auto-start when run directly (e.g. `bun src/server.ts`), not when the
// module is imported by a test that drives createFetchHandler in-process.
if (import.meta.main) {
  main().catch((err) => {
    // Log the full error (stack + cause), not just the message.
    logger.error("fatal startup error", { message: errorMessage(err) });
    console.error(err);
    process.exit(1);
  });
}
