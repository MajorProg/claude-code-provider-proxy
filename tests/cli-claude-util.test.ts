/**
 * CLI pure/temp-dir seam tests — hermetic (real temp files, no network, no
 * process spawns). Covers Task 9 (F5).
 *
 * - src/cli/claude.ts: claudeSettingsPath (pure path), backupClaudeSettings
 *   (timestamped copy in a temp dir, 0o600 perms, no-op when the source is
 *   absent). writeClaudeSettings is NOT exercised here: it targets the real
 *   ~/.claude/settings.json and would clobber the developer's file.
 * - src/cli/util.ts: currentPlatform/isWindows (OS bucketing) + the colored
 *   logging helpers (NO_COLOR / non-TTY => plain text).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { backupClaudeSettings, claudeSettingsPath } from "../src/cli/claude.ts";
import { bold, currentPlatform, isWindows, ok, warn } from "../src/cli/util.ts";

describe("claudeSettingsPath", () => {
  test("resolves to ~/.claude/settings.json under the home dir", () => {
    const p = claudeSettingsPath();
    expect(p).toBe(join(homedir(), ".claude", "settings.json"));
  });
});

describe("backupClaudeSettings", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ccpp-claude-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns null and creates nothing when the source file is absent", () => {
    const missing = join(dir, "settings.json");
    expect(backupClaudeSettings(missing)).toBeNull();
    expect(existsSync(missing)).toBe(false);
  });

  test("copies an existing file to a timestamped backup and preserves content", () => {
    const file = join(dir, "settings.json");
    const content = JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "ccpp_secret" } });
    writeFileSync(file, content);

    const fixedNow = new Date(2026, 7, 28, 17, 5, 6); // 2026-08-28T17:05:06 local
    const backup = backupClaudeSettings(file, fixedNow);

    expect(backup).toBe(`${file}.backup-20260828T170506`);
    expect(backup).not.toBeNull();
    if (backup) {
      expect(existsSync(backup)).toBe(true);
      expect(readFileSync(backup, "utf8")).toBe(content);
    }
    // The original is left in place (a backup is a copy, not a move).
    expect(existsSync(file)).toBe(true);
  });

  test("the backup is written owner-only (0o600) on POSIX filesystems", () => {
    if (isWindows()) return; // POSIX perms are not meaningful on Windows
    const file = join(dir, "settings.json");
    writeFileSync(file, "{}");
    const backup = backupClaudeSettings(file);
    expect(backup).not.toBeNull();
    if (backup) {
      const mode = statSync(backup).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });
});

describe("currentPlatform / isWindows", () => {
  test("maps the host os into the three CLI buckets and agrees with node:os", () => {
    const p = currentPlatform();
    expect(["windows", "macos", "linux"]).toContain(p);
    const raw = platform();
    const expected = raw === "win32" ? "windows" : raw === "darwin" ? "macos" : "linux";
    expect(p).toBe(expected);
    expect(isWindows()).toBe(p === "windows");
  });
});

describe("colored logging helpers", () => {
  // Under bun:test stdout is not a TTY, so color is disabled: helpers return /
  // print plain text with no ANSI escape codes. Verify no ESC (\u001b) leaks.
  test("bold returns the input unchanged when color is disabled (non-TTY)", () => {
    const s = "plain message";
    expect(bold(s)).toBe(s);
    expect(bold(s).includes("\u001b")).toBe(false);
  });

  test("ok/warn write plain text (no ANSI) to stdout", () => {
    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    // Capture writes without emitting ANSI to the test runner.
    (process.stdout as { write: unknown }).write = (chunk: string) => {
      written.push(String(chunk));
      return true;
    };
    try {
      ok("done");
      warn("careful");
    } finally {
      (process.stdout as { write: unknown }).write = original;
    }
    expect(written.join("")).toBe("done\ncareful\n");
    expect(written.some((w) => w.includes("\u001b"))).toBe(false);
  });
});
