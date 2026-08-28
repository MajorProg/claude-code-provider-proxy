/**
 * Config-gated request/response logging (system prompts + per-turn sessions).
 *
 * When enabled, captures:
 *   - System prompts, deduplicated by content hash, under `<dir>/<systemDir>/`.
 *   - One JSON file per conversation turn under
 *     `<dir>/<sessionDir>/<session-id>/`, containing the request messages, the
 *     inference output, token usage, stop reason, and timestamps.
 *
 * All writes are best-effort and MUST NOT affect the proxy response path: a
 * logging failure is swallowed (logged to console) so inference is never broken.
 * When disabled, every method is a no-op.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { LoggingConfig } from "../config.ts";
import { errorMessage, logger } from "./logger.ts";

/** Token usage captured for a turn. */
export interface TurnUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** A single captured turn (request + response). */
export interface TurnRecord {
  readonly sessionId: string;
  readonly canonicalModel: string;
  readonly invocationModel: string;
  readonly backend: string;
  readonly translationPath: string;
  readonly streamed: boolean;
  /** sha256 hash of the system prompt used (or null if none). */
  readonly systemHash: string | null;
  /** Full Anthropic `messages` array as sent by the client. */
  readonly messages: unknown;
  /**
   * Tool-offer trace: custom tools forwarded and Anthropic server-tools dropped
   * on this path. Omitted when the request offered no tools.
   */
  readonly tools?: {
    readonly customTools: string[];
    readonly droppedServerTools: { name: string; type: string | undefined }[];
  };
  /** Assistant response: content blocks (text/tool_use) as Anthropic shape. */
  readonly responseContent: unknown;
  readonly stopReason: string | null;
  readonly usage: TurnUsage;
  readonly requestedAt: string;
  readonly respondedAt: string;
}

/** Metadata for a stored system prompt. */
export interface SystemPromptMeta {
  hash: string;
  preview: string;
  firstSeen: string;
  lastSeen: string;
  count: number;
}

/** Stored system prompt file shape. */
interface SystemPromptFile extends SystemPromptMeta {
  system: unknown;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Produce a short, single-line preview of arbitrary system content. */
function previewOf(system: unknown): string {
  const text =
    typeof system === "string"
      ? system
      : Array.isArray(system)
        ? system
            .map((b) =>
              b && typeof b === "object" && "text" in b
                ? String((b as { text: unknown }).text)
                : "",
            )
            .join(" ")
        : JSON.stringify(system);
  return text.replace(/\s+/g, " ").trim().slice(0, 160);
}

/**
 * Sanitize a session id for safe use as a directory name.
 *
 * The id originates from a client-controlled header (x-claude-code-session-id),
 * so it must never be usable for path traversal. `replace(/[^a-zA-Z0-9._-]/…)`
 * still permits '.', so ".." would survive and escape the log dir; reject any
 * cleaned value that is only dots (".", "..") — those map to "unknown".
 */
function safeSessionId(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (cleaned.length === 0 || cleaned === "." || cleaned === "..") return "unknown";
  return cleaned.slice(0, 128);
}

/**
 * Persists logs to disk. Constructed once at startup; a disabled instance is a
 * cheap no-op used everywhere so callers need no conditionals.
 */
export class LogStore {
  private readonly enabled: boolean;
  private readonly systemPath: string;
  private readonly sessionPath: string;
  /** In-memory per-session sequence counters for stable turn ordering. */
  private readonly seq = new Map<string, number>();
  /** Per-system-prompt-hash write mutex: serializes read-modify-write of the
   *  dedup counter so concurrent identical prompts don't lose count updates. */
  private readonly promptLocks = new Map<string, Promise<void>>();
  /** Set by stop() so a dropped store (e.g. on hot-reload) stops recording. */
  private stopped = false;

  /** Cap the in-memory seq map so a long-lived process with many distinct
   *  sessions cannot grow it without bound (LRU by insertion recency). */
  private static readonly MAX_SEQ_ENTRIES = 10_000;

  constructor(config: LoggingConfig) {
    this.enabled = config.enabled;
    this.systemPath = join(config.dir, config.systemDir);
    this.sessionPath = join(config.dir, config.sessionDir);
  }

  isEnabled(): boolean {
    return this.enabled && !this.stopped;
  }

