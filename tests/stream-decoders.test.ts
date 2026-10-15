/**
 * Byte-stream decoder parity tests (Task 10): feeding a stream in many small
 * chunks must produce exactly the same frames/lines as a single-shot decode.
 * This locks in the O(L) read-cursor / tail-carry rewrites against regressions.
 *
 * Also carries the upstream-resilience tests for Workstream A (A2 non-streaming
 * no-replay, A3 redirect SSRF guard) — the postJson/path boundary at the head of
 * every translated stream.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { UpstreamError } from "../src/errors.ts";
import { UpstreamRedirectError, postJson } from "../src/http/upstream.ts";
import { handlePassthroughMessages } from "../src/paths/passthrough.ts";
import type { RouteTarget } from "../src/router.ts";
import { EventStreamDecoder, converseStreamToAnthropicSse } from "../src/stream/converse-events.ts";
import {
  SseLineParser,
  deltaContentToText,
  openAiStreamToAnthropicSse,
} from "../src/stream/openai-sse.ts";

/** Restore the real fetch after every test that stubs the network boundary. */
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Build one vnd.amazon.eventstream frame with a `:event-type` header + JSON
 *  payload. CRCs are zeroed (the decoder does not validate them). */
function encodeFrame(eventType: string, payload: unknown): Uint8Array {
  const enc = new TextEncoder();
  const nameBytes = enc.encode(":event-type");
  const valueBytes = enc.encode(eventType);
  // header: [1B nameLen][name][1B type=7][2B valueLen][value]
  const headerLen = 1 + nameBytes.length + 1 + 2 + valueBytes.length;
  const payloadBytes = enc.encode(JSON.stringify(payload));
  const totalLen = 4 + 4 + 4 + headerLen + payloadBytes.length + 4;
  const buf = new Uint8Array(totalLen);
  const dv = new DataView(buf.buffer);
  let o = 0;
  dv.setUint32(o, totalLen);
  o += 4;
  dv.setUint32(o, headerLen);
  o += 4;
  dv.setUint32(o, 0); // prelude CRC (ignored)
  o += 4;
  // header
  buf[o++] = nameBytes.length;
  buf.set(nameBytes, o);
  o += nameBytes.length;
  buf[o++] = 7; // string type
  dv.setUint16(o, valueBytes.length);
  o += 2;
  buf.set(valueBytes, o);
  o += valueBytes.length;
  // payload
  buf.set(payloadBytes, o);
  o += payloadBytes.length;
  dv.setUint32(o, 0); // message CRC (ignored)
  return buf;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

describe("EventStreamDecoder chunk-parity", () => {
  test("many 1-byte chunks decode to the same frames as one shot", () => {
    const frames = [
      encodeFrame("messageStart", { role: "assistant" }),
      encodeFrame("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "héllo 🌍" } }),
      encodeFrame("contentBlockDelta", { contentBlockIndex: 0, delta: { text: " world" } }),
      encodeFrame("messageStop", { stopReason: "end_turn" }),
    ];
    const whole = concat(frames);

    // Single-shot decode.
    const single = new EventStreamDecoder().push(whole);

    // Byte-by-byte decode.
    const drip = new EventStreamDecoder();
    const collected: { eventType: string; payload: unknown }[] = [];
    for (let i = 0; i < whole.length; i++) {
      collected.push(...drip.push(whole.subarray(i, i + 1)));
    }

    expect(collected.length).toBe(single.length);
    expect(JSON.stringify(collected)).toBe(JSON.stringify(single));
    // Sanity: we actually decoded the 4 frames.
    expect(single.map((f) => f.eventType)).toEqual([
      "messageStart",
      "contentBlockDelta",
      "contentBlockDelta",
      "messageStop",
    ]);
  });
});

describe("SseLineParser SR7 raw-buffer guard", () => {
  test("throws when a single chunk with no newline exceeds the buffer cap", () => {
    const parser = new SseLineParser();
    // 16 MiB cap — a 17 MiB no-newline chunk must trip the guard rather than
    // buffer unbounded.
    const huge = new TextEncoder().encode("x".repeat(17 * 1024 * 1024));
    expect(() => parser.push(huge)).toThrow(/without a line terminator/);
  });

  test("a normal small event is unaffected by the guard", () => {
    const parser = new SseLineParser();
    const out = parser.push(new TextEncoder().encode('data: {"a":1}\n\n'));
    expect(out).toEqual(['{"a":1}']);
  });
});

describe("SseLineParser chunk-parity", () => {
  test("arbitrary chunk boundaries yield the same data payloads (SR6 spec framing)", () => {
    const enc = new TextEncoder();
    // Real Mantle framing: each event terminated by a blank line. Includes a
    // comment line (ignored) and a multi-line data: event (joined with \n).
    const text =
      'data: {"a":1}\n\n' +
      ": heartbeat comment\n\n" +
      "data: line1\ndata: line2\n\n" +
      "data: [DONE]\n\n";
    const bytes = enc.encode(text);

    const single = new SseLineParser().push(bytes);

    // Feed in 3-byte chunks.
    const drip = new SseLineParser();
    const collected: string[] = [];
    for (let i = 0; i < bytes.length; i += 3) {
      collected.push(...drip.push(bytes.subarray(i, i + 3)));
    }

    expect(collected).toEqual(single);
    // A multi-line data: event is joined with \n; the comment line is ignored.
    expect(single).toEqual(['{"a":1}', "line1\nline2", "[DONE]"]);
  });

  test("SR6: flush() emits a final event that lacks a trailing blank line", () => {
    const enc = new TextEncoder();
    const p = new SseLineParser();
    // A stream that ends right after the last data: line (no terminating \n\n).
    const pushed = p.push(enc.encode('data: {"a":1}\n\ndata: {"b":2}'));
    expect(pushed).toEqual(['{"a":1}']); // only the terminated event so far
    expect(p.flush()).toEqual(['{"b":2}']); // the dangling final event
    expect(p.flush()).toEqual([]); // idempotent — nothing left
  });
});

describe("EventStreamDecoder malformed-frame handling", () => {
  test("a frame with a non-JSON payload decodes to an empty payload (not a throw)", () => {
    // Hand-build a frame whose payload bytes are not valid JSON.
    const enc = new TextEncoder();
    const nameBytes = enc.encode(":event-type");
    const valueBytes = enc.encode("contentBlockDelta");
    const headerLen = 1 + nameBytes.length + 1 + 2 + valueBytes.length;
    const payloadBytes = enc.encode("this is not json{");
    const totalLen = 4 + 4 + 4 + headerLen + payloadBytes.length + 4;
    const buf = new Uint8Array(totalLen);
    const dv = new DataView(buf.buffer);
    let o = 0;
    dv.setUint32(o, totalLen);
    o += 4;
    dv.setUint32(o, headerLen);
    o += 4;
    dv.setUint32(o, 0);
    o += 4;
    buf[o++] = nameBytes.length;
    buf.set(nameBytes, o);
    o += nameBytes.length;
    buf[o++] = 7;
    dv.setUint16(o, valueBytes.length);
    o += 2;
    buf.set(valueBytes, o);
    o += valueBytes.length;
    buf.set(payloadBytes, o);

    const frames = new EventStreamDecoder().push(buf);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.eventType).toBe("contentBlockDelta");
    // Malformed payload is tolerated -> empty object, stream continues.
    expect(frames[0]?.payload).toEqual({});
  });

  test("a corrupt totalLen is dropped without an infinite loop", () => {
    // totalLen < 16 is treated as corrupt framing: the decoder bails.
    const buf = new Uint8Array(16);
    new DataView(buf.buffer).setUint32(0, 4); // absurd totalLen
    const frames = new EventStreamDecoder().push(buf);
    expect(frames).toEqual([]);
  });

  test("a partial frame is buffered until the remaining bytes arrive", () => {
    const full = encodeFrame("messageStart", { role: "assistant" });
    const dec = new EventStreamDecoder();
    // First half: no complete frame yet.
    expect(dec.push(full.subarray(0, full.length - 4))).toEqual([]);
    // Remaining bytes complete the frame.
    const frames = dec.push(full.subarray(full.length - 4));
    expect(frames).toHaveLength(1);
    expect(frames[0]?.eventType).toBe("messageStart");
  });
});

describe("EventStreamDecoder header-scan (SR10)", () => {
  /**
   * Build a frame whose header block contains, in order:
   *   - a bool-true header (type 0, 0-byte value),
   *   - a timestamp header (type 8, 8-byte value),
   *   - a byte header (type 2, 1-byte value),
   *   - then the `:event-type` string header (type 7).
   * The old scanner aborted on the first non-string header and dropped the
   * whole frame; the fixed scanner must skip each by its correct length and
   * still find `:event-type`.
   */
  function encodeFrameWithLeadingNonStringHeaders(eventType: string, payload: unknown): Uint8Array {
    const enc = new TextEncoder();
    const headerChunks: number[] = [];
    const pushName = (name: string) => {
      const nb = enc.encode(name);
      headerChunks.push(nb.length, ...nb);
    };
    // :bool header, type 0 (true), no value bytes.
    pushName(":bool");
    headerChunks.push(0);
    // :date header, type 8 (timestamp), 8 value bytes.
    pushName(":date");
    headerChunks.push(8, 0, 0, 0, 0, 0, 0, 0, 0);
    // :b header, type 2 (byte), 1 value byte.
    pushName(":b");
    headerChunks.push(2, 0xff);
    // :event-type header, type 7 (string), 2-byte length prefix + value.
    const nb = enc.encode(":event-type");
    const vb = enc.encode(eventType);
    headerChunks.push(nb.length, ...nb, 7, (vb.length >> 8) & 0xff, vb.length & 0xff, ...vb);

    const headerBytes = Uint8Array.from(headerChunks);
    const payloadBytes = enc.encode(JSON.stringify(payload));
    const totalLen = 4 + 4 + 4 + headerBytes.length + payloadBytes.length + 4;
    const buf = new Uint8Array(totalLen);
    const dv = new DataView(buf.buffer);
    let o = 0;
    dv.setUint32(o, totalLen);
    o += 4;
    dv.setUint32(o, headerBytes.length);
    o += 4;
    dv.setUint32(o, 0);
    o += 4;
    buf.set(headerBytes, o);
    o += headerBytes.length;
    buf.set(payloadBytes, o);
    o += payloadBytes.length;
    dv.setUint32(o, 0);
    return buf;
  }

  test("non-string headers before :event-type do NOT drop the frame", () => {
    const buf = encodeFrameWithLeadingNonStringHeaders("contentBlockDelta", {
      contentBlockIndex: 0,
      delta: { text: "kept" },
    });
    const frames = new EventStreamDecoder().push(buf);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.eventType).toBe("contentBlockDelta");
    expect(frames[0]?.payload).toEqual({ contentBlockIndex: 0, delta: { text: "kept" } });
  });
});

