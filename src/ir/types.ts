/**
 * Canonical intermediate representation (IR) — DESIGN §6, §12.
 *
 * A provider-neutral model of an Anthropic Messages request/response, shared by
 * the non-Claude translation paths:
 *   - Path C: Anthropic <-> Bedrock Converse
 *   - Path M: Anthropic <-> OpenAI/Mantle
 *
 * Anthropic is the inbound/outbound wire format, so the IR mirrors Anthropic's
 * shape closely; each translator maps its provider's schema to/from this IR.
 *
 * Pure types only — no logic.
 */

/** Roles carried in a conversation. */
export type IRRole = "user" | "assistant";

/** A block of text content. */
export interface IRTextBlock {
  readonly type: "text";
  readonly text: string;
}

/** A model's request to invoke a tool. */
export interface IRToolUseBlock {
  readonly type: "tool_use";
  readonly id: string;
  readonly name: string;
  /** Parsed tool input arguments. */
  readonly input: unknown;
}

/** The result of a tool call, supplied back to the model. */
export interface IRToolResultBlock {
  readonly type: "tool_result";
  readonly toolUseId: string;
  /** Result content as text (structured content is serialized upstream as needed). */
  readonly content: string;
  readonly isError?: boolean;
}

/** An input image block. */
export interface IRImageBlock {
  readonly type: "image";
  /** Media type, e.g. "image/png", "image/jpeg". Empty string when unknown (url source). */
  readonly mediaType: string;
  /** Base64-encoded image bytes (for a base64 source). Mutually exclusive with `url`. */
  readonly data?: string;
  /** Image URL (for a url source, TC6). Mutually exclusive with `data`. */
  readonly url?: string;
}

/**
 * Extended-thinking / reasoning block.
 *
 * Carries the model's reasoning text plus, when the source provider supplies a
 * cryptographic thinking `signature` (Anthropic / Bedrock Converse `reasoning`),
 * that signature verbatim. Signatures are provider-bound and MUST NOT be
 * fabricated: OpenAI-origin reasoning (`reasoning_content`) is plaintext and
 * unsigned, so those blocks carry no `signature` — they are emitted for
 * visibility only. A block with a real signature (Path C / Converse) must
 * preserve it unmodified so multi-turn continuation stays valid.
 */
export interface IRThinkingBlock {
  readonly type: "thinking";
  readonly thinking: string;
  /** Cryptographic thinking signature, when the provider supplies one. */
  readonly signature?: string;
}

/** Any content block in a message. */
export type IRContentBlock =
  | IRTextBlock
  | IRThinkingBlock
  | IRToolUseBlock
  | IRToolResultBlock
  | IRImageBlock;

/** A single conversation message. */
export interface IRMessage {
  readonly role: IRRole;
  readonly content: readonly IRContentBlock[];
}

/** Constraint on which tool (if any) the model should call. */
export type IRToolChoice =
  | { readonly type: "auto" }
  | { readonly type: "any" }
  | { readonly type: "tool"; readonly name: string }
  | { readonly type: "none" };

/** Why generation stopped. Canonical (Anthropic) vocabulary. */
export type IRStopReason = "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | "refusal";

/** Token accounting, including prompt-cache counters when available. */
export interface IRUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens?: number;
  readonly cacheWriteInputTokens?: number;
}

/** A provider-neutral inference response. */
export interface IRResponse {
  readonly role: "assistant";
  readonly content: readonly IRContentBlock[];
  readonly stopReason: IRStopReason;
  /**
   * The stop sequence that terminated generation, when known and unambiguous
   * (SR9). Anthropic surfaces this as `message.stop_sequence`. Bedrock Converse
   * does not report which configured sequence matched, so this is only set when
   * `stopReason === "stop_sequence"` and exactly one sequence was configured.
   */
  readonly stopSequence?: string;
  readonly usage: IRUsage;
}
