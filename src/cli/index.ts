#!/usr/bin/env bun
/**
 * claude-code-provider-proxy — unified cross-platform control CLI.
 *
 * Supersedes proxy.sh / start.sh / stop.sh with a single Bun program that runs
 * on Windows, macOS, and Linux, in two run modes:
 *
 *   --local    run the proxy as a bare Bun process (no Docker)
 *   --docker   run the proxy in Docker via docker compose (default when Docker
 *              is available)
 *
 * Commands:
 *   setup            install deps + Claude Code, bootstrap config, generate
 *                    shared auth token, configure Claude Code
 *   up | start       start the proxy (mode auto/explicit)
 *   down | stop      stop the proxy
 *   restart          stop then start
 *   status           show run status + registry URLs
 *   logs             follow logs
 *   config-claude    (re)write Claude Code settings to point at the proxy
 *   doctor           diagnose environment (deps, BIND_IP, config)
 *   help             show usage
 *
 * Flags: --local | --docker | --rotate (regenerate the proxy auth token).
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveBindIp, verifyBindIp } from "./bind-ip.ts";
import { bootstrapPaths, ensureAuthToken, ensureConfigFiles } from "./bootstrap.ts";
import { writeClaudeSettings } from "./claude.ts";
import { checkBun, checkDocker, ensureClaudeCode } from "./deps.ts";
import { getEnvValue, setEnvValue } from "./env.ts";
import {
  bold,
  commandExists,
  die,
  info,
  ok,
  runCapture,
  runInherit,
  spawnDetached,
  warn,
} from "./util.ts";

// --- Defaults -------------------------------------------------------------
const DEFAULT_PORT = "8787";
// NOTE: No model ids are hardcoded in src/ (AGENTS.md rule #3). The default
// Claude Code model ids live in .env.example (ANTHROPIC_MODEL /
// ANTHROPIC_SMALL_FAST_MODEL, plus ANTHROPIC_DEFAULT_SONNET_MODEL /
// ANTHROPIC_DEFAULT_HAIKU_MODEL for the auto-mode classifier) and are read
// from .env at runtime.

type Mode = "local" | "docker";

interface Args {
  command: string;
  mode: Mode | undefined;
  rotate: boolean;
}

/** Project root = two levels up from src/cli/index.ts. */
function projectRoot(): string {
  return dirname(dirname(dirname(fileURLToPath(import.meta.url))));
}

export function parseArgs(argv: string[]): Args {
  let command = "help";
  let mode: Mode | undefined;
  let rotate = false;
  const positionals: string[] = [];
  for (const a of argv) {
    if (a === "--local") mode = "local";
    else if (a === "--docker") mode = "docker";
    else if (a === "--rotate") rotate = true;
    else if (!a.startsWith("-")) positionals.push(a);
  }
  if (positionals[0]) command = positionals[0];
  return { command, mode, rotate };
}

/** Resolve the run mode: explicit flag wins, else Docker if available. */
function resolveMode(explicit: Mode | undefined): Mode {
  if (explicit) return explicit;
  return commandExists("docker") ? "docker" : "local";
}

function compose(root: string, args: string[]): number {
  // Prefer the `docker compose` plugin; fall back to legacy `docker-compose`.
  if (runCapture("docker", ["compose", "version"]) !== null) {
    return runInherit("docker", ["compose", ...args], root);
  }
  if (commandExists("docker-compose")) {
    return runInherit("docker-compose", args, root);
  }
  die("neither 'docker compose' nor 'docker-compose' is available.");
}

export function portValue(envPath: string): string {
  return getEnvValue(envPath, "PORT") || DEFAULT_PORT;
}

/**
 * Read the Claude Code model ids from .env. These are client-facing defaults,
 * kept out of src/ per AGENTS.md rule #3 — .env.example ships sensible values.
 *
 * sonnetModel/haikuModel pin ANTHROPIC_DEFAULT_SONNET_MODEL / _HAIKU_MODEL to
 * the same canonical ids as mainModel/fastModel. Without them, Claude Code's
 * auto-mode classifier calls the bare alias "claude-sonnet-5" directly, which
 * the proxy rejects as an invalid canonical id — fall back to mainModel/
 * fastModel when unset so existing .env files keep working.
 */
