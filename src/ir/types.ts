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
  /** Media type, e.g. "image/png", "image/jpeg". */
  readonly mediaType: string;
  /** Base64-encoded image bytes. */
  readonly data: string;
}

/** Any content block in a message. */
export type IRContentBlock = IRTextBlock | IRToolUseBlock | IRToolResultBlock | IRImageBlock;

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
export type IRStopReason = "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";

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
  readonly usage: IRUsage;
}
