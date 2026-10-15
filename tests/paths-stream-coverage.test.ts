/**
 * Coverage-closure tests for the Path C/M translation + streaming modules
 * (src/paths/{converse,normalize,relay}.ts, src/stream/*). Each test drives the
 * REAL implementation with real inputs and asserts on the real output.
 *
 * The branches exercised here are the ones the existing suites reach only on a
 * live provider or not at all:
 *   - the thinking / reasoning round-trip (Anthropic thinking block -> Converse
 *     reasoningContent, and the drop of redacted_thinking);
 *   - url-source vs base64 images on the Converse request path;
 *   - systemText extraction edge cases (non-string `text`, non-text blocks, a
 *     non-array system content shape);
 *   - the readBodyWithLimit no-stream fallback (+ its byte-length count) and the
 *     swallowing of a rejecting reader.cancel during the streamed-cap abort;
 *   - the emitter's `signature_delta`;
 *   - the client-cancel and upstream-error teardown of both SSE bridges and the
 *     keep-alive tee.
 */
import { describe, expect, test } from "bun:test";
import { PayloadTooLargeError, UpstreamError } from "../src/errors.ts";
import { anthropicToConverseRequest } from "../src/paths/converse.ts";
import { normalizeForIrPaths, systemFieldToText } from "../src/paths/normalize.ts";
import { assertUpstreamOk, readBodyWithLimit } from "../src/paths/relay.ts";
import type { RouteTarget } from "../src/router.ts";
import { AnthropicSseEmitter } from "../src/stream/anthropic-sse.ts";
import { EventStreamDecoder, converseStreamToAnthropicSse } from "../src/stream/converse-events.ts";
import { keepAliveTee } from "../src/stream/keepalive-tee.ts";
import {
  SseLineParser,
  deltaContentToText,
  openAiStreamToAnthropicSse,
} from "../src/stream/openai-sse.ts";
import { readFixtureBase64, readFixtureText } from "./helpers/fetch-mock.ts";

const enc = new TextEncoder();

// Minimal RouteTarget stub — only `path` + `invocationId` are read by the relay
// helpers (assertUpstreamOk / parseUpstreamJson).
const route = { path: "https://x/model/m/converse", invocationId: "m-1" } as unknown as RouteTarget;

/** The request argument type of anthropicToConverseRequest (for loose fixtures). */
type ConverseReq = Parameters<typeof anthropicToConverseRequest>[0];

describe("converse.ts — Anthropic block -> Converse mapping", () => {
  test("an assistant thinking block round-trips to reasoningContent with its signature", () => {
    const body = anthropicToConverseRequest({
      model: "x",
      max_tokens: 64,
      messages: [
        { role: "user", content: "reason about it" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "step by step", signature: "sig-xyz" },
            { type: "text", text: "the answer" },
          ],
        },
      ],
    } as unknown as ConverseReq);
    // Converse is Claude, so the REAL signature must round-trip unmodified.
    expect(body.messages[1]?.content[0]).toEqual({
      reasoningContent: { reasoningText: { text: "step by step", signature: "sig-xyz" } },
    });
    expect(body.messages[1]?.content[1]).toEqual({ text: "the answer" });
  });

  test("redacted_thinking is dropped and an unsigned thinking block omits the signature", () => {
    const body = anthropicToConverseRequest({
      model: "x",
      max_tokens: 64,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "redacted_thinking", data: "encrypted" },
            { type: "thinking", thinking: "unsigned reasoning" },
            { type: "text", text: "ok" },
          ],
        },
      ],
    } as unknown as ConverseReq);
    // redacted_thinking has no Converse equivalent -> dropped; the unsigned
    // thinking block carries no fabricated signature key.
    expect(body.messages[0]?.content).toEqual([
      { reasoningContent: { reasoningText: { text: "unsigned reasoning" } } },
      { text: "ok" },
    ]);
  });

  test("a url-source image degrades to a placeholder (Converse images are bytes-only)", () => {
    const body = anthropicToConverseRequest({
      model: "x",
      max_tokens: 64,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "url", url: "https://example.test/cat.png" } },
          ],
        },
      ],
    } as unknown as ConverseReq);
    expect(body.messages[0]?.content[0]).toEqual({
      text: "[image url omitted: not supported by this model]",
    });
  });

  test("a base64 image maps to Converse image bytes with a derived format token", () => {
    const body = anthropicToConverseRequest({
      model: "x",
      max_tokens: 64,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } },
          ],
        },
      ],
    } as unknown as ConverseReq);
    expect(body.messages[0]?.content[0]).toEqual({
      image: { format: "jpeg", source: { bytes: "AAAA" } },
    });
  });
});

