/**
 * Router tests — driven by a REAL catalog discovered from live Bedrock.
 * No mocks: the Catalog is built from live discovery, then routing decisions
 * are asserted against it.
 *
 * Required env: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, (AWS_SESSION_TOKEN).
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { generateShortLivedBedrockToken } from "../src/auth/bedrock-token.ts";
import { type ProxyConfig, validateConfig } from "../src/config.ts";
import { ModelNotFoundError } from "../src/errors.ts";
import { parseCanonicalId } from "../src/model/canonical-id.ts";
import {
  Catalog,
  CatalogManager,
  type DiscoveredModel,
  createHttpDiscoveryClient,
} from "../src/model/catalog.ts";
import { route } from "../src/router.ts";
import { awsCreds, describeLive } from "./helpers/live.ts";

const CONFIG: ProxyConfig = validateConfig({
  server: { host: "127.0.0.1", port: 8787 },
  inboundAuth: { keys: ["test"] },
  primaryRegion: "us",
  profilePreference: "global",
  refreshIntervalMinutes: 60,
  claudeFallbackToMantle: false,
  regions: [
    { key: "us", awsRegion: "us-east-1" },
    { key: "eu", awsRegion: "eu-west-1" },
  ],
  providers: {
    bedrock: {
      credential: "unused",
      hosts: {
        converse: "bedrock-runtime.{region}.amazonaws.com",
        mantle: "bedrock-mantle.{region}.api.aws",
        control: "bedrock.{region}.amazonaws.com",
      },
    },
  },
});

let catalog: Catalog;

describeLive("route (against live catalog)", () => {
  beforeAll(async () => {
    const { accessKeyId, secretAccessKey, sessionToken } = awsCreds();
    const client = createHttpDiscoveryClient(CONFIG, (awsRegion) =>
      generateShortLivedBedrockToken({
        credentials: { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) },
        region: awsRegion,
        expiresInSeconds: 900,
      }),
    );
    const mgr = await CatalogManager.start(CONFIG, client);
    catalog = mgr.current();
    mgr.stop();
  });

  test("converse + Claude -> Path C (Converse translation), NOT passthrough", () => {
    // Pick a real discovered Claude converse model.
    const claude = catalog.models.find((m) => m.backend === "converse" && m.isAnthropic);
    expect(claude).toBeDefined();
    if (!claude) return;
    const id = parseCanonicalId(`bedrock.converse.us.${claude.nativeModelId}`);
    const t = route(CONFIG, catalog, id);
    // The converse backend ALWAYS uses the Converse API — even for Claude.
    expect(t.translationPath).toBe("converse");
    expect(t.origin).toBe("https://bedrock-runtime.us-east-1.amazonaws.com");
    expect(t.path).toContain("/model/");
    expect(t.path).toContain("/converse");
    expect(t.streamPath).toContain("/converse-stream");
    // Claude on converse is inference-profile-only -> resolved to a profile id.
    expect(t.invocationId.startsWith("us.") || t.invocationId.startsWith("global.")).toBe(true);
    expect(t.isAnthropic).toBe(true);
  });

  test("converse + non-Claude -> converse path with /model/{id}/converse", () => {
    const nc = catalog.models.find(
      (m) =>
        m.backend === "converse" && !m.isAnthropic && (m.profiles.length > 0 || m.supportsOnDemand),
    );
    expect(nc).toBeDefined();
    if (!nc) return;
    const id = parseCanonicalId(`bedrock.converse.us.${nc.nativeModelId}`);
    const t = route(CONFIG, catalog, id);
    expect(t.translationPath).toBe("converse");
    expect(t.path).toContain("/model/");
    expect(t.path).toContain("/converse");
    expect(t.streamPath).toContain("/converse-stream");
    expect(t.countTokensPath).toBeUndefined();
    expect(t.isAnthropic).toBe(false);
  });

  test("mantle + non-Claude -> mantle path /v1/chat/completions, bare id", () => {
    const nc = catalog.models.find((m) => m.backend === "mantle" && !m.isAnthropic);
    expect(nc).toBeDefined();
    if (!nc) return;
    const id = parseCanonicalId(`bedrock.mantle.us.${nc.nativeModelId}`);
    const t = route(CONFIG, catalog, id);
    expect(t.translationPath).toBe("mantle");
    expect(t.path).toBe("https://bedrock-mantle.us-east-1.api.aws/v1/chat/completions");
    expect(t.invocationId).toBe(nc.nativeModelId);
  });

  test("global prefix routes to primary region host", () => {
    const claude = catalog.models.find((m) => m.backend === "converse" && m.isAnthropic);
    if (!claude) return;
    const id = parseCanonicalId(`bedrock.converse.global.${claude.nativeModelId}`);
    const t = route(CONFIG, catalog, id);
    expect(t.awsRegion).toBe("us-east-1"); // primaryRegion=us
  });

  test("eu prefix routes to eu-west-1 host", () => {
    const euModel = catalog.models.find((m) => m.regionKey === "eu" && m.backend === "converse");
    if (!euModel) return;
    const id = parseCanonicalId(`bedrock.converse.eu.${euModel.nativeModelId}`);
    const t = route(CONFIG, catalog, id);
    expect(t.origin).toContain("eu-west-1");
  });

  test("unknown model throws ModelNotFoundError", () => {
    const id = parseCanonicalId("bedrock.converse.us.nonexistent.model-v99:0");
    expect(() => route(CONFIG, catalog, id)).toThrow();
  });
});

// ── claudeFallbackToMantle (route-time fallback) ─────────────────────────────
// Hermetic: a fixed Catalog + validateConfig, no live discovery.

const CLAUDE_MODEL = "claude-3-5-sonnet-20241022";
const NONCLAUDE_MODEL = "amazon.nova-lite-v1:0";

/** A converse Claude entry that CANNOT be invoked on Converse. */
const converseClaudeNoProfile: DiscoveredModel = {
  provider: "bedrock",
  awsRegion: "us-east-1",
  regionKey: "us",
  backend: "converse",
  nativeModelId: CLAUDE_MODEL,
  isAnthropic: true,
  supportsOnDemand: false,
  profiles: [],
  streaming: true,
};

