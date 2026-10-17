/**
 * Modular capture: the prompt library and chat-turn capture are independent.
 *
 * `logging.capture.systemPrompts` records the deduped instruction surface;
 * `logging.capture.chatTurns` records per-turn index rows and body files. With
 * chat turns off (the default) a request leaves NO per-turn trace on disk, but
 * the prompt library still grows when system-prompt capture is on.
 *
 * Hermetic: temp directories only, never the repo `./logs`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoggingConfig } from "../src/config.ts";
import { LogStore } from "../src/logging/log-store.ts";
import type { TurnRecord } from "../src/logging/log-types.ts";
import { computePromptSurface } from "../src/logging/prompt-surface.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ccpp-logging-modules-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function logConfig(over: Partial<LoggingConfig> = {}): LoggingConfig {
  return {
    enabled: true,
    dir: root,
    systemDir: "system",
    sessionDir: "sessions",
    captureTimeoutMs: 120_000,
    compression: { enabled: true, minAgeMinutes: 10 },
    capture: { systemPrompts: true, chatTurns: false },
    retentionDays: 30,
    maxTurnBytes: 8 * 1024 * 1024,
    inFlightBudgetBytes: 256 * 1024 * 1024,
    indexFlushMs: 60_000,
    zstdLevel: 3,
    ...over,
  };
}

function store(over: Partial<LoggingConfig> = {}): LogStore {
  return new LogStore(logConfig(over), { writerMode: "inline" });
}

function turn(sessionId: string, over: Partial<TurnRecord> = {}): TurnRecord {
  return {
    sessionId,
    canonicalModel: "bedrock.converse.global.model-x",
    invocationModel: "model-x",
    backend: "converse",
    translationPath: "converse",
    streamed: false,
    systemHash: null,
    messages: [{ role: "user", content: "hello" }],
    responseContent: [{ type: "text", text: "hi" }],
    stopReason: "end_turn",
    usage: { inputTokens: 10, outputTokens: 5 },
    requestedAt: "2026-09-12T10:00:00.000Z",
    respondedAt: "2026-09-12T10:00:01.000Z",
    ...over,
  };
}

const surface = computePromptSurface({
  system: "You are helpful.",
  tools: [{ name: "read", description: "read a file", input_schema: { type: "object" } }],
  messages: [{ role: "user", content: "hi" }],
});

describe("capture module gating", () => {
  test("captureActive reflects the switches; every module is master-gated by enabled", () => {
    expect(store().captureActive()).toBe(true);
    expect(store().capturesPrompts()).toBe(true);
    expect(store().capturesTurns()).toBe(false);

    const promptsOff = store({ capture: { systemPrompts: false, chatTurns: true } });
    expect(promptsOff.captureActive()).toBe(true);
    expect(promptsOff.capturesPrompts()).toBe(false);
    expect(promptsOff.capturesTurns()).toBe(true);

    const allOff = store({ capture: { systemPrompts: false, chatTurns: false } });
    expect(allOff.captureActive()).toBe(false);

    const disabled = store({ enabled: false });
    expect(disabled.captureActive()).toBe(false);
    expect(disabled.capturesPrompts()).toBe(false);
    expect(disabled.capturesTurns()).toBe(false);
  });

  test("stop() turns every capture module off", async () => {
    const s = store();
    expect(s.capturesPrompts()).toBe(true);
    s.stop();
    expect(s.isEnabled()).toBe(false);
    expect(s.captureActive()).toBe(false);
    expect(s.capturesPrompts()).toBe(false);
    expect(s.capturesTurns()).toBe(false);
    await s.close();
  });
});

describe("chat turns off (the default), system prompts on", () => {
  test("recordTurn is a no-op: no index row, no body file, no session", async () => {
    const s = store();
    await s.recordTurn(turn("s1"));
    await s.flush();

    expect(await s.listSessions()).toEqual([]);
    expect(await s.listTurns("s1")).toEqual([]);
    expect(await s.getTurnBody("s1", 1)).toBeNull();
    await s.close();
  });

  test("recordPromptSurface records the deduped prompt version", async () => {
    const s = store();
    s.recordPromptSurface(surface);
    await s.flush();

    const versions = await s.listPromptVersions();
    expect(versions).toHaveLength(1);
    expect(versions[0]?.hash).toBe(surface.hash);
    expect(versions[0]?.seenCount).toBe(1);

    const full = await s.getPromptVersion(surface.hash);
    expect(full?.systemJson).toBe(surface.systemJson);
    expect(full?.toolsJson).toBe(surface.toolsJson);
    await s.close();
  });

  test("a repeated sighting advances seenCount without a second stored copy", async () => {
    const s = store();
    s.recordPromptSurface(surface);
    s.recordPromptSurface(surface);
    s.recordPromptSurface(surface);
    await s.flush();

    const versions = await s.listPromptVersions();
    expect(versions).toHaveLength(1);
    expect(versions[0]?.seenCount).toBe(3);
    await s.close();
  });

  test("recordPromptSurface is a no-op when prompt capture is off", async () => {
    const s = store({ capture: { systemPrompts: false, chatTurns: false } });
    s.recordPromptSurface(surface);
    await s.flush();
    expect(await s.listPromptVersions()).toEqual([]);
    await s.close();
  });
});

describe("system prompts off, chat turns on", () => {
  test("the turn is recorded but carries no prompt-version link or version row", async () => {
    const s = store({ capture: { systemPrompts: false, chatTurns: true } });
    await s.recordTurn(turn("s1", { promptSurface: surface }));
    await s.flush();

    const turns = await s.listTurns("s1");
    expect(turns).toHaveLength(1);
    expect(turns[0]?.promptVersion).toBeNull();
    expect(await s.listPromptVersions()).toEqual([]);
    await s.close();
  });

  test("recordSystemPrompt returns null so no system hash is attached", async () => {
    const s = store({ capture: { systemPrompts: false, chatTurns: true } });
    expect(await s.recordSystemPrompt("You are helpful.")).toBeNull();
    await s.close();
  });
});

describe("system prompts on, chat turns on", () => {
  test("a turn persists its surface as a prompt version", async () => {
    const s = store({ capture: { systemPrompts: true, chatTurns: true } });
    await s.recordTurn(turn("s1", { promptSurface: surface }));
    await s.flush();

    const turns = await s.listTurns("s1");
    expect(turns[0]?.promptVersion).toBe(surface.hash);
    expect((await s.listPromptVersions())[0]?.hash).toBe(surface.hash);
    await s.close();
  });
});
