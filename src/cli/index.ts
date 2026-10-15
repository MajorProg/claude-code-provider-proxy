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
import { networkInterfaces as osNetworkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { credentialState, resolveBedrockMode } from "../auth/bedrock-mode.ts";
import { type ProxyConfig, loadConfig } from "../config.ts";
import { type NetworkInterfaceMap, deriveBindIp, verifyBindIp } from "./bind-ip.ts";
import { bootstrapPaths, ensureAuthToken, ensureConfigFiles } from "./bootstrap.ts";
import { writeClaudeSettings } from "./claude.ts";
import { type DepsHost, checkBun, checkDocker, ensureClaudeCode } from "./deps.ts";
import { getEnvValue, readEnvFile, setEnvValue } from "./env.ts";
import {
  bold,
  commandExists,
  currentPlatform,
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
  /** Optional second positional (e.g. a sound file for `ping`). */
  arg: string | undefined;
}

/**
 * The process/OS boundary every command touches (existence probe, capture/inherit
 * runners, detached spawn, process signal) plus the Claude settings-file override,
 * collected into one injectable object. Command bodies take an optional `io`
 * defaulting to {@link realCliEnv}; tests pass a stub so the REAL command logic
 * runs in-process against a temp root with no real process spawned and no file
 * written outside it. The default preserves today's behaviour exactly.
 */
export interface CliEnv extends DepsHost {
  spawnDetached(
    cmd: string,
    args: string[],
    opts: { cwd: string; logFd: number; env: Record<string, string> },
  ): number | undefined;
  kill(pid: number): void;
  /** Override for ~/.claude/settings.json (tests point this at a temp dir). */
  claudeSettingsFile?: string;
  /**
   * The OS network-interface map (os.networkInterfaces()). A seam so BIND_IP
   * derivation/verification can be driven against a synthetic host — e.g. a
   * VPN-only machine with no private LAN address — instead of the real NICs.
   */
  networkInterfaces(): NetworkInterfaceMap;
  /**
   * Ping watcher's poll of the proxy's public /status.json: the parsed body, or
   * `undefined` on a non-2xx response. The real default GETs `url` with a 4s
   * timeout COMBINED with `signal`, so cancelling the watcher cancels the
   * in-flight request instead of leaving it to run out its own timeout; a test
   * injects a canned sequence.
   */
  pollStatus(
    url: string,
    signal?: AbortSignal,
  ): Promise<{ servingAccount?: string | null } | undefined>;
  /**
   * Ping watcher's inter-poll delay. The real default waits `ms` (clearing the
   * timer promptly when `signal` aborts); a test stub resolves immediately.
   */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/** The real boundary: every method shells out / signals the real OS. */
export const realCliEnv: CliEnv = {
  commandExists,
  runCapture,
  runInherit,
  currentPlatform,
  spawnDetached,
  kill: (pid): void => {
    process.kill(pid);
  },
  networkInterfaces: () => osNetworkInterfaces(),
  pollStatus: async (url, signal) => {
    // Bound each poll with a 4s timeout so a hung request cannot wedge the
    // watcher, AND cancel it the instant the watcher signal aborts so Ctrl-C
    // tears down an in-flight fetch immediately — not merely the await around
    // it (leaving the request to hold the event loop until the timeout fires is
    // the bug this wires in). The two signals are merged through a controller
    // rather than AbortSignal.any(), which this project's TS lib does not declare.
    const timeout = AbortSignal.timeout(4000);
    const merged = new AbortController();
    const onAbort = (): void => merged.abort();
    timeout.addEventListener("abort", onAbort, { once: true });
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await fetch(url, { signal: merged.signal });
      if (!res.ok) return undefined;
      return (await res.json()) as { servingAccount?: string | null };
    } finally {
      // Detach both: the watcher signal is long-lived, so an undispatched
      // listener would accumulate one per poll over a long watch.
      timeout.removeEventListener("abort", onAbort);
      signal?.removeEventListener("abort", onAbort);
    }
  },
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal === undefined) {
        setTimeout(resolve, ms);
        return;
      }
      // Abort-aware: an abort settles the wait at once (no full-interval stall),
      // otherwise the timer does. Whichever fires detaches the other, and the
      // abort listener is removed on normal completion too — so the long-lived
      // watcher signal never accumulates listeners.
      const onAbort = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal.addEventListener("abort", onAbort, { once: true });
    }),
};

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
  return { command, mode, rotate, arg: positionals[1] };
}

