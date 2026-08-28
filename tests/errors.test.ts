/**
 * Error taxonomy tests — hermetic.
 *
 * Covers the Task 24/26 additions: ProxyError.cause propagation, UpstreamError
 * context/upstreamBody, and the assertNever exhaustiveness guard.
 */
import { describe, expect, test } from "bun:test";
import {
  BadRequestError,
  ConfigError,
  ProxyError,
  UpstreamError,
  assertNever,
} from "../src/errors.ts";

describe("ProxyError cause propagation", () => {
  test("preserves Error.cause when provided", () => {
    const root = new Error("root failure");
    const err = new ConfigError("wrapper", { cause: root });
    expect(err.cause).toBe(root);
    expect(err.status).toBe(500);
    expect(err.type).toBe("config_error");
  });

  test("omits cause cleanly when not provided", () => {
    const err = new BadRequestError("bad body");
    expect(err.cause).toBeUndefined();
    expect(err.status).toBe(400);
  });

  test("toAnthropicBody renders the type + message (never the cause)", () => {
    const err = new ConfigError("boom", { cause: new Error("secret detail") });
    expect(err.toAnthropicBody()).toEqual({
      type: "error",
      error: { type: "config_error", message: "boom" },
    });
  });
});

describe("UpstreamError", () => {
  test("carries upstreamBody + context and a 5xx status", () => {
    const err = new UpstreamError(502, "Upstream 502", {
      upstreamBody: '{"error":"provider down"}',
      context: { route: "https://x/model", model: "m-1" },
      cause: new Error("socket hang up"),
    });
    expect(err.status).toBe(502);
    expect(err.type).toBe("api_error");
    expect(err.upstreamBody).toBe('{"error":"provider down"}');
    expect(err.context).toEqual({ route: "https://x/model", model: "m-1" });
    expect((err.cause as Error).message).toBe("socket hang up");
    expect(err instanceof ProxyError).toBe(true);
  });

  test("options are all optional", () => {
    const err = new UpstreamError(503, "Upstream 503");
    expect(err.upstreamBody).toBeUndefined();
    expect(err.context).toBeUndefined();
  });
});

describe("assertNever", () => {
  test("throws with the offending value + context", () => {
    const bogus = "unexpected" as never;
    expect(() => assertNever(bogus, "MyUnion.kind")).toThrow(/MyUnion\.kind/);
    expect(() => assertNever(bogus)).toThrow(/unexpected/);
  });

  test("is reachable only at runtime (compile-time never)", () => {
    // Simulate a switch that received an out-of-union wire value.
    function classify(kind: "a" | "b"): string {
      switch (kind) {
        case "a":
          return "A";
        case "b":
          return "B";
        default:
          return assertNever(kind, "kind");
      }
    }
    expect(classify("a")).toBe("A");
    expect(() => classify("c" as "a")).toThrow();
  });
});
