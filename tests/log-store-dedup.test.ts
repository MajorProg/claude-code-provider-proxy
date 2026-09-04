/**
 * LogStore.recordSystemPrompt concurrency test (Task 7).
 *
 * Concurrent identical system prompts must not lose count increments: the
 * per-hash mutex serializes the read-modify-write so the final dedup count
 * equals the number of records. Also exercises the atomic temp-file+rename
 * write (no truncated files).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LogStore } from "../src/logging/log-store.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ccpp-logstore-dedup-"));
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
  });
}

describe("recordSystemPrompt dedup under concurrency", () => {
  test("N concurrent identical prompts -> count === N (no lost updates)", async () => {
    const s = store();
    const N = 25;
    const system = "You are a helpful assistant with a specific persona.";
    const hashes = await Promise.all(Array.from({ length: N }, () => s.recordSystemPrompt(system)));
    // All calls return the same non-null hash.
    const hash = hashes[0];
    expect(hash).not.toBeNull();
    expect(hashes.every((h) => h === hash)).toBe(true);

    // Exactly one dedup file, with count === N.
    const files = readdirSync(join(root, "system")).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(1);
    const rec = JSON.parse(readFileSync(join(root, "system", files[0] as string), "utf-8"));
    expect(rec.count).toBe(N);
    expect(rec.hash).toBe(hash);
  });

  test("no leftover .tmp files after writes (atomic rename)", async () => {
    const s = store();
    await Promise.all([
      s.recordSystemPrompt("prompt A"),
      s.recordSystemPrompt("prompt B"),
      s.recordSystemPrompt("prompt A"),
    ]);
    const files = readdirSync(join(root, "system"));
    expect(files.some((f) => f.includes(".tmp"))).toBe(false);
    // Two distinct prompts -> two files.
    expect(files.filter((f) => f.endsWith(".json")).length).toBe(2);
  });
});

describe("parallelized session/turn listing preserves order + aggregates", () => {
  function turn(sessionId: string, at: string, inTok: number, outTok: number) {
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
      usage: { inputTokens: inTok, outputTokens: outTok },
      requestedAt: at,
      respondedAt: at,
    };
  }

  test("listTurns is seq-ordered and listSessions sums tokens across turns", async () => {
    const s = store();
    // Record three turns for one session sequentially so seq increments 1,2,3.
    await s.recordTurn(turn("sess-1", "2026-08-27T10:00:00.000Z", 10, 5));
    await s.recordTurn(turn("sess-1", "2026-08-27T10:01:00.000Z", 20, 7));
    await s.recordTurn(turn("sess-1", "2026-08-27T10:02:00.000Z", 30, 9));

    const turns = await s.listTurns("sess-1");
    expect(turns.length).toBe(3);
    // Sequence prefix (00001,00002,00003) preserves chronological order.
    expect(turns.map((t) => t.requestedAt)).toEqual([
      "2026-08-27T10:00:00.000Z",
      "2026-08-27T10:01:00.000Z",
      "2026-08-27T10:02:00.000Z",
    ]);

    const sessions = await s.listSessions();
    const sess1 = sessions.find((x) => x.id === "sess-1");
    expect(sess1?.turnCount).toBe(3);
    expect(sess1?.inputTokens).toBe(60);
    expect(sess1?.outputTokens).toBe(21);
  });
});

describe("LogStore.stop() (Task 31)", () => {
  test("after stop(), record* are no-ops and isEnabled() is false", async () => {
    const s = store();
    expect(s.isEnabled()).toBe(true);
    s.stop();
    expect(s.isEnabled()).toBe(false);
    // recordSystemPrompt returns null and writes nothing.
    expect(await s.recordSystemPrompt("persona")).toBeNull();
    await s.recordTurn({
      sessionId: "sess-after-stop",
      canonicalModel: "x",
      invocationModel: "x",
      backend: "converse",
      translationPath: "converse",
      streamed: false,
      systemHash: null,
      messages: [],
      responseContent: [],
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
      requestedAt: "2026-08-27T10:00:00.000Z",
      respondedAt: "2026-08-27T10:00:00.000Z",
    });
    // No files written under system/ or sessions/ (dirs may not even exist).
    expect(existsSync(join(root, "system"))).toBe(false);
    expect(existsSync(join(root, "sessions", "sess-after-stop"))).toBe(false);
    // stop() is idempotent.
    s.stop();
    expect(s.isEnabled()).toBe(false);
  });
});
