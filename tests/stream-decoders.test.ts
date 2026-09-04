/**
 * Byte-stream decoder parity tests (Task 10): feeding a stream in many small
 * chunks must produce exactly the same frames/lines as a single-shot decode.
 * This locks in the O(L) read-cursor / tail-carry rewrites against regressions.
 */
import { describe, expect, test } from "bun:test";
import { EventStreamDecoder } from "../src/stream/converse-events.ts";
import {
  SseLineParser,
  deltaContentToText,
  openAiStreamToAnthropicSse,
} from "../src/stream/openai-sse.ts";

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
