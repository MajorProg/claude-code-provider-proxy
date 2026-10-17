/**
 * Turn-writer tests (src/logging/writer.ts) — the InlineWriter fast path.
 *
 * The request path only ENQUEUES; the writer owns zstd compression, the atomic
 * per-turn body file and the batched SQLite index. `InlineWriter` runs that
 * `WriterCore` on the calling thread (production runs it in a Worker), so its
 * behavior is the same real compression + file + index code the Worker runs.
 *
 * Covered here:
 *   - a turn becomes a zstd body file plus an index row; flush drains;
 *   - the shed policy marks a body `shed` while metadata survives;
 *   - the per-turn cap drops the body WHOLE (marked `shed`), never corrupt JSON;
 *   - a body WRITE failure still records the row (metadata is never lost);
 *   - retention deletes old bodies and marks them `pruned`;
 *   - a prompt version is stored once and linked by every turn that ran it;
 *   - a hostile session id cannot escape the log root;
 *   - writes after close are dropped.
 *
 * Hermetic: temp directories only, never the repo `./logs`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { IndexDb } from "../src/logging/index-db.ts";
import type {
  PromptSurface,
  TurnRecord,
  WriterConfig,
  WriterJob,
} from "../src/logging/log-types.ts";
import { computePromptSurface } from "../src/logging/prompt-surface.ts";
import { InlineWriter, WorkerWriter, createWriter } from "../src/logging/writer.ts";

/** Bun's synchronous zstd API is absent from @types/bun — narrow it like src does. */
const zstd = Bun as unknown as { zstdDecompressSync(input: Uint8Array): Uint8Array };

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ccpp-logging-writer-"));
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
    // Large enough that the batch only commits when we flush explicitly.
    indexFlushMs: 60_000,
    zstdLevel: 3,
    compress: true,
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

describe("InlineWriter: body file + index row", () => {
  test("writes a zstd body file and an index row; flush drains the queue", async () => {
    const w = new InlineWriter(config());
    w.write(job("s1", 1));
    await w.flush();

    const db = reader();
    const turns = db.listTurns("s1");
    expect(turns).toHaveLength(1);
    const t = turns[0];
    expect(t?.bodyState).toBe("full");
    expect(t?.bodyFile?.startsWith("sessions/")).toBe(true);
    expect(t?.bodyBytes).toBeGreaterThan(0);

    const abs = join(root, t?.bodyFile ?? "");
    expect(existsSync(abs)).toBe(true);
    const raw = zstd.zstdDecompressSync(new Uint8Array(readFileSync(abs)));
    const parsed = JSON.parse(new TextDecoder().decode(raw)) as { sessionId: string };
    expect(parsed.sessionId).toBe("s1");

    db.close();
    await w.close();
  });

  test("the body file round-trips the full turn record", async () => {
    const w = new InlineWriter(config());
    const recorded = turn("s1", { stopReason: "tool_use" });
    w.write(job("s1", 1, { turn: recorded }));
    await w.flush();

    const db = reader();
    const rel = db.listTurns("s1")[0]?.bodyFile ?? "";
    const raw = zstd.zstdDecompressSync(new Uint8Array(readFileSync(join(root, rel))));
    expect(JSON.parse(new TextDecoder().decode(raw))).toEqual(recorded);

    db.close();
    await w.close();
  });
});

