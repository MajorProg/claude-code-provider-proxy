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
 * Capture is best-effort and never blocks or alters the client response. Body
 * accumulation is additionally BOUNDED so a burst of large turns cannot grow the
 * process without limit: a per-turn byte cap clips one turn's body
 * (`body_state: "truncated"`) and a process-wide in-flight byte budget shared by
 * every concurrent capture sheds the body of new turns (`body_state: "shed"`)
 * while their metadata is still recorded. Only the tee'd log branch is ever
 * dropped — the client stream is never affected. A stream CUT EARLY (client
 * disconnect, capture timeout) likewise records `body_state: "truncated"`, so a
 * partial payload is never indistinguishable from a complete one.
 */
import { DEFAULT_LOG_IN_FLIGHT_BUDGET_BYTES, DEFAULT_LOG_MAX_TURN_BYTES } from "../config.ts";
import { coerceToolInput, isCustomTool } from "../paths/relay.ts";
import type { LogStore } from "./log-store.ts";
import type { BodyState, PromptSurface, TurnRecord } from "./log-types.ts";
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
  /**
   * Byte length of the WHOLE inbound request body (as read at the trust
   * boundary). It is a PROXY for message size: a request with huge tool schemas
   * and a small conversation trips the same threshold. When present and greater
   * than the per-turn cap, the stored turn keeps its metadata but stores
   * `messages: []` plus a `messagesOmitted` marker rather than the full
   * conversation — a single oversized request must not blow the body budget.
   */
  readonly inboundBytes?: number;
  /**
   * The full instruction-surface fingerprint (system + tool schemas + injected
   * instruction envelopes) this request ran under, when the caller computed it.
   * Forwarded verbatim onto the {@link TurnRecord} so the turn links to the exact
   * prompt version; when absent, LogStore falls back to the system-only version.
   */
  readonly promptSurface?: PromptSurface;
  /** Tool-offer trace for the request (offered/dropped tools). Optional. */
  readonly tools?: ToolTrace;
  /**
   * LABEL of the credential-pool entry that served the request
   * (VIRTUAL_MODELS.md cost attribution). The key VALUE never appears here.
   */
  readonly servingKeyLabel?: string;
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
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

/**
 * Wall-clock milliseconds from the inbound request to the recorded response. Both
 * timestamps already ride on the turn, so this only derives the delta; it yields
 * undefined rather than NaN or a negative when a timestamp is unusable.
 */
function latencyBetween(requestedAt: string, respondedAt: string): number | undefined {
  const start = Date.parse(requestedAt);
  const end = Date.parse(respondedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
  return Math.max(0, end - start);
}

/* ===================== bounded body capture ===================== */

/** UTF-8 byte length of a string — the unit the body caps are expressed in. */
function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/** Positive-integer coercion; undefined for anything else (never throws). */
function positiveInt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;
}

/**
 * Live capture counters + the current limits — for hermetic tests and for a
 * viewer/status surface. `bytesInFlight` is the reservation currently held by
 * in-progress captures; the two counters are cumulative since process start.
 */
export interface CaptureCounters {
  /** Bytes currently reserved by in-progress captures (shared budget). */
  readonly bytesInFlight: number;
  /** Turns whose body was dropped because the global budget was exhausted. */
  readonly turnsShed: number;
  /** Turns whose body was clipped to the per-turn cap. */
  readonly turnsTruncated: number;
  /** Current per-turn body cap (bytes). */
  readonly maxTurnBytes: number;
  /** Current global in-flight body budget (bytes). */
  readonly inFlightBudgetBytes: number;
}

/**
 * Shared, process-wide accounting for captured body bytes.
 *
 * Capture is bounded on two axes so a burst of large turns can never grow the
 * process without limit:
 *   - a PER-TURN cap (`maxTurnBytes`): a single turn's body beyond it is clipped
 *     and recorded `body_state: "truncated"`;
 *   - a GLOBAL in-flight budget (`inFlightBudgetBytes`) shared across all
 *     concurrent captures: once reserved bytes reach it, NEW turns shed their
 *     body (`body_state: "shed"`) while their metadata is still recorded.
 *
 * Only the log branch touches this; the client response is never affected.
 * `journal`/disk is irrelevant here — this is pure in-memory admission control.
 */