const converseNonClaudeNoProfile: DiscoveredModel = {
  provider: "bedrock",
  awsRegion: "us-east-1",
  regionKey: "us",
  backend: "converse",
  nativeModelId: NONCLAUDE_MODEL,
  isAnthropic: false,
  supportsOnDemand: false,
  profiles: [],
  streaming: true,
};

function fbConfig(claudeFallbackToMantle: boolean): ProxyConfig {
  return validateConfig({
    server: { host: "127.0.0.1", port: 8787 },
    inboundAuth: { keys: ["test"] },
    primaryRegion: "us",
    profilePreference: "global",
    refreshIntervalMinutes: 60,
    claudeFallbackToMantle,
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
    },
    logging: { enabled: false },
    chatPage: { enabled: false },
  });
}

describe("route() claudeFallbackToMantle", () => {
  test("flag on + a Claude converse id with no resolvable profile -> mantle passthrough", () => {
    const id = parseCanonicalId(`bedrock.converse.us.${CLAUDE_MODEL}`);
    const t = route(fbConfig(true), new Catalog([converseClaudeNoProfile]), id);
    expect(t.provider).toBe("bedrock");
    expect(t.backend).toBe("mantle");
    expect(t.translationPath).toBe("passthrough");
    expect(t.isAnthropic).toBe(true);
    expect(t.path).toBe("https://bedrock-mantle.us-east-1.api.aws/anthropic/v1/messages");
    expect(t.countTokensPath).toBe(
      "https://bedrock-mantle.us-east-1.api.aws/anthropic/v1/messages/count_tokens",
    );
    // The native id is passed through unchanged (Mantle's route takes bare ids).
    expect(t.invocationId).toBe(CLAUDE_MODEL);
  });

  test("flag on + a Claude converse id absent from the catalog -> mantle passthrough", () => {
    const id = parseCanonicalId(`bedrock.converse.us.${CLAUDE_MODEL}`);
    const t = route(fbConfig(true), new Catalog([]), id);
    expect(t.translationPath).toBe("passthrough");
    expect(t.isAnthropic).toBe(true);
    expect(t.path).toContain("/anthropic/v1/messages");
    expect(t.countTokensPath).toContain("/anthropic/v1/messages/count_tokens");
  });

  test("flag off -> a Claude converse id with no resolvable profile still throws", () => {
    const id = parseCanonicalId(`bedrock.converse.us.${CLAUDE_MODEL}`);
    expect(() => route(fbConfig(false), new Catalog([converseClaudeNoProfile]), id)).toThrow(
      ModelNotFoundError,
    );
    expect(() => route(fbConfig(false), new Catalog([]), id)).toThrow(ModelNotFoundError);
  });

  test("flag on + a NON-Claude model with no profile still throws (isAnthropic gate)", () => {
    const id = parseCanonicalId(`bedrock.converse.us.${NONCLAUDE_MODEL}`);
    // Falling a non-Claude id onto Path M would be a different translation, not
    // a fallback — the gate must keep the ModelNotFoundError.
    expect(() => route(fbConfig(true), new Catalog([converseNonClaudeNoProfile]), id)).toThrow(
      ModelNotFoundError,
    );
    expect(() => route(fbConfig(true), new Catalog([]), id)).toThrow(ModelNotFoundError);
  });
});
