# Porting Guide: 55-Finding Upgrade

This document summarizes all changes by file to help port the delta to forked projects.

**Commit**: `cbb4380`
**Scope**: 45 files changed (+4,882/-258)
**Reference**: See handoff summary in conversation for detailed rationale

---

## New Files (Port Entirely)

### `src/stream/keepalive-tee.ts` ⭐ NEW
**Purpose**: P1 - Byte-preserving keep-alive idle-tee for Path P (native Anthropic passthrough)

**What it does**:
- Wraps upstream SSE stream and injects standard `event: ping` frames during idle gaps
- Default 5s idle timeout before injecting a ping
- Passes ALL upstream bytes through unchanged (verbatim passthrough)
- Prevents Claude Code stream idle watchdog (~180s) from aborting during long tool executions

**Key exports**:
- `keepAliveTee(upstream: ReadableStream<Uint8Array>, idleMs?: number): ReadableStream<Uint8Array>`
- `DEFAULT_PASSTHROUGH_PING_IDLE_MS = 5000`

**Dependencies**: None (standalone)

---

### `tests/catalog-backoff.test.ts` ⭐ NEW
**Purpose**: Tests for PC9 - catalog discovery exponential backoff + per-source cooldown

**What it tests**:
- `SourceBackoff` class: exponential cooldown (60s→30min, capped at 30min)
- Backoff reset on successful discovery
- Multiple sources tracked independently
- Integration with `CatalogManager`

---

### `tests/fixtures/openai-reasoning-stream.sse` ⭐ NEW
**Purpose**: R1/R2 - Real captured OpenAI SSE stream with `reasoning` blocks

**Contents**:
- Moonshot Kimi model (returns `thinking` blocks)
- Shows `delta.reasoning` field usage (not `reasoning_content`)

---

### `tests/fixtures/openai-reasoning-text.json` ⭐ NEW
**Purpose**: R1 - Non-streaming OpenAI response with reasoning

---

### `tests/keepalive-tee.test.ts` ⭐ NEW
**Purpose**: Tests for P1 - keepalive tee functionality

**What it tests**:
- Ping injection after idle timeout
- Byte-preserving passthrough (no data corruption)
- Multiple chunks reset idle timer
- Clean teardown on upstream end/error
- Backpressure handling

---

## Core Source Files (Modified)

### `src/ir/types.ts` ⭐ CRITICAL
**Changes**: R1/R4/C1/SR9 - IR extensions for reasoning + cache + stop_sequence

**Additions**:
```typescript
// R1: New IR block type for thinking/reasoning
export interface IRThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;  // C1: Converse signature (408-char live-verified)
}

// Update IRContentBlock union
export type IRContentBlock = IRTextBlock | IRToolUseBlock | IRThinkingBlock;

// R4: Stop reason extended
export type IRStopReason =
  | "end_turn"
  | "max_tokens"
  | "stop_sequence"
  | "tool_use"
  | "refusal";  // TC7: OpenAI content_filter refusal

// SR9: Cache token fields in IRUsage
export interface IRUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;      // SR4
  cacheCreationInputTokens?: number;  // SR4/PC7
}

// SR9: Inferred stop sequence (when exactly one stop_sequences configured)
export interface IRResponse {
  // ... existing fields
  stopSequence?: string;  // Only set when unambiguous
}
```

**Why**: Central IR extension point for all three translation paths

---

### `src/paths/relay.ts` ⭐ CRITICAL
**Changes**: Central trust-boundary helpers + IR serializer

**New exports**:

1. **SEC-1**: `readBodyWithLimit(request, maxBytes)` - 25MiB default limit
   - Fast reject if `Content-Length` exceeds limit
   - Streamed byte-cap enforcement
   - Throws `PayloadTooLargeError`

2. **SEC-2**: `parseJsonSafe(text, maxDepth=64)` - Prototype pollution protection
   - Reviver strips `__proto__`, `constructor`, `prototype`
   - `Object.hasOwn` for field checks
   - Max depth guard

3. **SEC-6**: `validateInboundBlock(block)` - 400 on unknown block types
   - Returns `null` if valid
   - Returns `ProxyError` with details if invalid

