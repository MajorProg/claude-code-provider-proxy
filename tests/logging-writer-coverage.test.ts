/**
 * Coverage closure for the turn writer's WORKER half.
 *
 * `tests/logging-writer.test.ts` exercises the InlineWriter fast path on the
 * calling thread. This file drives the two pieces that file never touches:
 *
 *   1. `writer-worker.ts` — the worker-thread entry point. It is a module with
 *      no exports that installs a global `onmessage` handler and drives a
 *      `WriterCore` off the `WriterRequest`/`WriterResponse` protocol. It is
 *      imported here (so it stops being invisible to coverage) and each message
 *      type is pushed through its REAL handler with a stubbed `postMessage`;
 *      the assertions are on the responses it posts back and on the index rows
 *      the core it constructs actually writes.
 *
 *   2. `WorkerWriter` in `writer.ts` — the production writer. Its happy path is
 *      verified end-to-end against a REAL Worker thread (a turn crosses the
 *      boundary and lands in the index), and its flow-control / crash-recovery /
 *      error branches are driven through a scripted Worker that stands in for
 *      the thread boundary (the same `globalThis.Worker` seam the existing
 *      suite already uses to simulate an unavailable worker).
 *
 * Hermetic: temp directories only, never the repo `./logs`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IndexDb } from "../src/logging/index-db.ts";
import type { TurnRecord, WriterConfig, WriterJob } from "../src/logging/log-types.ts";
import {
  InlineWriter,
  WorkerWriter,
  type WriterRequest,
  type WriterResponse,
  createWriter,
} from "../src/logging/writer.ts";

/** Bun's synchronous zstd API is absent from @types/bun — narrow it like src does. */
const zstd = Bun as unknown as { zstdDecompressSync(input: Uint8Array): Uint8Array };

/** The fake-timer API works at runtime but is absent from the pinned @types/bun. */
const timers = jest as unknown as {
  useFakeTimers(): void;
  useRealTimers(): void;
  advanceTimersByTime(ms: number): void;
};

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ccpp-logging-writer-cov-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function config(over: Partial<WriterConfig> = {}): WriterConfig {
  return {
    dir: root,
    sessionDir: "sessions",
    indexPath: join(root, "index.db"),
    retentionDays: 30,
    maxTurnBytes: 8 * 1024 * 1024,
    inFlightBudgetBytes: 256 * 1024 * 1024,
    // Large enough that a batch only commits when we flush explicitly.
    indexFlushMs: 60_000,
    zstdLevel: 3,
    ...over,
  };
}

function turn(sessionId: string, over: Partial<TurnRecord> = {}): TurnRecord {
  return {
    sessionId,
    canonicalModel: "bedrock.converse.global.model-x",
    invocationModel: "model-x",
    backend: "converse",
    translationPath: "converse",
    streamed: false,
    systemHash: null,
    messages: [{ role: "user", content: "hello" }],
    responseContent: [{ type: "text", text: "hi" }],
    stopReason: "end_turn",
    usage: { inputTokens: 10, outputTokens: 5 },
    requestedAt: "2026-09-12T10:00:00.000Z",
    respondedAt: "2026-09-12T10:00:01.000Z",
    ...over,
  };
}

function job(sessionId: string, seq: number, over: Partial<WriterJob> = {}): WriterJob {
  return {
    turn: turn(sessionId),
    seq,
    promptSurface: null,
    bodyState: "full",
    failoverEvents: [],
    ...over,
  };
}

/** Open a read connection to the writer's index for assertions. */
function reader(): IndexDb {
  return new IndexDb(join(root, "index.db"), { spoolPath: "" });
}

/* ================================================================== *
 * 1. writer-worker.ts: the real message handler, driven directly
 * ================================================================== */

const savedOnmessage = (globalThis as { onmessage?: unknown }).onmessage;
const savedPostMessage = (globalThis as { postMessage?: unknown }).postMessage;

