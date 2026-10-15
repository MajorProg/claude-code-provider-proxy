/**
 * Writer worker entry point.
 *
 * Runs on its own thread and owns EVERY blocking part of turn logging: zstd
 * compression, the atomic body-file write and the SQLite index. The
 * `WriterCore` it constructs opens bun:sqlite HERE, so the main thread never
 * blocks on a synchronous database call.
 *
 * It speaks the `WriterRequest`/`WriterResponse` protocol with `WorkerWriter`:
 * the job body arrives as a transferred ArrayBuffer (zero-copy) while the small
 * metadata arrives structured-cloned; a batch commit inside the core is
 * forwarded back as a `committed` message so the main thread's `WriterStats`
 * stays accurate.
 */

import { errorMessage, logger } from "./logger.ts";
import { type WireJob, WriterCore, type WriterRequest, type WriterResponse } from "./writer.ts";

/** The slice of the worker global scope this entry point uses. */
interface WorkerScope {
  onmessage: ((ev: MessageEvent) => void) | null;
  postMessage(message: WriterResponse): void;
}

const scope = globalThis as unknown as WorkerScope;

/** The core, constructed on `init`; null until then. */
let core: WriterCore | null = null;

/** Post a response back to the main thread. */
function post(message: WriterResponse): void {
  scope.postMessage(message);
}

/** Correlation id of a request, or null for `init` (which has none). */
function requestId(msg: WriterRequest): number | null {
  return msg.type === "init" ? null : msg.id;
}

scope.onmessage = (ev: MessageEvent): void => {
  const msg = ev.data as WriterRequest;
  try {
    handle(msg);
  } catch (err) {
    logger.error("turn writer worker failed to handle a request", {
      kind: msg.type,
      error: errorMessage(err),
    });
    post({ type: "error", id: requestId(msg), message: errorMessage(err) });
  }
};

function handle(msg: WriterRequest): void {
  switch (msg.type) {
    case "init": {
      core = new WriterCore(msg.config, {
        onCommit: (flushCount, turns, ids) => post({ type: "committed", flushCount, turns, ids }),
      });
      post({ type: "ready" });
      return;
    }
    case "job": {
      const active = core;
      if (!active) {
        post({ type: "error", id: msg.id, message: "job received before init" });
        return;
      }
      const wire: WireJob = {
        id: msg.id,
        meta: msg.meta,
        body: msg.body === null ? null : new Uint8Array(msg.body),
      };
      active.apply(wire);
      post({ type: "written", id: msg.id });
      return;
    }
    case "flush": {
      const active = core;
      if (active) active.flushBatch();
      post({ type: "flushed", id: msg.id, flushCount: active ? active.flushCount : 0 });
      return;
    }
    case "prune": {
      const active = core;
      post({ type: "pruned", id: msg.id, pruned: active ? active.prune() : 0 });
      return;
    }
    case "close": {
      const active = core;
      if (active) {
        active.close();
        core = null;
      }
      post({ type: "closed", id: msg.id });
      return;
    }
  }
}
