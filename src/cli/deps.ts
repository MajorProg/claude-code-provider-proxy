/**
 * OS-aware dependency detection and installation.
 *
 * The Bun runtime itself is a precondition (this CLI runs under Bun), so it is
 * only *checked* here — installing Bun is the job of the bootstrap shims
 * (bootstrap.sh / bootstrap.ps1), which run before Bun exists. This module
 * handles Docker availability and Claude Code installation.
 */
import {
  commandExists,
  currentPlatform,
  die,
  info,
  ok,
  runCapture,
  runInherit,
  warn,
} from "./util.ts";

/** Confirm Bun is present (it must be, since we're running under it). */
export function checkBun(): boolean {
  const present = commandExists("bun");
  if (present) ok("Bun is installed.");
  else warn("Bun not detected on PATH (unexpected — this CLI runs under Bun).");
  return present;
}

/** Confirm Docker CLI + daemon are usable. Required only for --docker mode. */
export function checkDocker(required: boolean): boolean {
  if (!commandExists("docker")) {
    if (required) die("Docker not found. Install/start Docker Desktop, or use --local mode.");
    warn("Docker not found (only needed for --docker mode).");
    return false;
  }
  // `docker info` fails when the daemon isn't running; capture (quiet) output.
  const infoOut = runCapture("docker", ["info"]);
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
export function ensureClaudeCode(): boolean {
  if (commandExists("claude")) {
    ok("Claude Code is installed.");
    return true;
  }
  warn("Claude Code not found — installing…");
  const plat = currentPlatform();

  if (plat === "windows") {
    if (commandExists("npm")) {
      const code = runInherit("npm", ["install", "-g", "@anthropic-ai/claude-code"]);
      if (code === 0 && commandExists("claude")) {
        ok("Installed Claude Code via npm.");
        return true;
      }
    }
    warn("Could not auto-install Claude Code on Windows.");
    info("Install it manually, then re-run:");
    info("  npm install -g @anthropic-ai/claude-code");
    info("  (or see https://docs.claude.com/claude-code for the Windows installer)");
    return false;
  }

  // Unix: prefer the official install script.
  if (commandExists("curl")) {
    const code = runInherit("sh", ["-c", "curl -fsSL https://claude.ai/install.sh | sh"]);
    if (code === 0 && commandExists("claude")) {
      ok("Installed Claude Code via official script.");
      return true;
    }
  }
  if (commandExists("npm")) {
    const code = runInherit("npm", ["install", "-g", "@anthropic-ai/claude-code"]);
    if (code === 0 && commandExists("claude")) {
      ok("Installed Claude Code via npm.");
      return true;
    }
  }
  warn("Could not auto-install Claude Code.");
  info("Install it manually, then re-run:");
  info("  curl -fsSL https://claude.ai/install.sh | sh");
  info("  (or: npm install -g @anthropic-ai/claude-code)");
  return false;
}