export class CaptureBudget {
  private maxTurn = DEFAULT_LOG_MAX_TURN_BYTES;
  private budget = DEFAULT_LOG_IN_FLIGHT_BUDGET_BYTES;
  private bytes = 0;
  private shedCount = 0;
  private truncatedCount = 0;

  constructor(
    maxTurnBytes: number = DEFAULT_LOG_MAX_TURN_BYTES,
    inFlightBudgetBytes: number = DEFAULT_LOG_IN_FLIGHT_BUDGET_BYTES,
  ) {
    this.maxTurn = positiveInt(maxTurnBytes) ?? DEFAULT_LOG_MAX_TURN_BYTES;
    this.budget = positiveInt(inFlightBudgetBytes) ?? DEFAULT_LOG_IN_FLIGHT_BUDGET_BYTES;
  }

  get maxTurnBytes(): number {
    return this.maxTurn;
  }

  get inFlightBudgetBytes(): number {
    return this.budget;
  }

  /** Bytes available before the global in-flight budget is exhausted. */
  freeBytes(): number {
    return this.budget - this.bytes;
  }

  /** Reserve `n` bytes; returns false (leaving the accounting unchanged) when it
   *  would exceed the global budget. */
  reserve(n: number): boolean {
    if (n <= 0) return true;
    if (this.bytes + n > this.budget) return false;
    this.bytes += n;
    return true;
  }

  /** Release `n` previously reserved bytes (saturating at zero). */
  release(n: number): void {
    if (n > 0) this.bytes = Math.max(0, this.bytes - n);
  }

  noteShed(): void {
    this.shedCount += 1;
  }

  noteTruncated(): void {
    this.truncatedCount += 1;
  }

  /** Apply new limits (idempotent); non-positive/absent values are ignored. */
  configure(limits: { maxTurnBytes?: number; inFlightBudgetBytes?: number }): void {
    const maxTurnBytes = positiveInt(limits.maxTurnBytes);
    const inFlightBudgetBytes = positiveInt(limits.inFlightBudgetBytes);
    if (maxTurnBytes !== undefined) this.maxTurn = maxTurnBytes;
    if (inFlightBudgetBytes !== undefined) this.budget = inFlightBudgetBytes;
  }

  /** Zero the in-flight accounting and counters (tests / hot-reload). */
  reset(): void {
    this.bytes = 0;
    this.shedCount = 0;
    this.truncatedCount = 0;
  }

  snapshot(): CaptureCounters {
    return {
      bytesInFlight: this.bytes,
      turnsShed: this.shedCount,
      turnsTruncated: this.truncatedCount,
      maxTurnBytes: this.maxTurn,
      inFlightBudgetBytes: this.budget,
    };
  }
}

/** The process-wide budget shared by every concurrent capture. */
const sharedCaptureBudget = new CaptureBudget();

/** Apply resolved `logging.*` limits to the shared budget (idempotent). */
export function configureCaptureBudget(limits: {
  maxTurnBytes?: number;
  inFlightBudgetBytes?: number;
}): void {
  sharedCaptureBudget.configure(limits);
}

/** Live capture counters + current limits (for tests and the log viewer). */
export function captureCounters(): CaptureCounters {
  return sharedCaptureBudget.snapshot();
}

/** Zero the shared budget's in-flight bytes and counters (tests). */
export function resetCaptureBudget(): void {
  sharedCaptureBudget.reset();
}

/**
 * Resolve the capture budget for a store. A store that already carries the
 * resolved logging limits (`maxTurnBytes` / `inFlightBudgetBytes`) wins — those
 * come from config and may be tuned per deployment; otherwise the shared
 * budget's defaults (the same config defaults) apply. The budget is
 * process-wide so its in-flight accounting spans ALL concurrent captures.
 */
