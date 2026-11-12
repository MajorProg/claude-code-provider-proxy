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

  test("ignores non-object entries in tools[]", () => {
    const body = { model: "orig", tools: ["nope", 42, null] };
    const out = withModel(body, "x");
    expect(out.tools).toEqual(["nope", 42, null]);
  });
});

/**
 * Claude Code's inline-tools beta delivers mid-conversation tool changes in a
 * synthetic `role: "system"` message. Third-party Anthropic-compatible providers
 * (DeepSeek, z.ai) accept only part of that shape, so Path P rewrites it when
 * the target is external — see `hoistInlineToolBlocks` in passthrough.ts.
 */
describe("withModel inline-tool normalization (external Anthropic providers)", () => {
  const definition = {
    name: "late_tool",
    description: "added mid-conversation",
    input_schema: { type: "object", properties: {} },
    defer_loading: true,
  };

  const carrier = (content: unknown[]) => ({ role: "system", content });

  test("hoists tool_definition into tools[] and rewrites the addition by reference", () => {
    const body = {
      model: "orig",
      messages: [
        { role: "user", content: "hi" },
        carrier([{ type: "tool_addition", tool: { type: "tool_definition", definition } }]),
      ],
    };
    const out = withModel(body, "resolved", { externalAnthropic: true });

    const tools = out.tools as Record<string, unknown>[];
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("late_tool");
    expect(tools[0] && "defer_loading" in tools[0]).toBe(false);

    const messages = out.messages as Record<string, unknown>[];
    expect(messages).toHaveLength(2);
    expect(messages[1]?.content).toEqual([
      { type: "tool_addition", tool: { type: "tool_reference", name: "late_tool" } },
    ]);

    // TC9: the caller's parsed body is untouched.
    const sent = body.messages[1]?.content[0] as Record<string, unknown>;
    expect((sent.tool as Record<string, unknown>).type).toBe("tool_definition");
    expect(body).not.toHaveProperty("tools");
  });

  test("preserves cache_control on the rewritten addition", () => {
    const block = {
      type: "tool_addition",
      tool: { type: "tool_definition", definition },
      cache_control: { type: "ephemeral" },
    };
    const out = withModel({ model: "orig", messages: [carrier([block])] }, "x", {
      externalAnthropic: true,
    });
    expect((out.messages as Record<string, unknown>[])[0]?.content).toEqual([
      {
        type: "tool_addition",
        tool: { type: "tool_reference", name: "late_tool" },
        cache_control: { type: "ephemeral" },
      },
    ]);
  });

  test("drops tool_removal and the carrier message left empty", () => {
    const body = {
      model: "orig",
      messages: [
        { role: "user", content: "hi" },
        carrier([{ type: "tool_removal", tool: { type: "tool_reference", name: "gone" } }]),
      ],
    };
    const out = withModel(body, "x", { externalAnthropic: true });
    expect((out.messages as unknown[]).length).toBe(1);
    // Nothing was hoisted and there was no tools[] — the field stays absent.
    expect(out.tools).toBeUndefined();
  });

  test("keeps sibling text blocks when a carrier also holds text", () => {
    const body = {
      model: "orig",
      messages: [
        carrier([
          { type: "text", text: "tool update" },
          { type: "tool_removal", tool: { type: "tool_reference", name: "gone" } },
        ]),
      ],
    };
    const out = withModel(body, "x", { externalAnthropic: true });
    expect((out.messages as Record<string, unknown>[])[0]?.content).toEqual([
      { type: "text", text: "tool update" },
    ]);
  });

  test("keeps an existing tools[] and does not redeclare a hoisted name", () => {
    const body = {
      model: "orig",
      tools: [{ name: "late_tool", description: "already declared" }],
      messages: [
        carrier([{ type: "tool_addition", tool: { type: "tool_definition", definition } }]),
      ],
    };
    const out = withModel(body, "x", { externalAnthropic: true });
    const tools = out.tools as Record<string, unknown>[];
    expect(tools).toHaveLength(1);
    expect(tools[0]?.description).toBe("already declared");
    expect((out.messages as Record<string, unknown>[])[0]?.content).toEqual([
      { type: "tool_addition", tool: { type: "tool_reference", name: "late_tool" } },
    ]);
  });

  test("keeps an existing tools[] unchanged when every addition is already declared", () => {
    const body = {
      model: "orig",
      tools: [{ name: "late_tool" }],
      messages: [
        carrier([{ type: "tool_addition", tool: { type: "tool_reference", name: "late_tool" } }]),
      ],
    };
    const out = withModel(body, "x", { externalAnthropic: true });
    expect(out.tools).toEqual([{ name: "late_tool" }]);
    expect((out.messages as Record<string, unknown>[])[0]?.content).toEqual([
      { type: "tool_addition", tool: { type: "tool_reference", name: "late_tool" } },
    ]);
  });

  test("drops unnamed additions and definitions without a usable name", () => {
    const body = {
      model: "orig",
      messages: [
        carrier([
          { type: "tool_addition" },
          {
            type: "tool_addition",
            tool: { type: "tool_definition", definition: { description: "x" } },
          },
          { type: "tool_addition", tool: { type: "tool_definition" } },
        ]),
      ],
    };
    const out = withModel(body, "x", { externalAnthropic: true });
    expect(out.messages).toEqual([]);
    expect(out.tools).toBeUndefined();
  });

  test("hoists each name once (first definition wins)", () => {
    const body = {
      model: "orig",
      messages: [
        carrier([
          { type: "tool_addition", tool: { type: "tool_definition", definition } },
          {
            type: "tool_addition",
            tool: {
              type: "tool_definition",
              definition: { ...definition, description: "second", input_schema: {} },
            },
          },
        ]),
      ],
    };
    const tools = withModel(body, "x", { externalAnthropic: true }).tools as Record<
      string,
      unknown
    >[];
    expect(tools).toHaveLength(1);
    expect(tools[0]?.description).toBe("added mid-conversation");
  });

  test("leaves the request untouched for native Anthropic / Bedrock targets", () => {
    const body = {
      model: "orig",
      messages: [
        carrier([
          { type: "tool_addition", tool: { type: "tool_definition", definition } },
          { type: "tool_removal", tool: { type: "tool_reference", name: "gone" } },
        ]),
      ],
    };
    const out = withModel(body, "resolved");
    expect(out.messages).toBe(body.messages);
    expect(out).not.toHaveProperty("tools");
  });

  test("leaves string content and non-object messages alone", () => {
    const messages = ["nope", null, 7, { role: "user", content: "plain" }];
    const out = withModel({ model: "orig", messages }, "x", { externalAnthropic: true });
    expect(out.messages).toBe(messages);
  });

  test("no inline blocks means no rewrite at all", () => {
    const messages = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
    const out = withModel({ model: "orig", messages }, "x", { externalAnthropic: true });
    expect(out.messages).toBe(messages);
  });

  test("ignores a non-array messages field", () => {
    const out = withModel({ model: "orig", messages: "nope" }, "x", { externalAnthropic: true });
    expect(out.messages).toBe("nope");
  });

  test("ignores unknown block types inside a carrier", () => {
    const block = { type: "mystery" };
    const body = { model: "orig", messages: [carrier([block])] };
    const out = withModel(body, "x", { externalAnthropic: true });
    expect((out.messages as Record<string, unknown>[])[0]?.content).toEqual([block]);
  });
});

