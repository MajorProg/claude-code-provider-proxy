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
import { createHash } from "node:crypto";
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
  type PromptPartRef,
  type PromptVersionMeta,
  type PromptVersionRecord,
  type PromptVersionStats,
  type PromptVersionWrite,
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
  // Content addressing for a prompt surface's three parts. `prompt_versions`
  // keeps its shape (metadata + the legacy inline JSON columns, which new writes
  // NULL out); the part STRINGS live here keyed by their own sha256, and the
  // version -> parts mapping lives in `prompt_version_content`. A new TABLE can
  // be added to an existing index.db (a new COLUMN cannot — there is no
  // migration), which is why the content lives in tables rather than columns.
  //
  // HONEST LIMITS: content addressing is EXACT-MATCH, so two versions whose tool
  // sets differ by a single schema field do NOT share a tools part — the win is
  // one tools_json per genuinely distinct tool set, not a perfect collapse. And
  // this only stops ADDING duplicates; it does not reclaim the bytes already
  // stored inline in an existing index.db (a backfill + VACUUM is deferred).
  `CREATE TABLE IF NOT EXISTS prompt_parts (
     part_hash TEXT PRIMARY KEY,
     content TEXT NOT NULL,
     bytes INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS prompt_version_content (
     hash TEXT PRIMARY KEY,
     system_part TEXT NOT NULL,
     tools_part TEXT NOT NULL,
     injected_part TEXT NOT NULL
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
  "CREATE INDEX IF NOT EXISTS idx_turns_requested_at ON turns(requested_at)",
  "CREATE INDEX IF NOT EXISTS idx_turns_prompt_version ON turns(prompt_version)",
  "CREATE INDEX IF NOT EXISTS idx_turns_model_served ON turns(model_served)",
];

/**
 * Cleanup run once at open, AFTER the schema. `idx_turns_session_seq` duplicated
 * the auto-index SQLite creates for `UNIQUE(session_id, seq)` (~220 KB each per
 * live dbstat); dropping it here, not just removing it from {@link SCHEMA_SQL},
 * is what retires it on an already-populated index.db. `IF EXISTS` keeps it a
 * no-op on a fresh database.
 */
const DROP_SQL: readonly string[] = ["DROP INDEX IF EXISTS idx_turns_session_seq"];

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

/**
 * Prompt-version METADATA row. The three legacy inline JSON columns are written
 * NULL — the content now lives in `prompt_parts` / `prompt_version_content`,
 * written in the SAME transaction. NULLing the inline columns atomically with
 * inserting the content row is what keeps a mid-batch failure from blanking
 * content with the parts row absent. `created_at` is set once, on first insert,
 * and never touched on conflict.
 */
const SQL_UPSERT_PROMPT = `INSERT INTO prompt_versions (
  hash, created_at, last_seen, seen_count, system_json, tools_json, injected_json,
  system_bytes, tools_bytes
) VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?)
ON CONFLICT(hash) DO UPDATE SET
  last_seen = excluded.last_seen,
  seen_count = excluded.seen_count,
  system_json = NULL,
  tools_json = NULL,
  injected_json = NULL,
  system_bytes = excluded.system_bytes,
  tools_bytes = excluded.tools_bytes`;

/**
 * One content-addressed part. `DO NOTHING` on conflict: the key IS the sha256 of
 * `content`, so a hash that already exists already holds the same string — there
 * is nothing to rewrite.
 */
const SQL_UPSERT_PROMPT_PART = `INSERT INTO prompt_parts (part_hash, content, bytes)
  VALUES (?, ?, ?)
  ON CONFLICT(part_hash) DO NOTHING`;

/** The version -> three part-hash mapping, re-pointable on conflict. */
const SQL_UPSERT_PROMPT_CONTENT = `INSERT INTO prompt_version_content
  (hash, system_part, tools_part, injected_part)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(hash) DO UPDATE SET
    system_part = excluded.system_part,
    tools_part = excluded.tools_part,
    injected_part = excluded.injected_part`;

/**
 * Incremental session rollup, applied inside the SAME transaction as the turn
 * inserts that fed it (a per-batch {@link SessionDelta}). `MIN`/`MAX` against the
 * EXISTING row (not blind assignment) so an out-of-order replay can never move
 * `first_seen` later; `turns` accumulates by the count actually INSERTED, so a
 * replayed batch that already landed (changes === 0) adds nothing.
 */
const SQL_UPSERT_SESSION = `INSERT INTO sessions (session_id, first_seen, last_seen, turns)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(session_id) DO UPDATE SET
    first_seen = MIN(sessions.first_seen, excluded.first_seen),
    last_seen  = MAX(sessions.last_seen,  excluded.last_seen),
    turns      = sessions.turns + excluded.turns`;

/**
 * Derive/repair rollup: recompute a session's row from the authoritative `turns`
 * rows. Idempotent (re-running yields the same row), so it is kept as
 * {@link IndexDb.upsertSessions} for spool replay of legacy `sessions` entries
 * and as a repair path — the flush path no longer uses it.
 */
const SQL_REDERIVE_SESSION = `INSERT INTO sessions (session_id, first_seen, last_seen, turns)
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