describe("deltaContentToText (SR5 array-form delta.content)", () => {
  test("returns a string delta verbatim", () => {
    expect(deltaContentToText("hello")).toBe("hello");
  });

  test("concatenates the text of array-form content parts", () => {
    expect(
      deltaContentToText([
        { type: "text", text: "foo" },
        { type: "text", text: "bar" },
      ]),
    ).toBe("foobar");
  });

  test("ignores non-text parts and missing text fields", () => {
    expect(deltaContentToText([{ type: "image_url" }, { type: "text", text: "ok" }] as never)).toBe(
      "ok",
    );
  });

  test("null/undefined content yields empty string", () => {
    expect(deltaContentToText(null)).toBe("");
    expect(deltaContentToText(undefined)).toBe("");
  });
});

describe("openAiStreamToAnthropicSse G5 interleave ordering", () => {
  test("text + tool_call in one chunk: text block closes before the tool_use opens", async () => {
    const enc = new TextEncoder();
    const chunks = [
      // One chunk carrying BOTH text content and a tool_call.
      'data: {"choices":[{"delta":{"role":"assistant","content":"Let me check.","tool_calls":[{"index":0,"id":"call_1","function":{"name":"lookup","arguments":"{\\"q\\":1}"}}]},"index":0}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls","index":0}]}\n\n',
      "data: [DONE]\n\n",
    ];
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const ch of chunks) c.enqueue(enc.encode(ch));
        c.close();
      },
    });
    const sse = openAiStreamToAnthropicSse(body, "m");
    const dec = new TextDecoder();
    let out = "";
    const rd = sse.getReader();
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      out += dec.decode(value, { stream: true });
    }
    // Both the text and the tool_use are present.
    expect(out).toContain("Let me check.");
    expect(out).toContain('"type":"tool_use"');
    // Ordering: text content_block_start, then its stop, THEN the tool block start.
    const textStart = out.indexOf('"content_block":{"type":"text"');
    const toolStart = out.indexOf('"content_block":{"type":"tool_use"');
    const firstStopAfterText = out.indexOf('"type":"content_block_stop"', textStart);
    expect(textStart).toBeGreaterThanOrEqual(0);
    expect(toolStart).toBeGreaterThan(textStart);
    expect(firstStopAfterText).toBeGreaterThan(textStart);
    expect(firstStopAfterText).toBeLessThan(toolStart); // text stopped before tool opens
  });
});

