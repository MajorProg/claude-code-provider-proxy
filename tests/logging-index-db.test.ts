import { Database } from "bun:sqlite";
/**
 * SQLite turn-index tests (src/logging/index-db.ts).
 *
 * The index replaces the old per-session `_summary.json` whole-file rewrite
 * (O(N) bytes/turn, O(N^2)/session) with a real SQLite database. These tests
 * exercise the real `bun:sqlite` code against throwaway temp databases:
 *   - schema + the deliberate `journal_mode = DELETE` (WAL is unsafe on the
 *     Docker bind mount the logs live on);
 *   - batched, single-transaction inserts and the read queries the viewers use;
 *   - `statsForPromptVersion`, including the ordered tool-call shape;
 *   - retention marking (prune) and its no-op when disabled;
 *   - the durable-metadata guarantee: a failed batch is spooled to
 *     `index-spool.jsonl` and replayed on the next open.
 *
 * Hermetic: temp directories only, never the repo `./logs`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IndexDb, type TurnRow } from "../src/logging/index-db.ts";
import type { PromptVersionRecord } from "../src/logging/log-types.ts";

let root: string;
let indexPath: string;
let spoolPath: string;
let open: IndexDb[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ccpp-logging-index-"));
  indexPath = join(root, "index.db");
  spoolPath = join(root, "index-spool.jsonl");
  open = [];
});

afterEach(() => {
  for (const db of open) {
    try {
      db.close();
    } catch {
      // already closed — nothing to do
    }
  }
  rmSync(root, { recursive: true, force: true });
});

/** Open the index and track it for teardown; the caller still gets the handle. */
function db(): IndexDb {
  const handle = new IndexDb(indexPath, { spoolPath });
  open.push(handle);
  return handle;
}

/** A turn row with sensible defaults; `over` overrides individual columns. */
function row(sessionId: string, seq: number, over: Partial<TurnRow> = {}): TurnRow {
  const stamp = String(seq).padStart(2, "0");
  return {
    sessionId,
    seq,
    requestedAt: `2026-09-12T10:00:${stamp}.000Z`,
    respondedAt: `2026-09-12T10:00:${stamp}.500Z`,
    modelRequested: "bedrock.converse.global.model-x",
    modelServed: "model-x",
    backend: "converse",
    path: "converse",
    promptVersion: "H1",
    stopReason: "end_turn",
    inputTokens: 10,
    outputTokens: 5,
    ...over,
  };
}

function promptRecord(over: Partial<PromptVersionRecord> = {}): PromptVersionRecord {
  return {
    hash: "H1",
    createdAt: "2026-09-12T10:00:00.000Z",
    lastSeen: "2026-09-12T10:00:00.000Z",
    seenCount: 1,
    systemJson: '"sys"',
    toolsJson: "[]",
    injectedJson: "[]",
    systemBytes: 5,
    toolsBytes: 2,
    ...over,
  };
}

describe("schema + pragmas", () => {
  test("creates the four tables and the four indexes", () => {
    db();
    const probe = new Database(indexPath);
    const tables = (
      probe.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string;
      }[]
    )
      .map((t) => t.name)
      .sort();
    // `sqlite_sequence` is the AUTOINCREMENT bookkeeping table SQLite maintains.
    expect(tables).toEqual([
      "failover_events",
      "prompt_versions",
      "sessions",
      "sqlite_sequence",
      "turns",
    ]);

    const indexes = (
      probe
        .query("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'")
        .all() as { name: string }[]
    )
      .map((i) => i.name)
      .sort();
    expect(indexes).toEqual([
      "idx_turns_model_served",
      "idx_turns_prompt_version",
      "idx_turns_requested_at",
      "idx_turns_session_seq",
    ]);
    probe.close();
  });

  test("uses journal_mode=DELETE (never WAL) on the bind-mount-hosted database", () => {
    db();
    const probe = new Database(indexPath);
    const mode = probe.query("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(mode.journal_mode).toBe("delete");
    probe.close();
  });
});