function budgetFor(store: LogStore): CaptureBudget {
  const source = store as unknown as {
    maxTurnBytes?: unknown;
    inFlightBudgetBytes?: unknown;
  };
  const maxTurnBytes = positiveInt(source.maxTurnBytes);
  const inFlightBudgetBytes = positiveInt(source.inFlightBudgetBytes);
  if (maxTurnBytes !== undefined || inFlightBudgetBytes !== undefined) {
    sharedCaptureBudget.configure({
      ...(maxTurnBytes !== undefined ? { maxTurnBytes } : {}),
      ...(inFlightBudgetBytes !== undefined ? { inFlightBudgetBytes } : {}),
    });
  }
  return sharedCaptureBudget;
}

/**
 * Per-turn body meter. Draws from a shared {@link CaptureBudget}, clipping this
 * turn at the per-turn cap and shedding its body when the global budget is
 * exhausted. Bulk content is accumulated only while `active`; metadata (token
 * usage, stop reason, tool-call names) is tracked by the caller regardless, so a
 * shed or truncated turn still yields a complete index row.
 */
class BodyCapture {
  private state: BodyState = "full";
  private reserved = 0;

  constructor(private readonly budget: CaptureBudget) {
    // Admission happens at capture start: once the shared budget is exhausted,
    // this turn's body is shed (metadata still flows).
    if (budget.freeBytes() <= 0) this.markShed();
  }

  get maxTurnBytes(): number {
    return this.budget.maxTurnBytes;
  }

  get bodyState(): BodyState {
    return this.state;
  }

  get shed(): boolean {
    return this.state === "shed";
  }

  get truncated(): boolean {
    return this.state === "truncated";
  }

  /** True while more bulk content may still be accepted (state is "full"). */
  get accepting(): boolean {
    return this.state === "full";
  }

  /** Reserve `bytes` of bulk body content; false once no more may be accepted. */
  accept(bytes: number): boolean {
    if (this.state !== "full") return false;
    if (this.reserved + bytes > this.budget.maxTurnBytes) {
      this.truncate();
      return false;
    }
    if (!this.budget.reserve(bytes)) {
      this.markShed();
      return false;
    }
    this.reserved += bytes;
    return true;
  }

  /** Mark this turn's body clipped at the per-turn cap (once). */
  truncate(): void {
    if (this.state !== "full") return;
    this.state = "truncated";
    this.budget.noteTruncated();
  }

  private markShed(): void {
    if (this.state === "shed") return;
    this.state = "shed";
    this.budget.noteShed();
    // A shed body is not kept: return any reservation to the shared budget.
    this.budget.release(this.reserved);
    this.reserved = 0;
  }

  /** Release this turn's reservation (once the turn is handed off / abandoned). */
  dispose(): void {
    this.budget.release(this.reserved);
    this.reserved = 0;
  }
}

/** Tool-call NAMES (in call order) from a reconstructed content array. */
function extractToolCallNames(content: readonly unknown[]): string[] {
  const names: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: unknown }).type === "tool_use") {
      const name = (block as { name?: unknown }).name;
      names.push(typeof name === "string" ? name : "(unnamed)");
    }
  }
  return names;
}

/**
 * The `messages` (and optional `messagesOmitted`) fields for a turn record.
 *
 * The inbound `messages` array is OMITTED — stored as `[]` with a marker — when
 * the WHOLE request body exceeded the per-turn cap. `inboundBytes` is the
 * whole-body size, a proxy for message size: a request with huge tool schemas
 * and a small conversation trips the same threshold. The rest of the record
 * (usage, stop reason, tool calls, response content) is unaffected, and
 * `bodyState` is deliberately untouched — it describes the RESPONSE capture, a
 * different axis.
 */
function messagesFields(
  ctx: CaptureContext,
  limitBytes: number,
): Pick<TurnRecord, "messages" | "messagesOmitted"> {
  const inboundBytes = ctx.inboundBytes;
  if (inboundBytes !== undefined && inboundBytes > limitBytes) {
    return { messages: [], messagesOmitted: { inboundBytes, limitBytes } };
  }
  return { messages: ctx.messages };
}

/**
 * Per-content-block JSON byte sizes, computed ONCE. Sizing a non-streaming body
 * this way lets both the whole-array fit check and the clipped-array size come
 * from arithmetic — no throwaway `JSON.stringify` of the entire array.
 */
