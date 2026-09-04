/**
 * Capture helpers that turn a proxy Response into a TurnRecord for the LogStore.
 *
 * All paths produce Anthropic-shaped output (either a JSON message body or an
 * Anthropic SSE stream), so capture works uniformly in Anthropic terms:
 *   - Non-streaming: parse the JSON body; extract content, stop_reason, usage.
 *   - Streaming: tee the SSE stream — one branch relays to the client
 *     unchanged, the other accumulates events to reconstruct the assistant
 *     content, final stop_reason, and token usage.
 *
 * Capture is best-effort and never blocks or alters the client response.
 */
import { coerceToolInput, isCustomTool } from "../paths/relay.ts";
import type { LogStore, TurnRecord } from "./log-store.ts";
import { errorMessage, logger } from "./logger.ts";

/**
 * Summarize a request's `tools` array into a ToolTrace: which tools were
 * forwarded (custom, with a real schema) and which were dropped (Anthropic
 * server-tools with no `input_schema`). Returns undefined when no tools were
 * offered, so the field is omitted from the record. Tolerant of untrusted
 * shapes — anything that isn't a well-formed tool object is ignored.
 */
export function summarizeTools(tools: unknown): ToolTrace | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const customTools: string[] = [];
  const droppedServerTools: { name: string; type: string | undefined }[] = [];
  for (const t of tools) {
    if (typeof t !== "object" || t === null) continue;
    const tool = t as { name?: unknown; type?: unknown; input_schema?: unknown };
    const name = typeof tool.name === "string" ? tool.name : "(unnamed)";
    if (isCustomTool(tool)) {
      customTools.push(name);
    } else {
      droppedServerTools.push({
        name,
        type: typeof tool.type === "string" ? tool.type : undefined,
      });
    }
  }
  return { customTools, droppedServerTools };
}

/**
 * Run a detached best-effort task, swallowing any rejection with a diagnostic.
 *
 * The capture tasks already wrap their body in try/catch, but attaching a
 * terminal `.catch` here is defense-in-depth: if a future edit adds an `await`
 * *before* the inner try (e.g. before `getReader()`), it would otherwise become
 * an unhandled promise rejection. Capture is never allowed to crash the process.
 */
function runDetached(task: () => Promise<void>, label: string): void {
  task().catch((err) => {
    logger.warn(`log capture task rejected (${label})`, { message: errorMessage(err) });
  });
}

/** Context describing the request being captured. */
export interface CaptureContext {
  readonly sessionId: string;
  readonly canonicalModel: string;
  readonly invocationModel: string;
  readonly backend: string;
  readonly translationPath: string;
  readonly system: unknown;
  readonly messages: unknown;
  /** Tool-offer trace for the request (offered/dropped tools). Optional. */
  readonly tools?: ToolTrace;
  readonly requestedAt: string;
}

/**
 * A summary of the tools a client offered in a request, split by whether the
 * proxy could forward them. Server-tools (Anthropic built-ins with no
 * `input_schema`, e.g. "bash_20250825") are dropped on the Converse/Mantle
 * paths and listed under `droppedServerTools` — a ready-made catalog of which
 * built-ins would need MCP equivalents for non-Anthropic backends.
 */
export interface ToolTrace {
  /** Custom tools forwarded to the backend (name only; schemas can be large). */
  readonly customTools: string[];
  /** Anthropic server-tools dropped on this path: `{ name, type }`. */
  readonly droppedServerTools: { name: string; type: string | undefined }[];
}

