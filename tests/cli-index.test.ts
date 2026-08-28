/**
 * CLI index.ts pure-seam tests (hermetic; temp files, no process spawns).
 *
 * Covers argument parsing, env-derived helpers, and local-mode pid/path logic.
 * The spawn/orchestration functions (cmdUp/localUp/compose/…) are intentionally
 * not unit-tested here — they shell out to bun/docker and are covered by the
 * live/manual run modes.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeModels,
  localPaths,
  parseArgs,
  pidAlive,
  portValue,
  readPid,
  resolveBindIp,
} from "../src/cli/index.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccpp-cli-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("parseArgs", () => {
  test("defaults to the help command with no mode/rotate", () => {
    expect(parseArgs([])).toEqual({ command: "help", mode: undefined, rotate: false });
  });

  test("first positional is the command; --local/--docker set mode; --rotate flag", () => {
    expect(parseArgs(["up", "--local"])).toEqual({
      command: "up",
      mode: "local",
      rotate: false,
    });
    expect(parseArgs(["setup", "--docker", "--rotate"])).toEqual({
      command: "setup",
      mode: "docker",
      rotate: true,
    });
  });

  test("later mode flag wins; extra positionals are ignored", () => {
    expect(parseArgs(["status", "--local", "--docker", "extra"])).toEqual({
      command: "status",
      mode: "docker",
      rotate: false,
    });
  });

  test("unknown dash-flags are ignored (not treated as the command)", () => {
    expect(parseArgs(["--rotate", "restart"])).toEqual({
      command: "restart",
      mode: undefined,
      rotate: true,
    });
  });
});

describe("portValue", () => {
  test("returns PORT from .env when set", () => {
    const env = join(dir, ".env");
    writeFileSync(env, "PORT=9999\n");
    expect(portValue(env)).toBe("9999");
  });

  test("falls back to the default when PORT is unset/empty", () => {
    const env = join(dir, ".env");
    writeFileSync(env, "OTHER=1\n");
    expect(portValue(env)).toBe("8787");
    // Missing file -> default too.
    expect(portValue(join(dir, "nope.env"))).toBe("8787");
  });
});

describe("claudeModels", () => {
  test("reads both model ids from .env (trimmed)", () => {
    const env = join(dir, ".env");
    writeFileSync(
      env,
      "ANTHROPIC_MODEL= bedrock.converse.global.anthropic.claude-x \nANTHROPIC_SMALL_FAST_MODEL=bedrock.mantle.us.qwen.q\n",
    );
    expect(claudeModels(env)).toEqual({
      mainModel: "bedrock.converse.global.anthropic.claude-x",
      fastModel: "bedrock.mantle.us.qwen.q",
      sonnetModel: "bedrock.converse.global.anthropic.claude-x",
      haikuModel: "bedrock.mantle.us.qwen.q",
      maxContextTokens: undefined,
    });
  });

  test("sonnetModel/haikuModel use ANTHROPIC_DEFAULT_SONNET_MODEL / _HAIKU_MODEL when set", () => {
    const env = join(dir, ".env");
    writeFileSync(
      env,
      [
        "ANTHROPIC_MODEL=bedrock.converse.global.anthropic.claude-x",
        "ANTHROPIC_SMALL_FAST_MODEL=bedrock.mantle.us.qwen.q",
        "ANTHROPIC_DEFAULT_SONNET_MODEL= bedrock.mantle.eu.anthropic.claude-sonnet-5 ",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL=bedrock.mantle.eu.anthropic.claude-haiku-4-5",
        "",
      ].join("\n"),
    );
    expect(claudeModels(env)).toEqual({
      mainModel: "bedrock.converse.global.anthropic.claude-x",
      fastModel: "bedrock.mantle.us.qwen.q",
      sonnetModel: "bedrock.mantle.eu.anthropic.claude-sonnet-5",
      haikuModel: "bedrock.mantle.eu.anthropic.claude-haiku-4-5",
      maxContextTokens: undefined,
    });
  });

  test("reads CLAUDE_CODE_MAX_CONTEXT_TOKENS when set (trimmed)", () => {
    const env = join(dir, ".env");
    writeFileSync(
      env,
      [
        "ANTHROPIC_MODEL=zai.anthropic.global.glm-5.3",
        "ANTHROPIC_SMALL_FAST_MODEL=zai.anthropic.global.glm-5.3-flash",
        "CLAUDE_CODE_MAX_CONTEXT_TOKENS= 1000000 ",
        "",
      ].join("\n"),
    );
    expect(claudeModels(env).maxContextTokens).toBe("1000000");
  });

  test("maxContextTokens is undefined when the key is absent or blank", () => {
    const env = join(dir, ".env");
    writeFileSync(
      env,
      [
        "ANTHROPIC_MODEL=zai.anthropic.global.glm-5.3",
        "ANTHROPIC_SMALL_FAST_MODEL=zai.anthropic.global.glm-5.3-flash",
        "CLAUDE_CODE_MAX_CONTEXT_TOKENS=",
        "",
      ].join("\n"),
    );
    expect(claudeModels(env).maxContextTokens).toBeUndefined();
  });
});

describe("resolveBindIp", () => {
  const saved = process.env.BIND_IP;
  afterEach(() => {
    if (saved === undefined) Reflect.deleteProperty(process.env, "BIND_IP");
    else process.env.BIND_IP = saved;
  });

  test("an existing .env BIND_IP is returned AND mirrored into process.env", () => {
    // Regression: a first-run setup wrote BIND_IP to .env but never exported it,
    // so the docker-compose child (which interpolates ${BIND_IP} from the env)
    // failed until a second run. resolveBindIp must populate process.env too.
    const envPath = join(dir, ".env");
    writeFileSync(envPath, "BIND_IP=192.168.1.50\nPORT=8787\n");
    Reflect.deleteProperty(process.env, "BIND_IP");

    const result = resolveBindIp(envPath);

    expect(result).toBe("192.168.1.50");
    expect(process.env.BIND_IP).toBe("192.168.1.50");
  });

  test("trims surrounding whitespace before exporting", () => {
    const envPath = join(dir, ".env");
    writeFileSync(envPath, "BIND_IP=  10.0.0.7  \n");
    Reflect.deleteProperty(process.env, "BIND_IP");

    expect(resolveBindIp(envPath)).toBe("10.0.0.7");
    expect(process.env.BIND_IP).toBe("10.0.0.7");
  });
});

describe("localPaths", () => {
  test("derives pid/log/logDir under <root>/logs", () => {
    const p = localPaths("/srv/app");
    expect(p.logDir).toBe(join("/srv/app", "logs"));
    expect(p.pid).toBe(join("/srv/app", "logs", "proxy.pid"));
    expect(p.log).toBe(join("/srv/app", "logs", "proxy.local.log"));
  });
});

describe("readPid", () => {
  test("returns null when the pid file is absent", () => {
    expect(readPid(join(dir, "proxy.pid"))).toBeNull();
  });

  test("parses a positive integer pid", () => {
    const f = join(dir, "proxy.pid");
    writeFileSync(f, "12345\n");
    expect(readPid(f)).toBe(12345);
  });

  test("rejects non-positive / non-integer contents", () => {
    const f = join(dir, "proxy.pid");
    writeFileSync(f, "not-a-number");
    expect(readPid(f)).toBeNull();
    writeFileSync(f, "0");
    expect(readPid(f)).toBeNull();
    writeFileSync(f, "-9");
    expect(readPid(f)).toBeNull();
  });
});

describe("pidAlive", () => {
  test("the current process is alive", () => {
    expect(pidAlive(process.pid)).toBe(true);
  });

  test("an unused high pid is not alive", () => {
    // 2^30-ish pid that won't exist; process.kill(pid,0) -> ESRCH.
    expect(pidAlive(1_073_741_823)).toBe(false);
  });
});
