/**
 * .env read/write + auth-token tests — hermetic (real temp files, no network).
 *
 * setEnvValue must preserve comments/order/other keys and only rewrite the one
 * requested key (or append it). getEnvValue is last-occurrence-wins.
 * generateAuthToken must produce a 256-bit ccpp_ token.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INBOUND_KEY_PLACEHOLDER,
  generateAuthToken,
  getEnvValue,
  isInboundKeyUnset,
  setEnvValue,
} from "../src/cli/env.ts";

let dir: string;
let envPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccpp-env-"));
  envPath = join(dir, ".env");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("generateAuthToken", () => {
  test("produces a ccpp_-prefixed base64url token with 256 bits of entropy", () => {
    const t = generateAuthToken();
    expect(t.startsWith("ccpp_")).toBe(true);
    const body = t.slice("ccpp_".length);
    // 32 bytes base64url (no padding) = 43 chars, url-safe alphabet only.
    expect(body).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Overwhelmingly unique.
    expect(generateAuthToken()).not.toBe(t);
  });
});

describe("isInboundKeyUnset", () => {
  test("treats undefined, empty, whitespace, and the placeholder as unset", () => {
    expect(isInboundKeyUnset(undefined)).toBe(true);
    expect(isInboundKeyUnset("")).toBe(true);
    expect(isInboundKeyUnset("   ")).toBe(true);
    expect(isInboundKeyUnset(INBOUND_KEY_PLACEHOLDER)).toBe(true);
  });
  test("treats a real value as set", () => {
    expect(isInboundKeyUnset("ccpp_realtoken")).toBe(false);
  });
});

describe("getEnvValue / setEnvValue", () => {
  test("getEnvValue returns undefined for a missing file or absent key", () => {
    expect(getEnvValue(envPath, "PROXY_INBOUND_KEY")).toBeUndefined();
    writeFileSync(envPath, "OTHER=1\n");
    expect(getEnvValue(envPath, "PROXY_INBOUND_KEY")).toBeUndefined();
  });

  test("setEnvValue appends a new key to a fresh file", () => {
    setEnvValue(envPath, "PROXY_INBOUND_KEY", "ccpp_abc");
    expect(getEnvValue(envPath, "PROXY_INBOUND_KEY")).toBe("ccpp_abc");
    expect(readFileSync(envPath, "utf8").endsWith("\n")).toBe(true);
  });

  test("setEnvValue rewrites an existing key in place, preserving comments and other keys", () => {
    writeFileSync(
      envPath,
      "# header comment\nPORT=8787\nPROXY_INBOUND_KEY=old\n# trailing comment\nBIND_IP=192.168.1.5\n",
    );
    setEnvValue(envPath, "PROXY_INBOUND_KEY", "new");
    const text = readFileSync(envPath, "utf8");
    expect(getEnvValue(envPath, "PROXY_INBOUND_KEY")).toBe("new");
    // Comments and unrelated keys survive, order preserved.
    expect(text).toContain("# header comment");
    expect(text).toContain("# trailing comment");
    expect(getEnvValue(envPath, "PORT")).toBe("8787");
    expect(getEnvValue(envPath, "BIND_IP")).toBe("192.168.1.5");
    // Old value gone (not duplicated).
    expect(text.match(/PROXY_INBOUND_KEY=/g)?.length).toBe(1);
  });

  test("getEnvValue is last-occurrence-wins for duplicate keys", () => {
    writeFileSync(envPath, "K=first\nK=second\n");
    expect(getEnvValue(envPath, "K")).toBe("second");
  });

  test("setEnvValue writes the file with owner-only (0o600) permissions", () => {
    setEnvValue(envPath, "PROXY_INBOUND_KEY", "ccpp_secret");
    const { statSync } = require("node:fs");
    const mode = statSync(envPath).mode & 0o777;
    // On POSIX this is exactly 0o600; skip the strict check on platforms that
    // don't honor mode bits.
    if (process.platform !== "win32") {
      expect(mode).toBe(0o600);
    }
  });
});
