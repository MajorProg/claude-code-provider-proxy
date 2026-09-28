/**
 * Config-gated request/response logging (system prompts + per-turn sessions).
 *
 * When enabled, captures:
 *   - System prompts, deduplicated by content hash, under `<dir>/<systemDir>/`.
 *   - One JSON file per conversation turn under
 *     `<dir>/<sessionDir>/<session-id>/`, containing the request messages, the
 *     inference output, token usage, stop reason, and timestamps.
 *   - A per-session summary index (`_summary.json` alongside the turn files)
 *     mirroring the listing metadata, so the log viewer scales to sessions
 *     with thousands of turns / GBs of payloads without reading them.
 *
 * All writes are best-effort and MUST NOT affect the proxy response path: a
 * logging failure is swallowed (logged to console) so inference is never broken.
 * When disabled, every method is a no-op.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import type { LoggingConfig } from "../config.ts";
import { errorMessage, logger } from "./logger.ts";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

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
  /**
   * LABEL of the credential-pool entry that served the turn (cost attribution,
   * VIRTUAL_MODELS.md). Optional: absent for bedrock targets and unlabeled
   * single-key providers; old records simply lack the field (read-side safe).
   */
  readonly servingKeyLabel?: string;
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

/* ---------------- summary index (scalable log listing) ---------------- */

/**
 * Per-session summary index filename. Lives inside the session dir next to the
 * turn files and holds the lightweight metadata the log viewer needs (model,
 * timestamps, token counts), so listing endpoints never have to read + parse
 * turn-file bodies (which contain full message payloads and can total many GB
 * across a long-lived deployment — reading them all per request OOMs).
 */
const SUMMARY_FILE = "_summary.json";

/** Turn basename for {@link SUMMARY_FILE} (filename without the extension). */
const SUMMARY_TURN = "_summary";

/**
 * Turn files are `<5-digit seq>-<stamp>.json` by construction (recordTurn),
 * optionally gzip-compressed to `…<stamp>.json.gz` by the background sweep.
 * Listing/enumeration matches this exact shape so the summary index (also a
 * `.json` file in the same dir) is never mistaken for a turn.
 */
const TURN_FILE_RE = /^\d{5}-.*\.json(\.gz)?$/;

/** Turn basename (filename without the `.json`/`.json.gz` extension). */
function turnBasename(f: string): string {
  return f.replace(/\.json(\.gz)?$/, "");
}

/** Background-compression sweep cadence. `unref()`'d; never blocks exit. */
const COMPRESS_TICK_MS = 30_000;
/** Per-sweep file/byte budgets: the initial backlog of a long-lived repo (tens
 *  of GB) is chewed through incrementally without hogging the disk. */
const COMPRESS_MAX_FILES_PER_SWEEP = 128;
const COMPRESS_MAX_BYTES_PER_SWEEP = 256 * 1024 * 1024;

/** Max turn files read concurrently while (re)building a session summary. */
const SCAN_CONCURRENCY = 8;
/** Max sessions summarized concurrently by listSessions (bounds peak memory
 *  during a first-listing backfill across many large sessions). */
const SESSION_CONCURRENCY = 4;

/**
 * Lightweight per-turn metadata mirrored into the session summary index —
 * exactly the fields listTurns exposes to the log viewer.
 */
export interface SessionTurnMeta {
  readonly turn: string;
  readonly model: string;
  readonly requestedAt: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly stopReason: string | null;
}

/** Shape of the `_summary.json` index file. */
interface SessionSummaryFile {
  /** Number of turn FILES on disk when the index was built. Distinct from
   *  `turns.length` when some files failed to parse (corrupt entries are
   *  skipped); comparing against a fresh readdir detects drift without
   *  forcing a rescan for unparseable-but-stable directories. */
  fileCount: number;
  /** Turn metadata in listing (filename) order. */
  turns: SessionTurnMeta[];
}

/** Run `fn` serialized per key (chained-promise mutex, same shape as the
 *  per-hash prompt lock): concurrent read-modify-writes of the same summary
 *  would lose appends. The lock entry is dropped once it is the tail so the
 *  map cannot grow without bound. */
