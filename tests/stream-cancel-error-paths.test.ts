/**
 * Upstream-cancel teardown for the two streaming decoders
 * (src/stream/converse-events.ts, src/stream/openai-sse.ts).
 *
 * Both bridges register a client-disconnect hook that aborts the upstream read
 * — `void reader.cancel().catch(() => {})` — and tear down after an upstream
 * read error with a second swallowed cancel — `await reader.cancel(err)
 * .catch(() => {})`. The `.catch(() => {})` exists so a REJECTING upstream
 * cancel can never reach the request path as an unhandled rejection, and can
 * never replace the error the client is meant to see.
 *
 * Each test below drives a reader whose `cancel()` REJECTS through one of those
 * paths and asserts the decoder still degrades correctly: the upstream cancel
 * was attempted, the client stream ends with the real typed error event, and no
 * unhandled rejection escapes.
 */
import { describe, expect, test } from "bun:test";
import { converseStreamToAnthropicSse } from "../src/stream/converse-events.ts";
import { openAiStreamToAnthropicSse } from "../src/stream/openai-sse.ts";
import { readFixtureBase64, readFixtureText } from "./helpers/fetch-mock.ts";

const enc = new TextEncoder();
const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Capture any process-level unhandled rejection for the duration of one test.
 * The bridges swallow a rejecting `reader.cancel()` precisely so a failed
 * teardown never surfaces as an unhandled rejection; `seen` being empty after a
 * rejecting-cancel teardown is that contract.
 */
function watchUnhandledRejections(): { seen: unknown[]; stop: () => void } {
  const seen: unknown[] = [];
  const onRejection = (reason: unknown): void => {
    seen.push(reason);
  };
  process.on("unhandledRejection", onRejection);
  return { seen, stop: () => process.off("unhandledRejection", onRejection) };
}

/**
 * A duck-typed upstream body whose reader rejects `read()` with `readErr` and
 * rejects `cancel()` with a DISTINCT `cancelErr`. A real ReadableStream cannot
 * be in that state — a rejecting read means the stream itself errored, so its
 * own `cancel()` rejects with the SAME stored error — so this seam is the only
 * way to prove the bridge surfaces the READ error rather than the teardown's
 * cancel error. The bridge's pump, catch and finally blocks are the real code.
 */
function rejectingReaderBody(
  readErr: Error,
  cancelErr: Error,
  opts: { releaseLockThrows?: boolean } = {},
): ReadableStream<Uint8Array> {
  const reader = {
    read: () => Promise.reject(readErr),
    cancel: () => Promise.reject(cancelErr),
    releaseLock: () => {
      if (opts.releaseLockThrows) throw new Error("releaseLock after cancel rejected");
    },
  };
  return { getReader: () => reader } as unknown as ReadableStream<Uint8Array>;
}

describe("converse-events.ts — upstream-cancel teardown with a REJECTING cancel", () => {
  test("a client disconnect aborts the upstream read; the rejecting upstream cancel is swallowed", async () => {
    const frames = readFixtureBase64("converse-stream.b64");
    let upstreamCancelled = false;
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(frames);
        // Stays open — a live Converse stream between events.
      },
      cancel() {
        upstreamCancelled = true;
        throw new Error("upstream cancel rejected");
      },
    });
    const watch = watchUnhandledRejections();
    try {
      const rd = converseStreamToAnthropicSse(upstream, "m").getReader();
      const first = await rd.read();
      expect(first.done).toBe(false); // the bridge emitted its first SSE event
      await rd.cancel(new Error("client gone")); // client disconnect
      await tick();
      // onCancel reached the upstream reader despite its cancel() rejecting.
      expect(upstreamCancelled).toBe(true);
    } finally {
      watch.stop();
    }
    expect(watch.seen).toEqual([]);
  });

  test("an upstream read error fails the client stream; the errored-stream cancel rejection is swallowed", async () => {
    // An already-errored stream: read() rejects, and the teardown's
    // reader.cancel(err) rejects too (an errored stream returns its stored
    // error). The swallow must keep the ORIGINAL failure as the surfaced one.
    const watch = watchUnhandledRejections();
    let text = "";
    try {
      const upstream = new ReadableStream<Uint8Array>({
        start(c) {
          c.error(new Error("converse upstream exploded"));
        },
      });
      text = await new Response(converseStreamToAnthropicSse(upstream, "m")).text();
    } finally {
      watch.stop();
    }
    expect(text).toContain("event: error");
    expect(text).toContain("converse upstream exploded");
    expect(watch.seen).toEqual([]);
  });

  test("a read error plus a DISTINCT cancel error and a throwing releaseLock surface the read error", async () => {
    const watch = watchUnhandledRejections();
    let text = "";
    try {
      const body = rejectingReaderBody(
        new Error("converse read failed"),
        new Error("converse cancel failed"),
        { releaseLockThrows: true },
      );
      text = await new Response(converseStreamToAnthropicSse(body, "m")).text();
    } finally {
      watch.stop();
    }
    expect(text).toContain("event: error");
    expect(text).toContain("converse read failed");
    // Neither the cancel rejection nor the releaseLock throw masked it.
    expect(text).not.toContain("converse cancel failed");
    expect(text).not.toContain("releaseLock");
    expect(watch.seen).toEqual([]);
  });
});

describe("openai-sse.ts — upstream-cancel teardown with a REJECTING cancel", () => {
  test("a client disconnect aborts the upstream read; the rejecting upstream cancel is swallowed", async () => {
    const bytes = enc.encode(readFixtureText("openai-stream.sse"));
    let upstreamCancelled = false;
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes);
        // Stays open — a live SSE stream between chunks.
      },
      cancel() {
        upstreamCancelled = true;
        throw new Error("upstream cancel rejected");
      },
    });
    const watch = watchUnhandledRejections();
    try {
      const rd = openAiStreamToAnthropicSse(upstream, "m").getReader();
      const first = await rd.read();
      expect(first.done).toBe(false); // the bridge emitted its first SSE event
      await rd.cancel(new Error("client gone")); // client disconnect
      await tick();
      expect(upstreamCancelled).toBe(true);
    } finally {
      watch.stop();
    }
    expect(watch.seen).toEqual([]);
  });

  test("an upstream read error fails the client stream; the errored-stream cancel rejection is swallowed", async () => {
    const watch = watchUnhandledRejections();
    let text = "";
    try {
      const upstream = new ReadableStream<Uint8Array>({
        start(c) {
          c.error(new Error("openai upstream exploded"));
        },
      });
      text = await new Response(openAiStreamToAnthropicSse(upstream, "m")).text();
    } finally {
      watch.stop();
    }
    expect(text).toContain("event: error");
    expect(text).toContain("openai upstream exploded");
    expect(watch.seen).toEqual([]);
  });

  test("a read error plus a DISTINCT cancel error and a throwing releaseLock surface the read error", async () => {
    const watch = watchUnhandledRejections();
    let text = "";
    try {
      const body = rejectingReaderBody(
        new Error("openai read failed"),
        new Error("openai cancel failed"),
        { releaseLockThrows: true },
      );
      text = await new Response(openAiStreamToAnthropicSse(body, "m")).text();
    } finally {
      watch.stop();
    }
    expect(text).toContain("event: error");
    expect(text).toContain("openai read failed");
    expect(text).not.toContain("openai cancel failed");
    expect(text).not.toContain("releaseLock");
    expect(watch.seen).toEqual([]);
  });
});
