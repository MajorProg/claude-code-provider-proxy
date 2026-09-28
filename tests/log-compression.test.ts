/**
 * Background turn-file compression tests: the bounded sweep (`sweepCompress`)
 * gzips plain `.json` turn files to `.json.gz` while listings, detail reads,
 * and exports stay transparent. Covers: age/budget bounds, on-disk round-trip,
 * index invariance across compression, resumed-session basename collisions
 * (both forms on disk), and the crash window between the .gz rename and the
 * .json unlink.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { LogStore } from "../src/logging/log-store.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ccpp-logstore-compress-"));
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
    // Timer-driven sweeping is exercised via direct sweepCompress() calls; the
    // timer itself only re-invokes the same method on a cadence.
    compression: { enabled: false, minAgeMinutes: 10 },
  });
}

function turn(sessionId: string, at: string, inTok = 10, outTok = 5) {
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

/** Age a file's mtime far into the past so any minAge accepts it. */
function ageFile(file: string): void {
  utimesSync(file, new Date(Date.now() - 86_400_000), new Date(Date.now() - 86_400_000));
}

describe("sweep basics", () => {
  test("compresses old turn files to .json.gz with byte-identical content", async () => {
    const s = store();
    await s.recordTurn(turn("a", "2026-09-12T10:00:00.000Z"));
    const dir = sessionDirOf("a");
    const plain = join(dir, "00001-2026-09-12T10-00-00-000Z.json");
    const plainContent = readFileSync(plain, "utf-8");
    ageFile(plain);

    const { files } = await s.sweepCompress({ minAgeMs: 0 });
    expect(files).toBe(1);
    expect(existsSync(plain)).toBe(false);
    const gz = `${plain}.gz`;
    expect(existsSync(gz)).toBe(true);
    expect(gunzipSync(new Uint8Array(readFileSync(gz))).toString("utf-8")).toBe(plainContent);
  });

  test("respects minAge: a fresh file is left alone", async () => {
    const s = store();
    await s.recordTurn(turn("a", "2026-09-12T10:00:00.000Z"));
    const { files } = await s.sweepCompress({ minAgeMs: 3_600_000 });
    expect(files).toBe(0);
    expect(existsSync(join(sessionDirOf("a"), "00001-2026-09-12T10-00-00-000Z.json"))).toBe(true);
  });

  test("respects the file budget per sweep call", async () => {
    const s = store();
    for (let i = 0; i < 3; i++) {
      await s.recordTurn(turn("b", `2026-09-12T10:0${i}:00.000Z`));
    }
    for (const f of readdirSync(sessionDirOf("b"))) {
      if (f.endsWith(".json") && f !== "_summary.json") ageFile(join(sessionDirOf("b"), f));
    }
    const first = await s.sweepCompress({ minAgeMs: 0, maxFiles: 1 });
    expect(first.files).toBe(1);
    const remaining = readdirSync(sessionDirOf("b")).filter(
      (f) => f.endsWith(".json") && f !== "_summary.json",
    );
    expect(remaining.length).toBe(2);
    const rest = await s.sweepCompress({ minAgeMs: 0 });
    expect(rest.files).toBe(2);
  });

  test("never touches the _summary.json index", async () => {
    const s = store();
    await s.recordTurn(turn("a", "2026-09-12T10:00:00.000Z"));
    const dir = sessionDirOf("a");
    ageFile(join(dir, "_summary.json"));
    ageFile(join(dir, "00001-2026-09-12T10-00-00-000Z.json"));
    await s.sweepCompress({ minAgeMs: 0 });
    expect(existsSync(join(dir, "_summary.json"))).toBe(true);
    expect(readdirSync(dir).some((f) => f === "_summary.json.gz")).toBe(false);
  });
});

