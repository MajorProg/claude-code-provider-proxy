/**
 * Server behavior with Bedrock DISABLED (hermetic).
 *
 * The proxy must keep serving: external-only catalogs work, requests for
 * bedrock.* models get a clean Anthropic-shaped 404 ProviderDisabledError
 * (never a 500, never an upstream call), the management/status surfaces report
 * the disabled state with a reason, and the config UI shell stays reachable so
 * an operator can fix credentials without file surgery. Bedrock-disabled means
 * tokenProvider is null — the Runtime here mirrors what buildRuntime produces.
 */
import { describe, expect, test } from "bun:test";
import { type ProxyConfig, validateConfig } from "../src/config.ts";
import { Catalog, type DiscoveredModel } from "../src/model/catalog.ts";
import { type Runtime, createFetchHandler } from "../src/server.ts";
import { installFetchMock } from "./helpers/fetch-mock.ts";

const KEY = "ccpp-disabled-bedrock-key";

function makeConfig(withBedrockBlock: boolean): ProxyConfig {
  return validateConfig({
    server: { host: "127.0.0.1", port: 8787 },
    inboundAuth: { keys: [KEY] },
    primaryRegion: "us",
    profilePreference: "global",
    refreshIntervalMinutes: 60,
    claudeFallbackToMantle: false,
    regions: [{ key: "us", awsRegion: "us-east-1" }],
    providers: {
      ...(withBedrockBlock
        ? {
            bedrock: {
              credential: "", // present but empty => disabled
              hosts: {
                converse: "bedrock-runtime.{region}.amazonaws.com",
                mantle: "bedrock-mantle.{region}.api.aws",
                control: "bedrock.{region}.amazonaws.com",
              },
            },
          }
        : {}),
      zai: {
        type: "anthropic",
        credential: "", // configured but inactive until ZAI_API_KEY is set
        auth: "bearer",
        baseUrl: "https://api.z.ai/api/anthropic",
        countTokens: true,
        modelsUrl: "https://api.z.ai/api/paas/v4/models",
      },
      deepseek: {
        type: "anthropic",
        credential: "sk-deepseek-set",
        auth: "x-api-key",
        baseUrl: "https://api.deepseek.com/anthropic",
        countTokens: true,
        modelsUrl: "https://api.deepseek.com/v1/models",
      },
    },
    logging: { enabled: false, dir: "./logs", systemDir: "system", sessionDir: "sessions" },
    chatPage: { enabled: true },
  });
}

const deepseekModel: DiscoveredModel = {
  provider: "deepseek",
  awsRegion: "",
  regionKey: "global",
  backend: "anthropic",
  nativeModelId: "deepseek-chat",
  isAnthropic: true,
  supportsOnDemand: true,
  profiles: [],
  streaming: true,
};

/** Mirror of what buildRuntime produces when Bedrock is disabled. */
function makeRuntime(withBedrockBlock: boolean): Runtime {
  const catalog = new Catalog(
    [deepseekModel],
    [
      { source: "bedrock", state: "disabled" },
      { source: "zai", state: "skipped", detail: "credential unset or placeholder" },
      { source: "deepseek", state: "ok" },
    ],
  );
  const runtime = {
    config: makeConfig(withBedrockBlock),
    tokenProvider: null, // bedrock disabled
    catalogManager: { current: () => catalog, stop: () => {} },
    logStore: { isEnabled: () => false },
  };
  return runtime as unknown as Runtime;
}

function handler(withBedrockBlock = true) {
  const runtime = makeRuntime(withBedrockBlock);
  return createFetchHandler(
    () => runtime,
    async () => {},
  );
}

function post(path: string, body: unknown, key = KEY): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function get(path: string, key = KEY): Request {
  return new Request(`http://localhost${path}`, { headers: { authorization: `Bearer ${key}` } });
}

function messages(model: string): unknown {
  return { model, max_tokens: 32, messages: [{ role: "user", content: "hi" }] };
}