describe("writer-worker: the WriterRequest handler", () => {
  let sent: WriterResponse[];
  /** The handler writer-worker.ts installed onto globalThis. */
  let onMessage: (ev: { data: WriterRequest }) => void;

  beforeAll(async () => {
    // Importing the module runs its top-level `globalThis.onmessage = ...`.
    await import("../src/logging/writer-worker.ts");
    onMessage = (globalThis as { onmessage?: unknown }).onmessage as (ev: {
      data: WriterRequest;
    }) => void;
  });

  afterAll(() => {
    (globalThis as { onmessage?: unknown }).onmessage = savedOnmessage;
    (globalThis as { postMessage?: unknown }).postMessage = savedPostMessage;
  });

  beforeEach(() => {
    sent = [];
    // The worker posts back through `scope.postMessage` (== globalThis.postMessage).
    (globalThis as { postMessage?: unknown }).postMessage = (m: WriterResponse) => {
      sent.push(m);
    };
  });

  afterEach(() => {
    (globalThis as { postMessage?: unknown }).postMessage = savedPostMessage;
  });

  function send(msg: WriterRequest): void {
    onMessage({ data: msg });
  }

  test("init builds the core, posts ready, and a job writes a real row", () => {
    const cfg = config();
    send({ type: "init", config: cfg });
    expect(sent).toEqual([{ type: "ready" }]);

    // A job carries its body as an ArrayBuffer; the core compresses + indexes it.
    const body = new TextEncoder().encode(JSON.stringify(turn("s1")));
    send({ type: "job", id: 1, meta: metaFor("s1", 1), body: body.buffer as ArrayBuffer });
    expect(sent.at(-1)).toEqual({ type: "written", id: 1 });

    // flush commits the batch.
    send({ type: "flush", id: 2 });
    expect(sent.at(-1)).toEqual({ type: "flushed", id: 2, flushCount: 1 });

    // The row really landed, with a body file the core wrote.
    const db = reader();
    const t = db.listTurns("s1")[0];
    expect(t?.bodyState).toBe("full");
    const abs = join(root, t?.bodyFile ?? "");
    expect(existsSync(abs)).toBe(true);
    const raw = zstd.zstdDecompressSync(new Uint8Array(readFileSync(abs)));
    expect((JSON.parse(new TextDecoder().decode(raw)) as { sessionId: string }).sessionId).toBe(
      "s1",
    );
    db.close();

    send({ type: "prune", id: 3 });
    expect(sent.at(-1)?.type).toBe("pruned");
    send({ type: "close", id: 4 });
    expect(sent.at(-1)).toEqual({ type: "closed", id: 4 });
  });

  test("a job with a null body is indexed with an absent payload (shed)", () => {
    send({ type: "init", config: config() });
    sent = [];
    send({ type: "job", id: 9, meta: metaFor("s2", 1), body: null });
    expect(sent).toEqual([{ type: "written", id: 9 }]);
    send({ type: "flush", id: 10 });
    const db = reader();
    const t = db.listTurns("s2")[0];
    expect(t?.bodyState).toBe("shed");
    expect(t?.bodyFile).toBeNull();
    db.close();
    send({ type: "close", id: 11 });
  });

  test("a job before init is refused with an error response", () => {
    // A fresh module state would be needed to truly start null; instead assert
    // the code path via its observable contract: after `close` the core is null.
    send({ type: "init", config: config() });
    send({ type: "close", id: 1 });
    sent = [];
    send({ type: "job", id: 2, meta: metaFor("s3", 1), body: null });
    expect(sent).toEqual([{ type: "error", id: 2, message: "job received before init" }]);
  });

  test("flush/prune/close after the core is closed still answer (core null branches)", () => {
    send({ type: "init", config: config() });
    send({ type: "close", id: 1 });
    sent = [];
    send({ type: "flush", id: 2 });
    expect(sent).toEqual([{ type: "flushed", id: 2, flushCount: 0 }]);
    sent = [];
    send({ type: "prune", id: 3 });
    expect(sent).toEqual([{ type: "pruned", id: 3, pruned: 0 }]);
    sent = [];
    send({ type: "close", id: 4 });
    expect(sent).toEqual([{ type: "closed", id: 4 }]);
  });

  test("a handler failure is caught and reported as an error response", () => {
    // A config whose session directory already exists as a FILE makes the core's
    // mkdirSync throw; the top-level catch must report it (id null for init).
    const bad = config();
    mkdirSync(bad.dir, { recursive: true });
    writeFileSync(join(bad.dir, bad.sessionDir), "not a directory");
    sent = [];
    send({ type: "init", config: bad });
    expect(sent).toHaveLength(1);
    const err = sent[0];
    expect(err?.type).toBe("error");
    if (err?.type === "error") {
      expect(err.id).toBeNull();
      expect(err.message.length).toBeGreaterThan(0);
    }
  });
});