describe("openAiStreamToAnthropicSse SR11 late-delta ordering", () => {
  test("a text delta after tool_calls + finish_reason does not reopen text after tool_use", async () => {
    const enc = new TextEncoder();
    const chunks = [
      'data: {"choices":[{"delta":{"role":"assistant"},"index":0}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"f","arguments":"{}"}}]},"index":0}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls","index":0}]}\n\n',
      // LATE trailing text delta after finish_reason — must be ignored (SR11).
      'data: {"choices":[{"delta":{"content":"late trailing text"},"index":0}]}\n\n',
      "data: [DONE]\n\n",
    ];
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const ch of chunks) c.enqueue(enc.encode(ch));
        c.close();
      },
    });
    const sse = openAiStreamToAnthropicSse(body, "m");
    const dec = new TextDecoder();
    let out = "";
    const rd = sse.getReader();
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      out += dec.decode(value, { stream: true });
    }
    // The tool_use block is present; the late text must NOT appear, and no text
    // content_block_start may follow the tool_use block.
    expect(out).toContain('"type":"tool_use"');
    expect(out).not.toContain("late trailing text");
    const toolIdx = out.indexOf('"type":"tool_use"');
    const textAfter = out.indexOf('"type":"text"', toolIdx);
    expect(textAfter).toBe(-1);
  });
});