async function runLocked<T>(
  locks: Map<string, Promise<void>>,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const result = prev.then(() => fn());
  const gate = result.then(
    () => undefined,
    () => undefined,
  );
  locks.set(key, gate);
  void gate.then(() => {
    if (locks.get(key) === gate) locks.delete(key);
  });
  return result;
}

/** Map with bounded concurrency, preserving input order in the result. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      const item = items[i];
      if (item === undefined) return;
      results[i] = await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

/** Extract the listing metadata from a parsed turn record. */
function turnMetaOf(file: string, rec: TurnRecord): SessionTurnMeta {
  return {
    turn: turnBasename(file),
    model: rec.canonicalModel,
    requestedAt: rec.requestedAt,
    inputTokens: rec.usage?.inputTokens ?? 0,
    outputTokens: rec.usage?.outputTokens ?? 0,
    stopReason: rec.stopReason ?? null,
  };
}

/** Validate a parsed `_summary.json` payload; null unless structurally sound. */
function parseSummaryFile(parsed: unknown): SessionSummaryFile | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const fileCount = (parsed as { fileCount?: unknown }).fileCount;
  const turns = (parsed as { turns?: unknown }).turns;
  if (typeof fileCount !== "number" || !Array.isArray(turns)) return null;
  const clean = turns.filter(
    (t): t is SessionTurnMeta =>
      typeof t === "object" && t !== null && typeof (t as SessionTurnMeta).turn === "string",
  );
  return { fileCount, turns: clean };
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
  /**
   * PC8 backstop (ms) on the streaming log-capture branch, from LoggingConfig.
   * The log branch is a follower (cancelled when the client branch ends); this
   * only caps a hung upstream whose client branch never ends.
   */
  readonly captureTimeoutMs: number;
  /** In-memory per-session sequence counters for stable turn ordering. */
  private readonly seq = new Map<string, number>();
  /** Per-system-prompt-hash write mutex: serializes read-modify-write of the
   *  dedup counter so concurrent identical prompts don't lose count updates. */
  private readonly promptLocks = new Map<string, Promise<void>>();
  /** Per-session-dir write mutex for the summary index: serializes
   *  read-modify-write so concurrent turn records don't lose appends. */
  private readonly summaryLocks = new Map<string, Promise<void>>();
  /** Set by stop() so a dropped store (e.g. on hot-reload) stops recording. */
  private stopped = false;
  /** Background compression (config-gated): min age + sweep timer + re-entry flag. */
  private readonly compressionMinAgeMs: number;
  private compressTimer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;

  /** Cap the in-memory seq map so a long-lived process with many distinct
   *  sessions cannot grow it without bound (LRU by insertion recency). */
  private static readonly MAX_SEQ_ENTRIES = 10_000;

  constructor(config: LoggingConfig) {
    this.enabled = config.enabled;
    this.systemPath = join(config.dir, config.systemDir);
    this.sessionPath = join(config.dir, config.sessionDir);
    this.captureTimeoutMs = config.captureTimeoutMs;
    this.compressionMinAgeMs = config.compression.minAgeMinutes * 60_000;
    if (config.enabled && config.compression.enabled) {
      this.compressTimer = setInterval(() => void this.tickCompress(), COMPRESS_TICK_MS);
      this.compressTimer.unref();
    }
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
    if (this.compressTimer !== null) {
      clearInterval(this.compressTimer);
      this.compressTimer = null;
    }
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
   * Atomically write text or (compressed) binary data: write to a unique temp
   * file then rename over the target (rename is atomic on the same
   * filesystem), so a crash mid-write can never leave a truncated/half-written
   * file for readers to trip over.
   */
  private async writeAtomic(file: string, data: string | Uint8Array | Buffer): Promise<void> {
    const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    // Normalize to a plain Uint8Array: Buffer's SharedArrayBuffer-typed backing
    // is not assignable to writeFile's ArrayBufferView in current @types/node.
    const payload = typeof data === "string" ? data : new Uint8Array(data);
    await writeFile(tmp, payload);
    await rename(tmp, file);
  }

  /**
   * Read a file into a Buffer, transparently decompressing gzip payloads
   * (`.gz` filenames). All turn-file reads go through here so compression is
   * invisible to every caller.
   */
  private async readBufferMaybeGz(file: string): Promise<Buffer> {
    const buf = await readFile(file);
    // new Uint8Array(buf) copies into a plain ArrayBuffer (the zlib InputType
    // rejects Buffer's SharedArrayBuffer-backed view) — negligible vs the
    // decompression itself, and keeps gzip off the event loop (thread pool).
    return file.endsWith(".gz") ? await gunzipAsync(new Uint8Array(buf)) : buf;
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
      const parsed = JSON.parse((await this.readBufferMaybeGz(file)).toString("utf-8")) as unknown;
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
    await runLocked(this.promptLocks, hash, () => this.writeSystemPrompt(hash, system));
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
      await this.writeAtomic(file, JSON.stringify(record, null, 2));
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
      await this.writeAtomic(file, JSON.stringify(turn, null, 2));
      await this.appendTurnSummary(dir, turnMetaOf(`${seqStr}-${stamp}.json`, turn));
    } catch (err) {
      // A dropped turn is data loss — surface at error level (with session id).
      logger.error("log-store failed to record turn", {
        session: turn.sessionId,
        message: errorMessage(err),
      });
    }
  }

  /**
   * Mirror one recorded turn into the session's `_summary.json` index (under
   * the per-session lock). Replaces an existing entry with the same turn name
   * (recordTurn retries / seq-collisions after a restart overwrite the turn
   * file, so the index must follow) or appends a new one. Only this method
   * and loadTurnSummaryUnlocked write the index in steady state, so listing
   * endpoints never need to touch turn-file bodies.
   */
  private async appendTurnSummary(dir: string, meta: SessionTurnMeta): Promise<void> {
    await runLocked(this.summaryLocks, dir, async () => {
      // Fast path: recordTurn wrote the turn file just before this call, so a
      // summary that is exactly one entry behind is in sync minus our write —
      // append without rescanning (steady state; keeps per-turn cost O(1)
      // instead of a full-directory read on a long-lived session).
      let turnFiles: string[] = [];
      try {
        turnFiles = (await readdir(dir)).filter((f) => TURN_FILE_RE.test(f));
      } catch {
        return; // unreadable dir: the turn-file write already failed loudly
      }
      const summaryFile = join(dir, SUMMARY_FILE);
      const existing = parseSummaryFile(await this.readJsonSafe<unknown>(summaryFile));
      if (
        existing &&
        existing.fileCount === turnFiles.length - 1 &&
        !existing.turns.some((t) => t.turn === meta.turn)
      ) {
        const summary: SessionSummaryFile = {
          fileCount: turnFiles.length,
          turns: [...existing.turns, meta],
        };
        await this.writeAtomic(summaryFile, JSON.stringify(summary, null, 2));
        return;
      }
      // Slow path (first turn of a session, retry with the same filename,
      // drift): rebuild from disk — the rebuild's readdir already includes the
      // new turn file, so the scan indexes it; replace-or-append defensively.
      const summary = await this.loadTurnSummaryUnlocked(dir);
      const idx = summary.turns.findIndex((t) => t.turn === meta.turn);
      if (idx >= 0) {
        summary.turns[idx] = meta;
      } else {
        summary.turns.push(meta);
        summary.fileCount += 1;
      }
      await this.writeAtomic(summaryFile, JSON.stringify(summary, null, 2));
    });
  }

  /**
   * Load (and if needed build) the session summary index. Steady state is one
   * readdir + one small-file read; a missing index (session recorded by a
   * pre-index build) or a file-count mismatch (crash between the turn-file
   * write and the index write) triggers a bounded-concurrency rebuild from the
   * turn files themselves, persisted so the scan happens at most once. A
   * corrupt-but-stable directory (unparseable turn files) does not loop: the
   * index records the file COUNT, so failed parses skip entries without
   * re-tripping the mismatch check.
   *
   * Callers must already hold the per-session summary lock (appendTurnSummary,
   * listTurns) — the recordTurn write path always does.
   */
  private async loadTurnSummaryUnlocked(dir: string): Promise<SessionSummaryFile> {
    let turnFiles: string[] = [];
    try {
      turnFiles = (await readdir(dir)).filter((f) => TURN_FILE_RE.test(f)).sort();
    } catch {
      return { fileCount: 0, turns: [] };
    }
    // A basename can exist in BOTH forms on disk: a recordTurn overwrite of an
    // already-compressed turn (seq re-use after a restart), or a crash between
    // the sweep's .gz rename and its .json unlink. The plain file is always
    // the newer write (and the .gz payload is byte-identical to the pre-rename
    // .json), so prefer it and drop the stale .gz — keeping both would inflate
    // the file count, re-trip the drift check on every listing, and surface
    // the turn twice.
    const byBasename = new Map<string, string>();
    for (const f of turnFiles) {
      const base = turnBasename(f);
      const prev = byBasename.get(base);
      if (prev === undefined) {
        byBasename.set(base, f);
        continue;
      }
      const jsonName = f.endsWith(".gz") ? prev : f;
      byBasename.set(base, jsonName);
      const staleGz = join(dir, f.endsWith(".gz") ? f : prev);
      try {
        await unlink(staleGz);
      } catch {
        // best-effort: a failed unlink only costs one extra rescan later
      }
    }
    const turnList = [...byBasename.values()].sort();
    const existing = parseSummaryFile(await this.readJsonSafe<unknown>(join(dir, SUMMARY_FILE)));
    if (existing && existing.fileCount === turnList.length) return existing;
    const metas = await mapLimit(turnList, SCAN_CONCURRENCY, async (f) => {
      const rec = await this.readJsonSafe<TurnRecord>(join(dir, f));
      return rec ? turnMetaOf(f, rec) : null;
    });
    const summary: SessionSummaryFile = {
      fileCount: turnList.length,
      turns: metas.filter((m): m is SessionTurnMeta => m !== null),
    };
    try {
      await this.writeAtomic(join(dir, SUMMARY_FILE), JSON.stringify(summary, null, 2));
    } catch (err) {
      // The in-memory result is still returned; only persistence failed —
      // the next listing rebuilds again (best-effort, like all log writes).
      logger.warn("log-store failed to persist session summary", {
        dir,
        message: errorMessage(err),
      });
    }
    return summary;
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

  /**
   * List sessions with aggregate stats. Served from per-session summary
   * indexes (one readdir + one small read per session), never from turn-file
   * bodies — reading every turn of every session (many GB in a long-lived
   * deployment) OOMs the process. Sessions are summarized with bounded
   * concurrency so even a first-listing backfill of many large sessions keeps
   * peak memory flat.
   */
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
    const perSession = await mapLimit(sessionDirs, SESSION_CONCURRENCY, async (id) => ({
      id,
      turns: await this.listTurns(id),
    }));
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

  /** List a session's turns (lightweight metadata), ordered by sequence.
   *  Served from the summary index; builds it on first access. */
  async listTurns(sessionId: string): Promise<SessionTurnMeta[]> {
    if (!this.enabled) return [];
    const dir = this.sessionDir(sessionId);
    const summary = await runLocked(this.summaryLocks, dir, () =>
      this.loadTurnSummaryUnlocked(dir),
    );
    return summary.turns;
  }

  /** Read one turn's full record (plain or background-compressed). */
  async getTurn(sessionId: string, turn: string): Promise<TurnRecord | null> {
    if (!this.enabled) return null;
    const dir = this.sessionDir(sessionId);
    if (turn === SUMMARY_TURN) return null;
    if (!/^[a-zA-Z0-9._-]+$/.test(turn)) return null;
    const plain = await this.readJsonSafe<TurnRecord>(join(dir, `${turn}.json`));
    if (plain !== null) return plain;
    return this.readJsonSafe<TurnRecord>(join(dir, `${turn}.json.gz`));
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
            .filter((f) => TURN_FILE_RE.test(f))
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
              // ZIP members always carry the plain `.json` name and
              // decompressed content, regardless of on-disk compression.
              return { name: `sessions/${sid}/${f.replace(/\.gz$/, "")}`, content };
            }),
        );
        return entries.filter((e): e is { name: string; content: string } => e !== null);
      }),
    );
    return perSession.flat();
  }

  /* ---------------- background compression ---------------- */

  /** Timer tick: skip when stopped or a previous sweep is still running. */
  private async tickCompress(): Promise<void> {
    if (this.stopped || this.sweeping) return;
    this.sweeping = true;
    try {
      const { files, bytes } = await this.sweepCompress();
      if (files > 0) logger.debug("log-store compressed turn files", { files, bytes });
    } catch (err) {
      // Best-effort like every log operation; the next tick retries.
      logger.warn("log-store compression sweep failed", { message: errorMessage(err) });
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * Compress plain turn files to `.json.gz`, oldest work first encountered,
   * within per-sweep file/byte budgets. Also eats the pre-compression backlog
   * of an existing logs dir incrementally (tens of GB across many ticks).
   * Each file is compressed under the per-session summary lock and atomically
   * (tmp+rename of the `.gz`, then unlink of the plain file), so a concurrent
   * listing or index rebuild never observes the both-forms intermediate state.
   */
  async sweepCompress(opts?: {
    minAgeMs?: number;
    maxFiles?: number;
    maxBytes?: number;
  }): Promise<{ files: number; bytes: number }> {
    const result = { files: 0, bytes: 0 };
    if (!this.enabled) return result;
    const minAgeMs = opts?.minAgeMs ?? this.compressionMinAgeMs;
    let filesLeft = opts?.maxFiles ?? COMPRESS_MAX_FILES_PER_SWEEP;
    let bytesLeft = opts?.maxBytes ?? COMPRESS_MAX_BYTES_PER_SWEEP;
    const cutoff = Date.now() - minAgeMs;
    let sessionDirs: string[];
    try {
      sessionDirs = await readdir(this.sessionPath);
    } catch {
      return result;
    }
    for (const sid of sessionDirs) {
      if (filesLeft <= 0 || bytesLeft <= 0) break;
      const dir = join(this.sessionPath, sid);
      let files: string[];
      try {
        files = await readdir(dir);
      } catch {
        continue; // not a session dir (or unreadable): skip, keep walking
      }
      for (const f of files) {
        if (filesLeft <= 0 || bytesLeft <= 0) break;
        if (!f.endsWith(".json") || !TURN_FILE_RE.test(f)) continue;
        const file = join(dir, f);
        let size = 0;
        try {
          const st = await stat(file);
          if (st.mtimeMs > cutoff) continue;
          size = st.size;
        } catch {
          continue;
        }
        // Lock on the resolved dir — the same key listTurns/appendTurnSummary
        // use — so compression serializes with listings and index writes.
        const ok = await runLocked(this.summaryLocks, resolve(dir), () =>
          this.compressTurnFile(dir, f),
        );
        if (ok) {
          result.files += 1;
          result.bytes += size;
          filesLeft -= 1;
          bytesLeft -= size;
        }
      }
    }
    return result;
  }

  /** Gzip one turn file in place: atomic `.gz` write, then unlink the plain
   *  file. Contents are byte-identical before/after, so any crash window (both
   *  forms on disk) is resolved losslessly by the listing's prefer-.json dedup. */
  private async compressTurnFile(dir: string, file: string): Promise<boolean> {
    const plain = join(dir, file);
    try {
      const buf = await readFile(plain);
      await this.writeAtomic(`${plain}.gz`, await gzipAsync(new Uint8Array(buf)));
      await unlink(plain);
      return true;
    } catch (err) {
      logger.warn("log-store failed to compress turn file", {
        file: plain,
        message: errorMessage(err),
      });
      return false;
    }
  }

  /** Read a file to a string (gzip-transparent), logging (not throwing) on
   *  non-ENOENT failure. */
  private async readTextSafe(file: string): Promise<string | null> {
    try {
      return (await this.readBufferMaybeGz(file)).toString("utf-8");
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
