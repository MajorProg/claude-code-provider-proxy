import { afterEach, describe, expect, test } from "bun:test";
/**
 * CredentialCooldownStore disk persistence — quota marks and live cooldowns
 * survive a process restart via the state file (labels + epoch ms only,
 * atomic tmp+rename; the live path is <logging.dir>/cooldown-state.json,
 * inside the Docker-mounted ./logs volume).
 *
 * Hermetic: real file IO against a per-test tmpdir; no network, no timers
 * relied on (clear() at the end of each case disposes restored timers).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialCooldownStore } from "../src/failover.ts";

const dirs: string[] = [];

function statePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "ccpp-cooldown-state-"));
  dirs.push(dir);
  return join(dir, "cooldown-state.json");
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("CredentialCooldownStore persistence", () => {
  test("live cooldowns and quota marks survive into a fresh store (restart)", () => {
    const path = statePath();
    const a = new CredentialCooldownStore({ statePath: path });
    const weeklyReset = Date.now() + 4 * 24 * 3600_000; // days out -> 1h-clamped cooldown
    a.mark("zai", "primary", weeklyReset, () => 0);
    a.mark("zai", "secondary", undefined, () => 0);
    const untilPrimary = a.degradedUntil("zai", "primary") ?? 0;

    // New process, same file: cooldowns re-armed, quota marks restored.
    const b = new CredentialCooldownStore({ statePath: path });
    expect(b.isDegraded("zai", "primary")).toBe(true);
    expect(b.isDegraded("zai", "secondary")).toBe(true);
    expect(b.degradedUntil("zai", "primary")).toBe(untilPrimary);
    const marks = b.quotaSnapshot();
    expect(marks.find((m) => m.label === "primary")?.quotaResetAt).toBe(weeklyReset);
    expect(marks.find((m) => m.label === "secondary")?.quotaResetAt).toBeUndefined();

    // The file carries identifiers + epoch ms only — the store never sees
    // credential values at all, so nothing secret can leak into it.
    const raw = readFileSync(path, "utf8");
    expect(raw).toContain('"version":1');
    a.clear();
    b.clear();
  });

  test("a cooldown already past expiry is dropped on load; its quota mark still restores", () => {
    const path = statePath();
    const expired = Date.now() - 1000;
    writeFileSync(
      path,
      `${JSON.stringify({
        version: 1,
        cooldowns: [{ provider: "zai", label: "primary", untilMs: expired }],
        quotaMarks: [
          {
            provider: "zai",
            label: "primary",
            last429At: expired,
            quotaResetAt: Date.now() + 86_400_000,
          },
        ],
      })}\n`,
    );
    const b = new CredentialCooldownStore({ statePath: path });
    expect(b.isDegraded("zai", "primary")).toBe(false);
    const marks = b.quotaSnapshot();
    expect(marks).toHaveLength(1);
    expect(marks[0]?.quotaResetAt ?? 0).toBeGreaterThan(Date.now());
    b.clear();
  });

  test("a corrupt state file starts fresh without throwing", () => {
    const path = statePath();
    writeFileSync(path, "{not json");
    const b = new CredentialCooldownStore({ statePath: path });
    expect(b.snapshot()).toEqual([]);
    expect(b.quotaSnapshot()).toEqual([]);
  });

  test("missing state file (first boot) is silent and empty", () => {
    const path = join(tmpdir(), "ccpp-cooldown-state-missing", "cooldown-state.json");
    const b = new CredentialCooldownStore({ statePath: path });
    expect(b.quotaSnapshot()).toEqual([]);
  });
});