function contentBlockSizes(content: readonly unknown[]): number[] {
  return content.map((block) => utf8Bytes(JSON.stringify(block)));
}

/** Exact JSON byte length of a block array given its serialized block sizes:
 *  `[` + blocks joined by `,` + `]` (2 bytes when empty). */
function arrayBytes(sizes: readonly number[]): number {
  if (sizes.length === 0) return 2; // "[]"
  let total = 2 + (sizes.length - 1); // brackets + N-1 separators
  for (const size of sizes) total += size;
  return total;
}

/**
 * Keep whole content blocks until adding the next would exceed `maxBytes` — a
 * faithful clip of an oversized non-streaming body (blocks are the smallest unit
 * that stays individually JSON-valid; the result is still a valid block array).
 * Reuses the sizes from {@link contentBlockSizes} so a block is serialized once,
 * never again for the clip. Returns the kept blocks AND their EXACT JSON byte
 * size (for the budget reservation): the fit check uses the true array size,
 * while the clip point keeps the prior block-at-a-time rule so the truncation
 * boundary is byte-for-byte unchanged.
 */
function clipBlocks(
  content: readonly unknown[],
  sizes: readonly number[],
  maxBytes: number,
): { blocks: unknown[]; bytes: number } {
  const out: unknown[] = [];
  const keptSizes: number[] = [];
  let bytes = 2; // the enclosing "[]"
  for (let i = 0; i < content.length; i++) {
    const size = sizes[i] ?? 0;
    if (bytes + size + 1 > maxBytes) break;
    out.push(content[i]);
    keptSizes.push(size);
    bytes += size + 1; // + separating comma
  }
  return { blocks: out, bytes: arrayBytes(keptSizes) };
}

/** The bounded-capture decision for one non-streaming body's content array. */
export interface ContentCapturePlan {
  /** EXACT JSON byte size of the blocks to store (for the shared-budget reservation). */
  readonly bytes: number;
  /** Blocks to keep — all of them, or a whole-block clip of the front of the array. */
  readonly stored: unknown[];
  /** True when the cap forced one or more trailing blocks to be dropped. */
  readonly truncated: boolean;
}

/**
 * Decide how much of a non-streaming response's content array fits the per-turn
 * cap, sizing the array by summing per-block JSON sizes ONCE (no throwaway
 * `JSON.stringify` of the whole body). The exact fit boundary is preserved: the
 * array is kept whole when its true JSON size is within the cap, and clipped
 * block-by-block only when it is not. Extracted so the byte-exact sizing is
 * directly testable, independent of the writer's own whole-payload cap.
 */
export function planContentCapture(
  content: readonly unknown[],
  maxBytes: number,
): ContentCapturePlan {
  const sizes = contentBlockSizes(content);
  const full = arrayBytes(sizes);
  if (full <= maxBytes) {
    return { bytes: full, stored: content as unknown[], truncated: false };
  }
  const clipped = clipBlocks(content, sizes, maxBytes);
  return { bytes: clipped.bytes, stored: clipped.blocks, truncated: true };
}

/* ===================== response capture ===================== */