interface AnthropicMessageBody {
  content?: unknown;
  stop_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** Build and store a turn record from a non-streaming Anthropic response body. */
async function captureNonStreaming(
  store: LogStore,
  ctx: CaptureContext,
  systemHash: string | null,
  body: AnthropicMessageBody,
): Promise<void> {
  const turn: TurnRecord = {
    sessionId: ctx.sessionId,
    canonicalModel: ctx.canonicalModel,
    invocationModel: ctx.invocationModel,
    backend: ctx.backend,
    translationPath: ctx.translationPath,
    streamed: false,
    systemHash,
    messages: ctx.messages,
    ...(ctx.tools ? { tools: ctx.tools } : {}),
    responseContent: body.content ?? [],
    stopReason: body.stop_reason ?? null,
    usage: {
      inputTokens: body.usage?.input_tokens ?? 0,
      outputTokens: body.usage?.output_tokens ?? 0,
    },
    requestedAt: ctx.requestedAt,
    respondedAt: new Date().toISOString(),
  };
  await store.recordTurn(turn);
}

/** Max total captured content chars before capture is truncated (DoS guard). */
const MAX_CAPTURE_CHARS = 8 * 1024 * 1024; // 8 MiB of reconstructed content

/**
 * The streaming log-capture branch is a best-effort FOLLOWER of the client
 * branch (PC8): it is cancelled promptly when the client branch ends (see
 * `captureStreaming`) or on client disconnect. A wall-clock backstop
 * (`LoggingConfig.captureTimeoutMs`, threaded via `LogStore.captureTimeoutMs`)
 * only caps a hung upstream whose client branch never ends. Independent of
 * MAX_CAPTURE_CHARS, which bounds memory but not open-socket time.
 */

/**
 * Accumulates Anthropic SSE events to reconstruct content + usage + stop reason.
 * Fed decoded SSE text chunks; call `finish()` to obtain the assembled result.
 */
export class AnthropicStreamAccumulator {
  private buffer = "";
  // Accumulate delta fragments in arrays and join once in content(): appending
  // to a growing string per delta is O(n^2) over a long streamed response.
  private textByIndex = new Map<number, string[]>();
  private toolByIndex = new Map<number, { id: string; name: string; json: string[] }>();
  private order: number[] = [];
  /** Running size of accumulated content; capture stops past MAX_CAPTURE_CHARS. */
  private accumulatedChars = 0;
  private truncated = false;
  inputTokens = 0;
  outputTokens = 0;
  stopReason: string | null = null;

  push(chunk: string): void {
    // Once capacity is exceeded, stop buffering entirely — a hung/adversarial
    // upstream must not grow memory without bound. Usage/stop-reason already
    // captured stand; content is marked truncated in content().
    if (this.truncated) return;
    this.buffer += chunk;
    // PC10: MAX_CAPTURE_CHARS counts DECODED content deltas, not the raw
    // unparsed buffer. A stream that never sends a newline (or a single giant
    // data line) would grow this.buffer without bound. Cap the raw buffer too:
    // on overflow, stop buffering and mark truncated (capture is best-effort —
    // usage/stop-reason captured so far stand; content is flagged truncated).
    if (this.buffer.length > MAX_CAPTURE_CHARS) {
      this.truncated = true;
      this.buffer = "";
      return;
    }
    // Read-cursor scan: advance `start` per line and slice the remainder ONCE
    // per push, instead of re-slicing the whole buffer per line (O(L^2)).
    let start = 0;
    for (;;) {
      const nl = this.buffer.indexOf("\n", start);
      if (nl === -1) break;
      let end = nl;
      if (end > start && this.buffer.charCodeAt(end - 1) === 13) end--; // strip trailing \r
      const line = this.buffer.slice(start, end);
      start = nl + 1;
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trimStart();
      if (payload.length === 0) continue;
      try {
        this.handleEvent(JSON.parse(payload) as Record<string, unknown>);
      } catch {
        // ignore non-JSON data lines
      }
    }
    if (start > 0) this.buffer = this.buffer.slice(start);
  }

  /** Track accumulated content size; trip the cap (and drop the buffer) once
   *  the limit is exceeded so memory can't grow without bound. */
  private countTowardCap(chars: number): void {
    this.accumulatedChars += chars;
    if (this.accumulatedChars > MAX_CAPTURE_CHARS) {
      this.truncated = true;
      this.buffer = "";
    }
  }

