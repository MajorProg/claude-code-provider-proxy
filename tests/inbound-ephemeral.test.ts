/**
 * Ephemeral inbound-key tests (hermetic; real validateConfig / serializeConfig /
 * authenticateInbound / createFetchHandler).
 *
 * PROXY_INBOUND_KEY unset must never lock the operator out OR weaken auth: a
 * random key is minted per validation, auth stays enforced against it, the key
 * is never persisted (save path rewrites to the bare ${PROXY_INBOUND_KEY} ref),
 * and every hot-reload rotates it with the new value surfaced in the save
 * response. Public surfaces (/status.json) carry only a boolean, never the key.
 */
import { describe, expect, test } from "bun:test";
import { authenticateInbound } from "../src/auth/inbound.ts";
import {
  type ProxyConfig,
  generateEphemeralInboundKey,
  isEphemeralInboundKey,
  serializeConfig,
  validateConfig,
} from "../src/config.ts";
import { UnauthorizedError } from "../src/errors.ts";
import { buildRegistrySnapshot } from "../src/http/registry-page.ts";
import { Catalog } from "../src/model/catalog.ts";
import { type Runtime, createFetchHandler } from "../src/server.ts";

const BASE = {
  server: { host: "127.0.0.1", port: 8787 },
  primaryRegion: "us" as const,
  profilePreference: "global" as const,
  refreshIntervalMinutes: 60,
  claudeFallbackToMantle: false,
  regions: [{ key: "us" as const, awsRegion: "us-east-1" }],
  providers: {},
  logging: { enabled: false, dir: "./logs", systemDir: "system", sessionDir: "sessions" },
  chatPage: { enabled: false },
};

function ephemeralConfig(): ProxyConfig {
  return validateConfig({ ...BASE, inboundAuth: { keys: [] } });
}

describe("ephemeral key generation", () => {
  test("format: prefix + 32 hex chars; isEphemeralInboundKey matches", () => {
    const key = generateEphemeralInboundKey();
    expect(key).toMatch(/^ccpp-ephemeral-[0-9a-f]{32}$/);
    expect(isEphemeralInboundKey(key)).toBe(true);
    expect(isEphemeralInboundKey("ccpp_cli_generated_key")).toBe(false);
    expect(isEphemeralInboundKey("")).toBe(false);
  });
});

describe("authenticateInbound with a minted key", () => {
  test("accepts the key via Authorization: Bearer", () => {
    const cfg = ephemeralConfig();
    const key = cfg.inboundAuth.keys[0] ?? "";
    expect(() =>
      authenticateInbound(
        new Request("http://localhost/api/config", {
          headers: { authorization: `Bearer ${key}` },
        }).headers,
        cfg.inboundAuth.keys,
      ),
    ).not.toThrow();
  });

  test("accepts the key via x-api-key", () => {
    const cfg = ephemeralConfig();
    const key = cfg.inboundAuth.keys[0] ?? "";
    expect(() =>
      authenticateInbound(
        new Request("http://localhost/v1/messages", { headers: { "x-api-key": key } }).headers,
        cfg.inboundAuth.keys,
      ),
    ).not.toThrow();
  });

  test("rejects any other credential (auth is never bypassed)", () => {
    const cfg = ephemeralConfig();
    for (const h of [
      new Headers({ authorization: "Bearer wrong" }),
      new Headers({ "x-api-key": "" }),
      new Headers(),
    ]) {
      expect(() => authenticateInbound(h, cfg.inboundAuth.keys)).toThrow(UnauthorizedError);
    }
  });
});