describe("openAiStreamToAnthropicSse PC7 usage fallback", () => {
  test("estimates output_tokens from content when the stream omits usage", async () => {
    // Real OpenAI chunk framing (data: {...}\n\n per event), with content but
    // NO usage object anywhere — exercises the PC7 fallback estimate.
    const enc = new TextEncoder();
    const chunks = [
      'data: {"choices":[{"delta":{"role":"assistant","content":""},"finish_reason":null,"index":0}]}\n\n',
      'data: {"choices":[{"delta":{"content":"Hello there, this is a reply."},"finish_reason":null,"index":0}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}\n\n',
      "data: [DONE]\n\n",
    ];
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const ch of chunks) c.enqueue(enc.encode(ch));
        c.close();
      },
    });
    const sse = openAiStreamToAnthropicSse(body, "test-model");
    const dec = new TextDecoder();
    let out = "";
    const rd = sse.getReader();
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      out += dec.decode(value, { stream: true });
    }
    // The final message_delta usage must carry a non-zero estimated output
    // ("Hello there, this is a reply." = 29 chars -> ceil(29/4) = 8 tokens).
    const deltaMatch = out.match(/"usage":\{"output_tokens":(\d+),"input_tokens":\d+\}/);
    expect(deltaMatch).not.toBeNull();
    expect(Number(deltaMatch?.[1])).toBe(8);
  });
});

