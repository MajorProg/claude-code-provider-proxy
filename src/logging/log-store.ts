/**
 * Config-gated request/response logging — the request-path face of the turn log.
 *
 * This is the seam every caller uses (capture, the /api/logs routes, tests). It
 * is deliberately thin: the WRITE side is enqueue-only and the READ side is
 * served entirely from the SQLite index.
 *
 * Write path (recordTurn / recordSystemPrompt): NO compression, NO file write,
 * NO SQLite on the caller's thread — those are the exact costs the old per-turn
 * `_summary.json` rewrite paid on every request. Each call builds a small job and
 * hands it to a {@link TurnWriter}, which owns zstd compression, the per-turn
 * body file and the batched `index.db` commit. A WorkerWriter runs that work on
 * a dedicated thread (bun:sqlite is synchronous and would otherwise stall the
 * event loop); an InlineWriter runs it on the calling thread (tests / fallback).
 *
 * Read path (listSessions / listTurns / getTurn / listPromptVersions /
 * getPromptVersion / getPromptVersionMeta / statsForPromptVersion): served from
 * the index via this store's OWN read
 * connection, so reads never depend on, or block, the writer's thread. A turn's
 * body is a single zstd file, decompressed on read ({@link getTurnBody}).
 *
 * Prompt versions: the FULL instruction surface (system + tool schemas + injected
 * instruction envelopes) is fingerprinted as one unit by `prompt-surface.ts`. A
 * turn links to the version it ran under via `turn.promptSurface`; when a caller
 * predates that wiring it falls back to the system-only version recorded through
 * {@link recordSystemPrompt}. The fallback is honest — a system-only fingerprint,
 * never a names-only surface dressed up as the complete one.
 *
 * All storage is best-effort and MUST NOT affect the proxy response path: a
 * logging failure is swallowed (logged to console) so inference is never broken.
 * When disabled, every method is a no-op.
 */
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { LoggingConfig } from "../config.ts";
import { IndexDb, type ListTurnsOptions } from "./index-db.ts";
import type {
  PromptSurface,
  PromptVersionMeta,
  PromptVersionRecord,
  PromptVersionStats,
  SessionSummary,
  TurnMeta,
  TurnRecord,
  WriterConfig,
  WriterJob,
} from "./log-types.ts";
import { errorMessage, logger } from "./logger.ts";
import { computePromptSurface } from "./prompt-surface.ts";
import { type TurnWriter, type WriterMode, createWriter } from "./writer.ts";

/**
 * Re-export the turn record shape so this module stays a single import site for
 * the log subsystem (capture helpers and tests import `TurnRecord` from here).
 */
export type { TurnRecord } from "./log-types.ts";

/** Index database filename, resolved under `logging.dir`. */
const INDEX_FILE = "index.db";

/**
 * Bound on the in-memory per-session seq map (LRU by recency). A long-lived
 * process with many distinct sessions must not grow it without bound; only a
 * session this large has rolled off ever re-starts its numbering.
 */
const MAX_SEQ_ENTRIES = 100_000;

/**
 * Bound on the system-only prompt-surface cache used by the `recordSystemPrompt`
 * fallback. It bridges the (awaited) `recordSystemPrompt` -> `recordTurn` pair of
 * one live capture, so it only ever needs the in-flight working set.
 */
const MAX_SYSTEM_SURFACES = 512;

/**
 * Bun's synchronous zstd API. Present at runtime but absent from the pinned
 * `@types/bun`, so it is surfaced through a narrow typed view rather than a cast
 * at the call site. Only decompression is needed here — compression belongs to
 * the writer.
 */
interface ZstdApi {
  zstdDecompressSync(input: Uint8Array): Uint8Array;
}

const zstd = Bun as unknown as ZstdApi;

/** Options for {@link LogStore}. */
export interface LogStoreOptions {
  /**
   * Which writer implementation to run. `worker` (the default) keeps the
   * synchronous compression + SQLite work off the event loop in production;
   * `inline` runs it on the calling thread for deterministic tests / fallback.
   */
  readonly writerMode?: WriterMode;
}

/**
 * Persists logs to the index + compressed body files. Constructed once at
 * startup; a disabled instance is a cheap no-op used everywhere so callers need
 * no conditionals.
 */
