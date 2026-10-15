/**
 * Behavioural coverage for the dependency-free HTML page renderers and the ZIP
 * writer:
 *   - providers-page.ts  (renderProvidersPageHtml)
 *   - registry-page.ts   (buildRegistrySnapshot + renderRegistryHtml)
 *   - zip.ts             (buildZip store-method archive + limit guards)
 *
 * These are pure string/byte producers, so the tests are hermetic: a REAL
 * ProxyConfig built through the real validateConfig, a REAL Catalog of
 * DiscoveredModels, then assertions on the returned markup / archive bytes.
 * The zip cases shell out to the system `unzip` for a real round-trip; the
 * temp dir is a mkdtempSync path under tmpdir (never the repo ./logs).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ProxyConfig, validateConfig } from "../src/config.ts";
import { renderProvidersPageHtml } from "../src/http/providers-page.ts";
import { buildRegistrySnapshot, renderRegistryHtml } from "../src/http/registry-page.ts";
import { ZipLimitError, buildZip } from "../src/http/zip.ts";
import { Catalog, type DiscoveredModel, type SourceStatus } from "../src/model/catalog.ts";

/** A real config (through the real validator) with two external providers: zai
 *  carries a multi-key pool, deepseek a single flat key. */
function pageConfig(overrides?: { tiers?: boolean; pool?: boolean }): ProxyConfig {
  const withTiers = overrides?.tiers !== false;
  const withPool = overrides?.pool !== false;
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
        credential: "bedrock-api-key-test",
        hosts: {
          converse: "bedrock-runtime.{region}.amazonaws.com",
          mantle: "bedrock-mantle.{region}.api.aws",
          control: "bedrock.{region}.amazonaws.com",
        },
      },
      zai: {
        type: "anthropic",
        auth: "bearer",
        baseUrl: "https://api.z.ai/api/anthropic",
        modelsUrl: "https://api.z.ai/api/paas/v4/models",
        ...(withPool
          ? {
              credentials: [
                { credential: "zai-primary", label: "primary" },
                { credential: "zai-secondary" },
              ],
            }
          : { credential: "zai-single" }),
      },
      deepseek: {
        type: "anthropic",
        auth: "x-api-key",
        baseUrl: "https://api.deepseek.com/anthropic",
        modelsUrl: "https://api.deepseek.com/v1/models",
        credential: "deepseek-single",
      },
    },
    ...(withTiers
      ? {
          virtualModels: {
            "sonnet-like": [
              "zai.anthropic.global.glm-5.3",
              "deepseek.anthropic.global.deepseek-chat",
            ],
          },
        }
      : {}),
    logging: { enabled: false },
    chatPage: { enabled: false },
  });
}

const zaiModel: DiscoveredModel = {
  provider: "zai",
  awsRegion: "",
  regionKey: "global",
  backend: "anthropic",
  nativeModelId: "glm-5.3",
  isAnthropic: false,
  supportsOnDemand: false,
  profiles: [],
  streaming: true,
};

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

const novaModel: DiscoveredModel = {
  provider: "bedrock",
  awsRegion: "us-east-1",
  regionKey: "us",
  backend: "converse",
  nativeModelId: "amazon.nova-lite-v1:0",
  isAnthropic: false,
  supportsOnDemand: true,
  profiles: ["us.amazon.nova-lite-v1:0"],
  streaming: true,
};

const sources: SourceStatus[] = [
  { source: "bedrock:us-east-1", state: "ok" },
  { source: "zai", state: "error", detail: "boom" },
];

describe("buildRegistrySnapshot", () => {
  test("computes counts, sorted ids, tiers and key pools from real inputs", () => {
    const config = pageConfig();
    const catalog = new Catalog([novaModel, zaiModel, deepseekModel], sources);
    const snap = buildRegistrySnapshot(config, catalog);

    expect(snap.providers).toEqual(["bedrock", "deepseek", "zai"]);
    expect(snap.primaryRegion).toBe("us");
    expect(snap.profilePreference).toBe("global");
    expect(snap.regions).toEqual([{ key: "us", awsRegion: "us-east-1" }]);
    expect(snap.sources).toBe(sources);

    expect(snap.counts.total).toBe(3);
    expect(snap.counts.anthropic).toBe(1);
    expect(snap.counts.nonAnthropic).toBe(2);
    expect(snap.counts.byBackend).toEqual({ converse: 1, anthropic: 2 });
    expect(snap.counts.byRegion).toEqual({ us: 1, global: 2 });

    // Models are serialized with their canonical id and sorted by it.
    expect(snap.models.map((m) => m.canonicalId)).toEqual([
      "bedrock.converse.us.amazon.nova-lite-v1:0",
      "deepseek.anthropic.global.deepseek-chat",
      "zai.anthropic.global.glm-5.3",
    ]);
    const nova = snap.models[0];
    expect(nova?.awsRegion).toBe("us-east-1");
    expect(nova?.profiles).toEqual(["us.amazon.nova-lite-v1:0"]);
    expect(nova?.streaming).toBe(true);
    expect(nova?.isAnthropic).toBe(false);

    // Virtual tier: both candidates route, so the first resolves.
    expect(snap.virtualTiers).toEqual([
      {
        name: "sonnet-like",
        resolution: "zai.anthropic.global.glm-5.3",
        available: 2,
        candidates: 2,
      },
    ]);

    // Only the multi-key provider appears; the label-less entry renders "default".
    expect(snap.pools).toEqual([{ provider: "zai", labels: ["primary", "default"] }]);

    // servingChangePing is off in this config, so no serving account is shown.
    expect(snap.servingAccount).toBeNull();
  });

  test("omits virtualTiers and pools when none are configured", () => {
    const config = pageConfig({ tiers: false, pool: false });
    const snap = buildRegistrySnapshot(config, new Catalog([zaiModel], []));
    expect(snap.virtualTiers).toBeUndefined();
    expect(snap.pools).toBeUndefined();
  });

  test("an empty catalog yields zero counts and no providers", () => {
    const snap = buildRegistrySnapshot(pageConfig(), new Catalog([], []));
    expect(snap.providers).toEqual([]);
    expect(snap.counts).toEqual({
      total: 0,
      byBackend: {},
      byRegion: {},
      anthropic: 0,
      nonAnthropic: 0,
    });
    expect(snap.models).toEqual([]);
  });
});

