/**
 * Error taxonomy for the proxy (DESIGN §9.1).
 *
 * Upstream error bodies MUST be preserved unmodified where possible, because
 * Claude Code's automatic-retry logic matches on upstream error wording.
 */

/**
 * The Anthropic-style error `type` string. Anthropic's error taxonomy plus the
 * proxy's own config error; a literal union so subclasses can't drift.
 */
export type ProxyErrorType =
  | "authentication_error"
  | "invalid_request_error"
  | "not_found_error"
  | "api_error"
  | "config_error";

/** Base class for all proxy-originated errors. */
export class ProxyError extends Error {
  readonly status: number;
  readonly type: ProxyErrorType;

  constructor(
    status: number,
    type: ProxyErrorType,
    message: string,
    options?: { cause?: unknown },
  ) {
    // Preserve the root-cause chain (Error.cause) so a rethrown ProxyError does
    // not sever the original stack — aids diagnosis in the top-level logger.
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.status = status;
    this.type = type;
  }

  /** Render as an Anthropic-style error body. */
  toAnthropicBody(): { type: "error"; error: { type: ProxyErrorType; message: string } } {
    return { type: "error", error: { type: this.type, message: this.message } };
  }
}

/** 401 — inbound credential missing or invalid (DESIGN §8.1). */
export class UnauthorizedError extends ProxyError {
  constructor(message = "Missing or invalid credentials") {
    super(401, "authentication_error", message);
  }
}

/** 400 — canonical model id could not be parsed (DESIGN §4). */
export class BadModelIdError extends ProxyError {
  constructor(id: string) {
    super(400, "invalid_request_error", `Invalid canonical model id: "${id}"`);
  }
}

/** 400 — request body invalid or unsupported. */
export class BadRequestError extends ProxyError {
  constructor(message: string) {
    super(400, "invalid_request_error", message);
  }
}

/** 413 — inbound request body exceeds the configured size limit (SEC-1). */
export class PayloadTooLargeError extends ProxyError {
  constructor(message: string) {
    super(413, "invalid_request_error", message);
  }
}

/** 404 — model not present in the discovered catalog for the target region. */
export class ModelNotFoundError extends ProxyError {
  constructor(message: string) {
    super(404, "not_found_error", message);
  }
}

/**
 * 404 — the request named a provider that is not configured. Distinct from
 * ModelNotFoundError so callers can branch on "unknown provider" vs "known
 * provider, unknown model".
 */
export class UnsupportedProviderError extends ProxyError {
  constructor(provider: string) {
    super(404, "not_found_error", `Unsupported provider "${provider}"`);
  }
}

/**
 * 404 — the request named a configured provider that is currently disabled
 * (no usable credential). Distinct from UnsupportedProviderError: "known
 * provider, not active" vs "unknown provider". The message carries the reason
 * (e.g. "credential is unset") so the operator can act on it.
 */
export class ProviderDisabledError extends ProxyError {
  constructor(provider: string, reason: string) {
    super(404, "not_found_error", `Provider "${provider}" is disabled: ${reason}`);
  }
}

/** 502 — the upstream provider returned an error we could not translate. */
export class UpstreamError extends ProxyError {
  /** Raw upstream body, preserved unmodified for relay (DESIGN §9.1). */
  readonly upstreamBody: string | undefined;
  /** Route/model context for logs (never rendered to the client body). */
  readonly context: Record<string, unknown> | undefined;

  constructor(
    status: number,
    message: string,
    options?: { upstreamBody?: string; context?: Record<string, unknown>; cause?: unknown },
  ) {
    super(status, "api_error", message, { cause: options?.cause });
    this.upstreamBody = options?.upstreamBody;
    this.context = options?.context;
  }
}

/** 500 — misconfiguration detected at startup or request time (DESIGN §10). */
export class ConfigError extends ProxyError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(500, "config_error", message, { cause: options?.cause });
  }
}

/**
 * Exhaustiveness guard for discriminated-union switches. When every case is
 * handled, TypeScript narrows the argument to `never`; if a new variant is
 * added without a case, this becomes a COMPILE error. At runtime (e.g. an
 * unexpected on-the-wire enum value the types didn't anticipate) it throws with
 * the offending value rather than silently falling through.
 */
export function assertNever(value: never, context?: string): never {
  const suffix = context ? ` (${context})` : "";
  throw new Error(`Unexpected value did not match any case${suffix}: ${JSON.stringify(value)}`);
}
