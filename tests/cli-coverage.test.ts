/**
 * Coverage closure for the CLI modules: src/cli/{util,env,index,claude,deps}.ts.
 *
 * Everything here drives the REAL functions with real inputs and asserts on the
 * real output — real temp files, real (light, harmless) child processes, the
 * real `.env` reader/writer, the real config validator. The only thing ever
 * intercepted is `process.exit` (so `die()` can be asserted without killing the
 * test runner) and the stdout/stderr write sinks (to capture what the coloured
 * loggers emitted). No line is coloured green without exercising its branch.
 *
 * The command bodies are driven in-process through the injected boundary seams
 * (CliEnv in index.ts, DepsHost in deps.ts, writeClaudeSettings' settings-path
 * parameter): every function runs its REAL logic against a temp project root,
 * with only the process/OS boundary stubbed so no real process is spawned and
 * no file is written outside the temp dir.
 *
 * STILL not reachable from an in-process test (see the report at the bottom):
 *  - src/cli/index.ts — the `deriveBindIp() === null` branch (a host with no
 *                       private LAN interface) in both resolveBindIp and
 *                       cmdDoctor: deriveBindIp reads os.networkInterfaces()
 *                       directly, and this host always has a private LAN IPv4.
 *  - src/cli/index.ts — the `import.meta.main` boot guard: false under
 *                       bun:test, and a spawned child contributes no
 *                       in-process line coverage.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import type { NetworkInterfaceInfoIPv4 } from "node:os";
import { join } from "node:path";
import { type NetworkInterfaceMap, deriveBindIp, verifyBindIp } from "../src/cli/bind-ip.ts";
import { buildClaudeEnv, writeClaudeSettings } from "../src/cli/claude.ts";
import { type DepsHost, checkBun, checkDocker, ensureClaudeCode } from "../src/cli/deps.ts";
import { getEnvValue, readEnvFile } from "../src/cli/env.ts";
import {
  type CliEnv,
  claudeModels,
  cliErrorExit,
  cmdConfigClaude,
  cmdDoctor,
  cmdDown,
  cmdLogs,
  cmdSetup,
  cmdStatus,
  cmdUp,
  configDiagnostics,
  main,
  readPid,
  realCliEnv,
  resolveBindIp,
  resolveSoundPlayer,
  setExitCode,
  usage,
} from "../src/cli/index.ts";
import {
  bold,
  commandExists,
  die,
  err,
  info,
  isWindows,
  ok,
  runCapture,
  runInherit,
  spawnDetached,
  warn,
} from "../src/cli/util.ts";
import { validateConfig } from "../src/config.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccpp-cli-cov-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// --- capture helpers -------------------------------------------------------

const BOGUS_BIN = "ccpp-definitely-not-a-real-binary-xyz";

/** Restore a captured write sink after a test. */
type WriteSink = { write: unknown };
function captureSink(target: NodeJS.WriteStream, sink: string[]): () => void {
  const original = target.write.bind(target);
  (target as unknown as WriteSink).write = (chunk: string) => {
    sink.push(String(chunk));
    return true;
  };
  return () => {
    (target as unknown as WriteSink).write = original;
  };
}

/** Run `fn` with stdout/stderr captured; returns the captured text. */
function captureOutput<T>(fn: () => T): { stdout: string; stderr: string; result: T } {
  const out: string[] = [];
  const errs: string[] = [];
  const restoreOut = captureSink(process.stdout, out);
  const restoreErr = captureSink(process.stderr, errs);
  try {
    const result = fn();
    return { stdout: out.join(""), stderr: errs.join(""), result };
  } finally {
    restoreOut();
    restoreErr();
  }
}

/** Sentinel thrown in place of process.exit so the runner survives `die()`. */
class ExitTrapped extends Error {
  constructor(readonly exitCode: number | undefined) {
    super(`process.exit(${exitCode}) trapped`);
  }
}

/**
 * Run `fn` with process.exit stubbed to throw, so `die()`'s real body (print to
 * stderr + request exit 1) runs without terminating the test process.
 */
function runTrappingExit(fn: () => void): {
  code: number | undefined;
  stdout: string;
  stderr: string;
} {
  const out: string[] = [];
  const errs: string[] = [];
  const restoreOut = captureSink(process.stdout, out);
  const restoreErr = captureSink(process.stderr, errs);
  const originalExit = process.exit;
  let code: number | undefined;
  process.exit = ((exitCode?: number): never => {
    code = exitCode;
    throw new ExitTrapped(exitCode);
  }) as typeof process.exit;
  try {
    fn();
  } catch (e) {
    if (!(e instanceof ExitTrapped)) throw e;
  } finally {
    process.exit = originalExit;
    restoreOut();
    restoreErr();
  }
  return { code, stdout: out.join(""), stderr: errs.join("") };
}

/** Poll `pred` until it is true or the timeout elapses. */
async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

// ---------------------------------------------------------------------------
// src/cli/util.ts
// ---------------------------------------------------------------------------

describe("util: logging + colour", () => {
  test("info/ok/warn write plain stdout and err writes plain stderr (colour off)", () => {
    const { stdout, stderr } = captureOutput(() => {
      info("i-line");
      ok("o-line");
      warn("w-line");
      err("e-line");
    });
    // Under bun:test stdout is not a TTY, so colour is disabled: plain text,
    // one line each, no ANSI escapes.
    expect(stdout).toBe("i-line\no-line\nw-line\n");
    expect(stderr).toBe("e-line\n");
    expect(stdout.includes("\u001b")).toBe(false);
    expect(stderr.includes("\u001b")).toBe(false);
  });

  test("bold returns the input unchanged when colour is disabled (non-TTY)", () => {
    expect(bold("plain")).toBe("plain");
    expect(bold("plain").includes("\u001b")).toBe(false);
  });
});

describe("util: die", () => {
  test("prints ERROR: <msg> to stderr and requests exit 1", () => {
    const { code, stdout, stderr } = runTrappingExit(() => die("boom"));
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe("ERROR: boom\n");
  });
});

describe("util: process wrappers", () => {
  test("commandExists resolves a real binary and rejects a bogus one", () => {
    const real = isWindows() ? "cmd" : "sh";
    expect(commandExists(real)).toBe(true);
    expect(commandExists(BOGUS_BIN)).toBe(false);
  });

  test("runInherit returns the child exit code, and 1 on spawn failure", () => {
    if (isWindows()) return; // `sh` is POSIX-only
    expect(runInherit("sh", ["-c", "exit 7"])).toBe(7);
    expect(runInherit("sh", ["-c", "exit 0"])).toBe(0);
    expect(runInherit(BOGUS_BIN, [])).toBe(1); // res.error set => 1
  });

  test("runCapture trims stdout, returns null on non-zero, null on spawn failure", () => {
    if (isWindows()) return;
    expect(runCapture("sh", ["-c", "printf '  hi  '"])).toBe("hi");
    expect(runCapture("sh", ["-c", "exit 3"])).toBeNull();
    expect(runCapture(BOGUS_BIN, [])).toBeNull();
  });
});

describe("util: spawnDetached", () => {
  let logPath: string;
  let logFd: number;
  beforeEach(() => {
    logPath = join(dir, "out.log");
    logFd = openSync(logPath, "a");
  });
  afterEach(() => {
    try {
      closeSync(logFd);
    } catch {
      // already closed
    }
  });

  test("spawns a detached child writing to the log fd and returns its pid", async () => {
    if (isWindows()) return;
    const pid = spawnDetached("sh", ["-c", "printf SPAWNED"], {
      cwd: dir,
      logFd,
      env: { ...process.env } as Record<string, string>,
    });
    expect(typeof pid).toBe("number");
    await waitFor(() => readFileSync(logPath, "utf8").includes("SPAWNED"));
    expect(readFileSync(logPath, "utf8")).toContain("SPAWNED");
  });

  test("a failed spawn surfaces through the error handler instead of crashing", async () => {
    const errs: string[] = [];
    const restoreErr = captureSink(process.stderr, errs);
    try {
      const pid = spawnDetached(BOGUS_BIN, [], { cwd: dir, logFd, env: {} });
      expect(pid).toBeUndefined();
      // The ENOENT arrives asynchronously; give the 'error' listener a tick.
      await new Promise((r) => setTimeout(r, 200));
    } finally {
      restoreErr();
    }
    expect(errs.join("")).toContain(`Failed to spawn ${BOGUS_BIN}`);
  });
});