describe("renderRegistryHtml", () => {
  test("renders the shell seeded with the snapshot and escapes embedded scripts", () => {
    // A hostile model id must not be able to break out of the inline <script>.
    const evil: DiscoveredModel = {
      ...zaiModel,
      nativeModelId: "</script><img src=x onerror=alert(1)>",
    };
    const snap = buildRegistrySnapshot(pageConfig(), new Catalog([evil], []));
    const html = renderRegistryHtml(snap, true);

    expect(html).toContain("<!doctype html>");
    expect(html).toContain('x-data="registry()"');
    expect(html).toContain("claude-code-provider-proxy — registry");
    expect(html).toContain("snap:"); // the seeded snapshot
    expect(html).toContain('href="/chat"'); // chat tab (enabled)
    // jsonForScript escapes '<', so the raw markup never appears.
    expect(html).toContain("\\u003c/script>");
    expect(html).not.toContain("</script><img");
  });

  test("omits the chat tab when the chat page is disabled", () => {
    const snap = buildRegistrySnapshot(pageConfig(), new Catalog([novaModel], []));
    const html = renderRegistryHtml(snap, false);
    expect(html).not.toContain('href="/chat"');
    expect(html).toContain('href="/"');
    expect(html).toContain("backendCounts()");
  });
});

describe("renderProvidersPageHtml", () => {
  test("renders the providers page with the cooldown client wired up", () => {
    const html = renderProvidersPageHtml(true);
    expect(html).toContain("<!doctype html>");
    expect(html).toContain('x-data="providersPage()"');
    expect(html).toContain("claude-code-provider-proxy — providers");
    expect(html).toContain("/api/providers/status"); // the live poll endpoint
    expect(html).toContain("No external providers configured.");
    expect(html).toContain("loading…");
    expect(html).toContain("reinstates");
    expect(html).toContain("dd:hh:mm");
    expect(html).toContain("quotaLine");
    expect(html).toContain('href="/providers"'); // active nav link
    expect(html).toContain('href="/chat"'); // chat tab (enabled)
  });

  test("omits the chat tab when the chat page is disabled", () => {
    const html = renderProvidersPageHtml(false);
    expect(html).not.toContain('href="/chat"');
    expect(html).toContain("providersPage()");
    expect(html).toContain("No external providers configured.");
  });
});

describe("buildZip entry-name encoding", () => {
  test("a non-ASCII entry name is embedded as UTF-8 bytes", () => {
    const name = "sessions/café-日本語.json";
    const zip = buildZip([{ name, data: "x" }], new Date(2026, 0, 2, 3, 4, 6));
    expect(zip[0]).toBe(0x50); // 'P'
    expect(zip[1]).toBe(0x4b); // 'K'
    const bytes = Buffer.from(zip);
    expect(bytes.includes(Buffer.from(name, "utf8"))).toBe(true);
    // The name length in the local header (UTF-8 byte count, not UTF-16 units).
    const nameByteLen = new TextEncoder().encode(name).length;
    expect(new DataView(zip.buffer, zip.byteOffset).getUint16(26, true)).toBe(nameByteLen);
  });
});

describe("buildZip round-trips real content through the system unzip", () => {
  test("binary (non-UTF-8) data survives byte-for-byte", async () => {
    const bytes = new Uint8Array(512);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
    const zip = buildZip([{ name: "bin/data.bin", data: bytes }]);

    const dir = mkdtempSync(join(tmpdir(), "ccpp-http-zip-"));
    try {
      const zipPath = join(dir, "out.zip");
      writeFileSync(zipPath, zip);
      const proc = Bun.spawn(["unzip", "-o", zipPath, "-d", dir], {
        stdout: "ignore",
        stderr: "ignore",
      });
      expect(await proc.exited).toBe(0);
      const extracted = readFileSync(join(dir, "bin/data.bin"));
      expect(new Uint8Array(extracted)).toEqual(bytes);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an empty archive is a valid 22-byte end-of-central-directory record", () => {
    const zip = buildZip([]);
    expect(zip.length).toBe(22);
    // EOCD signature 0x06054b50, little-endian.
    const dv = new DataView(zip.buffer, zip.byteOffset);
    expect(dv.getUint32(0, true)).toBe(0x06054b50);
    expect(dv.getUint16(10, true)).toBe(0); // total entries
  });

  test("accepts the entry-count cap and rejects one past it (ZipLimitError)", () => {
    // Our own 50_000 cap is stricter than the uint16 0xffff format max, so it is
    // the one that fires; the thrown message names the effective limit.
    const make = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ name: `f${i}.json`, data: "x" }));
    const atLimit = buildZip(make(50_000));
    expect(atLimit[0]).toBe(0x50);

    try {
      buildZip(make(50_001));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ZipLimitError);
      expect((err as Error).message).toContain("50000");
    }
  });
});