/** Metadata columns shared by the list/meta reads (no ~244 KB content). */
const PROMPT_META_COLUMNS = "hash, created_at, last_seen, seen_count, system_bytes, tools_bytes";

const SQL_LIST_PROMPT_VERSIONS = `SELECT ${PROMPT_META_COLUMNS}
  FROM prompt_versions ORDER BY last_seen DESC, hash ASC`;

const SQL_GET_PROMPT_VERSION_META = `SELECT ${PROMPT_META_COLUMNS}
  FROM prompt_versions WHERE hash = ?`;

/**
 * Reconstitute one version PARTS-FIRST with the legacy inline columns as
 * fallback: a row written by the current writer has no inline JSON (they are
 * NULL) and joins to its `prompt_version_content` + three `prompt_parts` rows; a
 * legacy row has no content row, so every join yields NULL and COALESCE returns
 * the inline columns it was written with. No migration needed — legacy rows read
 * correctly and are lazily migrated to parts when they are next re-seen.
 */
const SQL_GET_PROMPT_VERSION = `SELECT v.hash, v.created_at, v.last_seen, v.seen_count,
    COALESCE(sp.content, v.system_json) AS system_json,
    COALESCE(tp.content, v.tools_json) AS tools_json,
    COALESCE(ip.content, v.injected_json) AS injected_json,
    v.system_bytes, v.tools_bytes
  FROM prompt_versions v
  LEFT JOIN prompt_version_content c ON c.hash = v.hash
  LEFT JOIN prompt_parts sp ON sp.part_hash = c.system_part
  LEFT JOIN prompt_parts tp ON tp.part_hash = c.tools_part
  LEFT JOIN prompt_parts ip ON ip.part_hash = c.injected_part
  WHERE v.hash = ?`;

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

/**
 * The per-session contribution of one batch of INSERTED turns: `firstSeen` /
 * `lastSeen` are the extremes over the rows that actually landed in this batch
 * and `inserted` how many did. Applied incrementally to the `sessions` rollup in
 * the same transaction as the inserts.
 */
export interface SessionDelta {
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly inserted: number;
}

/**
 * Result of inserting a batch of turns: the assigned `turn_id`s in input order
 * (0 for a row that could not be resolved) plus the per-session deltas the
 * rollup was (or would have been) advanced by.
 */
export interface TurnBatchResult {
  readonly ids: readonly number[];
  readonly sessions: ReadonlyMap<string, SessionDelta>;
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

interface PromptVersionMetaDbRow {
  hash: string;
  created_at: string | null;
  last_seen: string | null;
  seen_count: number | null;
  system_bytes: number | null;
  tools_bytes: number | null;
}

interface PromptVersionDbRow extends PromptVersionMetaDbRow {
  system_json: string | null;
  tools_json: string | null;
  injected_json: string | null;
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

/** Map a `prompt_versions` row to the public {@link PromptVersionMeta} shape. */
function toPromptVersionMeta(r: PromptVersionMetaDbRow): PromptVersionMeta {
  return {
    hash: r.hash,
    createdAt: r.created_at ?? "",
    lastSeen: r.last_seen ?? r.created_at ?? "",
    seenCount: r.seen_count ?? 0,
    systemBytes: r.system_bytes ?? 0,
    toolsBytes: r.tools_bytes ?? 0,
  };
}

/** Map a full (content-reconstituting) `prompt_versions` row to its record. */
function toPromptVersionRecord(r: PromptVersionDbRow): PromptVersionRecord {
  return {
    ...toPromptVersionMeta(r),
    systemJson: r.system_json ?? "",
    toolsJson: r.tools_json ?? "",
    injectedJson: r.injected_json ?? "",
  };
}

/** sha256 of a canonical prompt part string. */
function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Build a content-addressed part ref from a part's canonical string. */
function makePartRef(content: string): PromptPartRef {
  return { hash: sha256Hex(content), content, bytes: Buffer.byteLength(content, "utf8") };
}

/** A prompt version as persisted: new part-ref form, or a legacy inline record. */
type PromptPersist = PromptVersionWrite | PromptVersionRecord;

/**
 * Normalize a persistable prompt version to the part-ref form. A record from the
 * current writer already carries `system`/`tools`/`injected` part refs; a LEGACY
 * record (an old `index-spool.jsonl` line, or a caller that predates content
 * addressing) carries inline JSON, which is hashed here to build the refs — the
 * same lazy migration the read path performs when it re-sees such a row.
 */
function toPromptVersionWrite(rec: PromptPersist): PromptVersionWrite {
  if ("system" in rec) return rec;
  return {
    hash: rec.hash,
    createdAt: rec.createdAt,
    lastSeen: rec.lastSeen,
    seenCount: rec.seenCount,
    systemBytes: rec.systemBytes,
    toolsBytes: rec.toolsBytes,
    system: makePartRef(rec.systemJson),
    tools: makePartRef(rec.toolsJson),
    injected: makePartRef(rec.injectedJson),
  };
}

/* ------------------------------------------------------------------ *
 * Spool
 * ------------------------------------------------------------------ */

/** A deferred batch: the unit spooled on failure and replayed on next open. */
type SpoolEntry =
  | { readonly kind: "turns"; readonly rows: readonly TurnRow[] }
  | { readonly kind: "prompt_versions"; readonly records: readonly PromptPersist[] }
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
  // Legacy lines carry inline systemJson/toolsJson/injectedJson; new lines carry
  // system/tools/injected part refs. Both are re-normalized on apply.
  if (kind === "prompt_versions") return { kind, records: payload as PromptPersist[] };
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
    // A DROP (not just a missing CREATE) is what retires a redundant index on an
    // already-populated index.db.
    for (const sql of DROP_SQL) this.#db.run(sql);
    this.replaySpool();
  }