/** Resolve the run mode: explicit flag wins, else Docker if available. */
export function resolveMode(explicit: Mode | undefined, io: CliEnv = realCliEnv): Mode {
  if (explicit) return explicit;
  return io.commandExists("docker") ? "docker" : "local";
}

function compose(root: string, args: string[], io: CliEnv = realCliEnv): number {
  // Prefer the `docker compose` plugin; fall back to legacy `docker-compose`.
  const hasPlugin = io.runCapture("docker", ["compose", "version"]) !== null;
  if (hasPlugin) return io.runInherit("docker", ["compose", ...args], root);
  const hasLegacy = io.commandExists("docker-compose");
  if (hasLegacy) return io.runInherit("docker-compose", args, root);
  die("neither 'docker compose' nor 'docker-compose' is available.");
}

export function portValue(envPath: string): string {
  return getEnvValue(envPath, "PORT") || DEFAULT_PORT;
}

/**
 * Read the Claude Code model-variable family from .env. These are client-facing
 * defaults, kept out of src/ per AGENTS.md rule #3 — .env.example ships values.
 *
 * Fallbacks keep existing .env files working: sonnet→main, haiku→legacy
 * ANTHROPIC_SMALL_FAST_MODEL→main (in that order), opus/default→main,
 * subagent→haiku. `legacySmallFast` records whether the deprecated
 * ANTHROPIC_SMALL_FAST_MODEL is still the haiku source (writeClaudeSettings
 * then emits BOTH vars for older Claude Code versions).
 */
export function claudeModels(envPath: string): {
  mainModel: string;
  fastModel: string;
  sonnetModel: string;
  haikuModel: string;
  opusModel: string;
  defaultModel: string;
  subagentModel: string;
  legacySmallFast: boolean;
  maxContextTokens: string | undefined;
  customModelOption: string | undefined;
  customModelOptionName: string | undefined;
  customModelOptionDescription: string | undefined;
} {
  const mainModel = getEnvValue(envPath, "ANTHROPIC_MODEL")?.trim();
  if (!mainModel) {
    die(
      "ANTHROPIC_MODEL missing in .env. Re-copy from .env.example (it ships defaults), then re-run.",
    );
  }
  const legacyFast = getEnvValue(envPath, "ANTHROPIC_SMALL_FAST_MODEL")?.trim();
  const haikuExplicit = getEnvValue(envPath, "ANTHROPIC_DEFAULT_HAIKU_MODEL")?.trim();
  const haikuModel = haikuExplicit || legacyFast || mainModel;
  const sonnetModel = getEnvValue(envPath, "ANTHROPIC_DEFAULT_SONNET_MODEL")?.trim() || mainModel;
  const opusModel = getEnvValue(envPath, "ANTHROPIC_DEFAULT_OPUS_MODEL")?.trim() || mainModel;
  const defaultModel = getEnvValue(envPath, "ANTHROPIC_DEFAULT_MODEL")?.trim() || mainModel;
  const subagentModel = getEnvValue(envPath, "CLAUDE_CODE_SUBAGENT_MODEL")?.trim() || haikuModel;
  const legacySmallFast = !haikuExplicit && !!legacyFast;
  if (legacySmallFast) {
    warn(
      "ANTHROPIC_SMALL_FAST_MODEL is deprecated by Claude Code; ANTHROPIC_DEFAULT_HAIKU_MODEL is preferred. Keeping both for compatibility — migrate .env when convenient.",
    );
  }
  const opt = (name: string): string | undefined => {
    const v = getEnvValue(envPath, name)?.trim();
    return v || undefined;
  };
  return {
    mainModel,
    fastModel: legacyFast ?? mainModel,
    sonnetModel,
    haikuModel,
    opusModel,
    defaultModel,
    subagentModel,
    legacySmallFast,
    maxContextTokens: opt("CLAUDE_CODE_MAX_CONTEXT_TOKENS"),
    customModelOption: opt("ANTHROPIC_CUSTOM_MODEL_OPTION"),
    customModelOptionName: opt("ANTHROPIC_CUSTOM_MODEL_OPTION_NAME"),
    customModelOptionDescription: opt("ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION"),
  };
}

