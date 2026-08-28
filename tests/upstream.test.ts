/**
 * postJson timeout / abort / retry tests (Task 15). Uses a stubbed global fetch
 * so it is fully hermetic (no network).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { postJson } from "../src/http/upstream.ts";

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

describe("postJson", () => {
  test("returns a non-transient response without retrying", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return jsonResponse(200);
    }) as typeof fetch;
    const res = await postJson("https://x.test/api", {}, "{}");
    expect(res.status).toBe(200);
    expect(calls).toBe(1);
  });

  test("retries a transient status then succeeds", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return calls < 2 ? jsonResponse(503) : jsonResponse(200);
    }) as typeof fetch;
    const res = await postJson("https://x.test/api", {}, "{}", { maxRetries: 2 });
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
  });

  test("times out a stalled upstream (per-attempt AbortController)", async () => {
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      // Resolve/reject deterministically on abort so no promise is left pending
      // across suites (avoids late unhandled rejections attributed elsewhere).
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(new DOMException("aborted", "AbortError"));
          return;
        }
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
          once: true,
        });
      });
    }) as typeof fetch;
    await expect(
      postJson("https://x.test/slow", {}, "{}", { maxRetries: 0, timeoutMs: 30 }),
    ).rejects.toThrow(/after 1 attempts/);
  });

  test("aborts immediately when the caller signal is already aborted", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return jsonResponse(200);
    }) as typeof fetch;
    const ac = new AbortController();
    ac.abort(new Error("client gone"));
    await expect(postJson("https://x.test/api", {}, "{}", { signal: ac.signal })).rejects.toThrow(
      "client gone",
    );
    expect(calls).toBe(0);
  });
});