describe("InlineWriter: bounded capture on the write side", () => {
  test("under budget pressure a body is shed while its metadata survives", async () => {
    // A 16-byte in-flight budget: the first job's queued body exhausts it, so
    // the second job's body is shed before it is ever compressed.
    const w = new InlineWriter(config({ inFlightBudgetBytes: 16 }));
    w.write(job("s1", 1, { turn: turn("s1", { stopReason: "end_turn" }) }));
    w.write(job("s1", 2, { turn: turn("s1", { stopReason: "tool_use" }) }));
    await w.flush();

    const db = reader();
    const turns = db.listTurns("s1");
    expect(turns.map((t) => t.bodyState)).toEqual(["full", "shed"]);
    expect(turns[1]?.bodyFile).toBeNull();
    // Metadata is recorded regardless of the shed body.
    expect(turns[1]?.stopReason).toBe("tool_use");
    expect(turns[0]?.stopReason).toBe("end_turn");
    expect(w.stats().shedCount).toBe(1);

    db.close();
    await w.close();
  });

  test("a body over maxTurnBytes is dropped whole (marked shed), never stored corrupt", async () => {
    const w = new InlineWriter(config({ maxTurnBytes: 40 }));
    w.write(job("s1", 1));
    await w.flush();

    const db = reader();
    const t = db.listTurns("s1")[0];
    // A byte-clip of a JSON blob is not valid JSON, so the body is dropped
    // honestly: metadata survives, the payload is ABSENT, never unparseable.
    expect(t?.bodyState).toBe("shed");
    expect(t?.bodyFile).toBeNull();
    expect(t?.bodyBytes).toBeNull();
    // Metadata is still recorded.
    expect(t?.stopReason).toBe("end_turn");

    db.close();
    await w.close();
  });

  test("every stored body file is valid JSON (a record under the cap round-trips)", async () => {
    const w = new InlineWriter(config({ maxTurnBytes: 8 * 1024 * 1024 }));
    w.write(job("s1", 1));
    await w.flush();

    const db = reader();
    const t = db.listTurns("s1")[0];
    expect(t?.bodyState).toBe("full");
    const raw = zstd.zstdDecompressSync(
      new Uint8Array(readFileSync(join(root, t?.bodyFile ?? ""))),
    );
    // Parseable JSON, never a clipped prefix.
    expect(() => JSON.parse(new TextDecoder().decode(raw))).not.toThrow();

    db.close();
    await w.close();
  });

  test("a body WRITE failure still records the row, marked shed", async () => {
    const w = new InlineWriter(config());
    // Occupy the session directory path with a plain FILE so the body write
    // cannot create the directory — the row must still land.
    mkdirSync(join(root, "sessions"), { recursive: true });
    writeFileSync(join(root, "sessions", "blocked"), "not a directory");
    w.write(job("blocked", 1, { turn: turn("blocked", { stopReason: "end_turn" }) }));
    await w.flush();

    const db = reader();
    const t = db.listTurns("blocked")[0];
    expect(t?.bodyState).toBe("shed");
    expect(t?.bodyFile).toBeNull();
    expect(t?.stopReason).toBe("end_turn");

    db.close();
    await w.close();
  });
});

describe("InlineWriter: retention", () => {
  test("pruneBodies deletes bodies older than retentionDays and marks them pruned", async () => {
    const w = new InlineWriter(config({ retentionDays: 1 }));
    w.write(job("s1", 1, { turn: turn("s1", { requestedAt: "2020-01-01T00:00:00.000Z" }) }));
    await w.flush();

    const db = reader();
    const before = db.listTurns("s1")[0];
    const abs = join(root, before?.bodyFile ?? "");
    expect(existsSync(abs)).toBe(true);

    expect(await w.pruneBodies()).toBe(1);
    expect(existsSync(abs)).toBe(false);
    expect(db.getTurn("s1", 1)?.bodyState).toBe("pruned");

    db.close();
    await w.close();
  });
});

/** A minimal synthetic prompt surface (the writer only stores the parts). */
function surface(tag: string): PromptSurface {
  return {
    hash: `hash-${tag}`,
    systemJson: `"s-${tag}"`,
    toolsJson: "[]",
    injectedJson: "[]",
    systemBytes: 3,
    toolsBytes: 2,
  };
}

