/**
 * Turn writer: the single owner of turn-body compression, the per-turn body
 * file and the SQLite index.
 *
 * The request path only ENQUEUES. `TurnWriter.write` never compresses, never
 * touches the filesystem and never calls sqlite, so a slow disk or a locked
 * database can never delay an inference response. Every blocking step (zstd
 * compression, the atomic body write, the batched index commit) is owned by a
 * `WriterCore`, which runs either:
 *   - inside a Bun Worker (`WorkerWriter`, production: bun:sqlite is synchronous
 *     and would otherwise block the event loop for the whole commit), or
 *   - inline on the calling thread (`InlineWriter`, tests and fallback).
 *
 * Both writers share one bounded-queue + shed policy and the same `WriterCore`;
 * neither is a stub. `WorkerWriter` hands each job's body across as a
 * transferable ArrayBuffer (moved, not structured-clone copied) and the worker
 * opens the database itself, so no sqlite call ever happens on the main thread.
 *
 * Metadata is never lost. A BODY may be dropped (queue-budget pressure, a worker
 * crash that took the transferred buffer with it, or a record larger than the
 * per-turn cap) and the row is marked `shed`, but the index row is always
 * staged, and `IndexDb` spools a failed commit for replay on the next open.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { IndexDb, type TurnRow } from "./index-db.ts";
import type {
  BodyState,
  ErrorClass,
  FailoverEvent,
  PromptPartRef,
  PromptSurface,
  PromptVersionWrite,
  TurnRecord,
  WriterConfig,
  WriterJob,
} from "./log-types.ts";
import { errorMessage, logger } from "./logger.ts";
import { promptVersionOf } from "./prompt-surface.ts";

/* ------------------------------------------------------------------ *
 * Tunables
 * ------------------------------------------------------------------ */

/** Accepted-but-unprocessed jobs before the queue counts as saturated. */
const DEFAULT_MAX_QUEUE_DEPTH = 1024;

/** Turns staged before a batch is committed regardless of the timer. */
const DEFAULT_MAX_BATCH_TURNS = 256;

/** Jobs in flight to the worker before posting pauses (flow control). */
const DEFAULT_MAX_OUTSTANDING = 16;

/**
 * Bound on the in-memory per-hash seen-count map (LRU by recency). A long-lived
 * worker accumulating distinct prompt surfaces must not grow it without bound;
 * an evicted hash simply re-reads its absolute seen count on the next sighting.
 */
const MAX_SEEN_SURFACES = 512;

/** Retention sweep cadence (ms); unref'd, so it never holds the process open. */
const PRUNE_TICK_MS = 6 * 60 * 60 * 1000;

/** Extension of a zstd-compressed, self-contained turn payload. */
const TURN_EXT_ZST = ".json.zst";

/** Extension of an UNcompressed turn payload (`compression.enabled: false`). */
const TURN_EXT_JSON = ".json";

/** Directory used when a session id cannot be sanitized to a safe segment. */
const UNKNOWN_SESSION = "unknown";

/**
 * Bun's synchronous zstd API. Present at runtime but absent from the pinned
 * `@types/bun`, so it is surfaced through a narrow typed view rather than a cast
 * at every call site. Level 3 is the measured sweet spot; level 19 is roughly
 * two orders of magnitude slower and is never wanted.
 */
interface ZstdApi {
  zstdCompressSync(input: Uint8Array, options?: { readonly level?: number }): Uint8Array;
}

const zstd = Bun as unknown as ZstdApi;

/* ------------------------------------------------------------------ *
 * Protocol + shared record shapes
 * ------------------------------------------------------------------ */

/**
 * The index-relevant projection of a `TurnRecord`, plus the fingerprint the turn
 * ran under. Deliberately carries NO body payload (messages / response content),
 * so it stays small and can be structured-cloned to the worker and retained on
 * the main thread for a post-crash re-send.
 */
export interface TurnJobMeta {
  readonly sessionId: string;
  readonly seq: number;
  readonly requestedAt: string;
  readonly respondedAt: string;
  readonly canonicalModel: string;
  readonly invocationModel: string;
  readonly modelServed: string | null;
  readonly backend: string;
  readonly translationPath: string;
  readonly promptVersion: string | null;
  readonly stopReason: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number | null;
  readonly latencyMs: number | null;
  readonly failover: boolean;
  readonly errorClass: ErrorClass | null;
  readonly toolCalls: readonly string[] | null;
  readonly subagentOf: number | null;
  readonly bodyState: BodyState;
  readonly promptSurface: PromptSurface | null;
  readonly failoverEvents: readonly FailoverEvent[];
}

/** One job as it crosses into a writer core (in-thread or across the worker). */
export type WireJob = WireTurnJob | WirePromptJob;

export interface WireTurnJob {
  readonly kind: "turn";
  /** Correlation id assigned by the main thread (flow control + ack). */
  readonly id: number;
  readonly meta: TurnJobMeta;
  /** UTF-8 JSON of the self-contained turn file, or null when the body is shed. */
  readonly body: Uint8Array | null;
}