/** Build and store a turn record from a non-streaming Anthropic response body. */
async function captureNonStreaming(
  store: LogStore,
  ctx: CaptureContext,
  systemHash: string | null,
  body: AnthropicMessageBody,
  budget: CaptureBudget,
): Promise<void> {
  const content: unknown[] = Array.isArray(body.content) ? (body.content as unknown[]) : [];
  // Metadata (tool-call names) is extracted BEFORE any body decision, so it
  // survives a shed/truncated body.
  const toolCalls = extractToolCallNames(content);
  const meter = new BodyCapture(budget);
  let stored: unknown[] = [];
  try {
    if (!meter.shed) {
      // Size the content ONCE (per-block JSON sums) and reuse it for the clip —
      // the whole body is never serialized just to be sized, and the byte
      // thresholds are unchanged.
      const plan = planContentCapture(content, meter.maxTurnBytes);
      if (meter.accept(plan.bytes)) {
        stored = plan.stored;
        if (plan.truncated) meter.truncate();
      }
    }
    const respondedAt = new Date().toISOString();
    const latencyMs = latencyBetween(ctx.requestedAt, respondedAt);
    const turn: TurnRecord = {
      sessionId: ctx.sessionId,
      canonicalModel: ctx.canonicalModel,
      invocationModel: ctx.invocationModel,
      backend: ctx.backend,
      translationPath: ctx.translationPath,
      streamed: false,
      systemHash,
      ...messagesFields(ctx, meter.maxTurnBytes),
      ...(ctx.promptSurface ? { promptSurface: ctx.promptSurface } : {}),
      ...(ctx.tools ? { tools: ctx.tools } : {}),
      ...(ctx.servingKeyLabel ? { servingKeyLabel: ctx.servingKeyLabel } : {}),
      responseContent: stored,
      stopReason: body.stop_reason ?? null,
      usage: {
        inputTokens: body.usage?.input_tokens ?? 0,
        outputTokens: body.usage?.output_tokens ?? 0,
      },
      ...(typeof body.usage?.cache_read_input_tokens === "number"
        ? { cacheReadTokens: body.usage.cache_read_input_tokens }
        : {}),
      toolCalls,
      bodyState: meter.bodyState,
      requestedAt: ctx.requestedAt,
      respondedAt,
      ...(latencyMs !== undefined ? { latencyMs } : {}),
    };
    await store.recordTurn(turn);
  } finally {
    meter.dispose();
  }
}

/**
 * The streaming log-capture branch is a best-effort FOLLOWER of the client
 * branch (PC8): it is cancelled promptly when the client branch ends (see
 * `captureStreaming`) or on client disconnect. A wall-clock backstop
 * (`LoggingConfig.captureTimeoutMs`, threaded via `LogStore.captureTimeoutMs`)
 * only caps a hung upstream whose client branch never ends.
 */

/**
 * Accumulates Anthropic SSE events to reconstruct content + usage + stop reason.
 * Fed decoded SSE text chunks; call `content()` to obtain the assembled result.
 *
 * Body accumulation is bounded by a {@link BodyCapture} (per-turn cap + the
 * shared global budget): text and tool-argument bytes stop accumulating once
 * either is hit. Token usage, stop reason and the ordered tool-call NAMES keep
 * being tracked regardless, so a truncated or shed turn still carries complete
 * metadata. `dispose()` releases the turn's budget reservation.
 */
export class AnthropicStreamAccumulator {
  private buffer = "";
  // Accumulate delta fragments in arrays and join once in content(): appending
  // to a growing string per delta is O(n^2) over a long streamed response.
  private textByIndex = new Map<number, string[]>();
  private toolByIndex = new Map<number, { id: string; name: string; json: string[] }>();
  private order: number[] = [];
  /** Tool names in call order — metadata, captured even when the body is shed. */
  readonly toolCalls: string[] = [];
  private readonly meter: BodyCapture;
  /** Set once the raw (unparsed) buffer overflows; stops all further processing. */
  private overflowed = false;
  inputTokens = 0;
  outputTokens = 0;
  /**
   * Cached-read input tokens; only the Anthropic wire reports them. Null means
   * the upstream did not report the field at all, which is distinct from a
   * reported zero.
   */
  cacheReadTokens: number | null = null;
  stopReason: string | null = null;

  constructor(budget: CaptureBudget = sharedCaptureBudget) {
    this.meter = new BodyCapture(budget);
  }

  /** This turn's body state after bounded capture: "full" | "truncated" | "shed". */
  get bodyState(): BodyState {
    return this.meter.bodyState;
  }

  /** Release this turn's budget reservation (call once the turn is handed off). */
  dispose(): void {
    this.meter.dispose();
  }