describe("InlineWriter: prompt versions", () => {
  test("the seen-count map is bounded: an evicted hash re-reads its count from the DB", async () => {
    const w = new InlineWriter(config());
    // More distinct surfaces than the bound (512): each is seen exactly once, so
    // the oldest are evicted from the in-memory map. bodyState "shed" avoids a
    // body file per turn — only the index rows and prompt versions matter here.
    const N = 600;
    for (let i = 0; i < N; i++) {
      w.write(job("s1", i + 1, { promptSurface: surface(String(i)), bodyState: "shed" }));
    }
    await w.flush();

    // surface "0" is the first inserted, so it was evicted. Re-seeing it must
    // continue from the stored count (1) — NOT restart at 1 — proving the bound
    // costs a re-read, never correctness.
    w.write(job("s1", N + 1, { promptSurface: surface("0"), bodyState: "shed" }));
    await w.flush();

    const db = reader();
    expect(db.getPromptVersionMeta("hash-0")?.seenCount).toBe(2);
    // A hash still resident in the map also kept counting.
    expect(db.getPromptVersionMeta("hash-599")?.seenCount).toBe(1);

    db.close();
    await w.close();
  });

  test("records a prompt version once and links every turn that ran it", async () => {
    const surface = computePromptSurface({
      system: "sys",
      tools: [{ name: "T", input_schema: { type: "object" } }],
      messages: [],
    });
    const w = new InlineWriter(config());
    w.write(job("s1", 1, { promptSurface: surface }));
    w.write(job("s1", 2, { promptSurface: surface }));
    await w.flush();

    const db = reader();
    const versions = db.listPromptVersions();
    expect(versions).toHaveLength(1);
    expect(versions[0]?.hash).toBe(surface.hash);
    expect(versions[0]?.seenCount).toBe(2);
    // The content is served by the detail read (the list is metadata-only).
    expect(db.getPromptVersion(surface.hash)?.toolsJson).toBe(surface.toolsJson);
    expect(db.listTurns("s1").map((t) => t.promptVersion)).toEqual([surface.hash, surface.hash]);

    db.close();
    await w.close();
  });
});

describe("InlineWriter: prompt-only jobs (chat-turn capture off)", () => {
  const surface = computePromptSurface({ system: "sys", tools: [], messages: [] });

  test("writePrompt records the version and no turn row or session", async () => {
    const w = new InlineWriter(config());
    w.writePrompt(surface);
    await w.flush();

    const db = reader();
    expect(db.listPromptVersions().map((v) => v.hash)).toEqual([surface.hash]);
    expect(db.listSessions()).toEqual([]);
    db.close();
    await w.close();
  });

  test("writePrompt after close is dropped, like write", async () => {
    const w = new InlineWriter(config());
    await w.close();
    w.writePrompt(surface);
    await w.flush();

    const db = reader();
    expect(db.listPromptVersions()).toEqual([]);
    db.close();
  });
});

describe("InlineWriter: safety + lifecycle", () => {
  test("a hostile session id is sanitized under the log root", async () => {
    const w = new InlineWriter(config());
    w.write(job("../../escape", 1));
    w.write(job("..", 1));
    await w.flush();

    const db = reader();
    const escaping = db.listTurns("../../escape")[0];
    const escapeRel = escaping?.bodyFile ?? "";
    expect(escapeRel.startsWith("sessions/")).toBe(true);
    expect(resolve(root, escapeRel).startsWith(resolve(root, "sessions"))).toBe(true);
    expect(existsSync(join(root, "..", "escape"))).toBe(false);

    const dotdot = db.listTurns("..")[0];
    expect(dotdot?.bodyFile?.startsWith("sessions/unknown/")).toBe(true);

    db.close();
    await w.close();
  });

  test("write after close is dropped", async () => {
    const w = new InlineWriter(config());
    await w.close();
    w.write(job("s1", 1));
    await w.flush();

    const db = reader();
    expect(db.listTurns("s1")).toHaveLength(0);
    db.close();
  });

  test("createWriter('inline') returns an InlineWriter", async () => {
    const w = createWriter(config(), "inline");
    expect(w).toBeInstanceOf(InlineWriter);
    await w.close();
  });
});

describe("WorkerWriter: degraded startup", () => {
  test("writes in-process rather than queueing forever when no Worker can start", async () => {
    // A runtime that cannot construct a Worker at all. Without the fallback the
    // writer accepts jobs and never drains them, so every turn's metadata — the
    // one thing the index must never lose — would be silently discarded.
    const RealWorker = globalThis.Worker;
    class UnavailableWorker {
      constructor() {
        throw new Error("workers unavailable in this runtime");
      }
    }
    (globalThis as unknown as { Worker: unknown }).Worker = UnavailableWorker;
    try {
      const w = createWriter(config(), "worker");
      expect(w).toBeInstanceOf(WorkerWriter);
      w.write(job("s-fallback", 1));
      await w.flush();
      await w.close();
    } finally {
      (globalThis as unknown as { Worker: unknown }).Worker = RealWorker;
    }

    const db = reader();
    expect(db.listTurns("s-fallback").map((t) => t.seq)).toEqual([1]);
    db.close();
  });
});