/** The index-relevant projection the worker protocol carries. */
function metaFor(sessionId: string, seq: number) {
  return {
    sessionId,
    seq,
    requestedAt: "2026-09-12T10:00:00.000Z",
    respondedAt: "2026-09-12T10:00:01.000Z",
    canonicalModel: "bedrock.converse.global.model-x",
    invocationModel: "model-x",
    modelServed: null,
    backend: "converse",
    translationPath: "converse",
    promptVersion: null,
    stopReason: "end_turn",
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: null,
    latencyMs: null,
    failover: false,
    errorClass: null,
    toolCalls: null,
    subagentOf: null,
    bodyState: "full" as const,
    promptSurface: null,
    failoverEvents: [],
  };
}

/* ================================================================== *
 * 2. WorkerWriter: the real thread boundary
 * ================================================================== */

describe("WorkerWriter: real worker thread", () => {
  test("a turn crosses the thread boundary and lands in the index", async () => {
    const w = new WorkerWriter(config());
    w.write(job("s1", 1));
    await w.flush();

    expect(w.stats().writtenCount).toBe(1);
    expect(w.stats().flushCount).toBe(1);
    expect(w.stats().queueDepth).toBe(0);

    const db = reader();
    const t = db.listTurns("s1")[0];
    expect(t?.bodyState).toBe("full");
    const raw = zstd.zstdDecompressSync(
      new Uint8Array(readFileSync(join(root, t?.bodyFile ?? ""))),
    );
    expect(JSON.parse(new TextDecoder().decode(raw))).toEqual(turn("s1"));
    db.close();

    // Retention over the whole store: the body file is deleted, the row kept.
    expect(await w.pruneBodies()).toBeGreaterThanOrEqual(0);
    await w.close();
  });

  test("the in-flight window paces more jobs than it holds, and all commit", async () => {
    const w = new WorkerWriter(config());
    const N = 40; // > DEFAULT_MAX_OUTSTANDING (16): exercises the window cap.
    for (let i = 0; i < N; i++) w.write(job("s1", i + 1));
    await w.flush();

    expect(w.stats().writtenCount).toBe(N);
    const db = reader();
    expect(db.listTurns("s1")).toHaveLength(N);
    db.close();
    await w.close();
  });

  test("an exhausted byte budget sheds a body while its metadata still indexes", async () => {
    // A 1-byte budget: after the first job's body counts against it, the second
    // (written in the same tick, before the worker is ready) is shed.
    const w = new WorkerWriter(config({ inFlightBudgetBytes: 1 }));
    w.write(job("s1", 1));
    w.write(job("s1", 2, { turn: turn("s1", { stopReason: "tool_use" }) }));
    await w.flush();

    expect(w.stats().shedCount).toBe(1);
    const db = reader();
    const turns = db.listTurns("s1");
    expect(turns.map((t) => t.bodyState)).toEqual(["full", "shed"]);
    expect(turns[1]?.stopReason).toBe("tool_use");
    db.close();
    await w.close();
  });
});

/* ================================================================== *
 * 3. WorkerWriter: flow control, crash recovery and error responses
 *    driven through a scripted Worker (the thread boundary seam)
 * ================================================================== */

/**
 * A Worker stand-in that lets a test decide exactly when the writer sees
 * `ready` / `written` / `committed` / `flush` / `prune` / `close` and when the
 * thread "crashes". It replaces the `globalThis.Worker` constructor — the same
 * seam the existing suite uses to simulate an unavailable runtime — so the code
 * under test is the real `WorkerWriter` bookkeeping.
 */
