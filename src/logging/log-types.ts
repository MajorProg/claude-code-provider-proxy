/**
 * Shared type surface for the turn-logging subsystem (payload files + index).
 *
 * This module is the SPINE every logging module imports:
 *   - the capture layer builds a {@link TurnRecord} on the request path,
 *   - the writer persists it as one zstd turn file plus a row in the SQLite
 *     index (`turns`, keyed by `turn_id`), deduplicating the prompt surface into
 *     `prompt_versions` and recording `failover_events`,
 *   - the readers serve the log viewer and orchestration analysis from
 *     {@link TurnMeta}, {@link PromptVersionRecord}, {@link PromptVersionStats}
 *     and {@link SessionSummary}.
 *
 * Field names mirror the SQLite columns (snake_case in SQL -> camelCase here);
 * no other module re-declares these shapes. This file imports NOTHING, which
 * keeps it safe for the Worker writer (structured-cloneable types only) and for
 * hermetic tests alike.
 */

/** Token usage captured for a turn. */
export interface TurnUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/**
 * Capture state of a turn's body payload. Metadata is ALWAYS recorded; the body
 * is best-effort and may be shed under memory pressure or dropped by retention
 * (the index row survives either way — the client response is never affected).
 *   - `full`      — body written verbatim (within the per-turn byte cap).
 *   - `truncated` — body written but clipped to `maxTurnBytes`.
 *   - `shed`      — body capture dropped under in-flight budget pressure.
 *   - `pruned`    — body deleted by retention; the index row survives.
 */
export type BodyState = "full" | "truncated" | "shed" | "pruned";

/** Every {@link BodyState}, for validating a value crossing the SQLite boundary. */
export const BODY_STATES: readonly BodyState[] = ["full", "truncated", "shed", "pruned"];

/**
 * Short typed slug classifying a failed turn, or null on success. A closed union
 * so the stats surface aggregates failures without stringly drift:
 *   - `rate_limit`       — 429 / quota exhaustion.
 *   - `context_overflow` — request exceeds the model's context window.
 *   - `network`          — connect failure or mid-stream drop.
 *   - `conversion_bug`   — a provider translation defect.
 *   - `refusal`          — the model declined the request.
 */
export type ErrorClass =
  | "rate_limit"
  | "context_overflow"
  | "network"
  | "conversion_bug"
  | "refusal";

/** Every {@link ErrorClass}, for validating a value crossing the SQLite boundary. */
export const ERROR_CLASSES: readonly ErrorClass[] = [
  "rate_limit",
  "context_overflow",
  "network",
  "conversion_bug",
  "refusal",
];

/**
 * One credential-pool transition observed while serving a turn
 * (docs/VIRTUAL_MODELS.md), mirrored into the `failover_events` table. Labels are
 * pool-entry LABELS — never key values.
 */
export interface FailoverEvent {
  readonly fromLabel: string;
  readonly toLabel: string;
  readonly reason: string;
}

/**
 * The full instruction surface a turn ran under, fingerprinted as ONE unit:
 *   (a) the system prompt blocks,
 *   (b) the tool definitions INCLUDING their full schemas (not just names),
 *   (c) injected instruction blocks lifted out of the conversation (e.g. a
 *       `<system-reminder>` envelope or project-rule content), which are
 *       otherwise indistinguishable from ordinary user turns.
 * A change in ANY of the three yields a new `hash`. `hash` is sha256 over a
 * canonical, key-sorted JSON serialization of the three parts; the full content
 * is kept FOREVER in `prompt_versions`.
 */
export interface PromptSurface {
  readonly hash: string;
  /** Canonical JSON of the system prompt blocks. */
  readonly systemJson: string;
  /** Canonical JSON of the tool definitions (names + full schemas). */
  readonly toolsJson: string;
  /** Canonical JSON of injected instruction blocks extracted from the convo. */
  readonly injectedJson: string;
  readonly systemBytes: number;
  readonly toolsBytes: number;
}

/**
 * One stored prompt version (`prompt_versions` row). The content is kept
 * forever (never pruned); every turn links back via `turns.prompt_version`.
 */
export interface PromptVersionRecord extends PromptSurface {
  readonly createdAt: string;
  readonly lastSeen: string;
  readonly seenCount: number;
}

/**
 * A single captured turn (request + response) — the writer's payload. The
 * pre-existing fields keep their names so current callers keep compiling; the
 * optional extensions below carry what the index/body store additionally needs.
 */
export interface TurnRecord {
  readonly sessionId: string;
  readonly canonicalModel: string;
  readonly invocationModel: string;
  readonly backend: string;
  readonly translationPath: string;
  readonly streamed: boolean;
  /** sha256 of the system prompt ALONE (legacy; see `promptVersion` for the
   *  full-surface fingerprint). */
  readonly systemHash: string | null;
  /** Full Anthropic `messages` array as sent by the client. */
  readonly messages: unknown;
  /**
   * Tool-offer trace: custom tools forwarded and Anthropic server-tools dropped
   * on this path. Omitted when the request offered no tools.
   */
  readonly tools?: {
    readonly customTools: string[];
    readonly droppedServerTools: { name: string; type: string | undefined }[];
  };
  /** Assistant response: content blocks (text/tool_use) as Anthropic shape. */
  readonly responseContent: unknown;
  readonly stopReason: string | null;
  readonly usage: TurnUsage;
  /**
   * LABEL of the credential-pool entry that served the turn (cost attribution,
   * VIRTUAL_MODELS.md). Absent for bedrock targets and unlabeled single-key
   * providers.
   */
  readonly servingKeyLabel?: string;
  readonly requestedAt: string;
  readonly respondedAt: string;