export class LogStore {
  /** `logging.enabled`: a disabled store never opens the index or a writer. */
  private readonly enabled: boolean;
  /**
   * PC8 backstop (ms) on the streaming log-capture branch, from LoggingConfig.
   * The log branch is a follower (cancelled when the client branch ends); this
   * only caps a hung upstream whose client branch never ends.
   */
  readonly captureTimeoutMs: number;
  /** Per-turn body byte cap (exposed for the capture-layer body meter). */
  readonly maxTurnBytes: number;
  /** Global in-flight body byte budget (exposed for the capture-layer meter). */
  readonly inFlightBudgetBytes: number;

  /** Resolved writer configuration (the only storage knobs the writer needs). */
  private readonly writerConfig: WriterConfig;
  /** The enqueue target for turns; null when disabled. */
  private readonly writer: TurnWriter | null;
  /** This store's own read connection; null when disabled. */
  private readonly reader: IndexDb | null;

  /** In-memory per-session sequence counters for stable turn ordering. */
  private readonly seq = new Map<string, number>();
  /** System-only prompt surfaces, keyed by hash (the recordSystemPrompt fallback). */
  private readonly systemSurfaces = new Map<string, PromptSurface>();

  /** Set once the store is torn down (hot-reload) so record* calls short-circuit. */
  private stopRequested = false;
  /** Set once close() has completed; makes teardown idempotent. */
  private closed = false;

  constructor(config: LoggingConfig, opts: LogStoreOptions = {}) {
    this.enabled = config.enabled;
    this.captureTimeoutMs = config.captureTimeoutMs;
    this.maxTurnBytes = config.maxTurnBytes;
    this.inFlightBudgetBytes = config.inFlightBudgetBytes;
    this.writerConfig = {
      dir: config.dir,
      sessionDir: config.sessionDir,
      indexPath: join(config.dir, INDEX_FILE),
      retentionDays: config.retentionDays,
      maxTurnBytes: config.maxTurnBytes,
      inFlightBudgetBytes: config.inFlightBudgetBytes,
      indexFlushMs: config.indexFlushMs,
      zstdLevel: config.zstdLevel,
    };

    let reader: IndexDb | null = null;
    let writer: TurnWriter | null = null;
    if (config.enabled) {
      try {
        // Open the READ connection here so every read is independent of the
        // writer's thread. `spoolPath: ""` disables spooling AND replay on this
        // connection: the writer owns spool replay, the reader must not race it.
        reader = new IndexDb(this.writerConfig.indexPath, { spoolPath: "" });
        this.seedSeq(reader);
        writer = createWriter(this.writerConfig, opts.writerMode ?? "worker");
      } catch (err) {
        // Non-fatal, exactly like the old startup probe: a log dir that is not
        // writable (or an index that cannot open) DISABLES capture rather than
        // crashing the server.
        this.stopRequested = true;
        logger.warn(
          "log-store failed to initialize — turn/prompt capture is DISABLED. " +
            "Check `logging.dir` in your config (it must be writable in the current run mode; " +
            'use a relative path like "./logs" so it resolves under the project root locally ' +
            "and under /app in Docker).",
          { dir: config.dir, message: errorMessage(err) },
        );
      }
    }
    this.reader = reader;
    this.writer = writer;
  }

  /** Whether recording is active (config-enabled AND not stopped/closed). */
  isEnabled(): boolean {
    return this.enabled && !this.stopRequested && !this.closed;
  }

  /**
   * One-time startup probe: ensure the log directory is writable, with one
   * actionable warning rather than one error per request. Non-fatal — logging is
   * best-effort, so a failed probe disables the store rather than crashing.
   * (The index open in the constructor already covers the index path; this keeps
   * the historical directory probe and its message.)
   */
  async verifyWritable(): Promise<void> {
    if (!this.isEnabled()) return;
    try {
      await mkdir(this.writerConfig.dir, { recursive: true });
      await mkdir(join(this.writerConfig.dir, this.writerConfig.sessionDir), { recursive: true });
    } catch (err) {
      this.stopRequested = true;
      logger.warn(
        "log-store directory is not writable — turn/prompt capture is DISABLED. " +
          "Check `logging.dir` in your config (it must be writable in the current run mode; " +
          'use a relative path like "./logs" so it resolves under the project root locally ' +
          "and under /app in Docker).",
        { dir: this.writerConfig.dir, message: errorMessage(err) },
      );
    }
  }

