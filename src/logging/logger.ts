/**
 * Minimal leveled, structured logger (DESIGN §9 observability).
 *
 * No dependency; wraps console.* with a level gate and a compact structured
 * line. Level is read once from LOG_LEVEL env (debug|info|warn|error), default
 * "info". Fields are appended as ` key=value` pairs after the message.
 *
 * NEVER log secrets: callers pass identifiers (requestId, provider, model,
 * status, latencyMs), never credentials, tokens, headers, or request bodies.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function parseLevel(raw: string | undefined): LogLevel {
  const v = (raw ?? "").toLowerCase();
  if (v === "debug" || v === "info" || v === "warn" || v === "error") return v;
  return "info";
}

const activeLevel: LogLevel = parseLevel(Bun.env.LOG_LEVEL);

/** Structured fields to append to a log line (identifiers only — no secrets). */
export type LogFields = Record<string, string | number | boolean | undefined>;

function formatFields(fields?: LogFields): string {
  if (!fields) return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    // Quote values containing whitespace so the line stays parseable.
    const s = typeof v === "string" && /\s/.test(v) ? JSON.stringify(v) : String(v);
    parts.push(`${k}=${s}`);
  }
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

function emit(level: LogLevel, msg: string, fields?: LogFields): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[activeLevel]) return;
  const line = `[${level}] ${msg}${formatFields(fields)}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  level: activeLevel,
  debug: (msg: string, fields?: LogFields): void => emit("debug", msg, fields),
  info: (msg: string, fields?: LogFields): void => emit("info", msg, fields),
  warn: (msg: string, fields?: LogFields): void => emit("warn", msg, fields),
  error: (msg: string, fields?: LogFields): void => emit("error", msg, fields),
};

/** Safe error message extraction (never throws on non-Error values). */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Short correlation id for a request (8 hex chars). */
export function newRequestId(): string {
  return crypto.randomUUID().slice(0, 8);
}