4. **TC3**: `normalizeToolSchema(schema, dialect)` - JSON-Schema dialect rewrite
   - `converse`: no changes
   - `openai`: ensure `type` and `properties`
   - `openai-strict`: + `additionalProperties: false` + `required: all keys`

5. **G3**: `sanitizeToolCallId(id)` - Stable sanitization
   - `^[a-zA-Z0-9_-]+$` pattern
   - Deterministic so tool_use↔tool_result pairing survives

6. **G10/SEC-10**: `coerceToolInput(input)` - Safety coerce
   - Always returns object (empty `{}` for malformed)

7. **TC6**: `normalizeImageSource(block)` - Image handling
   - Validates `media_type` ∈ {png,jpeg,gif,webp}
   - Unknown base64 media type → `image/png`
   - URL source handling for Converse/Mantle split

8. **PC7**: `estimateTokensFromChars(text)` - ~4 chars/token fallback
   - Used when upstream omits stream usage

9. **SR9**: `irToAnthropicResponse(ir)` - IR serializer
   - Emits `thinking` blocks with optional `signature`
   - Emits `cache_read_input_tokens`/`cache_creation_input_tokens`
   - Infers `stop_sequence` when exactly one configured

**Modified functions**:
- `parseJsonObject` → calls `parseJsonSafe`
- `parseUpstreamJson` → calls `parseJsonSafe`
- `assertUpstreamOk` → validates + relays upstream errors

**Why**: Centralizes all trust-boundary validation and IR serialization

---

### `src/paths/normalize.ts` ⭐ CRITICAL
**Changes**: TC3/TC4/TC5/TC6/G1/G2/SEC-5 - Request normalization

**New exports**:

1. **TC4**: `mergeConsecutiveRoleMessages(messages)` - Same-role merge
   - Converse rejects adjacent same-role messages
   - Joins text blocks with `\n\n`

2. **TC5**: `systemFieldToText(system)` - System prompt text extraction
   - Joins text blocks with `\n\n` (was empty `""` glue)
   - Skips + logs non-text blocks

3. **G2**: `reconcileToolBlocks(messages)` - Tool pairing fix
   - Inject synthetic `tool_result` for dangling `tool_use`
   - Prune orphan `tool_result` blocks
   - Critical for Mistral (400s without this)

4. **SEC-5**: System hoisting trust preservation
   - `role: "system"` before first user → top-level system prompt (trusted)
   - `role: "system"` after conversation start → demoted to `user` turn (untrusted)
   - OWASP LLM01 mitigation

5. **TC6**: Image source validation + handling
   - Validated media types
   - URL → Converse: placeholder text
   - URL → Mantle: passthrough (data:/S3 only, SSRF-safe)

6. **TC3**: Tool schema normalization via `relay.ts`

7. **G1**: Block ordering preserved (tool_result before user text)

**Modified functions**:
- `normalizeMessages()` → calls all above helpers in correct order

**Why**: All three paths (P/C/M) depend on this normalization

---

### `src/paths/converse.ts` ⭐ PATH C
**Changes**: C1/TC1-TC8 - Bedrock Converse API mapping

**Key changes**:

1. **C1**: Reasoning/thinking support
   - Non-streaming: `reasoningContent[].reasoningText` → `IRThinkingBlock`
   - Streaming: `contentBlockDelta.reasoningContent` → thinking block
   - Preserves `signature` field (408-char live-verified)

2. **TC2**: Image in `tool_result` → `[image omitted]` placeholder
   - Converse has no image support in tool results

3. **TC4**: Same-role message merging (calls `normalize.ts`)

4. **TC6**: Image source handling
   - `url` source → placeholder text block (Converse: base64-only)

5. **TC7**: `content_filter` stop reason → `refusal`

6. **TC8**: Assistant `content: null` when `tool_calls` present

7. **G10**: Tool input coercion to object

**Streaming fixes**:
- **SR10**: Eventstream header scan fixed
  - Was aborting on first non-string header
  - Now skips all header value types by correct byte length

**Why**: Converse path for Bedrock native models

---

