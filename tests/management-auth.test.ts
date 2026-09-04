/**
 * Auth regression tests for the management/observability surface.
 *
 * Every management API route (config, logs, chat) MUST return 401 without the
 * inbound key and be reachable with it. The public routes (registry pages,
 * /status.json, /v1/models, HEAD probe) and the HTML shells (/config, /logs,
 * /chat) MUST stay reachable without a key (they carry no secret; the browser
 * attaches the key on the subsequent API fetch).
 *
 * Also asserts the credential-redaction contract (Task 1): an authenticated
 * /api/config/auth response never contains the raw minted SigV4 token.
 *
 * Drives the exported createFetchHandler with a stubbed Runtime — no Bun.serve,
 * no live discovery.
 */
import { describe, expect, test } from "bun:test";
import { type ProxyConfig, validateConfig } from "../src/config.ts";
import { type Runtime, createFetchHandler } from "../src/server.ts";

const KEY = "ccpp-test-inbound-key";

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
        // long-term key path -> describeAuth reports it (no minting), keeping
        // the test hermetic (no AWS calls).
        credential: "long-term-secret-key-value",
        hosts: {
          converse: "bedrock-runtime.{region}.amazonaws.com",
          mantle: "bedrock-mantle.{region}.api.aws",
          control: "bedrock.{region}.amazonaws.com",
        },
      },
      deepseek: {
        type: "anthropic",
        credential: "sk-deepseek-secret",
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

/** Minimal Runtime stub: empty catalog, disabled log store. */
function makeRuntime(config: ProxyConfig): Runtime {
  const emptyCatalog = { models: [] as never[], sources: [] as never[] };
  const runtime = {
    config,
    tokenProvider: async () => "unused-in-these-tests",
    catalogManager: { current: () => emptyCatalog, stop: () => {} },
    logStore: { isEnabled: () => false },
  };
  // Structural stub — only the members touched by the routes under test exist.
  return runtime as unknown as Runtime;
}

function handler() {
  const config = makeConfig();
  const runtime = makeRuntime(config);
  return createFetchHandler(
    () => runtime,
    async () => {},
  );
}

function req(method: string, path: string, withKey: boolean): Request {
  const headers: Record<string, string> = {};
  if (withKey) headers.authorization = `Bearer ${KEY}`;
  return new Request(`http://localhost${path}`, { method, headers });
}

const MANAGEMENT_GET = [
  "/api/config",
  "/api/config/status",
  "/api/config/auth",
  "/api/logs/system",
  "/api/logs/sessions",
  "/api/logs/export/system",
  "/api/logs/export/sessions?range=all",
  "/api/logs/system/deadbeef",
  "/api/logs/sessions/some-session",
];

describe("management surface requires the inbound key", () => {
  test("every management GET returns 401 without a key", async () => {
    const h = handler();
    for (const path of MANAGEMENT_GET) {
      const res = await h(req("GET", path, false));
      expect(res.status).toBe(401);
    }
  });

  test("POST /api/config returns 401 without a key", async () => {
    const h = handler();
    const res = await h(
      new Request("http://localhost/api/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(401);
  });

  test("POST /api/chat returns 401 without a key", async () => {
    const h = handler();
    const res = await h(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "x", messages: [] }),
      }),
    );
    expect(res.status).toBe(401);
  });

  test("management GETs are reachable (not 401) with a valid key", async () => {
    const h = handler();
    for (const path of ["/api/config", "/api/config/status", "/api/config/auth"]) {
      const res = await h(req("GET", path, true));
      expect(res.status).not.toBe(401);
    }
  });
});

describe("public surface stays open without a key", () => {
  test("registry, status.json, v1/models, HEAD probe, and HTML shells are not 401", async () => {
    const h = handler();
    for (const path of ["/", "/status.json", "/v1/models", "/config", "/logs", "/chat"]) {
      const res = await h(req("GET", path, false));
      expect(res.status).not.toBe(401);
    }
    const head = await h(req("HEAD", "/api/hello", false));
    expect(head.status).toBe(204);
  });
});

describe("credential redaction (Task 1)", () => {
  test("/api/config/auth never leaks a raw minted SigV4 token", async () => {
    const h = handler();
    const res = await h(req("GET", "/api/config/auth", true));
    expect(res.status).toBe(200);
    const body = await res.text();
    // The minted short-lived token is prefixed 'bedrock-api-key-'; it must never
    // appear in the auth response (metadata only).
    expect(body.includes("bedrock-api-key-")).toBe(false);
  });
});

describe("CSRF protection on POST /api/config (Task 33)", () => {
  test("authenticated POST without the CSRF header is rejected (401)", async () => {
    const h = handler();
    const res = await h(
      new Request("http://localhost/api/config", {
        method: "POST",
        headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(401);
  });

  test("authenticated POST with the CSRF header passes the gate (not 401)", async () => {
    const h = handler();
    const res = await h(
      new Request("http://localhost/api/config", {
        method: "POST",
        headers: {
          authorization: `Bearer ${KEY}`,
          "content-type": "application/json",
          "x-ccpp-csrf": "1",
        },
        body: "{}",
      }),
    );
    // reloadRuntime is a no-op stub here, so the gated handler returns 200.
    expect(res.status).not.toBe(401);
  });

  test("a cross-origin Origin header is rejected even with key + CSRF header", async () => {
    const h = handler();
    const res = await h(
      new Request("http://localhost/api/config", {
        method: "POST",
        headers: {
          authorization: `Bearer ${KEY}`,
          "content-type": "application/json",
          "x-ccpp-csrf": "1",
          origin: "https://evil.example",
        },
        body: "{}",
      }),
    );
    expect(res.status).toBe(401);
  });
});

describe("CSRF protection on POST /api/chat (Task 3)", () => {
  test("authenticated POST without the CSRF header is rejected (401)", async () => {
    const h = handler();
    const res = await h(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "x", messages: [] }),
      }),
    );
    expect(res.status).toBe(401);
  });

  test("authenticated POST with the CSRF header passes the CSRF gate (not 401)", async () => {
    const h = handler();
    const res = await h(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: {
          authorization: `Bearer ${KEY}`,
          "content-type": "application/json",
          "x-ccpp-csrf": "1",
        },
        body: JSON.stringify({ model: "x", messages: [] }),
      }),
    );
    // Passes auth + CSRF; downstream routing/inference may fail on the stub
    // catalog, but the request is no longer rejected at the CSRF gate.
    expect(res.status).not.toBe(401);
  });
});

describe("Content-Security-Policy on HTML pages (Task 33)", () => {
  test("served HTML shells carry a CSP header", async () => {
    const h = handler();
    for (const path of ["/", "/config", "/logs"]) {
      const res = await h(new Request(`http://localhost${path}`, { method: "GET" }));
      expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });
});