export function claudeModels(envPath: string): {
  mainModel: string;
  fastModel: string;
  sonnetModel: string;
  haikuModel: string;
  maxContextTokens: string | undefined;
} {
  const mainModel = getEnvValue(envPath, "ANTHROPIC_MODEL")?.trim();
  const fastModel = getEnvValue(envPath, "ANTHROPIC_SMALL_FAST_MODEL")?.trim();
  if (!mainModel || !fastModel) {
    die(
      "ANTHROPIC_MODEL / ANTHROPIC_SMALL_FAST_MODEL missing in .env. " +
        "Re-copy from .env.example (it ships defaults), then re-run.",
    );
  }
  const sonnetModel = getEnvValue(envPath, "ANTHROPIC_DEFAULT_SONNET_MODEL")?.trim() || mainModel;
  const haikuModel = getEnvValue(envPath, "ANTHROPIC_DEFAULT_HAIKU_MODEL")?.trim() || fastModel;
  // Optional: propagated verbatim into Claude Code's env so it knows the real
  // context window of a proxied non-Claude model (else it assumes 200k + warns).
  const maxContextTokens =
    getEnvValue(envPath, "CLAUDE_CODE_MAX_CONTEXT_TOKENS")?.trim() || undefined;
  return { mainModel, fastModel, sonnetModel, haikuModel, maxContextTokens };
}

// --- BIND_IP resolution (shared by up/status/doctor) ----------------------
/**
 * Ensure .env has a safe BIND_IP. If unset, auto-derive and persist it; if set,
 * verify it and warn (don't block) on a stale/virtual/absent value. Returns the
 * effective BIND_IP, or null if none could be established.
 */
export function resolveBindIp(envPath: string): string | null {
  const current = getEnvValue(envPath, "BIND_IP");
  if (current && current.trim() !== "") {
    const value = current.trim();
    const v = verifyBindIp(value);
    if (!v.ok) {
      warn(`BIND_IP=${current} looks unsafe (${v.reason}); keeping it but verify your network.`);
    }
    // Mirror into this process's env so a child spawned later in the SAME run
    // (e.g. `docker compose`) sees it even if it was only just written to .env.
    process.env.BIND_IP = value;
    return value;
  }
  const derived = deriveBindIp();
  if (!derived) {
    warn("Could not auto-derive a LAN IP (VPN-only or no private interface?).");
    return null;
  }
  setEnvValue(envPath, "BIND_IP", derived);
  // Persisting to .env is not enough: the just-written value is not in this
  // process's environment, and Docker Compose interpolates ${BIND_IP} from the
  // environment. Export it so the first setup/up run works without a re-run.
  process.env.BIND_IP = derived;
  ok(`Auto-derived BIND_IP=${derived} (written to .env).`);
  return derived;
}

// --- Local run mode -------------------------------------------------------
export function localPaths(root: string): { pid: string; log: string; logDir: string } {
  const logDir = join(root, "logs");
  return { pid: join(logDir, "proxy.pid"), log: join(logDir, "proxy.local.log"), logDir };
}