/** A prompt-library sighting: no turn row, no body, nothing to compress. */
export interface WirePromptJob {
  readonly kind: "prompt";
  readonly id: number;
  readonly surface: PromptSurface;
}

/** Main thread -> writer worker. */
export type WriterRequest =
  | { readonly type: "init"; readonly config: WriterConfig }
  | {
      readonly type: "job";
      readonly id: number;
      readonly meta: TurnJobMeta;
      readonly body: ArrayBuffer | null;
    }
  | { readonly type: "prompt"; readonly id: number; readonly surface: PromptSurface }
  | { readonly type: "flush"; readonly id: number }
  | { readonly type: "prune"; readonly id: number }
  | { readonly type: "close"; readonly id: number };

/** Writer worker -> main thread. */
export type WriterResponse =
  | { readonly type: "ready" }
  | { readonly type: "written"; readonly id: number }
  | {
      readonly type: "committed";
      readonly flushCount: number;
      readonly turns: number;
      readonly ids: readonly number[];
    }
  | { readonly type: "flushed"; readonly id: number; readonly flushCount: number }
  | { readonly type: "pruned"; readonly id: number; readonly pruned: number }
  | { readonly type: "closed"; readonly id: number }
  | { readonly type: "error"; readonly id: number | null; readonly message: string };

/** Operational counters exposed by every writer. */
export interface WriterStats {
  /** Jobs accepted but not yet processed (queued plus in flight). */
  readonly queueDepth: number;
  /** Bodies dropped rather than written. */
  readonly shedCount: number;
  /** Index batches committed by the core. */
  readonly flushCount: number;
  /**
   * Committed work units: turn rows (body written, or shed when over the
   * per-turn cap) plus prompt-library sightings.
   */
  readonly writtenCount: number;
  /** Body bytes currently in flight (queued, not yet processed). */
  readonly inFlightBytes: number;
}

/**
 * The writer contract. `write` is enqueue-only and must not block; `flush`
 * drains the queue and commits the pending batch; `close` flushes then releases
 * resources (terminates the worker / closes the database).
 */
export interface TurnWriter {
  write(job: WriterJob): void;
  /**
   * Record one prompt-library sighting with no turn. Used when system-prompt
   * capture is on and chat-turn capture is off; enqueue-only like {@link write}.
   */
  writePrompt(surface: PromptSurface): void;
  flush(): Promise<void>;
  close(): Promise<void>;
  /** Prune bodies past `retentionDays`; resolves to the files deleted. */
  pruneBodies(): Promise<number>;
  stats(): WriterStats;
}

/** Which writer implementation the caller wants. */
export type WriterMode = "worker" | "inline";

/* ------------------------------------------------------------------ *
 * Path + serialization helpers
 * ------------------------------------------------------------------ */

/**
 * Sanitize a session id for use as a directory segment. The id comes from a
 * client header, so it must never enable path traversal: `..` is rejected (the
 * dot is preserved by the allow-list, so it is checked explicitly) and the
 * length is bounded.
 */
function safeSessionId(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (cleaned.length === 0 || cleaned === "." || cleaned === "..") return UNKNOWN_SESSION;
  return cleaned.slice(0, 128);
}

/** Absolute session directory for a session id, contained under the log root. */
function sessionDirOf(config: WriterConfig, sessionId: string): string {
  const base = resolve(config.dir, config.sessionDir);
  const dir = resolve(base, safeSessionId(sessionId));
  if (dir !== base && !dir.startsWith(base + sep)) return join(base, UNKNOWN_SESSION);
  return dir;
}

/** Deterministic turn-file name: zero-padded seq + a filename-safe timestamp. */
function bodyFileName(seq: number, requestedAt: string, compressed: boolean): string {
  const seqStr = String(seq).padStart(5, "0");
  const ext = compressed ? TURN_EXT_ZST : TURN_EXT_JSON;
  return `${seqStr}-${requestedAt.replace(/[:.]/g, "-")}${ext}`;
}

/** Write bytes atomically: temp file, then rename over the target. */
function writeFileAtomic(file: string, data: Uint8Array): void {
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

/** Serialize a turn record to the UTF-8 bytes that become its body file. */
function encodeTurn(turn: TurnRecord): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(turn));
}

/**
 * Content-address ONE canonical prompt part: its sha256, the string itself and
 * its UTF-8 size. Computed here (on the writer thread, off the request path)
 * from the already-materialized canonical strings. Deliberately NOT memoized by
 * the combined version hash: two versions with the same combined hash must still
 * reflect their own content (the index test that upserts one hash with different
 * content relies on last-write-wins). Three sha256's of a few hundred KB are
 * sub-millisecond, and a flush touches only 1-3 versions.
 */
function partRef(content: string): PromptPartRef {
  return {
    hash: createHash("sha256").update(content).digest("hex"),
    content,
    bytes: Buffer.byteLength(content, "utf8"),
  };
}