describe("bedrock.* requests with Bedrock disabled", () => {
  test("bedrock.mantle.* -> clean 404 ProviderDisabledError, zero upstream calls", async () => {
    const mock = installFetchMock({ text: "{}" });
    try {
      const res = await handler()(
        post("/v1/messages", messages("bedrock.mantle.us.anthropic.claude-sonnet-5")),
      );
      expect(res.status).toBe(404);
      const json = (await res.json()) as { type: string; error: { type: string; message: string } };
      expect(json.type).toBe("error");
      expect(json.error.type).toBe("not_found_error");
      expect(json.error.message).toContain('Provider "bedrock" is disabled');
      // route() rejected before any upstream fetch (esp. the routeMantle path,
      // which does NOT consult the catalog and previously would have called out).
      expect(mock.requests).toEqual([]);
    } finally {
      mock.restore();
    }
  });

  test("bedrock.converse.* -> clean 404, zero upstream calls", async () => {
    const mock = installFetchMock({ text: "{}" });
    try {
      const res = await handler()(
        post("/v1/messages", messages("bedrock.converse.us.amazon.nova-lite-v1:0")),
      );
      expect(res.status).toBe(404);
      const json = (await res.json()) as { error: { message: string } };
      expect(json.error.message).toContain('Provider "bedrock" is disabled');
      expect(mock.requests).toEqual([]);
    } finally {
      mock.restore();
    }
  });

  test("same for a config with NO bedrock block at all", async () => {
    const mock = installFetchMock({ text: "{}" });
    try {
      const res = await handler(false)(
        post("/v1/messages", messages("bedrock.mantle.us.some.model")),
      );
      expect(res.status).toBe(404);
      expect(mock.requests).toEqual([]);
    } finally {
      mock.restore();
    }
  });

  test("count_tokens on a bedrock id -> clean 4xx, zero upstream calls", async () => {
    const mock = installFetchMock({ text: "{}" });
    try {
      const res = await handler()(
        post("/v1/messages/count_tokens", {
          model: "bedrock.mantle.us.anthropic.claude-sonnet-5",
          messages: [{ role: "user", content: "hi" }],
        }),
      );
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(mock.requests).toEqual([]);
    } finally {
      mock.restore();
    }
  });
});

describe("external providers alongside disabled Bedrock", () => {
  test("external provider with an empty credential -> 404 ProviderDisabledError", async () => {
    const mock = installFetchMock({ text: "{}" });
    try {
      const res = await handler()(post("/v1/messages", messages("zai.anthropic.global.glm-5")));
      expect(res.status).toBe(404);
      const json = (await res.json()) as { error: { message: string } };
      expect(json.error.message).toContain('Provider "zai" is disabled');
      expect(mock.requests).toEqual([]);
    } finally {
      mock.restore();
    }
  });
});

describe("management/status surfaces with Bedrock disabled", () => {
  test("GET /api/config/status reports bedrock disabled + provider states", async () => {
    const res = await handler()(get("/api/config/status"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      bedrock: { enabled: boolean; reason?: string };
      external: { key: string; state: string }[];
      totalModels: number;
    };
    expect(json.bedrock.enabled).toBe(false);
    expect(json.bedrock.reason).toContain("no Bedrock credential");
    const states = Object.fromEntries(json.external.map((e) => [e.key, e.state]));
    expect(states.zai).toBe("skipped");
    expect(states.deepseek).toBe("ok");
    expect(json.totalModels).toBe(1);
  });

  test("GET /api/config/auth reports mode=disabled without leaking a credential", async () => {
    const res = await handler()(get("/api/config/auth"));
    expect(res.status).toBe(200);
    const text = await res.text();
    const json = JSON.parse(text) as { bedrock: { mode: string; reason?: string } };
    expect(json.bedrock.mode).toBe("disabled");
    expect(json.bedrock.reason).toBeTruthy();
    // No key-shaped strings in the disabled branch.
    expect(text.includes("bedrock-api-key-")).toBe(false);
  });

  test("GET /status.json is 200 and carries per-source statuses", async () => {
    const res = await handler()(new Request("http://localhost/status.json"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { sources: { source: string; state: string }[] };
    const states = Object.fromEntries(json.sources.map((s) => [s.source, s.state]));
    expect(states.bedrock).toBe("disabled");
    expect(states.zai).toBe("skipped");
    expect(states.deepseek).toBe("ok");
  });

  test("GET /config stays reachable (the UI is how an operator fixes this)", async () => {
    const res = await handler()(new Request("http://localhost/config"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });
});
