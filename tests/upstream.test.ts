/**
 * postJson timeout / abort / retry tests (Task 15). Uses a stubbed global fetch
 * so it is fully hermetic (no network).
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  backoffCeilingMs,
  backoffDelay,
  parseRetryAfter,
  postJson,
  preconnectOrigin,
  readWithIdleTimeout,
} from "../src/http/upstream.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function jsonResponse(status: number, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ ok: status < 400 }), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
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

  test("PC2: retryTransientStatus:false returns a transient status WITHOUT replaying the body", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return jsonResponse(503);
    }) as typeof fetch;
    const res = await postJson("https://x.test/stream", {}, "{}", {
      maxRetries: 2,
      retryTransientStatus: false,
    });
    // The transient 503 is returned as-is; the body was NOT re-sent.
    expect(res.status).toBe(503);
    expect(calls).toBe(1);
  });

  test("PC2: connection errors are still retried even when retryTransientStatus is false", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls < 2) throw new Error("ECONNRESET");
      return jsonResponse(200);
    }) as typeof fetch;
    const res = await postJson("https://x.test/stream", {}, "{}", {
      maxRetries: 2,
      retryTransientStatus: false,
    });
    // A pre-response connection error is safe to retry (no processing happened).
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
  test("PC3: honors a Retry-After header (delta-seconds) on a transient status then succeeds", async () => {
    let calls = 0;
    const start = Date.now();
    globalThis.fetch = (async () => {
      calls++;
      // Retry-After: 0 => retry immediately (no wall-clock delay), still retried.
      return calls < 2 ? jsonResponse(429, { "retry-after": "0" }) : jsonResponse(200);
    }) as typeof fetch;
    const res = await postJson("https://x.test/api", {}, "{}", { maxRetries: 2 });
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
    // Retry-After:0 must not add a long backoff delay.
    expect(Date.now() - start).toBeLessThan(500);
  });
});

describe("parseRetryAfter (PC3)", () => {
  test("parses delta-seconds into ms", () => {
    expect(parseRetryAfter("120")).toBe(120_000);
    expect(parseRetryAfter("0")).toBe(0);
  });

  test("parses an HTTP-date relative to now", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    const future = new Date(now + 30_000).toUTCString();
    expect(parseRetryAfter(future, now)).toBe(30_000);
  });

  test("clamps a past HTTP-date to 0", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    const past = new Date(now - 60_000).toUTCString();
    expect(parseRetryAfter(past, now)).toBe(0);
  });

  test("returns undefined for absent / empty / malformed values", () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter("  ")).toBeUndefined();
    expect(parseRetryAfter("not-a-date")).toBeUndefined();
  });
});

describe("backoff (PC4 exponential + full jitter)", () => {
  test("ceiling doubles per attempt then caps at 10s", () => {
    expect(backoffCeilingMs(0)).toBe(150);
    expect(backoffCeilingMs(1)).toBe(300);
    expect(backoffCeilingMs(2)).toBe(600);
    // 150·2^7 = 19200 -> capped to 10000.
    expect(backoffCeilingMs(7)).toBe(10_000);
    expect(backoffCeilingMs(20)).toBe(10_000);
  });

  test("full jitter keeps every sample within [0, ceiling)", () => {
    for (const attempt of [0, 1, 2, 5, 10]) {
      const ceiling = backoffCeilingMs(attempt);
      for (let i = 0; i < 200; i++) {
        const d = backoffDelay(attempt);
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThan(ceiling);
      }
    }
  });
});

describe("preconnectOrigin (PC5 connection warming)", () => {
  test("normalizes to the origin and calls the preconnect fn", () => {
    const seen: string[] = [];
    preconnectOrigin("https://bedrock-runtime.us-east-1.amazonaws.com/model/x/converse", (u) =>
      seen.push(u),
    );
    expect(seen).toEqual(["https://bedrock-runtime.us-east-1.amazonaws.com"]);
  });

  test("is a no-op when no preconnect fn is available (non-Bun)", () => {
    expect(() => preconnectOrigin("https://example.com", undefined)).not.toThrow();
  });

  test("swallows a malformed URL and a throwing preconnect (best-effort)", () => {
    const boom = () => {
      throw new Error("boom");
    };
    expect(() => preconnectOrigin("not a url", boom)).not.toThrow();
    expect(() => preconnectOrigin("https://example.com", boom)).not.toThrow();
  });
});

describe("readWithIdleTimeout (PC1 per-chunk idle-read)", () => {
  test("returns a chunk that arrives within the idle window", async () => {
    let calls = 0;
    const reader = {
      read: async () => {
        calls++;
        return calls === 1
          ? { done: false as const, value: new Uint8Array([1, 2, 3]) }
          : { done: true as const };
      },
      cancel: async () => {},
    };
    const first = await readWithIdleTimeout(reader, 1000);
    expect(first.done).toBe(false);
    if (!first.done) expect(first.value).toEqual(new Uint8Array([1, 2, 3]));
    const second = await readWithIdleTimeout(reader, 1000);
    expect(second.done).toBe(true);
  });

  test("throws and cancels the reader when no chunk arrives before the idle timeout", async () => {
    let cancelled = false;
    const reader = {
      // A read that never resolves (simulates a hung upstream).
      read: () => new Promise<{ done: false; value: Uint8Array }>(() => {}),
      cancel: async () => {
        cancelled = true;
      },
    };
    await expect(readWithIdleTimeout(reader, 20)).rejects.toThrow(/idle for more than 20ms/);
    expect(cancelled).toBe(true);
  });
});
