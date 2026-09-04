/**
 * captureTurn / captureStreaming wiring tests (hermetic, no network).
 *
 * Covers the tee-based capture path and the Task 0 signal/timeout logic:
 *   - a streaming turn is reconstructed + recorded from a real Anthropic SSE
 *     fixture, while the client branch is relayed intact;
 *   - a non-streaming turn is recorded from a clone;
 *   - capture is a no-op when the store is disabled or the response is not ok;
 *   - aborting the inbound signal cancels the log branch (no turn recorded),
 *     and the client branch is still consumable.
 *
 * Uses a stub LogStore (captureTurn only calls isEnabled/recordSystemPrompt/
 * recordTurn) and real Anthropic SSE bytes captured from live Bedrock.
 */
import { describe, expect, test } from "bun:test";
import { type CaptureContext, captureTurn } from "../src/logging/capture.ts";
import type { LogStore, TurnRecord } from "../src/logging/log-store.ts";
import { readFixtureText, streamOf } from "./helpers/fetch-mock.ts";

interface Recorded {
  turns: TurnRecord[];
  systemHashes: number;
}

function stubStore(enabled = true): { store: LogStore; rec: Recorded } {
  const rec: Recorded = { turns: [], systemHashes: 0 };
  const store = {
    isEnabled: () => enabled,
    captureTimeoutMs: 120_000,
    recordSystemPrompt: async (_system: unknown) => {
      rec.systemHashes++;
      return "hash";
    },
    recordTurn: async (turn: TurnRecord) => {
      rec.turns.push(turn);
    },
  } as unknown as LogStore;
  return { store, rec };
}

function ctx(): CaptureContext {
  return {
    sessionId: "sess-1",
    canonicalModel: "bedrock.mantle.us.anthropic.claude",
    invocationModel: "anthropic.claude",
    backend: "anthropic",
    translationPath: "passthrough",
    system: "You are helpful.",
    messages: [{ role: "user", content: "hi" }],
    requestedAt: new Date().toISOString(),
  };
}

/** Wait for the detached capture task to flush. */
const flush = () => new Promise((r) => setTimeout(r, 50));

function sseResponse(bytes: Uint8Array, chunks = 3): Response {
  return new Response(streamOf(bytes, chunks), {
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}

describe("captureTurn (streaming)", () => {
  test("records a reconstructed turn and relays the client branch intact", async () => {
    const bytes = new TextEncoder().encode(readFixtureText("anthropic-stream.sse"));
    const { store, rec } = stubStore();
    const out = captureTurn(store, ctx(), sseResponse(bytes));

    // Client branch is fully readable (relayed unchanged).
    const clientText = await out.text();
    expect(clientText).toContain("event: message_start");

    await flush();
    expect(rec.turns).toHaveLength(1);
    const turn = rec.turns[0];
    expect(turn?.streamed).toBe(true);
    expect(turn?.sessionId).toBe("sess-1");
    expect(Array.isArray(turn?.responseContent)).toBe(true);
    // Usage was extracted from the SSE stream.
    expect(typeof turn?.usage.inputTokens).toBe("number");
  });

  test("PC8: cancelling the client branch stops the log branch promptly (no inbound signal)", async () => {
    const { store, rec } = stubStore();
    // A stream that emits one chunk then stalls forever (upstream never closes).
    const stalling = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("event: message_start\ndata: {}\n\n"));
        // never close / never enqueue again
      },
    });
    const resp = new Response(stalling, {
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    });
    // No inbound signal — the ONLY thing that can stop the log branch here is
    // the client-branch-ended follower wiring (PC8).
    const out = captureTurn(store, ctx(), resp);
    // Read one chunk from the client branch, then cancel it (client disconnect).
    const reader = out.body?.getReader();
    await reader?.read();
    await reader?.cancel(new Error("client hung up"));

    // The log-branch pump must complete promptly (records a partial turn OR
    // bails) rather than hanging forever on the stalled upstream.
    const start = Date.now();
    while (rec.turns.length === 0 && Date.now() - start < 1000) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(Date.now() - start).toBeLessThan(1000);
    expect(rec.turns).toHaveLength(1); // partial turn recorded after follower cancel
  });

  test("no-op when the store is disabled (returns the same response object)", async () => {
    const bytes = new TextEncoder().encode(readFixtureText("anthropic-stream.sse"));
    const { store, rec } = stubStore(false);
    const resp = sseResponse(bytes);
    const out = captureTurn(store, ctx(), resp);
    expect(out).toBe(resp);
    await flush();
    expect(rec.turns).toHaveLength(0);
  });

  test("aborting the inbound signal stops the log branch promptly (does not hang)", async () => {
    const { store, rec } = stubStore();
    // A stream that emits one chunk then stalls forever. Without the Task 0
    // abort wiring the log-branch pump would await read() indefinitely; with it,
    // the abort cancels the reader so the pump completes promptly. We assert it
    // finishes within a bound (not that it hangs).
    const stalling = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("event: message_start\ndata: {}\n\n"));
        // never close / never enqueue again
      },
    });
    const resp = new Response(stalling, {
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    });
    const controller = new AbortController();
    const out = captureTurn(store, ctx(), resp, controller.signal);
    expect(out.body).not.toBeNull();

    await new Promise((r) => setTimeout(r, 10));
    controller.abort(new Error("client gone"));

    // Poll for the pump to finish (record a partial turn OR bail) within 1s.
    // A hung pump (no abort wiring) would never resolve and this would time out.
    const start = Date.now();
    while (rec.turns.length === 0 && Date.now() - start < 1000) {
      await new Promise((r) => setTimeout(r, 20));
    }
    // The pump completed after abort rather than hanging forever on read().
    expect(Date.now() - start).toBeLessThan(1000);
    await out.body?.cancel().catch(() => {});
  });
});

describe("captureTurn (non-streaming)", () => {
  test("records a turn from a JSON clone and returns the response", async () => {
    const body = readFixtureText("anthropic-text.json");
    const { store, rec } = stubStore();
    const resp = new Response(body, { headers: { "content-type": "application/json" } });
    const out = captureTurn(store, ctx(), resp);
    // Original response body is still readable by the client.
    const json = (await out.json()) as Record<string, unknown>;
    expect(json.type).toBe("message");
    await flush();
    expect(rec.turns).toHaveLength(1);
    expect(rec.turns[0]?.streamed).toBe(false);
  });

  test("no-op when the response is not ok", async () => {
    const { store, rec } = stubStore();
    const resp = new Response("nope", { status: 500 });
    const out = captureTurn(store, ctx(), resp);
    expect(out).toBe(resp);
    await flush();
    expect(rec.turns).toHaveLength(0);
  });
});
