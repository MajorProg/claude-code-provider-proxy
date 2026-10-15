/**
 * Coverage closure for src/server.ts.
 *
 * Everything here drives the REAL request handler (createFetchHandler) or a
 * real exported helper with real inputs, asserting on real status codes and
 * response bodies. The only stub is the outbound HTTP boundary (installFetchMock,
 * replaying captured fixtures) plus the documented Runtime seam — the same
 * approach tests/server-dispatch.test.ts and tests/server-disabled-bedrock.test.ts
 * use. No line is coloured green without exercising its branch.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ProxyConfig, validateConfig } from "../src/config.ts";
import { ProviderCooldownError } from "../src/errors.ts";
import { CredentialCooldownStore } from "../src/failover.ts";
import { LogStore } from "../src/logging/log-store.ts";
import type { TurnMeta, TurnRecord } from "../src/logging/log-types.ts";
import { computePromptSurface } from "../src/logging/prompt-surface.ts";
import { Catalog, type DiscoveredModel } from "../src/model/catalog.ts";
import { type Runtime, buildRuntime, createFetchHandler, errorResponse } from "../src/server.ts";
import { installFetchMock, readFixtureText } from "./helpers/fetch-mock.ts";

const KEY = "ccpp-server-coverage-key";
const BASE = "http://localhost";

/** A disabled store stub for routes that never touch logging. */
const DISABLED_STORE = { isEnabled: () => false } as unknown as LogStore;

/** The base raw config, extended by each case. Bedrock enabled (long-term key). */
function rawConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    server: { host: "127.0.0.1", port: 8787 },
    inboundAuth: { keys: [KEY] },
    primaryRegion: "us",
    profilePreference: "global",
    refreshIntervalMinutes: 60,
    claudeFallbackToMantle: false,
    regions: [{ key: "us", awsRegion: "us-east-1" }],
    providers: {
      bedrock: {
        credential: "long-term-key",
        hosts: {
          converse: "bedrock-runtime.{region}.amazonaws.com",
          mantle: "bedrock-mantle.{region}.api.aws",
          control: "bedrock.{region}.amazonaws.com",
        },
      },
    },
    logging: { enabled: false },
    chatPage: { enabled: true },
    ...overrides,
  };
}

/** A real Converse model (on-demand, bare id) for catalog-sensitive routing. */
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

function runtimeFor(
  config: ProxyConfig,
  catalog: Catalog,
  logStore: LogStore,
  tokenProvider: Runtime["tokenProvider"] = async () => "test-bearer",
  cooldownStore = new CredentialCooldownStore(),
): Runtime {
  const runtime = {
    config,
    tokenProvider,
    catalogManager: { current: () => catalog, stop: () => {} },
    logStore,
    cooldownStore,
  };
  return runtime as unknown as Runtime;
}

function handlerFor(runtime: Runtime) {
  return createFetchHandler(
    () => runtime,
    async () => undefined,
  );
}

function get(path: string, key = KEY): Request {
  return new Request(`${BASE}${path}`, {
    headers: key === "" ? {} : { authorization: `Bearer ${key}` },
  });
}

