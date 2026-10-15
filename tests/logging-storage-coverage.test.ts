/**
 * Coverage-closure tests for the logging storage modules. Each block exercises a
 * real, previously-uncovered behaviour end to end — never a line-touch:
 *
 *   - prompt-surface.ts: the defensive request-path branches — a raw STRING
 *     content block (vs a `{text}` block), a message whose content is absent,
 *     and the canonical-JSON edges (bigint, undefined members, non-finite
 *     numbers, over-deep + cyclic values).
 *   - index-db.ts: the deferred-replay path. A spooled batch that parses but
 *     cannot be APPLIED is retained for the next open (never dropped, never a
 *     crash), while a sibling batch that applies cleanly still lands.
 *   - log-store.ts: verifyWritable() (the startup probe), stop() and isEnabled()
 *     — the paths that disable capture instead of throwing.
 *   - capture.ts: the CaptureBudget limit accessors, runDetached's terminal
 *     `.catch` (a rejected capture task must never become an unhandled
 *     rejection or crash the process), and the streaming teardown cancel
 *     paths — the swallowed `reader.cancel()` handlers that only run when the
 *     log branch has errored or the tee's source rejects its own cancel.
 *
 * Hermetic: temp directories only, never the repo ./logs.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoggingConfig } from "../src/config.ts";
import { CaptureBudget, type CaptureContext, captureTurn } from "../src/logging/capture.ts";
import { IndexDb, type TurnRow } from "../src/logging/index-db.ts";
import { LogStore } from "../src/logging/log-store.ts";
import type { TurnMeta, TurnRecord } from "../src/logging/log-types.ts";
import { computePromptSurface } from "../src/logging/prompt-surface.ts";
import { readFixtureText, streamOf } from "./helpers/fetch-mock.ts";

let root: string;
let indexPath: string;
let spoolPath: string;
let open: IndexDb[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ccpp-logging-storage-"));
  indexPath = join(root, "index.db");
  spoolPath = join(root, "index-spool.jsonl");
  open = [];
});

afterEach(() => {
  for (const db of open) {
    try {
      db.close();
    } catch {
      // already closed — nothing to do
    }
  }
  rmSync(root, { recursive: true, force: true });
});

/** Open an index over the temp dir and track it for teardown. */
function db(): IndexDb {
  const handle = new IndexDb(indexPath, { spoolPath });
  open.push(handle);
  return handle;
}

/** A minimal complete turn row (only the columns a replay needs). */
function row(sessionId: string, seq: number): TurnRow {
  return {
    sessionId,
    seq,
    requestedAt: `2026-09-12T10:00:0${seq}.000Z`,
    respondedAt: `2026-09-12T10:00:0${seq}.500Z`,
    modelServed: "m",
    promptVersion: "H1",
    stopReason: "end_turn",
  };
}

/** A LoggingConfig rooted at the temp dir; `over` overrides individual fields. */
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

/* ================================================================== *
 * prompt-surface.ts — the defensive request-path branches
 * ================================================================== */

describe("prompt-surface: defensive request-path branches", () => {
  test("a raw STRING block inside a content array is scanned for envelopes", () => {
    const s = computePromptSurface({
      system: null,
      tools: [],
      messages: [
        {
          role: "user",
          // The block is a bare string, not a `{ text }` object — a distinct
          // spelling that must still be read.
          content: ["<system-reminder>block form note</system-reminder>", "ordinary prose"],
        },
      ],
    });
    expect(JSON.parse(s.injectedJson)).toEqual(["block form note"]);
    // The ordinary sibling string is not elevated to an injection.
    expect(s.injectedJson).not.toContain("ordinary prose");
  });

  test("a message whose content is neither a string nor an array contributes nothing", () => {
    const s = computePromptSurface({
      system: null,
      tools: [],
      messages: [
        { role: "user", content: 42 },
        { role: "user", content: { text: "<system-reminder>not read</system-reminder>" } },
        { role: "user" },
      ],
    });
    expect(JSON.parse(s.injectedJson)).toEqual([]);
  });

  test("an envelope with a missing closing tag is captured to the end of the segment", () => {
    const s = computePromptSurface({
      system: null,
      tools: [],
      messages: [{ role: "user", content: "<system-reminder>truncated mid-stream" }],
    });
    expect(JSON.parse(s.injectedJson)).toEqual(["truncated mid-stream"]);
  });

  test("a bigint member canonicalizes to its exact decimal digits", () => {
    const s = computePromptSurface({
      system: { budget: 9_007_199_254_740_993n },
      tools: [],
      messages: [],
    });
    // Above Number.MAX_SAFE_INTEGER: the digits must survive verbatim, not round.
    expect(s.systemJson).toBe('{"budget":9007199254740993}');
  });

  test("canonical JSON drops undefined members and renders the other JSON edges", () => {
    const s = computePromptSurface({
      system: {
        gone: undefined,
        keep: 1,
        list: [1, undefined, 3],
        nan: Number.NaN,
        inf: Number.POSITIVE_INFINITY,
      },
      tools: [],
      messages: [],
    });
    // `gone` is omitted; an undefined array element and non-finite numbers are null.
    expect(s.systemJson).toBe('{"inf":null,"keep":1,"list":[1,null,3],"nan":null}');
  });

  test("a value deeper than the cap degrades to null rather than recursing forever", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 80; i++) deep = { nest: deep };
    const s = computePromptSurface({ system: deep, tools: [], messages: [] });
    expect(s.hash).toMatch(/^[0-9a-f]{64}$/);
    // The cap is hit, so the sentinel null appears rather than the leaf string.
    expect(s.systemJson).toContain("null");
    expect(s.systemJson).not.toContain("leaf");
  });

  test("non-object tool entries are skipped while real tools are kept", () => {
    const s = computePromptSurface({
      system: null,
      tools: [null, 7, "name", ["nested"], { name: "Read", input_schema: { type: "object" } }],
      messages: [],
    });
    expect(JSON.parse(s.toolsJson)).toEqual([{ name: "Read", input_schema: { type: "object" } }]);
  });
});

