/**
 * Config bootstrap: create .env and config.local.jsonc from their committed
 * examples when missing, and ensure a real (auto-generated) proxy auth token
 * exists in .env. Idempotent — safe to run on every `setup`/`up`.
 *
 * The generated token is shared: it lands in .env PROXY_INBOUND_KEY, is
 * interpolated into config.local.jsonc via ${PROXY_INBOUND_KEY}, and is written
 * into Claude Code's settings by the claude module.
 */
import { copyFileSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { generateAuthToken, getEnvValue, isInboundKeyUnset, setEnvValue } from "./env.ts";
import { ok, warn } from "./util.ts";

export interface BootstrapPaths {
  root: string;
  env: string;
  envExample: string;
  config: string;
  configExample: string;
}

/** Resolve the standard file paths relative to the project root. */
export function bootstrapPaths(root: string): BootstrapPaths {
  return {
    root,
    env: join(root, ".env"),
    envExample: join(root, ".env.example"),
    config: join(root, "config.local.jsonc"),
    configExample: join(root, "config.example.jsonc"),
  };
}

/**
 * Handle the Docker bind-mount gotcha: when `docker compose up` runs while the
 * host file is missing, the engine creates a DIRECTORY at the bind source. An
 * empty directory is auto-removed (nothing was ever in it); a non-empty one is
 * left alone and reported with remediation — its contents may be the only copy.
 */
function ensureFileNotDirectory(path: string, examplePath: string, label: string): void {
  if (!existsSync(path) || !statSync(path).isDirectory()) return;
  const entries = readdirSync(path);
  if (entries.length === 0) {
    rmSync(path, { recursive: true, force: true });
    warn(`Removed the empty directory Docker created at ${path} (missing bind-mount source).`);
  } else {
    // Array-join (not concatenation) keeps every line within Biome's width.
    const remediation = [
      `${label} exists as a NON-EMPTY directory at ${path} — typically created by`,
      "`docker compose up` when the bind-mount source file was missing. Run",
      "`docker compose down`, back up and remove the directory (or rename it),",
      `then re-run this command to recreate the file from ${examplePath}.`,
    ].join(" ");
    throw new Error(remediation);
  }
}

/**
 * Ensure .env and config.local.jsonc exist (copied from examples if missing).
 * Returns true if a fresh .env was just created (caller may want to prompt for
 * provider keys).
 */
export function ensureConfigFiles(paths: BootstrapPaths): { createdEnv: boolean } {
  ensureFileNotDirectory(paths.env, paths.envExample, ".env");
  ensureFileNotDirectory(paths.config, paths.configExample, "config.local.jsonc");
  let createdEnv = false;
  if (!existsSync(paths.env)) {
    if (!existsSync(paths.envExample)) {
      throw new Error(`.env.example not found at ${paths.envExample}`);
    }
    copyFileSync(paths.envExample, paths.env);
    createdEnv = true;
    warn(".env not found — created from .env.example.");
  }
  if (!existsSync(paths.config)) {
    if (!existsSync(paths.configExample)) {
      throw new Error(`config.example.jsonc not found at ${paths.configExample}`);
    }
    copyFileSync(paths.configExample, paths.config);
    warn("config.local.jsonc not found — created from config.example.jsonc.");
  }
  return { createdEnv };
}

/**
 * Ensure a strong PROXY_INBOUND_KEY exists in .env. Generates one when missing,
 * empty, or still the shipped placeholder. Never overwrites an existing real
 * token unless `rotate` is set (rotating breaks already-configured clients).
 *
 * Returns the effective token so the caller can propagate it to Claude Code.
 */
export function ensureAuthToken(paths: BootstrapPaths, rotate: boolean): string {
  const current = getEnvValue(paths.env, "PROXY_INBOUND_KEY");
  if (rotate || isInboundKeyUnset(current)) {
    const token = generateAuthToken();
    setEnvValue(paths.env, "PROXY_INBOUND_KEY", token);
    ok(
      rotate
        ? "Rotated proxy auth token (PROXY_INBOUND_KEY)."
        : "Generated proxy auth token (PROXY_INBOUND_KEY).",
    );
    return token;
  }
  return current as string;
}