### `src/paths/mantle.ts` ⭐ PATH M
**Changes**: R1/R2/TC3/TC6/G1-G10/SR5-SR11 - OpenAI Chat Completions

**Key changes**:

1. **R1/R2**: Reasoning content mapping
   - Primary: `delta.reasoning` (Bedrock Mantle live-verified)
   - Fallback: `delta.reasoning_content` (vLLM)
   - Maps to `IRThinkingBlock`

2. **TC3**: Tool schema normalization
   - Calls `normalizeToolSchema(schema, dialect)`
   - Opt-in `strictTools` via config

3. **TC6**: Image handling
   - `url` source → passes through (Mantle accepts data:/S3 URLs)
   - Plain `http(s)` URLs → relayed 400 from upstream

4. **TC7**: `refusal` → IR stop reason + content

5. **G1-G10**: All tool handling fixes
   - Block ordering
   - Tool reconciliation
   - ID sanitization
   - Input coercion

**Streaming changes** (SR5-SR11):
- **SR5**: Array-form `delta.content` + `delta.refusal`
- **SR6**: SSE parser spec-correct (multi-line data accumulation)
- **SR8**: Tool-call stream defers block open until id known
- **SR11**: Ignores late deltas after `finish_reason`
- **SR9**: Cache token fields from `usage.prompt_tokens_details`

**Why**: Path M for Bedrock Mantle + external OpenAI-compatible providers

---

### `src/paths/passthrough.ts` ⭐ PATH P
**Changes**: P1/TC9/PC6 - Verbatim relay with keepalive

**Key changes**:

1. **P1**: `keepAliveTee` integration
   - Wraps streaming response body
   - Injects synthetic pings during idle gaps
   - Byte-preserving (all upstream data unchanged)

2. **TC9**: Never mutates inbound body
   - `withModel()` avoids double-clone
   - Respects logging tee immutability

3. **PC6**: Performance optimization
   - Single JSON clone for model rewrite

**Why**: Path P for native Anthropic (Claude on Mantle + external type:anthropic)

---

### `src/stream/anthropic-sse.ts` ⭐ STREAMING
**Changes**: R4/PC10/SR1/SR2 - Anthropic SSE emitter

**Key changes**:

1. **R4**: Thinking→text→tool_use ordering enforcement
   - `closeThinking()` called before opening text/tool blocks
   - Prevents malformed stream ordering

2. **SR1**: Single long-lived ping interval
   - Replaced per-event timer churn
   - Pings only when `Date.now() - lastWriteAt >= pingInterval`

3. **SR2**: Immediate ping after `message_start`
   - Prevents early timeout

4. **PC10**: Raw buffer size guard (8MiB)
   - `AnthropicStreamAccumulator` limit

**New exports**:
- `AnthropicSseEmitter` methods unchanged, internals optimized

**Why**: Used by all three paths (C/M/P) for Anthropic SSE output

---

### `src/stream/converse-events.ts` ⭐ STREAMING
**Changes**: C1/SR10 - Converse binary eventstream decoder

**Key changes**:

1. **C1**: Reasoning content decoding
   - `reasoningContent` → `IRThinkingBlock` with signature
   - Both non-streaming and streaming paths

2. **SR10**: Header scan fix (CRITICAL)
   - Was: abort on first non-string header value
   - Now: skips all header value types by correct byte length
   - Was silently dropping entire frames before this fix

**Why**: Path C streaming decoder

---

### `src/stream/openai-sse.ts` ⭐ STREAMING
**Changes**: R1/R2/SR3-SR11 - OpenAI SSE decoder

**Key changes**:

1. **R1/R2**: Reasoning content handling
   - Primary field: `delta.reasoning` (Mantle)
   - Fallback: `delta.reasoning_content` (vLLM)
   - Maps to thinking blocks

2. **SR3**: Incremental `message_delta` usage
   - 5s default cadence, coalesced
   - Backpressure-guarded
   - `fail()` emits best-effort usage before error

3. **SR4**: Cache token plumbing
   - `usage.prompt_tokens_details.cached_tokens`
   - Emits `cache_read_input_tokens`/`cache_creation_input_tokens`

