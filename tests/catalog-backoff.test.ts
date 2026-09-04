/**
 * PC9 discovery-hygiene tests (hermetic, no network).
 *
 * Covers the two PC9 primitives that gate refresh scheduling and per-source
 * retry cost: `jitteredInterval` (± jitter bounds) and `SourceBackoff`
 * (cooldown skip window, exponential growth, clear-on-success).
 */
import { describe, expect, test } from "bun:test";
import { SourceBackoff, jitteredInterval } from "../src/model/catalog.ts";

describe("jitteredInterval (PC9 refresh jitter)", () => {
  test("stays within ±15% of the base for any random sample", () => {
    const base = 60_000;
    const lo = base * 0.85;
    const hi = base * 1.15;
    for (let i = 0; i < 500; i++) {
      const v = jitteredInterval(base);
      expect(v).toBeGreaterThanOrEqual(lo);
      expect(v).toBeLessThanOrEqual(hi);
    }
  });

  test("rand=0 -> lower bound, rand≈1 -> upper bound (deterministic)", () => {
    const base = 60_000;
    expect(jitteredInterval(base, () => 0)).toBeCloseTo(base * 0.85, 5);
    expect(jitteredInterval(base, () => 1)).toBeCloseTo(base * 1.15, 5);
  });
});

describe("SourceBackoff (PC9 per-source cooldown)", () => {
  test("a healthy source is never skipped", () => {
    const b = new SourceBackoff();
    expect(b.shouldSkip("zai", 1000)).toBe(false);
  });

  test("a failed source is skipped during its cooldown then retried after", () => {
    const b = new SourceBackoff();
    b.recordFailure("zai", 0);
    // 1st failure -> 60s cooldown.
    expect(b.shouldSkip("zai", 30_000)).toBe(true);
    expect(b.shouldSkip("zai", 60_001)).toBe(false);
  });

  test("consecutive failures grow the cooldown exponentially, capped at 30m", () => {
    expect(SourceBackoff.cooldownMs(0)).toBe(0);
    expect(SourceBackoff.cooldownMs(1)).toBe(60_000);
    expect(SourceBackoff.cooldownMs(2)).toBe(120_000);
    expect(SourceBackoff.cooldownMs(3)).toBe(240_000);
    // 60s·2^9 = 30720s -> capped to 30 min.
    expect(SourceBackoff.cooldownMs(10)).toBe(30 * 60_000);
  });

  test("recordSuccess clears the cooldown", () => {
    const b = new SourceBackoff();
    b.recordFailure("zai", 0);
    expect(b.shouldSkip("zai", 1000)).toBe(true);
    b.recordSuccess("zai");
    expect(b.shouldSkip("zai", 1000)).toBe(false);
  });

  test("failures compound: 2nd failure extends the window from the failure time", () => {
    const b = new SourceBackoff();
    b.recordFailure("zai", 0); // window ends at 60s
    b.recordFailure("zai", 60_000); // 2nd failure -> +120s from 60s = 180s
    expect(b.shouldSkip("zai", 179_000)).toBe(true);
    expect(b.shouldSkip("zai", 180_001)).toBe(false);
  });
});