/* ================================================================== *
 * index-db.ts — the deferred-replay path (#rewriteSpool)
 * ================================================================== */

describe("index-db: a batch that cannot be applied is deferred, not lost", () => {
  test("replay applies the valid batch and RETAINS the un-appliable one", () => {
    const valid = { kind: "turns", payload: [row("s1", 1)] };
    // Parses as a `turns` entry but cannot be APPLIED: a non-scalar value where a
    // scalar column is expected makes bun:sqlite's bind throw. (A bare NOT NULL
    // violation would NOT do it — INSERT OR IGNORE silently skips such a row.)
    const bad = {
      kind: "turns",
      payload: [{ sessionId: "orphan", seq: 1, requestedAt: "x", subagentOf: {} }],
    };
    writeFileSync(spoolPath, `${JSON.stringify(valid)}\n${JSON.stringify(bad)}\n`);

    const index = db();
    // The valid batch landed...
    expect(index.listTurns("s1").map((t) => t.seq)).toEqual([1]);
    // ...and the failed one is kept on disk (rewritten, not dropped).
    expect(existsSync(spoolPath)).toBe(true);
    const lines = readFileSync(spoolPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const kept = JSON.parse(lines[0] ?? "") as { kind: string; payload: unknown[] };
    expect(kept.kind).toBe("turns");
    expect(kept.payload).toHaveLength(1);
  });

  test("a deferred entry survives a second open (it is never silently dropped)", () => {
    writeFileSync(
      spoolPath,
      `${JSON.stringify({
        kind: "turns",
        payload: [{ sessionId: "orphan", seq: 1, requestedAt: "x", subagentOf: {} }],
      })}\n`,
    );

    const first = db();
    expect(existsSync(spoolPath)).toBe(true);
    first.close();

    // Re-opening replays and re-defers the same entry — durable across restarts.
    const second = db();
    // The un-appliable row was never applied by the reopen.
    expect(second.listTurns("orphan")).toEqual([]);
    expect(existsSync(spoolPath)).toBe(true);
    expect(readFileSync(spoolPath, "utf8").trim()).not.toBe("");
  });
});

/* ================================================================== *
 * log-store.ts — verifyWritable / stop / isEnabled
 * ================================================================== */

describe("log-store: startup probe, stop and isEnabled", () => {
  test("verifyWritable creates the roots and leaves capture enabled", async () => {
    const s = store();
    expect(s.isEnabled()).toBe(true);
    // Remove the session dir the writer pre-created so the probe recreates it.
    rmSync(join(root, "sessions"), { recursive: true, force: true });
    await s.verifyWritable();
    expect(existsSync(join(root, "sessions"))).toBe(true);
    expect(s.isEnabled()).toBe(true);
    await s.close();
  });

  test("verifyWritable disables capture when the session dir cannot be created", async () => {
    const s = store();
    // Replace the session dir with a FILE: the probe's mkdir now fails, which
    // must disable the store rather than throw.
    rmSync(join(root, "sessions"), { recursive: true, force: true });
    writeFileSync(join(root, "sessions"), "not a directory");
    expect(s.isEnabled()).toBe(true);

    await s.verifyWritable();
    expect(s.isEnabled()).toBe(false);
    await s.close();
  });

  test("stop() on a disabled store returns without touching capture state", () => {
    const s = store({ enabled: false });
    s.stop(); // must not throw
    expect(s.isEnabled()).toBe(false);
  });

  test("stop() marks an enabled store stopped and short-circuits later records", async () => {
    const s = store();
    expect(s.isEnabled()).toBe(true);
    s.stop();
    // Recording is now a no-op: the store is stopped.
    expect(s.isEnabled()).toBe(false);
    await s.recordTurn(turn("s1"));
    await s.close(); // lets the detached teardown settle (idempotent)
  });
});

/* ================================================================== *
 * capture.ts — the budget accessors and runDetached's terminal catch
 * ================================================================== */

describe("capture: CaptureBudget limit accessors", () => {
  test("expose the configured per-turn cap and in-flight budget", () => {
    const budget = new CaptureBudget(1_234, 5_678_901);
    expect(budget.maxTurnBytes).toBe(1_234);
    expect(budget.inFlightBudgetBytes).toBe(5_678_901);

    // configure() updates the cap but leaves the untouched limit in place.
    budget.configure({ maxTurnBytes: 7 });
    expect(budget.maxTurnBytes).toBe(7);
    expect(budget.inFlightBudgetBytes).toBe(5_678_901);
  });
});

describe("capture: a rejected capture task is swallowed (never an unhandled crash)", () => {
  test("a streaming capture that throws before its guarded block relays the client branch", async () => {
    const bytes = new TextEncoder().encode(readFixtureText("anthropic-stream.sse"));
    let systemPromptCalls = 0;
    const ctx: CaptureContext = {
      sessionId: "swallow",
      canonicalModel: "bedrock.converse.global.m",
      invocationModel: "m",
      backend: "converse",
      translationPath: "converse",
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      requestedAt: new Date().toISOString(),
    };
    const store = {
      isEnabled: () => true,
      // The log-branch pump reads this BEFORE its own try/guard; a throwing
      // accessor stands in for any future edit that throws before the guarded
      // block, proving runDetached's terminal .catch swallows the rejection.
      get captureTimeoutMs(): number {
        throw new Error("boom before the guarded block");
      },
      recordSystemPrompt: async () => {
        systemPromptCalls++;
        return "hash";
      },
      recordTurn: async () => {},
    } as unknown as LogStore;

    const resp = new Response(streamOf(bytes, 4), {
      headers: { "content-type": "text/event-stream" },
    });
    const out = captureTurn(store, ctx, resp);

    // The client branch is still relayed byte-for-byte.
    expect(await out.text()).toContain("event: message_start");
    // Give the (rejected) detached task a moment to settle, then assert it was
    // swallowed: no turn was recorded and — crucially — nothing was thrown.
    await new Promise((r) => setTimeout(r, 50));
    expect(systemPromptCalls).toBe(0);
  });
});

/* ================================================================== *
 * capture.ts — the streaming teardown cancel paths
 * ================================================================== *
 *
 * A streamed capture tears its log branch down with several best-effort
 * `reader.cancel()` calls whose promise is deliberately swallowed
 * (`.catch(() => {})`) so a cancel failure can never reach the request path.
 * Those swallow handlers only run when `cancel()` actually REJECTS, which
 * happens in two real situations: the log branch's stream has ERRORED
 * mid-flight, or a tee whose underlying source throws in its own `cancel` is
 * torn down after BOTH branches are cancelled. Each test drives one of those
 * genuine teardown moments and asserts the observable outcome — the client
 * branch is never affected, a failed capture writes no bogus turn, and a
 * genuinely truncated turn is recorded as `truncated`.
 */

/** Bounded wait (hermetic — no network, no repo files). */
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A capture context rooted at a session id. */
function context(sessionId: string): CaptureContext {
  return {
    sessionId,
    canonicalModel: "bedrock.converse.global.model-x",
    invocationModel: "model-x",
    backend: "converse",
    translationPath: "converse",
    system: "You are terse.",
    messages: [{ role: "user", content: "hi" }],
    requestedAt: new Date().toISOString(),
  };
}

function sse(type: string, payload: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

/** A streaming Anthropic response whose source ERRORS after `frames` frames. */
function erroringResponse(frames = 1): Response {
  const enc = new TextEncoder();
  let emitted = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (emitted < frames) {
        controller.enqueue(
          enc.encode(
            sse("content_block_delta", {
              index: 0,
              delta: { type: "text_delta", text: `c${emitted}` },
            }),
          ),
        );
        emitted++;
        return;
      }
      controller.error(new Error("source errored mid-stream"));
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}

/** A streaming response whose source HANGS and whose own `cancel` THROWS. */
function rejectingCancelResponse(frames = 1): Response {
  const enc = new TextEncoder();
  let emitted = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (emitted < frames) {
        controller.enqueue(
          enc.encode(
            sse("content_block_delta", {
              index: 0,
              delta: { type: "text_delta", text: `c${emitted}` },
            }),
          ),
        );
        emitted++;
        return;
      }
      return new Promise<void>(() => {}); // hang: never closes, never enqueues again
    },
    cancel() {
      throw new Error("source cancel rejected");
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}

/**
 * A store whose `recordSystemPrompt` never resolves, so the capture task parks
 * there: its timeout/abort listeners stay armed and it never reaches the read
 * loop or `recordTurn`. The call counters let a test prove that parking.
 */
function parkingStore(timeoutMs: number): {
  store: LogStore;
  calls: { system: number; turns: number };
} {
  const calls = { system: 0, turns: 0 };
  const store = {
    isEnabled: () => true,
    captureTimeoutMs: timeoutMs,
    recordSystemPrompt: () => {
      calls.system++;
      return new Promise<string>(() => {}); // never resolves
    },
    recordTurn: async () => {
      calls.turns++;
    },
  } as unknown as LogStore;
  return { store, calls };
}

/** Poll (bounded) for a session's first recorded turn. */
async function firstTurn(s: LogStore, sessionId: string): Promise<TurnMeta | undefined> {
  for (let i = 0; i < 400; i++) {
    await s.flush();
    const turns = await s.listTurns(sessionId);
    if (turns.length > 0) return turns[0];
    await sleep(5);
  }
  return (await s.listTurns(sessionId))[0];
}

describe("capture: streaming teardown cancel paths", () => {
  test("a source error mid-stream writes no turn; the catch-handler cancel is swallowed", async () => {
    const s = store();
    const out = captureTurn(s, context("err"), erroringResponse(1), undefined);
    // The client branch surfaces the upstream error (it is a faithful relay).
    await expect(out.text()).rejects.toThrow();

    // A failed capture must not fabricate a turn from the partial frames.
    expect(await s.listTurns("err")).toEqual([]);
    await s.close();
  });

  test("a client disconnect on a rejecting-cancel source records a truncated turn", async () => {
    const s = store();
    const out = captureTurn(s, context("disc"), rejectingCancelResponse(1), undefined);
    const reader = out.body?.getReader();
    if (reader === undefined) throw new Error("expected a streamed body");
    await reader.read();
    // Disconnect mid-stream: the log branch cancel goes through a source whose
    // own cancel REJECTS, so the swallowed handler is what keeps this quiet.
    try {
      await reader.cancel();
    } catch {
      // the client branch may surface the source's cancel rejection
    }

    const meta = await firstTurn(s, "disc");
    // The cut is recorded honestly as truncated, not as a complete "full" body.
    expect(meta?.bodyState).toBe("truncated");
    await s.close();
  });

  test("an aborted request parks before the read loop and records nothing", async () => {
    const controller = new AbortController();
    const { store: s, calls } = parkingStore(5_000);
    const out = captureTurn(s, context("abort"), erroringResponse(1), controller.signal);
    const reader = out.body?.getReader();
    await reader?.read();
    // Pull the source error through the tee so the LOG branch is errored too.
    await reader?.read().catch(() => {});
    controller.abort(); // fires onAbort -> cancels the (errored) log branch

    await sleep(40);
    // The task parked on the system-prompt write and never recorded a turn.
    expect(calls.system).toBe(1);
    expect(calls.turns).toBe(0);
  });

  test("the capture timeout cancels an errored log branch and records nothing", async () => {
    const { store: s, calls } = parkingStore(20);
    const out = captureTurn(s, context("tmo"), erroringResponse(1), undefined);
    const reader = out.body?.getReader();
    await reader?.read();
    await reader?.read().catch(() => {}); // error the log branch
    await sleep(60); // let the wall-clock timeout fire on the errored branch

    expect(calls.system).toBe(1);
    expect(calls.turns).toBe(0);
  });

  test("a timeout that the client then cancels still records a truncated turn", async () => {
    const s = store({ captureTimeoutMs: 15 });
    const out = captureTurn(s, context("late"), rejectingCancelResponse(1), undefined);
    // Let the timeout cancel the log branch with the client branch still open;
    // the source's rejecting cancel is what the timeout's swallow handler eats.
    await sleep(60);

    const reader = out.body?.getReader();
    try {
      await reader?.read();
    } catch {
      // may error
    }
    // A late client disconnect cancels the already-torn-down source.
    try {
      await reader?.cancel();
    } catch {
      // the source cancel rejection surfaces here
    }

    const meta = await firstTurn(s, "late");
    expect(meta?.bodyState).toBe("truncated");
    await s.close();
  });
});