/** Project a turn into the small, clone-safe index metadata. */
function buildMeta(job: WriterJob, bodyState: BodyState): TurnJobMeta {
  const t = job.turn;
  return {
    sessionId: t.sessionId,
    seq: job.seq,
    requestedAt: t.requestedAt,
    respondedAt: t.respondedAt,
    canonicalModel: t.canonicalModel,
    invocationModel: t.invocationModel,
    modelServed: t.modelServed ?? null,
    backend: t.backend,
    translationPath: t.translationPath,
    promptVersion: job.promptSurface?.hash ?? promptVersionOf(t),
    stopReason: t.stopReason,
    inputTokens: t.usage.inputTokens,
    outputTokens: t.usage.outputTokens,
    cacheReadTokens: t.cacheReadTokens ?? null,
    latencyMs: t.latencyMs ?? null,
    failover: t.failover ?? false,
    errorClass: t.errorClass ?? null,
    toolCalls: t.toolCalls ?? null,
    subagentOf: t.subagentOf ?? null,
    bodyState,
    promptSurface: job.promptSurface,
    failoverEvents: job.failoverEvents,
  };
}

/**
 * Build a wire job. When `shed` is set (queue pressure, or a post-crash re-send)
 * or the caller already marked the body shed, the body is dropped entirely and
 * the row is marked `shed`; the metadata is always produced.
 */
function buildWireJob(id: number, job: WriterJob, shed: boolean): WireJob {
  const dropBody = shed || job.bodyState === "shed";
  const bodyState: BodyState = dropBody ? "shed" : job.bodyState;
  return {
    kind: "turn",
    id,
    meta: buildMeta(job, bodyState),
    body: dropBody ? null : encodeTurn(job.turn),
  };
}

/* ------------------------------------------------------------------ *
 * WriterCore: compression + body file + batched index (no queue)
 * ------------------------------------------------------------------ */

/** Hooks the worker installs to forward commits back over the protocol. */
export interface WriterCoreOptions {
  /**
   * Invoked after each committed batch with the running flush count and the wire
   * ids of the jobs committed, so the caller can retire them.
   */
  readonly onCommit?: (flushCount: number, turns: number, ids: readonly number[]) => void;
}

/**
 * The blocking half of the writer: compress a job's body, write it atomically,
 * stage the index rows and commit them in batches. It has no queue of its own;
 * the caller (a Worker or `InlineWriter`) decides when `apply` is called and owns
 * the flush cadence via the timer started here.
 *
 * The database is opened HERE, so whichever thread constructs the core is the
 * only thread that touches bun:sqlite.
 */
