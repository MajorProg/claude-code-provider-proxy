/**
 * SQLite turn index (bun:sqlite) for the turn-logging subsystem.
 *
 * This is the writer-side index store: it replaces the old per-session
 * `_summary.json` rewrite (O(N) bytes per turn, O(N²) per session) with a real
 * SQLite database at `<logging.dir>/index.db`. Metadata is tiny (a ~350-byte row
 * per turn) and batched into ONE transaction per call, so the hot path is a
 * single commit rather than a whole-file rewrite.
 *
 * Design constraints baked in here (do NOT re-litigate in a later patch):
 *   - `journal_mode = DELETE`, NOT WAL: the DB lives on a Docker bind mount where
 *     WAL's shared-memory coordination is both unsafe and slow.
 *   - bun:sqlite is SYNCHRONOUS and blocks the event loop for 100% of wall time,
 *     so the request path must never touch this class. The caller owns threading
 *     (a Worker in production, inline in tests); this class deliberately does NOT
 *     spawn a Worker and keeps the synchronous bun:sqlite API contained inside
 *     its own methods.
 *   - Big payloads never live here; only the small metadata rows do, and a turn's
 *     body is a separate zstd file referenced by `turns.body_file`.
 *
 * Durable-metadata guarantee: if a batch write throws, the rows are spooled to
 * `<logging.dir>/index-spool.jsonl` (one JSON line per failed batch) and the call
 * returns WITHOUT throwing — the client response must never be affected by an
 * index-write failure. `replaySpool()` runs automatically on the next open and
 * re-applies any surviving entries, so metadata is never silently lost.
 *
 * No side effects or file access happen at import time; everything happens in
 * the constructor (which opens the database) or in explicit method calls.
 */

import { Database } from "bun:sqlite";
import type { Statement } from "bun:sqlite";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  BODY_STATES,
  type BodyState,
  ERROR_CLASSES,
  type ErrorClass,
  type FailoverEvent,
  type PromptVersionRecord,
  type PromptVersionStats,
  type SessionSummary,
  type ToolCallShape,
  type TurnMeta,
} from "./log-types.ts";
import { errorMessage, logger } from "./logger.ts";

/** Default spool file name, resolved next to the index database. */
const DEFAULT_SPOOL_NAME = "index-spool.jsonl";

/** SQLite `busy_timeout` default (ms) — bounded wait for a concurrent writer. */
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

/** SQLite page size default (bytes); must be a power of two in [512, 65536]. */
const DEFAULT_PAGE_SIZE = 4_096;

/** Milliseconds in a day, for retention cutoff math. */
const MS_PER_DAY = 86_400_000;

/* ------------------------------------------------------------------ *
 * Schema (fresh start — no migration of the pre-SQLite `_summary.json`
 * files; `body_state = 'pruned'` is the retention marker).
 * ------------------------------------------------------------------ */

