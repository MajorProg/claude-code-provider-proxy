/**
 * `.env` read/write helpers and proxy auth-token generation.
 *
 * The .env writer preserves existing comments, ordering, and unrelated keys —
 * it only rewrites the single key requested (or appends it if absent). This
 * keeps the human-authored .env.example structure intact after `setup`.
 *
 * Token chain (all three carry the SAME generated secret):
 *   .env PROXY_INBOUND_KEY
 *     -> config.local.jsonc inboundAuth.keys via ${PROXY_INBOUND_KEY}
 *     -> ~/.claude/settings.json ANTHROPIC_AUTH_TOKEN
 */
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/** Placeholder shipped in .env.example; treated as "not yet set". */
export const INBOUND_KEY_PLACEHOLDER = "change-me-to-a-strong-random-string";

/**
 * Generate a cryptographically strong proxy auth token.
 * Format: `ccpp_` + base64url(32 random bytes) = 256 bits of entropy.
 */
export function generateAuthToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64url = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `ccpp_${b64url}`;
}

/** Read a single key's value from a .env file (last occurrence wins). */
export function getEnvValue(envPath: string, key: string): string | undefined {
  if (!existsSync(envPath)) return undefined;
  const text = readFileSync(envPath, "utf8");
  let value: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m && m[1] === key) value = m[2];
  }
  return value;
}

/**
 * Read every `KEY=VALUE` pair from a .env file into a plain record (comment
 * lines ignored; last occurrence wins). Used by `doctor` to build the env the
 * server process would see (process env overlaid with .env).
 */
export function readEnvFile(envPath: string): Record<string, string> {
  if (!existsSync(envPath)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    const key = m?.[1];
    const value = m?.[2];
    if (key !== undefined && value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Set a single key in a .env file, preserving comments/order/other keys.
 * Rewrites the last matching line, or appends the key if it does not exist.
 */
export function setEnvValue(envPath: string, key: string, value: string): void {
  const text = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const lines = text.split(/\r?\n/);
  // Match `key=` by prefix (no RegExp) — avoids any metachar issues if `key`
  // ever contained regex-special characters.
  const prefix = `${key}=`;
  let lastIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line?.startsWith(prefix)) lastIdx = i;
  }
  if (lastIdx >= 0) {
    lines[lastIdx] = `${key}=${value}`;
  } else {
    // Append, keeping a single trailing newline.
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    lines.push(`${key}=${value}`);
  }
  let out = lines.join("\n");
  if (!out.endsWith("\n")) out += "\n";
  // .env holds PROXY_INBOUND_KEY + provider credentials — keep it owner-only.
  // Write atomically (temp file in the same dir + rename) so a crash mid-write
  // can't truncate the operator's .env. The temp file is created 0o600 so the
  // secret is never briefly world-readable.
  const tmp = `${envPath}.${process.pid}.tmp`;
  writeFileSync(tmp, out, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600); // enforce perms even where the mode option is ignored
  } catch {
    // Best-effort on non-POSIX filesystems.
  }
  renameSync(tmp, envPath); // atomic replace on the same filesystem
}

/** True if the inbound key is unset, empty, or still the shipped placeholder. */
export function isInboundKeyUnset(value: string | undefined): boolean {
  return value === undefined || value.trim() === "" || value === INBOUND_KEY_PLACEHOLDER;
}
