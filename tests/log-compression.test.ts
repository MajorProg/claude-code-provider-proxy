/**
 * Turn bodies are zstd-compressed AT WRITE; readers decompress transparently.
 *
 * The old design wrote plain `.json` and swept it to `.json.gz` on a timer; the
 * new design compresses the body once, at write, in the writer's thread. The
 * legacy `logging.compression` block is still ACCEPTED but IGNORED (`config.local
 * .jsonc` on disk still carries it, so rejecting it would break boot) — it no
 * longer delays or drives compression.
 *
 * These tests pin the on-disk contract:
 *   - a recorded body is a zstd frame (`.json.zst`), not plaintext JSON;
 *   - `getTurnBody` decompresses it back to the original turn record;
 *   - `compression.enabled = true` does NOT defer compression (no sweep).
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

function turn(sessionId: string, inTok = 10, outTok = 5): TurnRecord {
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
    requestedAt: "2026-09-12T10:00:00.000Z",
    respondedAt: "2026-09-12T10:00:01.000Z",
  };
}

describe("bodies are zstd-compressed at write", () => {
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

  test("compression.enabled = true does NOT defer compression (no sweep)", async () => {
    // The legacy block (still on disk in config.local.jsonc) is accepted and
    // ignored: the body is compressed immediately, with no delayed sweep step.
    const s = store({ compression: { enabled: true, minAgeMinutes: 10 } });
    await s.recordTurn(turn("a"));
    await s.flush();

    const rel = (await s.listTurns("a"))[0]?.bodyFile ?? "";
    expect(rel.endsWith(".json.zst")).toBe(true);
    const bytes = readFileSync(join(root, rel));
    expect([...bytes.subarray(0, 4)]).toEqual(ZSTD_MAGIC);
    // No plaintext body is left behind for a later sweep to pick up.
    const onDisk = readdirSync(join(root, "sessions", "a"));
    expect(onDisk.every((f) => f.endsWith(".json.zst"))).toBe(true);
    await s.close();
  });
});
