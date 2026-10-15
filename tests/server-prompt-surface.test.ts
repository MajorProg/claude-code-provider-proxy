/**
 * Production prompt-surface wiring (hermetic) — drives createFetchHandler with a
 * REAL inline LogStore and a REAL captured Converse fixture, mocking only the
 * outbound fetch boundary.
 *
 * This is the regression guard for the gap where the production dispatch path
 * fingerprinted only the SYSTEM prompt: `computePromptSurface` handled tools +
 * injected blocks, but no production caller invoked it with them, so a tool's
 * input_schema (names unchanged) or an injected `<system-reminder>` block change
 * produced an IDENTICAL prompt version. These tests assert the dispatch path now
 * feeds the full instruction surface through, so:
 *   - the stored tools_json carries the tools' schemas (not "[]"),
 *   - the stored injected_json carries the extracted instruction envelopes,
 *   - a tool-schema change with a stable name yields a NEW prompt version,
 *   - an injected-block change yields a NEW prompt version.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ProxyConfig, validateConfig } from "../src/config.ts";
import { LogStore } from "../src/logging/log-store.ts";
import { Catalog, type DiscoveredModel } from "../src/model/catalog.ts";
import { type Runtime, createFetchHandler } from "../src/server.ts";
import { installFetchMock, readFixtureText } from "./helpers/fetch-mock.ts";

const KEY = "ccpp-surface-key";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ccpp-prompt-surface-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// A real Converse model (on-demand, bare id) so route() resolves without profiles.
const novaModel: DiscoveredModel = {
  provider: "bedrock",
  awsRegion: "us-east-1",
  regionKey: "us",
  backend: "converse",
  nativeModelId: "amazon.nova-lite-v1:0",
  isAnthropic: false,
  supportsOnDemand: true,
  profiles: [],
  streaming: true,
};

const CID = "bedrock.converse.us.amazon.nova-lite-v1:0";
const SESSION = "sess-prompt-surface";

/** A config whose logging is ENABLED and writes into the test's temp dir. */
function makeConfig(): ProxyConfig {
  return validateConfig({
    server: { host: "127.0.0.1", port: 8787 },
    inboundAuth: { keys: [KEY] },
    primaryRegion: "us",
    profilePreference: "global",
    refreshIntervalMinutes: 60,
    claudeFallbackToMantle: false,
    regions: [{ key: "us", awsRegion: "us-east-1" }],
    providers: {
      bedrock: {
        credential: "long-term-secret",
        hosts: {
          converse: "bedrock-runtime.{region}.amazonaws.com",
          mantle: "bedrock-mantle.{region}.api.aws",
          control: "bedrock.{region}.amazonaws.com",
        },
      },
    },
    logging: { enabled: true, dir: root, systemDir: "system", sessionDir: "sessions" },
    chatPage: { enabled: true },
  });
}

function makeRuntime(config: ProxyConfig, store: LogStore): Runtime {
  const catalog = new Catalog([novaModel]);
  return {
    config,
    tokenProvider: async () => "test-bearer",
    catalogManager: { current: () => catalog, stop: () => {} },
    logStore: store,
  } as unknown as Runtime;
}

function post(body: unknown): Request {
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: {
      authorization: `Bearer ${KEY}`,
      "content-type": "application/json",
      "x-claude-code-session-id": SESSION,
    },
    body: JSON.stringify(body),
  });
}