describe("normalize.ts — system text extraction edge cases", () => {
  test("a system block whose `text` is present but not a string is dropped", () => {
    const out = systemFieldToText([
      { type: "text", text: "kept" },
      { type: "text", text: 123 },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "A" } },
    ]);
    // Only the real string text survives; both non-text shapes are dropped.
    expect(out).toBe("kept");
  });

  test("a system-role message's non-text content blocks contribute no system text", () => {
    const n = normalizeForIrPaths({
      messages: [
        {
          role: "system",
          content: [
            { type: "text", text: "keep" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "A" } },
          ],
        },
        { role: "user", content: "hi" },
      ],
    });
    // Only the text block folds into the hoisted system prompt.
    expect(n.system).toEqual(["keep"]);
  });

  test("a system-role message with non-string/array content yields no system text", () => {
    const n = normalizeForIrPaths({
      messages: [
        { role: "system", content: 42 },
        { role: "user", content: "hi" },
      ],
    });
    expect(n.system).toEqual([]);
    expect(n.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  test("a message whose content is neither string nor array is preserved as-is", () => {
    const n = normalizeForIrPaths({
      messages: [{ role: "user", content: { weird: true } }],
    });
    // Unknown content shape is kept (translators decide how to handle it) rather
    // than dropped as "empty".
    expect(n.messages).toEqual([{ role: "user", content: { weird: true } }]);
  });
});

describe("relay.ts — readBodyWithLimit fallback + unreadable error body", () => {
  test("falls back to req.text() when there is no stream body (declared length under cap)", async () => {
    const req = {
      headers: { get: (n: string) => (n === "content-length" ? "7" : null) },
      text: async () => '{"a":1}',
    };
    // The declared length is finite AND under the cap, so the Content-Length
    // fast-reject is skipped; with no readable body the text fallback runs and
    // the UTF-8 byte length is counted.
    expect(await readBodyWithLimit(req, 1024)).toEqual({ text: '{"a":1}', bytes: 7 });
  });

  test("the no-stream fallback still enforces the cap (413)", async () => {
    const req = { headers: { get: () => null }, text: async () => "x".repeat(2048) };
    await expect(readBodyWithLimit(req, 1024)).rejects.toThrow(PayloadTooLargeError);
    await expect(readBodyWithLimit(req, 1024)).rejects.toThrow(/exceeds the 1024-byte limit/);
  });

  test("a rejecting reader.cancel during the streamed-cap abort does not mask the 413", async () => {
    const chunk = new Uint8Array(4096).fill(65);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(chunk);
        c.enqueue(chunk);
      },
      cancel() {
        throw new Error("cancel boom");
      },
    });
    const req = { headers: { get: () => null }, body: stream, text: async () => "unused" };
    // 8192 bytes > 4096 cap -> the streamed cap aborts and cancels the reader.
    await expect(readBodyWithLimit(req, 4096)).rejects.toThrow(PayloadTooLargeError);
  });

  test("assertUpstreamOk degrades to an empty upstreamBody when the error body is unreadable", async () => {
    const upstream = {
      ok: false,
      status: 500,
      body: null,
      text: () => Promise.reject(new Error("body unreadable")),
    } as unknown as Response;
    try {
      await assertUpstreamOk(upstream, route);
      throw new Error("assertUpstreamOk should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(UpstreamError);
      expect((err as UpstreamError).status).toBe(500);
      // The body read failed, so the relayed error body is empty (best-effort).
      expect((err as UpstreamError).upstreamBody).toBe("");
    }
  });
});

describe("anthropic-sse.ts — signature delta on an open thinking block", () => {
  test("appendSignature emits a signature_delta; an empty signature is a no-op", async () => {
    const e = new AnthropicSseEmitter(1_000_000, 1_000_000);
    e.start("m", 5);
    const idx = e.startThinkingBlock();
    e.appendThinking(idx, "reasoning");
    e.appendSignature(idx, "SIG-REAL");
    e.appendSignature(idx, ""); // empty signature -> no event
    e.finish("end_turn", { outputTokens: 2, inputTokens: 5 });
    const sse = await new Response(e.readable).text();
    expect(sse).toContain('"content_block":{"type":"thinking"');
    expect(sse).toContain('"delta":{"type":"signature_delta","signature":"SIG-REAL"}');
  });
});

