/**
 * `logging.compression.enabled` drives turn-body compression AT WRITE.
 *
 * Enabled (the default) stores each body as a zstd frame (`.json.zst`);
 * disabled stores plain, readable JSON (`.json`). Readers branch on the stored
 * extension, so flipping the switch does not strand previously written bodies.
 * There is no background sweep in either mode.
 *
 * These tests pin the on-disk contract:
 *   - a compressed body is a zstd frame (`.json.zst`), not plaintext JSON;
 *   - an uncompressed body is plain `.json` and stays byte-readable;
 *   - `getTurnBody` reads BOTH forms back to the original turn record;
 *   - both forms coexist within one session directory across a config flip.
 *
 * Hermetic: temp directories only, never the repo `./logs`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoggingConfig } from "../src/config.ts";
import { LogStore } from "../src/logging/log-store.ts";
import type { TurnRecord } from "../src/logging/log-types.ts";

/** zstd frame magic number (RFC 8878): little-endian 0xFD2FB528. */
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ccpp-logstore-compress-"));
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
    compression: { enabled: true, minAgeMinutes: 10 },
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

function turn(
  sessionId: string,
  inTok = 10,
  outTok = 5,
  at = "2026-09-12T10:00:00.000Z",
): TurnRecord {
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

describe("compression.enabled = true (default)", () => {
  test("a recorded turn is a .json.zst zstd frame, not plaintext JSON", async () => {
    const s = store();
    await s.recordTurn(turn("a"));
    await s.flush();

    const meta = (await s.listTurns("a"))[0];
    const rel = meta?.bodyFile ?? "";
    expect(rel.endsWith(".json.zst")).toBe(true);
    const abs = join(root, rel);
    expect(existsSync(abs)).toBe(true);

    const bytes = readFileSync(abs);
    expect([...bytes.subarray(0, 4)]).toEqual(ZSTD_MAGIC);
    // The raw bytes are a compressed frame, not the JSON we fed in.
    expect(bytes.subarray(0, 1).toString("utf-8")).not.toBe("{");
    await s.close();
  });

  test("getTurnBody decompresses the body back to the original record", async () => {
    const s = store();
    const recorded = turn("a", 11, 7);
    await s.recordTurn(recorded);
    await s.flush();

    expect(await s.getTurnBody("a", 1)).toEqual(recorded);
    await s.close();
  });
});

describe("compression.enabled = false", () => {
  test("a recorded turn is a plain .json body that starts with the JSON object", async () => {
    const s = store({ compression: { enabled: false, minAgeMinutes: 10 } });
    const recorded = turn("a");
    await s.recordTurn(recorded);
    await s.flush();

    const rel = (await s.listTurns("a"))[0]?.bodyFile ?? "";
    expect(rel.endsWith(".json")).toBe(true);
    expect(rel.endsWith(".zst")).toBe(false);
    const bytes = readFileSync(join(root, rel));
    expect(bytes.subarray(0, 1).toString("utf-8")).toBe("{");
    expect(JSON.parse(bytes.toString("utf-8"))).toEqual(
      recorded as unknown as Record<string, unknown>,
    );
    await s.close();
  });

  test("getTurnBody reads an uncompressed body back to the original record", async () => {
    const s = store({ compression: { enabled: false, minAgeMinutes: 10 } });
    const recorded = turn("a", 3, 4);
    await s.recordTurn(recorded);
    await s.flush();

    expect(await s.getTurnBody("a", 1)).toEqual(recorded);
    await s.close();
  });

  test("exportSessionTurns includes an uncompressed body", async () => {
    const s = store({ compression: { enabled: false, minAgeMinutes: 10 } });
    await s.recordTurn(turn("a"));
    await s.flush();

    const entries = await s.exportSessionTurns("all");
    expect(entries).toHaveLength(1);
    expect(JSON.parse(entries[0]?.content ?? "")).toMatchObject({ sessionId: "a" });
    await s.close();
  });
});

describe("a config flip leaves both body forms readable", () => {
  test("compressed and uncompressed bodies in one session directory both load", async () => {
    const compressed = store();
    await compressed.recordTurn(turn("a", 1, 1, "2026-09-12T10:00:00.000Z"));
    await compressed.flush();
    await compressed.close();

    const plain = store({ compression: { enabled: false, minAgeMinutes: 10 } });
    await plain.recordTurn(turn("a", 2, 2, "2026-09-12T10:00:02.000Z"));
    await plain.flush();

    const rels = (await plain.listTurns("a")).map((t) => t.bodyFile ?? "");
    expect(rels.some((r) => r.endsWith(".json.zst"))).toBe(true);
    expect(rels.some((r) => r.endsWith(".json"))).toBe(true);
    const onDisk = readdirSync(join(root, "sessions", "a"));
    expect(onDisk).toHaveLength(2);

    expect(await plain.getTurnBody("a", 1)).toMatchObject({ sessionId: "a" });
    expect(await plain.getTurnBody("a", 2)).toMatchObject({ sessionId: "a" });
    await plain.close();
  });
});