4. **SR6**: SSE parser spec-correct
   - Multi-line `data:` accumulation
   - Blank-line dispatch
   - `:`-comment skip
   - `flush()` on done

5. **SR8**: Tool-call stream handling
   - Defers block open until id known
   - Buffers early arg fragments
   - Stable synthetic index

6. **SR11**: Ignores late deltas after `finish_reason`

7. **PC10**: Raw buffer size guard (8MiB)

**New state**:
- `SseLineParser` with 16MiB buffer limit
- Proper event accumulation state machine

**Why**: Path M streaming decoder

---

### `src/http/upstream.ts` ⭐ NETWORKING
**Changes**: PC1-PC5 - Timeouts, retries, backoff, preconnect

**Key changes**:

1. **PC1**: Split timeouts
   - `DEFAULT_TIME_TO_HEADERS_MS = 120000` (cleared once headers arrive)
   - `readWithIdleTimeout(stream, idleMs)` - 60s per-chunk watchdog
   - Never kills stream body after headers

2. **PC2**: Idempotency-aware retries
   - `retryTransientStatus: boolean` option
   - Streaming callers pass `false` (never replay body mid-stream)
   - Pre-response connection errors still retried

3. **PC3**: `parseRetryAfter(header)` - Retry-After parsing
   - Delta-seconds format
   - HTTP-date format
   - Capped at 30s

4. **PC4**: Exponential backoff + full jitter
   - `baseDelay * 2^attempt` (base 150ms, cap 10s)
   - Full jitter added
   - Subordinate to Retry-After

5. **PC5**: Preconnect support
   - `preconnectOrigin(url)` helper
   - `Bun.fetch.preconnect` option
   - Wired into `HEAD /api/hello`

**New exports**:
- `FetchOptions.retryTransientStatus`
- `FetchOptions.preconnect`
- `parseRetryAfter()`
- `exponentialBackoff()`

**Why**: All three paths use this for upstream fetches

---

### `src/model/catalog.ts` ⭐ DISCOVERY
**Changes**: PC9 - Discovery jitter + backoff

**Key changes**:

1. **PC9**: Refresh jitter
   - ±15% randomization on refresh interval
   - Self-rescheduling `setTimeout`

2. **PC9**: `SourceBackoff` class
   - Exponential cooldown: 60s→30min (capped)
   - Per-source tracking (region + external providers)
   - Reset on successful discovery

**New state**:
- `SourceBackoff.cooldownUntil` map
- Backoff state in `CatalogManager`

**Why**: Prevents thundering herd on discovery failures

---

### `src/config.ts` ⭐ CONFIG
**Changes**: TC3/SEC-4/PC8 - Configuration extensions

**New config fields**:

1. **TC3**: `ExternalProviderConfig.strictTools?: boolean`
   - Opt-in to `openai-strict` schema dialect
   - Sets `additionalProperties: false` + `required: all`

2. **SEC-4**: `RequestLimits` interface
   ```typescript
   interface RequestLimits {
     maxMessages?: number;
     maxContentBlocksPerMessage?: number;
     maxTools?: number;
   }
   ```
   - Applied in request validation

3. **PC8**: `LoggingConfig.captureTimeoutMs?: number`
   - Default: 120000 (2 minutes)
   - Timeout for log capture client branch

4. **SEC-9**: SSRF guard config
   - Environment variable controls (if needed)

**Why**: All features are configurable

---

### `src/errors.ts` ⭐ ERRORS
**Changes**: SEC-1/SEC-7 - New error types

**New exports**:

1. **SEC-1**: `PayloadTooLargeError`
   - HTTP 413
   - Message includes size + limit
   - Thrown by `readBodyWithLimit()`

2. **SEC-7**: Generic internal error
   - Non-ProxyError catch-all
   - Returns: `"Internal server error (reference: <uuid>)"`
   - No raw `err.message` leak
   - Detail logged with UUID

**Why**: Clean error taxonomy for trust boundary

---

### `src/server.ts` ⭐ ENTRY POINT
**Changes**: SEC-1/SEC-7/G2 - Request validation + error handling

**Key changes**:

1. **SEC-1**: Request size limit
   - Calls `readBodyWithLimit()` before parsing
   - 25MiB default

