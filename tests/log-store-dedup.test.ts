/**
 * LogStore dedup + concurrency (the request-path seam, driven concurrently).
 *
 * Two properties must hold under a burst of overlapping captures:
 *   - every accepted turn lands an index row (no lost appends), and
 *   - a prompt surface shared by many turns is stored as ONE `prompt_versions`
 *     row whose `seenCount` equals the number of turns that ran it.
 *
 * The store assigns each session's `seq` synchronously and hands an in-memory
 * job to the writer, so a concurrent burst exercises the real ordering +
 * dedup path end to end. Hermetic: temp directories only, never `./logs`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoggingConfig } from "../src/config.ts";
import { LogStore } from "../src/logging/log-store.ts";
import type { TurnRecord } from "../src/logging/log-types.ts";
import { computePromptSurface } from "../src/logging/prompt-surface.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ccpp-logstore-dedup-"));
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
    compression: { enabled: false, minAgeMinutes: 10 },
    retentionDays: 30,
    maxTurnBytes: 8 * 1024 * 1024,
    inFlightBudgetBytes: 256 * 1024 * 1024,
    indexFlushMs: 60_000,
    zstdLevel: 3,
    ...over,
  };
}

function store(): LogStore {
  return new LogStore(logConfig(), { writerMode: "inline" });
}

function turn(sessionId: string, at: string, over: Partial<TurnRecord> = {}): TurnRecord {
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
    requestedAt: at,
    respondedAt: at,
    ...over,
  };
}

describe("recordSystemPrompt dedup under concurrency", () => {
  test("N concurrent identical prompts all resolve to one stable hash", async () => {
    const s = store();
    const N = 25;
    const hashes = await Promise.all(
      Array.from({ length: N }, () => s.recordSystemPrompt("You are a helpful assistant.")),
    );
    const hash = hashes[0];
    expect(hash).not.toBeNull();
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashes.every((h) => h === hash)).toBe(true);
    await s.close();
  });
});

describe("concurrent turn records preserve every append", () => {
  test("N concurrent recordTurns -> N index rows and N counted by the session", async () => {
    const s = store();
    const N = 25;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        s.recordTurn(turn("conc", `2026-09-12T10:${String(i).padStart(2, "0")}:00.000Z`)),
      ),
    );
    await s.flush();

    const turns = await s.listTurns("conc");
    expect(turns.length).toBe(N);
    // seq is assigned 1..N in arrival order.
    expect(turns.map((t) => t.seq)).toEqual(Array.from({ length: N }, (_, i) => i + 1));
    expect((await s.listSessions()).find((x) => x.id === "conc")?.turnCount).toBe(N);
    await s.close();
  });

  test("one prompt surface shared by N turns is stored ONCE with seenCount N", async () => {
    const s = store();
    const N = 12;
    const surface = computePromptSurface({
      system: "sys",
      tools: [{ name: "Read", input_schema: { type: "object" } }],
      messages: [],
    });
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        s.recordTurn(
          turn("dedup", `2026-09-12T11:${String(i).padStart(2, "0")}:00.000Z`, {
            promptSurface: surface,
            toolCalls: ["Read"],
          }),
        ),
      ),
    );
    await s.flush();

    const versions = await s.listPromptVersions();
    expect(versions).toHaveLength(1);
    expect(versions[0]?.hash).toBe(surface.hash);
    expect(versions[0]?.seenCount).toBe(N);
    // Every turn links to that one version, and its stats count all N turns.
    expect((await s.listTurns("dedup")).every((t) => t.promptVersion === surface.hash)).toBe(true);
    const stats = await s.statsForPromptVersion(surface.hash);
    expect(stats.turns).toBe(N);
    expect(stats.toolCallShape).toEqual([{ tool: "Read", count: N }]);
    await s.close();
  });
});
