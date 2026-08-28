/**
 * BIND_IP derivation tests — hermetic (no network).
 *
 * isPrivateIPv4 is fully deterministic and is the security-relevant core (it
 * gates which addresses the proxy will bind to). listBindCandidates /
 * deriveBindIp / verifyBindIp read the host's real interfaces, so we assert
 * invariants (shape, safety properties) rather than a specific machine's IP.
 */
import { describe, expect, test } from "bun:test";
import {
  type BindCandidate,
  deriveBindIp,
  isPrivateIPv4,
  listBindCandidates,
  verifyBindIp,
} from "../src/cli/bind-ip.ts";

describe("isPrivateIPv4", () => {
  test("accepts RFC-1918 ranges", () => {
    expect(isPrivateIPv4("10.0.0.1")).toBe(true);
    expect(isPrivateIPv4("10.255.255.255")).toBe(true);
    expect(isPrivateIPv4("172.16.0.1")).toBe(true);
    expect(isPrivateIPv4("172.31.255.255")).toBe(true);
    expect(isPrivateIPv4("192.168.1.1")).toBe(true);
  });

  test("rejects public and edge-of-range addresses", () => {
    expect(isPrivateIPv4("8.8.8.8")).toBe(false);
    expect(isPrivateIPv4("172.15.0.1")).toBe(false); // just below /12
    expect(isPrivateIPv4("172.32.0.1")).toBe(false); // just above /12
    expect(isPrivateIPv4("192.169.0.1")).toBe(false);
    expect(isPrivateIPv4("11.0.0.1")).toBe(false);
  });

  test("rejects 0.0.0.0 and loopback (must never be a bind target)", () => {
    expect(isPrivateIPv4("0.0.0.0")).toBe(false);
    expect(isPrivateIPv4("127.0.0.1")).toBe(false);
  });

  test("rejects malformed input (out-of-range octets, wrong arity, non-numeric)", () => {
    expect(isPrivateIPv4("10.0.0.256")).toBe(false);
    expect(isPrivateIPv4("10.0.0")).toBe(false);
    expect(isPrivateIPv4("10.0.0.1.2")).toBe(false);
    expect(isPrivateIPv4("10.0.0.-1")).toBe(false);
    expect(isPrivateIPv4("abc")).toBe(false);
    expect(isPrivateIPv4("")).toBe(false);
    expect(isPrivateIPv4("192.168.0.x")).toBe(false);
  });
});

describe("listBindCandidates / deriveBindIp", () => {
  test("every candidate is private and on a non-virtual interface", () => {
    const candidates: BindCandidate[] = listBindCandidates();
    for (const c of candidates) {
      expect(isPrivateIPv4(c.ip)).toBe(true);
      expect(c.iface.length).toBeGreaterThan(0);
      // Never a VPN/virtual NIC name fragment.
      expect(
        /utun|tun|tap|ppp|bridge|vnic|vmenet|vboxnet|vmnet|docker|veth|wg|zt|tailscale/i.test(
          c.iface,
        ),
      ).toBe(false);
    }
  });

  test("deriveBindIp returns the first candidate or null (never 0.0.0.0)", () => {
    const derived = deriveBindIp();
    const candidates = listBindCandidates();
    const first = candidates[0];
    if (!first) {
      expect(derived).toBeNull();
    } else {
      expect(derived).toBe(first.ip);
      expect(derived).not.toBe("0.0.0.0");
      expect(isPrivateIPv4(derived as string)).toBe(true);
    }
  });
});

describe("verifyBindIp", () => {
  test("rejects a non-private address as not-private", () => {
    expect(verifyBindIp("8.8.8.8")).toEqual({ ok: false, reason: "not-private" });
    expect(verifyBindIp("0.0.0.0")).toEqual({ ok: false, reason: "not-private" });
  });

  test("rejects a private address that is not assigned to any local interface", () => {
    // A valid-shape RFC-1918 address extremely unlikely to be locally assigned.
    const result = verifyBindIp("10.255.255.254");
    // Either not present, or (vanishingly unlikely) actually assigned; if
    // assigned it must be on a non-virtual iface (ok). Never a false "virtual"
    // for a real physical assignment we can't predict — assert the shape.
    if (!result.ok) {
      expect(result.reason).toBe("not-present");
    } else {
      expect(result.ok).toBe(true);
    }
  });

  test("a derived candidate verifies as ok (round-trip)", () => {
    const derived = deriveBindIp();
    if (derived) {
      expect(verifyBindIp(derived)).toEqual({ ok: true });
    }
  });
});
