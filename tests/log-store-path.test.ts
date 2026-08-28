/**
 * Path-traversal regression tests for LogStore session handling (Task 3).
 *
 * The session id comes from a client-controlled header, so a traversal input
 * (".." / "../.." / "a/../../b" / ".") must never write or read outside the
 * configured session directory. safeSessionId collapses separators/dots to the
 * "unknown" bucket; sessionDir() adds a resolve-containment backstop.
 *
 * These tests use a real temp dir and assert (a) no file is created outside the
 * base, and (b) traversal ids resolve to the same "unknown" bucket.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LogStore } from "../src/logging/log-store.ts";
import type { TurnRecord } from "../src/logging/log-store.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ccpp-logstore-"));
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
  });
}

function turn(sessionId: string): TurnRecord {
  return {
    sessionId,
    canonicalModel: "bedrock.converse.global.x",
    invocationModel: "x",
    backend: "converse",
    translationPath: "converse",
    streamed: false,
    systemHash: null,
    messages: [],
    responseContent: [],
    stopReason: "end_turn",
    usage: { inputTokens: 1, outputTokens: 1 },
    requestedAt: new Date().toISOString(),
    respondedAt: new Date().toISOString(),
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
    test(`recordTurn("${id}") writes only inside the base dir`, async () => {
      const s = store();
      await s.recordTurn(turn(id));
      const files = walk(root);
      // Every written file must be under <root>/sessions/.
      const sessionsBase = join(root, "sessions");
      for (const f of files) {
        expect(f.startsWith(sessionsBase)).toBe(true);
      }
      // And none may sit directly in a ".." escape (no path component is "..").
      for (const f of files) {
        expect(f.split(/[\\/]/).includes("..")).toBe(false);
      }
    });
  }

  test("traversal ids collapse to the 'unknown' bucket and are readable back", async () => {
    const s = store();
    await s.recordTurn(turn(".."));
    await s.recordTurn(turn("."));
    // Both landed in "unknown"; listTurns("unknown") sees both.
    const turns = await s.listTurns("unknown");
    expect(turns.length).toBe(2);
    // A traversal read also resolves to the same bucket (no escape, no throw).
    const viaTraversal = await s.listTurns("..");
    expect(viaTraversal.length).toBe(2);
  });

  test("a normal session id is isolated from the unknown bucket", async () => {
    const s = store();
    await s.recordTurn(turn("session-abc123"));
    await s.recordTurn(turn(".."));
    expect((await s.listTurns("session-abc123")).length).toBe(1);
    expect((await s.listTurns("unknown")).length).toBe(1);
  });
});