export function readPid(pidFile: string): number | null {
  try {
    if (!existsSync(pidFile)) return null;
    const n = Number(readFileSync(pidFile, "utf8").trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch (e) {
    warn(`Could not read pid file ${pidFile}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH => no such process (not running). EPERM => process EXISTS but is
    // owned by another user — treat as alive so we don't spawn a duplicate.
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    return false;
  }
}

function localUp(root: string, envPath: string): void {
  const { pid: pidFile, log, logDir } = localPaths(root);
  const existing = readPid(pidFile);
  if (existing && pidAlive(existing)) {
    warn(`Proxy already running locally (pid ${existing}).`);
    return;
  }
  mkdirSync(logDir, { recursive: true });

  const port = portValue(envPath);
  const bind = resolveBindIp(envPath);
  // Local mode binds the server directly to the LAN IP (or 127.0.0.1 fallback).
  const host = bind ?? "127.0.0.1";

  // Load .env values into the child environment (interpolated by config load).
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  for (const line of existsSync(envPath) ? readFileSync(envPath, "utf8").split(/\r?\n/) : []) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m?.[1] && m[2] !== undefined) env[m[1]] = m[2];
  }
  env.HOST = host;
  env.PORT = port;
  env.CONFIG_PATH = join(root, "config.local.jsonc");

  // Open the log fd and guarantee it's closed even if the spawn throws.
  const logFd = openSync(log, "a");
  let pid: number | undefined;
  try {
    pid = spawnDetached("bun", ["run", join(root, "src", "server.ts")], {
      cwd: root,
      logFd,
      env,
    });
  } finally {
    closeSync(logFd);
  }
  if (!pid) die("Failed to start local proxy process.");
  writeFileSync(pidFile, `${pid}\n`, "utf8");

  ok(`Proxy running locally (pid ${pid}, bound to ${host}:${port}).`);
  info(`  Registry (local): http://127.0.0.1:${port}/`);
  if (bind) info(`  Registry (LAN):   http://${bind}:${port}/`);
  info(`  Logs:             ${log}`);
}

function localDown(root: string): void {
  const { pid: pidFile } = localPaths(root);
  const pid = readPid(pidFile);
  if (!pid) {
    warn("No local proxy pid file found; nothing to stop.");
    return;
  }
  if (pidAlive(pid)) {
    try {
      process.kill(pid);
      ok(`Stopped local proxy (pid ${pid}).`);
      rmSync(pidFile, { force: true });
    } catch (e) {
      // Kill failed (e.g. EPERM): the process may still be running. Keep the
      // pid file so it stays trackable rather than orphaning it.
      warn(`Could not signal pid ${pid}: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    warn(`Local proxy pid ${pid} not running; clearing stale pid file.`);
    rmSync(pidFile, { force: true });
  }
}

function localStatus(root: string, envPath: string): void {
  const { pid: pidFile, log } = localPaths(root);
  const pid = readPid(pidFile);
  const port = portValue(envPath);
  if (pid && pidAlive(pid)) {
    ok(`Local proxy running (pid ${pid}).`);
    info(`  Registry (local): http://127.0.0.1:${port}/`);
    info(`  Logs:             ${log}`);
  } else {
    info("Local proxy not running.");
  }
}

// --- Commands -------------------------------------------------------------
function cmdSetup(root: string, mode: Mode, rotate: boolean): void {
  info(`${bold("[1/4]")} Checking dependencies…`);
  checkBun();
  if (mode === "docker") checkDocker(true);

  info(`${bold("[2/4]")} Bootstrapping config…`);
  const paths = bootstrapPaths(root);
  const { createdEnv } = ensureConfigFiles(paths);
  const token = ensureAuthToken(paths, rotate);
  resolveBindIp(paths.env);

  info(`${bold("[3/4]")} Installing + configuring Claude Code…`);
  ensureClaudeCode();
  const port = portValue(paths.env);
  const models = claudeModels(paths.env);
  writeClaudeSettings({
    baseUrl: `http://127.0.0.1:${port}`,
    authToken: token,
    mainModel: models.mainModel,
    fastModel: models.fastModel,
    sonnetModel: models.sonnetModel,
    haikuModel: models.haikuModel,
    ...(models.maxContextTokens ? { maxContextTokens: models.maxContextTokens } : {}),
  });

  if (mode === "docker") {
    info(`${bold("[4/4]")} Building Docker image…`);
    compose(root, ["build"]);
  } else {
    info(`${bold("[4/4]")} Local mode — no image build needed.`);
    if (commandExists("bun")) runInherit("bun", ["install"], root);
  }

  ok("Setup complete.");
  if (createdEnv) warn("Set BEDROCK_API_KEY in .env before starting (long-term Bedrock key).");
  info(`Next: ${bold(`bun run cli up --${mode}`)}`);
}

function cmdUp(root: string, mode: Mode): void {
  const paths = bootstrapPaths(root);
  ensureConfigFiles(paths);
  if (mode === "local") {
    localUp(root, paths.env);
    return;
  }
  checkDocker(true);
  const bind = resolveBindIp(paths.env);
  if (!bind) die("BIND_IP is required for Docker mode. Set it in .env (LAN IPv4).");
  const port = portValue(paths.env);
  compose(root, ["up", "-d", "--build"]);
  ok(`Running in Docker (bound to ${bind} + 127.0.0.1 only — not 0.0.0.0).`);
  info(`  Registry (LAN):   http://${bind}:${port}/`);
  info(`  Registry (local): http://127.0.0.1:${port}/`);
  info(`  Configure Claude: ${bold("bun run cli config-claude")}`);
}

function cmdDown(root: string, mode: Mode): void {
  if (mode === "local") {
    localDown(root);
    return;
  }
  checkDocker(true);
  compose(root, ["down", "--remove-orphans"]);
  ok("Stopped.");
}

function cmdStatus(root: string, mode: Mode): void {
  const envPath = join(root, ".env");
  if (mode === "local") {
    localStatus(root, envPath);
    return;
  }
  checkDocker(true);
  compose(root, ["ps"]);
  const port = portValue(envPath);
  const bind = getEnvValue(envPath, "BIND_IP");
  info(`Registry: http://${bind || "127.0.0.1"}:${port}/  (local: http://127.0.0.1:${port}/)`);
}

function cmdLogs(root: string, mode: Mode): void {
  if (mode === "local") {
    const { log } = localPaths(root);
    if (!existsSync(log)) {
      warn("No local log file yet.");
      return;
    }
    runInherit(
      process.platform === "win32" ? "powershell" : "tail",
      process.platform === "win32"
        ? ["-Command", `Get-Content -Wait -Tail 50 "${log}"`]
        : ["-f", log],
    );
    return;
  }
  checkDocker(true);
  compose(root, ["logs", "-f", "proxy"]);
}

function cmdConfigClaude(root: string): void {
  const paths = bootstrapPaths(root);
  ensureConfigFiles(paths);
  const token = getEnvValue(paths.env, "PROXY_INBOUND_KEY");
  if (!token || token.trim() === "") {
    die("PROXY_INBOUND_KEY not set in .env. Run setup first (it generates one).");
  }
  ensureClaudeCode();
  const port = portValue(paths.env);
  const models = claudeModels(paths.env);
  writeClaudeSettings({
    baseUrl: `http://127.0.0.1:${port}`,
    authToken: token,
    mainModel: models.mainModel,
    fastModel: models.fastModel,
    sonnetModel: models.sonnetModel,
    haikuModel: models.haikuModel,
    ...(models.maxContextTokens ? { maxContextTokens: models.maxContextTokens } : {}),
  });
}

function cmdDoctor(root: string, mode: Mode): void {
  info(bold("Environment check:"));
  checkBun();
  checkDocker(false);
  const paths = bootstrapPaths(root);
  info(existsSync(paths.env) ? "  .env present." : "  .env missing (run setup).");
  info(
    existsSync(paths.config)
      ? "  config.local.jsonc present."
      : "  config.local.jsonc missing (run setup).",
  );
  const bind = getEnvValue(paths.env, "BIND_IP");
  if (bind && bind.trim() !== "") {
    const v = verifyBindIp(bind.trim());
    info(v.ok ? `  BIND_IP=${bind} OK.` : `  BIND_IP=${bind} PROBLEM: ${v.reason}.`);
  } else {
    const derived = deriveBindIp();
    info(
      derived
        ? `  BIND_IP unset — would derive ${derived}.`
        : "  BIND_IP unset and none derivable (VPN-only?).",
    );
  }
  info(`  Run mode: ${mode}.`);
}

function usage(): void {
  info(
    [
      "claude-code-provider-proxy CLI",
      "",
      "  bun run cli <command> [--local|--docker] [--rotate]",
      "",
      "Commands:",
      "  setup            install deps + Claude Code, bootstrap config, gen token",
      "  up | start       start the proxy",
      "  down | stop      stop the proxy",
      "  restart          stop then start",
      "  status           show status + registry URLs",
      "  logs             follow logs",
      "  config-claude    (re)write Claude Code settings",
      "  doctor           diagnose environment",
      "  help             this message",
      "",
      "Modes: --docker (default if Docker present) | --local (bare Bun process)",
      "Flags: --rotate  regenerate the shared proxy auth token",
    ].join("\n"),
  );
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const root = projectRoot();
  if (args.command === "help" || args.command === "-h" || args.command === "--help") {
    usage();
    return;
  }
  const mode = resolveMode(args.mode);
  switch (args.command) {
    case "setup":
      cmdSetup(root, mode, args.rotate);
      break;
    case "up":
    case "start":
      cmdUp(root, mode);
      break;
    case "down":
    case "stop":
      cmdDown(root, mode);
      break;
    case "restart":
      cmdDown(root, mode);
      cmdUp(root, mode);
      break;
    case "status":
      cmdStatus(root, mode);
      break;
    case "logs":
      cmdLogs(root, mode);
      break;
    case "config-claude":
      cmdConfigClaude(root);
      break;
    case "doctor":
      cmdDoctor(root, mode);
      break;
    default:
      warn(`Unknown command: ${args.command}`);
      usage();
      process.exit(1);
  }
}

// Only run the CLI when executed directly (`bun run src/cli/index.ts ...`),
// not when imported (e.g. by the module smoke test), mirroring server.ts.
if (import.meta.main) {
  main();
}
