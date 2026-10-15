/**
 * keepAliveTee (P1) tests — hermetic, no network.
 *
 * The tee wraps a Path P upstream SSE body: it relays every byte UNCHANGED and
 * only interleaves a standard `event: ping` frame into idle gaps. These tests
 * feed a controlled ReadableStream and assert (1) verbatim passthrough with no
 * ping while active, (2) a ping IS injected during a silent gap, and (3) clean
 * completion when the upstream ends.
 */
import { describe, expect, test } from "bun:test";
import { keepAliveTee } from "../src/stream/keepalive-tee.ts";

const enc = new TextEncoder();

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  const dec = new TextDecoder();
  let out = "";
  const rd = stream.getReader();
  for (;;) {
    const { done, value } = await rd.read();
    if (done) break;
    if (value) out += dec.decode(value, { stream: true });
  }
  return out;
}

describe("keepAliveTee (P1)", () => {
  test("relays upstream bytes verbatim and injects no ping when never idle", async () => {
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode("event: message_start\ndata: {}\n\n"));
        c.enqueue(enc.encode("event: content_block_delta\ndata: {}\n\n"));
        c.close();
      },
    });
    // Huge idle window so the timer never fires during this fast stream.
    const out = await collect(keepAliveTee(upstream, 1_000_000));
    expect(out).toBe("event: message_start\ndata: {}\n\nevent: content_block_delta\ndata: {}\n\n");
    expect(out).not.toContain("event: ping");
  });

  test("injects a standard ping frame during an idle gap, then relays the rest", async () => {
    let enqueueLate: (() => void) | undefined;
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode("event: message_start\ndata: {}\n\n"));
        // Hold the stream open, then emit a final chunk + close after a delay.
        enqueueLate = () => {
          c.enqueue(enc.encode("event: message_stop\ndata: {}\n\n"));
          c.close();
        };
      },
    });
    // Tiny idle window so a ping is injected during the gap before the late chunk.
    const teed = keepAliveTee(upstream, 5);
    const collected = collect(teed);
    await new Promise((r) => setTimeout(r, 40)); // idle gap -> ping(s) injected
    enqueueLate?.();
    const out = await collected;
    expect(out).toContain('event: ping\ndata: {"type":"ping"}');
    expect(out).toContain("event: message_start");
    expect(out).toContain("event: message_stop");
  });

  test("cancelling the teed stream cancels the upstream reader", async () => {
    let cancelled = false;
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode("event: message_start\ndata: {}\n\n"));
        // never closes
      },
      cancel() {
        cancelled = true;
      },
    });
    const teed = keepAliveTee(upstream, 1_000_000);
    const rd = teed.getReader();
    await rd.read(); // first chunk
    await rd.cancel(new Error("client gone"));
    expect(cancelled).toBe(true);
  });

  // A1: Path P had NO upstream stall bound — a bare reader.read() hangs forever
  // on a silent upstream, and the tee's own pings keep the client watchdog from
  // firing either. The pump now uses readWithIdleTimeout, so a stalled upstream
  // fails the client stream cleanly within the idle bound instead of hanging.
  test("a stalled upstream fails the client stream within the idle bound", async () => {
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode("event: message_start\ndata: {}\n\n"));
        // Then silence forever (never closes).
      },
    });
    // ping idle 5ms (pings keep flowing), stream idle 60ms (the stall bound).
    const teed = keepAliveTee(upstream, 5, 60);
    const start = Date.now();
    // collect() rejects when the teed stream errors (rather than ending cleanly).
    await expect(collect(teed)).rejects.toThrow(/idle for more than 60ms/);
    // It failed on the idle bound — not by hanging.
    expect(Date.now() - start).toBeLessThan(2_000);
  });

  // A1 (regression): the idle bound must not trip a HEALTHY-but-slow stream.
  // A gap larger than the ping idle (so a ping is injected) but smaller than the
  // stream idle still relays every byte verbatim.
  test("a healthy slow stream relays every byte verbatim and still pings", async () => {
    let enqueueLate: (() => void) | undefined;
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode("event: message_start\ndata: {}\n\n"));
        enqueueLate = () => {
          c.enqueue(enc.encode("event: message_stop\ndata: {}\n\n"));
          c.close();
        };
      },
    });
    // ping idle 10ms, stream idle 5s — a 50ms gap pings but never trips the bound.
    const teed = keepAliveTee(upstream, 10, 5_000);
    const collected = collect(teed);
    await new Promise((r) => setTimeout(r, 50)); // idle gap -> ping(s) injected
    enqueueLate?.();
    const out = await collected;
    expect(out).toContain('event: ping\ndata: {"type":"ping"}');
    // Both real frames are relayed byte-for-byte, in order, uninterrupted.
    expect(out).toContain("event: message_start\ndata: {}\n\n");
    expect(out).toContain("event: message_stop\ndata: {}\n\n");
  });
});
