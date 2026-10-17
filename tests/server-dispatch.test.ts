/**
 * Full server dispatch round-trip (hermetic) — drives createFetchHandler with a
 * REAL catalog + REAL fixtures, mocking only the outbound fetch boundary.
 *
 * This exercises the end-to-end glue that the path-level fixture tests don't:
 * inbound auth -> parse-once -> canonical-id parse -> route() -> translation
 * handler -> Response, for POST /v1/messages and /v1/messages/count_tokens, plus
 * GET /v1/models. It complements management-auth.test.ts (auth/CSRF matrix) and
 * paths-fixture.test.ts (per-handler translation).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ProxyConfig, validateConfig } from "../src/config.ts";
import { renderLogViewerHtml } from "../src/http/log-viewer-page.ts";
import { LogStore } from "../src/logging/log-store.ts";
import type { TurnRecord } from "../src/logging/log-types.ts";
import { logger } from "../src/logging/logger.ts";
import { computePromptSurface } from "../src/logging/prompt-surface.ts";
import { Catalog, type DiscoveredModel } from "../src/model/catalog.ts";
import {
  EXPORT_YIELD_INTERVAL,
  type Runtime,
  createFetchHandler,
  errorResponse,
} from "../src/server.ts";
import { installFetchMock, readFixtureText } from "./helpers/fetch-mock.ts";

const KEY = "ccpp-dispatch-key";

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
    logging: { enabled: false, dir: "./logs", systemDir: "system", sessionDir: "sessions" },
    chatPage: { enabled: true },
  });
}

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

function makeRuntime(config: ProxyConfig): Runtime {
  const catalog = new Catalog([novaModel]);
  const runtime = {
    config,
    tokenProvider: async () => "test-bearer",
    catalogManager: { current: () => catalog, stop: () => {} },
    logStore: { isEnabled: () => false, captureActive: () => false },
  };
  return runtime as unknown as Runtime;
}

function handler() {
  const config = makeConfig();
  const runtime = makeRuntime(config);
  return createFetchHandler(
    () => runtime,
    async () => undefined,
  );
}

function post(path: string, body: unknown, key = KEY): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const CID = "bedrock.converse.us.amazon.nova-lite-v1:0";

describe("POST /v1/messages end-to-end (Converse via fixture)", () => {
  test("authenticated request translates a Converse response to an Anthropic message", async () => {
    const mock = installFetchMock({ text: readFixtureText("converse-text.json") });
    try {
      const res = await handler()(
        post("/v1/messages", {
          model: CID,
          max_tokens: 64,
          messages: [{ role: "user", content: "hi" }],
        }),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json.type).toBe("message");
      expect(json.role).toBe("assistant");
      const content = json.content as Array<{ type: string; text?: string }>;
      expect(content[0]?.text).toBe("Hello fixture");
      // The outbound call went to the converse endpoint with a Bearer token.
      expect(mock.requests[0]?.url).toContain("/converse");
      expect(mock.requests[0]?.headers.authorization).toBe("Bearer test-bearer");
    } finally {
      mock.restore();
    }
  });

  test("SEC-1: an oversized inbound body is rejected with 413 (before parse)", async () => {
    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${KEY}`,
        "content-type": "application/json",
        "content-length": String(50 * 1024 * 1024), // 50 MiB > 25 MiB cap
      },
      body: JSON.stringify({
        model: CID,
        max_tokens: 8,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    const res = await handler()(req);
    expect(res.status).toBe(413);
    const json = (await res.json()) as { type: string; error?: { type: string } };
    expect(json.type).toBe("error");
    // Anthropic's own 413 type — the ONE 413 shape every surface now shares.
    expect(json.error?.type).toBe("request_too_large");
  });

  test("missing inbound key -> 401 (no upstream call)", async () => {
    const mock = installFetchMock({ text: "{}" });
    try {
      const res = await handler()(
        new Request("http://localhost/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: CID, messages: [] }),
        }),
      );
      expect(res.status).toBe(401);
      expect(mock.requests).toHaveLength(0);
    } finally {
      mock.restore();
    }
  });

  test("a non-object body -> 400 (trust-boundary parse)", async () => {
    const mock = installFetchMock({ text: "{}" });
    try {
      const res = await handler()(
        new Request("http://localhost/v1/messages", {
          method: "POST",
          headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
          body: '"not an object"',
        }),
      );
      expect(res.status).toBe(400);
      expect(mock.requests).toHaveLength(0);
    } finally {
      mock.restore();
    }
  });

  test("an unknown model id -> error status, no successful message", async () => {
    const mock = installFetchMock({ text: "{}" });
    try {
      const res = await handler()(
        post("/v1/messages", {
          model: "bedrock.converse.us.does.not-exist",
          messages: [{ role: "user", content: "hi" }],
        }),
      );
      expect(res.status).toBeGreaterThanOrEqual(400);
    } finally {
      mock.restore();
    }
  });

  test("relays an upstream 500 as an error (Converse)", async () => {
    const mock = installFetchMock({ status: 500, text: "upstream boom" });
    try {
      const res = await handler()(
        post("/v1/messages", {
          model: CID,
          max_tokens: 64,
          messages: [{ role: "user", content: "hi" }],
        }),
      );
      expect(res.status).toBeGreaterThanOrEqual(500);
    } finally {
      mock.restore();
    }
  });
});

describe("GET /v1/models", () => {
  test("lists the discovered model with its canonical id (no auth required)", async () => {
    const res = await handler()(new Request("http://localhost/v1/models", { method: "GET" }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data?: Array<{ id: string }> };
    const ids = (json.data ?? []).map((m) => m.id);
    expect(ids.some((id) => id.includes("nova-lite"))).toBe(true);
  });
});

describe("errorResponse SEC-7 (generic message + stable id for unexpected errors)", () => {
  test("does NOT leak a raw Error.message for a non-ProxyError; returns a reference id", async () => {
    const secret = "connect ECONNREFUSED 10.0.0.5:5432 (internal db)";
    const res = errorResponse(new Error(secret));
    expect(res.status).toBe(500);
    const json = (await res.json()) as { type: string; error: { type: string; message: string } };
    expect(json.type).toBe("error");
    expect(json.error.type).toBe("api_error");
    // The internal detail must NOT appear in the client body.
    expect(json.error.message).not.toContain(secret);
    expect(json.error.message).not.toContain("ECONNREFUSED");
    expect(json.error.message).not.toContain("10.0.0.5");
    // A stable correlation id IS present so the operator can find it in logs.
    expect(json.error.message).toMatch(/reference: [0-9a-f-]{36}/);
  });

  test("still surfaces a ProxyError's own (safe) message", async () => {
    const { BadRequestError } = await import("../src/errors.ts");
    const res = errorResponse(new BadRequestError("messages must be an array"));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toBe("messages must be an array");
  });
});

describe("GET /v1/models + /api/config/status with virtual tiers & pools", () => {
  const POOL_KEY_PRIMARY = "zai-pool-primary-abcdef123456";
  const POOL_KEY_SECONDARY = "zai-pool-secondary-abcdef123456";

  function tieredRuntime(): Runtime {
    const config = validateConfig({
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
        zai: {
          type: "anthropic",
          credentials: [
            { credential: POOL_KEY_PRIMARY, label: "primary" },
            { credential: POOL_KEY_SECONDARY, label: "secondary" },
          ],
          auth: "bearer",
          baseUrl: "https://api.z.ai/api/anthropic",
          countTokens: true,
          modelsUrl: "https://api.z.ai/api/paas/v4/models",
        },
      },
      virtualModels: {
        "sonnet-like": [
          "zai.anthropic.global.glm-5.3",
          "bedrock.converse.us.amazon.nova-lite-v1:0",
        ],
      },
      logging: { enabled: false },
      chatPage: { enabled: true },
    });
    return makeRuntime(config);
  }

  function tieredHandler() {
    const runtime = tieredRuntime();
    return createFetchHandler(
      () => runtime,
      async () => undefined,
    );
  }

  test("/v1/models lists the virtual id with aliasOf naming the current resolution", async () => {
    const res = await tieredHandler()(new Request("http://localhost/v1/models", { method: "GET" }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data?: Array<{ id: string; aliasOf?: string | null }> };
    const entry = (json.data ?? []).find((m) => m.id === "virtual.anthropic.global.sonnet-like");
    expect(entry).toBeDefined();
    expect(entry?.aliasOf).toBe("zai.anthropic.global.glm-5.3");
  });

  test("/api/config/status exposes virtualTiers + pool LABELS, never key values", async () => {
    const res = await tieredHandler()(
      new Request("http://localhost/api/config/status", {
        headers: { authorization: `Bearer ${KEY}` },
      }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    const json = JSON.parse(text) as {
      virtualTiers?: Array<{ name: string; resolution: string | null }>;
      external?: Array<{ key: string; credentialPool?: { labels: string[]; primary: string } }>;
    };
    expect(json.virtualTiers?.[0]?.name).toBe("sonnet-like");
    expect(json.virtualTiers?.[0]?.resolution).toBe("zai.anthropic.global.glm-5.3");
    const zai = (json.external ?? []).find((e) => e.key === "zai");
    expect(zai?.credentialPool?.labels).toEqual(["primary", "secondary"]);
    expect(zai?.credentialPool?.primary).toBe("primary");
    // PUBLIC-surface hygiene even on the auth-gated status: no key material.
    expect(text.includes(POOL_KEY_PRIMARY)).toBe(false);
    expect(text.includes(POOL_KEY_SECONDARY)).toBe(false);
  });
});

/* ==================================================================== *
 * HTTP-surface behaviours (Workstream C): path-consistent max_tokens,
 * log-route traversal + malformed-escape hardening, single-row reads,
 * event-loop yields, and the viewer's messagesOmitted notice.
 * ==================================================================== */