const SCHEMA_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS turns (
     turn_id INTEGER PRIMARY KEY AUTOINCREMENT,
     session_id TEXT NOT NULL,
     seq INTEGER NOT NULL,
     requested_at TEXT NOT NULL,
     responded_at TEXT,
     model_requested TEXT,
     model_served TEXT,
     backend TEXT,
     path TEXT,
     prompt_version TEXT,
     stop_reason TEXT,
     input_tokens INTEGER,
     output_tokens INTEGER,
     cache_read_tokens INTEGER,
     latency_ms INTEGER,
     failover INTEGER,
     error_class TEXT,
     body_file TEXT,
     body_bytes INTEGER,
     body_state TEXT,
     tool_calls TEXT,
     subagent_of INTEGER,
     UNIQUE(session_id, seq)
   )`,
  `CREATE TABLE IF NOT EXISTS prompt_versions (
     hash TEXT PRIMARY KEY,
     created_at TEXT,
     last_seen TEXT,
     seen_count INTEGER,
     system_json TEXT,
     tools_json TEXT,
     injected_json TEXT,
     system_bytes INTEGER,
     tools_bytes INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS sessions (
     session_id TEXT PRIMARY KEY,
     first_seen TEXT,
     last_seen TEXT,
     turns INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS failover_events (
     event_id INTEGER PRIMARY KEY AUTOINCREMENT,
     turn_id INTEGER,
     from_label TEXT,
     to_label TEXT,
     reason TEXT
   )`,
  "CREATE INDEX IF NOT EXISTS idx_turns_session_seq ON turns(session_id, seq)",
  "CREATE INDEX IF NOT EXISTS idx_turns_requested_at ON turns(requested_at)",
  "CREATE INDEX IF NOT EXISTS idx_turns_prompt_version ON turns(prompt_version)",
  "CREATE INDEX IF NOT EXISTS idx_turns_model_served ON turns(model_served)",
];

/** Column list shared by the read queries, in `TurnDbRow` order. */
const TURN_COLUMNS = `turn_id, session_id, seq, requested_at, responded_at,
  model_requested, model_served, backend, path, prompt_version, stop_reason,
  input_tokens, output_tokens, cache_read_tokens, latency_ms, failover,
  error_class, body_file, body_bytes, body_state, tool_calls, subagent_of`;

const SQL_INSERT_TURN = `INSERT OR IGNORE INTO turns (
  session_id, seq, requested_at, responded_at, model_requested, model_served,
  backend, path, prompt_version, stop_reason, input_tokens, output_tokens,
  cache_read_tokens, latency_ms, failover, error_class, body_file, body_bytes,
  body_state, tool_calls, subagent_of
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const SQL_SELECT_TURN_ID = "SELECT turn_id FROM turns WHERE session_id = ? AND seq = ?";

const SQL_DELETE_FAILOVER = "DELETE FROM failover_events WHERE turn_id = ?";

const SQL_INSERT_FAILOVER = `INSERT INTO failover_events (turn_id, from_label, to_label, reason)
  VALUES (?, ?, ?, ?)`;

const SQL_UPSERT_PROMPT = `INSERT INTO prompt_versions (
  hash, created_at, last_seen, seen_count, system_json, tools_json, injected_json,
  system_bytes, tools_bytes
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(hash) DO UPDATE SET
  last_seen = excluded.last_seen,
  seen_count = excluded.seen_count,
  system_json = excluded.system_json,
  tools_json = excluded.tools_json,
  injected_json = excluded.injected_json,
  system_bytes = excluded.system_bytes,
  tools_bytes = excluded.tools_bytes`;

/**
 * Session rollup, DERIVED from the authoritative `turns` rows rather than
 * accumulated: this keeps `sessions` replay-safe and drift-free (re-running it
 * yields the same row), which plain increment-on-conflict could not.
 */
const SQL_UPSERT_SESSION = `INSERT INTO sessions (session_id, first_seen, last_seen, turns)
  SELECT session_id, MIN(requested_at), MAX(COALESCE(responded_at, requested_at)), COUNT(*)
  FROM turns WHERE session_id = ? GROUP BY session_id
  ON CONFLICT(session_id) DO UPDATE SET
    first_seen = excluded.first_seen,
    last_seen = excluded.last_seen,
    turns = excluded.turns`;

const SQL_LIST_SESSIONS = `SELECT s.session_id AS id, s.turns AS turnCount,
    COALESCE(SUM(t.input_tokens), 0) AS inputTokens,
    COALESCE(SUM(t.output_tokens), 0) AS outputTokens,
    s.first_seen AS firstAt, s.last_seen AS lastAt
  FROM sessions s
  LEFT JOIN turns t ON t.session_id = s.session_id
  GROUP BY s.session_id
  ORDER BY s.last_seen DESC, s.session_id ASC`;

const SQL_GET_TURN = `SELECT ${TURN_COLUMNS} FROM turns WHERE session_id = ? AND seq = ?`;

const SQL_LIST_PROMPT_VERSIONS = `SELECT hash, created_at, last_seen, seen_count,
    system_json, tools_json, injected_json, system_bytes, tools_bytes
  FROM prompt_versions ORDER BY last_seen DESC, hash ASC`;

const SQL_GET_PROMPT_VERSION = `SELECT hash, created_at, last_seen, seen_count,
    system_json, tools_json, injected_json, system_bytes, tools_bytes
  FROM prompt_versions WHERE hash = ?`;

const SQL_STATS_AGG = `SELECT COUNT(*) AS turns,
    COUNT(DISTINCT session_id) AS sessions,
    COALESCE(SUM(input_tokens), 0) AS inputTokens,
    COALESCE(SUM(output_tokens), 0) AS outputTokens,
    COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens,
    MIN(latency_ms) AS minMs, MAX(latency_ms) AS maxMs, AVG(latency_ms) AS avgMs
  FROM turns WHERE prompt_version = ?`;

const SQL_STATS_MODELS = `SELECT model_served AS m, COUNT(*) AS c
  FROM turns WHERE prompt_version = ? AND model_served IS NOT NULL
  GROUP BY model_served ORDER BY c DESC, m ASC`;

const SQL_STATS_STOP_REASONS = `SELECT stop_reason AS r, COUNT(*) AS c
  FROM turns WHERE prompt_version = ? AND stop_reason IS NOT NULL
  GROUP BY stop_reason ORDER BY c DESC, r ASC`;

const SQL_STATS_FAILURES = `SELECT error_class AS e, COUNT(*) AS c
  FROM turns WHERE prompt_version = ? AND error_class IS NOT NULL
  GROUP BY error_class ORDER BY c DESC, e ASC`;

/**
 * Ordered tool-call shape. `json_each` walks each turn's `tool_calls` array and
 * `COUNT(DISTINCT turn_id)` counts each tool ONCE PER TURN (a tool invoked twice
 * in one turn still counts as one), which is "how many captured turns invoked
 * it". `json_valid` guards a stray non-JSON value so the viewer never crashes.
 */
const SQL_STATS_TOOLS = `SELECT j.value AS tool, COUNT(DISTINCT t.turn_id) AS count
  FROM turns t, json_each(t.tool_calls) j
  WHERE t.prompt_version = ? AND t.tool_calls IS NOT NULL AND json_valid(t.tool_calls)
  GROUP BY j.value ORDER BY count DESC, tool ASC`;

const SQL_SELECT_PRUNABLE = `SELECT turn_id AS turnId, body_file AS bodyFile
  FROM turns
  WHERE body_file IS NOT NULL AND body_state IN ('full', 'truncated') AND requested_at < ?`;

const SQL_MARK_PRUNED = `UPDATE turns SET body_state = 'pruned' WHERE turn_id = ?`;

/* ------------------------------------------------------------------ *
 * Public input/result types
 * ------------------------------------------------------------------ */

/**
 * One `turns` row to insert. Mirrors the index columns; the writer builds it from
 * a {@link import("./log-types.ts").TurnRecord} plus the resolved body file. All
 * nullable columns may be omitted (normalized to NULL). `failoverEvents` are
 * written in the SAME transaction, keyed to the turn's assigned `turn_id`.
 */
export interface TurnRow {
  readonly sessionId: string;
  readonly seq: number;
  readonly requestedAt: string;
  readonly respondedAt?: string | null;
  readonly modelRequested?: string | null;
  readonly modelServed?: string | null;
  readonly backend?: string | null;
  readonly path?: string | null;
  readonly promptVersion?: string | null;
  readonly stopReason?: string | null;
  readonly inputTokens?: number | null;
  readonly outputTokens?: number | null;
  readonly cacheReadTokens?: number | null;
  readonly latencyMs?: number | null;
  readonly failover?: boolean;
  readonly errorClass?: ErrorClass | null;
  readonly bodyFile?: string | null;
  readonly bodyBytes?: number | null;
  readonly bodyState?: BodyState | null;
  readonly toolCalls?: readonly string[] | null;
  readonly subagentOf?: number | null;
  /** Credential-pool transitions observed while serving this turn. */
  readonly failoverEvents?: readonly FailoverEvent[];
}

/** Options for {@link IndexDb.listTurns}. */
export interface ListTurnsOptions {
  /** Max rows to return; omitted means no limit. */
  readonly limit?: number;
  /** Rows to skip; default 0. */
  readonly offset?: number;
  /** `seq` order; default `"asc"` (chronological). */
  readonly order?: "asc" | "desc";
}

/** Result of {@link IndexDb.pruneBodiesOlderThan}: the files the caller deletes. */
export interface PruneResult {
  /** `body_file` paths now marked `pruned`; the caller MUST delete each one. */
  readonly files: readonly string[];
  /** Number of index rows transitioned to `pruned` (== `files.length`). */
  readonly pruned: number;
}

/** Construction options for {@link IndexDb}. */
export interface IndexDbOptions {
  /** Spool path override; defaults to `index-spool.jsonl` beside the database. */
  readonly spoolPath?: string;
  /** SQLite `busy_timeout` (ms); default 5000. */
  readonly busyTimeoutMs?: number;
  /** SQLite `page_size` (bytes); default 4096. */
  readonly pageSize?: number;
}

/** Per-tool counts across a set of compared prompt versions (aligned to `hashes`). */
export interface ToolCallComparisonRow {
  readonly tool: string;
  /** Invocation counts, index-aligned to {@link PromptVersionComparison.hashes}. */
  readonly counts: readonly number[];
}

/** Cross-version comparison: per-version stats plus a tool-presence matrix. */
export interface PromptVersionComparison {
  readonly hashes: readonly string[];
  readonly versions: readonly PromptVersionStats[];
  /** Union of tools across all compared versions, ordered by total count desc. */
  readonly tools: readonly ToolCallComparisonRow[];
}

/* ------------------------------------------------------------------ *
 * Internal row shapes + coercion helpers
 * ------------------------------------------------------------------ */

interface TurnDbRow {
  turn_id: number;
  session_id: string;
  seq: number;
  requested_at: string;
  responded_at: string | null;
  model_requested: string | null;
  model_served: string | null;
  backend: string | null;
  path: string | null;
  prompt_version: string | null;
  stop_reason: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  latency_ms: number | null;
  failover: number;
  error_class: string | null;
  body_file: string | null;
  body_bytes: number | null;
  body_state: string | null;
  tool_calls: string | null;
  subagent_of: number | null;
}

interface PromptVersionDbRow {
  hash: string;
  created_at: string | null;
  last_seen: string | null;
  seen_count: number | null;
  system_json: string | null;
  tools_json: string | null;
  injected_json: string | null;
  system_bytes: number | null;
  tools_bytes: number | null;
}

interface SessionDbRow {
  id: string;
  turnCount: number;
  inputTokens: number;
  outputTokens: number;
  firstAt: string;
  lastAt: string;
}

interface StatsAggDbRow {
  turns: number;
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  minMs: number | null;
  maxMs: number | null;
  avgMs: number | null;
}

/** `body_state` value crossing the SQLite boundary, or null when unrecognized. */
function asBodyState(v: unknown): BodyState | null {
  if (typeof v !== "string") return null;
  return (BODY_STATES as readonly string[]).includes(v) ? (v as BodyState) : null;
}

/** `error_class` value crossing the SQLite boundary, or null when unrecognized. */
function asErrorClass(v: unknown): ErrorClass | null {
  if (typeof v !== "string") return null;
  return (ERROR_CLASSES as readonly string[]).includes(v) ? (v as ErrorClass) : null;
}

/** Parse the `tool_calls` JSON column to a string array, or null when absent. */
function asToolCalls(raw: string | null): string[] | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return null;
  }
}

/** Map a `turns` row to the public {@link TurnMeta} shape. */
function toTurnMeta(r: TurnDbRow): TurnMeta {
  return {
    turnId: r.turn_id,
    sessionId: r.session_id,
    seq: r.seq,
    requestedAt: r.requested_at,
    respondedAt: r.responded_at,
    modelRequested: r.model_requested,
    modelServed: r.model_served,
    backend: r.backend,
    path: r.path,
    promptVersion: r.prompt_version,
    stopReason: r.stop_reason,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheReadTokens: r.cache_read_tokens,
    latencyMs: r.latency_ms,
    failover: r.failover !== 0,
    errorClass: asErrorClass(r.error_class),
    bodyFile: r.body_file,
    bodyBytes: r.body_bytes,
    bodyState: asBodyState(r.body_state),
    toolCalls: asToolCalls(r.tool_calls),
    subagentOf: r.subagent_of,
  };
}

/** Map a `prompt_versions` row to the public {@link PromptVersionRecord} shape. */
function toPromptVersionRecord(r: PromptVersionDbRow): PromptVersionRecord {
  return {
    hash: r.hash,
    createdAt: r.created_at ?? "",
    lastSeen: r.last_seen ?? r.created_at ?? "",
    seenCount: r.seen_count ?? 0,
    systemJson: r.system_json ?? "",
    toolsJson: r.tools_json ?? "",
    injectedJson: r.injected_json ?? "",
    systemBytes: r.system_bytes ?? 0,
    toolsBytes: r.tools_bytes ?? 0,
  };
}

/* ------------------------------------------------------------------ *
 * Spool
 * ------------------------------------------------------------------ */

/** A deferred batch: the unit spooled on failure and replayed on next open. */
type SpoolEntry =
  | { readonly kind: "turns"; readonly rows: readonly TurnRow[] }
  | { readonly kind: "prompt_versions"; readonly records: readonly PromptVersionRecord[] }
  | { readonly kind: "sessions"; readonly sessionIds: readonly string[] };

/** Parse one spool line into a typed entry, or null when unusable. */
function parseSpoolEntry(raw: string): SpoolEntry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { kind, payload } = parsed as { kind?: unknown; payload?: unknown };
  if (!Array.isArray(payload)) return null;
  if (kind === "turns") return { kind, rows: payload as TurnRow[] };
  if (kind === "prompt_versions") return { kind, records: payload as PromptVersionRecord[] };
  if (kind === "sessions") return { kind, sessionIds: payload as string[] };
  return null;
}