// Cached-input normalization: the Anthropic-facing stream must report
// input_tokens EXCLUDING the cached subset (OpenAI-wire prompt_tokens includes
// it) while cache_read_input_tokens carries the cached count.
describe("openAiStreamToAnthropicSse cached-input normalization", () => {
  async function drainCached(chunks: string[]): Promise<string> {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const ch of chunks) c.enqueue(enc.encode(ch));
        c.close();
      },
    });
    const sse = openAiStreamToAnthropicSse(body, "m");
    const dec = new TextDecoder();
    let out = "";
    const rd = sse.getReader();
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      out += dec.decode(value, { stream: true });
    }
    return out;
  }

  test("final message_delta reports input minus cached + cache_read counter", async () => {
    const out = await drainCached([
      'data: {"choices":[{"delta":{"content":"hi"},"index":0}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":1700,"completion_tokens":7,"prompt_tokens_details":{"cached_tokens":1650}}}\n\n',
      "data: [DONE]\n\n",
    ]);
    const deltaLine = out
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .filter((p) => p.startsWith("{") && p.includes('"message_delta"'))
      .map((p) => JSON.parse(p) as { usage?: Record<string, unknown> })
      .pop();
    expect(deltaLine?.usage).toMatchObject({
      input_tokens: 50, // 1700 - 1650 (Anthropic semantics)
      output_tokens: 7,
      cache_read_input_tokens: 1650,
    });
  });

  test("a stream without cached_tokens reports input unchanged", async () => {
    const out = await drainCached([
      'data: {"choices":[{"delta":{"content":"hi"},"index":0}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":1700,"completion_tokens":7}}\n\n',
      "data: [DONE]\n\n",
    ]);
    const deltaLine = out
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .filter((p) => p.startsWith("{") && p.includes('"message_delta"'))
      .map((p) => JSON.parse(p) as { usage?: Record<string, unknown> })
      .pop();
    expect(deltaLine?.usage).toMatchObject({ input_tokens: 1700, output_tokens: 7 });
  });
});

// zai error finish_reasons → typed error events (zaiWire providers only).
describe("openAiStreamToAnthropicSse zai error finish_reasons", () => {
  async function drainZai(chunks: string[], zaiStreamErrors: boolean): Promise<string> {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const ch of chunks) c.enqueue(enc.encode(ch));
        c.close();
      },
    });
    const sse = openAiStreamToAnthropicSse(body, "glm-5.3-flash", 0, zaiStreamErrors);
    const dec = new TextDecoder();
    let out = "";
    const rd = sse.getReader();
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      out += dec.decode(value, { stream: true });
    }
    return out;
  }

  test("network_error → api_error error event; partial content flushed; no message_stop", async () => {
    const out = await drainZai(
      [
        'data: {"choices":[{"delta":{"content":"par"},"index":0}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"network_error","index":0}]}\n\n',
        "data: [DONE]\n\n",
      ],
      true,
    );
    expect(out).toContain("event: error");
    expect(out).toContain("network_error");
    expect(out).toContain('"type":"api_error"');
    expect(out).toContain("par");
    expect(out).not.toContain("event: message_stop");
  });

  test("sensitive → invalid_request_error error event (non-retriable refusal)", async () => {
    const out = await drainZai(
      [
        'data: {"choices":[{"delta":{},"finish_reason":"sensitive","index":0}]}\n\n',
        "data: [DONE]\n\n",
      ],
      true,
    );
    expect(out).toContain("event: error");
    expect(out).toContain("sensitive");
    expect(out).toContain('"type":"invalid_request_error"');
  });

  test("model_context_window_exceeded → request_too_large error event", async () => {
    const out = await drainZai(
      [
        'data: {"choices":[{"delta":{},"finish_reason":"model_context_window_exceeded","index":0}]}\n\n',
        "data: [DONE]\n\n",
      ],
      true,
    );
    expect(out).toContain("event: error");
    expect(out).toContain("model_context_window_exceeded");
    expect(out).toContain('"type":"request_too_large"');
  });

  test("flag OFF keeps the generic mapper behavior (end_turn, no error event)", async () => {
    const out = await drainZai(
      [
        'data: {"choices":[{"delta":{"content":"par"},"index":0}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"network_error","index":0}]}\n\n',
        "data: [DONE]\n\n",
      ],
      false,
    );
    expect(out).not.toContain("event: error");
    expect(out).toContain("event: message_stop");
    expect(out).toContain('"stop_reason":"end_turn"');
  });
});

/* --- Workstream A: upstream HTTP resilience ------------------------------- */

