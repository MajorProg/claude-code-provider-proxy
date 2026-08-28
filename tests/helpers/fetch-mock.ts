/**
 * Hermetic fetch mock for replaying captured upstream fixtures.
 *
 * These fixtures are REAL upstream responses captured once from live Bedrock
 * (see scripts/capture-fixtures.ts). Replaying them through globalThis.fetch
 * exercises the real translation/streaming/relay code with authentic provider
 * data — no network, no cost, deterministic. This is the mock layer the project
 * now permits (AGENTS.md): only the outbound HTTP boundary is stubbed; all
 * translation logic under test is real.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FIX = join(import.meta.dir, "..", "fixtures");

export function readFixtureText(name: string): string {
  return readFileSync(join(FIX, name), "utf8");
}

export function readFixtureBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIX, name)));
}

/** Bytes of a base64-encoded binary fixture (e.g. the Converse eventstream). */
export function readFixtureBase64(name: string): Uint8Array {
  return new Uint8Array(Buffer.from(readFixtureText(name).trim(), "base64"));
}

/** Build a ReadableStream that emits the given bytes, optionally in N chunks. */
export function streamOf(bytes: Uint8Array, chunks = 1): ReadableStream<Uint8Array> {
  const size = Math.max(1, Math.ceil(bytes.byteLength / chunks));
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.subarray(offset, offset + size));
      offset += size;
    },
  });
}

export interface MockResponseSpec {
  status?: number;
  headers?: Record<string, string>;
  /** JSON body (object) — serialized. */
  json?: unknown;
  /** Raw text/SSE body. */
  text?: string;
  /** Streaming body bytes. */
  stream?: Uint8Array;
  /** Chunk count for a streaming body (default 1). */
  chunks?: number;
}

/**
 * Install a fetch mock returning `spec` (or the next spec, if an array is given
 * — one per successive call). Returns a restore() to put the real fetch back.
 * Also records every outgoing request so tests can assert URL/headers/body.
 */
export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

export interface FetchMock {
  restore(): void;
  requests: RecordedRequest[];
}

export function installFetchMock(spec: MockResponseSpec | MockResponseSpec[]): FetchMock {
  const original = globalThis.fetch;
  const specs = Array.isArray(spec) ? spec : [spec];
  const requests: RecordedRequest[] = [];
  let call = 0;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        headers[k.toLowerCase()] = v;
      }
    }
    requests.push({
      url,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : null,
    });

    const s = specs[Math.min(call, specs.length - 1)] ?? {};
    call++;
    const status = s.status ?? 200;
    const respHeaders = new Headers(s.headers ?? {});

    if (s.stream) {
      if (!respHeaders.has("content-type")) {
        respHeaders.set("content-type", "text/event-stream; charset=utf-8");
      }
      return new Response(streamOf(s.stream, s.chunks ?? 1), { status, headers: respHeaders });
    }
    if (s.json !== undefined) {
      if (!respHeaders.has("content-type")) respHeaders.set("content-type", "application/json");
      return new Response(JSON.stringify(s.json), { status, headers: respHeaders });
    }
    return new Response(s.text ?? "", { status, headers: respHeaders });
  }) as typeof fetch;

  return {
    restore() {
      globalThis.fetch = original;
    },
    requests,
  };
}
