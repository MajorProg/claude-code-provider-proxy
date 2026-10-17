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
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IndexDb, type TurnRow } from "../src/logging/index-db.ts";
import type {
  PromptPartRef,
  PromptVersionRecord,
  PromptVersionWrite,
} from "../src/logging/log-types.ts";

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

/** sha256 of a canonical part string, matching the writer's content addressing. */
function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** A content-addressed part ref built from a canonical string. */
function ref(content: string): PromptPartRef {
  return { hash: sha256(content), content, bytes: Buffer.byteLength(content, "utf8") };
}

/** A part-ref prompt-version write, as the writer stages it. */
function version(
  hash: string,
  system: string,
  tools: string,
  injected: string,
  over: Partial<PromptVersionWrite> = {},
): PromptVersionWrite {
  return {
    hash,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastSeen: "2026-01-01T00:00:00.000Z",
    seenCount: 1,
    systemBytes: Buffer.byteLength(system, "utf8"),
    toolsBytes: Buffer.byteLength(tools, "utf8"),
    system: ref(system),
    tools: ref(tools),
    injected: ref(injected),
    ...over,
  };
}

describe("schema + pragmas", () => {
  test("creates the tables and the indexes (minus the redundant session-seq index)", () => {
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
      "prompt_parts",
      "prompt_version_content",
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
    // idx_turns_session_seq is deliberately ABSENT — it duplicated the auto-index.
    expect(indexes).toEqual([
      "idx_turns_model_served",
      "idx_turns_prompt_version",
      "idx_turns_requested_at",
    ]);
    probe.close();
  });

  test("the redundant session-seq index is dropped and the auto-index serves lookups", () => {
    const index = db();
    const probe = new Database(indexPath);
    // Gone from sqlite_master entirely.
    const named = probe
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_turns_session_seq'",
      )
      .all() as { name: string }[];
    expect(named).toEqual([]);

    // The UNIQUE(session_id, seq) auto-index still backs both point and range
    // lookups, so the DROP costs nothing.
    const planOf = (sql: string, ...params: string[]): string =>
      (probe.query(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[])
        .map((r) => r.detail)
        .join(" | ");
    const getTurnPlan = planOf("SELECT * FROM turns WHERE session_id = ? AND seq = ?", "s1", "1");
    expect(getTurnPlan).toContain("sqlite_autoindex_turns_1");
    expect(getTurnPlan).not.toContain("idx_turns_session_seq");
    const listPlan = planOf("SELECT * FROM turns WHERE session_id = ? ORDER BY seq ASC", "s1");
    expect(listPlan).toContain("sqlite_autoindex_turns_1");
    // The rollup's derive/repair query filters + groups by session_id, so it too
    // rides the auto-index.
    const rollupPlan = planOf(
      "SELECT session_id, MIN(requested_at), MAX(COALESCE(responded_at, requested_at)), " +
        "COUNT(*) FROM turns WHERE session_id = ? GROUP BY session_id",
      "s1",
    );
    expect(rollupPlan).toContain("sqlite_autoindex_turns_1");

    // Sanity: the index still reads the rows it always did.
    index.insertTurnRows([row("s1", 1)]);
    expect(index.getTurn("s1", 1)?.seq).toBe(1);
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
    const result = index.insertTurnRows([row("s1", 1), row("s1", 2), row("s2", 1)]);
    expect(result.ids).toHaveLength(3);
    expect(result.ids[0]).toBe(1);
    expect(result.ids[1]).toBe(2);
    expect(result.ids[2]).toBe(3);
    expect(index.listTurns("s1").map((t) => t.seq)).toEqual([1, 2]);
    // The incremental rollup travels with the inserts: no explicit upsertSessions.
    expect(result.sessions.get("s1")).toEqual({
      firstSeen: "2026-09-12T10:00:01.000Z",
      lastSeen: "2026-09-12T10:00:02.500Z",
      inserted: 2,
    });
    const sessions = index.listSessions();
    expect(sessions.find((s) => s.id === "s1")?.turnCount).toBe(2);
    expect(sessions.find((s) => s.id === "s2")?.turnCount).toBe(1);
  });

  test("a re-insert of an existing (session_id, seq) is ignored and its id re-read", () => {
    const index = db();
    const first = index.insertTurnRows([row("s1", 1)]);
    const second = index.insertTurnRows([row("s1", 1)]);
    expect(second.ids).toEqual(first.ids);
    expect(index.listTurns("s1")).toHaveLength(1);
  });

  test("an empty batch is a no-op returning no ids", () => {
    const index = db();
    const result = index.insertTurnRows([]);
    expect(result.ids).toEqual([]);
    expect(result.sessions.size).toBe(0);
  });

  test("the incremental rollup accumulates across batches and clamps with MIN/MAX", () => {
    const index = db();
    index.insertTurnRows([
      row("s1", 1, {
        requestedAt: "2026-09-12T10:00:00.000Z",
        respondedAt: "2026-09-12T10:00:01.000Z",
      }),
    ]);
    index.insertTurnRows([
      row("s1", 2, {
        requestedAt: "2026-09-12T11:00:00.000Z",
        respondedAt: "2026-09-12T11:00:05.000Z",
      }),
    ]);
    const s = index.listSessions().find((x) => x.id === "s1");
    expect(s?.turnCount).toBe(2);
    expect(s?.firstAt).toBe("2026-09-12T10:00:00.000Z");
    expect(s?.lastAt).toBe("2026-09-12T11:00:05.000Z");
  });

  test("out-of-order replay moves first_seen back via MIN, never forward", () => {
    const index = db();
    // A LATER turn lands first, then an EARLIER one arrives (a delayed replay).
    index.insertTurnRows([
      row("s1", 2, {
        requestedAt: "2026-09-12T11:00:00.000Z",
        respondedAt: "2026-09-12T11:00:01.000Z",
      }),
    ]);
    index.insertTurnRows([
      row("s1", 1, {
        requestedAt: "2026-09-12T09:00:00.000Z",
        respondedAt: "2026-09-12T09:00:01.000Z",
      }),
    ]);
    const s = index.listSessions().find((x) => x.id === "s1");
    expect(s?.firstAt).toBe("2026-09-12T09:00:00.000Z");
    expect(s?.lastAt).toBe("2026-09-12T11:00:01.000Z");
    expect(s?.turnCount).toBe(2);
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

describe("content-addressed prompt storage", () => {
  test("versions sharing a byte-identical tools part store ONE prompt_parts row for tools", () => {
    const index = db();
    const sharedTools = '[{"name":"Read","input_schema":{"type":"object"}}]';
    index.upsertPromptVersions([
      version("H1", '"sys-A"', sharedTools, "[]"),
      version("H2", '"sys-B"', sharedTools, "[]"),
    ]);

    const probe = new Database(indexPath);
    // Distinct parts stored: sys-A, sys-B, tools, injected = 4 rows. The shared
    // tools part collapses to one.
    const total = probe.query("SELECT COUNT(*) AS c FROM prompt_parts").get() as { c: number };
    expect(total.c).toBe(4);
    const toolsRows = probe
      .query("SELECT COUNT(*) AS c FROM prompt_parts WHERE part_hash = ?")
      .get(sha256(sharedTools)) as { c: number };
    expect(toolsRows.c).toBe(1);
    // Each version maps to exactly one content row.
    const contentRows = probe.query("SELECT COUNT(*) AS c FROM prompt_version_content").get() as {
      c: number;
    };
    expect(contentRows.c).toBe(2);
    probe.close();

    // Both versions still read back their EXACT content, parts-first.
    expect(index.getPromptVersion("H1")?.systemJson).toBe('"sys-A"');
    expect(index.getPromptVersion("H2")?.systemJson).toBe('"sys-B"');
    expect(index.getPromptVersion("H1")?.toolsJson).toBe(sharedTools);
    expect(index.getPromptVersion("H2")?.toolsJson).toBe(sharedTools);
  });

  test("a legacy prompt_versions row with inline JSON and no content row reads correctly", () => {
    const index = db();
    // Write a LEGACY row straight into the table: inline JSON, no parts row.
    const probe = new Database(indexPath);
    probe
      .query(
        `INSERT INTO prompt_versions
           (hash, created_at, last_seen, seen_count, system_json, tools_json, injected_json,
            system_bytes, tools_bytes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "LEGACY",
        "2026-01-01T00:00:00.000Z",
        "2026-02-01T00:00:00.000Z",
        7,
        '"legacy sys"',
        '[{"name":"T"}]',
        '["injected"]',
        12,
        15,
      );
    probe.close();

    const rec = index.getPromptVersion("LEGACY");
    expect(rec?.systemJson).toBe('"legacy sys"');
    expect(rec?.toolsJson).toBe('[{"name":"T"}]');
    expect(rec?.injectedJson).toBe('["injected"]');
    expect(rec?.seenCount).toBe(7);
    expect(rec?.lastSeen).toBe("2026-02-01T00:00:00.000Z");

    // The metadata-only accessor works without a content row too.
    const meta = index.getPromptVersionMeta("LEGACY");
    expect(meta?.hash).toBe("LEGACY");
    expect(meta?.systemBytes).toBe(12);
    expect(meta?.toolsBytes).toBe(15);
  });

  test("listPromptVersions is metadata-only; getPromptVersion carries the content", () => {
    const index = db();
    index.upsertPromptVersions([version("H1", '"s"', "[1,2]", '["inj"]')]);
    const list = index.listPromptVersions();
    expect(list).toHaveLength(1);
    const m = list[0];
    expect(m?.hash).toBe("H1");
    expect(m?.seenCount).toBe(1);
    expect(m?.toolsBytes).toBe(5);
    // The metadata shape carries NO content fields.
    expect(Object.keys(m ?? {})).not.toContain("toolsJson");
    // The full record still does.
    expect(index.getPromptVersion("H1")?.toolsJson).toBe("[1,2]");
    expect(index.getPromptVersionMeta("H1")?.hash).toBe("H1");
  });

  test("a legacy prompt_versions spool line (inline JSON) replays via normalization", () => {
    const legacy = {
      hash: "LSPOOL",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastSeen: "2026-01-01T00:00:00.000Z",
      seenCount: 3,
      systemJson: '"legacy-system"',
      toolsJson: '["tool"]',
      injectedJson: "[]",
      systemBytes: 15,
      toolsBytes: 8,
    };
    writeFileSync(spoolPath, `${JSON.stringify({ kind: "prompt_versions", payload: [legacy] })}\n`);

    const index = db();
    const rec = index.getPromptVersion("LSPOOL");
    expect(rec?.systemJson).toBe('"legacy-system"');
    expect(rec?.toolsJson).toBe('["tool"]');
    expect(rec?.seenCount).toBe(3);
    // The replayed legacy record was migrated to content addressing.
    const probe = new Database(indexPath);
    const contentRows = probe.query("SELECT COUNT(*) AS c FROM prompt_version_content").get() as {
      c: number;
    };
    expect(contentRows.c).toBe(1);
    probe.close();
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

  test("retention NEVER ages out the prompt library, however old it is", () => {
    const index = db();
    // A prompt version dated 2000 and a turn body dated 2000, under a 1-day
    // retention window: the BODY must age out, the prompt must not. System
    // prompts and tool schemas are permanent records — `retentionDays` applies
    // to turn bodies only.
    index.upsertPromptVersions([
      promptRecord({
        createdAt: "2000-01-01T00:00:00.000Z",
        lastSeen: "2000-01-01T00:00:00.000Z",
        systemJson: '"immortal system"',
        toolsJson: '[{"name":"Read"}]',
      }),
    ]);
    index.insertTurnRows([
      row("s1", 1, {
        requestedAt: "2000-01-01T00:00:00.000Z",
        bodyFile: "sessions/s1/ancient.json.zst",
        bodyBytes: 10,
        bodyState: "full",
        promptVersion: "H1",
      }),
    ]);

    const result = index.pruneBodiesOlderThan(1, new Date("2026-10-15T00:00:00.000Z"));
    expect(result.pruned).toBe(1);
    expect(index.getTurn("s1", 1)?.bodyState).toBe("pruned");

    // Metadata AND content survive, byte for byte.
    expect(index.listPromptVersions().map((v) => v.hash)).toEqual(["H1"]);
    expect(index.getPromptVersion("H1")?.systemJson).toBe('"immortal system"');
    expect(index.getPromptVersion("H1")?.toolsJson).toBe('[{"name":"Read"}]');
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
    const ids = first.insertTurnRows([row("s1", 2)]).ids;
    expect(ids).toEqual([]);
    expect(existsSync(spoolPath)).toBe(true);

    // A fresh open replays the spool and clears it.
    const second = db();
    expect(second.listTurns("s1").map((t) => t.seq)).toEqual([1, 2]);
    expect(existsSync(spoolPath)).toBe(false);
  });

  test("replay re-derives the rollup for restored turns, and a re-landed batch never double-counts", () => {
    // A flush can spool its turn rows while the `sessions` rollup in the same
    // batch is derived without them, so the rollup reaching disk is short. Here
    // the whole batch spools, leaving turn rows with no sessions row at all.
    const broken = db();
    broken.close();
    expect(broken.insertTurnRows([row("s1", 1)]).ids).toEqual([]);
    expect(existsSync(spoolPath)).toBe(true);

    // `turnCount` is read from the STORED `sessions.turns` column rather than
    // counted live, so a rollup that is never re-derived does not merely
    // under-count — the session is missing from listings entirely.
    const reopened = db();
    expect(reopened.listTurns("s1").map((t) => t.seq)).toEqual([1]);
    expect(reopened.listSessions().find((s) => s.id === "s1")?.turnCount).toBe(1);
    reopened.close();

    // IDEMPOTENCY (the one that matters): the SAME batch is spooled again even
    // though its row already landed. Replaying a batch that already landed must
    // leave `sessions.turns` unchanged — the insert is ignored (changes === 0)
    // and contributes nothing to the rollup.
    writeFileSync(spoolPath, `${JSON.stringify({ kind: "turns", payload: [row("s1", 1)] })}\n`);
    const again = db();
    expect(again.listTurns("s1").map((t) => t.seq)).toEqual([1]);
    expect(again.listSessions().find((s) => s.id === "s1")?.turnCount).toBe(1);
  });

  test("re-inserting an already-landed turn does not double-count the session", () => {
    const index = db();
    index.insertTurnRows([row("s1", 1)]);
    const second = index.insertTurnRows([row("s1", 1)]);
    // Nothing was inserted this batch, so no rollup delta was produced.
    expect(second.sessions.get("s1")).toBeUndefined();
    expect(index.listSessions().find((s) => s.id === "s1")?.turnCount).toBe(1);
  });

  test("commitFlush writes turns, the rollup and prompts in ONE transaction", () => {
    const index = db();
    const result = index.commitFlush(
      [row("s1", 1), row("s1", 2)],
      [
        {
          hash: "H1",
          createdAt: "2026-09-12T10:00:00.000Z",
          lastSeen: "2026-09-12T10:00:00.000Z",
          seenCount: 1,
          systemBytes: 3,
          toolsBytes: 2,
          system: { hash: "ps", content: '"s"', bytes: 3 },
          tools: { hash: "pt", content: "[]", bytes: 2 },
          injected: { hash: "pi", content: "[]", bytes: 2 },
        },
      ],
    );
    expect(result.ids).toHaveLength(2);
    expect(index.listSessions().find((s) => s.id === "s1")?.turnCount).toBe(2);
    expect(index.getPromptVersion("H1")?.systemJson).toBe('"s"');
  });

  test("a failed atomic flush spools BOTH the turn and prompt entry kinds", () => {
    const index = db();
    index.close();
    const result = index.commitFlush([row("s1", 1)], [version("H1", '"s"', "[]", "[]")]);
    expect(result.ids).toEqual([]);
    expect(existsSync(spoolPath)).toBe(true);
    const kinds = readFileSync(spoolPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { kind: string }).kind)
      .sort();
    expect(kinds).toEqual(["prompt_versions", "turns"]);
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
    expect(index.insertTurnRows([row("s1", 1)]).ids).toEqual([1]);
    expect(index.listTurns("s1")).toHaveLength(1);
    expect(() => index.close()).not.toThrow();
    expect(() => index.close()).not.toThrow();
  });
});

/* ------------------------------------------------------------------ *
 * Schema safety: opening an index.db written by the EARLIER schema.
 *
 * The content-addressing change (prompt_parts / prompt_version_content) adds
 * only new TABLES — there is no column migration — so an old index.db is opened
 * by `CREATE TABLE IF NOT EXISTS`. This block builds a faithful OLD-schema
 * database (the four original tables, a legacy inline-JSON prompt_versions row,
 * a turn, and the redundant session-seq index) and asserts that the new code
 * (a) adds the two content tables, (b) retires the redundant index, (c) reads
 * the OLD rows correctly, and (d) throws nothing and spools nothing.
 * ------------------------------------------------------------------ */
describe("opening a pre-content-addressing index.db", () => {
  function buildOldSchemaDb(): void {
    const raw = new Database(indexPath);
    raw.run(`CREATE TABLE turns (
      turn_id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL, seq INTEGER NOT NULL, requested_at TEXT NOT NULL,
      responded_at TEXT, model_requested TEXT, model_served TEXT, backend TEXT,
      path TEXT, prompt_version TEXT, stop_reason TEXT, input_tokens INTEGER,
      output_tokens INTEGER, cache_read_tokens INTEGER, latency_ms INTEGER,
      failover INTEGER, error_class TEXT, body_file TEXT, body_bytes INTEGER,
      body_state TEXT, tool_calls TEXT, subagent_of INTEGER, UNIQUE(session_id, seq))`);
    // The legacy redundant index the new DROP_SQL retires.
    raw.run("CREATE INDEX idx_turns_session_seq ON turns(session_id, seq)");
    raw.run(`CREATE TABLE prompt_versions (
      hash TEXT PRIMARY KEY, created_at TEXT, last_seen TEXT, seen_count INTEGER,
      system_json TEXT, tools_json TEXT, injected_json TEXT, system_bytes INTEGER,
      tools_bytes INTEGER)`);
    raw.run(
      "CREATE TABLE sessions (session_id TEXT PRIMARY KEY, first_seen TEXT, last_seen TEXT, turns INTEGER)",
    );
    raw.run(`CREATE TABLE failover_events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT, turn_id INTEGER,
      from_label TEXT, to_label TEXT, reason TEXT)`);
    raw
      .query(
        `INSERT INTO prompt_versions
           (hash, created_at, last_seen, seen_count, system_json, tools_json, injected_json,
            system_bytes, tools_bytes)
         VALUES ('OLDPV', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 3,
                 '"old sys"', '[{"n":1}]', '["inj"]', 9, 12)`,
      )
      .run();
    raw
      .query(
        `INSERT INTO turns (session_id, seq, requested_at, model_requested, prompt_version)
         VALUES ('s-old', 1, '2026-01-01T00:00:00.000Z', 'bedrock.converse.global.m', 'OLDPV')`,
      )
      .run();
    raw.close();
  }

  test("adds content tables, retires the redundant index, reads legacy rows, spools nothing", () => {
    buildOldSchemaDb();
    const index = db(); // opening an old db must not throw

    const probe = new Database(indexPath);
    const tables = (
      probe.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string;
      }[]
    ).map((t) => t.name);
    expect(tables).toContain("prompt_parts");
    expect(tables).toContain("prompt_version_content");
    const retired = probe
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_turns_session_seq'",
      )
      .all();
    expect(retired).toHaveLength(0);
    probe.close();

    // OLD rows read correctly through the NEW queries.
    const turns = index.listTurns("s-old");
    expect(turns).toHaveLength(1);
    expect(turns[0]?.promptVersion).toBe("OLDPV");
    const rec = index.getPromptVersion("OLDPV");
    expect(rec?.systemJson).toBe('"old sys"'); // legacy inline fallback
    expect(rec?.toolsJson).toBe('[{"n":1}]');
    expect(rec?.injectedJson).toBe('["inj"]');
    expect(rec?.seenCount).toBe(3);
    expect(index.getPromptVersionMeta("OLDPV")?.toolsBytes).toBe(12);
    expect(index.statsForPromptVersion("OLDPV").turns).toBe(1);

    // Nothing landed in the spool.
    expect(existsSync(spoolPath)).toBe(false);
  });
});
