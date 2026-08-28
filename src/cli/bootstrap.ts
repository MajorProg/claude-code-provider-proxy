/**
 * Config bootstrap: create .env and config.local.jsonc from their committed
 * examples when missing, and ensure a real (auto-generated) proxy auth token
 * exists in .env. Idempotent — safe to run on every `setup`/`up`.
 *
 * The generated token is shared: it lands in .env PROXY_INBOUND_KEY, is
 * interpolated into config.local.jsonc via ${PROXY_INBOUND_KEY}, and is written
 * into Claude Code's settings by the claude module.
 */
import { copyFileSync, existsSync } from "node:fs";
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
 * Ensure .env and config.local.jsonc exist (copied from examples if missing).
 * Returns true if a fresh .env was just created (caller may want to prompt for
 * BEDROCK_API_KEY).
 */
export function ensureConfigFiles(paths: BootstrapPaths): { createdEnv: boolean } {
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
