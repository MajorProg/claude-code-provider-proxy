/**
 * Path P (passthrough) tests — LIVE against real Bedrock. No mocks.
 *
 * Routes a real Claude model through the router, then exercises the passthrough
 * handler end-to-end against bedrock-runtime and bedrock-mantle, asserting the
 * responses are native Anthropic Messages (non-streaming, streaming, count_tokens).
 *
 * Required env: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, (AWS_SESSION_TOKEN).
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { generateShortLivedBedrockToken } from "../src/auth/bedrock-token.ts";
import { type ProxyConfig, validateConfig } from "../src/config.ts";
import { parseCanonicalId } from "../src/model/canonical-id.ts";
import { type Catalog, CatalogManager, createHttpDiscoveryClient } from "../src/model/catalog.ts";
import {
  handlePassthroughCountTokens,
  handlePassthroughMessages,
  withModel,
} from "../src/paths/passthrough.ts";
import { route } from "../src/router.ts";
import { awsCreds, describeLive, liveEnabled } from "./helpers/live.ts";

const CONFIG: ProxyConfig = validateConfig({
  server: { host: "127.0.0.1", port: 8787 },
  inboundAuth: { keys: ["test"] },
  primaryRegion: "us",
  profilePreference: "global",
  refreshIntervalMinutes: 60,
  claudeFallbackToMantle: false,
  regions: [{ key: "us", awsRegion: "us-east-1" }],
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

const inboundHeaders = { get: (n: string) => (n === "anthropic-version" ? "2023-06-01" : null) };

let catalog: Catalog;
let bearer: string;

beforeAll(async () => {
  // Top-level beforeAll runs regardless of describe.skip; no-op in the unit lane.
  if (!liveEnabled()) return;
  const { accessKeyId, secretAccessKey, sessionToken } = awsCreds();
  bearer = await generateShortLivedBedrockToken({
    credentials: { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) },
    region: "us-east-1",
    expiresInSeconds: 900,
  });
  const client = createHttpDiscoveryClient(CONFIG, () => bearer);
  const mgr = await CatalogManager.start(CONFIG, client);
  catalog = mgr.current();
  mgr.stop();

  // Find a Mantle Claude model actually served on the /anthropic/v1/messages
  // route (only the newest Claude generation is — see DESIGN §5.4). Probe once.
  const mantleClaudes = catalog.models.filter((m) => m.backend === "mantle" && m.isAnthropic);
  for (const c of mantleClaudes) {
    const t = route(CONFIG, catalog, parseCanonicalId(`bedrock.mantle.us.${c.nativeModelId}`));
    const res = await handlePassthroughMessages(t, inboundHeaders, bearer, body("ignored")).catch(
      () => null,
    );
    if (res && res.status === 200) {
      await res.body?.cancel().catch(() => {});
      workingMantleClaude = c.nativeModelId;
      break;
    }
  }
  if (!workingMantleClaude) {
    throw new Error("no Mantle Claude model is served on the /anthropic route");
  }
});

let workingMantleClaude: string | undefined;

function body(model: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model,
    max_tokens: 16,
    messages: [{ role: "user", content: "Reply with exactly: PONG" }],
    ...extra,
  };
}

describeLive("Path P passthrough (live Bedrock)", () => {
  test("mantle + Claude: non-streaming returns native Anthropic message", async () => {
    const target = route(
      CONFIG,
      catalog,
      parseCanonicalId(`bedrock.mantle.us.${workingMantleClaude}`),
    );
    const res = await handlePassthroughMessages(target, inboundHeaders, bearer, body("ignored"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.type).toBe("message");
    expect(Array.isArray(json.content)).toBe(true);
  });

  test("mantle + Claude: streaming relays native Anthropic SSE", async () => {
    const target = route(
      CONFIG,
      catalog,
      parseCanonicalId(`bedrock.mantle.us.${workingMantleClaude}`),
    );
    const res = await handlePassthroughMessages(
      target,
      inboundHeaders,
      bearer,
      body("ignored", { stream: true }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("event-stream");
    const text = await res.text();
    expect(text).toContain("event: message_start");
    expect(text).toContain("content_block");
  });

  test("mantle + Claude: count_tokens returns input_tokens", async () => {
    const target = route(
      CONFIG,
      catalog,
      parseCanonicalId(`bedrock.mantle.us.${workingMantleClaude}`),
    );
    const res = await handlePassthroughCountTokens(target, inboundHeaders, bearer, {
      model: "ignored",
      messages: [{ role: "user", content: "count me" }],
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(typeof json.input_tokens).toBe("number");
  });
});

describe("withModel (PC6 targeted rewrite + TC9 no caller mutation)", () => {
  test("rewrites model and drops unsupported top-level fields", () => {
    const body = {
      model: "orig",
      max_tokens: 10,
      context_management: { edits: [] },
      output_config: { format: "json" },
      messages: [{ role: "user", content: "hi" }],
    };
    const out = withModel(body, "resolved-id");
    expect(out.model).toBe("resolved-id");
    expect("context_management" in out).toBe(false);
    expect("output_config" in out).toBe(false);
    expect(out.max_tokens).toBe(10);
    expect(out.messages).toBe(body.messages); // shallow: unchanged refs reused
  });

  test("TC9: does not mutate the caller body (model + stripped fields intact)", () => {
    const body = {
      model: "orig",
      context_management: { edits: [] },
      tools: [{ name: "t", defer_loading: true }],
    };
    const out = withModel(body, "resolved-id");
    // Caller body is untouched.
    expect(body.model).toBe("orig");
    expect("context_management" in body).toBe(true);
    expect((body.tools[0] as Record<string, unknown>).defer_loading).toBe(true);
    // Output is rewritten + stripped.
    expect(out.model).toBe("resolved-id");
    expect("context_management" in out).toBe(false);
    const outTool = (out.tools as Record<string, unknown>[])[0];
    expect(outTool && "defer_loading" in outTool).toBe(false);
  });

  test("no-op strip still clones once to set model (caller body untouched)", () => {
    const body = { model: "orig", messages: [{ role: "user", content: "hi" }] };
    const out = withModel(body, "resolved-id");
    expect(out).not.toBe(body); // a fresh object
    expect(body.model).toBe("orig"); // caller unchanged
    expect(out.model).toBe("resolved-id");
    expect(out.messages).toBe(body.messages); // shallow clone reuses nested refs
  });

  test("strips per-tool defer_loading nested under custom", () => {
    const body = {
      model: "orig",
      tools: [{ name: "t", custom: { defer_loading: true, other: 1 } }],
    };
    const out = withModel(body, "x");
    const custom = (out.tools as Record<string, unknown>[])[0]?.custom as Record<string, unknown>;
    expect("defer_loading" in custom).toBe(false);
    expect(custom.other).toBe(1);
  });
});