  /**
   * One-time startup probe: ensure the log directory is writable. Catches a
   * common misconfiguration — a `logging.dir` pointing at a path that exists
   * only inside the container (e.g. an absolute `/app/logs`) while running in
   * local mode, which would otherwise fail silently per-turn with EROFS. Logs a
   * single actionable warning instead of one error per request. Non-fatal:
   * logging is best-effort, so a failed probe disables the store rather than
   * crashing the server.
   */
  async verifyWritable(): Promise<void> {
    if (!this.isEnabled()) return;
    try {
      await mkdir(this.systemPath, { recursive: true });
      await mkdir(this.sessionPath, { recursive: true });
    } catch (err) {
      // Disable recording (reuse the stopped flag; enabled is readonly).
      this.stopped = true;
      logger.warn(
        "log-store directory is not writable — turn/prompt capture is DISABLED. " +
          "Check `logging.dir` in your config (it must be writable in the current run mode; " +
          'use a relative path like "./logs" so it resolves under the project root locally ' +
          "and under /app in Docker).",
        { dir: this.systemPath, message: errorMessage(err) },
      );
    }
  }

  /**
   * Stop the store: after this, record* calls are no-ops. Called on hot-reload
   * before the runtime swaps in a replacement, mirroring CatalogManager.stop()
   * (the two had an asymmetric lifecycle — the log store was previously just
   * dropped). Idempotent. In-flight writes are allowed to settle.
   */
  stop(): void {
    this.stopped = true;
  }

  /**
   * Next sequence number for a session, with an LRU bound on the seq map.
   * Re-inserting on each access keeps the most-recently-used sessions; when the
   * map exceeds the cap, the oldest (first-inserted) entry is evicted. A missing
   * entry restarts at 1 — turn files also carry a timestamp, so a rare eviction
   * only affects the numeric prefix ordering of very old idle sessions.
   */
  private bumpSeq(sid: string): number {
    const n = (this.seq.get(sid) ?? 0) + 1;
    this.seq.delete(sid); // reinsert to move to the end (most-recent)
    this.seq.set(sid, n);
    if (this.seq.size > LogStore.MAX_SEQ_ENTRIES) {
      const oldest = this.seq.keys().next().value;
      if (oldest !== undefined) this.seq.delete(oldest);
    }
    return n;
  }

  /**
   * Resolve a session directory under sessionPath, asserting containment.
   * safeSessionId already strips separators and rejects '.'/'..', so this is
   * defense-in-depth: if the resolved path ever escapes sessionPath, treat it
   * as the "unknown" bucket rather than touching an out-of-tree path.
   */
  private sessionDir(sessionId: string): string {
    const sid = safeSessionId(sessionId);
    const base = resolve(this.sessionPath);
    const dir = resolve(base, sid);
    if (dir !== base && !dir.startsWith(base + sep)) {
      return resolve(base, "unknown");
    }
    return dir;
  }

  /**
   * Atomically write JSON: write to a unique temp file then rename over the
   * target (rename is atomic on the same filesystem), so a crash mid-write can
   * never leave a truncated/half-written JSON file for readers to trip over.
   */
  private async writeJsonAtomic(file: string, data: string): Promise<void> {
    const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, file);
  }

