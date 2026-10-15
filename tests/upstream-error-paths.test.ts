/**
 * Error-path coverage for src/http/upstream.ts (task: upstream).
 *
 * These drive the REAL helpers into their rarely-hit failure branches — the
 * ones whose function bodies only run when a subordinate promise REJECTS or
 * when a caller aborts mid-flight. Each asserts on a real observable outcome
 * (the error the caller finally sees / the request count / whether the upstream
 * signal was actually aborted), never on the shape of a stub:
 *
 *   - postJson's caller-abort listener (`onAbort`): aborting the inbound signal
 *     while a request is in flight must abort the upstream fetch and fail clean.
 *   - postJson's retry path swallowing a rejecting `res.body?.cancel()`: a
 *     transient 5xx whose discarded body cannot be released must still let the
 *     retry proceed and the request ultimately succeed.
 *   - readWithIdleTimeout swallowing a rejecting `reader.cancel()`: a hung
 *     upstream that also refuses to cancel must still surface the idle timeout.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { postJson, readWithIdleTimeout } from "../src/http/upstream.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function jsonResponse(status: number): Response {
  return new Response(JSON.stringify({ ok: status < 400 }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A real `Response` whose body is a stream that never produces data and whose
 * `cancel()` REJECTS — modelling an upstream connection whose discarded body
 * cannot be cleanly released. `res.body.cancel()` therefore returns a rejected
 * promise, exercising postJson's `await res.body?.cancel().catch(…)` swallow.
 */
function responseWithRejectingBodyCancel(status: number): Response {
  const stream = new ReadableStream<Uint8Array>({
    start() {
      // Never enqueue/close: the body stays pending, so the retry must cancel it.
    },
    cancel() {
      return Promise.reject(new Error("upstream body cancel failed"));
    },
  });
  return new Response(stream, { status });
}

describe("postJson caller-abort listener (client disconnect aborts upstream)", () => {
  test("aborts the in-flight upstream fetch and fails the request when the caller signal aborts", async () => {
    const ac = new AbortController();
    let upstreamSignal: AbortSignal | null | undefined;
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      upstreamSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    }) as typeof fetch;

    const pending = postJson("https://x.test/api", {}, "{}", {
      signal: ac.signal,
      maxRetries: 0,
    });
    // The synchronous prologue (listener registration + the fetch call) has run.
    expect(upstreamSignal?.aborted).toBe(false);
    // Aborting the inbound request must propagate to the upstream fetch.
    ac.abort(new Error("client gone"));

    await expect(pending).rejects.toThrow(/abort/i);
    expect(upstreamSignal?.aborted).toBe(true);
  });
});

describe("postJson retry with an uncancellable discarded body", () => {
  test("still retries a transient 5xx and succeeds when res.body.cancel() rejects", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      // First attempt: a transient 503 whose body refuses to cancel; the retry
      // must proceed regardless (the rejection is swallowed, not propagated).
      return calls < 2 ? responseWithRejectingBodyCancel(503) : jsonResponse(200);
    }) as typeof fetch;

    const res = await postJson("https://x.test/api", {}, "{}", { maxRetries: 2 });
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
  });
});

describe("readWithIdleTimeout with an uncancellable reader", () => {
  test("rejects with the idle-timeout error even when reader.cancel() rejects", async () => {
    let cancelledWith: unknown;
    const reader = {
      // A read that never settles (hung upstream).
      read: () => new Promise<never>(() => {}),
      cancel: (reason?: unknown) => {
        cancelledWith = reason;
        return Promise.reject(new Error("upstream reader cancel failed"));
      },
    };

    await expect(readWithIdleTimeout(reader, 10)).rejects.toThrow(/idle for more than 10ms/);
    // cancel() was attempted with the idle-timeout error and its rejection was
    // swallowed — the timeout, not the cancellation failure, is the outcome.
    expect(cancelledWith).toBeInstanceOf(Error);
    expect((cancelledWith as Error).message).toBe("Upstream stream idle for more than 10ms");
  });
});