2. **SEC-4**: Request limits validation
   - `maxMessages`, `maxBlocksPerMessage`, `maxTools`
   - Early 400 rejection

3. **SEC-7**: Top-level error handler
   - Wraps all request handlers
   - Returns generic error for non-ProxyError
   - Logs detail with UUID

4. **PC5**: Preconnect warmup
   - `HEAD /api/hello` endpoint
   - Calls `preconnectOrigin()` for configured upstreams

**Why**: Main entry point for all requests

---

### `src/router.ts` ⭐ ROUTING
**Changes**: Minor - routing logic unchanged

**Notes**:
- Path selection logic untouched
- All changes are in path handlers, not router

---

### `src/logging/capture.ts` ⭐ LOGGING
**Changes**: PC8 - Capture timeout

**Key changes**:

1. **PC8**: Timeout enforcement
   - `captureTimeoutMs` from config (default 2min)
   - Client branch wrapped in ReadableStream (not TransformStream)
   - `clientDone.abort()` on end/cancel
   - Prompt cleanup, no dangling connections

**Why**: Prevents log capture from blocking shutdown

---

### `src/logging/log-store.ts` ⭐ LOGGING
**Changes**: Minor - schema unchanged

**Notes**:
- Log record structure unchanged
- Performance improvements only

---

## Test Files (Reference for Verification)

All test files were updated to cover new functionality. Key test files:

- `tests/relay.test.ts` - Trust boundary helpers (+343 lines)
- `tests/normalize.test.ts` - Normalization logic (+261 lines)
- `tests/mantle.test.ts` - Path M streaming (+105 lines)
- `tests/converse.test.ts` - Path C reasoning (+106 lines)
- `tests/stream-decoders.test.ts` - SSE parsing (+243 lines)
- `tests/upstream.test.ts` - Retries/backoff (+161 lines)
- `tests/catalog-backoff.test.ts` - NEW: backoff tests
- `tests/keepalive-tee.test.ts` - NEW: tee tests

---

## Documentation Files

### `AGENTS.md`
**Changes**: TC6/SEC-5 - Documented new features

**Added sections**:
- TC6: Image handling verified behavior (Converse vs Mantle)
- SEC-5: Trust-preserving system hoisting rationale

---

### `docs/index.md`
**Changes**: Updated code summary

---

## Porting Priority

**Must port together (tightly coupled)**:
1. `src/ir/types.ts` - Core IR types
2. `src/paths/relay.ts` - Trust boundary helpers
3. `src/paths/normalize.ts` - Normalization logic
4. `src/stream/anthropic-sse.ts` - Emitter (all paths depend on this)
5. `src/paths/converse.ts` + `src/stream/converse-events.ts` - Path C
6. `src/paths/mantle.ts` + `src/stream/openai-sse.ts` - Path M
7. `src/paths/passthrough.ts` + `src/stream/keepalive-tee.ts` - Path P

**Can port independently**:
- `src/http/upstream.ts` - Networking improvements (any time)
- `src/model/catalog.ts` - Discovery backoff (any time)
- `src/config.ts` - New config fields (add defaults for backward compat)
- `src/errors.ts` - New error types (add types first)
- `src/server.ts` - Request validation (after errors.ts)
- `src/logging/capture.ts` - Timeout (any time)

**Tests**: Port test files for each module to verify correctness.

---

## Verification Checklist

After porting, verify:

1. **Type check**: `bun run typecheck` (strict mode)
2. **Lint**: `bun run lint` (100-char line width)
3. **Unit tests**: `bun run test:unit` (528 pass)
4. **Live verification** (if you have creds):
   - Converse reasoning: Claude-on-Converse returns thinking blocks with signature
   - Mantle reasoning: OpenAI-compatible models return reasoning field
   - Path P keepalive: Long tool execution doesn't timeout
   - Backoff: Discovery failures don't spam logs

---

## Questions?

Refer to the handoff summary in the conversation for:
- Live-verified provider facts (Converse vs Mantle behavior)
- Critical operational context (test lanes, live model IDs)
- Key file responsibilities and import relationships