describe("converse-events.ts — client-cancel + upstream-error teardown", () => {
  test("a client cancel aborts the upstream reader (a rejecting upstream cancel is swallowed)", async () => {
    const bytes = readFixtureBase64("converse-stream.b64");
    let upstreamCancelled = false;
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes);
        // Stays open — a live Converse stream between events.
      },
      cancel() {
        upstreamCancelled = true;
        throw new Error("upstream cancel boom");
      },
    });
    const sse = converseStreamToAnthropicSse(upstream, "m");
    const rd = sse.getReader();
    await rd.read(); // pull the first event so the pump is live
    await rd.cancel(new Error("client gone"));
    await new Promise((r) => setTimeout(r, 10));
    // onCancel fired and reached the upstream reader.
    expect(upstreamCancelled).toBe(true);
  });

  test("an upstream read error fails the client stream with a typed error event", async () => {
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        c.error(new Error("converse upstream exploded"));
      },
    });
    const sse = converseStreamToAnthropicSse(upstream, "m");
    const text = await new Response(sse).text();
    expect(text).toContain("event: error");
    expect(text).toContain("converse upstream exploded");
  });
});

describe("openai-sse.ts — client-cancel + upstream-error teardown", () => {
  test("a client cancel aborts the upstream reader (a rejecting upstream cancel is swallowed)", async () => {
    const bytes = enc.encode(readFixtureText("openai-stream.sse"));
    let upstreamCancelled = false;
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes);
        // Stays open — a live SSE stream between chunks.
      },
      cancel() {
        upstreamCancelled = true;
        throw new Error("upstream cancel boom");
      },
    });
    const sse = openAiStreamToAnthropicSse(upstream, "m");
    const rd = sse.getReader();
    await rd.read();
    await rd.cancel(new Error("client gone"));
    await new Promise((r) => setTimeout(r, 10));
    expect(upstreamCancelled).toBe(true);
  });

  test("an upstream read error fails the client stream with a typed error event", async () => {
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        c.error(new Error("openai upstream exploded"));
      },
    });
    const sse = openAiStreamToAnthropicSse(upstream, "m");
    const text = await new Response(sse).text();
    expect(text).toContain("event: error");
    expect(text).toContain("openai upstream exploded");
  });
});

describe("keepalive-tee.ts — teardown swallows a rejecting upstream cancel", () => {
  test("cancelling the teed stream does not reject when the upstream cancel() throws", async () => {
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode("event: message_start\ndata: {}\n\n"));
      },
      cancel() {
        throw new Error("upstream cancel boom");
      },
    });
    const teed = keepAliveTee(upstream, 1_000_000);
    const rd = teed.getReader();
    await rd.read();
    // Must resolve cleanly even though the upstream reader's cancel() rejects.
    await rd.cancel(new Error("client gone"));
  });
});

/**
 * Build one `vnd.amazon.eventstream` frame (real wire format) with a single
 * `:event-type` string header and a JSON payload. The prelude/message CRCs are
 * zeroed — the decoder does not validate them. `rawPayload` (when given) is
 * emitted verbatim as the payload bytes so a malformed-payload frame can be
 * constructed.
 */
function encodeFrame(eventType: string, payload: unknown, rawPayload?: Uint8Array): Uint8Array {
  const enc = new TextEncoder();
  const nameBytes = enc.encode(":event-type");
  const valueBytes = enc.encode(eventType);
  const headerLen = 1 + nameBytes.length + 1 + 2 + valueBytes.length;
  const payloadBytes = rawPayload ?? enc.encode(JSON.stringify(payload));
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
  buf[o++] = nameBytes.length;
  buf.set(nameBytes, o);
  o += nameBytes.length;
  buf[o++] = 7; // header value type = string
  dv.setUint16(o, valueBytes.length);
  o += 2;
  buf.set(valueBytes, o);
  o += valueBytes.length;
  buf.set(payloadBytes, o);
  o += payloadBytes.length;
  dv.setUint32(o, 0); // message CRC (ignored)
  return buf;
}