  /* ---------- extensions for the index/body store (all optional) ---------- */

  /** Model id actually SERVED (after any failover), when known. */
  readonly modelServed?: string;
  /** End-to-end latency in ms (`requestedAt` -> `respondedAt`). */
  readonly latencyMs?: number;
  /** True when the serving key/candidate differed from the primary. */
  readonly failover?: boolean;
  /** Typed failure slug, or null on success. */
  readonly errorClass?: ErrorClass | null;
  /** Tool names the assistant invoked, in call order. */
  readonly toolCalls?: string[];
  /** Cache-read tokens the provider reported (subset of input, if any). */
  readonly cacheReadTokens?: number;
  /** Prompt-surface hash this turn ran under (see {@link PromptSurface}). */
  readonly promptVersion?: string;
  /** Full prompt surface, carried so the writer can persist it once. */
  readonly promptSurface?: PromptSurface | null;
  /** Capture state of this turn's body payload. Defaults to `"full"`. */
  readonly bodyState?: BodyState;
  /** `turn_id` of the parent turn, when this turn belongs to a subagent. */
  readonly subagentOf?: number;
}

/**
 * One row of the `turns` index (mirrors its columns). Metadata is ALWAYS
 * recorded; the body fields describe the (possibly shed/pruned) payload file.
 * Nullable columns are `| null`; `failover` is the 0/1 column surfaced as a
 * boolean, and `toolCalls` the JSON array column surfaced parsed.
 */
export interface TurnMeta {
  readonly turnId: number;
  readonly sessionId: string;
  readonly seq: number;
  readonly requestedAt: string;
  readonly respondedAt: string | null;
  readonly modelRequested: string | null;
  readonly modelServed: string | null;
  readonly backend: string | null;
  readonly path: string | null;
  readonly promptVersion: string | null;
  readonly stopReason: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly latencyMs: number | null;
  readonly failover: boolean;
  readonly errorClass: ErrorClass | null;
  readonly bodyFile: string | null;
  readonly bodyBytes: number | null;
  readonly bodyState: BodyState | null;
  readonly toolCalls: string[] | null;
  readonly subagentOf: number | null;
}

/**
 * One entry of a prompt version's ordered tool-call shape: a tool name and how
 * many captured turns under that version invoked it, ordered by descending
 * count — the orchestration fingerprint of a prompt (which tools it drives).
 */
export interface ToolCallShape {
  readonly tool: string;
  readonly count: number;
}

/** Latency aggregate (ms) over a prompt version's turns. */
export interface LatencyStats {
  readonly minMs: number;
  readonly maxMs: number;
  readonly avgMs: number;
}

/** Per-prompt-version aggregates for orchestration / cost analysis. */
export interface PromptVersionStats {
  readonly hash: string;
  readonly turns: number;
  readonly sessions: number;
  /** Distinct served model ids, ordered by descending turn count. */
  readonly modelsServed: readonly string[];
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly latency: LatencyStats;
  /** `stop_reason` -> turn count. */
  readonly stopReasons: Readonly<Record<string, number>>;
  /** `error_class` -> turn count (only classes that occurred). */
  readonly failures: Partial<Record<ErrorClass, number>>;
  /** Ordered tool-call shape (descending count). */
  readonly toolCallShape: readonly ToolCallShape[];
}

/** One `sessions` row, plus the token totals the log viewer shows. */
export interface SessionSummary {
  readonly id: string;
  readonly turnCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly firstAt: string;
  readonly lastAt: string;
}

/**
 * One unit of deferred work handed to the writer. Built on the request path
 * (which does NO disk I/O, sqlite, or compression) and consumed by the writer,
 * which owns the compression, the turn file and the SQLite rows.
 */
export interface WriterJob {
  readonly turn: TurnRecord;
  /** 1-based sequence assigned to this turn within its session. */
  readonly seq: number;
  /** Prompt surface to persist (deduplicated by hash); null when unavailable. */
  readonly promptSurface: PromptSurface | null;
  /** Effective body state after any shedding applied at enqueue time. */
  readonly bodyState: BodyState;
  /** Credential-pool transitions observed while serving this turn. */
  readonly failoverEvents: readonly FailoverEvent[];
}

/**
 * Writer configuration, resolved from `logging.*` at LogStore construction. The
 * writer is the ONLY component that touches the filesystem / SQLite, so every
 * storage knob lives here rather than on the request path.
 */
export interface WriterConfig {
  /** Root log directory (`logging.dir`). */
  readonly dir: string;
  /** Session subdirectory under `dir` holding the per-turn body files. */
  readonly sessionDir: string;
  /** SQLite index path (`<dir>/index.db`). */
  readonly indexPath: string;
  /** Prune turn bodies older than this many days; 0 keeps them forever. */
  readonly retentionDays: number;
  /** Per-turn body byte cap before the body is marked truncated. */
  readonly maxTurnBytes: number;
  /** Global in-flight (queued-but-unwritten) body byte budget before shedding. */
  readonly inFlightBudgetBytes: number;
  /** Max delay before a batched index commit is flushed. */
  readonly indexFlushMs: number;
  /** zstd compression level for turn bodies (3 measured best; never 19). */
  readonly zstdLevel: number;
}
