/**
 * Bounded capture tests (src/logging/capture.ts) — the most important guarantee
 * in the logging subsystem.
 *
 * Capture tees a streaming response: one branch relays to the client and the
 * other accumulates a turn for the log. Only the LOG branch is bounded — a
 * per-turn byte cap truncates one turn's body and a global in-flight budget
 * sheds new turns' bodies — and **the client branch is never affected**. These
 * tests prove that by running the SAME captured upstream stream through
 * `captureTurn` with an exhausted budget and a tiny cap and asserting the client
 * reader still sees every byte, identical to the unlogged case.
 *
 * The exact body-state transitions (shed / truncated) are additionally pinned
 * deterministically against `AnthropicStreamAccumulator` with an explicit
 * `CaptureBudget`, so no scheduling is involved.
 *
 * Hermetic: replays a REAL captured upstream stream; no network.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoggingConfig } from "../src/config.ts";
import {
  AnthropicStreamAccumulator,
  CaptureBudget,
  type CaptureContext,
  captureCounters,
  captureTurn,
  configureCaptureBudget,
  resetCaptureBudget,
} from "../src/logging/capture.ts";
import { LogStore } from "../src/logging/log-store.ts";
import type { TurnMeta } from "../src/logging/log-types.ts";
import { readFixtureText, streamOf } from "./helpers/fetch-mock.ts";

const DEFAULT_CAP = 8 * 1024 * 1024;
const DEFAULT_BUDGET = 256 * 1024 * 1024;

/** The real captured Anthropic SSE stream, as the client would receive it. */
const UPSTREAM = new TextEncoder().encode(readFixtureText("anthropic-stream.sse"));

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ccpp-logging-capture-"));
  resetCaptureBudget();
});

afterEach(() => {
  resetCaptureBudget();
  configureCaptureBudget({ maxTurnBytes: DEFAULT_CAP, inFlightBudgetBytes: DEFAULT_BUDGET });
  rmSync(root, { recursive: true, force: true });
});

function logConfig(over: Partial<LoggingConfig> = {}): LoggingConfig {
  return {
    enabled: true,
    dir: root,
    systemDir: "system",
    sessionDir: "sessions",
    captureTimeoutMs: 5_000,
    compression: { enabled: false, minAgeMinutes: 10 },
    retentionDays: 30,
    maxTurnBytes: DEFAULT_CAP,
    inFlightBudgetBytes: DEFAULT_BUDGET,
    indexFlushMs: 60_000,
    zstdLevel: 3,
    ...over,
  };
}

function store(over: Partial<LoggingConfig> = {}): LogStore {
  return new LogStore(logConfig(over), { writerMode: "inline" });
}

function response(): Response {
  return new Response(streamOf(UPSTREAM, 4), {
    headers: { "content-type": "text/event-stream" },
  });
}

function context(sessionId: string): CaptureContext {
  return {
    sessionId,
    canonicalModel: "bedrock.converse.global.m",
    invocationModel: "m",
    backend: "converse",
    translationPath: "converse",
    system: "You are terse.",
    messages: [{ role: "user", content: "hi" }],
    requestedAt: new Date().toISOString(),
  };
}