describe("transparent reads after compression", () => {
  test("listings and getTurn are identical before vs after compression", async () => {
    const s = store();
    await s.recordTurn(turn("a", "2026-09-12T10:00:00.000Z", 11, 7));
    await s.recordTurn(turn("a", "2026-09-12T10:01:00.000Z", 22, 9));
    const sessionsBefore = await s.listSessions();
    const turnsBefore = await s.listTurns("a");
    const turnBefore = await s.getTurn("a", "00001-2026-09-12T10-00-00-000Z");

    const dir = sessionDirOf("a");
    for (const f of readdirSync(dir)) {
      if (TURN_PLAIN(f)) ageFile(join(dir, f));
    }
    const { files } = await s.sweepCompress({ minAgeMs: 0 });
    expect(files).toBe(2);

    expect(await s.listSessions()).toEqual(sessionsBefore);
    expect(await s.listTurns("a")).toEqual(turnsBefore);
    expect(await s.getTurn("a", "00001-2026-09-12T10-00-00-000Z")).toEqual(turnBefore);
  });

  test("a rebuild from a fully compressed dir (index deleted) reads .gz bodies", async () => {
    const s = store();
    await s.recordTurn(turn("a", "2026-09-12T10:00:00.000Z"));
    const dir = sessionDirOf("a");
    ageFile(join(dir, "00001-2026-09-12T10-00-00-000Z.json"));
    await s.sweepCompress({ minAgeMs: 0 });
    rmSync(join(dir, "_summary.json"));

    const turns = await s.listTurns("a");
    expect(turns.length).toBe(1);
    expect(turns[0]?.turn).toBe("00001-2026-09-12T10-00-00-000Z");
    expect(turns[0]?.inputTokens).toBe(10);
  });

  test("ZIP export decompresses and strips the .gz member name", async () => {
    const s = store();
    await s.recordTurn(turn("a", "2026-09-12T10:00:00.000Z"));
    const dir = sessionDirOf("a");
    ageFile(join(dir, "00001-2026-09-12T10-00-00-000Z.json"));
    await s.sweepCompress({ minAgeMs: 0 });

    const entries = await s.exportSessionTurns("all");
    expect(entries.length).toBe(1);
    expect(entries[0]?.name).toBe("sessions/a/00001-2026-09-12T10-00-00-000Z.json");
    const rec = JSON.parse(entries[0]?.content ?? "{}");
    expect(rec.sessionId).toBe("a");
  });
});

describe("basename collisions (both forms on disk)", () => {
  test("recordTurn over an already-compressed turn: listing shows one, stale .gz dropped", async () => {
    const s = store();
    await s.recordTurn(turn("a", "2026-09-12T10:00:00.000Z", 1, 1));
    const dir = sessionDirOf("a");
    ageFile(join(dir, "00001-2026-09-12T10-00-00-000Z.json"));
    await s.sweepCompress({ minAgeMs: 0 });
    expect(existsSync(join(dir, "00001-2026-09-12T10-00-00-000Z.json.gz"))).toBe(true);

    // Same turn re-recorded after a restart (fresh store: seq restarts at 1,
    // same requestedAt -> same basename): the plain file is the newer write,
    // the listing must not duplicate the turn, and the stale .gz must go.
    const s2 = store();
    await s2.recordTurn(turn("a", "2026-09-12T10:00:00.000Z", 2, 2));

    const turns = await s2.listTurns("a");
    expect(turns.length).toBe(1);
    expect(existsSync(join(dir, "00001-2026-09-12T10-00-00-000Z.json.gz"))).toBe(false);
    const rec = await s2.getTurn("a", "00001-2026-09-12T10-00-00-000Z");
    expect(rec?.usage.inputTokens).toBe(2);
  });

  test("crash window (both .json and .gz present): prefer .json, single listing entry", async () => {
    const s = store();
    await s.recordTurn(turn("a", "2026-09-12T10:00:00.000Z"));
    const dir = sessionDirOf("a");
    // Simulate a crash between the sweep's .gz rename and its .json unlink.
    const plain = join(dir, "00001-2026-09-12T10-00-00-000Z.json");
    writeFileSync(`${plain}.gz`, new Uint8Array(gzipSync(new Uint8Array(readFileSync(plain)))));

    const turns = await s.listTurns("a");
    expect(turns.length).toBe(1);
    expect(existsSync(`${plain}.gz`)).toBe(false);
    expect(existsSync(plain)).toBe(true);
    const sessions = await s.listSessions();
    expect(sessions[0]?.turnCount).toBe(1);
  });
});

function TURN_PLAIN(f: string): boolean {
  return f.endsWith(".json") && f !== "_summary.json";
}