// --- BIND_IP resolution (shared by up/status/doctor) ----------------------
/**
 * Ensure .env has a safe BIND_IP. If unset, auto-derive and persist it; if set,
 * verify it and warn (don't block) on a stale/virtual/absent value. Returns the
 * effective BIND_IP, or null if none could be established.
 */
export function resolveBindIp(envPath: string, io: CliEnv = realCliEnv): string | null {
  const current = getEnvValue(envPath, "BIND_IP");
  if (current && current.trim() !== "") {
    const value = current.trim();
    const v = verifyBindIp(value, io.networkInterfaces);
    if (!v.ok) {
      warn(`BIND_IP=${current} looks unsafe (${v.reason}); keeping it but verify your network.`);
    }
    // Mirror into this process's env so a child spawned later in the SAME run
    // (e.g. `docker compose`) sees it even if it was only just written to .env.
    process.env.BIND_IP = value;
    return value;
  }
  const derived = deriveBindIp(io.networkInterfaces);
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

function localUp(root: string, envPath: string, io: CliEnv = realCliEnv): void {
  const { pid: pidFile, log, logDir } = localPaths(root);
  const existing = readPid(pidFile);
  if (existing && pidAlive(existing)) {
    warn(`Proxy already running locally (pid ${existing}).`);
    return;
  }
  mkdirSync(logDir, { recursive: true });

  const port = portValue(envPath);
  const bind = resolveBindIp(envPath, io);
  // Local mode binds the server directly to the LAN IP (or 127.0.0.1 fallback).
  const host = bind ?? "127.0.0.1";

  // Load .env values into the child environment (interpolated by config load).
  const childEnv: Record<string, string> = { ...(process.env as Record<string, string>) };
  for (const line of existsSync(envPath) ? readFileSync(envPath, "utf8").split(/\r?\n/) : []) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m?.[1] && m[2] !== undefined) childEnv[m[1]] = m[2];
  }
  childEnv.HOST = host;
  childEnv.PORT = port;
  childEnv.CONFIG_PATH = join(root, "config.local.jsonc");

  // Open the log fd and guarantee it's closed even if the spawn throws.
  const logFd = openSync(log, "a");
  let pid: number | undefined;
  try {
    pid = io.spawnDetached("bun", ["run", join(root, "src", "server.ts")], {
      cwd: root,
      logFd,
      env: childEnv,
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

function localDown(root: string, io: CliEnv = realCliEnv): void {
  const { pid: pidFile } = localPaths(root);
  const pid = readPid(pidFile);
  if (!pid) {
    warn("No local proxy pid file found; nothing to stop.");
    return;
  }
  if (pidAlive(pid)) {
    try {
      io.kill(pid);
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
export function cmdSetup(root: string, mode: Mode, rotate: boolean, io: CliEnv = realCliEnv): void {
  info(`${bold("[1/4]")} Checking dependencies…`);
  checkBun(io);
  if (mode === "docker") checkDocker(true, io);

  info(`${bold("[2/4]")} Bootstrapping config…`);
  const paths = bootstrapPaths(root);
  const { createdEnv } = ensureConfigFiles(paths);
  const token = ensureAuthToken(paths, rotate);
  resolveBindIp(paths.env, io);

  info(`${bold("[3/4]")} Installing + configuring Claude Code…`);
  ensureClaudeCode(io);
  const port = portValue(paths.env);
  const models = claudeModels(paths.env);
  writeClaudeSettings(
    {
      baseUrl: `http://127.0.0.1:${port}`,
      authToken: token,
      mainModel: models.mainModel,
      fastModel: models.fastModel,
      sonnetModel: models.sonnetModel,
      haikuModel: models.haikuModel,
      opusModel: models.opusModel,
      defaultModel: models.defaultModel,
      subagentModel: models.subagentModel,
      legacySmallFast: models.legacySmallFast,
      ...(models.maxContextTokens ? { maxContextTokens: models.maxContextTokens } : {}),
      ...(models.customModelOption ? { customModelOption: models.customModelOption } : {}),
      ...(models.customModelOptionName
        ? { customModelOptionName: models.customModelOptionName }
        : {}),
      ...(models.customModelOptionDescription
        ? { customModelOptionDescription: models.customModelOptionDescription }
        : {}),
    },
    io.claudeSettingsFile,
  );

  if (mode === "docker") {
    info(`${bold("[4/4]")} Building Docker image…`);
    compose(root, ["build"], io);
  } else {
    info(`${bold("[4/4]")} Local mode — no image build needed.`);
    if (io.commandExists("bun")) io.runInherit("bun", ["install"], root);
  }

  ok("Setup complete.");
  if (createdEnv) {
    info("Activate at least one provider in .env, then run up:");
    info(
      "  External (no AWS needed): set e.g. ZAI_API_KEY (or DEEPSEEK_API_KEY, …) — the matching provider activates automatically.",
    );
    info(
      "  Bedrock: set BEDROCK_API_KEY (long-term key), or leave empty to skip Bedrock entirely.",
    );
    info("  The proxy also boots with no provider key at all; fix credentials later at /config.");
  }
  info(`Next: ${bold(`bun run cli up --${mode}`)}`);
}

export function cmdUp(root: string, mode: Mode, io: CliEnv = realCliEnv): void {
  const paths = bootstrapPaths(root);
  ensureConfigFiles(paths);
  if (mode === "local") {
    localUp(root, paths.env, io);
    return;
  }
  checkDocker(true, io);
  const bind = resolveBindIp(paths.env, io);
  if (!bind) die("BIND_IP is required for Docker mode. Set it in .env (LAN IPv4).");
  const port = portValue(paths.env);
  compose(root, ["up", "-d", "--build"], io);
  ok(`Running in Docker (bound to ${bind} + 127.0.0.1 only — not 0.0.0.0).`);
  info(`  Registry (LAN):   http://${bind}:${port}/`);
  info(`  Registry (local): http://127.0.0.1:${port}/`);
  info(`  Configure Claude: ${bold("bun run cli config-claude")}`);
}

export function cmdDown(root: string, mode: Mode, io: CliEnv = realCliEnv): void {
  if (mode === "local") {
    localDown(root, io);
    return;
  }
  checkDocker(true, io);
  compose(root, ["down", "--remove-orphans"], io);
  ok("Stopped.");
}

export function cmdStatus(root: string, mode: Mode, io: CliEnv = realCliEnv): void {
  const envPath = join(root, ".env");
  if (mode === "local") {
    localStatus(root, envPath);
    return;
  }
  checkDocker(true, io);
  compose(root, ["ps"], io);
  const port = portValue(envPath);
  const bind = getEnvValue(envPath, "BIND_IP");
  info(`Registry: http://${bind || "127.0.0.1"}:${port}/  (local: http://127.0.0.1:${port}/)`);
}

export function cmdLogs(root: string, mode: Mode, io: CliEnv = realCliEnv): void {
  if (mode === "local") {
    const { log } = localPaths(root);
    if (!existsSync(log)) {
      warn("No local log file yet.");
      return;
    }
    io.runInherit(
      process.platform === "win32" ? "powershell" : "tail",
      process.platform === "win32"
        ? ["-Command", `Get-Content -Wait -Tail 50 "${log}"`]
        : ["-f", log],
    );
    return;
  }
  checkDocker(true, io);
  compose(root, ["logs", "-f", "proxy"], io);
}

export function cmdConfigClaude(root: string, io: CliEnv = realCliEnv): void {
  const paths = bootstrapPaths(root);
  ensureConfigFiles(paths);
  const token = getEnvValue(paths.env, "PROXY_INBOUND_KEY");
  if (!token || token.trim() === "") {
    die("PROXY_INBOUND_KEY not set in .env. Run setup first (it generates one).");
  }
  ensureClaudeCode(io);
  const port = portValue(paths.env);
  const models = claudeModels(paths.env);
  writeClaudeSettings(
    {
      baseUrl: `http://127.0.0.1:${port}`,
      authToken: token,
      mainModel: models.mainModel,
      fastModel: models.fastModel,
      sonnetModel: models.sonnetModel,
      haikuModel: models.haikuModel,
      opusModel: models.opusModel,
      defaultModel: models.defaultModel,
      subagentModel: models.subagentModel,
      legacySmallFast: models.legacySmallFast,
      ...(models.maxContextTokens ? { maxContextTokens: models.maxContextTokens } : {}),
      ...(models.customModelOption ? { customModelOption: models.customModelOption } : {}),
      ...(models.customModelOptionName
        ? { customModelOptionName: models.customModelOptionName }
        : {}),
      ...(models.customModelOptionDescription
        ? { customModelOptionDescription: models.customModelOptionDescription }
        : {}),
    },
    io.claudeSettingsFile,
  );
}

/**
 * Resolve the host-side sound PLAYER for the ping watcher (pure, exported for
 * tests). macOS gets first-class support (`afplay`, always present, plays on
 * the default audio device); Linux is best-effort via the first available of
 * paplay/ffplay/play; Windows has no built-in and returns null.
 */
export function resolveSoundPlayer(
  platform: "macos" | "linux" | "windows",
  has = (cmd: string): boolean => commandExists(cmd),
): { cmd: string; baseArgs: string[] } | null {
  if (platform === "macos") return { cmd: "afplay", baseArgs: [] };
  if (platform === "windows") return null;
  for (const [cmd, baseArgs] of [
    ["paplay", []],
    ["ffplay", ["-nodisp", "-autoexit", "-loglevel", "quiet"]],
    ["play", ["-q"]],
  ] as const) {
    if (has(cmd)) return { cmd, baseArgs: [...baseArgs] };
  }
  return null;
}

/** Poll cadence while the proxy is healthy (2s). */
const PING_INTERVAL_MS = 2000;
/** Cap for the exponential backoff applied while the proxy is unreachable (30s). */
const PING_BACKOFF_MAX_MS = 30000;

/**
 * Run a promise-producing step but resolve to `null` the instant `signal`
 * aborts — so a poll that is in flight (or a long wait) can never block
 * shutdown. A step rejection propagates unchanged. The `start` callback is
 * handed the same `signal` so a cancellable step (the real pollStatus passes it
 * to fetch) tears its own work down rather than being merely abandoned.
 */
function raceAbort<T>(
  start: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
): Promise<T | null> {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise<T | null>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      resolve(null);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    start(signal).then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Host-side serving-account change watcher: polls the proxy's public
 * /status.json (`servingAccount` — labels only) and plays a sound on the
 * default audio device whenever it changes (failover to another key, cooldown
 * expiry, provider shift). Runs on the HOST (the container cannot reach the
 * speakers) — works for both --local and --docker since it targets the
 * published port. Returns an exit code (0 for a clean shutdown) when `signal`
 * aborts; it never resolves otherwise.
 *
 * Three behaviours the earlier fire-and-forget loop got wrong:
 *  - an unreachable proxy is announced ONCE per transition (including when it
 *    was never reachable — the opening state), and again "reachable again" on
 *    recovery, so a stopped proxy is never silently ignored;
 *  - a failed poll no longer discards the last KNOWN account, so an account
 *    change that happened DURING an outage is still surfaced after recovery;
 *  - the poll interval backs off (2s → 4s → 8s → … capped at 30s) while the
 *    proxy is down, and resets to 2s on the first success, so a dead proxy is
 *    not hammered forever.
 */
async function cmdPing(
  soundPath: string | undefined,
  signal: AbortSignal,
  io: CliEnv = realCliEnv,
  root: string = projectRoot(),
): Promise<number> {
  const base = `http://127.0.0.1:${portValue(join(root, ".env"))}`;
  const player = resolveSoundPlayer(io.currentPlatform());
  const sound = soundPath ?? "/System/Library/Sounds/Glass.aiff";
  // Probe the sound file ONCE at startup rather than on every play.
  let audio = false;
  if (player === null) {
    warn("No sound player on this platform (macOS: afplay). Watching without sound.");
  } else if (!existsSync(sound)) {
    warn(`Sound file not found: ${sound} — watching without sound.`);
  } else {
    audio = true;
  }
  let playWarned = false;
  const play = (): void => {
    if (player === null || !audio) return;
    let failure: string | null = null;
    try {
      if (io.runCapture(player.cmd, [...player.baseArgs, sound]) === null) {
        failure = `${player.cmd} exited non-zero`;
      }
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e);
    }
    if (failure !== null && !playWarned) {
      playWarned = true;
      warn(`Could not play the sound (${failure}); continuing without audio.`);
    }
  };

  info(`Watching ${base}/status.json for serving-account changes (Ctrl-C to stop)…`);
  const ts = (): string => new Date().toLocaleTimeString();
  let last: string | null | undefined; // last KNOWN account — survives an outage
  let reachable: boolean | undefined; // undefined until the first observation
  let outage = false; // a failed poll since the last successful one
  let backoff = PING_INTERVAL_MS;

  for (;;) {
    try {
      // The watcher signal is threaded into the poll, so an abort cancels the
      // in-flight fetch (not just this await) and the process can exit at once.
      const status = await raceAbort((s) => io.pollStatus(`${base}/status.json`, s), signal);
      if (status === null) break; // aborted mid-poll
      // Any HTTP answer (even a non-2xx) means the proxy is reachable.
      if (reachable === false) info(`${ts()} proxy reachable again`);
      reachable = true;
      if (status !== undefined) {
        const cur = status.servingAccount ?? null;
        if (last !== undefined && cur !== last) {
          const when = outage ? " during an outage" : "";
          info(`${ts()} serving account changed${when}: ${last ?? "(none)"} -> ${cur ?? "(none)"}`);
          play();
        }
        last = cur;
      }
      outage = false;
      backoff = PING_INTERVAL_MS;
    } catch {
      // Proxy down or restarting — announce each transition once, then keep watching.
      if (reachable !== false) info(`${ts()} proxy unreachable at ${base}, waiting…`);
      reachable = false;
      outage = true;
    }
    if (signal.aborted) break;
    const wait = reachable === false ? backoff : PING_INTERVAL_MS;
    if (reachable === false) backoff = Math.min(backoff * 2, PING_BACKOFF_MAX_MS);
    await io.sleep(wait, signal);
    if (signal.aborted) break;
  }
  return 0;
}

/**
 * Wire the ping watcher's lifecycle: one AbortController driven by Ctrl-C
 * (SIGINT/SIGTERM), plus an optional external signal for tests. Awaits the
 * watcher, prints a single clean "stopped" line, and returns its exit code.
 * The handlers are removed on the way out so nothing leaks.
 */
async function runPingWatcher(
  soundPath: string | undefined,
  io: CliEnv,
  root: string,
  signal: AbortSignal | undefined,
): Promise<number> {
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  if (signal !== undefined) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", stop, { once: true });
  }
  try {
    const code = await cmdPing(soundPath, controller.signal, io, root);
    info("Ping watcher stopped.");
    return code;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    if (signal !== undefined) signal.removeEventListener("abort", stop);
  }
}

/**
 * Pure config diagnostics for {@link cmdDoctor} (exported for tests): one line
 * per notable state — ephemeral inbound key, load warnings, and per-provider /
 * per-region activity — in print order, with the severity the doctor prints.
 */
export function configDiagnostics(config: ProxyConfig): {
  level: "ok" | "warn";
  line: string;
}[] {
  const out: { level: "ok" | "warn"; line: string }[] = [];
  if (config.inboundAuth.ephemeralKey) {
    out.push({
      level: "warn",
      line: "  Inbound key: EPHEMERAL (PROXY_INBOUND_KEY unset) — changes on every restart; set PROXY_INBOUND_KEY in .env to persist.",
    });
  }
  for (const w of config.loadWarnings ?? []) {
    out.push({ level: "warn", line: `  config warning: unset env var ${w} resolved empty.` });
  }
  for (const [key, p] of Object.entries(config.providers.external)) {
    // Pool size next to the ok lines — cost attribution at a glance ("3 keys").
    const poolSuffix = p.credentials.length > 1 ? `, ${p.credentials.length} keys` : "";
    if (p.inactiveReason) {
      out.push({ level: "warn", line: `  ${key}: inactive — ${p.inactiveReason}` });
    } else if (p.regions) {
      for (const [regionKey, r] of Object.entries(p.regions)) {
        if (r.inactiveReason) {
          out.push({
            level: "warn",
            line: `  ${key}:${regionKey}: inactive — ${r.inactiveReason}`,
          });
        } else {
          const pool = r.credentials ?? p.credentials;
          const usable = pool.filter(
            (e) =>
              credentialState(e.credential) !== "empty" &&
              credentialState(e.credential) !== "placeholder",
          );
          out.push(
            usable.length === 0
              ? {
                  level: "warn",
                  line: `  ${key}:${regionKey}: skipped — credential unset/placeholder.`,
                }
              : {
                  level: "ok",
                  line: `  ${key}:${regionKey}: credential set (${p.type}${
                    usable.length > 1 ? `, ${usable.length} keys` : ""
                  }).`,
                },
          );
        }
      }
    } else {
      const state = credentialState(p.credential);
      out.push(
        state === "empty" || state === "placeholder"
          ? { level: "warn", line: `  ${key}: skipped — credential unset/placeholder.` }
          : { level: "ok", line: `  ${key}: credential set (${p.type}${poolSuffix}).` },
      );
    }
  }
  return out;
}

export async function cmdDoctor(root: string, mode: Mode, io: CliEnv = realCliEnv): Promise<void> {
  info(bold("Environment check:"));
  checkBun(io);
  checkDocker(false, io);
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
    const derived = deriveBindIp(io.networkInterfaces);
    info(
      derived
        ? `  BIND_IP unset — would derive ${derived}.`
        : "  BIND_IP unset and none derivable (VPN-only?).",
    );
  }
  info(`  Run mode: ${mode}.`);

  // Config + provider-state check: parse the config exactly like the server
  // would (process env overlaid with .env) and classify every credential, so
  // "why is provider X missing" is answerable without opening the logs.
  if (!existsSync(paths.config)) return;
  info(bold("Config check:"));
  let config: ProxyConfig;
  try {
    const env = { ...process.env, ...readEnvFile(paths.env) };
    config = await loadConfig(paths.config, env);
    ok("  config.local.jsonc parses and validates.");
    const bedrockMode = resolveBedrockMode(config.providers.bedrock?.credential, env);
    if (bedrockMode.enabled) {
      ok("  Bedrock: enabled.");
    } else {
      warn(`  Bedrock: disabled — ${bedrockMode.reason}`);
    }
  } catch (err) {
    warn(`  config.local.jsonc INVALID: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (Object.keys(config.providers.external).length === 0) {
    warn("  No external providers configured (see config.example.jsonc).");
  }
  for (const d of configDiagnostics(config)) {
    if (d.level === "ok") ok(d.line);
    else warn(d.line);
  }
}

export function usage(): void {
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
      "  ping [sound]     watch the proxy; play a sound when the serving",
      "                   account changes (default: macOS Glass.aiff)",
      "  doctor           diagnose environment",
      "  help             this message",
      "",
      "Modes: --docker (default if Docker present) | --local (bare Bun process)",
      "Flags: --rotate  regenerate the shared proxy auth token",
    ].join("\n"),
  );
}

/**
 * The CLI entry point. Returns the process exit code: 0 for a normal run, or
 * the value a long-running command (the ping watcher) settles on when aborted,
 * so the boot guard can exit deterministically instead of the process being
 * kept alive by a watch loop. An optional external `signal` cancels the watch
 * (used by tests; production wires SIGINT/SIGTERM inside the ping command).
 */
export async function main(
  argv: string[] = process.argv.slice(2),
  io: CliEnv = realCliEnv,
  root: string = projectRoot(),
  signal?: AbortSignal,
): Promise<number> {
  const args = parseArgs(argv);
  if (args.command === "help" || args.command === "-h" || args.command === "--help") {
    usage();
    return 0;
  }
  const mode = resolveMode(args.mode, io);
  switch (args.command) {
    case "setup":
      cmdSetup(root, mode, args.rotate, io);
      break;
    case "up":
    case "start":
      cmdUp(root, mode, io);
      break;
    case "down":
    case "stop":
      cmdDown(root, mode, io);
      break;
    case "restart":
      cmdDown(root, mode, io);
      cmdUp(root, mode, io);
      break;
    case "status":
      cmdStatus(root, mode, io);
      break;
    case "logs":
      cmdLogs(root, mode, io);
      break;
    case "config-claude":
      cmdConfigClaude(root, io);
      break;
    case "doctor":
      await cmdDoctor(root, mode, io);
      break;
    case "ping":
      return runPingWatcher(args.arg, io, root, signal);
    default:
      warn(`Unknown command: ${args.command}`);
      usage();
      process.exit(1);
  }
  return 0;
}

/**
 * Fatal-exit handler for the boot guard: report the error and exit non-zero.
 * Extracted (and exported) so its body is exercised directly instead of hiding
 * inside a never-run `import.meta.main` arrow.
 */
export function cliErrorExit(err: unknown): void {
  console.error(err);
  process.exit(1);
}

/** Adopt main()'s resolved code as the process exit status (exported for tests). */
export function setExitCode(code: number): void {
  process.exitCode = code;
}

// Only run the CLI when executed directly (`bun run src/cli/index.ts ...`),
// not when imported (e.g. by the module smoke test), mirroring server.ts.
// The resolved code becomes the process exit status (a clean ping shutdown is
// 0), so a non-zero return is not silently discarded; a rejection still forces
// a non-zero exit through cliErrorExit.
if (import.meta.main) {
  main().then(setExitCode).catch(cliErrorExit);
}
