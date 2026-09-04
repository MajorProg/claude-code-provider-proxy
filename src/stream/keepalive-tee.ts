/**
 * Byte-preserving keep-alive idle-tee for Path P (native Anthropic passthrough).
 *
 * Path P relays the upstream SSE stream verbatim (to preserve thinking blocks,
 * signatures, and every byte exactly). It therefore injects none of the
 * synthetic pings that `AnthropicSseEmitter` provides for the translated paths.
 * That leaves Path P dependent on the upstream sending its own keep-alives — an
 * unverified, per-provider assumption. Claude Code's stream idle watchdog fires
 * at ~180s (claude-code #85322/#88900); keep-alive during tool execution is a
 * still-open upstream gap (claude-code #45224), and external `type: anthropic`
 * providers give no ping guarantee at all. A long silent gap → the client
 * aborts.
 *
 * This tee wraps the upstream body and:
 *   - passes ALL upstream bytes through UNCHANGED (verbatim passthrough intact);
 *   - on an idle timer that RESETS on every upstream chunk, injects a STANDARD
 *     Anthropic `event: ping\ndata: {"type":"ping"}\n\n` frame after `idleMs` of
 *     silence (the standard frame — clients can crash on unknown SSE event
 *     types, claude-code #59022);
 *   - stops cleanly when the upstream ends, errors, or the client cancels.
 *
 * It never parses or reorders the stream — it only interleaves ping frames into
 * the idle gaps, which are valid to insert between any two SSE events.
 */

/** Default idle gap (ms) before a synthetic ping is injected on Path P. */
export const DEFAULT_PASSTHROUGH_PING_IDLE_MS = 5_000;

const PING_FRAME = new TextEncoder().encode('event: ping\ndata: {"type":"ping"}\n\n');

/**
 * Wrap an upstream SSE byte stream with a keep-alive idle-tee (P1).
 *
 * @param upstream  The upstream response body (verbatim SSE bytes).
 * @param idleMs    Silence (ms) before injecting a ping. Default 5s.
 * @returns A ReadableStream that relays `upstream` byte-for-byte and injects
 *          standard ping frames during idle gaps.
 */
export function keepAliveTee(
  upstream: ReadableStream<Uint8Array>,
  idleMs: number = DEFAULT_PASSTHROUGH_PING_IDLE_MS,
): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      // A single long-lived interval (SR1-style — no per-chunk timer churn).
      // It only fires a ping when the gap since the last enqueue exceeds idleMs.
      let lastEnqueueAt = Date.now();
      const enqueue = (bytes: Uint8Array): void => {
        controller.enqueue(bytes);
        lastEnqueueAt = Date.now();
      };
      pingTimer = setInterval(() => {
        if (closed) return;
        if (Date.now() - lastEnqueueAt < idleMs) return;
        try {
          // Only inject when the consumer isn't applying backpressure.
          if (typeof controller.desiredSize === "number" && controller.desiredSize <= 0) return;
          enqueue(PING_FRAME);
        } catch {
          // Consumer gone — teardown happens via cancel().
        }
      }, idleMs);
      if (pingTimer && typeof pingTimer === "object" && "unref" in pingTimer) {
        (pingTimer as { unref: () => void }).unref();
      }

      const pump = async (): Promise<void> => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) enqueue(value); // verbatim passthrough
          }
          controller.close();
        } catch (err) {
          controller.error(err);
        } finally {
          closed = true;
          if (pingTimer) clearInterval(pingTimer);
        }
      };
      void pump();
    },
    cancel(reason) {
      closed = true;
      if (pingTimer) clearInterval(pingTimer);
      void reader.cancel(reason).catch(() => {});
    },
  });
}