// A3: a mocked 302 (e.g. pointing at the cloud metadata service) must NOT be
// followed. postJson issues every request with `redirect: "manual"` and refuses
// a 3xx — exactly one upstream request, and the caller surfaces a clear error
// instead of the redirect target's body.
describe("postJson redirect SSRF guard (A3)", () => {
  test("a 302 is refused, not followed: one request + a clear error", async () => {
    let calls = 0;
    let redirectMode: RequestInit["redirect"];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      calls++;
      redirectMode = init?.redirect;
      return new Response("169.254.169.254 metadata", {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data/" },
      });
    }) as typeof fetch;

    await expect(postJson("https://api.example.test/v1/messages", {}, "{}")).rejects.toBeInstanceOf(
      UpstreamRedirectError,
    );
    // Never re-issued (not retried) and never followed (one fetch only).
    expect(calls).toBe(1);
    // The guard is enforced at the transport layer, for every postJson caller.
    expect(redirectMode).toBe("manual");
  });

  test("the refused redirect names the Location in the error message", async () => {
    globalThis.fetch = (async () =>
      new Response("", {
        status: 301,
        headers: { location: "https://10.0.0.5/internal" },
      })) as typeof fetch;
    await expect(postJson("https://api.example.test/x", {}, "{}")).rejects.toThrow(
      /redirects are not followed/,
    );
  });
});

// A2 (PC2, uniform): a message body is never replayed on a status code. The
// passthrough handler now passes retryTransientStatus:false on its NON-streaming
// call too, so a 502 yields exactly ONE upstream request (a replay would be a
// second, double-billed generation). assertUpstreamOk then throws a clear error.
describe("non-streaming message body is not replayed on a 5xx (A2)", () => {
  const target: RouteTarget = {
    provider: "bedrock",
    backend: "mantle",
    translationPath: "passthrough",
    awsRegion: "us-east-1",
    origin: "https://bedrock-runtime.us-east-1.amazonaws.com",
    path: "/anthropic/v1/messages",
    streamPath: "/anthropic/v1/messages",
    countTokensPath: undefined,
    invocationId: "us.anthropic.claude-x-v1:0",
    isAnthropic: true,
  };
  const inbound = { get: (n: string) => (n === "anthropic-version" ? "2023-06-01" : null) };

  test("a non-streaming 502 produces exactly ONE upstream request", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(
        JSON.stringify({ type: "error", error: { type: "api_error", message: "bad gateway" } }),
        { status: 502, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    await expect(
      handlePassthroughMessages(target, inbound, "tok", {
        model: "irrelevant",
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toBeInstanceOf(UpstreamError);
    // The 502 is relayed, NOT replayed — one fetch, not maxRetries+1.
    expect(calls).toBe(1);
  });

  test("a non-streaming 200 still relays normally (one request)", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ id: "msg_1", type: "message", content: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const res = await handlePassthroughMessages(target, inbound, "tok", {
      model: "irrelevant",
      max_tokens: 16,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(200);
    expect(calls).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * G3: multi-chunk tool-call reassembly on BOTH translation paths.
 *
 * The existing hermetic OpenAI-wire tests pass a COMPLETE argument string in a
 * SINGLE chunk, so the fragment-concatenation logic never runs; the Converse
 * fixture carries no toolUse frame at all. Real providers split tool arguments
 * across many chunks (e.g. {"ci / ty":"Ber / lin"), which is exactly where an
 * off-by-one or a dropped delta silently corrupts a tool call. These tests
 * drive the REAL decoders with split arguments.
 * ------------------------------------------------------------------ */

interface ParsedSseEvent {
  event: string;
  data: Record<string, unknown>;
}

/** Parse an Anthropic SSE stream into its (event, data) pairs. */
function parseSseEvents(sse: string): ParsedSseEvent[] {
  const events: ParsedSseEvent[] = [];
  for (const block of sse.split("\n\n")) {
    let event: string | undefined;
    let data: string | undefined;
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) data = line.slice(6);
    }
    if (event === undefined || data === undefined) continue;
    events.push({ event, data: JSON.parse(data) as Record<string, unknown> });
  }
  return events;
}

/** tool_use `content_block_start` events, in emitted order. */
function toolUseStarts(events: ParsedSseEvent[]): ParsedSseEvent[] {
  return events.filter(
    (e) =>
      e.event === "content_block_start" &&
      (e.data.content_block as { type?: string } | undefined)?.type === "tool_use",
  );
}

/** Concatenate `input_json_delta` partials per content-block index. */
function inputJsonByBlock(events: ParsedSseEvent[]): Map<number, string> {
  const byBlock = new Map<number, string>();
  for (const e of events) {
    if (e.event !== "content_block_delta") continue;
    const delta = e.data.delta as { type?: string; partial_json?: string } | undefined;
    if (delta?.type !== "input_json_delta" || typeof delta.partial_json !== "string") continue;
    const idx = e.data.index as number;
    byBlock.set(idx, (byBlock.get(idx) ?? "") + delta.partial_json);
  }
  return byBlock;
}

/** Count `input_json_delta` fragments per content-block index. */
function inputJsonDeltaCounts(events: ParsedSseEvent[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const e of events) {
    if (e.event !== "content_block_delta") continue;
    const delta = e.data.delta as { type?: string } | undefined;
    if (delta?.type !== "input_json_delta") continue;
    const idx = e.data.index as number;
    counts.set(idx, (counts.get(idx) ?? 0) + 1);
  }
  return counts;
}

/** Drain a ReadableStream<Uint8Array> to a UTF-8 string. */
async function drainStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const dec = new TextDecoder();
  let out = "";
  const rd = stream.getReader();
  for (;;) {
    const { done, value } = await rd.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  return out;
}

describe("openAiStreamToAnthropicSse multi-chunk tool-call reassembly (G3)", () => {
  test("three split fragments for tool 0 + a second tool 1 -> ordered blocks, joined JSON", async () => {
    const enc = new TextEncoder();
    const chunks = [
      // First fragment carries id + name + the argument START.
      'data: {"choices":[{"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"get_weather","arguments":"{\\"ci"}}]},"index":0}]}\n\n',
      // Subsequent fragments carry ONLY index + a piece of the argument string.
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ty\\":\\"Ber"}}]},"index":0}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"lin\\"}"}}]},"index":0}]}\n\n',
      // A second tool at OpenAI index 1.
      'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_b","type":"function","function":{"name":"get_time","arguments":"{\\"tz\\":\\"UTC\\"}"}}]},"index":0}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls","index":0}]}\n\n',
      "data: [DONE]\n\n",
    ];
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const ch of chunks) c.enqueue(enc.encode(ch));
        c.close();
      },
    });
    const out = await drainStream(openAiStreamToAnthropicSse(body, "m"));
    const events = parseSseEvents(out);

    // Two distinct tool_use blocks, in index order.
    const starts = toolUseStarts(events);
    expect(starts).toHaveLength(2);
    expect(starts.map((s) => s.data.index)).toEqual([0, 1]);
    expect(starts.map((s) => (s.data.content_block as { name: string }).name)).toEqual([
      "get_weather",
      "get_time",
    ]);

    // The split fragments concatenate to the full tool input JSON.
    const joined = inputJsonByBlock(events);
    expect(joined.get(0)).toBe('{"city":"Berlin"}');
    expect(joined.get(1)).toBe('{"tz":"UTC"}');
    // Block 0 received THREE separate partials (a dropped/merged delta would
    // still concatenate here only if the text were intact — assert the count too).
    expect(inputJsonDeltaCounts(events).get(0)).toBe(3);
  });
});