export class WriterCore {
  readonly #config: WriterConfig;
  readonly #db: IndexDb;
  readonly #onCommit: WriterCoreOptions["onCommit"];
  #turns: TurnRow[] = [];
  #batchIds: number[] = [];
  /** Prompt-only jobs staged for this batch (no turn row accompanies them). */
  #promptJobs = 0;
  #prompts = new Map<string, PromptVersionWrite>();
  #seen = new Map<string, { createdAt: string; seenCount: number }>();
  #flushCount = 0;
  #closed = false;
  #flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: WriterConfig, opts: WriterCoreOptions = {}) {
    this.#config = config;
    this.#onCommit = opts.onCommit;
    // Pre-create the roots so the first body write cannot fail on a missing dir.
    mkdirSync(join(config.dir, config.sessionDir), { recursive: true });
    this.#db = new IndexDb(config.indexPath);
    const flushMs = Math.max(1, Math.floor(config.indexFlushMs));
    this.#flushTimer = setInterval(() => this.flushBatch(), flushMs);
    this.#flushTimer.unref();
  }

  /** Number of index batches committed. */
  get flushCount(): number {
    return this.#flushCount;
  }

  /**
   * Process one job. Returns true when this job tipped the staged batch over the
   * size cap and committed it. A failed body write never blocks the row: the row
   * is staged anyway and marked shed.
   */
  apply(job: WireJob): boolean {
    const now = new Date().toISOString();
    if (job.kind === "prompt") {
      // Modular capture: the prompt library is recorded even when chat-turn
      // capture is off. There is no turn row and no body — just the version
      // sighting, committed with whatever else this batch carries.
      this.#recordPrompt(job.surface, now);
      this.#batchIds.push(job.id);
      this.#promptJobs += 1;
      return false;
    }
    const { meta } = job;
    let bodyFile: string | null = null;
    let bodyBytes: number | null = null;
    let bodyState: BodyState = "shed";

    if (job.body !== null && meta.bodyState !== "shed") {
      const stored = job.body;
      if (stored.byteLength > this.#config.maxTurnBytes) {
        // A byte-clip of a UTF-8 JSON blob is NOT valid JSON: the stored file
        // would fail to parse and read back as an empty body. Instead of storing
        // a corrupt payload, drop the body honestly — the metadata row survives
        // and the body is ABSENT (marked `shed`), never corrupt.
        bodyState = "shed";
      } else {
        bodyState = meta.bodyState;
        const written = this.#writeBody(meta, stored);
        if (written) {
          bodyFile = written.file;
          bodyBytes = written.bytes;
        } else {
          bodyState = "shed";
        }
      }
    }

    this.#turns.push({
      sessionId: meta.sessionId,
      seq: meta.seq,
      requestedAt: meta.requestedAt,
      respondedAt: meta.respondedAt,
      modelRequested: meta.canonicalModel,
      modelServed: meta.modelServed ?? meta.invocationModel,
      backend: meta.backend,
      path: meta.translationPath,
      promptVersion: meta.promptVersion,
      stopReason: meta.stopReason,
      inputTokens: meta.inputTokens,
      outputTokens: meta.outputTokens,
      cacheReadTokens: meta.cacheReadTokens,
      latencyMs: meta.latencyMs,
      failover: meta.failover,
      errorClass: meta.errorClass,
      bodyFile,
      bodyBytes,
      bodyState,
      toolCalls: meta.toolCalls,
      subagentOf: meta.subagentOf,
      failoverEvents: meta.failoverEvents,
    });
    this.#batchIds.push(job.id);
    if (meta.promptSurface) this.#recordPrompt(meta.promptSurface, now);

    if (this.#turns.length >= DEFAULT_MAX_BATCH_TURNS) {
      this.flushBatch();
      return true;
    }
    return false;
  }

  /**
   * Commit the staged rows as ONE transaction: the turn rows, their incremental
   * `sessions` rollup (which now travels with the inserts) and the prompt
   * versions. `IndexDb.commitFlush` owns the transaction and spools the batch on
   * failure, so a flush is a single commit covering the whole batch rather than
   * one commit per kind.
   */
  flushBatch(): void {
    if (this.#turns.length === 0 && this.#prompts.size === 0) return;
    const turns = this.#turns;
    const ids = this.#batchIds;
    const prompts = [...this.#prompts.values()];
    const committed = turns.length + this.#promptJobs;
    this.#turns = [];
    this.#batchIds = [];
    this.#promptJobs = 0;
    this.#prompts = new Map();
    try {
      this.#db.commitFlush(turns, prompts);
      this.#flushCount += 1;
      // The ids are reported only after the rows are durable (inserted, or
      // spooled for replay by IndexDb), so a caller may safely retire them.
      this.#onCommit?.(this.#flushCount, committed, ids);
    } catch (err) {
      logger.error("turn writer batch commit failed", { error: errorMessage(err) });
    }
  }

  /**
   * Prune TURN BODIES older than `retentionDays`: mark them `pruned` in the
   * index and delete the files. Prompt versions and index rows are kept
   * FOREVER — the prompt library is never aged out, by design. Returns the
   * number of files deleted; a no-op when retention is disabled.
   */
  prune(): number {
    const days = this.#config.retentionDays;
    if (!(days > 0)) return 0;
    let pruned = 0;
    try {
      for (const rel of this.#db.pruneBodiesOlderThan(days).files) {
        const abs = this.#bodyAbsolutePath(rel);
        if (abs === null) continue;
        try {
          rmSync(abs, { force: true });
          pruned += 1;
        } catch (err) {
          logger.warn("turn writer failed to delete pruned body", {
            file: rel,
            error: errorMessage(err),
          });
        }
      }
    } catch (err) {
      logger.warn("turn writer retention sweep failed", { error: errorMessage(err) });
    }
    return pruned;
  }

  /** Flush the pending batch, stop the timer and close the database. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#flushTimer !== null) {
      clearInterval(this.#flushTimer);
      this.#flushTimer = null;
    }
    this.flushBatch();
    this.#db.close();
  }

  /* ------------------------------- private ------------------------------ */

  /** Compress and atomically write one body; null on failure (never throws). */
  #writeBody(
    meta: TurnJobMeta,
    data: Uint8Array,
  ): { readonly file: string; readonly bytes: number } | null {
    try {
      const compressed = this.#config.compress;
      const stored = compressed
        ? zstd.zstdCompressSync(data, { level: this.#config.zstdLevel })
        : data;
      const dir = sessionDirOf(this.#config, meta.sessionId);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, bodyFileName(meta.seq, meta.requestedAt, compressed));
      writeFileAtomic(file, stored);
      return { file: relative(resolve(this.#config.dir), file), bytes: stored.byteLength };
    } catch (err) {
      logger.error("turn writer failed to write body file", {
        session: meta.sessionId,
        seq: meta.seq,
        error: errorMessage(err),
      });
      return null;
    }
  }

  /**
   * Stage a prompt version, tracking its absolute seen count across the run.
   * The `#seen` map is bounded (LRU): on eviction the next sighting re-reads
   * `createdAt` / `seenCount` from the DB via the METADATA-ONLY accessor, so an
   * eviction costs a read, never correctness — and never materializes the
   * version's ~244 KB of tool schemas.
   */
  #recordPrompt(surface: PromptSurface, now: string): void {
    let seen = this.#seen.get(surface.hash);
    if (!seen) {
      const existing = this.#db.getPromptVersionMeta(surface.hash);
      const createdAt = existing && existing.createdAt.length > 0 ? existing.createdAt : now;
      seen = { createdAt, seenCount: existing?.seenCount ?? 0 };
    }
    seen.seenCount += 1;
    // Re-insert as most-recent, then evict the oldest past the cap.
    this.#seen.delete(surface.hash);
    this.#seen.set(surface.hash, seen);
    if (this.#seen.size > MAX_SEEN_SURFACES) {
      const oldest = this.#seen.keys().next().value;
      if (oldest !== undefined) this.#seen.delete(oldest);
    }
    this.#batchPrompt(surface, now, seen.createdAt, seen.seenCount);
  }

  /** Stage (last write wins per hash in a batch) one prompt-version record. */
  #batchPrompt(
    surface: PromptSurface,
    lastSeen: string,
    createdAt: string,
    seenCount: number,
  ): void {
    this.#prompts.set(surface.hash, {
      hash: surface.hash,
      createdAt,
      lastSeen,
      seenCount,
      systemBytes: surface.systemBytes,
      toolsBytes: surface.toolsBytes,
      system: partRef(surface.systemJson),
      tools: partRef(surface.toolsJson),
      injected: partRef(surface.injectedJson),
    });
  }

  /** Resolve a stored `body_file` to an absolute path, contained under the root. */
  #bodyAbsolutePath(rel: string): string | null {
    const base = resolve(this.#config.dir);
    const abs = resolve(base, rel);
    if (abs !== base && !abs.startsWith(base + sep)) return null;
    return abs;
  }
}

/* ------------------------------------------------------------------ *
 * InlineWriter: same core, processed on the calling thread
 * ------------------------------------------------------------------ */

/** Writer lifecycle: open accepts jobs, closing/closed do not. */
type WriterState = "open" | "closing" | "closed";

/**
 * In-process writer. Jobs are chained onto one promise so they are processed in
 * order, and `flush` awaits the chain before committing. Used by tests and as
 * the fallback when a Worker is not wanted; it performs the real compression,
 * file write and index work (it is not a stub) but does block the calling thread
 * for the duration of each job, which is exactly why `WorkerWriter` exists.
 */
export class InlineWriter implements TurnWriter {
  readonly #config: WriterConfig;
  readonly #core: WriterCore;
  #chain: Promise<void> = Promise.resolve();
  #state: WriterState = "open";
  #depth = 0;
  #inFlightBytes = 0;
  #shedCount = 0;
  #writtenCount = 0;
  #nextId = 1;
  #pruneTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: WriterConfig) {
    this.#config = config;
    // Count committed rows, matching WorkerWriter's `writtenCount` semantics.
    this.#core = new WriterCore(config, {
      onCommit: (_flushCount, turns) => {
        this.#writtenCount += turns;
      },
    });
    this.#pruneTimer = setInterval(() => void this.pruneBodies(), PRUNE_TICK_MS);
    this.#pruneTimer.unref();
  }

  write(job: WriterJob): void {
    if (this.#state !== "open") {
      logger.warn("turn writer is not open; dropping turn", { session: job.turn.sessionId });
      return;
    }
    const shed =
      this.#inFlightBytes >= this.#config.inFlightBudgetBytes ||
      this.#depth >= DEFAULT_MAX_QUEUE_DEPTH;
    const wire = buildWireJob(this.#nextId++, job, shed);
    const bytes = wire.kind === "turn" ? (wire.body?.byteLength ?? 0) : 0;
    if (shed) this.#shedCount += 1;
    else this.#inFlightBytes += bytes;
    this.#depth += 1;
    this.#chain = this.#chain.then(() => this.#consume(wire, bytes));
  }

  writePrompt(surface: PromptSurface): void {
    if (this.#state !== "open") {
      logger.warn("turn writer is not open; dropping prompt sighting");
      return;
    }
    const wire: WireJob = { kind: "prompt", id: this.#nextId++, surface };
    this.#depth += 1;
    this.#chain = this.#chain.then(() => this.#consume(wire, 0));
  }

  async flush(): Promise<void> {
    if (this.#state === "closed") return;
    await this.#chain;
    this.#core.flushBatch();
  }

  async close(): Promise<void> {
    if (this.#state !== "open") return;
    this.#state = "closing";
    await this.#chain;
    this.#core.close();
    this.#state = "closed";
    if (this.#pruneTimer !== null) {
      clearInterval(this.#pruneTimer);
      this.#pruneTimer = null;
    }
  }

  async pruneBodies(): Promise<number> {
    if (this.#state !== "open") return 0;
    await this.#chain;
    return this.#core.prune();
  }

  stats(): WriterStats {
    return {
      queueDepth: this.#depth,
      shedCount: this.#shedCount,
      flushCount: this.#core.flushCount,
      writtenCount: this.#writtenCount,
      inFlightBytes: this.#inFlightBytes,
    };
  }

  /** Apply one job; never throws, always releases its queue slot. */
  #consume(wire: WireJob, bytes: number): void {
    try {
      this.#core.apply(wire);
    } catch (err) {
      logger.error("turn writer failed to apply job", {
        kind: wire.kind,
        ...(wire.kind === "turn" ? { seq: wire.meta.seq } : {}),
        error: errorMessage(err),
      });
    } finally {
      this.#inFlightBytes -= bytes;
      this.#depth -= 1;
    }
  }
}

/* ------------------------------------------------------------------ *
 * WorkerWriter: same core, run on a dedicated thread
 * ------------------------------------------------------------------ */

/** An accepted job plus the body bytes it contributes to the budget. */
interface Envelope {
  readonly wire: WireJob;
  readonly bytes: number;
  /**
   * True once its body buffer has been transferred to the worker. A transferred
   * buffer is detached on this side, so a crash cannot re-send it and the job
   * must be rebuilt body-less.
   */
  bodySent: boolean;
}

/**
 * Production writer. The main thread only serializes each job's body to a
 * transferable ArrayBuffer and posts it; compression, the file write and every
 * sqlite call happen in `writer-worker.ts`.
 *
 * Two independent trackers guard correctness:
 *   - `#inflight` is the flow-control window (`DEFAULT_MAX_OUTSTANDING` jobs) and
 *     is retired by the per-job `written` ack;
 *   - `#uncommitted` holds every accepted job until the worker reports its row
 *     COMMITTED. A batch commit lags the ack, so this is what a crash re-sends.
 * A crash therefore loses only bodies, never metadata: an uncommitted job whose
 * body was transferred out is re-queued BODY-LESS and marked shed, while a job
 * still queued keeps its body.
 */
export class WorkerWriter implements TurnWriter {
  readonly #config: WriterConfig;
  #worker: Worker | null = null;
  #ready = false;
  #state: WriterState = "open";
  /** Accepted, not yet posted (body buffer still intact). */
  #queued: Envelope[] = [];
  /** Posted, awaiting the worker's `written` ack (body buffer transferred out). */
  #inflight = new Map<number, Envelope>();
  /** Accepted, not yet committed to the index (superset of queued + inflight). */
  #uncommitted = new Map<number, Envelope>();
  #inFlightBytes = 0;
  #shedCount = 0;
  #writtenCount = 0;
  #flushCount = 0;
  #crashes = 0;
  #generation = 0;
  #nextId = 1;
  #requestSeq = 1;
  #waiters = new Map<number, (msg: WriterResponse) => void>();
  /** Control requests awaiting a reply; re-sent to a replacement worker. */
  #pendingRequests = new Map<number, WriterRequest>();
  #drainWaiters: Array<() => void> = [];
  #pruneTimer: ReturnType<typeof setInterval> | null = null;
  #respawnTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Set only when the Worker could not be constructed at all and no job was yet
   * in flight: writes then happen in-process instead of queueing forever. Briefly
   * blocking the event loop is a far better trade than losing every turn's
   * metadata, which is exactly what a permanently unspawned queue would do.
   */
  #fallback: InlineWriter | null = null;

  constructor(config: WriterConfig) {
    this.#config = config;
    this.#spawn();
    this.#pruneTimer = setInterval(() => void this.pruneBodies(), PRUNE_TICK_MS);
    this.#pruneTimer.unref();
  }

  write(job: WriterJob): void {
    if (this.#fallback !== null) {
      this.#fallback.write(job);
      return;
    }
    if (this.#state !== "open") {
      logger.warn("turn writer is not open; dropping turn", { session: job.turn.sessionId });
      return;
    }
    const shed =
      this.#inFlightBytes >= this.#config.inFlightBudgetBytes ||
      this.#uncommitted.size >= DEFAULT_MAX_QUEUE_DEPTH;
    const wire = buildWireJob(this.#nextId++, job, shed);
    const bytes = wire.kind === "turn" ? (wire.body?.byteLength ?? 0) : 0;
    if (shed) this.#shedCount += 1;
    else this.#inFlightBytes += bytes;
    const env: Envelope = { wire, bytes, bodySent: false };
    this.#queued.push(env);
    this.#uncommitted.set(wire.id, env);
    this.#pump();
  }

  writePrompt(surface: PromptSurface): void {
    if (this.#fallback !== null) {
      this.#fallback.writePrompt(surface);
      return;
    }
    if (this.#state !== "open") {
      logger.warn("turn writer is not open; dropping prompt sighting");
      return;
    }
    const wire: WireJob = { kind: "prompt", id: this.#nextId++, surface };
    const env: Envelope = { wire, bytes: 0, bodySent: false };
    this.#queued.push(env);
    this.#uncommitted.set(wire.id, env);
    this.#pump();
  }

  async flush(): Promise<void> {
    if (this.#fallback !== null) return this.#fallback.flush();
    if (this.#state === "closed") return;
    // Apply everything, force a commit, and repeat in case a crash re-queued a
    // job after the commit. One pass is the norm.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await this.#drainApplied();
      if (this.#uncommitted.size === 0) return;
      if (!this.#ready || this.#worker === null) return;
      await this.#request("flush");
    }
  }

  async close(): Promise<void> {
    const fallback = this.#fallback;
    if (fallback !== null) {
      this.#state = "closed";
      if (this.#pruneTimer !== null) {
        clearInterval(this.#pruneTimer);
        this.#pruneTimer = null;
      }
      await fallback.close();
      return;
    }
    if (this.#state !== "open") return;
    this.#state = "closing";
    try {
      await this.flush();
      if (this.#ready && this.#worker !== null) await this.#request("close");
    } finally {
      this.#state = "closed";
      if (this.#pruneTimer !== null) {
        clearInterval(this.#pruneTimer);
        this.#pruneTimer = null;
      }
      if (this.#respawnTimer !== null) {
        clearTimeout(this.#respawnTimer);
        this.#respawnTimer = null;
      }
      this.#disposeWorker();
      this.#ready = false;
      this.#releaseWaiters();
    }
  }

  async pruneBodies(): Promise<number> {
    if (this.#fallback !== null) return this.#fallback.pruneBodies();
    if (this.#state !== "open" || !this.#ready || this.#worker === null) return 0;
    const resp = await this.#request("prune");
    return resp.type === "pruned" ? resp.pruned : 0;
  }

  stats(): WriterStats {
    if (this.#fallback !== null) return this.#fallback.stats();
    return {
      queueDepth: this.#uncommitted.size,
      shedCount: this.#shedCount,
      flushCount: this.#flushCount,
      writtenCount: this.#writtenCount,
      inFlightBytes: this.#inFlightBytes,
    };
  }

  /* ------------------------------- private ------------------------------ */

  /** Start (or restart) the worker and hand it the writer config. */
  #spawn(): void {
    const generation = ++this.#generation;
    try {
      const worker = new Worker(new URL("./writer-worker.ts", import.meta.url).href);
      // Handlers are generation-guarded so a terminated worker's late `error` /
      // `close` events cannot be mistaken for a crash of its successor.
      const current = (): boolean => generation === this.#generation;
      worker.onmessage = (ev: MessageEvent) => {
        if (current()) this.#onMessage(ev.data as WriterResponse);
      };
      worker.onerror = (ev: ErrorEvent) => {
        if (current()) this.#onCrash(errorMessage(ev.error ?? ev));
      };
      worker.addEventListener("messageerror", () => {
        if (current()) this.#onCrash("worker messageerror");
      });
      // A worker that exits without an error event (abrupt thread death) would
      // otherwise leave `flush` waiting forever; treat a close as a crash too.
      worker.addEventListener("close", () => {
        if (current() && this.#state !== "closed") this.#onCrash("worker exited");
      });
      this.#worker = worker;
      worker.postMessage({ type: "init", config: this.#config } satisfies WriterRequest);
    } catch (err) {
      // Boot-time failure (nothing queued yet): degrade to in-process writes so
      // metadata is still recorded. A mid-flight respawn failure keeps the loud
      // path instead, because queued jobs cannot be moved across cleanly.
      if (this.#uncommitted.size === 0 && this.#fallback === null) {
        logger.error("turn writer could not start worker; writing in-process instead", {
          error: errorMessage(err),
        });
        this.#fallback = new InlineWriter(this.#config);
        return;
      }
      logger.error("turn writer could not start worker; jobs will queue", {
        error: errorMessage(err),
      });
    }
  }

  /** Detach handlers (invalidating them) and terminate the current worker. */
  #disposeWorker(): void {
    this.#generation += 1;
    const worker = this.#worker;
    this.#worker = null;
    if (!worker) return;
    worker.onmessage = null;
    worker.onerror = null;
    worker.terminate();
  }

  #onMessage(msg: WriterResponse): void {
    switch (msg.type) {
      case "ready":
        this.#ready = true;
        this.#crashes = 0;
        this.#repostPending();
        this.#pump();
        break;
      case "written":
        // The window slot is free; retirement from the budget waits on commit.
        this.#inflight.delete(msg.id);
        this.#pump();
        this.#checkDrained();
        break;
      case "committed":
        this.#flushCount = msg.flushCount;
        this.#retireCommitted(msg.ids);
        break;
      case "flushed":
        this.#flushCount = msg.flushCount;
        this.#resolveWaiter(msg.id, msg);
        break;
      case "pruned":
      case "closed":
        this.#resolveWaiter(msg.id, msg);
        break;
      case "error":
        logger.error("turn writer worker reported an error", {
          request: msg.id ?? -1,
          error: msg.message,
        });
        if (msg.id !== null) this.#resolveWaiter(msg.id, msg);
        break;
    }
  }

  /** Post queued jobs while there is room in the in-flight window. */
  #pump(): void {
    const worker = this.#worker;
    if (!worker || !this.#ready || this.#state === "closed") return;
    while (this.#queued.length > 0 && this.#inflight.size < DEFAULT_MAX_OUTSTANDING) {
      const env = this.#queued.shift();
      if (!env) break;
      const wire = env.wire;
      this.#inflight.set(wire.id, env);
      if (wire.kind === "prompt") {
        // No body, nothing transferable: the surface is structured-cloned.
        worker.postMessage({
          type: "prompt",
          id: wire.id,
          surface: wire.surface,
        } satisfies WriterRequest);
        continue;
      }
      const buffer = wire.body ? (wire.body.buffer as ArrayBuffer) : null;
      if (buffer) env.bodySent = true;
      worker.postMessage(
        { type: "job", id: wire.id, meta: wire.meta, body: buffer } satisfies WriterRequest,
        buffer ? [buffer] : [],
      );
    }
    this.#checkDrained();
  }

  /** Wait until nothing is queued or in flight. */
  #drainApplied(): Promise<void> {
    if (this.#queued.length === 0 && this.#inflight.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.#drainWaiters.push(resolve));
  }

  #checkDrained(): void {
    if (this.#queued.length > 0 || this.#inflight.size > 0) return;
    if (this.#drainWaiters.length === 0) return;
    const waiters = this.#drainWaiters;
    this.#drainWaiters = [];
    for (const w of waiters) w();
  }

  /** Retire jobs the worker reported committed, releasing their budget bytes. */
  #retireCommitted(ids: readonly number[]): void {
    for (const id of ids) {
      const env = this.#uncommitted.get(id);
      if (!env) continue;
      this.#uncommitted.delete(id);
      this.#writtenCount += 1;
      this.#inFlightBytes = Math.max(0, this.#inFlightBytes - env.bytes);
    }
  }

  /** Send a control request and resolve with the worker's reply. */
  #request(kind: "flush" | "prune" | "close"): Promise<WriterResponse> {
    const worker = this.#worker;
    if (!worker || !this.#ready) {
      return Promise.resolve({ type: "error", id: null, message: "worker not ready" });
    }
    const id = this.#requestSeq++;
    const request: WriterRequest =
      kind === "flush"
        ? { type: "flush", id }
        : kind === "prune"
          ? { type: "prune", id }
          : { type: "close", id };
    this.#pendingRequests.set(id, request);
    return new Promise<WriterResponse>((resolve) => {
      this.#waiters.set(id, resolve);
      worker.postMessage(request);
    });
  }

  /** Re-send every control request the dead worker never answered. */
  #repostPending(): void {
    const worker = this.#worker;
    if (!worker) return;
    for (const request of this.#pendingRequests.values()) worker.postMessage(request);
  }

  #resolveWaiter(id: number, msg: WriterResponse): void {
    this.#pendingRequests.delete(id);
    const waiter = this.#waiters.get(id);
    if (!waiter) return;
    this.#waiters.delete(id);
    waiter(msg);
  }

  /** Fail every outstanding waiter so a dying writer never hangs a caller. */
  #releaseWaiters(): void {
    for (const [id, waiter] of this.#waiters) {
      waiter({ type: "error", id, message: "turn writer closed" });
    }
    this.#waiters.clear();
    this.#pendingRequests.clear();
    this.#checkDrained();
  }

  /**
   * Recover from a worker crash with bounded backoff. Only COMMITTED rows are
   * durable, so every uncommitted job is re-queued: one whose body was
   * transferred out is rebuilt body-less and marked shed (the metadata still
   * lands), one still queued keeps its body.
   */
  #onCrash(reason: string): void {
    if (this.#state === "closed") return;
    this.#crashes += 1;
    this.#ready = false;
    const survivors = [...this.#uncommitted.values()].sort((a, b) => a.wire.id - b.wire.id);
    logger.error("turn writer worker crashed; respawning", {
      reason,
      crashes: this.#crashes,
      requeued: survivors.length,
    });
    const rebuilt: Envelope[] = [];
    for (const env of survivors) {
      const wire = env.wire;
      // A prompt sighting carries no body, so a crash can always re-send it
      // intact. Only a transferred turn body is lost.
      const bodyLost = wire.kind === "turn" && env.bodySent && wire.body !== null;
      if (bodyLost) this.#shedCount += 1;
      let next: WireJob = wire;
      if (bodyLost && wire.kind === "turn") {
        next = {
          kind: "turn",
          id: wire.id,
          meta: { ...wire.meta, bodyState: "shed" },
          body: null,
        };
      }
      rebuilt.push({ wire: next, bytes: bodyLost ? 0 : env.bytes, bodySent: false });
    }
    this.#inflight.clear();
    this.#queued = rebuilt;
    this.#uncommitted = new Map(rebuilt.map((env) => [env.wire.id, env]));
    this.#inFlightBytes = rebuilt.reduce((sum, env) => sum + env.bytes, 0);
    this.#disposeWorker();
    const delay = Math.min(50 * 2 ** Math.min(this.#crashes - 1, 7), 5_000);
    this.#respawnTimer = setTimeout(() => {
      this.#respawnTimer = null;
      if (this.#state !== "closed") this.#spawn();
    }, delay);
    this.#respawnTimer.unref();
  }
}

/* ------------------------------------------------------------------ *
 * Factory
 * ------------------------------------------------------------------ */

/** Construct the requested writer implementation. */
export function createWriter(config: WriterConfig, mode: WriterMode): TurnWriter {
  return mode === "inline" ? new InlineWriter(config) : new WorkerWriter(config);
}