/**
 * A `pattern` is compiled by the provider, not by us. DeepSeek rejects a whole
 * request when it meets an escape its engine cannot parse — measured with
 * `agent.mint`'s `^\/[^\0]+$` (`400 … is not a "regex"`) — so Path P rewrites
 * the semantics-preserving `\0` → `\x00` form for external targets.
 */
describe("withModel tool-pattern normalization (external Anthropic providers)", () => {
  const agentMint = {
    name: "agent_mint",
    description: "mint identities",
    input_schema: {
      type: "object",
      properties: {
        out: { type: "string", pattern: "^\\/[^\\0]+$", description: "absolute directory" },
      },
      required: ["out"],
    },
  };

  test("rewrites a bare \\0 escape in a tool pattern to \\x00", () => {
    const body = { model: "orig", tools: [agentMint], messages: [{ role: "user", content: "hi" }] };
    const out = withModel(body, "resolved", { externalAnthropic: true });

    const tools = out.tools as Record<string, unknown>[];
    const schema = tools[0]?.input_schema as Record<string, unknown>;
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(props.out?.pattern).toBe("^\\/[^\\x00]+$");
    // TC9: the caller's parsed body still carries the original pattern.
    expect((agentMint.input_schema.properties.out as Record<string, unknown>).pattern).toBe(
      "^\\/[^\\0]+$",
    );
  });

  test("rewrites nested patterns (items, anyOf) and counts every occurrence", () => {
    const body = {
      model: "orig",
      tools: [
        {
          name: "t",
          input_schema: {
            type: "object",
            properties: {
              list: {
                type: "array",
                items: { type: "string", pattern: "^[^\\0]*$" },
              },
              choice: {
                anyOf: [
                  { type: "string", pattern: "^a\\0$" },
                  { type: "string", pattern: "^b\\0$" },
                ],
              },
            },
          },
        },
      ],
    };
    const out = withModel(body, "x", { externalAnthropic: true });
    const schema = (out.tools as Record<string, unknown>[])[0]?.input_schema as Record<
      string,
      Record<string, unknown>
    >;
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect((props.list?.items as Record<string, unknown>).pattern).toBe("^[^\\x00]*$");
    const branches = (props.choice?.anyOf as Record<string, unknown>[]) ?? [];
    expect(branches.map((b) => b.pattern)).toEqual(["^a\\x00$", "^b\\x00$"]);
  });

  test("leaves an already-portable \\x00 pattern untouched (same refs)", () => {
    const tools = [
      {
        name: "t",
        input_schema: { type: "object", properties: { p: { pattern: "^\\/[^\\x00]+$" } } },
      },
    ];
    const out = withModel({ model: "orig", tools }, "x", { externalAnthropic: true });
    expect(out.tools).toBe(tools);
  });

  test("does not reinterpret an octal-looking \\012 escape", () => {
    const tools = [
      { name: "t", input_schema: { type: "object", properties: { p: { pattern: "^a\\012$" } } } },
    ];
    const out = withModel({ model: "orig", tools }, "x", { externalAnthropic: true });
    expect(out.tools).toBe(tools);
  });

  test("is inert without tools, for a non-array tools field, and for native targets", () => {
    const messages = [{ role: "user", content: "hi" }];
    const noTools = withModel({ model: "orig", messages }, "x", { externalAnthropic: true });
    expect(noTools.tools).toBeUndefined();

    const malformed = withModel({ model: "orig", tools: "nope", messages }, "x", {
      externalAnthropic: true,
    });
    expect(malformed.tools).toBe("nope");

    // Native Anthropic/Bedrock targets keep the original expression.
    const nativeBody = { model: "orig", tools: [agentMint], messages };
    const native = withModel(nativeBody, "x");
    expect(native.tools).toBe(nativeBody.tools);
    const nativeSchema = (native.tools as Record<string, unknown>[])[0]?.input_schema as Record<
      string,
      Record<string, unknown>
    >;
    expect((nativeSchema.properties as Record<string, Record<string, unknown>>).out?.pattern).toBe(
      "^\\/[^\\0]+$",
    );
  });

  test("preserves non-object tool entries and non-string pattern values", () => {
    const tools = ["nope", 7, { name: "t", input_schema: { properties: { p: { pattern: 42 } } } }];
    const out = withModel({ model: "orig", tools }, "x", { externalAnthropic: true });
    expect(out.tools).toEqual(tools);
  });

  test("repairs a definition that arrived inline before it is hoisted", () => {
    const body = {
      model: "orig",
      messages: [
        {
          role: "system",
          content: [
            { type: "tool_addition", tool: { type: "tool_definition", definition: agentMint } },
          ],
        },
      ],
    };
    const out = withModel(body, "x", { externalAnthropic: true });
    const schema = (out.tools as Record<string, unknown>[])[0]?.input_schema as Record<
      string,
      Record<string, unknown>
    >;
    expect((schema.properties as Record<string, Record<string, unknown>>).out?.pattern).toBe(
      "^\\/[^\\x00]+$",
    );
  });
});