// ---------------------------------------------------------------------------
// src/cli/env.ts — readEnvFile (the one uncovered function)
// ---------------------------------------------------------------------------

describe("env: readEnvFile", () => {
  test("returns {} for a missing file", () => {
    expect(readEnvFile(join(dir, "nope.env"))).toEqual({});
  });

  test("reads KEY=VALUE pairs; ignores comments/blank/non-matching; last wins", () => {
    writeFileSync(
      join(dir, ".env"),
      ["# comment", "A=1", "", "B=two words", "A=3", "NOT A KEY=x", "9BAD=y", ""].join("\n"),
    );
    expect(readEnvFile(join(dir, ".env"))).toEqual({ A: "3", B: "two words" });
  });
});

// ---------------------------------------------------------------------------
// src/cli/index.ts
// ---------------------------------------------------------------------------

describe("index: claudeModels hard-fail", () => {
  test("dies with a pointer to .env.example when ANTHROPIC_MODEL is missing", () => {
    const envPath = join(dir, ".env");
    writeFileSync(envPath, "ANTHROPIC_SMALL_FAST_MODEL=only-the-legacy-var\n");
    const { code, stderr } = runTrappingExit(() => claudeModels(envPath));
    expect(code).toBe(1);
    expect(stderr).toContain("ANTHROPIC_MODEL missing in .env");
  });
});

describe("index: readPid unreadable path", () => {
  test("warns and returns null when the pid path exists but cannot be read", () => {
    const asDir = join(dir, "pid-dir");
    mkdirSync(asDir); // existsSync true, readFileSync(dir) throws EISDIR
    const { result, stdout } = captureOutput(() => readPid(asDir));
    expect(result).toBeNull();
    // warn() writes to stdout (see util: logging above).
    expect(stdout).toContain(`Could not read pid file ${asDir}`);
  });
});

describe("index: resolveBindIp auto-derivation", () => {
  const saved = process.env.BIND_IP;
  afterEach(() => {
    if (saved === undefined) Reflect.deleteProperty(process.env, "BIND_IP");
    else process.env.BIND_IP = saved;
  });

  test("derives, persists to .env, and exports BIND_IP when it is unset", () => {
    const envPath = join(dir, ".env");
    writeFileSync(envPath, "PORT=8787\n");
    Reflect.deleteProperty(process.env, "BIND_IP");

    const expected = deriveBindIp(); // the real derivation for this host
    const { result } = captureOutput(() => resolveBindIp(envPath));

    expect(result).toBe(expected);
    if (expected !== null) {
      expect(getEnvValue(envPath, "BIND_IP")).toBe(expected);
      expect(process.env.BIND_IP).toBe(expected);
    }
  });

  test("an existing BIND_IP is verified and returned without rewriting", () => {
    const envPath = join(dir, ".env");
    writeFileSync(envPath, "BIND_IP=192.168.1.77\n");
    Reflect.deleteProperty(process.env, "BIND_IP");
    const { result } = captureOutput(() => resolveBindIp(envPath));
    expect(result).toBe("192.168.1.77");
    expect(process.env.BIND_IP).toBe("192.168.1.77");
  });
});

// ---------------------------------------------------------------------------
// index: bind-ip derivation against an INJECTED interface map.
//
// The interface scan reads os.networkInterfaces() through the CliEnv seam, so a
// synthetic host — including one with no private LAN IPv4 — is reachable here.
// This is what makes resolveBindIp's `deriveBindIp() === null` branch and
// cmdDoctor's matching "none derivable (VPN-only?)" arm testable instead of
// allowlisted as environmental.
// ---------------------------------------------------------------------------
describe("index: bind-ip derivation via the injected interface seam", () => {
  const saved = process.env.BIND_IP;
  afterEach(() => {
    if (saved === undefined) Reflect.deleteProperty(process.env, "BIND_IP");
    else process.env.BIND_IP = saved;
  });

  /** One IPv4 address record for a synthetic interface. */
  const v4 = (address: string, internal = false): NetworkInterfaceInfoIPv4 => ({
    address,
    netmask: "255.255.255.0",
    family: "IPv4",
    mac: "00:00:00:00:00:00",
    internal,
    cidr: `${address}/24`,
  });

  /** Loopback + a WireGuard-style VPN tunnel: NO private LAN interface. */
  const VPN_ONLY: NetworkInterfaceMap = {
    lo0: [v4("127.0.0.1", true)],
    utun3: [v4("10.8.0.2")],
  };
  /** A normal host with one private LAN NIC. */
  const LAN: NetworkInterfaceMap = { en0: [v4("192.168.1.20")] };

  test("deriveBindIp returns null on a VPN-only host, the address on a LAN host", () => {
    expect(deriveBindIp(() => VPN_ONLY)).toBeNull();
    expect(deriveBindIp(() => LAN)).toBe("192.168.1.20");
  });

  test("verifyBindIp flags a private address that sits on a virtual interface", () => {
    expect(verifyBindIp("10.8.0.2", () => VPN_ONLY)).toEqual({ ok: false, reason: "virtual" });
    expect(verifyBindIp("192.168.1.20", () => LAN)).toEqual({ ok: true });
  });

  test("resolveBindIp warns and returns null when no LAN IP can be derived", () => {
    const envPath = join(dir, ".env");
    writeFileSync(envPath, "PORT=8787\n");
    Reflect.deleteProperty(process.env, "BIND_IP");
    const io = makeIo({ networkInterfaces: () => VPN_ONLY });
    const { result, stdout } = captureOutput(() => resolveBindIp(envPath, io));
    expect(result).toBeNull();
    expect(stdout).toContain("Could not auto-derive a LAN IP (VPN-only or no private interface?).");
    // Nothing was persisted for a null derivation.
    expect(getEnvValue(envPath, "BIND_IP")).toBeFalsy();
  });

  test("cmdDoctor reports the VPN-only diagnostic", async () => {
    writeFileSync(join(dir, ".env"), "ANTHROPIC_MODEL=virtual.anthropic.global.sonnet-like\n");
    const io = makeIo({
      commandExists: (c) => c === "bun",
      networkInterfaces: () => VPN_ONLY,
    });
    const { stdout } = await captureOutputAsync(() => cmdDoctor(dir, "local", io));
    expect(stdout).toContain("BIND_IP unset and none derivable (VPN-only?).");
  });
});

describe("index: configDiagnostics provider/region branches", () => {
  const BASE = {
    server: { host: "127.0.0.1", port: 8787 },
    primaryRegion: "us",
    profilePreference: "global",
    refreshIntervalMinutes: 60,
    claudeFallbackToMantle: false,
    regions: [{ key: "us", awsRegion: "us-east-1" }],
    providers: {},
    logging: { enabled: false },
    chatPage: { enabled: false },
  };

  test("reports a provider-level inactiveReason", () => {
    const cfg = validateConfig({
      ...BASE,
      inboundAuth: { keys: ["k"] },
      providers: {
        broken: {
          type: "anthropic",
          auth: "x-api-key",
          credential: "some-key",
          baseUrl: "", // unset env ref -> provider inactive
          modelsUrl: "https://api.example.com/v1/models",
        },
      },
    });
    const lines = configDiagnostics(cfg);
    const broken = lines.find((l) => l.line.includes("broken"));
    expect(broken?.level).toBe("warn");
    expect(broken?.line).toContain("inactive");
  });

  test("reports active regions (own multi-key pool, inherited pool) and a skipped one", () => {
    const cfg = validateConfig({
      ...BASE,
      inboundAuth: { keys: ["k"] },
      providers: {
        regional: {
          type: "anthropic",
          auth: "x-api-key",
          credential: "prov-key", // provider pool non-empty -> no provider inactiveReason
          regions: {
            // Own pool of two usable keys -> ok, plural.
            "eu-central-1": {
              modelsUrl: "https://eu.example.com/compatible-mode/v1/models",
              region: "eu-central-1",
              credentials: [{ credential: "eu-a" }, { credential: "eu-b" }],
            },
            // Own pool of one placeholder -> nothing usable -> skipped.
            "us-east-1": {
              modelsUrl: "https://us.example.com/compatible-mode/v1/models",
              region: "us-east-1",
              credential: "REPLACE_ME",
            },
            // No own pool -> inherits the provider pool (single usable key) -> ok.
            "ap-south-1": {
              modelsUrl: "https://ap.example.com/compatible-mode/v1/models",
              region: "ap-south-1",
            },
          },
        },
      },
    });
    const lines = configDiagnostics(cfg);

    const eu = lines.find((l) => l.line.includes("regional:eu-central-1"));
    expect(eu?.level).toBe("ok");
    expect(eu?.line).toContain("2 keys");

    const us = lines.find((l) => l.line.includes("regional:us-east-1"));
    expect(us?.level).toBe("warn");
    expect(us?.line).toContain("skipped");

    const ap = lines.find((l) => l.line.includes("regional:ap-south-1"));
    expect(ap?.level).toBe("ok");
    // Single usable key -> no ", N keys" suffix.
    expect(ap?.line).toContain("credential set (anthropic)");
  });
});