  /**
   * Read+parse a JSON file, returning null on any failure. A missing file
   * (ENOENT) is expected and silent; any other error (corrupt JSON, permission)
   * is logged so silent data loss becomes diagnosable (best-effort, never throws).
   *
   * A successfully-parsed but non-object payload (e.g. a hand-edited file that
   * became a bare string/number/array/null) is also skipped with a diagnostic,
   * so a corrupted record can't surface downstream as `undefined`/`NaN` field
   * access (all persisted records are JSON objects).
   */
  private async readJsonSafe<T>(file: string): Promise<T | null> {
    try {
      const parsed = JSON.parse(await readFile(file, "utf-8")) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        logger.warn("log-store skipping malformed file (not a JSON object)", { file });
        return null;
      }
      return parsed as T;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        logger.warn("log-store skipping unreadable file", { file, message: errorMessage(err) });
      }
      return null;
    }
  }

  /**
   * Hash and store a system prompt (deduplicated). Returns the hash, or null
   * when there is no system content or logging is disabled.
   *
   * The read-modify-write of the dedup record is serialized per hash via an
   * in-process promise mutex: two concurrent requests sharing a system prompt
   * would otherwise both read count:N and both write count:N+1 (lost update).
   */
  async recordSystemPrompt(system: unknown): Promise<string | null> {
    if (!this.isEnabled()) return null;
    if (system === undefined || system === null) return null;
    const serialized = JSON.stringify(system);
    if (serialized === '""' || serialized === "[]") return null;
    const hash = sha256Hex(serialized);

    const prev = this.promptLocks.get(hash) ?? Promise.resolve();
    const next = prev.then(() => this.writeSystemPrompt(hash, system));
    // Keep the chain alive but swallow settlement so one failure doesn't poison
    // the next writer; drop the entry once it's the tail (avoid unbounded map).
    const guarded = next.then(
      () => undefined,
      () => undefined,
    );
    this.promptLocks.set(hash, guarded);
    void guarded.then(() => {
      if (this.promptLocks.get(hash) === guarded) this.promptLocks.delete(hash);
    });
    await next;
    return hash;
  }

  /** Read-modify-write one system-prompt dedup record (serialized by caller). */
  private async writeSystemPrompt(hash: string, system: unknown): Promise<void> {
    try {
      await mkdir(this.systemPath, { recursive: true });
      const file = join(this.systemPath, `${hash}.json`);
      const now = new Date().toISOString();
      let existing: SystemPromptFile | undefined;
      try {
        existing = JSON.parse(await readFile(file, "utf-8")) as SystemPromptFile;
      } catch {
        existing = undefined;
      }
      const record: SystemPromptFile = existing
        ? { ...existing, lastSeen: now, count: existing.count + 1 }
        : {
            hash,
            preview: previewOf(system),
            firstSeen: now,
            lastSeen: now,
            count: 1,
            system,
          };
      await this.writeJsonAtomic(file, JSON.stringify(record, null, 2));
    } catch (err) {
      // A dropped system prompt is data loss — surface at error level.
      logger.error("log-store failed to record system prompt", { message: errorMessage(err) });
    }
  }

  /** Store a single turn as its own JSON file under the session directory. */
  async recordTurn(turn: TurnRecord): Promise<void> {
    if (!this.isEnabled()) return;
    try {
      const sid = safeSessionId(turn.sessionId);
      const dir = this.sessionDir(turn.sessionId);
      await mkdir(dir, { recursive: true });
      const seqStr = String(this.bumpSeq(sid)).padStart(5, "0");
      const stamp = turn.requestedAt.replace(/[:.]/g, "-");
      const file = join(dir, `${seqStr}-${stamp}.json`);
      await this.writeJsonAtomic(file, JSON.stringify(turn, null, 2));
    } catch (err) {
      // A dropped turn is data loss — surface at error level (with session id).
      logger.error("log-store failed to record turn", {
        session: turn.sessionId,
        message: errorMessage(err),
      });
    }
  }

  /* ---------------- read side (for the log viewer API) ---------------- */

  /** List stored system prompts (metadata only), newest last-seen first. */
  async listSystemPrompts(): Promise<SystemPromptMeta[]> {
    if (!this.enabled) return [];
    let files: string[];
    try {
      files = await readdir(this.systemPath);
    } catch {
      return [];
    }
    const records = await Promise.all(
      files
        .filter((f) => f.endsWith(".json"))
        .map((f) => this.readJsonSafe<SystemPromptFile>(join(this.systemPath, f))),
    );
    const out: SystemPromptMeta[] = [];
    for (const rec of records) {
      if (!rec) continue;
      out.push({
        hash: rec.hash,
        preview: rec.preview,
        firstSeen: rec.firstSeen,
        lastSeen: rec.lastSeen,
        count: rec.count,
      });
    }
    out.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
    return out;
  }

  /** Read one system prompt's full content by hash. */
  async getSystemPrompt(hash: string): Promise<SystemPromptFile | null> {
    if (!this.enabled) return null;
    if (!/^[a-f0-9]{64}$/.test(hash)) return null;
    return this.readJsonSafe<SystemPromptFile>(join(this.systemPath, `${hash}.json`));
  }

  /** List sessions with aggregate stats. */
  async listSessions(): Promise<
    {
      id: string;
      turnCount: number;
      inputTokens: number;
      outputTokens: number;
      firstAt: string;
      lastAt: string;
    }[]
  > {
    if (!this.enabled) return [];
    let sessionDirs: string[];
    try {
      sessionDirs = await readdir(this.sessionPath);
    } catch {
      return [];
    }
    const out: {
      id: string;
      turnCount: number;
      inputTokens: number;
      outputTokens: number;
      firstAt: string;
      lastAt: string;
    }[] = [];
    // Read every session's turns concurrently (was serial N+1).
    const perSession = await Promise.all(
      sessionDirs.map(async (id) => ({ id, turns: await this.listTurns(id) })),
    );
    for (const { id, turns } of perSession) {
      if (turns.length === 0) continue;
      let inputTokens = 0;
      let outputTokens = 0;
      for (const t of turns) {
        inputTokens += t.inputTokens;
        outputTokens += t.outputTokens;
      }
      out.push({
        id,
        turnCount: turns.length,
        inputTokens,
        outputTokens,
        firstAt: turns[0]?.requestedAt ?? "",
        lastAt: turns[turns.length - 1]?.requestedAt ?? "",
      });
    }
    out.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
    return out;
  }

  /** List a session's turns (lightweight metadata), ordered by sequence. */
  async listTurns(sessionId: string): Promise<
    {
      turn: string;
      model: string;
      requestedAt: string;
      inputTokens: number;
      outputTokens: number;
      stopReason: string | null;
    }[]
  > {
    if (!this.enabled) return [];
    const dir = this.sessionDir(sessionId);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      return [];
    }
    const turnFiles = files.filter((f) => f.endsWith(".json")).sort();
    const records = await Promise.all(
      turnFiles.map(async (f) => {
        const rec = await this.readJsonSafe<TurnRecord>(join(dir, f));
        return rec ? { file: f, rec } : null;
      }),
    );
    const out: {
      turn: string;
      model: string;
      requestedAt: string;
      inputTokens: number;
      outputTokens: number;
      stopReason: string | null;
    }[] = [];
    for (const entry of records) {
      if (!entry) continue;
      out.push({
        turn: entry.file.replace(/\.json$/, ""),
        model: entry.rec.canonicalModel,
        requestedAt: entry.rec.requestedAt,
        inputTokens: entry.rec.usage.inputTokens,
        outputTokens: entry.rec.usage.outputTokens,
        stopReason: entry.rec.stopReason,
      });
    }
    return out;
  }

  /** Read one turn's full record. */
  async getTurn(sessionId: string, turn: string): Promise<TurnRecord | null> {
    if (!this.enabled) return null;
    const dir = this.sessionDir(sessionId);
    if (!/^[a-zA-Z0-9._-]+$/.test(turn)) return null;
    return this.readJsonSafe<TurnRecord>(join(dir, `${turn}.json`));
  }

  /* ---------------- export (for ZIP download) ---------------- */

  /** All system prompt files as {name, content} for archiving. */
  async exportSystemPrompts(): Promise<{ name: string; content: string }[]> {
    if (!this.enabled) return [];
    let files: string[];
    try {
      files = await readdir(this.systemPath);
    } catch {
      return [];
    }
    const entries = await Promise.all(
      files
        .filter((f) => f.endsWith(".json"))
        .map(async (f) => {
          const content = await this.readTextSafe(join(this.systemPath, f));
          return content === null ? null : { name: `system/${f}`, content };
        }),
    );
    return entries.filter((e): e is { name: string; content: string } => e !== null);
  }

  /**
   * All session turn files as {name, content}, optionally filtered by the
   * turn's `requestedAt` timestamp: "all" | "today" | "1h".
   */
  async exportSessionTurns(
    range: "all" | "today" | "1h",
  ): Promise<{ name: string; content: string }[]> {
    if (!this.enabled) return [];
    const cutoff = this.rangeCutoff(range);
    let sessionDirs: string[];
    try {
      sessionDirs = await readdir(this.sessionPath);
    } catch {
      return [];
    }
    // Two-phase concurrent walk: read each session dir, then all its files.
    const perSession = await Promise.all(
      sessionDirs.map(async (sid) => {
        let files: string[];
        try {
          files = await readdir(join(this.sessionPath, sid));
        } catch {
          return [];
        }
        const entries = await Promise.all(
          files
            .filter((f) => f.endsWith(".json"))
            .map(async (f) => {
              const content = await this.readTextSafe(join(this.sessionPath, sid, f));
              if (content === null) return null;
              if (cutoff !== null) {
                // Only parse for the timestamp filter; a parse failure here is a
                // filtered-out record, not a hard error.
                let requestedAt: string | undefined;
                try {
                  requestedAt = (JSON.parse(content) as TurnRecord).requestedAt;
                } catch {
                  return null;
                }
                if (!requestedAt || Date.parse(requestedAt) < cutoff) return null;
              }
              return { name: `sessions/${sid}/${f}`, content };
            }),
        );
        return entries.filter((e): e is { name: string; content: string } => e !== null);
      }),
    );
    return perSession.flat();
  }

  /** Read a file to a string, logging (not throwing) on non-ENOENT failure. */
  private async readTextSafe(file: string): Promise<string | null> {
    try {
      return await readFile(file, "utf-8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        logger.warn("log-store skipping unreadable file", { file, message: errorMessage(err) });
      }
      return null;
    }
  }

  /** Compute a cutoff epoch-ms for a range filter, or null for "all". */
  private rangeCutoff(range: "all" | "today" | "1h"): number | null {
    if (range === "all") return null;
    if (range === "1h") return Date.now() - 60 * 60 * 1000;
    // "today": local midnight.
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
}
