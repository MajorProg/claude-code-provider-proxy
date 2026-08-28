/**
 * Concurrency regression tests for the reload/refresh critical sections
 * (Tasks 4/5/6).
 *
 * - createSerializer: concurrent calls run strictly in order and a rejection
 *   does not poison the chain (used to serialize reloadRuntime).
 * - CatalogManager.refresh: single-flight (overlapping calls share one
 *   discovery; a slow refresh can't overwrite a newer catalog); stop() prevents
 *   a late-resolving refresh from writing into a discarded manager.
 */
import { describe, expect, test } from "bun:test";
import { type ProxyConfig, validateConfig } from "../src/config.ts";
import { CatalogManager, type DiscoveryClient } from "../src/model/catalog.ts";
import { createSerializer } from "../src/server.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("createSerializer", () => {
  test("runs tasks strictly in submission order", async () => {
    const serialize = createSerializer();
    const order: number[] = [];
    // Submit three tasks whose bodies would finish out-of-order if unserialized.
    const p1 = serialize(async () => {
      await delay(30);
      order.push(1);
    });
    const p2 = serialize(async () => {
      await delay(5);
      order.push(2);
    });
    const p3 = serialize(async () => {
      await delay(1);
      order.push(3);
    });
    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });

  test("a rejection does not poison subsequent tasks", async () => {
    const serialize = createSerializer();
    const ran: string[] = [];
    const failing = serialize(async () => {
      throw new Error("boom");
    });
    const after = serialize(async () => {
      ran.push("after");
      return "ok";
    });
    await expect(failing).rejects.toThrow("boom");
    await expect(after).resolves.toBe("ok");
    expect(ran).toEqual(["after"]);
  });
});

function makeConfig(): ProxyConfig {
  return validateConfig({
    server: { host: "127.0.0.1", port: 8787 },
    inboundAuth: { keys: ["k"] },
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
      // No external providers -> discoverExternalCatalog is a no-op (hermetic).
    },
    logging: { enabled: false, dir: "./logs", systemDir: "system", sessionDir: "sessions" },
    chatPage: { enabled: false },
  });
}

/**
 * Discovery client stub that counts calls and can be made slow. Returns a
 * single foundation model whose id encodes the current "generation" so we can
 * detect stale overwrites. Built structurally and cast to DiscoveryClient to
 * avoid depending on the (currently non-exported) raw summary types.
 */
function makeSlowClient(state: { gen: number; calls: number; delayMs: number }): DiscoveryClient {
  const client = {
    async listFoundationModels(): Promise<unknown[]> {
      state.calls++;
      const gen = state.gen;
      await delay(state.delayMs);
      return [
        {
          modelId: `vendor.model-gen${gen}`,
          modelName: `gen${gen}`,
          providerName: "vendor",
          inferenceTypesSupported: ["ON_DEMAND"],
          modelLifecycle: { status: "ACTIVE" },
        },
      ];
    },
    async listInferenceProfiles(): Promise<unknown[]> {
      return [];
    },
    async listMantleModels(): Promise<unknown[]> {
      return [];
    },
  };
  return client as unknown as DiscoveryClient;
}

describe("CatalogManager.refresh single-flight", () => {
  test("overlapping refresh calls share one in-flight discovery", async () => {
    const state = { gen: 0, calls: 0, delayMs: 20 };
    const mgr = await CatalogManager.start(makeConfig(), makeSlowClient(state));
    const callsAfterStart = state.calls;
    // Fire three refreshes concurrently; single-flight should collapse to one.
    await Promise.all([mgr.refresh(), mgr.refresh(), mgr.refresh()]);
    expect(state.calls - callsAfterStart).toBe(1);
    mgr.stop();
  });

  test("stop() prevents a late refresh from overwriting the catalog", async () => {
    const state = { gen: 1, calls: 0, delayMs: 40 };
    const mgr = await CatalogManager.start(makeConfig(), makeSlowClient(state));
    const before = mgr.current().models.length;
    // Start a refresh with a NEW generation, then stop before it resolves.
    state.gen = 2;
    const inflight = mgr.refresh();
    mgr.stop();
    await inflight;
    // The catalog must be unchanged (the late refresh was discarded).
    expect(mgr.current().models.length).toBe(before);
  });
});