  /* ------------------------------- writes ------------------------------- */

  /**
   * Insert turn rows (plus their failover events and the incremental `sessions`
   * rollup) in ONE transaction, returning the assigned `turn_id`s in input order
   * plus the per-session deltas. Idempotent per `(session_id, seq)`: a re-insert
   * of an existing turn is ignored (changes === 0), contributes nothing to the
   * rollup, and its id is re-read. Never throws — on any SQLite error the batch
   * is spooled and an empty result is returned.
   */
  insertTurnRows(rows: readonly TurnRow[]): TurnBatchResult {
    return this.#writeBatch(rows, []);
  }

  /**
   * Atomic flush (the writer's hot path): turn rows (+ failover + the
   * incremental `sessions` rollup) AND prompt versions committed as ONE
   * transaction, so a flush is a single commit rather than one per kind. Never
   * throws — on failure BOTH entry kinds are spooled, so replay is unchanged.
   */
  commitFlush(rows: readonly TurnRow[], prompts: readonly PromptPersist[]): TurnBatchResult {
    return this.#writeBatch(rows, prompts);
  }

  /**
   * Upsert prompt versions in ONE transaction: the metadata row, the three
   * content-addressed parts and the version -> parts mapping together. Each
   * record is written to its stated ABSOLUTE state (`created_at` is set once, on
   * first insert, and preserved thereafter). Callers should pre-aggregate per
   * hash; a repeated hash in one call simply leaves the last record's values.
   * Never throws.
   */
  upsertPromptVersions(records: readonly PromptPersist[]): void {
    if (records.length === 0) return;
    try {
      this.#commitPrompts(records);
    } catch (err) {
      this.#spool({ kind: "prompt_versions", records }, err);
    }
  }

  /**
   * DERIVE/REPAIR the `sessions` rollup for the given session ids from their
   * authoritative `turns` rows, in ONE transaction. The flush path no longer
   * needs this (the rollup now travels with the turn inserts), but it stays as
   * the idempotent repair path and the applier for legacy `sessions` spool
   * entries. Never throws.
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

  /**
   * All prompt versions, most recently seen first. METADATA ONLY — the ~244 KB
   * content of each version is deliberately not read, so a listing does not
   * deserialize the whole library.
   */
  listPromptVersions(): PromptVersionMeta[] {
    const rows = this.#prep(SQL_LIST_PROMPT_VERSIONS).all() as PromptVersionMetaDbRow[];
    return rows.map(toPromptVersionMeta);
  }

  /** Metadata for one prompt version (no content), or null when absent. */
  getPromptVersionMeta(hash: string): PromptVersionMeta | null {
    const row = this.#prep(SQL_GET_PROMPT_VERSION_META).get(hash) as PromptVersionMetaDbRow | null;
    return row ? toPromptVersionMeta(row) : null;
  }

  /**
   * One prompt version WITH its reconstructed content by hash, or null when
   * absent. Parts-first with the legacy inline columns as fallback.
   */
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