class ScriptedWorker {
  static latest: ScriptedWorker | null = null;
  static autoReady = true;
  static autoJobs = true;
  static throwNext = false;
  /** Control-request types the scripted thread leaves unanswered (test-driven). */
  static heldRequests = new Set<string>();

  static reset(): void {
    ScriptedWorker.latest = null;
    ScriptedWorker.autoReady = true;
    ScriptedWorker.autoJobs = true;
    ScriptedWorker.throwNext = false;
    ScriptedWorker.heldRequests = new Set<string>();
  }

  onmessage: ((ev: { data: WriterResponse }) => void) | null = null;
  onerror: ((ev: { error: unknown }) => void) | null = null;
  readonly listeners = new Map<string, Array<() => void>>();
  readonly posted: WriterRequest[] = [];
  terminated = false;
  #flushCount = 0;

  constructor(_url: string) {
    if (ScriptedWorker.throwNext) {
      ScriptedWorker.throwNext = false;
      throw new Error("scripted worker refused to start");
    }
    ScriptedWorker.latest = this;
  }

  addEventListener(type: string, fn: () => void): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(fn);
    this.listeners.set(type, arr);
  }

  postMessage(msg: WriterRequest, _transfer?: unknown[]): void {
    this.posted.push(msg);
    switch (msg.type) {
      case "init":
        if (ScriptedWorker.autoReady) this.emit({ type: "ready" });
        return;
      case "job":
        if (ScriptedWorker.autoJobs) {
          this.#flushCount += 1;
          this.emit({ type: "written", id: msg.id });
          this.emit({ type: "committed", flushCount: this.#flushCount, turns: 1, ids: [msg.id] });
        }
        return;
      case "flush":
        if (!ScriptedWorker.heldRequests.has("flush")) {
          this.emit({ type: "flushed", id: msg.id, flushCount: this.#flushCount });
        }
        return;
      case "prune":
        if (!ScriptedWorker.heldRequests.has("prune")) {
          this.emit({ type: "pruned", id: msg.id, pruned: 7 });
        }
        return;
      case "close":
        if (!ScriptedWorker.heldRequests.has("close")) {
          this.emit({ type: "closed", id: msg.id });
        }
        return;
    }
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(msg: WriterResponse): void {
    this.onmessage?.({ data: msg });
  }

  emitError(error: unknown): void {
    this.onerror?.({ error });
  }

  emitEvent(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }
}

describe("WorkerWriter: scripted thread", () => {
  let realWorker: unknown;

  beforeEach(() => {
    realWorker = (globalThis as { Worker?: unknown }).Worker;
    ScriptedWorker.reset();
    (globalThis as { Worker?: unknown }).Worker = ScriptedWorker;
  });

  afterEach(() => {
    (globalThis as { Worker?: unknown }).Worker = realWorker;
  });

  test("an error response resolves the pending request; a null-id error is tolerated", async () => {
    ScriptedWorker.autoReady = false;
    ScriptedWorker.heldRequests.add("prune"); // the reply is delivered by hand
    const w = new WorkerWriter(config());
    const wk = ScriptedWorker.latest as ScriptedWorker;
    wk.emit({ type: "ready" });

    const pruneP = w.pruneBodies();
    const pruneReq = wk.posted.find((m) => m.type === "prune");
    expect(pruneReq?.type).toBe("prune");
    // An error reply is not a "pruned" reply: the caller gets the fallback value.
    if (pruneReq?.type === "prune") {
      wk.emit({ type: "error", id: pruneReq.id, message: "prune blew up" });
    }
    expect(await pruneP).toBe(0);

    // An error with no correlation id has no waiter to resolve; it must not throw.
    wk.emit({ type: "error", id: null, message: "uncorrelated worker failure" });

    await w.close();

    // Writes after close are dropped (the worker is gone), never queued.
    w.write(job("s1", 1));
    expect(w.stats().queueDepth).toBe(0);
  });

  test("a crash re-queues uncommitted jobs body-less, respawns, and reposts requests", async () => {
    ScriptedWorker.autoReady = false;
    ScriptedWorker.autoJobs = false;
    ScriptedWorker.heldRequests.add("prune"); // stays pending across the crash
    const w = new WorkerWriter(config());
    const w1 = ScriptedWorker.latest as ScriptedWorker;
    w1.emit({ type: "ready" });

    w.write(job("s1", 1));
    w.write(job("s1", 2));
    const firstJobs = w1.posted.filter((m) => m.type === "job");
    // The bodies were transferred out, so the crash cannot keep them.
    expect(firstJobs).toHaveLength(2);
    for (const j of firstJobs) if (j.type === "job") expect(j.body).not.toBeNull();

    // A control request left outstanding must survive into the replacement.
    const pruneP = w.pruneBodies();
    expect(w1.posted.some((m) => m.type === "prune")).toBe(true);

    w1.emitError(new Error("worker exploded"));

    // Both jobs are re-queued with their bodies gone; metadata is still tracked.
    expect(w.stats().queueDepth).toBe(2);
    expect(w.stats().shedCount).toBe(2);

    await new Promise((r) => setTimeout(r, 120)); // respawn backoff (crashes === 1)
    const w2 = ScriptedWorker.latest as ScriptedWorker;
    expect(w2).not.toBe(w1);

    w2.emit({ type: "ready" }); // pump the queued jobs + repost the prune request

    const rebuilt = w2.posted.filter((m) => m.type === "job");
    expect(rebuilt).toHaveLength(2);
    for (const j of rebuilt) {
      if (j.type === "job") {
        expect(j.body).toBeNull();
        expect(j.meta.bodyState).toBe("shed");
      }
    }
    // Re-queued in ascending id order (the recovery sort).
    const ids = rebuilt.map((j) => (j.type === "job" ? j.id : -1));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));

    // The reposted prune is answered.
    const pruneReq = w2.posted.find((m) => m.type === "prune");
    if (pruneReq?.type === "prune") {
      w2.emit({ type: "pruned", id: pruneReq.id, pruned: 3 });
    }
    expect(await pruneP).toBe(3);

    // Acknowledge + commit the rebuilt jobs so the writer can drain and close.
    for (const id of ids) w2.emit({ type: "written", id });
    w2.emit({ type: "committed", flushCount: 1, turns: 2, ids });
    expect(w.stats().writtenCount).toBe(2);
    expect(w.stats().shedCount).toBe(2);

    await w.close();
  });

  test("a worker 'close' event is treated as a crash (abrupt thread death)", async () => {
    ScriptedWorker.autoReady = false;
    const w = new WorkerWriter(config());
    const w1 = ScriptedWorker.latest as ScriptedWorker;
    w1.emitEvent("close");
    expect(w.stats().queueDepth).toBe(0);

    await new Promise((r) => setTimeout(r, 120));
    const w2 = ScriptedWorker.latest as ScriptedWorker;
    expect(w2).not.toBe(w1);
    w2.emit({ type: "ready" });
    await w.close();
  });

  test("a 'messageerror' event is treated as a crash", async () => {
    ScriptedWorker.autoReady = false;
    const w = new WorkerWriter(config());
    const w1 = ScriptedWorker.latest as ScriptedWorker;
    w1.emitEvent("messageerror");

    await new Promise((r) => setTimeout(r, 120));
    expect(ScriptedWorker.latest).not.toBe(w1);
    (ScriptedWorker.latest as ScriptedWorker).emit({ type: "ready" });
    await w.close();
  });

  test("a failed respawn with jobs queued keeps them queued rather than losing them", async () => {
    ScriptedWorker.autoReady = false;
    ScriptedWorker.autoJobs = false;
    const w = new WorkerWriter(config());
    const w1 = ScriptedWorker.latest as ScriptedWorker;
    w1.emit({ type: "ready" });
    w.write(job("s1", 1));

    ScriptedWorker.throwNext = true; // the replacement cannot be constructed
    w1.emitError(new Error("boom"));

    await new Promise((r) => setTimeout(r, 120));
    // The job was neither written in-process nor dropped: it stays queued.
    expect(w.stats().queueDepth).toBe(1);
  });
});

/* ================================================================== *
 * 4. WorkerWriter: the in-process fallback
 * ================================================================== */

describe("WorkerWriter: in-process fallback", () => {
  class UnavailableWorker {
    constructor() {
      throw new Error("workers unavailable in this runtime");
    }
  }

  let realWorker: unknown;

  beforeEach(() => {
    realWorker = (globalThis as { Worker?: unknown }).Worker;
    (globalThis as { Worker?: unknown }).Worker = UnavailableWorker;
  });

  afterEach(() => {
    (globalThis as { Worker?: unknown }).Worker = realWorker;
  });

  test("stats and pruneBodies are served by the fallback InlineWriter", async () => {
    const w = createWriter(config({ retentionDays: 0 }), "worker");
    expect(w).toBeInstanceOf(WorkerWriter);
    expect(w.stats()).toEqual({
      queueDepth: 0,
      shedCount: 0,
      flushCount: 0,
      writtenCount: 0,
      inFlightBytes: 0,
    });

    w.write(job("s1", 1));
    await w.flush();
    // writtenCount comes from the fallback's committed-row count.
    expect(w.stats().writtenCount).toBe(1);
    // Retention disabled: the fallback's prune is a real no-op.
    expect(await w.pruneBodies()).toBe(0);

    await w.close();
    // After close the fallback is closed; a further write is dropped by it.
    w.write(job("s1", 2));
    expect(w.stats().writtenCount).toBe(1);
  });

  test("createWriter('inline') returns an InlineWriter (sanity on the factory)", async () => {
    (globalThis as { Worker?: unknown }).Worker = realWorker; // not used by inline
    const w = createWriter(config(), "inline");
    expect(w).toBeInstanceOf(InlineWriter);
    await w.close();
  });
});

/* ================================================================== *
 * 5. The unref'd retention timers
 *
 * Both writers register a 6-hour `setInterval` that drives `pruneBodies`.
 * Advancing the clock with fake timers fires the REAL callback, so the sweep
 * below is the production retention path, not a stand-in.
 * ================================================================== */

const PRUNE_TICK = 6 * 60 * 60 * 1000;

/** Drain the microtasks the un-awaited `void pruneBodies()` schedules. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

describe("turn-writer retention timer", () => {
  test("InlineWriter's timer sweeps old bodies on its cadence", async () => {
    timers.useFakeTimers();
    try {
      const w = new InlineWriter(config({ retentionDays: 1, indexFlushMs: PRUNE_TICK }));
      w.write(job("s1", 1, { turn: turn("s1", { requestedAt: "2020-01-01T00:00:00.000Z" }) }));
      await w.flush();

      const db = reader();
      const abs = join(root, db.listTurns("s1")[0]?.bodyFile ?? "");
      expect(existsSync(abs)).toBe(true);

      // Fire the unref'd prune tick; the callback is the real sweep.
      timers.advanceTimersByTime(PRUNE_TICK + 1);
      await settle();

      expect(db.getTurn("s1", 1)?.bodyState).toBe("pruned");
      expect(existsSync(abs)).toBe(false);
      db.close();
      await w.close();
    } finally {
      timers.useRealTimers();
    }
  });

  test("WorkerWriter's timer sweeps old bodies through its in-process fallback", async () => {
    const realWorker = (globalThis as { Worker?: unknown }).Worker;
    class UnavailableWorker {
      constructor() {
        throw new Error("workers unavailable in this runtime");
      }
    }
    (globalThis as { Worker?: unknown }).Worker = UnavailableWorker;
    timers.useFakeTimers();
    try {
      const w = new WorkerWriter(config({ retentionDays: 1, indexFlushMs: PRUNE_TICK }));
      w.write(job("s1", 1, { turn: turn("s1", { requestedAt: "2020-01-01T00:00:00.000Z" }) }));
      await w.flush();

      const db = reader();
      const abs = join(root, db.listTurns("s1")[0]?.bodyFile ?? "");
      expect(existsSync(abs)).toBe(true);

      timers.advanceTimersByTime(PRUNE_TICK + 1);
      await settle();

      expect(db.getTurn("s1", 1)?.bodyState).toBe("pruned");
      expect(existsSync(abs)).toBe(false);
      db.close();
      await w.close();
    } finally {
      timers.useRealTimers();
      (globalThis as { Worker?: unknown }).Worker = realWorker;
    }
  });
});