describe("serializeConfig with an ephemeral key", () => {
  test("SAVE path (env provided) rewrites to the bare ${PROXY_INBOUND_KEY} ref", () => {
    const cfg = ephemeralConfig();
    const raw = serializeConfig(cfg, {}) as { inboundAuth: { keys: string[] } };
    expect(raw.inboundAuth.keys).toEqual(["${PROXY_INBOUND_KEY}"]);
  });

  test("DISPLAY path (no env) keeps the literal so the operator can copy it", () => {
    const cfg = ephemeralConfig();
    const raw = serializeConfig(cfg) as { inboundAuth: { keys: string[] } };
    expect(raw.inboundAuth.keys[0]).toMatch(/^ccpp-ephemeral-[0-9a-f]{32}$/);
  });

  test("a display round-trip through validateConfig mints a FRESH key (rotation)", () => {
    const cfg = ephemeralConfig();
    const displayed = serializeConfig(cfg); // what GET /api/config returns
    const reposted = validateConfig(displayed); // what the UI POSTs back
    expect(reposted.inboundAuth.keys[0]).toMatch(/^ccpp-ephemeral-[0-9a-f]{32}$/);
    expect(reposted.inboundAuth.keys[0]).not.toBe(cfg.inboundAuth.keys[0]);
    expect(reposted.inboundAuth.ephemeralKey).toBe(true);
  });
});

/** Minimal runtime mirroring buildRuntime for handler-level tests. */
function ephemeralRuntime(cfg: ProxyConfig): Runtime {
  const catalog = new Catalog([], [{ source: "bedrock", state: "disabled" }]);
  return {
    config: cfg,
    tokenProvider: null,
    catalogManager: { current: () => catalog, stop: () => {} },
    logStore: { isEnabled: () => false },
  } as unknown as Runtime;
}

describe("server surfaces with an ephemeral key", () => {
  test("/status.json reports the boolean marker and NEVER the key value", () => {
    const cfg = ephemeralConfig();
    const snap = buildRegistrySnapshot(cfg, new Catalog([], []));
    expect(snap.inboundAuthEphemeral).toBe(true);
    const json = JSON.stringify(snap);
    expect(json).not.toContain("ccpp-ephemeral-");
    // Marker absent for a persistent-key config.
    const persistent = validateConfig({ ...BASE, inboundAuth: { keys: ["real-key"] } });
    expect(
      buildRegistrySnapshot(persistent, new Catalog([], [])).inboundAuthEphemeral,
    ).toBeUndefined();
  });

  test("/status.json handler body carries warnings (names only) + marker", async () => {
    const cfg = Object.freeze({
      ...ephemeralConfig(),
      loadWarnings: ["PROXY_INBOUND_KEY"],
    });
    const runtime = ephemeralRuntime(cfg);
    const handler = createFetchHandler(
      () => runtime,
      async () => undefined,
    );
    const res = await handler(new Request("http://localhost/status.json"));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('"inboundAuthEphemeral":true');
    expect(body).toContain("PROXY_INBOUND_KEY");
    expect(body).not.toContain("ccpp-ephemeral-");
  });

  test("config save response carries the ROTATED ephemeral key from the outcome", async () => {
    const cfg = ephemeralConfig();
    const runtime = ephemeralRuntime(cfg);
    const rotated = "ccpp-ephemeral-rotated-test-value";
    const handler = createFetchHandler(
      () => runtime,
      async () => ({ ephemeralInboundKey: rotated }),
    );
    const res = await handler(
      new Request("http://localhost/api/config", {
        method: "POST",
        headers: {
          authorization: `Bearer ${cfg.inboundAuth.keys[0] ?? ""}`,
          "content-type": "application/json",
          "x-ccpp-csrf": "1",
          origin: "http://localhost",
        },
        body: JSON.stringify(serializeConfig(cfg)),
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { message?: string };
    expect(json.message).toContain(rotated);
  });

  test("a plain reload outcome keeps the standard save message", async () => {
    const cfg = ephemeralConfig();
    const runtime = ephemeralRuntime(cfg);
    const handler = createFetchHandler(
      () => runtime,
      async () => undefined,
    );
    const res = await handler(
      new Request("http://localhost/api/config", {
        method: "POST",
        headers: {
          authorization: `Bearer ${cfg.inboundAuth.keys[0] ?? ""}`,
          "content-type": "application/json",
          "x-ccpp-csrf": "1",
          origin: "http://localhost",
        },
        body: JSON.stringify(serializeConfig(cfg)),
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { message?: string };
    expect(json.message).toBe("Config saved and hot-reloaded.");
  });
});
