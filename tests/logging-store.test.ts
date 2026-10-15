/**
 * LogStore tests (src/logging/log-store.ts) — the request-path seam.
 *
 * LogStore is deliberately thin: the WRITE side is enqueue-only (no
 * compression, no file write, no SQLite on the caller's thread) and the READ
 * side is served from the SQLite index, with each body decompressed on demand.
 * These tests drive the real store over throwaway temp directories:
 *   - recordTurn returns without committing anything (the row appears on flush);
 *   - listTurns / getTurn / getTurnBody round-trip a turn through zstd unchanged;
 *   - an over-cap body is ABSENT (never corrupt), its metadata intact;
 *   - a pruned (or missing) body reads back as absent, never throwing;
 *   - sessions aggregate; a prompt surface is stored once and linked;
 *   - a disabled store — and an unwritable dir — are safe no-ops.
 *
 * Hermetic: temp directories only, never the repo `./logs`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoggingConfig } from "../src/config.ts";
import { IndexDb } from "../src/logging/index-db.ts";
import { LogStore } from "../src/logging/log-store.ts";
import type { TurnRecord } from "../src/logging/log-types.ts";
import { computePromptSurface } from "../src/logging/prompt-surface.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ccpp-logging-store-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function logConfig(over: Partial<LoggingConfig> = {}): LoggingConfig {
  return {
    enabled: true,
    dir: root,
    systemDir: "system",
    sessionDir: "sessions",
    captureTimeoutMs: 120_000,
    // ACCEPTED-AND-IGNORED: bodies are zstd-compressed at write now.
    compression: { enabled: false, minAgeMinutes: 10 },
    retentionDays: 30,
    maxTurnBytes: 8 * 1024 * 1024,
    inFlightBudgetBytes: 256 * 1024 * 1024,
    // Large enough that a commit only happens on an explicit flush.
    indexFlushMs: 60_000,
    zstdLevel: 3,
    ...over,
  };
}

/** A store on the inline writer (deterministic; the Worker is exercised by the app). */
function store(over: Partial<LoggingConfig> = {}): LogStore {
  return new LogStore(logConfig(over), { writerMode: "inline" });
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

describe("LogStore: the write path is enqueue-only", () => {
  test("recordTurn does not commit; the row appears only after flush", async () => {
    const s = store();
    await s.recordTurn(turn("s1"));
    // No commit has happened (indexFlushMs is large and nothing forced a batch).
    expect(await s.listTurns("s1")).toHaveLength(0);
    await s.flush();
    expect(await s.listTurns("s1")).toHaveLength(1);
    await s.close();
  });

  test("getTurnBody returns null before the body is committed", async () => {
    const s = store();
    await s.recordTurn(turn("s1"));
    expect(await s.getTurnBody("s1", 1)).toBeNull();
    await s.flush();
    expect(await s.getTurnBody("s1", 1)).not.toBeNull();
    await s.close();
  });
});

describe("LogStore: read path", () => {
  test("listTurns / getTurnBody round-trip a turn through zstd unchanged", async () => {
    const s = store();
    const recorded = turn("s1");
    await s.recordTurn(recorded);
    await s.flush();

    const metas = await s.listTurns("s1");
    expect(metas).toHaveLength(1);
    expect(metas[0]?.seq).toBe(1);
    expect(metas[0]?.bodyState).toBe("full");
    expect(await s.getTurnBody("s1", 1)).toEqual(recorded);
    await s.close();
  });

  test("listSessions aggregates turn counts and token totals", async () => {
    const s = store();
    await s.recordTurn(
      turn("s-a", {
        requestedAt: "2026-09-12T10:00:00.000Z",
        respondedAt: "2026-09-12T10:00:01.000Z",
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
    );
    await s.recordTurn(
      turn("s-a", {
        requestedAt: "2026-09-12T10:01:00.000Z",
        respondedAt: "2026-09-12T10:01:01.000Z",
        usage: { inputTokens: 20, outputTokens: 7 },
      }),
    );
    await s.recordTurn(
      turn("s-b", {
        requestedAt: "2026-09-12T11:00:00.000Z",
        respondedAt: "2026-09-12T11:00:01.000Z",
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    );
    await s.flush();

    const sessions = await s.listSessions();
    expect(sessions.map((x) => x.id)).toEqual(["s-b", "s-a"]); // last-seen desc
    const a = sessions.find((x) => x.id === "s-a");
    expect(a?.turnCount).toBe(2);
    expect(a?.inputTokens).toBe(30);
    expect(a?.outputTokens).toBe(12);
    expect(a?.firstAt).toBe("2026-09-12T10:00:00.000Z");
    expect(a?.lastAt).toBe("2026-09-12T10:01:01.000Z");
    await s.close();
  });

  test("a pruned body reads back as absent, and the index row survives", async () => {
    const s = store();
    await s.recordTurn(turn("s1"));
    await s.flush();

    // Retention has no public store method; the writer's prune is exercised in
    // the writer suite. Here we prune the index + delete the file directly.
    const db = new IndexDb(join(root, "index.db"), { spoolPath: "" });
    const result = db.pruneBodiesOlderThan(30, new Date("2999-01-01T00:00:00.000Z"));
    for (const f of result.files) rmSync(join(root, f), { force: true });
    db.close();

    expect(await s.getTurnBody("s1", 1)).toBeNull();
    const metas = await s.listTurns("s1");
    expect(metas).toHaveLength(1);
    expect(metas[0]?.bodyState).toBe("pruned");
    await s.close();
  });

  test("a missing body file reads back as absent without throwing", async () => {
    const s = store();
    await s.recordTurn(turn("s1"));
    await s.flush();
    const metas = await s.listTurns("s1");
    rmSync(join(root, metas[0]?.bodyFile ?? ""), { force: true });
    expect(await s.getTurnBody("s1", 1)).toBeNull();
    await s.close();
  });

  test("getTurn returns one turn's metadata by (sessionId, seq)", async () => {
    const s = store();
    await s.recordTurn(turn("s1"));
    await s.flush();
    const meta = await s.getTurn("s1", 1);
    expect(meta?.seq).toBe(1);
    expect(meta?.bodyState).toBe("full");
    expect(await s.getTurn("s1", 999)).toBeNull();
    await s.close();
  });

  test("messagesOmitted rides inside the body blob and round-trips", async () => {
    const s = store();
    const recorded = turn("s1", {
      messagesOmitted: { inboundBytes: 12_345, limitBytes: 8_192 },
    });
    await s.recordTurn(recorded);
    await s.flush();
    expect(await s.getTurnBody("s1", 1)).toEqual(recorded);
    await s.close();
  });

  test("an over-cap body is ABSENT (never corrupt) while its metadata survives", async () => {
    const s = store({ maxTurnBytes: 200 });
    await s.recordTurn(turn("s1", { messages: [{ role: "user", content: "x".repeat(2_000) }] }));
    await s.flush();

    const metas = await s.listTurns("s1");
    expect(metas).toHaveLength(1);
    // The body was over the cap, so it is dropped whole — marked shed, no file.
    expect(metas[0]?.bodyState).toBe("shed");
    expect(metas[0]?.bodyFile).toBeNull();
    // The payload is absent, never an unparseable (corrupt) body.
    expect(await s.getTurnBody("s1", 1)).toBeNull();
    expect(metas[0]?.stopReason).toBe("end_turn");
    await s.close();
  });

  test("a prompt surface is stored once, linked, and queryable with stats", async () => {
    const s = store();
    const surface = computePromptSurface({
      system: "sys",
      tools: [{ name: "Read", input_schema: { type: "object" } }],
      messages: [],
    });
    await s.recordTurn(turn("s1", { promptSurface: surface, toolCalls: ["Read"] }));
    await s.flush();

    const versions = await s.listPromptVersions();
    expect(versions).toHaveLength(1);
    expect(versions[0]?.hash).toBe(surface.hash);
    const rec = await s.getPromptVersion(surface.hash);
    expect(rec?.systemJson).toBe(surface.systemJson);
    expect(rec?.toolsJson).toBe(surface.toolsJson);
    const stats = await s.statsForPromptVersion(surface.hash);
    expect(stats.turns).toBe(1);
    expect(stats.toolCallShape).toEqual([{ tool: "Read", count: 1 }]);
    expect((await s.listTurns("s1"))[0]?.promptVersion).toBe(surface.hash);
    await s.close();
  });
});

describe("LogStore: system-only prompt fallback", () => {
  test("recordSystemPrompt is stable and links the following turn", async () => {
    const s = store();
    const h1 = await s.recordSystemPrompt("You are terse.");
    const h2 = await s.recordSystemPrompt("You are terse.");
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);

    await s.recordTurn(turn("s1", { systemHash: h1 }));
    await s.flush();
    expect((await s.listTurns("s1"))[0]?.promptVersion).toBe(h1);
    await s.close();
  });

  test("a null/absent system records nothing", async () => {
    const s = store();
    expect(await s.recordSystemPrompt(null)).toBeNull();
    expect(await s.recordSystemPrompt(undefined)).toBeNull();
    expect(await s.recordSystemPrompt("")).toBeNull();
    await s.close();
  });
});

describe("LogStore: disabled / unwritable", () => {
  test("a disabled store is a no-op on both sides", async () => {
    const s = store({ enabled: false });
    expect(s.isEnabled()).toBe(false);
    await s.recordTurn(turn("s1"));
    await s.flush();
    expect(await s.listSessions()).toEqual([]);
    expect(await s.listTurns("s1")).toEqual([]);
    expect(await s.getTurn("s1", 1)).toBeNull();
    expect(await s.getTurnBody("s1", 1)).toBeNull();
    expect(await s.listPromptVersions()).toEqual([]);
    expect(await s.getPromptVersion("x")).toBeNull();
    expect(await s.getPromptVersionMeta("x")).toBeNull();
    expect((await s.statsForPromptVersion("x")).turns).toBe(0);
    expect(await s.recordSystemPrompt("sys")).toBeNull();
    await s.close();
  });

  test("an unwritable log dir disables capture instead of throwing", async () => {
    // A file where a parent directory is expected makes the index open fail
    // (non-fatal by design: logging degrades, the process does not crash).
    writeFileSync(join(root, "not-a-dir"), "x");
    const s = new LogStore(logConfig({ dir: join(root, "not-a-dir", "logs") }), {
      writerMode: "inline",
    });
    expect(s.isEnabled()).toBe(false);
    await s.recordTurn(turn("s1")); // must not throw
    expect(await s.listTurns("s1")).toEqual([]);
    await s.close();
  });

  test("close is idempotent and further records are ignored", async () => {
    const s = store();
    await s.recordTurn(turn("s1"));
    await s.flush();
    await s.close();
    await s.close();
    expect(s.isEnabled()).toBe(false);
    await s.recordTurn(turn("s1")); // no-op, must not throw
  });

  test("exposes the resolved capture limits", async () => {
    const s = store({ captureTimeoutMs: 4242, maxTurnBytes: 111, inFlightBudgetBytes: 222 });
    expect(s.captureTimeoutMs).toBe(4242);
    expect(s.maxTurnBytes).toBe(111);
    expect(s.inFlightBudgetBytes).toBe(222);
    await s.close();
  });
});
