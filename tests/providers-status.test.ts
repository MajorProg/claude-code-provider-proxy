/**
 * GET /api/providers/status — hermetic, via createFetchHandler with a stubbed
 * Runtime (empty catalog, real CredentialCooldownStore).
 *
 * Asserts the serving-state contract the Providers UI tab renders from: every
 * external provider lists its pool keys with ok/cooldown status, a benched key
 * carries its reinstatement time (epoch ms + ISO), and the response names
 * LABELS only — never credential values.
 */
import { describe, expect, test } from "bun:test";
import { type ProxyConfig, validateConfig } from "../src/config.ts";
import { CredentialCooldownStore } from "../src/failover.ts";
import { Catalog } from "../src/model/catalog.ts";
import { type Runtime, createFetchHandler } from "../src/server.ts";

const KEY = "ccpp-providers-status-key";

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
      zai: {
        type: "anthropic",
        credentials: [
          { credential: "zai-secret-primary", label: "primary", name: "Chimera Developer 2" },
          { credential: "zai-secret-secondary", label: "secondary" },
        ],
        auth: "bearer",
        baseUrl: "https://api.z.ai/api/anthropic",
        countTokens: true,
        modelsUrl: "https://api.z.ai/api/paas/v4/models",
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
    logging: { enabled: false },
    chatPage: { enabled: false },
  });
}

function makeRuntime(config: ProxyConfig, cooldownStore: CredentialCooldownStore): Runtime {
  const catalog = new Catalog([]);
  const runtime = {
    config,
    tokenProvider: null,
    catalogManager: { current: () => catalog, stop: () => {} },
    logStore: { isEnabled: () => false, captureActive: () => false },
    cooldownStore,
  };
  return runtime as unknown as Runtime;
}

function get(path: string, withKey = true): Request {
  const headers: Record<string, string> = {};
  if (withKey) headers.authorization = `Bearer ${KEY}`;
  return new Request(`http://localhost${path}`, { headers });
}

describe("GET /api/providers/status", () => {
  test("benched keys surface their reinstatement time; clean keys are ok", async () => {
    const store = new CredentialCooldownStore();
    const h = createFetchHandler(
      () => makeRuntime(makeConfig(), store),
      async () => undefined,
    );
    // Deterministic rng so untilMs is exactly COOLDOWN_MS − jitter out; the
    // reset stamp is days out, so the operational cooldown clamps to 1h while
    // the quota mark keeps the real date.
    const weeklyReset = Date.now() + 4 * 24 * 3600 * 1000;
    store.mark("zai", "primary", weeklyReset, () => 0);
    const expectedUntil = store.degradedUntil("zai", "primary") ?? 0;

    const res = await h(get("/api/providers/status"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      serverNow: number;
      bedrock: { enabled: boolean; reason?: string };
      providers: Array<{
        key: string;
        keys: Array<{
          label: string;
          name?: string;
          status: string;
          cooldownUntilMs?: number;
          cooldownUntilIso?: string;
          last429At?: number;
          quotaResetAt?: number;
          quotaResetIso?: string;
        }>;
      }>;
    };

    expect(Math.abs(body.serverNow - Date.now())).toBeLessThan(5000);
    // No bedrock block configured -> disabled with its reason, never a crash.
    expect(body.bedrock.enabled).toBe(false);
    expect(body.bedrock.reason).toBeTruthy();

    const zai = body.providers.find((p) => p.key === "zai");
    expect(zai).toBeDefined();
    const [primary, secondary] = zai?.keys ?? [];
    expect(primary?.label).toBe("primary");
    // Optional display name (account/plan) surfaces for the UI; absent elsewhere.
    expect(primary?.name).toBe("Chimera Developer 2");
    expect(primary?.status).toBe("cooldown");
    expect(primary?.cooldownUntilMs).toBe(expectedUntil);
    expect(primary?.cooldownUntilIso).toBe(new Date(expectedUntil).toISOString());
    // Quota history: the clamped cooldown (<= 1h) is distinct from the REAL
    // provider-side weekly reset stamp, which the page keeps showing.
    expect(primary?.cooldownUntilMs).toBeLessThanOrEqual(Date.now() + 3600_000 + 1);
    expect(primary?.quotaResetAt).toBe(weeklyReset);
    expect(primary?.quotaResetIso).toBe(new Date(weeklyReset).toISOString());
    expect(primary?.last429At).toBeGreaterThan(Date.now() - 5000);
    expect(secondary?.label).toBe("secondary");
    expect(secondary?.status).toBe("ok");
    expect("cooldownUntilMs" in (secondary ?? {})).toBe(false);
    expect("last429At" in (secondary ?? {})).toBe(false);

    // A flat single credential contributes one "default"-labeled key.
    const deepseek = body.providers.find((p) => p.key === "deepseek");
    expect(deepseek?.keys).toEqual([{ label: "default", status: "ok" }]);

    // Labels only — the response must never carry credential values.
    const raw = JSON.stringify(body);
    expect(raw.includes("zai-secret")).toBe(false);
    expect(raw.includes("sk-deepseek-secret")).toBe(false);
    store.clear();
  });
});
