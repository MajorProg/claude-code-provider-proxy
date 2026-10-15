/**
 * Path-traversal containment through the LogStore public API.
 *
 * The session id arrives from a client-controlled header, so a traversal input
 * (".." / "../.." / "a/../../b" / ".") must never let a body file escape the
 * configured session directory. The writer sanitizes the id for the on-disk
 * directory (`.` and `..` collapse to the "unknown" bucket; path separators and
 * other unsafe characters become `_`), while the index row keeps the RAW id as
 * its key so a turn reads back under the id it was recorded with.
 *
 * These tests drive the real recordTurn -> flush -> listTurns path against a
 * temp dir and assert (a) every written file lands under `<root>/sessions` with
 * no ".." path component, and (b) each raw id reads back its own turn without a
 * throw.
 *
 * Hermetic: temp directories only, never the repo `./logs`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import type { LoggingConfig } from "../src/config.ts";
import { LogStore } from "../src/logging/log-store.ts";
import type { TurnRecord } from "../src/logging/log-types.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ccpp-logstore-path-"));
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
    // Accepted-and-ignored: bodies are zstd-compressed at write now.
    compression: { enabled: false, minAgeMinutes: 10 },
    retentionDays: 30,
    maxTurnBytes: 8 * 1024 * 1024,
    inFlightBudgetBytes: 256 * 1024 * 1024,
    indexFlushMs: 60_000,
    zstdLevel: 3,
    ...over,
  };
}

function store(over: Partial<LoggingConfig> = {}): LogStore {
  return new LogStore(logConfig(over), { writerMode: "inline" });
}

function turn(sessionId: string, requestedAt: string): TurnRecord {
  return {
    sessionId,
    canonicalModel: "bedrock.converse.global.model-x",
    invocationModel: "model-x",
    backend: "converse",
    translationPath: "converse",
    streamed: false,
    systemHash: null,
    messages: [],
    responseContent: [],
    stopReason: "end_turn",
    usage: { inputTokens: 1, outputTokens: 1 },
    requestedAt,
    respondedAt: requestedAt,
  };
}

/** Recursively collect every file path under a dir. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

describe("LogStore path traversal is contained", () => {
  const evil = ["..", "../..", "a/../../b", ".", "../../../etc/passwd"];

  for (const id of evil) {
    test(`recordTurn(${JSON.stringify(id)}) writes only inside the base dir`, async () => {
      const s = store();
      await s.recordTurn(turn(id, "2026-09-12T10:00:00.000Z"));
      await s.flush();

      const files = walk(root);
      // No file — index artifacts included — may sit under a ".." escape.
      for (const f of files) {
        expect(f.split(/[\\/]/).includes("..")).toBe(false);
      }
      // Every BODY file must be under <root>/sessions/; the only files allowed
      // at the log root itself are the SQLite index and its sidecars/spool.
      const sessionsBase = join(root, "sessions");
      for (const f of files) {
        const rel = relative(root, f);
        if (!rel.includes(sep) && rel.startsWith("index")) continue; // root index.db / spool
        expect(f.startsWith(sessionsBase)).toBe(true);
      }
      // The raw id reads its own turn back (the index keeps the raw key).
      const turns = await s.listTurns(id);
      expect(turns.length).toBe(1);
      expect(turns[0]?.bodyFile?.startsWith("sessions/")).toBe(true);
      await s.close();
    });
  }

  test("'.' and '..' collapse to the 'unknown' directory on disk", async () => {
    const s = store();
    // Distinct timestamps so the two turns do not share a body filename.
    await s.recordTurn(turn(".", "2026-09-12T10:00:00.000Z"));
    await s.recordTurn(turn("..", "2026-09-12T10:01:00.000Z"));
    await s.flush();

    expect((await s.listTurns("."))[0]?.bodyFile?.startsWith("sessions/unknown/")).toBe(true);
    expect((await s.listTurns(".."))[0]?.bodyFile?.startsWith("sessions/unknown/")).toBe(true);
    await s.close();
  });

  test("a normal session id is isolated from the traversal ids", async () => {
    const s = store();
    await s.recordTurn(turn("session-abc123", "2026-09-12T10:00:00.000Z"));
    await s.recordTurn(turn("..", "2026-09-12T10:01:00.000Z"));
    await s.flush();

    expect((await s.listTurns("session-abc123")).length).toBe(1);
    expect((await s.listTurns("..")).length).toBe(1);
    expect((await s.listTurns("unknown")).length).toBe(0);
    await s.close();
  });
});