  /**
   * Stop the store synchronously: after this, record* calls are no-ops. Called
   * on hot-reload before the runtime swaps in a replacement, mirroring
   * CatalogManager.stop(). Teardown (flush + close) proceeds in the background
   * via {@link close}; use `close` directly when the caller can await it.
   * Idempotent.
   */
  stop(): void {
    if (!this.enabled) return;
    this.stopRequested = true;
    void this.close();
  }

  /* ---------------- write side (enqueue-only) ---------------- */

  /**
   * Enqueue one captured turn. Pure request-path work: resolve the prompt
   * version, assign the session sequence, build the job and hand it to the
   * writer. NO compression, NO file write, NO SQLite happens here.
   */
  async recordTurn(turn: TurnRecord): Promise<void> {
    const writer = this.writer;
    if (!writer || !this.isEnabled()) return;
    try {
      const surface =
        turn.promptSurface ??
        (turn.systemHash !== null ? this.systemSurfaces.get(turn.systemHash) : undefined) ??
        null;
      const seq = this.bumpSeq(turn.sessionId);
      const withVersion: TurnRecord =
        surface !== null && turn.promptVersion === undefined
          ? { ...turn, promptVersion: surface.hash }
          : turn;
      const job: WriterJob = {
        turn: withVersion,
        seq,
        promptSurface: surface,
        bodyState: turn.bodyState ?? "full",
        failoverEvents: [],
      };
      writer.write(job);
    } catch (err) {
      // Enqueue is in-memory; a throw here is a bug, not I/O — still never fatal.
      logger.error("log-store failed to enqueue turn", {
        session: turn.sessionId,
        message: errorMessage(err),
      });
    }
  }

  /**
   * Record the SYSTEM portion of the instruction surface, deduplicated by its
   * system-only fingerprint. Enqueue-only: it computes the surface and remembers
   * it (bounded) so the following {@link recordTurn} for the same capture can link
   * to it, and returns the hash. This is the legacy fallback path for callers that
   * do not compute the full (system + tool-schema + injected) surface themselves.
   *
   * Returns null when logging is disabled or there is no system content.
   */
  async recordSystemPrompt(system: unknown): Promise<string | null> {
    if (!this.isEnabled()) return null;
    if (system === undefined || system === null) return null;
    const serialized = JSON.stringify(system);
    if (serialized === '""' || serialized === "[]") return null;
    // A system-only surface: tools and injected blocks are genuinely absent at
    // this call site, so the fingerprint records them as empty rather than
    // pretending a tool list was known.
    const surface = computePromptSurface({ system, tools: undefined, messages: undefined });
    this.rememberSystemSurface(surface);
    return surface.hash;
  }

  /**
   * Drain the writer's queue and commit the pending index batch (tests and
   * orderly shutdown). Resolves once every accepted job is durable.
   */
  async flush(): Promise<void> {
    await this.writer?.flush();
  }

  /**
   * Flush, then release the writer and the read connection. Idempotent.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.stopRequested = true;
    try {
      await this.writer?.flush();
      await this.writer?.close();
    } catch (err) {
      logger.warn("log-store failed to close writer", { message: errorMessage(err) });
    }
    try {
      this.reader?.close();
    } catch (err) {
      logger.warn("log-store failed to close index", { message: errorMessage(err) });
    }
    this.closed = true;
  }

  /* ---------------- read side (served from the index) ---------------- */

  /** List sessions with aggregate stats, newest activity first. */
  async listSessions(): Promise<SessionSummary[]> {
    const reader = this.reader;
    if (!reader || !this.enabled) return [];
    try {
      return reader.listSessions();
    } catch (err) {
      logger.warn("log-store failed to list sessions", { message: errorMessage(err) });
      return [];
    }
  }

  /** List a session's turns (lightweight metadata), ordered by `seq`. */
  async listTurns(sessionId: string, opts: ListTurnsOptions = {}): Promise<TurnMeta[]> {
    const reader = this.reader;
    if (!reader || !this.enabled) return [];
    try {
      return reader.listTurns(sessionId, opts);
    } catch (err) {
      logger.warn("log-store failed to list turns", {
        session: sessionId,
        message: errorMessage(err),
      });
      return [];
    }
  }

