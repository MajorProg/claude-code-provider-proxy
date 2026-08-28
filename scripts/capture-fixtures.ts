/**
 * One-off fixture capture (RUN MANUALLY, needs live creds in .env).
 *
 *   set -a; . ./.env; set +a; bun run scripts/capture-fixtures.ts
 *
 * Drives the REAL translation handlers against live Bedrock, but wraps
 * globalThis.fetch to record the raw *upstream* responses (before translation)
 * to tests/fixtures/. Those fixtures are then replayed by the hermetic
 * *-fixture.test.ts suites via a fetch mock — real data, zero ongoing cost.
 *
 * Captured (upstream = what Bedrock returned, pre-translation):
 *   - converse-text.json         Converse non-streaming JSON body
 *   - converse-tool.json         Converse non-streaming JSON body (tool use)
 *   - converse-stream.b64        Converse streaming binary eventstream (base64)
 *   - openai-text.json           Mantle OpenAI non-streaming JSON body
 *   - openai-tool.json           Mantle OpenAI non-streaming JSON body (tool use)
 *   - openai-stream.sse          Mantle OpenAI streaming SSE text
 *   - anthropic-text.json        Native Anthropic (passthrough) JSON body
 *   - anthropic-stream.sse       Native Anthropic (passthrough) streaming SSE text
 *   - anthropic-count.json       count_tokens JSON body
 *
 * Fixtures are model OUTPUT (no secrets) — safe to commit.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateShortLivedBedrockToken } from "../src/auth/bedrock-token.ts";
import { type ProxyConfig, validateConfig } from "../src/config.ts";
import { parseCanonicalId } from "../src/model/canonical-id.ts";
import { type Catalog, CatalogManager, createHttpDiscoveryClient } from "../src/model/catalog.ts";
import { handleConverseMessages } from "../src/paths/converse.ts";
import { handleMantleMessages } from "../src/paths/mantle.ts";
import {
  handlePassthroughCountTokens,
  handlePassthroughMessages,
} from "../src/paths/passthrough.ts";
import { route } from "../src/router.ts";

const FIX = join(import.meta.dir, "..", "tests", "fixtures");
mkdirSync(FIX, { recursive: true });

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
const realFetch = globalThis.fetch.bind(globalThis);

/**
 * Wrap fetch to save the raw upstream response for one call, then restore.
 * Returns a tee so the handler still consumes the body normally.
 */
async function capture(name: string, kind: "json" | "sse" | "b64", run: () => Promise<unknown>) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await realFetch(input as string, init);
    if (!res.ok || !res.body) return res;
    const [a, b] = res.body.tee();
    // Drain branch `b` to a fixture; hand branch `a` back to the caller.
    void (async () => {
      const reader = b.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          total += value.byteLength;
        }
      }
      const buf = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        buf.set(c, off);
        off += c.byteLength;
      }
      if (kind === "json") {
        writeFileSync(join(FIX, `${name}.json`), new TextDecoder().decode(buf));
      } else if (kind === "sse") {
        writeFileSync(join(FIX, `${name}.sse`), new TextDecoder().decode(buf));
      } else {
        writeFileSync(join(FIX, `${name}.b64`), Buffer.from(buf).toString("base64"));
      }
      console.log(`captured ${name} (${buf.byteLength} bytes)`);
    })();
    return new Response(a, { status: res.status, headers: res.headers });
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = realFetch;
  }
}

async function main() {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) throw new Error("need AWS creds in env");
  const sessionToken = process.env.AWS_SESSION_TOKEN;
  const bearer = await generateShortLivedBedrockToken({
    credentials: { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) },
    region: "us-east-1",
    expiresInSeconds: 900,
  });
  const client = createHttpDiscoveryClient(CONFIG, () => bearer);
  const mgr = await CatalogManager.start(CONFIG, client);
  const catalog: Catalog = mgr.current();
  mgr.stop();

  const nova = catalog.models.find(
    (m) => m.backend === "converse" && /nova-(lite|micro|pro)/.test(m.nativeModelId),
  );
  const mantleModel = catalog.models.find(
    (m) => m.backend === "mantle" && /qwen|glm|gpt-oss|deepseek|kimi/i.test(m.nativeModelId),
  );
  const claude = catalog.models.find((m) => m.backend === "mantle" && m.isAnthropic);
  if (!nova || !mantleModel || !claude) {
    throw new Error(
      `missing models: nova=${nova?.nativeModelId} mantle=${mantleModel?.nativeModelId} claude=${claude?.nativeModelId}`,
    );
  }

  // Catalog models carry no canonicalId; build one as bedrock.<backend>.<regionKey>.<nativeModelId>.
  const cid = (m: (typeof catalog.models)[number]) =>
    `bedrock.${m.backend}.${m.regionKey}.${m.nativeModelId}`;
  const novaRoute = route(CONFIG, catalog, parseCanonicalId(cid(nova)));
  const mantleRoute = route(CONFIG, catalog, parseCanonicalId(cid(mantleModel)));
  const claudeRoute = route(CONFIG, catalog, parseCanonicalId(cid(claude)));

  const textReq = {
    model: "x",
    max_tokens: 128,
    messages: [{ role: "user", content: "Reply with exactly: hello fixture" }],
  };
  const toolReq = {
    model: "x",
    max_tokens: 256,
    tools: [
      {
        name: "get_weather",
        description: "Get weather",
        input_schema: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    ],
    tool_choice: { type: "any" },
    messages: [{ role: "user", content: "What is the weather in Berlin? Use the tool." }],
  };

  // --- Converse (Path C) ---
  await capture("converse-text", "json", () => handleConverseMessages(novaRoute, bearer, textReq));
  await capture("converse-tool", "json", () => handleConverseMessages(novaRoute, bearer, toolReq));
  await capture("converse-stream", "b64", async () => {
    const res = await handleConverseMessages(novaRoute, bearer, { ...textReq, stream: true });
    await new Response(res.body).text(); // drain client branch
  });

  // --- Mantle OpenAI (Path M) ---
  await capture("openai-text", "json", () => handleMantleMessages(mantleRoute, bearer, textReq));
  await capture("openai-tool", "json", () => handleMantleMessages(mantleRoute, bearer, toolReq));
  await capture("openai-stream", "sse", async () => {
    const res = await handleMantleMessages(mantleRoute, bearer, { ...textReq, stream: true });
    await new Response(res.body).text();
  });

  // --- Native Anthropic passthrough (Path P) ---
  await capture("anthropic-text", "json", () =>
    handlePassthroughMessages(claudeRoute, inboundHeaders, bearer, textReq),
  );
  await capture("anthropic-stream", "sse", async () => {
    const res = await handlePassthroughMessages(claudeRoute, inboundHeaders, bearer, {
      ...textReq,
      stream: true,
    });
    await new Response(res.body).text();
  });
  await capture("anthropic-count", "json", () =>
    handlePassthroughCountTokens(claudeRoute, inboundHeaders, bearer, {
      model: "x",
      messages: [{ role: "user", content: "Reply with exactly: hello fixture" }],
    }),
  );

  // Let the tee-drain tasks flush.
  await new Promise((r) => setTimeout(r, 500));
  console.log("done. Fixtures in tests/fixtures/");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