function post(path: string, body: unknown, key = KEY, extra: Record<string, string> = {}): Request {
  return new Request(`${BASE}${path}`, {
    method: "POST",
    headers: {
      ...(key === "" ? {} : { authorization: `Bearer ${key}` }),
      "content-type": "application/json",
      ...extra,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/* ==================================================================== *
 * Route table: matchers, method mismatches, HTML shells, auth gates.
 * ==================================================================== */

describe("ROUTES table: shells, matchers and auth gates", () => {
  function h(): (req: Request) => Promise<Response> {
    return handlerFor(runtimeFor(validateConfig(rawConfig()), new Catalog([]), DISABLED_STORE));
  }

  test("Every public HTML shell serves 200 with a CSP + nosniff header", async () => {
    for (const path of ["/", "/status", "/config", "/logs", "/providers", "/chat"]) {
      const res = await h()(get(path, ""));
      expect(res.status, `GET ${path}`).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    }
  });

  test("the chat shell is registered ONLY when chatPage.enabled (else 404)", async () => {
    const enabled = handlerFor(
      runtimeFor(validateConfig(rawConfig()), new Catalog([]), DISABLED_STORE),
    );
    expect((await enabled(get("/chat", ""))).status).toBe(200);

    const disabled = handlerFor(
      runtimeFor(
        validateConfig(rawConfig({ chatPage: { enabled: false } })),
        new Catalog([]),
        DISABLED_STORE,
      ),
    );
    expect((await disabled(get("/chat", ""))).status).toBe(404);
  });

  test("a method mismatch and an unknown path both fall through to 404", async () => {
    // GET on a POST-only inference route.
    const res = await h()(get("/v1/messages", ""));
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: { type: string; message: string } };
    expect(json.error.type).toBe("not_found_error");
    expect(json.error.message).toBe("Unknown route");
    expect((await h()(get("/nope", ""))).status).toBe(404);
  });

  test("HEAD /api/hello is a 204 connection-warming probe", async () => {
    const res = await h()(new Request(`${BASE}/api/hello`, { method: "HEAD" }));
    expect(res.status).toBe(204);
  });

  test("management GET requires the key; the CSRF-less POST is rejected", async () => {
    expect((await h()(get("/api/config", ""))).status).toBe(401);
    expect((await h()(get("/api/config"))).status).toBe(200);
    const noCsrf = await h()(post("/api/config", {}, KEY));
    expect(noCsrf.status).toBe(401);
  });
});

/* ==================================================================== *
 * errorResponse branches.
 * ==================================================================== */

describe("errorResponse", () => {
  test("a client disconnect renders the benign 499 body (never a stack)", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const res = errorResponse(abort, { requestId: "req-1", method: "POST", path: "/v1/messages" });
    expect(res.status).toBe(499);
    const json = (await res.json()) as { error: { type: string; message: string } };
    expect(json.error.type).toBe("api_error");
    expect(json.error.message).toBe("Client closed request");
  });

  test("a ProxyError with responseHeaders() surfaces them (Retry-After on 429)", async () => {
    const res = errorResponse(new ProviderCooldownError(["zai"], 12_000));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("12");
    const json = (await res.json()) as { error: { type: string } };
    expect(json.error.type).toBe("rate_limit_error");
  });

  test("a ProxyError with NO responseHeaders() renders a plain status", async () => {
    const { BadRequestError } = await import("../src/errors.ts");
    const res = errorResponse(new BadRequestError("bad"));
    expect(res.status).toBe(400);
    expect(res.headers.get("retry-after")).toBeNull();
  });
});

/* ==================================================================== *
 * POST /v1/messages guards + the mantle translation path.
 * ==================================================================== */

describe("POST /v1/messages: model/max_tokens guards and the mantle path", () => {
  test("a body without a string `model` is a 400", async () => {
    const h = handlerFor(runtimeFor(validateConfig(rawConfig()), new Catalog([]), DISABLED_STORE));
    const mock = installFetchMock({ text: "{}" });
    try {
      const res = await h(
        post("/v1/messages", { max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
      );
      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: { message: string } };
      expect(json.error.message).toContain("model");
      expect(mock.requests).toHaveLength(0);
    } finally {
      mock.restore();
    }
  });

  test("a bedrock target with a null tokenProvider is a clean 404", async () => {
    // Config says Bedrock is enabled (long-term key) so route() resolves the
    // target, but the runtime carries no token provider — the defense-in-depth
    // branch in resolveOutboundAuth must answer, not crash.
    const h = handlerFor(
      runtimeFor(
        validateConfig(rawConfig()),
        new Catalog([novaModel]),
        DISABLED_STORE,
        null, // tokenProvider
      ),
    );
    const mock = installFetchMock({ text: "{}" });
    try {
      const res = await h(
        post("/v1/messages", {
          model: "bedrock.converse.us.amazon.nova-lite-v1:0",
          max_tokens: 16,
          messages: [{ role: "user", content: "hi" }],
        }),
      );
      expect(res.status).toBe(404);
      const json = (await res.json()) as { error: { message: string } };
      expect(json.error.message).toContain("bedrock");
      expect(mock.requests).toHaveLength(0);
    } finally {
      mock.restore();
    }
  });

  test("an external openai provider routes down the mantle path (Path M)", async () => {
    const config = validateConfig(
      rawConfig({
        providers: {
          mistral: {
            type: "openai",
            credential: "sk-mistral-secret",
            auth: "bearer",
            baseUrl: "https://api.mistral.ai/v1",
            modelsUrl: "https://api.mistral.ai/v1/models",
          },
        },
      }),
    );
    const h = handlerFor(runtimeFor(config, new Catalog([]), DISABLED_STORE));
    const mock = installFetchMock({ text: readFixtureText("openai-text.json") });
    try {
      const res = await h(
        post("/v1/messages", {
          model: "mistral.openai.global.mistral-small-latest",
          max_tokens: 64,
          messages: [{ role: "user", content: "Reply with exactly: hello fixture" }],
        }),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as { type: string; content: Array<{ text?: string }> };
      expect(json.type).toBe("message");
      // The outbound call hit the OpenAI chat-completions route with the bearer.
      expect(mock.requests[0]?.url).toContain("/chat/completions");
      expect(mock.requests[0]?.headers.authorization).toBe("Bearer sk-mistral-secret");
    } finally {
      mock.restore();
    }
  });
});

/* ==================================================================== *
 * POST /api/chat: disabled flag + captured capture path.
 * ==================================================================== */

describe("POST /api/chat", () => {
  const MANTLE_PROVIDERS = {
    mistral: {
      type: "openai",
      credential: "sk-mistral-secret",
      auth: "bearer",
      baseUrl: "https://api.mistral.ai/v1",
      modelsUrl: "https://api.mistral.ai/v1/models",
    },
  };
  const CSRF = { "x-ccpp-csrf": "1" };

  test("chat page disabled -> 404 from the dispatcher", async () => {
    const config = validateConfig(
      rawConfig({ providers: MANTLE_PROVIDERS, chatPage: { enabled: false } }),
    );
    const h = handlerFor(runtimeFor(config, new Catalog([]), DISABLED_STORE));
    const res = await h(
      post("/api/chat", { model: "mistral.openai.global.x", messages: [] }, KEY, CSRF),
    );
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("chat page disabled");
  });

  test("chat page enabled + capture on records the turn and still answers 200", async () => {
    let root: string;
    root = mkdtempSync(join(tmpdir(), "ccpp-server-cov-chat-"));
    const config = validateConfig(
      rawConfig({
        providers: MANTLE_PROVIDERS,
        logging: { enabled: true, dir: root, systemDir: "system", sessionDir: "sessions" },
      }),
    );
    const store = new LogStore(config.logging, { writerMode: "inline" });
    const h = handlerFor(runtimeFor(config, new Catalog([]), store));
    const mock = installFetchMock({ text: readFixtureText("openai-text.json") });
    try {
      const res = await h(
        post(
          "/api/chat",
          {
            model: "mistral.openai.global.mistral-small-latest",
            system: "You are a helpful assistant.",
            messages: [{ role: "user", content: "hi" }],
          },
          KEY,
          CSRF,
        ),
      );
      expect(res.status).toBe(200);
      await store.flush();
      // The captured turn landed (capture is transparent to the client response).
      const sessions = await store.listSessions();
      expect(sessions.some((s) => s.id === "chat-ui")).toBe(true);
    } finally {
      mock.restore();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/* ==================================================================== *
 * describeAuth (GET /api/config/auth) — the dev-sigv4 branch.
 * ==================================================================== */

describe("GET /api/config/auth: dev-sigv4 metadata (never the token)", () => {
  test("dev credential + AWS env mints metadata, never the token value", async () => {
    const prevKey = process.env.AWS_ACCESS_KEY_ID;
    const prevSecret = process.env.AWS_SECRET_ACCESS_KEY;
    process.env.AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
    process.env.AWS_SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    try {
      const config = validateConfig(
        rawConfig({
          providers: {
            bedrock: {
              credential: "dev",
              hosts: {
                converse: "bedrock-runtime.{region}.amazonaws.com",
                mantle: "bedrock-mantle.{region}.api.aws",
                control: "bedrock.{region}.amazonaws.com",
              },
            },
          },
        }),
      );
      const h = handlerFor(runtimeFor(config, new Catalog([]), DISABLED_STORE));
      const res = await h(get("/api/config/auth"));
      expect(res.status).toBe(200);
      const text = await res.text();
      const json = JSON.parse(text) as {
        bedrock: { mode: string; tokenAvailable?: boolean; awsPresent?: Record<string, boolean> };
      };
      expect(json.bedrock.mode).toBe("dev-sigv4");
      expect(json.bedrock.tokenAvailable).toBe(true);
      expect(json.bedrock.awsPresent?.AWS_ACCESS_KEY_ID).toBe(true);
      // Metadata only — the minted short-lived token never appears.
      expect(text.includes("bedrock-api-key-")).toBe(false);
    } finally {
      // Restore by empty string rather than the `delete` operator: `""` is
      // falsy, so every consumer here (Boolean()/truthiness cred checks) treats
      // it as absent, and it avoids the noDelete lint error.
      process.env.AWS_ACCESS_KEY_ID = prevKey ?? "";
      process.env.AWS_SECRET_ACCESS_KEY = prevSecret ?? "";
    }
  });
});

/* ==================================================================== *
 * buildRuntime — disabled (external-only) and enabled (discovery) paths.
 * ==================================================================== */

describe("buildRuntime", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ccpp-server-cov-runtime-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("Bedrock disabled -> no discovery client, empty catalog, fresh cooldown store", async () => {
    const config = validateConfig(
      rawConfig({
        providers: {},
        logging: { enabled: false, dir: root },
      }),
    );
    const runtime = await buildRuntime(config);
    try {
      expect(runtime.tokenProvider).toBeNull();
      expect(runtime.catalogManager.current().models).toEqual([]);
      expect(runtime.cooldownStore).toBeInstanceOf(CredentialCooldownStore);
    } finally {
      runtime.catalogManager.stop();
    }
  });

  test("Bedrock enabled + an existing cooldown store is carried across the rebuild", async () => {
    const config = validateConfig(
      rawConfig({
        providers: {
          bedrock: {
            credential: "long-term-key",
            hosts: {
              converse: "bedrock-runtime.{region}.amazonaws.com",
              mantle: "bedrock-mantle.{region}.api.aws",
              control: "bedrock.{region}.amazonaws.com",
            },
          },
        },
        logging: { enabled: false, dir: root },
      }),
    );
    const existing = new CredentialCooldownStore();
    // Discovery is mocked at the HTTP boundary; the region call returns no models.
    const mock = installFetchMock({ json: {} });
    let runtime: Runtime | undefined;
    try {
      runtime = await buildRuntime(config, existing);
      expect(runtime.cooldownStore).toBe(existing);
      // Bedrock is enabled so a token provider was constructed.
      expect(runtime.tokenProvider).not.toBeNull();
      // The empty discovery still produced a per-region source status.
      const sources = runtime.catalogManager.current().sources.map((s) => s.source);
      expect(sources).toContain("bedrock:us");
    } finally {
      mock.restore();
      runtime?.catalogManager.stop();
    }
  });
});

/* ==================================================================== *
 * The log observability routes — real SQLite index, real exports.
 * ==================================================================== */

describe("log routes", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ccpp-server-cov-logs-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function logsConfig(): ProxyConfig {
    return validateConfig(
      rawConfig({
        logging: { enabled: true, dir: root, systemDir: "system", sessionDir: "sessions" },
      }),
    );
  }

  function turn(sessionId: string, at: string): TurnRecord {
    return {
      sessionId,
      canonicalModel: "bedrock.converse.us.amazon.nova-lite-v1:0",
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

  test("prompt library, session listings and range exports all read the index", async () => {
    const config = logsConfig();
    const store = new LogStore(config.logging, { writerMode: "inline" });
    const surface = computePromptSurface({
      system: "You are terse.",
      tools: [{ name: "Read", input_schema: { type: "object", properties: {} } }],
      messages: [],
    });
    await store.recordTurn({ ...turn("sess-A", new Date().toISOString()), promptSurface: surface });
    await store.recordTurn(turn("sess-A", new Date().toISOString()));
    await store.flush();

    const h = handlerFor(runtimeFor(config, new Catalog([novaModel]), store));
    try {
      // GET /api/logs/system — the version listing joined with stats.
      const list = await h(get("/api/logs/system"));
      expect(list.status).toBe(200);
      const listJson = (await list.json()) as {
        data: Array<{ hash: string; stats: { turns: number } }>;
      };
      const entry = listJson.data.find((v) => v.hash === surface.hash);
      expect(entry).toBeDefined();
      expect(entry?.stats.turns).toBeGreaterThanOrEqual(1);

      // GET /api/logs/system/<hash> — full content for the found version.
      const detail = await h(get(`/api/logs/system/${surface.hash}`));
      expect(detail.status).toBe(200);
      const detailJson = (await detail.json()) as { systemJson?: string; toolsJson?: string };
      expect(detailJson.systemJson).toBe(surface.systemJson);
      expect(detailJson.toolsJson).toContain("Read");

      // ... and a 404 for an unknown hash.
      expect((await h(get("/api/logs/system/deadbeef"))).status).toBe(404);

      // GET /api/logs/sessions — the aggregate listing.
      const sessions = await h(get("/api/logs/sessions"));
      expect(sessions.status).toBe(200);
      const sessionsJson = (await sessions.json()) as { data: Array<{ id: string }> };
      expect(sessionsJson.data.some((s) => s.id === "sess-A")).toBe(true);

      // GET /api/logs/sessions/<id> — the turn list (params.length === 1).
      const turns = await h(get("/api/logs/sessions/sess-A"));
      expect(turns.status).toBe(200);

      // GET /api/logs/sessions/<id>/<seq> — { meta, body }.
      const one = await h(get("/api/logs/sessions/sess-A/1"));
      expect(one.status).toBe(200);
      const oneJson = (await one.json()) as { meta: { seq: number } | null; body: unknown };
      expect(oneJson.meta?.seq).toBe(1);

      // A session segment outside the allow-list -> 404.
      expect((await h(get("/api/logs/sessions/bad.id"))).status).toBe(404);
      // Too many path segments -> 404.
      expect((await h(get("/api/logs/sessions/sess-A/1/2"))).status).toBe(404);

      // Range exports — cover the 1h and today cutoffs plus the "all" default.
      for (const range of ["1h", "today"]) {
        const res = await h(get(`/api/logs/export/sessions?range=${range}`));
        expect(res.status, `range=${range}`).toBe(200);
        expect(res.headers.get("content-type")).toBe("application/zip");
      }
    } finally {
      await store.close();
    }
  });

  test("an export exceeding the ZIP entry cap is a typed 413", async () => {
    // A structural LogStore stub whose session holds more turns than the ZIP
    // entry limit — the REAL export handler + buildZip must reject with 413
    // rather than corrupt the archive. (50_001 tiny rows.)
    const count = 50_001;
    const turns: TurnMeta[] = Array.from({ length: count }, (_, i) => ({
      turnId: i + 1,
      sessionId: "bulk",
      seq: i + 1,
      requestedAt: new Date().toISOString(),
      respondedAt: null,
      modelRequested: null,
      modelServed: null,
      backend: null,
      path: null,
      promptVersion: null,
      stopReason: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      latencyMs: null,
      failover: false,
      errorClass: null,
      bodyFile: null,
      bodyBytes: null,
      bodyState: null,
      toolCalls: null,
      subagentOf: null,
    }));
    const stubStore = {
      isEnabled: () => true,
      listSessions: async () => [
        { id: "bulk", turnCount: count, inputTokens: 0, outputTokens: 0, firstAt: "", lastAt: "" },
      ],
      listTurns: async () => turns,
      getTurnBody: async () => null,
    } as unknown as LogStore;
    const config = validateConfig(rawConfig({ logging: { enabled: false, dir: root } }));
    const h = handlerFor(runtimeFor(config, new Catalog([]), stubStore));
    const res = await h(get("/api/logs/export/sessions"));
    expect(res.status).toBe(413);
    const json = (await res.json()) as { error: { type: string } };
    expect(json.error.type).toBe("request_too_large");
  });
});

/* ==================================================================== *
 * Multi-region external providers in the status surfaces.
 * ==================================================================== */

describe("status surfaces with a multi-region provider", () => {
  const alibabaModel: DiscoveredModel = {
    provider: "alibaba",
    awsRegion: "",
    regionKey: "ap-southeast-1",
    backend: "anthropic",
    nativeModelId: "qwen3-max",
    isAnthropic: false,
    supportsOnDemand: true,
    profiles: [],
    streaming: true,
  };

  function multiRegionConfig(): ProxyConfig {
    return validateConfig(
      rawConfig({
        providers: {
          alibaba: {
            type: "anthropic",
            auth: "x-api-key",
            credential: "sk-alibaba-primary",
            regions: {
              "ap-southeast-1": {
                modelsUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models",
                hostTemplate: "dashscope-intl.aliyuncs.com",
                billingMode: "token-plan",
              },
              "eu-central-1": {
                modelsUrl: "https://dashscope-eu.aliyuncs.com/compatible-mode/v1/models",
                credential: "sk-alibaba-eu",
                billingMode: "payg",
              },
            },
          },
        },
      }),
    );
  }

  function multiRegionHandler() {
    const catalog = new Catalog(
      [alibabaModel],
      [
        { source: "alibaba:ap-southeast-1", state: "ok" },
        { source: "alibaba:eu-central-1", state: "skipped", detail: "credential unset" },
      ],
    );
    return handlerFor(runtimeFor(multiRegionConfig(), catalog, DISABLED_STORE));
  }

  test("GET /api/config/status aggregates per-region state for a multi-region provider", async () => {
    const res = await multiRegionHandler()(get("/api/config/status"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      external: Array<{
        key: string;
        regions?: Array<{ key: string; billingMode?: string; state: string; detail?: string }>;
      }>;
    };
    const alibaba = json.external.find((e) => e.key === "alibaba");
    expect(alibaba?.regions?.map((r) => r.key)).toEqual(["ap-southeast-1", "eu-central-1"]);
    const eu = alibaba?.regions?.find((r) => r.key === "eu-central-1");
    expect(eu?.billingMode).toBe("payg");
    // The skipped region carries its discovery detail.
    expect(eu?.detail).toBe("credential unset");
  });

  test("GET /api/providers/status lists the per-region key pools", async () => {
    const res = await multiRegionHandler()(get("/api/providers/status"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      providers: Array<{
        key: string;
        regions?: Array<{ region: string; state: string; keys: Array<{ label: string }> }>;
      }>;
    };
    const alibaba = json.providers.find((p) => p.key === "alibaba");
    expect(alibaba?.regions?.map((r) => r.region)).toEqual(["ap-southeast-1", "eu-central-1"]);
    const eu = alibaba?.regions?.find((r) => r.region === "eu-central-1");
    expect(eu?.keys.map((k) => k.label)).toEqual(["default"]);
    // Labels only — the credential value never appears.
    expect(JSON.stringify(json).includes("sk-alibaba-eu")).toBe(false);
  });
});

/* ==================================================================== *
 * The import-time PORT guard (resolvePort).
 * ==================================================================== */

describe("resolvePort import-time guard", () => {
  test("an invalid PORT env value fails the module import loudly", async () => {
    const prev = process.env.PORT;
    process.env.PORT = "not-a-port";
    try {
      // A cache-busting query forces a fresh module evaluation so the top-level
      // guard runs. The specifier is typed `string` (not a literal) so TypeScript
      // does not try to resolve the query-suffixed module at compile time — the
      // runtime still re-evaluates it as a distinct cache key.
      const spec: string = "../src/server.ts?invalid-port";
      await expect(import(spec)).rejects.toThrow(/Invalid PORT env value/);
    } finally {
      // `""` is treated as absent by resolvePort (defaults to 8787); avoids the
      // noDelete lint error while restoring the "unset" case correctly.
      process.env.PORT = prev ?? "";
    }
  });
});

/* ==================================================================== *
 * Server bootstrap: main() + the import.meta.main guard.
 *
 * main() is module-private and reachable ONLY as the process entrypoint, so
 * the honest way to execute it is to run the real server file in a child
 * process — exactly how the proxy boots. The child binds a fresh OS-assigned
 * LOOPBACK port (never 8787) with a temp config and is killed the instant it
 * reports ready. Two spawns cover the whole bootstrap: a healthy boot (the
 * success path down through Bun.serve, incl. the copied-example warning and
 * the ephemeral-key print) and a structurally-invalid config (the fatal catch
 * + process.exit(1)). The child never touches the live proxy, the repo, or
 * ./logs (its logging dir is a temp dir).
 * ==================================================================== */

const REPO_ROOT = join(import.meta.dir, "..");

/** A fresh OS-assigned port on loopback (never 8787) for a boot child. */
async function freeLoopbackPort(): Promise<number> {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
  const port = probe.port;
  await probe.stop(true);
  return port;
}

interface BootResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/**
 * Write `files` into a fresh temp dir, then run the REAL server entrypoint
 * (`bun src/server.ts`) as a child with CONFIG_PATH pointing at `configName`
 * inside that dir. The child binds a fresh loopback port (never 8787). When
 * `waitFor` is given the promise resolves as soon as that marker appears on
 * stdout; otherwise it waits for the process to exit. The child is always
 * killed and the temp dir removed.
 */
async function bootServer(
  files: Record<string, string>,
  configName: string,
  waitFor: string | undefined,
  timeoutMs = 25_000,
): Promise<BootResult> {
  const dir = mkdtempSync(join(tmpdir(), "ccpp-server-boot-"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  const port = await freeLoopbackPort();

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    // Drop any inherited coverage config: a child must never write a coverage
    // dir (the default is ./coverage inside the repo — which must never appear).
    if (v !== undefined && !k.startsWith("BUN_COVERAGE")) env[k] = v;
  }
  env.CONFIG_PATH = join(dir, configName);
  env.PORT = String(port);
  env.HOST = "127.0.0.1";
  env.PROXY_INBOUND_KEY = ""; // unset -> the config's empty keys list mints an ephemeral one

  const proc = Bun.spawn([process.execPath, join(REPO_ROOT, "src/server.ts")], {
    cwd: REPO_ROOT,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  const decoder = new TextDecoder();
  let stdout = "";
  let stderr = "";
  const drainStderr = (async () => {
    const reader = proc.stderr.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      stderr += decoder.decode(value, { stream: true });
    }
  })();

  const reader = proc.stdout.getReader();
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const res = await Promise.race([
        reader.read(),
        new Promise<{ timeout: true }>((resolve) =>
          setTimeout(() => resolve({ timeout: true }), 200),
        ),
      ]);
      if ("timeout" in res) {
        if (proc.exitCode !== null) break; // process gone and drained
        continue;
      }
      if (res.done) break;
      stdout += decoder.decode(res.value, { stream: true });
      if (waitFor !== undefined && stdout.includes(waitFor)) break;
    }
  } finally {
    try {
      proc.kill();
    } catch {
      // already exited
    }
  }
  const exitCode = await proc.exited;
  await drainStderr;
  rmSync(dir, { recursive: true, force: true });
  return { stdout, stderr, exitCode };
}

describe("server bootstrap: main() + import.meta.main", () => {
  test("a healthy boot runs the full startup path and reaches Bun.serve", async () => {
    // config.local.jsonc is ABSENT but an example sits beside it, so boot takes
    // the `copied-example` branch (source !== "file" -> the boot warning) and
    // then runs the entire startup sequence on the copied config.
    const logDir = mkdtempSync(join(tmpdir(), "ccpp-server-boot-logs-"));
    try {
      const exampleConfig = JSON.stringify({
        server: { host: "127.0.0.1", port: 8787 },
        inboundAuth: { keys: [] }, // empty -> ephemeral inbound key
        primaryRegion: "us",
        profilePreference: "global",
        refreshIntervalMinutes: 60,
        claudeFallbackToMantle: false,
        regions: [{ key: "us", awsRegion: "us-east-1" }],
        providers: {}, // Bedrock absent -> disabled (external-only)
        logging: { enabled: true, dir: logDir, systemDir: "system", sessionDir: "sessions" },
        chatPage: { enabled: false },
      });
      const result = await bootServer(
        { "config.example.jsonc": exampleConfig },
        "config.local.jsonc",
        "listening on",
      );

      expect(result.stderr).not.toContain("fatal startup error");
      // source !== "file" -> the boot-source warning (console.warn -> stderr).
      expect(result.stderr).toContain("Booting from config source: copied-example.");
      // Ephemeral inbound key printed once, to the operator console.
      expect(result.stdout).toMatch(/EPHEMERAL inbound key for this run: \S+/);
      // Bedrock disabled -> the external-only discovery line.
      expect(result.stdout).toContain("Bedrock disabled");
      expect(result.stdout).toContain("Discovery complete: 0 models loaded.");
      // Logging enabled -> the write-location line.
      expect(result.stdout).toMatch(/Logging enabled: writing to /);
      // Bun.serve came up and the ready line printed.
      expect(result.stdout).toMatch(/listening on http:\/\/127\.0\.0\.1:\d+ \(registry at \/\)/);
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  test("a structurally-invalid config rejects main() -> the fatal catch exits 1", async () => {
    const result = await bootServer(
      { "config.local.jsonc": JSON.stringify({ server: "not-an-object" }) },
      "config.local.jsonc",
      undefined,
    );
    expect(result.exitCode).toBe(1);
    // logger.error("fatal startup error", ...) + console.error(err) -> stderr.
    expect(result.stderr).toContain("fatal startup error");
  });
});
