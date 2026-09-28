/**
 * LogStore summary-index tests (scalable log listing).
 *
 * The per-session `_summary.json` index lets listSessions/listTurns serve
 * listing metadata without reading turn-file bodies (which total many GB in a
 * long-lived deployment and previously OOM'd the proxy). These tests exercise
 * the full index lifecycle against the real recordTurn write path: creation,
 * exclusion from listings/exports, legacy backfill, drift self-healing,
 * concurrent appends (no lost entries), and corrupt-file tolerance.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LogStore } from "../src/logging/log-store.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ccpp-logstore-summary-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function store(): LogStore {
  return new LogStore({
    enabled: true,
    dir: root,
    systemDir: "system",
    sessionDir: "sessions",
    captureTimeoutMs: 120000,
    compression: { enabled: false, minAgeMinutes: 10 },
  });
}

function turn(sessionId: string, at: string, inTok: number, outTok: number) {
  return {
    sessionId,
    canonicalModel: "bedrock.converse.global.x",
    invocationModel: "x",
    backend: "converse",
    translationPath: "converse",
    streamed: false,
    systemHash: null,
    messages: [{ role: "user", content: "hello" }],
    responseContent: [{ type: "text", text: "hi" }],
    stopReason: "end_turn",
    usage: { inputTokens: inTok, outputTokens: outTok },
    requestedAt: at,
    respondedAt: at,
  };
}

function sessionDirOf(sid: string): string {
  return join(root, "sessions", sid);
}

describe("summary index creation + exclusion", () => {
  test("recordTurn writes _summary.json; listings and exports exclude it", async () => {
    const s = store();
    await s.recordTurn(turn("sess-a", "2026-09-12T10:00:00.000Z", 10, 5));
    await s.recordTurn(turn("sess-a", "2026-09-12T10:01:00.000Z", 20, 7));

    const dir = sessionDirOf("sess-a");
    expect(existsSync(join(dir, "_summary.json"))).toBe(true);
    const parsed = JSON.parse(readFileSync(join(dir, "_summary.json"), "utf-8"));
    expect(parsed.fileCount).toBe(2);
    expect(parsed.turns.map((t: { turn: string }) => t.turn)).toEqual([
      "00001-2026-09-12T10-00-00-000Z",
      "00002-2026-09-12T10-01-00-000Z",
    ]);

    // The index never surfaces as a turn.
    const turns = await s.listTurns("sess-a");
    expect(turns.length).toBe(2);
    expect(turns.some((t) => t.turn === "_summary")).toBe(false);
    const exportEntries = await s.exportSessionTurns("all");
    expect(exportEntries.map((e) => e.name).sort()).toEqual([
      "sessions/sess-a/00001-2026-09-12T10-00-00-000Z.json",
      "sessions/sess-a/00002-2026-09-12T10-01-00-000Z.json",
    ]);
    // getTurn refuses the index basename.
    expect(await s.getTurn("sess-a", "_summary")).toBeNull();
  });

  test("listSessions aggregates from the index", async () => {
    const s = store();
    await s.recordTurn(turn("sess-a", "2026-09-12T10:00:00.000Z", 10, 5));
    await s.recordTurn(turn("sess-a", "2026-09-12T10:01:00.000Z", 20, 7));
    await s.recordTurn(turn("sess-b", "2026-09-12T11:00:00.000Z", 1, 1));

    const sessions = await s.listSessions();
    expect(sessions.map((x) => x.id)).toEqual(["sess-b", "sess-a"]); // lastAt desc
    const a = sessions.find((x) => x.id === "sess-a");
    expect(a?.turnCount).toBe(2);
    expect(a?.inputTokens).toBe(30);
    expect(a?.outputTokens).toBe(12);
    expect(a?.firstAt).toBe("2026-09-12T10:00:00.000Z");
    expect(a?.lastAt).toBe("2026-09-12T10:01:00.000Z");
  });
});

describe("legacy backfill (sessions recorded before the index existed)", () => {
  test("listSessions rebuilds a deleted index from turn files, identically", async () => {
    const s = store();
    for (let i = 0; i < 5; i++) {
      await s.recordTurn(turn("legacy", `2026-09-12T10:0${i}:00.000Z`, i + 1, i + 2));
    }
    const before = await s.listSessions();

    // Simulate a pre-index session: drop the index on disk.
    rmSync(join(sessionDirOf("legacy"), "_summary.json"));

    const after = await s.listSessions();
    expect(after).toEqual(before);
    // The rebuilt index is persisted, so the scan never repeats.
    expect(existsSync(join(sessionDirOf("legacy"), "_summary.json"))).toBe(true);
    const parsed = JSON.parse(readFileSync(join(sessionDirOf("legacy"), "_summary.json"), "utf-8"));
    expect(parsed.fileCount).toBe(5);
    expect(parsed.turns.length).toBe(5);
  });

  test("a turn recorded by an index-less build is picked up via count drift", async () => {
    const s = store();
    await s.recordTurn(turn("drift", "2026-09-12T10:00:00.000Z", 5, 5));
    const dir = sessionDirOf("drift");
    rmSync(join(dir, "_summary.json"));
    // Simulate the old build writing one more turn file with no index update.
    copyFileSync(
      join(dir, "00001-2026-09-12T10-00-00-000Z.json"),
      join(dir, "00002-2026-09-12T10-05-00-000Z.json"),
    );

    const sessions = await s.listSessions();
    const drift = sessions.find((x) => x.id === "drift");
    expect(drift?.turnCount).toBe(2);
    const turns = await s.listTurns("drift");
    expect(turns.length).toBe(2);
  });
});

describe("concurrent turn records (summary mutex)", () => {
  test("N concurrent recordTurns -> N index entries, no lost appends", async () => {
    const s = store();
    const N = 25;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        s.recordTurn(turn("conc", `2026-09-12T10:${String(i).padStart(2, "0")}:00.000Z`, 1, 1)),
      ),
    );
    const turns = await s.listTurns("conc");
    expect(turns.length).toBe(N);
    const sessions = await s.listSessions();
    expect(sessions.find((x) => x.id === "conc")?.turnCount).toBe(N);
  });
});

describe("corrupt-file tolerance", () => {
  test("a corrupt turn file is skipped without crashing or looping", async () => {
    const s = store();
    await s.recordTurn(turn("corrupt", "2026-09-12T10:00:00.000Z", 3, 4));
    const dir = sessionDirOf("corrupt");
    rmSync(join(dir, "_summary.json"));
    // A turn file whose JSON is truncated (e.g. crash on a pre-atomic-write build).
    writeFileSync(join(dir, "00002-2026-09-12T10-01-00-000Z.json"), '{"sessionId": "cor');

    const turns = await s.listTurns("corrupt");
    expect(turns.length).toBe(1);
    expect(turns[0]?.turn).toBe("00001-2026-09-12T10-00-00-000Z");
    // Stable across listings: the index records fileCount (2), so the skipped
    // file does not re-trip the drift check and force a rescan every time.
    const again = await s.listTurns("corrupt");
    expect(again).toEqual(turns);
    // The persisted index reflects both files on disk.
    const parsed = JSON.parse(readFileSync(join(dir, "_summary.json"), "utf-8"));
    expect(parsed.fileCount).toBe(2);
    expect(parsed.turns.length).toBe(1);
  });
});
