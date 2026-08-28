/**
 * Claude Code configuration writer.
 *
 * Points Claude Code at the proxy by merging ANTHROPIC_* env vars into
 * ~/.claude/settings.json. If an existing settings file is present, it is
 * backed up (timestamped) before any change, so a user's prior configuration
 * is never lost.
 *
 * The base URL is always 127.0.0.1: Claude Code runs on the same host as the
 * proxy in both local and Docker run modes.
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ok, warn } from "./util.ts";

export interface ClaudeSettingsInput {
  baseUrl: string;
  authToken: string;
  mainModel: string;
  fastModel: string;
}

/** Standard Claude Code settings path: ~/.claude/settings.json */
export function claudeSettingsPath(): string {
  return join(homedir(), ".claude", "settings.json");
}

/** Timestamp suffix like 20260827T170000 for backup filenames. */
function backupStamp(now: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `T${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  );
}

/**
 * Back up an existing settings file to `<file>.backup-<timestamp>`.
 * Returns the backup path, or null if there was nothing to back up.
 */
export function backupClaudeSettings(settingsFile: string, now: Date = new Date()): string | null {
  if (!existsSync(settingsFile)) return null;
  const backup = `${settingsFile}.backup-${backupStamp(now)}`;
  copyFileSync(settingsFile, backup);
  // The settings file holds ANTHROPIC_AUTH_TOKEN; keep the backup owner-only too.
  try {
    chmodSync(backup, 0o600);
  } catch {
    // Best-effort (e.g. non-POSIX FS); the copy still succeeded.
  }
  return backup;
}

/**
 * Merge the proxy env vars into Claude Code's settings.json without clobbering
 * unrelated keys. Backs up any existing file first.
 *
 * Note ANTHROPIC_API_KEY is intentionally set to "" — a non-empty value makes
 * Claude Code bypass the proxy (README "mandatory gotcha").
 */
export function writeClaudeSettings(input: ClaudeSettingsInput): {
  backup: string | null;
  file: string;
} {
  const file = claudeSettingsPath();
  const dir = join(homedir(), ".claude");
  mkdirSync(dir, { recursive: true });

  const backup = backupClaudeSettings(file);
  if (backup) warn(`Backed up existing Claude settings -> ${backup}`);

  let current: Record<string, unknown> = {};
  if (existsSync(file)) {
    const text = readFileSync(file, "utf8").trim();
    if (text.length > 0) {
      try {
        current = JSON.parse(text) as Record<string, unknown>;
      } catch {
        warn("Existing ~/.claude/settings.json is not valid JSON; starting fresh (backup kept).");
      }
    }
  }

  const prevEnv = (current.env ?? {}) as Record<string, unknown>;
  current.env = {
    ...prevEnv,
    ANTHROPIC_BASE_URL: input.baseUrl,
    ANTHROPIC_AUTH_TOKEN: input.authToken,
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_MODEL: input.mainModel,
    ANTHROPIC_SMALL_FAST_MODEL: input.fastModel,
  };

  // Written owner-only (0o600): the file holds ANTHROPIC_AUTH_TOKEN. Atomic
  // temp-file + rename so a crash mid-write can't corrupt Claude Code's settings.
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600); // enforce perms even where the mode option is ignored
  } catch {
    // Best-effort on non-POSIX filesystems.
  }
  renameSync(tmp, file); // atomic replace on the same filesystem
  ok(`Configured Claude Code -> ${file}`);
  return { backup, file };
}