  private handleEvent(ev: Record<string, unknown>): void {
    const type = ev.type as string | undefined;
    if (type === "message_start") {
      const msg = ev.message as { usage?: { input_tokens?: number } } | undefined;
      if (typeof msg?.usage?.input_tokens === "number") this.inputTokens = msg.usage.input_tokens;
    } else if (type === "content_block_start") {
      const index = ev.index as number;
      const block = ev.content_block as { type?: string; id?: string; name?: string } | undefined;
      if (block?.type === "text") {
        this.textByIndex.set(index, []);
        this.order.push(index);
      } else if (block?.type === "tool_use") {
        this.toolByIndex.set(index, { id: block.id ?? "", name: block.name ?? "", json: [] });
        this.order.push(index);
      }
    } else if (type === "content_block_delta") {
      const index = ev.index as number;
      const delta = ev.delta as { type?: string; text?: string; partial_json?: string } | undefined;
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        let parts = this.textByIndex.get(index);
        if (parts === undefined) {
          parts = [];
          this.textByIndex.set(index, parts);
        }
        parts.push(delta.text);
        this.countTowardCap(delta.text.length);
      } else if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
        const t = this.toolByIndex.get(index);
        if (t) {
          t.json.push(delta.partial_json);
          this.countTowardCap(delta.partial_json.length);
        }
      }
    } else if (type === "message_delta") {
      const delta = ev.delta as { stop_reason?: string | null } | undefined;
      const usage = ev.usage as { output_tokens?: number; input_tokens?: number } | undefined;
      if (delta && "stop_reason" in delta) this.stopReason = delta.stop_reason ?? null;
      if (typeof usage?.output_tokens === "number") this.outputTokens = usage.output_tokens;
      // Some upstreams only report input tokens at the end (OpenAI/Mantle streams).
      if (typeof usage?.input_tokens === "number" && usage.input_tokens > 0) {
        this.inputTokens = usage.input_tokens;
      }
    }
  }

  /** Reconstruct the Anthropic content-block array from accumulated deltas. */
  content(): unknown[] {
    const blocks: unknown[] = [];
    for (const index of this.order) {
      const text = this.textByIndex.get(index);
      if (text !== undefined) {
        blocks.push({ type: "text", text: text.join("") });
        continue;
      }
      const tool = this.toolByIndex.get(index);
      if (tool) {
        // G10/SEC-10: logged tool_use.input is always an object; a truncated or
        // malformed argument stream degrades to {} (never a raw string).
        blocks.push({
          type: "tool_use",
          id: tool.id,
          name: tool.name,
          input: coerceToolInput(tool.json.join("")),
        });
      }
    }
    if (this.truncated) {
      blocks.push({
        type: "text",
        text: `\n[capture truncated: response exceeded ${MAX_CAPTURE_CHARS} chars]`,
      });
    }
    return blocks;
  }
}

/**
 * Capture a completed dispatch. Records the system prompt (deduped) and the
 * turn. Returns the Response to send to the client (unchanged for non-streaming;
 * a tee-wrapped equivalent for streaming).
 *
 * NON-BLOCKING contract: storage writes never sit on the client's response
 * path. For streaming, the tee branch records in the background. For
 * non-streaming, the response is returned immediately and the system-prompt +
 * turn are recorded in a detached, error-wrapped task (reading a clone so the
 * client body is untouched). Best-effort: any failure is logged, never thrown.
 */
export function captureTurn(
  store: LogStore,
  ctx: CaptureContext,
  response: Response,
  signal?: AbortSignal,
): Response {
  if (!store.isEnabled() || !response.ok) return response;
  const contentType = response.headers.get("content-type") ?? "";

  if (contentType.includes("text/event-stream")) {
    return captureStreaming(store, ctx, response, signal);
  }

  // Non-streaming: return the response immediately; record from a clone in the
  // background so storage-write latency is off the client's TTFB.
  const clone = response.clone();
  runDetached(async () => {
    try {
      const systemHash = await store.recordSystemPrompt(ctx.system);
      const body = (await clone.json()) as AnthropicMessageBody;
      await captureNonStreaming(store, ctx, systemHash, body);
    } catch (err) {
      logger.warn("log capture failed (non-streaming)", {
        session: ctx.sessionId,
        message: errorMessage(err),
      });
    }
  }, "non-streaming");
  return response;
}

