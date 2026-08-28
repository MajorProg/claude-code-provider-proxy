/**
 * BIND_IP derivation and verification (DESIGN §16).
 *
 * The proxy's published port must bind to a specific LAN IPv4 — never 0.0.0.0,
 * never a VPN/virtual interface. This module derives that address portably from
 * os.networkInterfaces() (works on Windows/macOS/Linux without shelling out to
 * ipconfig/ip) and can verify a user-supplied value the same way.
 *
 * "Available on the LAN" here means the address is actually ASSIGNED to a
 * local, up, physical interface — that is exactly the precondition for a
 * successful bind(). We deliberately do NOT probe reachability (ping): a bind
 * depends on local assignment, not on whether a peer answers.
 */
import { networkInterfaces } from "node:os";

/** Interface-name fragments that indicate VPN / virtual / container NICs. */
const VIRTUAL_NAME_PATTERNS = [
  "utun", // macOS VPN tunnels
  "tun", // generic tunnels
  "tap", // TAP adapters
  "ppp", // point-to-point / dial VPNs
  "bridge", // macOS/Docker bridges
  "vnic", // virtualization NICs
  "vmenet", // macOS VM networking
  "vboxnet", // VirtualBox
  "vmnet", // VMware
  "docker", // docker0
  "veth", // container veth pairs
  "wg", // WireGuard
  "zt", // ZeroTier
  "tailscale", // Tailscale
  "loopback", // Windows loopback naming
];

function isVirtualName(name: string): boolean {
  const lower = name.toLowerCase();
  return VIRTUAL_NAME_PATTERNS.some((p) => lower.includes(p));
}

/** True if `ip` is an RFC-1918 private IPv4 address. */
export function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  return false;
}

export interface BindCandidate {
  ip: string;
  iface: string;
}

/**
 * Enumerate all candidate LAN IPv4 addresses: non-internal, private-range,
 * on a non-virtual/non-VPN interface. Returned in interface-enumeration order.
 */
export function listBindCandidates(): BindCandidate[] {
  const out: BindCandidate[] = [];
  const ifaces = networkInterfaces();
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs || isVirtualName(name)) continue;
    for (const a of addrs) {
      // Node types IPv4 family as "IPv4" (older) or 4 (newer); accept both.
      const isV4 = a.family === "IPv4" || (a.family as unknown) === 4;
      if (!isV4 || a.internal) continue;
      if (isPrivateIPv4(a.address)) out.push({ ip: a.address, iface: name });
    }
  }
  return out;
}

/**
 * Derive the best BIND_IP automatically. Returns the first safe candidate, or
 * null when none can be found (e.g. VPN-only host) — callers must then fail
 * loudly and ask the user to set BIND_IP explicitly, rather than guessing.
 */
export function deriveBindIp(): string | null {
  const candidates = listBindCandidates();
  return candidates[0]?.ip ?? null;
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: "not-private" | "not-present" | "virtual" };

/**
 * Verify a user-supplied BIND_IP is safe and actually assigned to a local
 * physical interface. Used to catch stale/wrong values before Docker fails at
 * bind time.
 */
export function verifyBindIp(ip: string): VerifyResult {
  if (!isPrivateIPv4(ip)) return { ok: false, reason: "not-private" };
  const ifaces = networkInterfaces();
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs) continue;
    for (const a of addrs) {
      if (a.address !== ip) continue;
      if (isVirtualName(name)) return { ok: false, reason: "virtual" };
      return { ok: true };
    }
  }
  return { ok: false, reason: "not-present" };
}
