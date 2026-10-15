/**
 * OS-aware dependency detection and installation.
 *
 * The Bun runtime itself is a precondition (this CLI runs under Bun), so it is
 * only *checked* here — installing Bun is the job of the bootstrap shims
 * (bootstrap.sh / bootstrap.ps1), which run before Bun exists. This module
 * handles Docker availability and Claude Code installation.
 */
import {
  type Platform,
  commandExists,
  currentPlatform,
  die,
  info,
  ok,
  runCapture,
  runInherit,
  warn,
} from "./util.ts";

/**
 * The process/OS boundary these checks touch — existence probe, capture/inherit
 * runners, and the platform detector — collected into one injectable object so
 * the install/availability logic can be driven in-process with a stub that
 * reports bun/docker/claude present or absent. The default ({@link realDepsHost})
 * shells out exactly as before, so real CLI invocations are unchanged.
 */
export interface DepsHost {
  commandExists(cmd: string): boolean;
  runCapture(cmd: string, args: string[]): string | null;
  runInherit(cmd: string, args: string[], cwd?: string): number;
  currentPlatform(): Platform;
}

/** The real host: every method shells out / reads the real OS. */
export const realDepsHost: DepsHost = { commandExists, runCapture, runInherit, currentPlatform };

/** Confirm Bun is present (it must be, since we're running under it). */
export function checkBun(host: DepsHost = realDepsHost): boolean {
  const present = host.commandExists("bun");
  if (present) ok("Bun is installed.");
  else warn("Bun not detected on PATH (unexpected — this CLI runs under Bun).");
  return present;
}

/** Confirm Docker CLI + daemon are usable. Required only for --docker mode. */
export function checkDocker(required: boolean, host: DepsHost = realDepsHost): boolean {
  if (!host.commandExists("docker")) {
    if (required) die("Docker not found. Install/start Docker Desktop, or use --local mode.");
    warn("Docker not found (only needed for --docker mode).");
    return false;
  }
  // `docker info` fails when the daemon isn't running; capture (quiet) output.
  const infoOut = host.runCapture("docker", ["info"]);
  if (infoOut === null) {
    if (required) die("Docker daemon not reachable. Is Docker Desktop running?");
    warn("Docker installed but daemon not reachable.");
    return false;
  }
  ok("Docker is installed and running.");
  return true;
}

/**
 * Ensure Claude Code is installed, using the best mechanism per OS:
 *   - Unix (macOS/Linux): official install script via curl, else npm -g.
 *   - Windows: npm -g (Node/npm required), else point at the official installer.
 */
/** Print the install-success line and report success. */
function installDone(how: string): boolean {
  ok(`Installed Claude Code via ${how}.`);
  return true;
}

/** Run the npm global install; report whether `claude` then resolves. */
function tryNpmInstall(host: DepsHost): boolean {
  const code = host.runInherit("npm", ["install", "-g", "@anthropic-ai/claude-code"]);
  return code === 0 && host.commandExists("claude");
}

/** Run the official curl installer; report whether `claude` then resolves. */
function tryCurlInstall(host: DepsHost): boolean {
  const code = host.runInherit("sh", ["-c", "curl -fsSL https://claude.ai/install.sh | sh"]);
  return code === 0 && host.commandExists("claude");
}

export function ensureClaudeCode(host: DepsHost = realDepsHost): boolean {
  if (host.commandExists("claude")) {
    ok("Claude Code is installed.");
    return true;
  }
  warn("Claude Code not found — installing…");
  const plat = host.currentPlatform();

  if (plat === "windows") {
    if (host.commandExists("npm") && tryNpmInstall(host)) return installDone("npm");
    warn("Could not auto-install Claude Code on Windows.");
    info("Install it manually, then re-run:");
    info("  npm install -g @anthropic-ai/claude-code");
    info("  (or see https://docs.claude.com/claude-code for the Windows installer)");
    return false;
  }

  // Unix: prefer the official install script, then fall back to npm.
  if (host.commandExists("curl") && tryCurlInstall(host)) return installDone("official script");
  if (host.commandExists("npm") && tryNpmInstall(host)) return installDone("npm");
  warn("Could not auto-install Claude Code.");
  info("Install it manually, then re-run:");
  info("  curl -fsSL https://claude.ai/install.sh | sh");
  info("  (or: npm install -g @anthropic-ai/claude-code)");
  return false;
}