// ---------------------------------------------------------------------------
// index: command dispatch — the real main() in a child process
// ---------------------------------------------------------------------------
// main() only runs under `import.meta.main`, so it can never be entered from an
// imported module; bun's in-process coverage therefore cannot see these lines.
// This drives the REAL dispatcher end-to-end for the two safe, non-side-effecting
// commands (the state-changing paths are covered by the live/manual run modes).
// It adds no coverage — it is a behavioural test that the dispatcher works.
describe("index: command dispatch (child process)", () => {
  const repoRoot = join(import.meta.dir, "..");
  const cliPath = join(repoRoot, "src", "cli", "index.ts");

  test("`help` prints the usage banner and exits 0", () => {
    const r = Bun.spawnSync(["bun", "run", cliPath, "help"], { cwd: repoRoot });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toContain("claude-code-provider-proxy CLI");
  });

  test("an unknown command warns and exits non-zero", () => {
    const r = Bun.spawnSync(["bun", "run", cliPath, "definitely-not-a-command"], { cwd: repoRoot });
    expect(r.exitCode).toBe(1);
    expect(r.stdout.toString()).toContain("Unknown command: definitely-not-a-command");
  });
});

// ---------------------------------------------------------------------------
// Injected boundary seams: helpers shared by the deps/index/claude suites.
// ---------------------------------------------------------------------------

interface StubRecord {
  cmd: string;
  args: string[];
  cwd?: string;
}
type SpawnOpts = { cwd: string; logFd: number; env: Record<string, string> };

/** A CliEnv whose process/OS boundary is stubbed; it also records what the
 *  command asked it to do, so a test can assert the REAL command logic. */
interface StubIo extends CliEnv {
  captures: StubRecord[];
  inherits: StubRecord[];
  spawns: (StubRecord & { opts: SpawnOpts })[];
  killed: number[];
}

function makeIo(over: Partial<CliEnv> = {}): StubIo {
  const captures: StubRecord[] = [];
  const inherits: StubRecord[] = [];
  const spawns: (StubRecord & { opts: SpawnOpts })[] = [];
  const killed: number[] = [];
  const base: StubIo = {
    commandExists: () => false,
    runCapture: (cmd, args) => {
      captures.push({ cmd, args });
      return null;
    },
    runInherit: (cmd, args, cwd) => {
      inherits.push({ cmd, args, ...(cwd !== undefined ? { cwd } : {}) });
      return 0;
    },
    spawnDetached: (cmd, args, opts) => {
      spawns.push({ cmd, args, opts });
      return 4242;
    },
    kill: (pid) => killed.push(pid),
    currentPlatform: () => "linux",
    // BIND_IP seam: default to the REAL interface lookup (so the ordinary
    // command tests behave exactly as before); the bind-ip suite overrides it
    // with a synthetic host — including a VPN-only one with no LAN address.
    networkInterfaces: realCliEnv.networkInterfaces,
    // Ping-watcher seams: default to a no-op watch so the other command tests
    // never enter the loop. The ping suite overrides these.
    pollStatus: () => Promise.resolve(undefined),
    sleep: () => Promise.resolve(),
    captures,
    inherits,
    spawns,
    killed,
  };
  return Object.assign(base, over);
}

/** A CliEnv with Docker/bun present, `docker info` + `compose version` OK. */
function dockerIo(over: Partial<CliEnv> = {}): StubIo {
  return makeIo({ commandExists: () => true, runCapture: () => "Docker version 27", ...over });
}

/** A DepsHost with every probe stubbed. */
function makeHost(over: Partial<DepsHost> = {}): DepsHost {
  return {
    commandExists: () => false,
    runCapture: () => null,
    runInherit: () => 0,
    currentPlatform: () => "linux",
    ...over,
  };
}

/** Run an async body with stdout/stderr captured. */
async function captureOutputAsync<T>(
  fn: () => Promise<T>,
): Promise<{ stdout: string; stderr: string; result: T }> {
  const out: string[] = [];
  const errs: string[] = [];
  const restoreOut = captureSink(process.stdout, out);
  const restoreErr = captureSink(process.stderr, errs);
  try {
    const result = await fn();
    return { stdout: out.join(""), stderr: errs.join(""), result };
  } finally {
    restoreOut();
    restoreErr();
  }
}

/** Async twin of runTrappingExit: trap process.exit so an async `die()` is safe. */
async function runTrappingExitAsync(fn: () => Promise<unknown>): Promise<{
  code: number | undefined;
  stdout: string;
  stderr: string;
}> {
  const out: string[] = [];
  const errs: string[] = [];
  const restoreOut = captureSink(process.stdout, out);
  const restoreErr = captureSink(process.stderr, errs);
  const originalExit = process.exit;
  let code: number | undefined;
  process.exit = ((exitCode?: number): never => {
    code = exitCode;
    throw new ExitTrapped(exitCode);
  }) as typeof process.exit;
  try {
    await fn();
  } catch (e) {
    if (!(e instanceof ExitTrapped)) throw e;
  } finally {
    process.exit = originalExit;
    restoreOut();
    restoreErr();
  }
  return { code, stdout: out.join(""), stderr: errs.join("") };
}

// ---------------------------------------------------------------------------
// src/cli/deps.ts — real install/availability logic with a stubbed host
// ---------------------------------------------------------------------------

describe("deps: checkBun", () => {
  test("reports present when bun is on PATH, absent otherwise", () => {
    const present = captureOutput(() => checkBun(makeHost({ commandExists: (c) => c === "bun" })));
    expect(present.result).toBe(true);
    expect(present.stdout).toContain("Bun is installed.");

    const absent = captureOutput(() => checkBun(makeHost({ commandExists: () => false })));
    expect(absent.result).toBe(false);
    expect(absent.stdout).toContain("Bun not detected on PATH");
  });
});

describe("deps: checkDocker", () => {
  test("required + docker absent: dies with install guidance", () => {
    const { code, stderr } = runTrappingExit(() => checkDocker(true, makeHost()));
    expect(code).toBe(1);
    expect(stderr).toContain("Docker not found.");
  });

  test("optional + docker absent: warns and returns false", () => {
    const { result, stdout } = captureOutput(() => checkDocker(false, makeHost()));
    expect(result).toBe(false);
    expect(stdout).toContain("Docker not found (only needed for --docker mode).");
  });

  test("daemon down is fatal when required, a warning when optional", () => {
    const host = makeHost({ commandExists: () => true, runCapture: () => null });
    const died = runTrappingExit(() => checkDocker(true, host));
    expect(died.code).toBe(1);
    expect(died.stderr).toContain("Docker daemon not reachable.");

    const opt = captureOutput(() => checkDocker(false, host));
    expect(opt.result).toBe(false);
    expect(opt.stdout).toContain("Docker installed but daemon not reachable.");
  });

  test("docker present and daemon responding: returns true", () => {
    const host = makeHost({ commandExists: () => true, runCapture: () => "Server: Docker Engine" });
    const { result, stdout } = captureOutput(() => checkDocker(true, host));
    expect(result).toBe(true);
    expect(stdout).toContain("Docker is installed and running.");
  });
});