  /**
   * Read and decompress one turn's body (its self-contained turn record), keyed
   * by `(sessionId, seq)`. Returns null when the row is absent, its body was
   * shed/pruned, or the file cannot be read.
   */
  async getTurnBody(sessionId: string, seq: number): Promise<unknown | null> {
    const reader = this.reader;
    if (!reader || !this.enabled) return null;
    let meta: TurnMeta | null;
    try {
      meta = reader.getTurn(sessionId, seq);
    } catch (err) {
      logger.warn("log-store failed to read turn index row", {
        session: sessionId,
        seq,
        message: errorMessage(err),
      });
      return null;
    }
    if (!meta || !meta.bodyFile) return null;
    if (meta.bodyState === "shed" || meta.bodyState === "pruned") return null;
    const abs = this.bodyAbsolutePath(meta.bodyFile);
    if (abs === null) return null;
    try {
      const buf = await readFile(abs);
      const raw = zstd.zstdDecompressSync(new Uint8Array(buf));
      return JSON.parse(new TextDecoder().decode(raw)) as unknown;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        logger.warn("log-store failed to read turn body", {
          session: sessionId,
          seq,
          file: meta.bodyFile,
          message: errorMessage(err),
        });
      }
      return null;
    }
  }

  /**
   * Read one turn's index metadata by `(sessionId, seq)`, or null when absent.
   * Cheaper than {@link getTurnBody} when only the metadata row is needed.
   */
  async getTurn(sessionId: string, seq: number): Promise<TurnMeta | null> {
    const reader = this.reader;
    if (!reader || !this.enabled) return null;
    try {
      return reader.getTurn(sessionId, seq);
    } catch (err) {
      logger.warn("log-store failed to read turn", {
        session: sessionId,
        seq,
        message: errorMessage(err),
      });
      return null;
    }
  }

  /**
   * List stored prompt versions (METADATA ONLY), most recently seen first. The
   * content of each version is served by {@link getPromptVersion}, so listing N
   * versions does not deserialize N × ~244 KB of tool schemas.
   */
  async listPromptVersions(): Promise<PromptVersionMeta[]> {
    const reader = this.reader;
    if (!reader || !this.enabled) return [];
    try {
      return reader.listPromptVersions();
    } catch (err) {
      logger.warn("log-store failed to list prompt versions", { message: errorMessage(err) });
      return [];
    }
  }

  /** Read one prompt version's metadata (no content) by hash. */
  async getPromptVersionMeta(hash: string): Promise<PromptVersionMeta | null> {
    const reader = this.reader;
    if (!reader || !this.enabled) return null;
    try {
      return reader.getPromptVersionMeta(hash);
    } catch (err) {
      logger.warn("log-store failed to read prompt version metadata", {
        hash,
        message: errorMessage(err),
      });
      return null;
    }
  }

  /** Read one prompt version's full content by hash. */
  async getPromptVersion(hash: string): Promise<PromptVersionRecord | null> {
    const reader = this.reader;
    if (!reader || !this.enabled) return null;
    try {
      return reader.getPromptVersion(hash);
    } catch (err) {
      logger.warn("log-store failed to read prompt version", {
        hash,
        message: errorMessage(err),
      });
      return null;
    }
  }

  /**
   * Aggregates for one prompt version, including the ordered tool-call shape for
   * orchestration analysis. A hash with no turns (or a disabled store) yields a
   * zeroed record rather than null.
   */
  async statsForPromptVersion(hash: string): Promise<PromptVersionStats> {
    const reader = this.reader;
    if (!reader || !this.enabled) return emptyStats(hash);
    try {
      return reader.statsForPromptVersion(hash);
    } catch (err) {
      logger.warn("log-store failed to compute prompt-version stats", {
        hash,
        message: errorMessage(err),
      });
      return emptyStats(hash);
    }
  }

  /* ---------------- export (for the ZIP download routes) ---------------- */

  /**
   * Export session turn bodies as {name, content} for the ZIP download route,
   * optionally filtered by the turn's `requestedAt` ("all" | "today" | "1h").
   * Bodies are read from their zstd files and decompressed; a shed or pruned
   * body (no file on disk) is skipped rather than failing the export. A partial
   * export is returned if a later entry cannot be read.
   */
  async exportSessionTurns(
    range: "all" | "today" | "1h",
  ): Promise<{ name: string; content: string }[]> {
    const reader = this.reader;
    if (!reader || !this.enabled) return [];
    const cutoff = rangeCutoff(range);
    const out: { name: string; content: string }[] = [];
    try {
      for (const session of reader.listSessions()) {
        for (const turn of reader.listTurns(session.id)) {
          if (cutoff !== null && Date.parse(turn.requestedAt) < cutoff) continue;
          if (!turn.bodyFile) continue;
          if (turn.bodyState === "shed" || turn.bodyState === "pruned") continue;
          const abs = this.bodyAbsolutePath(turn.bodyFile);
          if (abs === null) continue;
          try {
            const buf = await readFile(abs);
            const raw = zstd.zstdDecompressSync(new Uint8Array(buf));
            out.push({
              name: turn.bodyFile.replace(/\.zst$/, ""),
              content: new TextDecoder().decode(raw),
            });
          } catch (err) {
            logger.warn("log-store failed to export turn body", {
              file: turn.bodyFile,
              message: errorMessage(err),
            });
          }
        }
      }
    } catch (err) {
      logger.warn("log-store failed to export session turns", { message: errorMessage(err) });
    }
    return out;
  }

  /* ---------------- private helpers ---------------- */

  /**
   * Seed per-session sequence counters from the index so a restarted (or
   * hot-reloaded) store does not re-issue `seq` values already committed — with
   * `UNIQUE(session_id, seq)` + INSERT OR IGNORE, a re-issued seq would be
   * silently dropped. The `sessions` rollup's `turns` count equals the highest
   * seq for a session (seq is assigned contiguously from 1), so one listing
   * query seeds every session at once.
   */
  private seedSeq(reader: IndexDb): void {
    try {
      for (const s of reader.listSessions()) {
        if (s.turnCount > 0) this.seq.set(s.id, s.turnCount);
      }
    } catch (err) {
      logger.warn("log-store failed to seed session sequences from the index", {
        message: errorMessage(err),
      });
    }
  }

  /**
   * Next sequence number for a session, with an LRU bound on the seq map.
   * Re-inserting on each access keeps the most-recently-used sessions; when the
   * map exceeds the cap, the oldest (first-inserted) entry is evicted. A missing
   * entry starts at 1 (seeded sessions above start from their committed max).
   */
  private bumpSeq(sid: string): number {
    const n = (this.seq.get(sid) ?? 0) + 1;
    this.seq.delete(sid); // reinsert to move to the end (most-recent)
    this.seq.set(sid, n);
    if (this.seq.size > MAX_SEQ_ENTRIES) {
      const oldest = this.seq.keys().next().value;
      if (oldest !== undefined) this.seq.delete(oldest);
    }
    return n;
  }

  /** Remember a system-only surface for the recordTurn fallback (bounded). */
  private rememberSystemSurface(surface: PromptSurface): void {
    this.systemSurfaces.delete(surface.hash);
    this.systemSurfaces.set(surface.hash, surface);
    if (this.systemSurfaces.size > MAX_SYSTEM_SURFACES) {
      const oldest = this.systemSurfaces.keys().next().value;
      if (oldest !== undefined) this.systemSurfaces.delete(oldest);
    }
  }

  /**
   * Resolve a stored `body_file` (relative to `logging.dir`) to an absolute path,
   * asserting containment so a hand-edited index cannot read outside the log dir.
   */
  private bodyAbsolutePath(rel: string): string | null {
    const base = resolve(this.writerConfig.dir);
    const abs = resolve(base, rel);
    if (abs !== base && !abs.startsWith(base + sep)) return null;
    return abs;
  }
}

/** Compute a cutoff epoch-ms for a range filter, or null for "all". */
function rangeCutoff(range: "all" | "today" | "1h"): number | null {
  if (range === "all") return null;
  if (range === "1h") return Date.now() - 60 * 60 * 1000;
  // "today": local midnight.
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** A zeroed {@link PromptVersionStats} for a hash with no rows (or disabled). */
function emptyStats(hash: string): PromptVersionStats {
  return {
    hash,
    turns: 0,
    sessions: 0,
    modelsServed: [],
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    latency: { minMs: 0, maxMs: 0, avgMs: 0 },
    stopReasons: {},
    failures: {},
    toolCallShape: [],
  };
}