/**
 * Serialize one spool entry to its on-disk line. The kind is lifted to the top
 * level and the batch array travels under a single `payload` key, so
 * {@link parseSpoolEntry} can read every kind uniformly.
 */
function serializeSpoolEntry(entry: SpoolEntry): string {
  const payload =
    entry.kind === "turns"
      ? entry.rows
      : entry.kind === "prompt_versions"
        ? entry.records
        : entry.sessionIds;
  return JSON.stringify({ kind: entry.kind, payload });
}

/* ------------------------------------------------------------------ *
 * IndexDb
 * ------------------------------------------------------------------ */

/**
 * The SQLite turn index. Open once per process/worker via the constructor (which
 * creates the schema and replays any spooled batches); all statements are cached.
 */
export class IndexDb {
  readonly #db: Database;
  readonly #spoolPath: string;
  readonly #opts: IndexDbOptions;
  readonly #cache = new Map<string, Statement>();
  #opened = false;
  #closed = false;

  /**
   * Open (creating if absent) the index at `indexPath`. Pass `":memory:"` for a
   * throwaway in-memory index (spooling is disabled in that case). File access
   * and the full schema setup happen here, never at import time.
   */
  constructor(indexPath: string, opts: IndexDbOptions = {}) {
    const memory = indexPath === "" || indexPath === ":memory:";
    if (!memory) mkdirSync(dirname(indexPath), { recursive: true });
    this.#db = new Database(indexPath);
    this.#opts = opts;
    this.#spoolPath =
      opts.spoolPath ?? (memory ? "" : join(dirname(indexPath), DEFAULT_SPOOL_NAME));
    this.open();
  }

