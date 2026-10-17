/**
 * LogStore index-backed listing + export routes.
 *
 * The old per-session `_summary.json` index is gone: listings are served from
 * the SQLite index (`listSessions` / `listTurns`), and the ZIP-export routes
 * read each turn body (a zstd file) or prompt version straight out of the store.
 * These tests cover the lifecycle the viewer depends on:
 *   - `listSessions` orders by last activity and sums tokens;
 *   - `exportSessionTurns` names every turn body WITHOUT the `.zst` extension,
 *     decompresses its content, honors the `all | today | 1h` range filter, and
 *     skips a shed body (no file on disk);
 *   - the prompt-version listing is metadata-only while the detail read serves
 *     the full instruction surface.
 *
 * Hermetic: temp directories only, never the repo `./logs`.
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
  root = mkdtempSync(join(tmpdir(), "ccpp-logstore-summary-"));
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
    capture: { systemPrompts: true, chatTurns: true },
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

function turn(sessionId: string, at: string, inTok: number, outTok: number): TurnRecord {
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
    usage: { inputTokens: inTok, outputTokens: outTok },
    requestedAt: at,
    respondedAt: at,
  };
}

describe("index-backed listing", () => {
  test("listSessions orders by last activity (desc) and aggregates tokens", async () => {
    const s = store();
    await s.recordTurn(turn("sess-a", "2026-09-12T10:00:00.000Z", 10, 5));
    await s.recordTurn(turn("sess-a", "2026-09-12T10:01:00.000Z", 20, 7));
    await s.recordTurn(turn("sess-b", "2026-09-12T11:00:00.000Z", 1, 1));
    await s.flush();

    const sessions = await s.listSessions();
    expect(sessions.map((x) => x.id)).toEqual(["sess-b", "sess-a"]); // lastAt desc
    const a = sessions.find((x) => x.id === "sess-a");
    expect(a?.turnCount).toBe(2);
    expect(a?.inputTokens).toBe(30);
    expect(a?.outputTokens).toBe(12);
    expect(a?.firstAt).toBe("2026-09-12T10:00:00.000Z");
    expect(a?.lastAt).toBe("2026-09-12T10:01:00.000Z");
    await s.close();
  });

  test("listTurns returns metadata in seq order without reading bodies", async () => {
    const s = store();
    await s.recordTurn(turn("sess-a", "2026-09-12T10:00:00.000Z", 10, 5));
    await s.recordTurn(turn("sess-a", "2026-09-12T10:01:00.000Z", 20, 7));
    await s.flush();

    const turns = await s.listTurns("sess-a");
    expect(turns.map((t) => t.seq)).toEqual([1, 2]);
    expect(turns.map((t) => t.inputTokens)).toEqual([10, 20]);
    await s.close();
  });
});

describe("exportSessionTurns", () => {
  test("names each body without the .zst extension and decompresses its content", async () => {
    const s = store();
    await s.recordTurn(turn("sess-a", "2026-09-12T10:00:00.000Z", 10, 5));
    await s.flush();

    const entries = await s.exportSessionTurns("all");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe("sessions/sess-a/00001-2026-09-12T10-00-00-000Z.json");
    const rec = JSON.parse(entries[0]?.content ?? "{}") as { sessionId: string };
    expect(rec.sessionId).toBe("sess-a");
    await s.close();
  });

  test("range filters by requestedAt: '1h' and 'today' exclude old turns", async () => {
    const s = store();
    const fresh = new Date().toISOString();
    await s.recordTurn(turn("sess-a", "2020-01-01T00:00:00.000Z", 1, 1)); // old
    await s.recordTurn(turn("sess-a", fresh, 2, 2)); // fresh
    await s.flush();

    expect((await s.exportSessionTurns("all")).map((e) => e.name)).toEqual([
      "sessions/sess-a/00001-2020-01-01T00-00-00-000Z.json",
      `sessions/sess-a/00002-${fresh.replace(/[:.]/g, "-")}.json`,
    ]);
    expect((await s.exportSessionTurns("1h")).map((e) => e.name)).toEqual([
      `sessions/sess-a/00002-${fresh.replace(/[:.]/g, "-")}.json`,
    ]);
    expect((await s.exportSessionTurns("today")).map((e) => e.name)).toEqual([
      `sessions/sess-a/00002-${fresh.replace(/[:.]/g, "-")}.json`,
    ]);
    await s.close();
  });

  test("skips a shed body (its metadata survives, but there is no file to export)", async () => {
    const s = store();
    await s.recordTurn({ ...turn("sess-a", "2026-09-12T10:00:00.000Z", 10, 5), bodyState: "shed" });
    await s.flush();

    expect((await s.exportSessionTurns("all")).length).toBe(0);
    // The index row is still there.
    expect((await s.listTurns("sess-a")).length).toBe(1);
    expect((await s.listTurns("sess-a"))[0]?.bodyState).toBe("shed");
    await s.close();
  });
});

describe("prompt-version content: metadata listing + full detail", () => {
  test("listPromptVersions is metadata-only; getPromptVersion serves the full surface", async () => {
    const s = store();
    const surface = computePromptSurface({
      system: "You are terse.",
      tools: [{ name: "Read", input_schema: { type: "object" } }],
      messages: [],
    });
    await s.recordTurn({
      ...turn("sess-a", "2026-09-12T10:00:00.000Z", 10, 5),
      promptSurface: surface,
    });
    await s.flush();

    const versions = await s.listPromptVersions();
    expect(versions).toHaveLength(1);
    const meta = versions[0];
    expect(meta?.hash).toBe(surface.hash);
    expect(meta?.seenCount).toBe(1);
    // The listing carries NO content fields (no ~244 KB tools_json deserialized).
    expect(Object.keys(meta ?? {})).not.toContain("toolsJson");
    expect(Object.keys(meta ?? {})).not.toContain("systemJson");

    // The detail read reconstitutes the surface's three parts verbatim.
    const rec = await s.getPromptVersion(surface.hash);
    expect(rec?.systemJson).toEqual(surface.systemJson);
    expect(rec?.toolsJson).toEqual(surface.toolsJson);
    expect(rec?.injectedJson).toEqual(surface.injectedJson);
    // The metadata accessor agrees with the listing.
    expect((await s.getPromptVersionMeta(surface.hash))?.hash).toBe(surface.hash);
    await s.close();
  });

  test("a store with no prompt versions lists nothing", async () => {
    const s = store();
    expect(await s.listPromptVersions()).toEqual([]);
    expect(await s.getPromptVersion("missing")).toBeNull();
    expect(await s.getPromptVersionMeta("missing")).toBeNull();
    await s.close();
  });
});