describe("converseStreamToAnthropicSse multi-chunk tool-call reassembly (G3)", () => {
  test("contentBlockStart/Delta/Stop frames reassemble split tool arguments", async () => {
    // NOTE: these frames are CONSTRUCTED here (the hermetic lane has no live
    // Bedrock creds) with the `encodeFrame` helper above, using the documented
    // vnd.amazon.eventstream wire format. They exercise the REAL decoder +
    // bridge; a live `bun run test:capture` re-capture of a toolUse stream is the
    // follow-up that replaces this with captured bytes.
    const frames = [
      encodeFrame("messageStart", { role: "assistant" }),
      encodeFrame("contentBlockStart", {
        contentBlockIndex: 0,
        start: { toolUse: { toolUseId: "toolu_1", name: "get_weather" } },
      }),
      encodeFrame("contentBlockDelta", {
        contentBlockIndex: 0,
        delta: { toolUse: { input: '{"ci' } },
      }),
      encodeFrame("contentBlockDelta", {
        contentBlockIndex: 0,
        delta: { toolUse: { input: 'ty":"Ber' } },
      }),
      encodeFrame("contentBlockDelta", {
        contentBlockIndex: 0,
        delta: { toolUse: { input: 'lin"}' } },
      }),
      encodeFrame("contentBlockStop", { contentBlockIndex: 0 }),
      encodeFrame("contentBlockStart", {
        contentBlockIndex: 1,
        start: { toolUse: { toolUseId: "toolu_2", name: "get_time" } },
      }),
      encodeFrame("contentBlockDelta", {
        contentBlockIndex: 1,
        delta: { toolUse: { input: '{"tz":"UTC"}' } },
      }),
      encodeFrame("contentBlockStop", { contentBlockIndex: 1 }),
      encodeFrame("messageStop", { stopReason: "tool_use" }),
      encodeFrame("metadata", { usage: { inputTokens: 11, outputTokens: 7 } }),
    ];
    // Feed in 7-byte chunks so the decoder must reassemble whole frames — and
    // the bridge its argument fragments — across chunk boundaries.
    const whole = concat(frames);
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < whole.length; i += 7) c.enqueue(whole.subarray(i, i + 7));
        c.close();
      },
    });
    const out = await drainStream(converseStreamToAnthropicSse(body, "m"));
    const events = parseSseEvents(out);

    const starts = toolUseStarts(events);
    expect(starts).toHaveLength(2);
    expect(starts.map((s) => s.data.index)).toEqual([0, 1]);
    expect(starts.map((s) => (s.data.content_block as { name: string }).name)).toEqual([
      "get_weather",
      "get_time",
    ]);
    const joined = inputJsonByBlock(events);
    expect(joined.get(0)).toBe('{"city":"Berlin"}');
    expect(joined.get(1)).toBe('{"tz":"UTC"}');
    expect(inputJsonDeltaCounts(events).get(0)).toBe(3);
  });
});