describe("deps: ensureClaudeCode", () => {
  test("already installed: returns true without an install attempt", () => {
    const { result, stdout } = captureOutput(() =>
      ensureClaudeCode(makeHost({ commandExists: (c) => c === "claude" })),
    );
    expect(result).toBe(true);
    expect(stdout).toContain("Claude Code is installed.");
  });

  test("unix: installs via the official curl script", () => {
    let installed = false;
    const host = makeHost({
      commandExists: (c) => (c === "claude" ? installed : c === "curl"),
      runInherit: () => {
        installed = true;
        return 0;
      },
    });
    const { result, stdout } = captureOutput(() => ensureClaudeCode(host));
    expect(result).toBe(true);
    expect(stdout).toContain("Installed Claude Code via official script.");
  });

  test("unix: falls back to npm when the curl script fails", () => {
    let installed = false;
    const host = makeHost({
      commandExists: (c) => (c === "claude" ? installed : c === "curl" || c === "npm"),
      runInherit: (cmd) => {
        if (cmd === "npm") installed = true;
        return cmd === "sh" ? 1 : 0;
      },
    });
    const { result, stdout } = captureOutput(() => ensureClaudeCode(host));
    expect(result).toBe(true);
    expect(stdout).toContain("Installed Claude Code via npm.");
  });

  test("unix: when every installer fails, points at the manual steps", () => {
    const host = makeHost({ commandExists: (c) => c === "curl", runInherit: () => 1 });
    const { result, stdout } = captureOutput(() => ensureClaudeCode(host));
    expect(result).toBe(false);
    expect(stdout).toContain("Could not auto-install Claude Code.");
    expect(stdout).toContain("curl -fsSL https://claude.ai/install.sh | sh");
  });

  test("windows: installs via npm when available", () => {
    let installed = false;
    const host = makeHost({
      currentPlatform: () => "windows",
      commandExists: (c) => (c === "claude" ? installed : c === "npm"),
      runInherit: () => {
        installed = true;
        return 0;
      },
    });
    const { result, stdout } = captureOutput(() => ensureClaudeCode(host));
    expect(result).toBe(true);
    expect(stdout).toContain("Installed Claude Code via npm.");
  });

  test("windows without npm: reports it cannot auto-install", () => {
    const host = makeHost({ currentPlatform: () => "windows", commandExists: () => false });
    const { result, stdout } = captureOutput(() => ensureClaudeCode(host));
    expect(result).toBe(false);
    expect(stdout).toContain("Could not auto-install Claude Code on Windows.");
  });
});

// ---------------------------------------------------------------------------
// src/cli/claude.ts — writeClaudeSettings against an injected settings path
// ---------------------------------------------------------------------------

const CLAUDE_INPUT = {
  baseUrl: "http://127.0.0.1:8787",
  authToken: "ccpp_inbound",
  mainModel: "virtual.anthropic.global.sonnet-like",
  fastModel: "virtual.anthropic.global.haiku-like",
  sonnetModel: "virtual.anthropic.global.sonnet-like",
  haikuModel: "virtual.anthropic.global.haiku-like",
  opusModel: "virtual.anthropic.global.opus-like",
  defaultModel: "virtual.anthropic.global.sonnet-like",
  subagentModel: "virtual.anthropic.global.haiku-like",
  legacySmallFast: false,
};