/**
 * Tee the streaming response for the client immediately, and in the background
 * record the (deduped) system prompt followed by the reconstructed turn. The
 * log-branch reader lock is always released; a failure cancels the branch and
 * is swallowed with a diagnostic (best-effort).
 *
 * The detached log-branch pump is bounded two ways so it can never outlive the
 * useful request: it is cancelled when the inbound `signal` aborts (client
 * disconnect) and by a wall-clock timeout (hung upstream). Without this, a
 * disconnected client would leave the tee'd log branch pulling the upstream to
 * completion — holding the socket open and burning tokens/cost.
 */
function captureStreaming(
  store: LogStore,
  ctx: CaptureContext,
  response: Response,
  signal?: AbortSignal,
): Response {
  if (!response.body) return response;
  const [clientBranch, logBranch] = response.body.tee();

  // PC8: the log branch is a FOLLOWER. When the client branch finishes (the
  // stream the user actually consumes ends or is cancelled), promptly cancel the
  // log-branch read so the tee doesn't keep the upstream socket alive for the
  // slower/idle branch. `clientDone` fires on client-branch close OR cancel.
  const clientDone = new AbortController();
  const clientReader = clientBranch.getReader();
  const monitoredClientBranch = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await clientReader.read();
        if (done) {
          controller.close();
          clientDone.abort(); // client branch reached end-of-stream
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        controller.error(err);
        clientDone.abort();
      }
    },
    cancel(reason) {
      void clientReader.cancel(reason).catch(() => {});
      clientDone.abort(); // client disconnected mid-stream
    },
  });

  runDetached(async () => {
    const reader = logBranch.getReader();
    // Cancel the log-branch read on client disconnect or after a wall-clock cap
    // so a slow/hung upstream can't pin the branch (and its socket) open.
    const timeout = setTimeout(() => {
      void reader.cancel(new Error("log capture timed out")).catch(() => {});
    }, store.captureTimeoutMs);
    const onAbort = () => {
      void reader.cancel(new Error("client disconnected")).catch(() => {});
    };
    // PC8: follow the client branch — when it ends, stop pumping the log branch.
    const onClientDone = () => {
      void reader.cancel(new Error("client branch ended")).catch(() => {});
    };
    if (clientDone.signal.aborted) onClientDone();
    else clientDone.signal.addEventListener("abort", onClientDone, { once: true });
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      const systemHash = await store.recordSystemPrompt(ctx.system);
      const acc = new AnthropicStreamAccumulator();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) acc.push(decoder.decode(value, { stream: true }));
      }
      const turn: TurnRecord = {
        sessionId: ctx.sessionId,
        canonicalModel: ctx.canonicalModel,
        invocationModel: ctx.invocationModel,
        backend: ctx.backend,
        translationPath: ctx.translationPath,
        streamed: true,
        systemHash,
        messages: ctx.messages,
        ...(ctx.tools ? { tools: ctx.tools } : {}),
        responseContent: acc.content(),
        stopReason: acc.stopReason,
        usage: { inputTokens: acc.inputTokens, outputTokens: acc.outputTokens },
        requestedAt: ctx.requestedAt,
        respondedAt: new Date().toISOString(),
      };
      await store.recordTurn(turn);
    } catch (err) {
      await reader.cancel(err).catch(() => {});
      logger.warn("log capture failed (streaming)", {
        session: ctx.sessionId,
        message: errorMessage(err),
      });
      return;
    } finally {
      clearTimeout(timeout);
      if (signal) signal.removeEventListener("abort", onAbort);
      clientDone.signal.removeEventListener("abort", onClientDone);
      reader.releaseLock();
    }
  }, "streaming");

  const headers: Record<string, string> = {};
  const ct = response.headers.get("content-type");
  if (ct) headers["content-type"] = ct;
  const cc = response.headers.get("cache-control");
  if (cc) headers["cache-control"] = cc;
  return new Response(monitoredClientBranch, { status: response.status, headers });
}