  /**
   * Apply pragmas + schema and replay the spool. Idempotent; the constructor
   * calls it, so an explicit `open()` afterwards is a harmless no-op.
   */
  open(): void {
    if (this.#opened || this.#closed) return;
    this.#opened = true;
    this.#configure();
    for (const sql of SCHEMA_SQL) this.#db.run(sql);
    this.replaySpool();
  }

  /* ------------------------------- writes ------------------------------- */

  /**
   * Insert turn rows (plus their failover events) in ONE transaction, returning
   * the assigned `turn_id`s in input order. Idempotent per `(session_id, seq)`:
   * a re-insert of an existing turn is ignored and its id re-read. Never throws —
   * on any SQLite error the batch is spooled and `[]` is returned.
   */
  insertTurnRows(rows: readonly TurnRow[]): number[] {
    if (rows.length === 0) return [];
    try {
      return this.#insertTurns(rows);
    } catch (err) {
      this.#spool({ kind: "turns", rows }, err);
      return [];
    }
  }

  /**
   * Upsert prompt versions in ONE transaction. Each record is written to its
   * stated ABSOLUTE state (`created_at` is set once, on first insert, and
   * preserved thereafter). Callers should pre-aggregate per hash; a repeated hash
   * in one call simply leaves the last record's values. Never throws.
   */
  upsertPromptVersions(records: readonly PromptVersionRecord[]): void {
    if (records.length === 0) return;
    try {
      this.#upsertPromptVersions(records);
    } catch (err) {
      this.#spool({ kind: "prompt_versions", records }, err);
    }
  }

  /**
   * Refresh the `sessions` rollup for the given session ids (derived from their
   * `turns` rows) in ONE transaction. Never throws.
   */
  upsertSessions(sessionIds: readonly string[]): void {
    if (sessionIds.length === 0) return;
    try {
      this.#upsertSessions(sessionIds);
    } catch (err) {
      this.#spool({ kind: "sessions", sessionIds }, err);
    }
  }

  /* -------------------------------- reads ------------------------------- */

  /** All sessions, newest activity first. */
  listSessions(): SessionSummary[] {
    const rows = this.#prep(SQL_LIST_SESSIONS).all() as SessionDbRow[];
    return rows.map((r) => ({
      id: r.id,
      turnCount: r.turnCount,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      firstAt: r.firstAt,
      lastAt: r.lastAt,
    }));
  }

  /** Turn metadata for one session, `seq`-ascending unless `opts.order` says otherwise. */
  listTurns(sessionId: string, opts: ListTurnsOptions = {}): TurnMeta[] {
    const direction = opts.order === "desc" ? "DESC" : "ASC";
    const limit = opts.limit ?? -1;
    const offset = opts.offset ?? 0;
    const sql = `SELECT ${TURN_COLUMNS} FROM turns
      WHERE session_id = ? ORDER BY seq ${direction} LIMIT ? OFFSET ?`;
    const rows = this.#prep(sql).all(sessionId, limit, offset) as TurnDbRow[];
    return rows.map(toTurnMeta);
  }

  /** One turn by `(sessionId, seq)`, or null when absent. */
  getTurn(sessionId: string, seq: number): TurnMeta | null {
    const row = this.#prep(SQL_GET_TURN).get(sessionId, seq) as TurnDbRow | null;
    return row ? toTurnMeta(row) : null;
  }

  /** All prompt versions, most recently seen first. */
  listPromptVersions(): PromptVersionRecord[] {
    const rows = this.#prep(SQL_LIST_PROMPT_VERSIONS).all() as PromptVersionDbRow[];
    return rows.map(toPromptVersionRecord);
  }

  /** One prompt version by hash, or null when absent. */
  getPromptVersion(hash: string): PromptVersionRecord | null {
    const row = this.#prep(SQL_GET_PROMPT_VERSION).get(hash) as PromptVersionDbRow | null;
    return row ? toPromptVersionRecord(row) : null;
  }

  /**
   * Aggregates for one prompt version: turn/session counts, token sums, latency,
   * `stop_reason` and `error_class` histograms, served models and the ordered
   * tool-call shape. A hash with no turns yields a zeroed record.
   */
  statsForPromptVersion(hash: string): PromptVersionStats {
    const agg = this.#prep(SQL_STATS_AGG).get(hash) as StatsAggDbRow | null;
    const modelsServed = (this.#prep(SQL_STATS_MODELS).all(hash) as { m: string }[]).map(
      (r) => r.m,
    );
    const stopReasons: Record<string, number> = {};
    for (const r of this.#prep(SQL_STATS_STOP_REASONS).all(hash) as { r: string; c: number }[]) {
      stopReasons[r.r] = r.c;
    }
    const failures: Partial<Record<ErrorClass, number>> = {};
    for (const r of this.#prep(SQL_STATS_FAILURES).all(hash) as { e: string; c: number }[]) {
      const cls = asErrorClass(r.e);
      if (cls) failures[cls] = r.c;
    }
    const toolCallShape: ToolCallShape[] = (
      this.#prep(SQL_STATS_TOOLS).all(hash) as { tool: string; count: number }[]
    ).map((r) => ({ tool: r.tool, count: r.count }));

    const minMs = agg?.minMs ?? null;
    const maxMs = agg?.maxMs ?? null;
    const avgMs = agg?.avgMs ?? null;
    return {
      hash,
      turns: agg?.turns ?? 0,
      sessions: agg?.sessions ?? 0,
      modelsServed,
      inputTokens: agg?.inputTokens ?? 0,
      outputTokens: agg?.outputTokens ?? 0,
      cacheReadTokens: agg?.cacheReadTokens ?? 0,
      latency: {
        minMs: minMs ?? 0,
        maxMs: maxMs ?? 0,
        avgMs: avgMs === null ? 0 : Math.round(avgMs),
      },
      stopReasons,
      failures,
      toolCallShape,
    };
  }

  /**
   * Cross-version comparison: per-version stats for each hash (in the given
   * order) plus a tool-presence matrix over the union of invoked tools, so the
   * orchestration analyst can see how a prompt change shifted the tool mix.
   */
  comparePromptVersions(hashes: readonly string[]): PromptVersionComparison {
    const versions = hashes.map((h) => this.statsForPromptVersion(h));
    const totals = new Map<string, number>();
    const perVersion = versions.map((stats) => {
      const counts = new Map<string, number>();
      for (const shape of stats.toolCallShape) {
        counts.set(shape.tool, shape.count);
        totals.set(shape.tool, (totals.get(shape.tool) ?? 0) + shape.count);
      }
      return counts;
    });
    const tools: ToolCallComparisonRow[] = [...totals.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .map(([tool]) => ({ tool, counts: perVersion.map((m) => m.get(tool) ?? 0) }));
    return { hashes: [...hashes], versions, tools };
  }

  /* ------------------------------ retention ----------------------------- */

  /**
   * Mark bodies older than `days` as `pruned`, returning the file paths the
   * caller must delete from disk. `days <= 0` keeps everything (retention off).
   * Already-shed/pruned rows are skipped; the index row survives regardless.
   */
  pruneBodiesOlderThan(days: number, now: Date = new Date()): PruneResult {
    if (!(days > 0)) return { files: [], pruned: 0 };
    const cutoff = new Date(now.getTime() - days * MS_PER_DAY).toISOString();
    return this.#transaction(() => {
      const rows = this.#prep(SQL_SELECT_PRUNABLE).all(cutoff) as {
        turnId: number;
        bodyFile: string;
      }[];
      const files: string[] = [];
      for (const r of rows) {
        this.#prep(SQL_MARK_PRUNED).run(r.turnId);
        files.push(r.bodyFile);
      }
      return { files, pruned: files.length };
    });
  }

  /* -------------------------------- spool ------------------------------- */

  /**
   * Re-apply spooled batches and clear the spool. Runs automatically from
   * {@link open}; also callable explicitly. Valid entries that still fail to
   * apply (e.g. the database is momentarily unavailable) are kept for the next
   * open; only irrecoverable, unparseable lines are dropped, and only loudly.
   */
  replaySpool(): void {
    if (this.#spoolPath === "" || !existsSync(this.#spoolPath)) return;
    let raw: string;
    try {
      raw = readFileSync(this.#spoolPath, "utf8");
    } catch (err) {
      logger.warn("logging index spool unreadable; deferring replay", {
        spool: this.#spoolPath,
        error: errorMessage(err),
      });
      return;
    }

    const pending: SpoolEntry[] = [];
    let dropped = 0;
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      const entry = parseSpoolEntry(trimmed);
      if (entry) pending.push(entry);
      else dropped++;
    }

    const failed: SpoolEntry[] = [];
    for (const entry of pending) {
      try {
        this.#applyEntry(entry);
      } catch (err) {
        failed.push(entry);
        logger.warn("logging index spool replay deferred a batch", {
          kind: entry.kind,
          error: errorMessage(err),
        });
      }
    }
    if (dropped > 0) {
      logger.warn("logging index spool dropped unparseable lines", {
        spool: this.#spoolPath,
        lines: dropped,
      });
    }
    if (failed.length === 0) {
      // The `sessions` rollup is DERIVED from the `turns` rows, but a batch whose
      // turn insert failed could still have landed a rollup computed without those
      // turns. Re-derive it for every session this replay just restored, so
      // `listSessions().turnCount` cannot under-count after a spill.
      const touched = new Set<string>();
      for (const entry of pending) {
        if (entry.kind !== "turns") continue;
        for (const row of entry.rows) touched.add(row.sessionId);
      }
      if (touched.size > 0) this.upsertSessions([...touched]);
      this.#clearSpool();
      if (pending.length > 0) {
        logger.info("logging index spool replayed", { batches: pending.length });
      }
    } else {
      this.#rewriteSpool(failed);
    }
  }

  /* -------------------------------- close ------------------------------- */

  /** Finalize every cached statement and close the database cleanly. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const stmt of this.#cache.values()) {
      try {
        stmt.finalize();
      } catch (err) {
        logger.warn("logging index statement finalize failed", { error: errorMessage(err) });
      }
    }
    this.#cache.clear();
    // Plain close() (sqlite3_close_v2): no throw-on-finalized semantics, and it is
    // a no-op if already closed.
    this.#db.close();
  }

  /* ------------------------------- private ------------------------------ */

  /** Set the pragmas that matter for this workload, in the required order. */
  #configure(): void {
    const busy = Math.max(0, Math.floor(this.#opts.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS));
    const pageSize = Math.max(0, Math.floor(this.#opts.pageSize ?? DEFAULT_PAGE_SIZE));
    // journal_mode must be set (and cannot change) outside a transaction; DELETE
    // is deliberate — WAL is unsafe and slow on the Docker bind mount.
    this.#db.run("PRAGMA journal_mode = DELETE");
    this.#db.run(`PRAGMA busy_timeout = ${busy}`);
    // FULL, not NORMAL: in rollback-journal mode NORMAL leaves the database file
    // unsynced after commit, so a power loss can corrupt it. Once retention prunes
    // old bodies the index is the ONLY surviving record of those turns, and commits
    // are batched to a few per second, so the extra fsyncs are cheap insurance.
    this.#db.run("PRAGMA synchronous = FULL");
    if (pageSize > 0) this.#db.run(`PRAGMA page_size = ${pageSize}`);
  }

  /** Insert turns + their failover events; throws on any SQLite error. */
  #insertTurns(rows: readonly TurnRow[]): number[] {
    return this.#transaction(() => {
      const ids: number[] = [];
      for (const row of rows) {
        this.#prep(SQL_INSERT_TURN).run(
          row.sessionId,
          row.seq,
          row.requestedAt,
          row.respondedAt ?? null,
          row.modelRequested ?? null,
          row.modelServed ?? null,
          row.backend ?? null,
          row.path ?? null,
          row.promptVersion ?? null,
          row.stopReason ?? null,
          row.inputTokens ?? null,
          row.outputTokens ?? null,
          row.cacheReadTokens ?? null,
          row.latencyMs ?? null,
          row.failover ? 1 : 0,
          row.errorClass ?? null,
          row.bodyFile ?? null,
          row.bodyBytes ?? null,
          row.bodyState ?? null,
          row.toolCalls != null ? JSON.stringify(row.toolCalls) : null,
          row.subagentOf ?? null,
        );
        const found = this.#prep(SQL_SELECT_TURN_ID).get(row.sessionId, row.seq) as {
          turn_id: number;
        } | null;
        const turnId = found?.turn_id ?? 0;
        ids.push(turnId);
        const events = row.failoverEvents;
        if (turnId > 0 && events && events.length > 0) {
          // Replace any prior rows for this turn so a spool replay is idempotent
          // rather than appending duplicates.
          this.#prep(SQL_DELETE_FAILOVER).run(turnId);
          for (const ev of events) {
            this.#prep(SQL_INSERT_FAILOVER).run(turnId, ev.fromLabel, ev.toLabel, ev.reason);
          }
        }
      }
      return ids;
    });
  }

  /** Upsert prompt versions; throws on any SQLite error. */
  #upsertPromptVersions(records: readonly PromptVersionRecord[]): void {
    this.#transaction(() => {
      for (const rec of records) {
        this.#prep(SQL_UPSERT_PROMPT).run(
          rec.hash,
          rec.createdAt,
          rec.lastSeen,
          rec.seenCount,
          rec.systemJson,
          rec.toolsJson,
          rec.injectedJson,
          rec.systemBytes,
          rec.toolsBytes,
        );
      }
    });
  }

  /** Refresh the sessions rollup; throws on any SQLite error. */
  #upsertSessions(sessionIds: readonly string[]): void {
    this.#transaction(() => {
      for (const sid of sessionIds) this.#prep(SQL_UPSERT_SESSION).run(sid);
    });
  }

  /** Re-apply one spooled batch via the throwing private paths. */
  #applyEntry(entry: SpoolEntry): void {
    switch (entry.kind) {
      case "turns":
        this.#insertTurns(entry.rows);
        break;
      case "prompt_versions":
        this.#upsertPromptVersions(entry.records);
        break;
      case "sessions":
        this.#upsertSessions(entry.sessionIds);
        break;
    }
  }

  /**
   * Run `fn` inside one BEGIN..COMMIT, rolling back on any throw. BEGIN/COMMIT
   * are themselves cached prepared statements so the hot path does not re-prepare
   * them on every batch.
   */
  #transaction<T>(fn: () => T): T {
    this.#prep("BEGIN").run();
    try {
      const out = fn();
      this.#prep("COMMIT").run();
      return out;
    } catch (err) {
      try {
        this.#prep("ROLLBACK").run();
      } catch {
        // Already rolled back or no active transaction — the original error wins.
      }
      throw err;
    }
  }

  /** Append a failed batch to the spool; never throws (logs loudly if it cannot). */
  #spool(entry: SpoolEntry, err: unknown): void {
    if (this.#spoolPath === "") {
      logger.error("logging index write failed (no spool: in-memory index)", {
        kind: entry.kind,
        error: errorMessage(err),
      });
      return;
    }
    try {
      mkdirSync(dirname(this.#spoolPath), { recursive: true });
      appendFileSync(this.#spoolPath, `${serializeSpoolEntry(entry)}\n`);
      logger.error("logging index write failed; spooled batch for replay", {
        kind: entry.kind,
        error: errorMessage(err),
      });
    } catch (spoolErr) {
      logger.error("logging index write AND spool append failed; metadata lost", {
        kind: entry.kind,
        error: errorMessage(err),
        spoolError: errorMessage(spoolErr),
      });
    }
  }

  /** Delete the spool file once every entry has been applied. Never throws. */
  #clearSpool(): void {
    if (this.#spoolPath === "") return;
    try {
      rmSync(this.#spoolPath, { force: true });
    } catch (err) {
      logger.warn("logging index spool clear failed", {
        spool: this.#spoolPath,
        error: errorMessage(err),
      });
    }
  }

  /** Atomically rewrite the spool with only the still-pending entries. Never throws. */
  #rewriteSpool(entries: readonly SpoolEntry[]): void {
    if (this.#spoolPath === "") return;
    try {
      const tmp = `${this.#spoolPath}.tmp`;
      const body = entries.map((e) => serializeSpoolEntry(e)).join("\n");
      writeFileSync(tmp, entries.length > 0 ? `${body}\n` : "");
      renameSync(tmp, this.#spoolPath);
    } catch (err) {
      // The original spool is left intact on any failure, so nothing is lost.
      logger.warn("logging index spool rewrite failed; spool left as-is", {
        spool: this.#spoolPath,
        error: errorMessage(err),
      });
    }
  }

  /** Compile-or-fetch a cached prepared statement. */
  #prep(sql: string): Statement {
    if (this.#closed) throw new Error("IndexDb is closed");
    const cached = this.#cache.get(sql);
    if (cached) return cached;
    const stmt = this.#db.prepare(sql);
    this.#cache.set(sql, stmt);
    return stmt;
  }
}