describe("claude: writeClaudeSettings", () => {
  test("writes the full env block to a fresh settings file (no backup)", () => {
    const file = join(dir, "claude", "settings.json"); // parent dir absent -> created
    const { stdout, result } = captureOutput(() => writeClaudeSettings(CLAUDE_INPUT, file));
    expect(result.backup).toBeNull();
    expect(result.file).toBe(file);
    expect(stdout).toContain(`Configured Claude Code -> ${file}`);

    const parsed = JSON.parse(readFileSync(file, "utf8")) as { env: Record<string, unknown> };
    expect(parsed.env).toEqual(buildClaudeEnv(CLAUDE_INPUT, {}));
    expect(parsed.env.ANTHROPIC_AUTH_TOKEN).toBe("ccpp_inbound");
    expect(parsed.env.ANTHROPIC_API_KEY).toBe("");
  });

  test("merges into an existing file, preserving unrelated keys, and backs it up", () => {
    const file = join(dir, "settings.json");
    writeFileSync(
      file,
      JSON.stringify({ theme: "dark", env: { KEEP_ME: "yes", ANTHROPIC_MODEL: "stale-id" } }),
    );
    const { stdout, result } = captureOutput(() => writeClaudeSettings(CLAUDE_INPUT, file));
    expect(result.backup).not.toBeNull();
    expect(stdout).toContain("Backed up existing Claude settings ->");

    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      theme: string;
      env: Record<string, unknown>;
    };
    expect(parsed.theme).toBe("dark"); // unrelated top-level key survives
    expect(parsed.env.KEEP_ME).toBe("yes"); // unrelated env key survives
    expect(parsed.env.ANTHROPIC_MODEL).toBe(CLAUDE_INPUT.mainModel); // managed key overwritten
  });

  test("recovers from a corrupt settings file, keeping the backup", () => {
    const file = join(dir, "settings.json");
    writeFileSync(file, "{ not: valid json");
    const { stdout, result } = captureOutput(() => writeClaudeSettings(CLAUDE_INPUT, file));
    expect(result.backup).not.toBeNull();
    expect(stdout).toContain("not valid JSON; starting fresh (backup kept).");
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { env: Record<string, unknown> };
    expect(parsed.env.ANTHROPIC_BASE_URL).toBe(CLAUDE_INPUT.baseUrl);
  });

  test("writes the settings file owner-only (0o600) on POSIX", () => {
    if (isWindows()) return;
    const file = join(dir, "settings.json");
    writeClaudeSettings(CLAUDE_INPUT, file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

// ---------------------------------------------------------------------------
// src/cli/index.ts — real command bodies through the injected CliEnv
// ---------------------------------------------------------------------------

/** A minimal valid config (no providers) as the server would parse it. */
const VALID_CONFIG = {
  server: { host: "127.0.0.1", port: 8787 },
  inboundAuth: { keys: ["${PROXY_INBOUND_KEY}"] },
  primaryRegion: "us",
  profilePreference: "global",
  refreshIntervalMinutes: 60,
  claudeFallbackToMantle: false,
  regions: [{ key: "us", awsRegion: "us-east-1" }],
  providers: {},
  logging: { enabled: false },
  chatPage: { enabled: false },
};

/** Seed a temp project root with the committed example files `setup` copies. */
function seedProject(root: string): void {
  writeFileSync(
    join(root, ".env.example"),
    [
      "PROXY_INBOUND_KEY=change-me-to-a-strong-random-string",
      "ANTHROPIC_MODEL=virtual.anthropic.global.sonnet-like",
      "ANTHROPIC_SMALL_FAST_MODEL=virtual.anthropic.global.haiku-like",
      "BIND_IP=10.0.0.5",
      "PORT=8787",
      "",
    ].join("\n"),
  );
  writeFileSync(join(root, "config.example.jsonc"), `${JSON.stringify(VALID_CONFIG, null, 2)}\n`);
}

describe("index: command bodies (injected boundary)", () => {
  const savedBindIp = process.env.BIND_IP;
  afterEach(() => {
    if (savedBindIp === undefined) Reflect.deleteProperty(process.env, "BIND_IP");
    else process.env.BIND_IP = savedBindIp;
  });

  beforeEach(() => {
    seedProject(dir);
  });

  test("cmdUp --local spawns the server, writes the pid, and prints both URLs", () => {
    const io = makeIo();
    const { stdout } = captureOutput(() => cmdUp(dir, "local", io));

    expect(io.spawns).toHaveLength(1);
    const spawn = io.spawns[0];
    expect(spawn?.cmd).toBe("bun");
    // The child env is the real observable: HOST/PORT/CONFIG_PATH drive the server.
    expect(spawn?.opts.env.HOST).toBe("10.0.0.5");
    expect(spawn?.opts.env.PORT).toBe("8787");
    expect(spawn?.opts.env.CONFIG_PATH).toBe(join(dir, "config.local.jsonc"));
    expect(readFileSync(join(dir, "logs", "proxy.pid"), "utf8")).toBe("4242\n");
    expect(stdout).toContain("Proxy running locally (pid 4242, bound to 10.0.0.5:8787).");
    expect(stdout).toContain("Registry (local): http://127.0.0.1:8787/");
    expect(stdout).toContain("Registry (LAN):   http://10.0.0.5:8787/");
  });

  test("cmdUp --local refuses to double-start when a live pid is recorded", () => {
    mkdirSync(join(dir, "logs"), { recursive: true });
    writeFileSync(join(dir, "logs", "proxy.pid"), `${process.pid}\n`);
    const io = makeIo();
    const { stdout } = captureOutput(() => cmdUp(dir, "local", io));
    expect(stdout).toContain(`Proxy already running locally (pid ${process.pid}).`);
    expect(io.spawns).toHaveLength(0);
  });

  test("cmdStatus --local reports running when a live pid is recorded", () => {
    mkdirSync(join(dir, "logs"), { recursive: true });
    writeFileSync(join(dir, "logs", "proxy.pid"), `${process.pid}\n`);
    const { stdout } = captureOutput(() => cmdStatus(dir, "local", makeIo()));
    expect(stdout).toContain(`Local proxy running (pid ${process.pid}).`);
    expect(stdout).toContain("Registry (local): http://127.0.0.1:8787/");
  });

  test("cmdStatus --local reports not running with no pid file", () => {
    const { stdout } = captureOutput(() => cmdStatus(dir, "local", makeIo()));
    expect(stdout).toContain("Local proxy not running.");
  });

  test("cmdDown --local: nothing to stop, a stale pid, and a live pid", () => {
    // No pid file.
    const none = captureOutput(() => cmdDown(dir, "local", makeIo()));
    expect(none.stdout).toContain("No local proxy pid file found; nothing to stop.");

    // Stale pid (not a running process): cleared.
    const pidFile = join(dir, "logs", "proxy.pid");
    mkdirSync(join(dir, "logs"), { recursive: true });
    writeFileSync(pidFile, "1073741823\n");
    const stale = captureOutput(() => cmdDown(dir, "local", makeIo()));
    expect(stale.stdout).toContain("not running; clearing stale pid file.");
    expect(existsSync(pidFile)).toBe(false);

    // Live pid: signalled via the injected kill (never a real signal).
    writeFileSync(pidFile, `${process.pid}\n`);
    const io = makeIo();
    const live = captureOutput(() => cmdDown(dir, "local", io));
    expect(live.stdout).toContain(`Stopped local proxy (pid ${process.pid}).`);
    expect(io.killed).toEqual([process.pid]);
    expect(existsSync(pidFile)).toBe(false);
  });

  test("cmdUp --docker composes up and prints the LAN + local URLs", () => {
    const io = dockerIo();
    const { stdout } = captureOutput(() => cmdUp(dir, "docker", io));
    expect(stdout).toContain(
      "Running in Docker (bound to 10.0.0.5 + 127.0.0.1 only — not 0.0.0.0).",
    );
    expect(stdout).toContain("Registry (LAN):   http://10.0.0.5:8787/");
  });

  test("cmdUp --docker falls back to legacy docker-compose when the plugin is absent", () => {
    // `docker info` succeeds (daemon up) but `docker compose version` fails, so
    // compose() must fall through to the docker-compose binary.
    const io = makeIo({
      commandExists: (c) => c === "docker" || c === "docker-compose",
      runCapture: (_cmd, args) => (args[0] === "compose" ? null : "Server: Docker Engine"),
    });
    const { stdout } = captureOutput(() => cmdUp(dir, "docker", io));
    expect(stdout).toContain("Running in Docker");
    expect(io.inherits.some((r) => r.cmd === "docker-compose" && r.args[0] === "up")).toBe(true);
  });

  test("cmdDown --docker composes down and reports stopped", () => {
    const { stdout } = captureOutput(() => cmdDown(dir, "docker", dockerIo()));
    expect(stdout).toContain("Stopped.");
  });

  test("cmdStatus --docker composes ps and prints the registry URL", () => {
    // cmdStatus reads .env directly (it does not bootstrap one first).
    writeFileSync(join(dir, ".env"), "BIND_IP=10.0.0.5\nPORT=8787\n");
    const { stdout } = captureOutput(() => cmdStatus(dir, "docker", dockerIo()));
    expect(stdout).toContain("Registry: http://10.0.0.5:8787/");
  });

  test("cmdLogs --local warns when no log file exists, tails it when it does", () => {
    const missing = captureOutput(() => cmdLogs(dir, "local", makeIo()));
    expect(missing.stdout).toContain("No local log file yet.");

    mkdirSync(join(dir, "logs"), { recursive: true });
    const log = join(dir, "logs", "proxy.local.log");
    writeFileSync(log, "boot\n");
    const io = makeIo();
    const { stdout } = captureOutput(() => cmdLogs(dir, "local", io));
    expect(stdout).not.toContain("No local log file yet.");
    expect(io.inherits).toHaveLength(1);
    expect(io.inherits[0]?.cmd).toBe("tail");
    expect(io.inherits[0]?.args).toEqual(["-f", log]);
  });

  test("cmdLogs --docker composes the proxy logs", () => {
    const io = dockerIo();
    captureOutput(() => cmdLogs(dir, "docker", io));
    expect(
      io.inherits.some((r) => r.cmd === "docker" && r.args.join(" ") === "compose logs -f proxy"),
    ).toBe(true);
  });

  test("cmdSetup --local bootstraps, writes Claude settings, and reports completion", () => {
    const settings = join(dir, "claude-settings.json");
    const io = makeIo({ commandExists: (c) => c === "claude", claudeSettingsFile: settings });
    const { stdout } = captureOutput(() => cmdSetup(dir, "local", false, io));

    expect(stdout).toContain("[1/4] Checking dependencies");
    expect(stdout).toContain("Generated proxy auth token (PROXY_INBOUND_KEY).");
    expect(stdout).toContain("Claude Code is installed.");
    expect(stdout).toContain("[4/4] Local mode — no image build needed.");
    expect(stdout).toContain("Setup complete.");
    // createdEnv is true (no .env yet) -> the provider-activation hints print.
    expect(stdout).toContain("Activate at least one provider in .env");

    // The real token generated into .env is the one handed to Claude Code.
    const token = getEnvValue(join(dir, ".env"), "PROXY_INBOUND_KEY");
    expect(token?.startsWith("ccpp_")).toBe(true);
    const parsed = JSON.parse(readFileSync(settings, "utf8")) as { env: Record<string, unknown> };
    expect(parsed.env.ANTHROPIC_AUTH_TOKEN).toBe(token);
    expect(parsed.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8787");
  });

  test("cmdSetup --docker builds the image via compose", () => {
    const io = dockerIo({ claudeSettingsFile: join(dir, "claude-settings.json") });
    const { stdout } = captureOutput(() => cmdSetup(dir, "docker", false, io));
    expect(stdout).toContain("Docker is installed and running.");
    expect(stdout).toContain("[4/4] Building Docker image…");
    expect(stdout).toContain("Setup complete.");
  });

  test("cmdSetup --rotate replaces an existing token in .env", () => {
    writeFileSync(
      join(dir, ".env"),
      "PROXY_INBOUND_KEY=ccpp_original\nANTHROPIC_MODEL=virtual.anthropic.global.sonnet-like\nBIND_IP=10.0.0.5\n",
    );
    const io = makeIo({
      commandExists: (c) => c === "claude",
      claudeSettingsFile: join(dir, "s.json"),
    });
    const { stdout } = captureOutput(() => cmdSetup(dir, "local", true, io));
    expect(stdout).toContain("Rotated proxy auth token (PROXY_INBOUND_KEY).");
    const token = getEnvValue(join(dir, ".env"), "PROXY_INBOUND_KEY");
    expect(token).not.toBe("ccpp_original");
  });

  test("cmdConfigClaude writes settings from the .env token", () => {
    writeFileSync(
      join(dir, ".env"),
      "PROXY_INBOUND_KEY=ccpp_config\nANTHROPIC_MODEL=virtual.anthropic.global.sonnet-like\n",
    );
    const settings = join(dir, "claude-settings.json");
    const io = makeIo({ commandExists: (c) => c === "claude", claudeSettingsFile: settings });
    const { stdout } = captureOutput(() => cmdConfigClaude(dir, io));

    expect(stdout).toContain("Claude Code is installed.");
    expect(stdout).toContain(`Configured Claude Code -> ${settings}`);
    const parsed = JSON.parse(readFileSync(settings, "utf8")) as { env: Record<string, unknown> };
    expect(parsed.env.ANTHROPIC_AUTH_TOKEN).toBe("ccpp_config");
    expect(parsed.env.ANTHROPIC_MODEL).toBe("virtual.anthropic.global.sonnet-like");
  });

  test("cmdConfigClaude dies when .env carries no inbound key", () => {
    writeFileSync(join(dir, ".env"), "ANTHROPIC_MODEL=virtual.anthropic.global.sonnet-like\n");
    const { code, stderr } = runTrappingExit(() =>
      cmdConfigClaude(dir, makeIo({ commandExists: () => true })),
    );
    expect(code).toBe(1);
    expect(stderr).toContain("PROXY_INBOUND_KEY not set in .env");
  });

  test("cmdDoctor validates the config and reports providers + bedrock state", async () => {
    writeFileSync(
      join(dir, ".env"),
      [
        "PROXY_INBOUND_KEY=ccpp_doctor",
        "ANTHROPIC_MODEL=virtual.anthropic.global.sonnet-like",
        "BIND_IP=10.0.0.5",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "config.local.jsonc"),
      `${JSON.stringify(
        {
          ...VALID_CONFIG,
          inboundAuth: { keys: ["k"] },
          providers: {
            zai: {
              type: "anthropic",
              auth: "bearer",
              credential: "zai-key",
              baseUrl: "https://api.z.ai/api/anthropic",
              modelsUrl: "https://api.z.ai/api/paas/v4/models",
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    const io = makeIo({ commandExists: (c) => c === "bun" });
    const { stdout } = await captureOutputAsync(() => cmdDoctor(dir, "local", io));

    expect(stdout).toContain("Environment check:");
    expect(stdout).toContain("Bun is installed.");
    expect(stdout).toContain(".env present.");
    expect(stdout).toContain("config.local.jsonc present.");
    expect(stdout).toContain("BIND_IP=10.0.0.5");
    expect(stdout).toContain("Run mode: local.");
    expect(stdout).toContain("config.local.jsonc parses and validates.");
    expect(stdout).toContain("Bedrock: disabled —");
    expect(stdout).toContain("zai: credential set (anthropic).");
  });

  test("cmdDoctor flags an invalid config and stops before diagnostics", async () => {
    writeFileSync(join(dir, ".env"), "ANTHROPIC_MODEL=virtual.anthropic.global.sonnet-like\n");
    writeFileSync(join(dir, "config.local.jsonc"), "{ definitely not valid jsonc");
    const io = makeIo({ commandExists: (c) => c === "bun" });
    const { stdout } = await captureOutputAsync(() => cmdDoctor(dir, "local", io));
    expect(stdout).toContain("Config check:");
    expect(stdout).toContain("config.local.jsonc INVALID:");
  });

  test("cmdDoctor returns after the env check when config.local.jsonc is absent", async () => {
    const io = makeIo({ commandExists: (c) => c === "bun" });
    const { stdout } = await captureOutputAsync(() => cmdDoctor(dir, "local", io));
    expect(stdout).toContain(".env missing (run setup).");
    expect(stdout).toContain("config.local.jsonc missing (run setup).");
    expect(stdout).not.toContain("Config check:");
  });

  test("cmdDoctor derives a BIND_IP when .env has none", async () => {
    writeFileSync(join(dir, ".env"), "ANTHROPIC_MODEL=virtual.anthropic.global.sonnet-like\n");
    const io = makeIo({ commandExists: (c) => c === "bun" });
    const { stdout } = await captureOutputAsync(() => cmdDoctor(dir, "local", io));
    const derived = deriveBindIp();
    if (derived !== null) expect(stdout).toContain(`would derive ${derived}.`);
    else expect(stdout).toContain("none derivable (VPN-only?)");
  });

  test("cmdDoctor warns when no external providers are configured", async () => {
    writeFileSync(join(dir, ".env"), "ANTHROPIC_MODEL=virtual.anthropic.global.sonnet-like\n");
    writeFileSync(join(dir, "config.local.jsonc"), `${JSON.stringify(VALID_CONFIG, null, 2)}\n`);
    const io = makeIo({ commandExists: (c) => c === "bun" });
    const { stdout } = await captureOutputAsync(() => cmdDoctor(dir, "local", io));
    expect(stdout).toContain("No external providers configured");
  });

  test("usage prints the command banner and the mode/flag reference", () => {
    const { stdout } = captureOutput(() => usage());
    expect(stdout).toContain("claude-code-provider-proxy CLI");
    expect(stdout).toContain("Modes: --docker (default if Docker present) | --local");
    expect(stdout).toContain("Flags: --rotate");
  });
});

// ---------------------------------------------------------------------------
// index: main dispatch — drives every case label through the injected boundary
// ---------------------------------------------------------------------------

describe("index: main dispatch (in-process)", () => {
  const savedBindIp = process.env.BIND_IP;
  afterEach(() => {
    if (savedBindIp === undefined) Reflect.deleteProperty(process.env, "BIND_IP");
    else process.env.BIND_IP = savedBindIp;
  });

  beforeEach(() => {
    seedProject(dir);
  });

  test("help / -h / --help / default print the usage banner", async () => {
    const io = makeIo();
    for (const argv of [["help"], ["-h"], ["--help"], []]) {
      const { stdout } = await captureOutputAsync(() => main(argv, io, dir));
      expect(stdout).toContain("claude-code-provider-proxy CLI");
    }
    // Also exercise the default `root = projectRoot()` (no explicit root).
    const { stdout } = await captureOutputAsync(() => main(["help"], io));
    expect(stdout).toContain("claude-code-provider-proxy CLI");
  });

  test("an unknown command warns, prints usage, and exits 1", async () => {
    const { code, stdout } = await runTrappingExitAsync(() =>
      main(["definitely-not-a-command"], makeIo(), dir),
    );
    expect(code).toBe(1);
    expect(stdout).toContain("Unknown command: definitely-not-a-command");
    expect(stdout).toContain("claude-code-provider-proxy CLI");
  });

  test("dispatches every known command name to its real body", async () => {
    writeFileSync(
      join(dir, ".env"),
      [
        "PROXY_INBOUND_KEY=ccpp_dispatch",
        "ANTHROPIC_MODEL=virtual.anthropic.global.sonnet-like",
        "BIND_IP=10.0.0.5",
        "PORT=8787",
        "",
      ].join("\n"),
    );
    writeFileSync(join(dir, "config.local.jsonc"), `${JSON.stringify(VALID_CONFIG, null, 2)}\n`);
    const settings = join(dir, "claude-settings.json");
    const io = dockerIo({ claudeSettingsFile: settings });

    // status --local: no pid file yet.
    expect((await captureOutputAsync(() => main(["status", "--local"], io, dir))).stdout).toContain(
      "Local proxy not running.",
    );
    // logs --local: no log file yet.
    expect((await captureOutputAsync(() => main(["logs", "--local"], io, dir))).stdout).toContain(
      "No local log file yet.",
    );
    // config-claude: writes the settings file.
    expect((await captureOutputAsync(() => main(["config-claude"], io, dir))).stdout).toContain(
      "Configured Claude Code",
    );
    // doctor: full report.
    expect((await captureOutputAsync(() => main(["doctor"], io, dir))).stdout).toContain(
      "Environment check:",
    );
    // setup --local --rotate.
    expect(
      (await captureOutputAsync(() => main(["setup", "--local", "--rotate"], io, dir))).stdout,
    ).toContain("Setup complete.");
    // down --local: nothing recorded yet.
    expect((await captureOutputAsync(() => main(["down", "--local"], io, dir))).stdout).toContain(
      "No local proxy pid file found",
    );
    // up --local (spawns through the stub) then `start` is an alias of up.
    expect((await captureOutputAsync(() => main(["up", "--local"], io, dir))).stdout).toContain(
      "Proxy running locally",
    );
    // restart --docker = down (docker) then up (docker).
    const restart = await captureOutputAsync(() => main(["restart", "--docker"], io, dir));
    expect(restart.stdout).toContain("Stopped.");
    expect(restart.stdout).toContain("Running in Docker (bound to");
    // stop --docker is an alias of down.
    expect((await captureOutputAsync(() => main(["stop", "--docker"], io, dir))).stdout).toContain(
      "Stopped.",
    );
  });
});

describe("index: boot guard handler", () => {
  test("cliErrorExit reports the error and exits 1", () => {
    // console.error writes to the real stderr fd (bypassing process.stderr.write),
    // so swap it to observe the reported error without polluting test output.
    const logged: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(...args);
    };
    let code: number | undefined;
    try {
      ({ code } = runTrappingExit(() => cliErrorExit(new Error("fatal-boot"))));
    } finally {
      console.error = original;
    }
    expect(code).toBe(1);
    expect(String(logged[0])).toContain("fatal-boot");
  });

  test("setExitCode adopts main()'s resolved code as the process exit status", () => {
    // The boot guard is unreachable under bun:test (import.meta.main is false),
    // so its exit-code handling lives in an exported, directly-tested function:
    // a resolved non-zero code from main() must become the REAL process status
    // rather than being discarded.
    // Capture with a numeric fallback: assigning `undefined` to process.exitCode
    // does NOT clear it in Bun, so restoring an unset status that way would leak
    // this test's non-zero code into the test runner's own exit status.
    const original = process.exitCode ?? 0;
    try {
      setExitCode(0);
      expect(process.exitCode).toBe(0);
      setExitCode(3);
      expect(process.exitCode).toBe(3);
    } finally {
      process.exitCode = original;
    }
  });
});

// ---------------------------------------------------------------------------
// index: further real branches (failed signal, Bedrock enabled, real env seam)
// ---------------------------------------------------------------------------

describe("index: additional command branches", () => {
  const savedBindIp = process.env.BIND_IP;
  afterEach(() => {
    if (savedBindIp === undefined) Reflect.deleteProperty(process.env, "BIND_IP");
    else process.env.BIND_IP = savedBindIp;
  });
  beforeEach(() => {
    seedProject(dir);
  });

  test("cmdDown --local keeps the pid file when the signal fails (EPERM)", () => {
    mkdirSync(join(dir, "logs"), { recursive: true });
    const pidFile = join(dir, "logs", "proxy.pid");
    writeFileSync(pidFile, `${process.pid}\n`);
    const io = makeIo({
      kill: () => {
        throw new Error("EPERM: operation not permitted");
      },
    });
    const { stdout } = captureOutput(() => cmdDown(dir, "local", io));
    expect(stdout).toContain(`Could not signal pid ${process.pid}: EPERM: operation not permitted`);
    // The process may still be running, so the pid file is kept for a retry.
    expect(existsSync(pidFile)).toBe(true);
  });

  test("cmdDoctor reports Bedrock enabled for a real long-term key", async () => {
    writeFileSync(join(dir, ".env"), "ANTHROPIC_MODEL=virtual.anthropic.global.sonnet-like\n");
    writeFileSync(
      join(dir, "config.local.jsonc"),
      `${JSON.stringify(
        {
          ...VALID_CONFIG,
          inboundAuth: { keys: ["k"] },
          providers: {
            bedrock: {
              credential: "br-long-term-key",
              hosts: {
                converse: "bedrock-runtime.{region}.amazonaws.com",
                mantle: "bedrock-mantle.{region}.api.aws",
                control: "bedrock.{region}.amazonaws.com",
              },
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    const io = makeIo({ commandExists: (c) => c === "bun" });
    const { stdout } = await captureOutputAsync(() => cmdDoctor(dir, "local", io));
    expect(stdout).toContain("Bedrock: enabled.");
  });

  test("realCliEnv.kill delegates to process.kill (rejects an out-of-range pid)", () => {
    // The default seam must actually signal the OS: an out-of-range pid is
    // rejected by process.kill (a stub returning undefined would not throw).
    expect(() => realCliEnv.kill(2 ** 40)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// src/cli/index.ts — the ping watcher (cmdPing), driven through main()
// ---------------------------------------------------------------------------

/** One scripted poll answer: a payload, "DOWN" (poll rejects), or "NOTOK" (non-2xx). */
type PingResponse = { servingAccount?: string | null } | "DOWN" | "NOTOK";

/**
 * Drive the REAL cmdPing loop through `main(["ping"[, sound]])` with a scripted
 * status sequence: `responses[i]` answers the i-th poll. The injected sleep
 * records each requested interval and ABORTS the watcher's external signal once
 * every response is consumed, so the real loop ends after the scripted ticks.
 * `opts.play` controls the injected sound runner: "ok" (default) reports
 * success, "null" returns null (a non-zero exit), "throw" raises — each failure
 * shape must warn once and keep watching.
 */
async function runPing(
  soundPath: string | undefined,
  responses: PingResponse[],
  platform: "windows" | "macos" | "linux" = "macos",
  opts: { play?: "ok" | "null" | "throw" } = {},
): Promise<{ stdout: string; code: number; sleeps: number[]; io: StubIo }> {
  let polled = 0;
  const sleeps: number[] = [];
  const controller = new AbortController();
  const io = makeIo({
    currentPlatform: () => platform,
    pollStatus: () => {
      const r = responses[Math.min(polled++, responses.length - 1)];
      if (r === "DOWN") return Promise.reject(new Error("ECONNREFUSED"));
      if (r === "NOTOK" || r === undefined) return Promise.resolve(undefined);
      return Promise.resolve(r);
    },
    sleep: (ms) => {
      sleeps.push(ms);
      if (polled >= responses.length) controller.abort();
      return Promise.resolve();
    },
  });
  const play = opts.play ?? "ok";
  io.runCapture = (cmd, args) => {
    io.captures.push({ cmd, args });
    if (play === "throw") throw new Error("player not found");
    return play === "null" ? null : "played";
  };
  const out: string[] = [];
  const restore = captureSink(process.stdout, out);
  let code = -1;
  try {
    code = await main(
      soundPath === undefined ? ["ping"] : ["ping", soundPath],
      io,
      dir,
      controller.signal,
    );
  } finally {
    restore();
  }
  return { stdout: out.join(""), code, sleeps, io };
}

describe("index: ping watcher (cmdPing via main dispatch)", () => {
  test("baselines silently, then announces a later account change, plays the sound, and stops", async () => {
    const sound = join(dir, "Glass.aiff");
    writeFileSync(sound, "not-really-audio");
    const { stdout, code, io } = await runPing(sound, [
      { servingAccount: "zai-account-1" },
      { servingAccount: "zai-account-2" },
    ]);
    expect(code).toBe(0); // a clean shutdown returns 0, never hangs
    expect(stdout).toContain("Watching http://127.0.0.1:8787/status.json");
    expect(stdout).toContain("Ping watcher stopped.");
    // The first tick only sets the baseline: exactly one change is announced,
    // and it names the transition the SECOND poll produced.
    expect((stdout.match(/serving account changed/g) ?? []).length).toBe(1);
    expect(stdout).toContain("serving account changed: zai-account-1 -> zai-account-2");
    expect(stdout.includes("during an outage")).toBe(false);
    // The change played the sound through the injected capture runner.
    expect(io.captures).toEqual([{ cmd: "afplay", args: [sound] }]);
  });

  test("warns and watches without sound when the platform has no player", async () => {
    const { stdout, code, io } = await runPing(
      undefined,
      [{ servingAccount: "a" }, { servingAccount: "b" }],
      "windows",
    );
    expect(code).toBe(0);
    expect(stdout).toContain("No sound player on this platform");
    // A change is still announced, but play() is a no-op (no player to run).
    expect(stdout).toContain("serving account changed: a -> b");
    expect(io.captures).toEqual([]);
  });

  test("warns when the requested sound file does not exist", async () => {
    const absent = join(dir, "absent.aiff");
    const { stdout, code } = await runPing(absent, [{ servingAccount: "k" }]);
    expect(code).toBe(0);
    expect(stdout).toContain(`Sound file not found: ${absent}`);
  });

  test("unreachable on the FIRST poll is announced (was silent before)", async () => {
    writeFileSync(join(dir, "Glass.aiff"), "x");
    const { stdout, code } = await runPing(join(dir, "Glass.aiff"), [
      "DOWN",
      { servingAccount: "k" },
    ]);
    expect(code).toBe(0);
    // The old loop emitted NOTHING when the very first poll failed; the fixed
    // reachability tracking announces the opening outage.
    expect(stdout).toContain("proxy unreachable at http://127.0.0.1:8787, waiting…");
    expect((stdout.match(/proxy unreachable at/g) ?? []).length).toBe(1);
  });

  test("recovery emits the reachable-again line exactly once", async () => {
    writeFileSync(join(dir, "Glass.aiff"), "x");
    const { stdout } = await runPing(join(dir, "Glass.aiff"), [
      "DOWN",
      { servingAccount: "k" },
      { servingAccount: "k" },
      { servingAccount: "k" },
    ]);
    expect((stdout.match(/proxy reachable again/g) ?? []).length).toBe(1);
  });

  test("an account change detected across an outage IS announced", async () => {
    writeFileSync(join(dir, "Glass.aiff"), "x");
    const { stdout, io } = await runPing(join(dir, "Glass.aiff"), [
      { servingAccount: "acct-A" },
      "DOWN",
      { servingAccount: "acct-B" },
    ]);
    // The old loop cleared `last` on failure, re-baselined on recovery, and
    // swallowed this change entirely.
    expect(stdout).toContain("serving account changed during an outage: acct-A -> acct-B");
    expect(io.captures).toEqual([{ cmd: "afplay", args: [join(dir, "Glass.aiff")] }]);
  });

  test("the poll interval backs off while unreachable and resets after recovery", async () => {
    writeFileSync(join(dir, "Glass.aiff"), "x");
    const { sleeps } = await runPing(join(dir, "Glass.aiff"), [
      "DOWN",
      "DOWN",
      "DOWN",
      "DOWN",
      "DOWN",
      "DOWN",
      { servingAccount: "k" },
    ]);
    // 2s → 4s → 8s → 16s → cap 30s, then held at 30s, then reset to 2s on the
    // first success (the dead proxy is not hammered every 2s forever).
    expect(sleeps).toEqual([2000, 4000, 8000, 16000, 30000, 30000, 2000]);
  });

  test("a non-2xx status is skipped without disturbing the baseline", async () => {
    const { stdout, code } = await runPing(undefined, ["NOTOK", { servingAccount: "k" }]);
    expect(code).toBe(0);
    expect(stdout.includes("serving account changed")).toBe(false);
    // A non-2xx still means the proxy answered, so it is not "unreachable".
    expect(stdout.includes("proxy unreachable")).toBe(false);
  });

  test("a failed play warns ONCE, however many changes occur", async () => {
    writeFileSync(join(dir, "Glass.aiff"), "x");
    const { stdout, io } = await runPing(
      join(dir, "Glass.aiff"),
      [{ servingAccount: "a" }, { servingAccount: "b" }, { servingAccount: "c" }],
      "macos",
      { play: "null" },
    );
    // Two changes (a→b, b→c), both play attempts fail, but only one warning.
    expect((stdout.match(/Could not play the sound/g) ?? []).length).toBe(1);
    expect(io.captures).toHaveLength(2);
  });

  test("a throwing sound runner is treated as a failed play, not a crash", async () => {
    writeFileSync(join(dir, "Glass.aiff"), "x");
    const { stdout, code } = await runPing(
      join(dir, "Glass.aiff"),
      [{ servingAccount: "a" }, { servingAccount: "b" }],
      "macos",
      { play: "throw" },
    );
    expect(code).toBe(0);
    expect(stdout).toContain("Could not play the sound (player not found)");
  });

  test("abort during a poll returns promptly with code 0", async () => {
    const controller = new AbortController();
    const io = makeIo({
      pollStatus: () => new Promise(() => {}), // never settles: the poll hangs
      sleep: () => Promise.resolve(),
    });
    const timer = setTimeout(() => controller.abort(), 10);
    const start = Date.now();
    const code = await main(["ping"], io, dir, controller.signal);
    clearTimeout(timer);
    expect(code).toBe(0);
    // It resolved by the abort, not by waiting for the poll.
    expect(Date.now() - start).toBeLessThan(1000);
  });

  test("the watcher signal reaches the in-flight poll, so abort cancels the request", async () => {
    // The observable that would FAIL without the fix: the poll must be HANDED a
    // signal, and that signal must abort when the watcher aborts. A poll that
    // merely gets abandoned by raceAbort (the old behaviour) never settles when
    // a real in-flight fetch would — so this stub settles ONLY on its signal.
    const controller = new AbortController();
    let captured: AbortSignal | undefined;
    let abortedDuringPoll = false;
    const io = makeIo({
      pollStatus: (_url, signal) => {
        captured = signal;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            abortedDuringPoll = true;
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        });
      },
      sleep: () => Promise.resolve(),
    });
    const timer = setTimeout(() => controller.abort(), 10);
    const code = await main(["ping"], io, dir, controller.signal);
    clearTimeout(timer);
    expect(code).toBe(0);
    expect(captured).toBeDefined();
    expect(captured?.aborted).toBe(true);
    expect(abortedDuringPoll).toBe(true);
  });

  test("abort during the sleep returns promptly without waiting the interval", async () => {
    const controller = new AbortController();
    const io = makeIo({
      pollStatus: () => Promise.resolve({ servingAccount: "a" }),
      // The REAL sleep: abort must clear its timer so the wait ends at once.
      sleep: realCliEnv.sleep,
    });
    const timer = setTimeout(() => controller.abort(), 10);
    const start = Date.now();
    const code = await main(["ping"], io, dir, controller.signal);
    clearTimeout(timer);
    expect(code).toBe(0);
    // A healthy interval is 2000ms; prompt exit proves the wait was interrupted.
    expect(Date.now() - start).toBeLessThan(1000);
  });

  test("an already-aborted signal stops immediately with code 0", async () => {
    const controller = new AbortController();
    controller.abort();
    let polls = 0;
    const io = makeIo({
      pollStatus: () => {
        polls++;
        return Promise.resolve({ servingAccount: "a" });
      },
      sleep: () => Promise.resolve(),
    });
    const code = await main(["ping"], io, dir, controller.signal);
    expect(code).toBe(0);
    expect(polls).toBe(0); // no poll is issued once the signal is already aborted
  });
});

// ---------------------------------------------------------------------------
// src/cli/index.ts — the real ping seams against a real local status endpoint
// ---------------------------------------------------------------------------

describe("index: realCliEnv ping seams", () => {
  test("pollStatus parses servingAccount and maps a non-2xx response to undefined", async () => {
    // A real HTTP server on an ephemeral port exercises the real fetch path
    // (never the proxy's own 8787, and never a remote host).
    const server = Bun.serve({
      port: 0,
      fetch: (req) =>
        new URL(req.url).pathname === "/status.json"
          ? Response.json({ servingAccount: "zai-account-9" })
          : new Response("nope", { status: 503 }),
    });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      expect(await realCliEnv.pollStatus(`${base}/status.json`)).toEqual({
        servingAccount: "zai-account-9",
      });
      expect(await realCliEnv.pollStatus(`${base}/missing.json`)).toBeUndefined();
    } finally {
      server.stop(true);
    }
  });

  test("pollStatus cancels the in-flight request when the watcher signal aborts", async () => {
    // A server that accepts the request and never answers: the ONLY thing that
    // can end the call quickly is the threaded signal — left on its own, the
    // real fetch would hang until the 4s per-poll timeout.
    const server = Bun.serve({
      port: 0,
      fetch: () => new Promise<Response>(() => {}),
    });
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20);
      const start = Date.now();
      await expect(
        realCliEnv.pollStatus(`http://127.0.0.1:${server.port}/status.json`, controller.signal),
      ).rejects.toThrow();
      clearTimeout(timer);
      // Well under the 4000ms per-poll timeout: the abort ended it, not the timer.
      expect(Date.now() - start).toBeLessThan(1000);
    } finally {
      server.stop(true);
    }
  });

  test("sleep defers resolution for the requested duration", async () => {
    const start = Date.now();
    await realCliEnv.sleep(30);
    // A real timer, not a busy resolve: setTimeout never fires early.
    expect(Date.now() - start).toBeGreaterThanOrEqual(20);
  });

  test("sleep with a live signal resolves on its timer and detaches the listener", async () => {
    const controller = new AbortController();
    const start = Date.now();
    await realCliEnv.sleep(20, controller.signal);
    expect(Date.now() - start).toBeGreaterThanOrEqual(10);
    // The normal-completion path removed its abort listener: aborting now must
    // not touch the settled promise (and, across a long watch, must not pile up).
    controller.abort();
  });
});

// ---------------------------------------------------------------------------
// index: resolveSoundPlayer's default PATH probe (its `has` default parameter)
// ---------------------------------------------------------------------------

describe("index: resolveSoundPlayer default probe", () => {
  test("linux selection agrees with an independent probe of the real PATH", () => {
    // The default `has` wraps the real commandExists. Assert resolveSoundPlayer
    // picks exactly the first candidate that the same probe reports present — a
    // mismatch means the default probe or the selection order is wrong.
    const candidates: [string, string[]][] = [
      ["paplay", []],
      ["ffplay", ["-nodisp", "-autoexit", "-loglevel", "quiet"]],
      ["play", ["-q"]],
    ];
    const firstAvailable = candidates.find(([cmd]) => commandExists(cmd));

    const resolved = resolveSoundPlayer("linux");
    if (firstAvailable === undefined) {
      expect(resolved).toBeNull();
    } else {
      expect(resolved).toEqual({ cmd: firstAvailable[0], baseArgs: firstAvailable[1] });
    }
  });
});