/* ------------------------------------------------------------------ *
 * G5: cached-input normalization on REALISTIC framing + the clamp.
 * OpenAI-wire prompt_tokens INCLUDES the cached subset; the Anthropic face
 * must report input_tokens EXCLUDING it. The subtraction must hold when the
 * stream is split across chunk boundaries, and must clamp at 0 (never go
 * negative) when a provider reports cached_tokens > prompt_tokens.
 * ------------------------------------------------------------------ */

describe("openAiStreamToAnthropicSse cached-input framing + clamp (G5)", () => {
  async function drainChunked(text: string, chunkSize: number): Promise<string> {
    const bytes = new TextEncoder().encode(text);
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < bytes.length; i += chunkSize) {
          c.enqueue(bytes.subarray(i, i + chunkSize));
        }
        c.close();
      },
    });
    return drainStream(openAiStreamToAnthropicSse(body, "m"));
  }

  /** The terminal message_delta's usage object (last message_delta wins). */
  function finalUsage(out: string): Record<string, unknown> | undefined {
    return parseSseEvents(out)
      .filter((e) => e.event === "message_delta")
      .map((e) => e.data.usage as Record<string, unknown> | undefined)
      .filter((u): u is Record<string, unknown> => u !== undefined)
      .pop();
  }

  const cachedFraming = (prompt: number, completion: number, cached: number): string =>
    `data: {"choices":[{"delta":{"content":"hi"},"index":0}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":${prompt},"completion_tokens":${completion},"prompt_tokens_details":{"cached_tokens":${cached}}}}\n\ndata: [DONE]\n\n`;

  test("byte-split framing: final usage subtracts cached from prompt_tokens", async () => {
    const usage = finalUsage(await drainChunked(cachedFraming(1000, 5, 900), 8));
    expect(usage).toMatchObject({
      input_tokens: 100, // 1000 - 900 (Anthropic semantics)
      output_tokens: 5,
      cache_read_input_tokens: 900,
    });
  });

  test("cached > prompt clamps input_tokens at 0 (never negative)", async () => {
    const usage = finalUsage(await drainChunked(cachedFraming(10, 3, 50), 8));
    expect(usage?.input_tokens).toBe(0);
    expect(usage?.cache_read_input_tokens).toBe(50);
    expect(usage).toMatchObject({ output_tokens: 3 });
  });
});