/** Poll until at least `n` turns for `sessionId` are durable (capture is detached). */
async function waitForTurns(store: LogStore, sessionId: string, n: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    await store.flush();
    if ((await store.listTurns(sessionId)).length >= n) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${n} turns in ${sessionId}`);
}

/** A request body whose ONLY varying parts are the ones under test. */
function requestBody(over: {
  toolSchemaType?: string;
  reminderText?: string;
}): Record<string, unknown> {
  return {
    model: CID,
    max_tokens: 64,
    system: "You are a careful engineer.",
    messages: [
      {
        role: "user",
        content: `<system-reminder>${over.reminderText ?? "Project rule: never force-push."}</system-reminder>\n\nShip it.`,
      },
    ],
    tools: [
      {
        name: "read_file",
        description: "Read a file",
        input_schema: {
          type: "object",
          properties: { path: { type: over.toolSchemaType ?? "string" } },
          required: ["path"],
        },
      },
    ],
  };
}

describe("production dispatch fingerprints the FULL instruction surface", () => {
  test("tools_json carries the tool schemas and injected_json the envelopes", async () => {
    const store = new LogStore(makeConfig().logging, { writerMode: "inline" });
    const handler = createFetchHandler(
      () => makeRuntime(makeConfig(), store),
      async () => undefined,
    );
    const mock = installFetchMock({ text: readFixtureText("converse-text.json") });
    try {
      const res = await handler(post(requestBody({})));
      expect(res.status).toBe(200);
      await waitForTurns(store, SESSION, 1);

      const versions = await store.listPromptVersions();
      expect(versions).toHaveLength(1);
      const v = versions[0];
      expect(v).toBeDefined();
      // The gap: tools_json was ALWAYS "[]" because no caller passed tools through.
      expect(v?.toolsJson).not.toBe("[]");
      expect(v?.toolsJson).toContain("read_file");
      expect(v?.toolsJson).toContain("input_schema");
      // The gap: injected_json was ALWAYS "[]" because no caller passed messages.
      expect(v?.injectedJson).not.toBe("[]");
      expect(v?.injectedJson).toContain("Project rule: never force-push.");

      // The turn links to the full-surface version.
      const turns = await store.listTurns(SESSION);
      expect(turns[0]?.promptVersion).toBe(v?.hash ?? null);
      await store.close();
    } finally {
      mock.restore();
    }
  });

  test("a tool-schema change (name unchanged) yields a NEW prompt version", async () => {
    const store = new LogStore(makeConfig().logging, { writerMode: "inline" });
    const handler = createFetchHandler(
      () => makeRuntime(makeConfig(), store),
      async () => undefined,
    );
    const mock = installFetchMock({ text: readFixtureText("converse-text.json") });
    try {
      expect((await handler(post(requestBody({ toolSchemaType: "string" })))).status).toBe(200);
      await waitForTurns(store, SESSION, 1);
      expect((await handler(post(requestBody({ toolSchemaType: "number" })))).status).toBe(200);
      await waitForTurns(store, SESSION, 2);

      const versions = await store.listPromptVersions();
      // Same system prompt + same tool NAME, different input_schema → 2 versions.
      expect(versions).toHaveLength(2);
      const hashes = new Set(versions.map((v) => v.hash));
      expect(hashes.size).toBe(2);

      const turns = await store.listTurns(SESSION);
      expect(turns).toHaveLength(2);
      expect(turns[0]?.promptVersion).not.toBe(turns[1]?.promptVersion);
      await store.close();
    } finally {
      mock.restore();
    }
  });

  test("an injected instruction block change yields a NEW prompt version", async () => {
    const store = new LogStore(makeConfig().logging, { writerMode: "inline" });
    const handler = createFetchHandler(
      () => makeRuntime(makeConfig(), store),
      async () => undefined,
    );
    const mock = installFetchMock({ text: readFixtureText("converse-text.json") });
    try {
      expect((await handler(post(requestBody({ reminderText: "Rule A." })))).status).toBe(200);
      await waitForTurns(store, SESSION, 1);
      expect((await handler(post(requestBody({ reminderText: "Rule B." })))).status).toBe(200);
      await waitForTurns(store, SESSION, 2);

      const versions = await store.listPromptVersions();
      expect(versions).toHaveLength(2);
      const injected = versions.map((v) => v.injectedJson).sort();
      expect(injected[0]).toContain("Rule A.");
      expect(injected[1]).toContain("Rule B.");
      await store.close();
    } finally {
      mock.restore();
    }
  });
});
