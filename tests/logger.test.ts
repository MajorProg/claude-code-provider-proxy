/**
 * Logger unit tests (Task 16): level gating, structured field formatting, and
 * the errorMessage helper.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { errorMessage, logger, newRequestId } from "../src/logging/logger.ts";

// Capture console output for assertions.
function capture(fn: () => void): string[] {
  const lines: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...a: unknown[]) => lines.push(a.join(" "));
  console.warn = (...a: unknown[]) => lines.push(a.join(" "));
  console.error = (...a: unknown[]) => lines.push(a.join(" "));
  try {
    fn();
  } finally {
    console.log = orig.log;
    console.warn = orig.warn;
    console.error = orig.error;
  }
  return lines;
}

afterEach(() => {});

describe("logger", () => {
  test("formats structured fields as key=value, quoting whitespace", () => {
    const out = capture(() => logger.error("boom", { requestId: "abc", note: "has space" }));
    expect(out.length).toBe(1);
    expect(out[0]).toContain("[error] boom");
    expect(out[0]).toContain("requestId=abc");
    expect(out[0]).toContain('note="has space"');
  });

  test("omits undefined fields", () => {
    const out = capture(() => logger.error("x", { a: 1, b: undefined }));
    expect(out[0]).toContain("a=1");
    expect(out[0]).not.toContain("b=");
  });

  test("error level always emits (default level is info)", () => {
    const out = capture(() => logger.error("err-line"));
    expect(out.some((l) => l.includes("err-line"))).toBe(true);
  });
});

describe("errorMessage", () => {
  test("extracts message from Error", () => {
    expect(errorMessage(new Error("nope"))).toBe("nope");
  });
  test("stringifies non-Error values", () => {
    expect(errorMessage("plain")).toBe("plain");
    expect(errorMessage(42)).toBe("42");
  });
});

describe("newRequestId", () => {
  test("returns an 8-char hex id", () => {
    const id = newRequestId();
    expect(id).toMatch(/^[0-9a-f]{8}$/);
  });
});
