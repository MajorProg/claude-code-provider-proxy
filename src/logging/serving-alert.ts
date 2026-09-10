/**
 * Audible alert when the serving ACCOUNT changes (user request).
 *
 * Tracks the last (provider, key-label) that successfully served; when a
 * request is served by a different account — failover to the next pool key,
 * cooldown expiry reinstating the primary, a tier shifting providers — this
 * writes a terminal BEL (\a) to stdout and a clearly-marked log line. The BEL
 * byte survives Docker's log driver, so `docker compose logs -f` /
 * `bun run cli logs` in a terminal with "audible bell" enabled pings on the
 * host. Gated by config `servingChangePing` (default off).
 *
 * Signal is the KEY (account), not the model: normal traffic alternates
 * haiku/sonnet models constantly — pinging on model changes would be noise.
 * First-ever serving does not ping (nothing changed). Module-level state is
 * intentional: it survives hot-reloads and needs no Runtime plumbing;
 * tests reset it via {@link resetServingAlert}.
 */
import type { ProxyConfig } from "../config.ts";
import { logger } from "./logger.ts";

let lastServingKey: string | null = null;

/** Forget the last serving account (tests reset state between cases). */
export function resetServingAlert(): void {
  lastServingKey = null;
}

/**
 * The ASCII BEL byte. Written as fromCharCode(7) because the "\a" escape
 * literal is silently rewritten to plain "a" by the biome formatter.
 */
const BEL = String.fromCharCode(7);

/** The currently-remembered serving account (tests / diagnostics). */
export function currentServingKey(): string | null {
  return lastServingKey;
}

/**
 * Record a successful serving. When the account differs from the previous
 * one (and `servingChangePing` is enabled), emit the BEL + warn line.
 */
export function noteServing(
  config: Pick<ProxyConfig, "servingChangePing">,
  provider: string,
  keyLabel: string | undefined,
  model: string,
): void {
  if (config.servingChangePing !== true) return;
  const key = keyLabel !== undefined && keyLabel !== "" ? `${provider}/${keyLabel}` : provider;
  try {
    if (lastServingKey !== null && lastServingKey !== key) {
      process.stdout.write(BEL);
      logger.warn("SERVING ACCOUNT CHANGED", {
        from: lastServingKey,
        to: key,
        model,
      });
    }
  } finally {
    lastServingKey = key;
  }
}
