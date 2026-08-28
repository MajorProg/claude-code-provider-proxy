/**
 * Shared CLI helpers: platform detection, colored logging, and process
 * execution wrappers. Used by every CLI module so the control surface behaves
 * identically on Windows, macOS, and Linux.
 *
 * No third-party deps: only Bun/Node stdlib. Keep this file free of any
 * hardcoded model ids or secrets.
 */
import { spawn, spawnSync } from "node:child_process";
import { platform } from "node:os";

export type Platform = "windows" | "macos" | "linux";

/** Detect the host OS in the three buckets the CLI cares about. */
export function currentPlatform(): Platform {
  const p = platform();
  if (p === "win32") return "windows";
  if (p === "darwin") return "macos";
  return "linux";
}

export const isWindows = (): boolean => currentPlatform() === "windows";

// ---------------------------------------------------------------------------
// Colored logging (auto-disabled when not a TTY or NO_COLOR is set)
// ---------------------------------------------------------------------------
const colorEnabled = (): boolean => process.stdout.isTTY === true && !("NO_COLOR" in Bun.env);

const paint = (code: string, s: string): string =>
  colorEnabled() ? `\u001b[${code}m${s}\u001b[0m` : s;

export const bold = (s: string): string => paint("1", s);

export function info(msg: string): void {
  process.stdout.write(`${msg}\n`);
}
export function ok(msg: string): void {
  process.stdout.write(`${paint("32", msg)}\n`);
}
export function warn(msg: string): void {
  process.stdout.write(`${paint("33", msg)}\n`);
}
export function err(msg: string): void {
  process.stderr.write(`${paint("31", msg)}\n`);
}

/** Print an error and exit non-zero. */
export function die(msg: string): never {
  err(`ERROR: ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Process execution
// ---------------------------------------------------------------------------

/** True if `cmd` resolves on PATH (portable `which`/`where`). */
export function commandExists(cmd: string): boolean {
  const probe = isWindows() ? "where" : "which";
  const res = spawnSync(probe, [cmd], { stdio: "ignore" });
  return res.status === 0;
}

/**
 * Run a command inheriting stdio (interactive), returning its exit code.
 * Used for long-running / user-visible commands (docker compose, installers).
 */
export function runInherit(cmd: string, args: string[], cwd?: string): number {
  const res = spawnSync(cmd, args, {
    stdio: "inherit",
    cwd,
    shell: false,
  });
  if (res.error) return 1;
  return res.status ?? 1;
}

/** Run a command capturing stdout; returns trimmed stdout or null on failure. */
export function runCapture(cmd: string, args: string[]): string | null {
  const res = spawnSync(cmd, args, {
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf8",
    shell: false,
  });
  if (res.status !== 0 || typeof res.stdout !== "string") return null;
  return res.stdout.trim();
}

/**
 * Spawn a detached, backgrounded process writing to the given log file.
 * Returns the child pid. Used by local (non-Docker) run mode.
 *
 * A failed spawn (ENOENT/EACCES) emits an async 'error' event; without a
 * listener that becomes an uncaught exception that can crash the CLI. We attach
 * one before unref() so the failure is logged rather than fatal. (The pid is
 * still returned synchronously; callers verify the process is alive.)
 */
export function spawnDetached(
  cmd: string,
  args: string[],
  opts: { cwd: string; logFd: number; env: Record<string, string> },
): number | undefined {
  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    detached: true,
    stdio: ["ignore", opts.logFd, opts.logFd],
    env: opts.env,
  });
  child.on("error", (e) => {
    err(`Failed to spawn ${cmd}: ${e instanceof Error ? e.message : String(e)}`);
  });
  child.unref();
  return child.pid;
}
