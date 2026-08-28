import { describe, expect, test } from "bun:test";
import { authenticateInbound, extractInboundCredential } from "../src/auth/inbound.ts";
import { UnauthorizedError } from "../src/errors.ts";

const KEYS = ["secret-one", "secret-two"];

function h(init: Record<string, string>) {
  return new Request("http://localhost/", { headers: init }).headers;
}

describe("extractInboundCredential", () => {
  test("reads Bearer token from Authorization", () => {
    expect(extractInboundCredential(h({ authorization: "Bearer abc123" }))).toBe("abc123");
  });
  test("Bearer is case-insensitive and trims", () => {
    expect(extractInboundCredential(h({ authorization: "bearer   xyz  " }))).toBe("xyz");
  });
  test("reads x-api-key", () => {
    expect(extractInboundCredential(h({ "x-api-key": "keyval" }))).toBe("keyval");
  });
  test("prefers Authorization Bearer over x-api-key", () => {
    expect(
      extractInboundCredential(h({ authorization: "Bearer fromauth", "x-api-key": "fromkey" })),
    ).toBe("fromauth");
  });
  test("returns null when nothing present", () => {
    expect(extractInboundCredential(h({}))).toBeNull();
  });
  test("returns null for non-Bearer Authorization with no x-api-key", () => {
    expect(extractInboundCredential(h({ authorization: "Basic abc" }))).toBeNull();
  });
});

describe("authenticateInbound", () => {
  test("accepts a matching Bearer key", () => {
    expect(() =>
      authenticateInbound(h({ authorization: "Bearer secret-one" }), KEYS),
    ).not.toThrow();
  });
  test("accepts a matching x-api-key", () => {
    expect(() => authenticateInbound(h({ "x-api-key": "secret-two" }), KEYS)).not.toThrow();
  });
  test("rejects a wrong key", () => {
    expect(() => authenticateInbound(h({ authorization: "Bearer nope" }), KEYS)).toThrow(
      UnauthorizedError,
    );
  });
  test("rejects when no credential presented", () => {
    expect(() => authenticateInbound(h({}), KEYS)).toThrow(UnauthorizedError);
  });
  test("rejects a prefix of a valid key (constant-time full compare)", () => {
    expect(() => authenticateInbound(h({ authorization: "Bearer secret-on" }), KEYS)).toThrow(
      UnauthorizedError,
    );
  });
});