async function collect(resp: Response): Promise<Uint8Array> {
  return new Uint8Array(await resp.arrayBuffer());
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Wait (bounded) for the detached log branch to record its turn. */
async function waitForTurns(s: LogStore, sid: string, min = 1): Promise<TurnMeta[]> {
  for (let i = 0; i < 400; i++) {
    await s.flush();
    const turns = await s.listTurns(sid);
    if (turns.length >= min) return turns;
    await new Promise((r) => setTimeout(r, 5));
  }
  return s.listTurns(sid);
}

/** Encode one Anthropic SSE frame. */
function sse(type: string, payload: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

/** A tool-using turn: usage at the start, a tool_use block, stop_reason at the end. */
function feedToolTurn(acc: AnthropicStreamAccumulator, body: string): void {
  acc.push(sse("message_start", { message: { usage: { input_tokens: 11 } } }));
  acc.push(
    sse("content_block_start", {
      index: 0,
      content_block: { type: "tool_use", id: "toolu_1", name: "get_weather" },
    }),
  );
  acc.push(
    sse("content_block_delta", {
      index: 0,
      delta: { type: "input_json_delta", partial_json: body },
    }),
  );
  acc.push(
    sse("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } }),
  );
}

describe("client stream is never affected by capture bounds", () => {
  test("baseline: the unlogged client stream is the upstream bytes verbatim", async () => {
    expect(bytesEqual(await collect(response()), UPSTREAM)).toBe(true);
  });

  test("budget ~zero SHEDS the body; the client still sees every byte", async () => {
    // A 1-byte in-flight budget means every captured body is shed on its first
    // byte of bulk content. The client branch must be untouched.
    const s = store({ inFlightBudgetBytes: 1 });
    const out = captureTurn(s, context("shed"), response(), undefined);

    const seen = await collect(out);
    expect(bytesEqual(seen, UPSTREAM)).toBe(true);
    expect(seen.byteLength).toBe(UPSTREAM.byteLength);

    const metas = await waitForTurns(s, "shed");
    expect(metas.length).toBeGreaterThan(0);
    expect(metas[0]?.bodyState).toBe("shed");
    expect(metas[0]?.bodyFile).toBeNull();
    // Metadata survives the shed body.
    expect(metas[0]?.modelRequested).toBe("bedrock.converse.global.m");
    expect(metas[0]?.stopReason).toBe("end_turn");
    expect(metas[0]?.inputTokens).toBe(19);
    await s.close();
  });

  test("a tiny per-turn cap TRUNCATES the body; the client still sees every byte", async () => {
    const s = store({ maxTurnBytes: 64 });
    const out = captureTurn(s, context("trunc"), response(), undefined);

    const seen = await collect(out);
    expect(bytesEqual(seen, UPSTREAM)).toBe(true);

    const metas = await waitForTurns(s, "trunc");
    expect(metas.length).toBeGreaterThan(0);
    expect(metas[0]?.bodyState).toBe("truncated");
    await s.close();
  });

  test("plenty of budget leaves the body full and the client identical", async () => {
    const s = store();
    const out = captureTurn(s, context("full"), response(), undefined);
    const seen = await collect(out);
    expect(bytesEqual(seen, UPSTREAM)).toBe(true);

    const metas = await waitForTurns(s, "full");
    expect(metas[0]?.bodyState).toBe("full");
    expect(metas[0]?.bodyFile).not.toBeNull();
    await s.close();
  });
});

describe("capture: outcome signals actually reach the turn", () => {
  // Both real captured fixtures report cache_read_input_tokens: 0, so asserting
  // a reported ZERO (not null) is what proves the plumbing works end to end —
  // the field being null is exactly the bug these tests exist to catch.

  test("a streamed turn records the cached-read tokens the upstream reported", async () => {
    const s = store();
    const out = captureTurn(s, context("out-stream"), response(), undefined);
    await collect(out);

    const metas = await waitForTurns(s, "out-stream");
    expect(metas[0]?.cacheReadTokens).toBe(0);
    expect(metas[0]?.cacheReadTokens).not.toBeNull();
    // Latency is derived from timestamps already on the turn, so it is always set.
    expect(typeof metas[0]?.latencyMs).toBe("number");
    await s.close();
  });

  test("a non-streamed turn records cached-read tokens and latency too", async () => {
    const s = store();
    const resp = new Response(readFixtureText("anthropic-text.json"), {
      headers: { "content-type": "application/json" },
    });

    captureTurn(s, context("out-json"), resp, undefined);

    const metas = await waitForTurns(s, "out-json");
    expect(metas[0]?.cacheReadTokens).toBe(0);
    expect(typeof metas[0]?.latencyMs).toBe("number");
    await s.close();
  });

  test("a non-zero cached-read count is carried through, not flattened", () => {
    const acc = new AnthropicStreamAccumulator(new CaptureBudget(DEFAULT_CAP, DEFAULT_BUDGET));
    acc.push(
      sse("message_start", {
        message: { usage: { input_tokens: 5, cache_read_input_tokens: 900 } },
      }),
    );
    expect(acc.cacheReadTokens).toBe(900);
  });
});

describe("AnthropicStreamAccumulator bounds (deterministic)", () => {
  test("sheds the body under budget pressure but keeps usage, stop reason and tool names", () => {
    const acc = new AnthropicStreamAccumulator(new CaptureBudget(DEFAULT_CAP, 1));
    feedToolTurn(acc, '{"city":"Berlin"}');

    expect(acc.bodyState).toBe("shed");
    expect(acc.content()).toEqual([]);
    // Metadata is captured regardless of the shed body.
    expect(acc.toolCalls).toEqual(["get_weather"]);
    expect(acc.stopReason).toBe("tool_use");
    expect(acc.inputTokens).toBe(11);
    expect(acc.outputTokens).toBe(7);
    acc.dispose();
  });

  test("truncates at the per-turn cap and appends a truncation marker", () => {
    // Cap large enough to hold a single SSE frame (so events are parsed) but
    // small enough that the text deltas overflow it.
    const acc = new AnthropicStreamAccumulator(new CaptureBudget(200, DEFAULT_BUDGET));
    acc.push(sse("message_start", { message: { usage: { input_tokens: 11 } } }));
    acc.push(sse("content_block_start", { index: 0, content_block: { type: "text" } }));
    for (let i = 0; i < 15; i++) {
      acc.push(
        sse("content_block_delta", {
          index: 0,
          delta: { type: "text_delta", text: "x".repeat(20) },
        }),
      );
    }
    acc.push(
      sse("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } }),
    );

    expect(acc.bodyState).toBe("truncated");
    const blocks = acc.content() as Array<{ type: string; text?: string }>;
    const marker = blocks[blocks.length - 1];
    expect(marker?.type).toBe("text");
    expect(marker?.text).toContain("capture truncated");
    // Metadata survives the truncation.
    expect(acc.stopReason).toBe("end_turn");
    expect(acc.inputTokens).toBe(11);
    expect(acc.outputTokens).toBe(4);
    acc.dispose();
  });

  test("an unbounded accumulator keeps the full body and no marker", () => {
    const acc = new AnthropicStreamAccumulator(new CaptureBudget(DEFAULT_CAP, DEFAULT_BUDGET));
    acc.push(sse("content_block_start", { index: 0, content_block: { type: "text" } }));
    acc.push(
      sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: "hello" } }),
    );
    expect(acc.bodyState).toBe("full");
    expect(acc.content()).toEqual([{ type: "text", text: "hello" }]);
    acc.dispose();
  });
});

describe("CaptureBudget accounting", () => {
  test("reserve respects the global budget and release saturates at zero", () => {
    const budget = new CaptureBudget(1024, 100);
    expect(budget.reserve(60)).toBe(true);
    expect(budget.freeBytes()).toBe(40);
    expect(budget.reserve(50)).toBe(false); // would exceed 100
    expect(budget.freeBytes()).toBe(40);
    budget.release(1000); // saturating
    expect(budget.freeBytes()).toBe(100);
    expect(budget.reserve(0)).toBe(true); // no-op
  });

  test("captureCounters reflects the shared budget's shed tally", () => {
    configureCaptureBudget({ maxTurnBytes: DEFAULT_CAP, inFlightBudgetBytes: 1 });
    const acc = new AnthropicStreamAccumulator(); // shared budget
    acc.push(sse("content_block_start", { index: 0, content_block: { type: "text" } }));
    acc.push(
      sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: "hello" } }),
    );
    acc.dispose();

    expect(acc.bodyState).toBe("shed");
    const counters = captureCounters();
    expect(counters.turnsShed).toBe(1);
    expect(counters.inFlightBudgetBytes).toBe(1);

    resetCaptureBudget();
    expect(captureCounters().turnsShed).toBe(0);
    expect(captureCounters().bytesInFlight).toBe(0);
  });
});