  /**
   * Commit a flush atomically: turn rows (+ failover + the incremental
   * `sessions` rollup) and prompt versions in ONE transaction. On any SQLite
   * error the whole transaction rolls back and BOTH entry kinds are spooled, so
   * a replay re-applies exactly what the old per-kind spooling would have. Never
   * throws.
   */
  #writeBatch(rows: readonly TurnRow[], prompts: readonly PromptPersist[]): TurnBatchResult {
    if (rows.length === 0 && prompts.length === 0) {
      return { ids: [], sessions: new Map() };
    }
    try {
      return this.#transaction(() => {
        const result = this.#commitTurnsInner(rows);
        this.#commitPromptsInner(prompts);
        return result;
      });
    } catch (err) {
      if (rows.length > 0) this.#spool({ kind: "turns", rows }, err);
      if (prompts.length > 0) this.#spool({ kind: "prompt_versions", records: prompts }, err);
      return { ids: [], sessions: new Map() };
    }
  }

  /** Wrap {@link #commitTurnsInner} in its own transaction (spool replay). */
  #commitTurns(rows: readonly TurnRow[]): TurnBatchResult {
    return this.#transaction(() => this.#commitTurnsInner(rows));
  }

  /**
   * Insert turns + their failover events and advance each affected session's
   * rollup by the delta of the rows that actually landed — all without opening a
   * transaction (the caller owns it). Throws on any SQLite error.
   */
  #commitTurnsInner(rows: readonly TurnRow[]): TurnBatchResult {
    const ids: number[] = [];
    const deltas = new Map<string, { firstSeen: string; lastSeen: string; inserted: number }>();
    for (const row of rows) {
      const info = this.#prep(SQL_INSERT_TURN).run(
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
      const inserted = info.changes === 1;
      // On insert, lastInsertRowid IS the turn_id; only an ignored re-insert
      // (changes === 0) needs the id re-read.
      let turnId: number;
      if (inserted) {
        turnId = Number(info.lastInsertRowid);
      } else {
        const found = this.#prep(SQL_SELECT_TURN_ID).get(row.sessionId, row.seq) as {
          turn_id: number;
        } | null;
        turnId = found?.turn_id ?? 0;
      }
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
      if (inserted) {
        const responded = row.respondedAt ?? row.requestedAt;
        const delta = deltas.get(row.sessionId);
        if (delta === undefined) {
          deltas.set(row.sessionId, {
            firstSeen: row.requestedAt,
            lastSeen: responded,
            inserted: 1,
          });
        } else {
          if (row.requestedAt < delta.firstSeen) delta.firstSeen = row.requestedAt;
          if (responded > delta.lastSeen) delta.lastSeen = responded;
          delta.inserted += 1;
        }
      }
    }
    for (const [sid, delta] of deltas) {
      this.#prep(SQL_UPSERT_SESSION).run(sid, delta.firstSeen, delta.lastSeen, delta.inserted);
    }
    return { ids, sessions: deltas };
  }

  /** Wrap {@link #commitPromptsInner} in its own transaction. */
  #commitPrompts(records: readonly PromptPersist[]): void {
    this.#transaction(() => this.#commitPromptsInner(records));
  }

  /**
   * Write each prompt version's parts, its parts mapping and its metadata row —
   * no transaction opened (the caller owns it). A legacy inline record is
   * normalized to part refs first. Throws on any SQLite error.
   */
  #commitPromptsInner(records: readonly PromptPersist[]): void {
    for (const rec of records) {
      const write = toPromptVersionWrite(rec);
      this.#prep(SQL_UPSERT_PROMPT).run(
        write.hash,
        write.createdAt,
        write.lastSeen,
        write.seenCount,
        write.systemBytes,
        write.toolsBytes,
      );
      for (const part of [write.system, write.tools, write.injected]) {
        this.#prep(SQL_UPSERT_PROMPT_PART).run(part.hash, part.content, part.bytes);
      }
      this.#prep(SQL_UPSERT_PROMPT_CONTENT).run(
        write.hash,
        write.system.hash,
        write.tools.hash,
        write.injected.hash,
      );
    }
  }

  /** Refresh the sessions rollup by derivation; throws on any SQLite error. */
  #upsertSessions(sessionIds: readonly string[]): void {
    this.#transaction(() => {
      for (const sid of sessionIds) this.#prep(SQL_REDERIVE_SESSION).run(sid);
    });
  }

  /** Re-apply one spooled batch via the throwing private paths. */
  #applyEntry(entry: SpoolEntry): void {
    switch (entry.kind) {
      case "turns":
        this.#commitTurns(entry.rows);
        break;
      case "prompt_versions":
        this.#commitPrompts(entry.records);
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
