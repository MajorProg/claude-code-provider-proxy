/**
 * Config serialization tests — focus on preserving ${ENV} references on save
 * so a UI save never bakes an env-sourced secret into the file.
 */
import { describe, expect, test } from "bun:test";
import { serializeConfig, validateConfig } from "../src/config.ts";

const ENV = {
  PROXY_INBOUND_KEY: "inbound-secret-abc123",
  BEDROCK_API_KEY: "dev",
  DEEPSEEK_API_KEY: "sk-deepseek-secret-xyz789",
  DASHSCOPE_API_KEY_EU: "sk-ws-eu-secret-longvalue-1234",
  DASHSCOPE_WORKSPACE_ID_EU: "ws-euworkspace9999",
};

function load() {
  // validateConfig receives already-interpolated values (as loadConfig would
  // produce). We simulate that by substituting ENV ourselves.
  const raw = {
    server: { host: "127.0.0.1", port: 8787 },
    inboundAuth: { keys: [ENV.PROXY_INBOUND_KEY] },
    primaryRegion: "us",
    profilePreference: "global",
    refreshIntervalMinutes: 60,
    claudeFallbackToMantle: false,
    regions: [{ key: "us", awsRegion: "us-east-1" }],
    providers: {
      bedrock: {
        credential: ENV.BEDROCK_API_KEY,
        hosts: {
          converse: "bedrock-runtime.{region}.amazonaws.com",
          mantle: "bedrock-mantle.{region}.api.aws",
          control: "bedrock.{region}.amazonaws.com",
        },
      },
      deepseek: {
        type: "anthropic",
        credential: ENV.DEEPSEEK_API_KEY,
        auth: "x-api-key",
        baseUrl: "https://api.deepseek.com/anthropic",
        countTokens: true,
        modelsUrl: "https://api.deepseek.com/v1/models",
      },
      alibaba: {
        type: "anthropic",
        credential: ENV.DASHSCOPE_API_KEY_EU,
        auth: "x-api-key",
        workspaceId: ENV.DASHSCOPE_WORKSPACE_ID_EU,
        hostTemplate: "{workspaceId}.{region}.maas.aliyuncs.com",
        region: "eu-central-1",
        basePath: "/apps/anthropic",
        countTokens: true,
        modelsUrl: `https://${ENV.DASHSCOPE_WORKSPACE_ID_EU}.eu-central-1.maas.aliyuncs.com/compatible-mode/v1/models`,
      },
    },
  };
  return validateConfig(raw);
}

describe("serializeConfig ${ENV} preservation", () => {
  test("with env: secrets are written back as ${VAR} references", () => {
    const out = serializeConfig(load(), ENV);
    const providers = out.providers as Record<string, Record<string, unknown> | undefined>;
    expect(providers.bedrock?.credential).toBe("${BEDROCK_API_KEY}");
    expect(providers.deepseek?.credential).toBe("${DEEPSEEK_API_KEY}");
    expect(providers.alibaba?.credential).toBe("${DASHSCOPE_API_KEY_EU}");
    expect(providers.alibaba?.workspaceId).toBe("${DASHSCOPE_WORKSPACE_ID_EU}");
    // Embedded ref inside a URL is restored too.
    expect(providers.alibaba?.modelsUrl).toBe(
      "https://${DASHSCOPE_WORKSPACE_ID_EU}.eu-central-1.maas.aliyuncs.com/compatible-mode/v1/models",
    );
    // Inbound key too.
    expect((out.inboundAuth as { keys: string[] }).keys[0]).toBe("${PROXY_INBOUND_KEY}");
    // No raw secret leaked into the serialized output.
    const json = JSON.stringify(out);
    expect(json.includes(ENV.DEEPSEEK_API_KEY)).toBe(false);
    expect(json.includes(ENV.DASHSCOPE_API_KEY_EU)).toBe(false);
    expect(json.includes(ENV.PROXY_INBOUND_KEY)).toBe(false);
  });

  test("without env: values are written literally (display path)", () => {
    const out = serializeConfig(load());
    const providers = out.providers as Record<string, Record<string, unknown> | undefined>;
    expect(providers.deepseek?.credential).toBe(ENV.DEEPSEEK_API_KEY);
    expect(providers.alibaba?.workspaceId).toBe(ENV.DASHSCOPE_WORKSPACE_ID_EU);
  });

  test("exact-match works even for short values (e.g. dev sentinel)", () => {
    // "dev" is short but an EXACT match for BEDROCK_API_KEY, so it's safely
    // reverse-mapped to the ref (exact-match can't cause substring collisions).
    const out = serializeConfig(load(), ENV);
    const providers = out.providers as Record<string, Record<string, unknown> | undefined>;
    expect(providers.bedrock?.credential).toBe("${BEDROCK_API_KEY}");
  });
});