  push(chunk: string): void {
    // Once the raw buffer has overflowed, stop buffering entirely — a
    // hung/adversarial upstream must not grow memory without bound. Usage /
    // stop-reason / tool names already captured stand; the body is truncated.
    if (this.overflowed) return;
    this.buffer += chunk;
    // PC10: MAX_CAPTURE counts DECODED content deltas, not the raw unparsed
    // buffer. A stream that never sends a newline (or a single giant data line)
    // would grow this.buffer without bound, so cap the raw buffer too: on
    // overflow, stop buffering and mark the body truncated (best-effort —
    // usage/stop-reason/tool names captured so far stand).
    if (this.buffer.length > this.meter.maxTurnBytes) {
      this.meter.truncate();
      this.overflowed = true;
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

  private handleEvent(ev: Record<string, unknown>): void {
    const type = ev.type as string | undefined;
    if (type === "message_start") {
      const msg = ev.message as
        | { usage?: { input_tokens?: number; cache_read_input_tokens?: number } }
        | undefined;
      if (typeof msg?.usage?.input_tokens === "number") this.inputTokens = msg.usage.input_tokens;
      if (typeof msg?.usage?.cache_read_input_tokens === "number") {
        this.cacheReadTokens = msg.usage.cache_read_input_tokens;
      }
    } else if (type === "content_block_start") {
      const index = ev.index as number;
      const block = ev.content_block as { type?: string; id?: string; name?: string } | undefined;
      if (block?.type === "text") {
        this.textByIndex.set(index, []);
        this.order.push(index);
      } else if (block?.type === "tool_use") {
        this.toolByIndex.set(index, { id: block.id ?? "", name: block.name ?? "", json: [] });
        this.order.push(index);
        // Tool names are metadata (a few bytes): recorded even when shed.
        this.toolCalls.push(block.name ?? "(unnamed)");
      }
    } else if (type === "content_block_delta") {
      const index = ev.index as number;
      const delta = ev.delta as { type?: string; text?: string; partial_json?: string } | undefined;
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        // Bulk content: only kept while the body meter still accepts bytes. The
        // `accepting` guard short-circuits the byte measurement itself once the
        // body is clipped or shed — otherwise `utf8Bytes` would run on every
        // remaining delta of a long stream (accept would reject them anyway).
        // Thresholds are unchanged: `accept` already returns false in that state.
        if (this.meter.accepting && this.meter.accept(utf8Bytes(delta.text))) {
          let parts = this.textByIndex.get(index);
          if (parts === undefined) {
            parts = [];
            this.textByIndex.set(index, parts);
          }
          parts.push(delta.text);
        }
      } else if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
        const t = this.toolByIndex.get(index);
        if (t && this.meter.accepting && this.meter.accept(utf8Bytes(delta.partial_json))) {
          t.json.push(delta.partial_json);
        }
      }
    } else if (type === "message_delta") {
      const delta = ev.delta as { stop_reason?: string | null } | undefined;
      const usage = ev.usage as
        | { output_tokens?: number; input_tokens?: number; cache_read_input_tokens?: number }
        | undefined;
      if (delta && "stop_reason" in delta) this.stopReason = delta.stop_reason ?? null;
      if (typeof usage?.output_tokens === "number") this.outputTokens = usage.output_tokens;
      // Some upstreams only report input tokens at the end (OpenAI/Mantle streams).
      if (typeof usage?.input_tokens === "number" && usage.input_tokens > 0) {
        this.inputTokens = usage.input_tokens;
      }
      if (typeof usage?.cache_read_input_tokens === "number") {
        this.cacheReadTokens = usage.cache_read_input_tokens;
      }
    }
  }

