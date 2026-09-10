/**
 * Serving-account-change alert (docs/VIRTUAL_MODELS.md observability) —
 * hermetic unit tests over the real tracker: BEL + warn line on account
 * change, silence on same-account/first-serving/disabled, config round-trip.
 */
import { describe, expect, test } from "bun:test";
import { validateConfig } from "../src/config.ts";
import { buildRegistrySnapshot } from "../src/http/registry-page.ts";
import { currentServingKey, noteServing, resetServingAlert } from "../src/logging/serving-alert.ts";
import { Catalog } from "../src/model/catalog.ts";

/** Capture console emissions (log + raw stdout writes) during fn(). */
async function capture(
  fn: () => void | Promise<void>,
): Promise<{ logs: string[]; stdout: string }> {
  const logs: string[] = [];
  let stdout = "";
  const origLog = console.log;
  const origWarn = console.warn;
  const origErr = console.error;
  const origWrite = process.stdout.write.bind(process.stdout);
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.warn = console.log as unknown as typeof console.warn;
  console.error = console.log as unknown as typeof console.error;
  process.stdout.write = ((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origErr;
    process.stdout.write = origWrite;
  }
  return { logs, stdout };
}

const ON = { servingChangePing: true };
const OFF = { servingChangePing: false };

describe("noteServing (account-change alert)", () => {
  test("first serving records but does NOT ping", async () => {
    resetServingAlert();
    const { logs, stdout } = await capture(() =>
      noteServing(ON, "zai", "primary", "zai.anthropic.global.glm-5.3"),
    );
    expect(stdout).toBe("");
    expect(logs.some((l) => l.includes("SERVING ACCOUNT CHANGED"))).toBe(false);
    expect(currentServingKey()).toBe("zai/primary");
  });

  test("same account again does NOT ping", async () => {
    resetServingAlert();
    noteServing(ON, "zai", "primary", "zai.anthropic.global.glm-5.3");
    const { logs, stdout } = await capture(() =>
      noteServing(ON, "zai", "primary", "zai.anthropic.global.glm-5.3-flash"),
    );
    expect(stdout).toBe("");
    expect(logs.some((l) => l.includes("SERVING ACCOUNT CHANGED"))).toBe(false);
  });

  test("account change pings: BEL byte + marked warn line naming from/to", async () => {
    resetServingAlert();
    noteServing(ON, "zai", "primary", "zai.anthropic.global.glm-5.3");
    const { logs, stdout } = await capture(() =>
      noteServing(ON, "zai", "secondary", "zai.anthropic.global.glm-5.3"),
    );
    expect(stdout).toBe(String.fromCharCode(7));
    const line = logs.find((l) => l.includes("SERVING ACCOUNT CHANGED"));
    expect(line).toContain("from=zai/primary");
    expect(line).toContain("to=zai/secondary");
  });

  test("provider shift (no label) also pings, keyed by provider alone", async () => {
    resetServingAlert();
    noteServing(ON, "zai", "secondary", "zai.anthropic.global.glm-5.3");
    const { logs, stdout } = await capture(() =>
      noteServing(ON, "bedrock", undefined, "bedrock.mantle.us.zai.glm-5"),
    );
    expect(stdout).toBe(String.fromCharCode(7));
    expect(logs.find((l) => l.includes("SERVING ACCOUNT CHANGED"))).toContain("to=bedrock");
  });

  test("disabled via config: no ping, and no tracking", async () => {
    resetServingAlert();
    noteServing(OFF, "zai", "primary", "zai.anthropic.global.glm-5.3");
    const { logs, stdout } = await capture(() =>
      noteServing(OFF, "alibaba", "default", "alibaba.anthropic.ap-southeast-1.qwen3-max"),
    );
    expect(stdout).toBe("");
    expect(logs.some((l) => l.includes("SERVING ACCOUNT CHANGED"))).toBe(false);
    expect(currentServingKey()).toBeNull();
    resetServingAlert();
  });
});

describe("servingChangePing config", () => {
  const BASE = {
    server: { host: "127.0.0.1", port: 8787 },
    inboundAuth: { keys: ["k"] },
    primaryRegion: "us",
    profilePreference: "global",
    refreshIntervalMinutes: 60,
    claudeFallbackToMantle: false,
    regions: [{ key: "us", awsRegion: "us-east-1" }],
    providers: {},
  };

  test("defaults to false; true round-trips through validation", () => {
    expect(validateConfig(BASE).servingChangePing).toBe(false);
    expect(validateConfig({ ...BASE, servingChangePing: true }).servingChangePing).toBe(true);
  });
});

describe("servingAccount on /status.json", () => {
  const cfg = (ping: boolean) =>
    validateConfig({
      server: { host: "127.0.0.1", port: 8787 },
      inboundAuth: { keys: ["k"] },
      primaryRegion: "us",
      profilePreference: "global",
      refreshIntervalMinutes: 60,
      claudeFallbackToMantle: false,
      regions: [{ key: "us", awsRegion: "us-east-1" }],
      providers: {},
      ...(ping ? { servingChangePing: true } : {}),
    });

  test("reflects the tracked serving account (labels only)", () => {
    resetServingAlert();
    noteServing(ON, "zai", "secondary", "zai.anthropic.global.glm-5.3");
    const snap = buildRegistrySnapshot(cfg(true), new Catalog([], []));
    expect(snap.servingAccount).toBe("zai/secondary");
    resetServingAlert();
  });

  test("null when the feature is off or nothing served yet", () => {
    resetServingAlert();
    expect(buildRegistrySnapshot(cfg(true), new Catalog([], [])).servingAccount).toBeNull();
    noteServing(ON, "zai", "primary", "zai.anthropic.global.glm-5.3");
    expect(buildRegistrySnapshot(cfg(false), new Catalog([], [])).servingAccount).toBeNull();
    resetServingAlert();
  });
});