describe("batched writes + idempotency", () => {
  test("insertTurnRows inserts a batch and returns its ids in input order", () => {
    const index = db();
    const ids = index.insertTurnRows([row("s1", 1), row("s1", 2), row("s2", 1)]);
    expect(ids).toHaveLength(3);
    expect(ids[0]).toBe(1);
    expect(ids[1]).toBe(2);
    expect(ids[2]).toBe(3);
    expect(index.listTurns("s1").map((t) => t.seq)).toEqual([1, 2]);
  });

  test("a re-insert of an existing (session_id, seq) is ignored and its id re-read", () => {
    const index = db();
    const first = index.insertTurnRows([row("s1", 1)]);
    const second = index.insertTurnRows([row("s1", 1)]);
    expect(second).toEqual(first);
    expect(index.listTurns("s1")).toHaveLength(1);
  });

  test("an empty batch is a no-op returning no ids", () => {
    const index = db();
    expect(index.insertTurnRows([])).toEqual([]);
  });
});

describe("read queries", () => {
  test("getTurn maps columns to TurnMeta (failover bool, parsed toolCalls, typed error class)", () => {
    const index = db();
    index.insertTurnRows([
      row("s1", 1, {
        failover: true,
        toolCalls: ["Read", "Bash"],
        errorClass: "rate_limit",
        cacheReadTokens: 3,
        latencyMs: 123,
        bodyFile: "sessions/s1/00001.json.zst",
        bodyBytes: 99,
        bodyState: "full",
      }),
    ]);
    const t = index.getTurn("s1", 1);
    expect(t).not.toBeNull();
    expect(t?.turnId).toBe(1);
    expect(t?.failover).toBe(true);
    expect(t?.toolCalls).toEqual(["Read", "Bash"]);
    expect(t?.errorClass).toBe("rate_limit");
    expect(t?.cacheReadTokens).toBe(3);
    expect(t?.latencyMs).toBe(123);
    expect(t?.bodyFile).toBe("sessions/s1/00001.json.zst");
    expect(t?.bodyBytes).toBe(99);
    expect(t?.bodyState).toBe("full");
    expect(index.getTurn("s1", 999)).toBeNull();
  });

  test("listTurns honors order and limit/offset", () => {
    const index = db();
    index.insertTurnRows([row("s1", 1), row("s1", 2), row("s1", 3)]);
    expect(index.listTurns("s1").map((t) => t.seq)).toEqual([1, 2, 3]);
    expect(index.listTurns("s1", { order: "desc" }).map((t) => t.seq)).toEqual([3, 2, 1]);
    expect(index.listTurns("s1", { limit: 1, offset: 1 }).map((t) => t.seq)).toEqual([2]);
  });

  test("upsertSessions derives the rollup from the authoritative turns rows", () => {
    const index = db();
    index.insertTurnRows([
      row("s1", 1, {
        requestedAt: "2026-09-12T10:00:00.000Z",
        respondedAt: "2026-09-12T10:00:01.000Z",
        inputTokens: 10,
        outputTokens: 5,
      }),
      row("s1", 2, {
        requestedAt: "2026-09-12T10:01:00.000Z",
        respondedAt: "2026-09-12T10:01:01.000Z",
        inputTokens: 20,
        outputTokens: 7,
      }),
    ]);
    index.upsertSessions(["s1"]);
    const sessions = index.listSessions();
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    expect(s?.id).toBe("s1");
    expect(s?.turnCount).toBe(2);
    expect(s?.inputTokens).toBe(30);
    expect(s?.outputTokens).toBe(12);
    expect(s?.firstAt).toBe("2026-09-12T10:00:00.000Z");
    expect(s?.lastAt).toBe("2026-09-12T10:01:01.000Z");
  });

  test("prompt versions upsert preserves created_at and reconstitutes full content", () => {
    const index = db();
    index.upsertPromptVersions([
      promptRecord({ seenCount: 1, createdAt: "2026-01-01T00:00:00.000Z" }),
    ]);
    index.upsertPromptVersions([
      promptRecord({
        seenCount: 5,
        createdAt: "2026-01-01T00:00:00.000Z",
        lastSeen: "2026-02-01T00:00:00.000Z",
        systemJson: '"new sys"',
      }),
    ]);
    const rec = index.getPromptVersion("H1");
    expect(rec?.seenCount).toBe(5);
    expect(rec?.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(rec?.lastSeen).toBe("2026-02-01T00:00:00.000Z");
    expect(rec?.systemJson).toBe('"new sys"');
    expect(index.listPromptVersions().map((r) => r.hash)).toEqual(["H1"]);
    expect(index.getPromptVersion("missing")).toBeNull();
  });
});

describe("statsForPromptVersion", () => {
  test("aggregates turns, sessions, tokens, latency, stop reasons, failures and tool shape", () => {
    const index = db();
    index.insertTurnRows([
      row("A", 1, {
        promptVersion: "H1",
        modelServed: "m1",
        stopReason: "end_turn",
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 2,
        latencyMs: 100,
        toolCalls: ["Read", "Bash"],
      }),
      row("B", 1, {
        promptVersion: "H1",
        modelServed: "m1",
        stopReason: "tool_use",
        inputTokens: 20,
        outputTokens: 7,
        cacheReadTokens: 0,
        latencyMs: 300,
        toolCalls: ["Read"],
        errorClass: "rate_limit",
      }),
    ]);
    const stats = index.statsForPromptVersion("H1");
    expect(stats.turns).toBe(2);
    expect(stats.sessions).toBe(2);
    expect(stats.modelsServed).toEqual(["m1"]);
    expect(stats.inputTokens).toBe(30);
    expect(stats.outputTokens).toBe(12);
    expect(stats.cacheReadTokens).toBe(2);
    expect(stats.latency).toEqual({ minMs: 100, maxMs: 300, avgMs: 200 });
    expect(stats.stopReasons).toEqual({ end_turn: 1, tool_use: 1 });
    expect(stats.failures).toEqual({ rate_limit: 1 });
    expect(stats.toolCallShape).toEqual([
      { tool: "Read", count: 2 },
      { tool: "Bash", count: 1 },
    ]);
  });

  test("a hash with no turns yields a zeroed record, not null", () => {
    const index = db();
    const stats = index.statsForPromptVersion("nope");
    expect(stats.turns).toBe(0);
    expect(stats.sessions).toBe(0);
    expect(stats.latency).toEqual({ minMs: 0, maxMs: 0, avgMs: 0 });
    expect(stats.toolCallShape).toEqual([]);
    expect(stats.stopReasons).toEqual({});
    expect(stats.failures).toEqual({});
  });

  test("comparePromptVersions builds a tool-presence matrix across versions", () => {
    const index = db();
    index.insertTurnRows([
      row("A", 1, { promptVersion: "H1", toolCalls: ["Read", "Grep"] }),
      row("A", 2, { promptVersion: "H1", toolCalls: ["Read"] }),
      row("B", 1, { promptVersion: "H2", toolCalls: ["Grep", "Write"] }),
    ]);
    const cmp = index.comparePromptVersions(["H1", "H2"]);
    expect(cmp.hashes).toEqual(["H1", "H2"]);
    expect(cmp.versions.map((v) => v.turns)).toEqual([2, 1]);
    expect(cmp.tools).toEqual([
      { tool: "Grep", counts: [1, 1] },
      { tool: "Read", counts: [2, 0] },
      { tool: "Write", counts: [0, 1] },
    ]);
  });
});

describe("retention marking", () => {
  test("pruneBodiesOlderThan marks old bodies pruned and returns their files", () => {
    const index = db();
    index.insertTurnRows([
      row("s1", 1, {
        requestedAt: "2026-01-01T00:00:00.000Z",
        bodyFile: "sessions/s1/old.json.zst",
        bodyBytes: 10,
        bodyState: "full",
      }),
      row("s1", 2, {
        requestedAt: "2026-10-14T00:00:00.000Z",
        bodyFile: "sessions/s1/new.json.zst",
        bodyBytes: 10,
        bodyState: "full",
      }),
    ]);
    const result = index.pruneBodiesOlderThan(30, new Date("2026-10-15T00:00:00.000Z"));
    expect(result.pruned).toBe(1);
    expect(result.files).toEqual(["sessions/s1/old.json.zst"]);
    expect(index.getTurn("s1", 1)?.bodyState).toBe("pruned");
    expect(index.getTurn("s1", 2)?.bodyState).toBe("full");
  });

  test("pruneBodiesOlderThan(0) is a no-op (retention off keeps bodies forever)", () => {
    const index = db();
    index.insertTurnRows([
      row("s1", 1, {
        requestedAt: "2000-01-01T00:00:00.000Z",
        bodyFile: "sessions/s1/ancient.json.zst",
        bodyState: "full",
      }),
    ]);
    expect(index.pruneBodiesOlderThan(0, new Date("2026-10-15T00:00:00.000Z"))).toEqual({
      files: [],
      pruned: 0,
    });
    expect(index.getTurn("s1", 1)?.bodyState).toBe("full");
  });
});

describe("durable metadata (spool + replay)", () => {
  test("a failed batch is spooled and replayed on the next open", () => {
    const first = db();
    first.insertTurnRows([row("s1", 1)]);
    expect(first.listTurns("s1")).toHaveLength(1);
    first.close();

    // Simulate a write failure: the closed handle rejects the statement, so the
    // batch must be spooled rather than lost (and NOT thrown).
    const ids = first.insertTurnRows([row("s1", 2)]);
    expect(ids).toEqual([]);
    expect(existsSync(spoolPath)).toBe(true);

    // A fresh open replays the spool and clears it.
    const second = db();
    expect(second.listTurns("s1").map((t) => t.seq)).toEqual([1, 2]);
    expect(existsSync(spoolPath)).toBe(false);
  });

  test("replay re-derives the sessions rollup for the turns it restores", () => {
    // A flush can spool its turn rows while the `sessions` rollup in the same
    // batch is derived without them, so the rollup reaching disk is short. Here
    // the whole batch spools, leaving turn rows with no sessions row at all.
    const broken = db();
    broken.close();
    expect(broken.insertTurnRows([row("s1", 1)])).toEqual([]);
    expect(existsSync(spoolPath)).toBe(true);

    // `turnCount` is read from the STORED `sessions.turns` column rather than
    // counted live, so a rollup that is never re-derived does not merely
    // under-count — the session is missing from listings entirely.
    const reopened = db();
    expect(reopened.listTurns("s1").map((t) => t.seq)).toEqual([1]);
    const listed = reopened.listSessions().find((s) => s.id === "s1");
    expect(listed?.turnCount).toBe(1);
  });

  test("replaySpool drops unparseable lines and applies valid ones", () => {
    writeFileSync(
      spoolPath,
      `${JSON.stringify({ kind: "turns", payload: [row("s1", 1)] })}\nthis is not json\n`,
    );
    const index = db();
    expect(index.listTurns("s1").map((t) => t.seq)).toEqual([1]);
    expect(existsSync(spoolPath)).toBe(false);
  });
});

describe("in-memory index", () => {
  test("':memory:' works and disables spooling", () => {
    const index = new IndexDb(":memory:");
    open.push(index);
    expect(index.insertTurnRows([row("s1", 1)])).toEqual([1]);
    expect(index.listTurns("s1")).toHaveLength(1);
    expect(() => index.close()).not.toThrow();
    expect(() => index.close()).not.toThrow();
  });
});
