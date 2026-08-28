/**
 * Byte-stream decoder parity tests (Task 10): feeding a stream in many small
 * chunks must produce exactly the same frames/lines as a single-shot decode.
 * This locks in the O(L) read-cursor / tail-carry rewrites against regressions.
 */
import { describe, expect, test } from "bun:test";
import { EventStreamDecoder } from "../src/stream/converse-events.ts";
import { SseLineParser } from "../src/stream/openai-sse.ts";

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

describe("SseLineParser chunk-parity", () => {
  test("arbitrary chunk boundaries yield the same data payloads", () => {
    const enc = new TextEncoder();
    const text = 'data: {"a":1}\n' + 'data: {"b":2}\r\n' + ": comment line\n" + "data: [DONE]\n";
    const bytes = enc.encode(text);

    const single = new SseLineParser().push(bytes);

    // Feed in 3-byte chunks.
    const drip = new SseLineParser();
    const collected: string[] = [];
    for (let i = 0; i < bytes.length; i += 3) {
      collected.push(...drip.push(bytes.subarray(i, i + 3)));
    }

    expect(collected).toEqual(single);
    expect(single).toEqual(['{"a":1}', '{"b":2}', "[DONE]"]);
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