  /** Reconstruct the Anthropic content-block array from accumulated deltas. */
  content(): unknown[] {
    // A shed body is not stored at all; metadata (usage/stop/tool names) stands.
    if (this.meter.shed) return [];
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
    if (this.meter.truncated) {
      blocks.push({
        type: "text",
        text: `\n[capture truncated: response exceeded ${this.meter.maxTurnBytes} bytes]`,
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
  const budget = budgetFor(store);

  if (contentType.includes("text/event-stream")) {
    return captureStreaming(store, ctx, response, signal, budget);
  }

  // Non-streaming: return the response immediately; record from a clone in the
  // background so storage-write latency is off the client's TTFB.
  const clone = response.clone();
  runDetached(async () => {
    try {
      const systemHash = await store.recordSystemPrompt(ctx.system);
      const body = (await clone.json()) as AnthropicMessageBody;
      await captureNonStreaming(store, ctx, systemHash, body, budget);
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
 *
 * The client branch is built the same way regardless of shedding: bounded
 * capture only ever governs the log branch's accumulation, never what the client
 * receives.
 */
function captureStreaming(
  store: LogStore,
  ctx: CaptureContext,
  response: Response,
  signal: AbortSignal | undefined,
  budget: CaptureBudget,
): Response {
  if (!response.body) return response;
  const [clientBranch, logBranch] = response.body.tee();

  // PC8: the log branch is a FOLLOWER. When the client branch finishes (the
  // stream the user actually consumes ends or is cancelled), promptly cancel the
  // log-branch read so the tee doesn't keep the upstream socket alive for the
  // slower/idle branch. `clientDone` fires on client-branch close OR cancel.
  //
  // `clientCancelled` distinguishes the two: it is set ONLY when the consumer
  // DISCONNECTS mid-stream (the monitored branch's `cancel` callback), never on a
  // normal end-of-stream close — so the capture can tell a partial body from a
  // complete one.
  let clientCancelled = false;
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
      clientCancelled = true; // client disconnected mid-stream
      void clientReader.cancel(reason).catch(() => {});
      clientDone.abort();
    },
  });

  runDetached(async () => {
    const reader = logBranch.getReader();
    // Admit this capture against the shared budget at stream start (before any
    // await) so a burst of concurrent large streams sheds promptly.
    const acc = new AnthropicStreamAccumulator(budget);
    // `earlyTerminated` marks a GENUINE cut: the capture timeout (hung upstream)
    // or the request-signal abort (client disconnect). It is NOT set by
    // `onClientDone`, which also fires on a normal end-of-stream. A turn cut this
    // way is recorded `body_state: "truncated"` so its (incomplete) payload is
    // not indistinguishable from a complete one.
    let earlyTerminated = false;
    // Cancel the log-branch read on client disconnect or after a wall-clock cap
    // so a slow/hung upstream can't pin the branch (and its socket) open.
    const timeout = setTimeout(() => {
      earlyTerminated = true;
      void reader.cancel(new Error("log capture timed out")).catch(() => {});
    }, store.captureTimeoutMs);
    const onAbort = () => {
      earlyTerminated = true;
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
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) acc.push(decoder.decode(value, { stream: true }));
      }
      const respondedAt = new Date().toISOString();
      const latencyMs = latencyBetween(ctx.requestedAt, respondedAt);
      // A genuine early cut (timeout / client disconnect) downgrades a body that
      // the meter still called "full" to "truncated": the accumulation stopped
      // mid-stream, so the payload is partial. A body the meter already shed or
      // clipped keeps that more specific state.
      const bodyState =
        acc.bodyState === "full" && (earlyTerminated || clientCancelled)
          ? "truncated"
          : acc.bodyState;
      const turn: TurnRecord = {
        sessionId: ctx.sessionId,
        canonicalModel: ctx.canonicalModel,
        invocationModel: ctx.invocationModel,
        backend: ctx.backend,
        translationPath: ctx.translationPath,
        streamed: true,
        systemHash,
        ...messagesFields(ctx, budget.maxTurnBytes),
        ...(ctx.promptSurface ? { promptSurface: ctx.promptSurface } : {}),
        ...(ctx.tools ? { tools: ctx.tools } : {}),
        ...(ctx.servingKeyLabel ? { servingKeyLabel: ctx.servingKeyLabel } : {}),
        responseContent: acc.content(),
        stopReason: acc.stopReason,
        usage: { inputTokens: acc.inputTokens, outputTokens: acc.outputTokens },
        ...(acc.cacheReadTokens !== null ? { cacheReadTokens: acc.cacheReadTokens } : {}),
        toolCalls: acc.toolCalls,
        bodyState,
        requestedAt: ctx.requestedAt,
        respondedAt,
        ...(latencyMs !== undefined ? { latencyMs } : {}),
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
      acc.dispose();
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