describe("POST /v1/messages requires max_tokens on EVERY path (C6)", () => {
  // The canonical id need not resolve to a catalog model for the 400 cases:
  // the check fires before routing/inference. The count_tokens success case
  // uses a Claude-on-mantle id (Path P passthrough has a count endpoint).
  const paths: Array<{ label: string; cid: string }> = [
    { label: "converse", cid: CID },
    { label: "mantle", cid: "bedrock.mantle.us.some.mantle-model" },
    { label: "passthrough (Claude on mantle)", cid: "bedrock.mantle.us.anthropic.claude-sonnet" },
  ];

  for (const { label, cid } of paths) {
    test(`an absent max_tokens is a 400 on the ${label} path`, async () => {
      const mock = installFetchMock({ text: "{}" });
      try {
        const res = await handler()(
          post("/v1/messages", { model: cid, messages: [{ role: "user", content: "hi" }] }),
        );
        expect(res.status).toBe(400);
        const json = (await res.json()) as { error: { type: string; message: string } };
        expect(json.error.type).toBe("invalid_request_error");
        expect(json.error.message).toContain("max_tokens");
        // Rejected before any upstream call.
        expect(mock.requests).toHaveLength(0);
      } finally {
        mock.restore();
      }
    });
  }

  test("count_tokens still accepts a body WITHOUT max_tokens", async () => {
    const mock = installFetchMock({ text: readFixtureText("anthropic-count.json") });
    try {
      const res = await handler()(
        post("/v1/messages/count_tokens", {
          model: "bedrock.mantle.us.anthropic.claude-sonnet",
          messages: [{ role: "user", content: "count me" }],
        }),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as { input_tokens: number };
      expect(json.input_tokens).toBe(19);
    } finally {
      mock.restore();
    }
  });
});

describe("log routes: traversal, malformed escapes, single-row reads, yields", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ccpp-server-dispatch-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** A config whose logging is ENABLED and writes into the test's temp dir. */
  function logsConfig(): ProxyConfig {
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
      logging: {
        enabled: true,
        dir: root,
        systemDir: "system",
        sessionDir: "sessions",
        capture: { systemPrompts: true, chatTurns: true },
      },
      chatPage: { enabled: true },
    });
  }

  function logsStore(): LogStore {
    return new LogStore(logsConfig().logging, { writerMode: "inline" });
  }

  function logsHandler(store: LogStore) {
    const config = logsConfig();
    const catalog = new Catalog([novaModel]);
    const runtime = {
      config,
      tokenProvider: async () => "test-bearer",
      catalogManager: { current: () => catalog, stop: () => {} },
      logStore: store,
    } as unknown as Runtime;
    return createFetchHandler(
      () => runtime,
      async () => undefined,
    );
  }

  function turnRecord(sessionId: string, at: string): TurnRecord {
    return {
      sessionId,
      canonicalModel: CID,
      invocationModel: "amazon.nova-lite-v1:0",
      backend: "converse",
      translationPath: "converse",
      streamed: false,
      systemHash: null,
      messages: [{ role: "user", content: "hello" }],
      responseContent: [{ type: "text", text: "hi" }],
      stopReason: "end_turn",
      usage: { inputTokens: 5, outputTokens: 2 },
      requestedAt: at,
      respondedAt: at,
    };
  }

  function authedGet(path: string): Request {
    return new Request(`http://localhost${path}`, {
      headers: { authorization: `Bearer ${KEY}` },
    });
  }

  /** Walk a STORE-method ZIP's local file headers into { name, content }. */
  function zipEntries(zip: Uint8Array): Array<{ name: string; content: string }> {
    const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const decoder = new TextDecoder();
    const out: Array<{ name: string; content: string }> = [];
    let pos = 0;
    while (pos + 30 <= zip.length && dv.getUint32(pos, true) === 0x04034b50) {
      const dataLen = dv.getUint32(pos + 18, true);
      const nameLen = dv.getUint16(pos + 26, true);
      const extraLen = dv.getUint16(pos + 28, true);
      const nameStart = pos + 30;
      const name = decoder.decode(zip.subarray(nameStart, nameStart + nameLen));
      const dataStart = nameStart + nameLen + extraLen;
      const content = decoder.decode(zip.subarray(dataStart, dataStart + dataLen));
      out.push({ name, content });
      pos = dataStart + dataLen;
    }
    return out;
  }

  test("C2: a malformed percent-escape session path is a 404 and logs nothing at error level", async () => {
    const store = logsStore();
    const handlerFn = logsHandler(store);
    const originalError = logger.error;
    let errorLogs = 0;
    logger.error = () => {
      errorLogs++;
    };
    try {
      const res = await handlerFn(authedGet("/api/logs/sessions/%"));
      expect(res.status).toBe(404);
    } finally {
      logger.error = originalError;
      await store.close();
    }
    // A route miss must never reach the error renderer's error-level line.
    expect(errorLogs).toBe(0);
  });

  test("C3: the one-turn detail route returns { meta, body } and 404s when both are absent", async () => {
    const store = logsStore();
    await store.recordTurn(turnRecord("sess-1", "2026-10-01T10:00:00.000Z"));
    await store.flush();
    const handlerFn = logsHandler(store);
    try {
      const ok = await handlerFn(authedGet("/api/logs/sessions/sess-1/1"));
      expect(ok.status).toBe(200);
      const json = (await ok.json()) as { meta: { seq: number } | null; body: unknown };
      expect(json.meta?.seq).toBe(1);
      expect(json.body).not.toBeNull();

      const missing = await handlerFn(authedGet("/api/logs/sessions/sess-1/99"));
      expect(missing.status).toBe(404);
    } finally {
      await store.close();
    }
  });

  test("C1: a session id with ../ yields NO traversal entry name in the export ZIP", async () => {
    const store = logsStore();
    await store.recordTurn(turnRecord("../../evil", "2026-10-01T10:00:00.000Z"));
    await store.flush();
    const handlerFn = logsHandler(store);
    try {
      const res = await handlerFn(authedGet("/api/logs/export/sessions"));
      expect(res.status).toBe(200);
      const names = zipEntries(new Uint8Array(await res.arrayBuffer())).map((e) => e.name);
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) {
        expect(name.startsWith("/")).toBe(false);
        expect(name.split("/")).not.toContain("..");
      }
    } finally {
      await store.close();
    }
  });

  test("C0: the system export carries each version's FULL content, not just metadata", async () => {
    const store = logsStore();
    const surface = computePromptSurface({
      system: "You are terse.",
      tools: [{ name: "Read", input_schema: { type: "object", properties: {} } }],
      messages: [],
    });
    await store.recordTurn({
      ...turnRecord("sess-1", "2026-10-01T10:00:00.000Z"),
      promptSurface: surface,
    });
    await store.flush();
    const handlerFn = logsHandler(store);
    try {
      const res = await handlerFn(authedGet("/api/logs/export/system"));
      expect(res.status).toBe(200);
      const entries = zipEntries(new Uint8Array(await res.arrayBuffer()));
      const entry = entries.find((e) => e.name === `prompts/${surface.hash}.json`);
      expect(entry).toBeDefined();
      const rec = JSON.parse(entry?.content ?? "{}") as {
        systemJson?: string;
        toolsJson?: string;
        injectedJson?: string;
      };
      // listPromptVersions is metadata-only; the export must still resolve content.
      expect(rec.systemJson).toEqual(surface.systemJson);
      expect(rec.toolsJson).toContain("Read");
      expect(rec.injectedJson).toBeDefined();
    } finally {
      await store.close();
    }
  });

  test("C4: a multi-entry export yields to the event loop every EXPORT_YIELD_INTERVAL entries", async () => {
    const store = logsStore();
    const count = EXPORT_YIELD_INTERVAL * 3;
    for (let i = 0; i < count; i++) {
      await store.recordTurn(turnRecord("bulk", "2026-10-01T10:00:00.000Z"));
    }
    await store.flush();
    const handlerFn = logsHandler(store);

    const originalSetImmediate = globalThis.setImmediate;
    let yields = 0;
    globalThis.setImmediate = ((...args: Parameters<typeof originalSetImmediate>) => {
      yields++;
      return originalSetImmediate(...args);
    }) as typeof originalSetImmediate;
    try {
      const res = await handlerFn(authedGet("/api/logs/export/sessions"));
      expect(res.status).toBe(200);
    } finally {
      globalThis.setImmediate = originalSetImmediate;
      await store.close();
    }
    // One yield per full interval of entries (count entries -> count/interval).
    expect(yields).toBeGreaterThanOrEqual(Math.floor(count / EXPORT_YIELD_INTERVAL));
  });

  test("C8: the viewer renders a messagesOmitted notice (escaped) instead of an empty list", () => {
    const html = renderLogViewerHtml(true);
    expect(html).toContain("Request messages omitted:");
    expect(html).toContain("body.messagesOmitted");
    expect(html).toContain("window.esc(o.inboundBytes)");
    expect(html).toContain("window.esc(o.limitBytes)");
  });
});