describe("converse-events.ts — EventStreamDecoder framing edge cases", () => {
  test("carries a partial frame across single-byte pushes", () => {
    const decoder = new EventStreamDecoder();
    const bytes = encodeFrame("messageStart", { role: "assistant" });
    const eventTypes: string[] = [];
    // One byte at a time: every frame boundary lands mid-push, so the decoder
    // must buffer the partial frame in `tail` and only emit on the final byte.
    for (let i = 0; i < bytes.length; i++) {
      for (const frame of decoder.push(bytes.subarray(i, i + 1))) eventTypes.push(frame.eventType);
    }
    expect(eventTypes).toEqual(["messageStart"]);
  });

  test("stops at corrupt framing (total length below the 16-byte minimum)", () => {
    const decoder = new EventStreamDecoder();
    const good = encodeFrame("messageStop", { stopReason: "end_turn" });
    // A trailing 12-byte prelude whose declared total length (8) is below the
    // 16-byte minimum: the decoder must drop the rest rather than loop forever.
    const junk = new Uint8Array(12);
    new DataView(junk.buffer).setUint32(0, 8);
    const combined = new Uint8Array(good.length + junk.length);
    combined.set(good, 0);
    combined.set(junk, good.length);
    const frames = decoder.push(combined);
    expect(frames.map((f) => f.eventType)).toEqual(["messageStop"]);
  });

  test("skips a frame whose payload is not valid JSON (empty payload object)", () => {
    const decoder = new EventStreamDecoder();
    const bad = encodeFrame("contentBlockDelta", undefined, enc.encode("{not json"));
    const frames = decoder.push(bad);
    // The event-type header still yields the frame; its payload degrades to {}.
    expect(frames).toEqual([{ eventType: "contentBlockDelta", payload: {} }]);
  });

  test("retains a split frame across two pushes and emits it once completed", () => {
    const decoder = new EventStreamDecoder();
    const f1 = encodeFrame("messageStart", { role: "assistant" });
    const f2 = encodeFrame("messageStop", { stopReason: "end_turn" });
    // First push: a whole frame plus the first 6 bytes of the next frame's
    // 12-byte prelude — below a full prelude, so it is buffered as `tail`.
    const first = new Uint8Array(f1.length + 6);
    first.set(f1, 0);
    first.set(f2.subarray(0, 6), f1.length);
    expect(decoder.push(first).map((f) => f.eventType)).toEqual(["messageStart"]);
    // Second push completes the buffered frame.
    expect(decoder.push(f2.subarray(6)).map((f) => f.eventType)).toEqual(["messageStop"]);
  });
});

describe("openai-sse.ts — direct parser + content flattening", () => {
  test("deltaContentToText flattens a string, an array of parts, and a null", () => {
    expect(deltaContentToText("hello")).toBe("hello");
    expect(
      deltaContentToText([
        { type: "text", text: "a" },
        { type: "text", text: "b" },
        { type: "image" },
      ]),
    ).toBe("ab");
    expect(deltaContentToText(null)).toBe("");
    expect(deltaContentToText(undefined)).toBe("");
  });

  test("SseLineParser accumulates multi-line data, ignores comments, strips CR", () => {
    const parser = new SseLineParser();
    // A comment line and a CRLF-terminated data line, then a two-line event
    // dispatched by the terminating blank line.
    const out = parser.push(
      enc.encode(": heartbeat\r\ndata: first\r\ndata: second\n\ndata: third\n\n"),
    );
    expect(out).toEqual(["first\nsecond", "third"]);
  });

  test("SseLineParser.flush dispatches an unterminated trailing data line", () => {
    const parser = new SseLineParser();
    // No trailing blank line: the payload stays pending and flush emits it once.
    expect(parser.push(enc.encode("data: tail"))).toEqual([]);
    expect(parser.flush()).toEqual(["tail"]);
    expect(parser.flush()).toEqual([]);
  });

  test("SseLineParser.flush ignores a non-data trailing fragment", () => {
    const parser = new SseLineParser();
    expect(parser.push(enc.encode("event: ping"))).toEqual([]);
    expect(parser.flush()).toEqual([]);
  });

  test("a client cancel whose upstream cancel() resolves tears down cleanly", async () => {
    const bytes = enc.encode(readFixtureText("openai-stream.sse"));
    let upstreamCancelled = false;
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes);
      },
      cancel() {
        upstreamCancelled = true; // resolves normally this time
      },
    });
    const sse = openAiStreamToAnthropicSse(upstream, "m");
    const rd = sse.getReader();
    await rd.read();
    await rd.cancel(new Error("client gone"));
    await new Promise((r) => setTimeout(r, 10));
    expect(upstreamCancelled).toBe(true);
  });
});

describe("converse-events.ts — client cancel with a resolving upstream cancel", () => {
  test("tears down cleanly when the upstream reader's cancel() does not reject", async () => {
    const bytes = readFixtureBase64("converse-stream.b64");
    let upstreamCancelled = false;
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes);
      },
      cancel() {
        upstreamCancelled = true;
      },
    });
    const sse = converseStreamToAnthropicSse(upstream, "m");
    const rd = sse.getReader();
    await rd.read();
    await rd.cancel(new Error("client gone"));
    await new Promise((r) => setTimeout(r, 10));
    expect(upstreamCancelled).toBe(true);
  });
});

describe("keepalive-tee.ts — idle ping injection", () => {
  test("injects a standard ping frame when the upstream goes idle", async () => {
    // The upstream never enqueues: the tee's pump blocks on read, so the only
    // bytes produced come from the keep-alive timer after `idleMs` of silence.
    const upstream = new ReadableStream<Uint8Array>({
      start() {
        // stays open, silent
      },
    });
    const teed = keepAliveTee(upstream, 10);
    const rd = teed.getReader();
    const { value } = await rd.read();
    expect(new TextDecoder().decode(value)).toBe('event: ping\ndata: {"type":"ping"}\n\n');
    await rd.cancel(new Error("done"));
  });
});
