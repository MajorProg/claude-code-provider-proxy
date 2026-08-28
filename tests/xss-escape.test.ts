/**
 * XSS-escaping helper tests (Task 18): escapeHtml for HTML context and
 * jsonForScript for safe inline <script> JSON embedding.
 */
import { describe, expect, test } from "bun:test";
import { escapeHtml, jsonForScript } from "../src/http/shell.ts";

describe("escapeHtml", () => {
  test("escapes the five significant HTML characters", () => {
    expect(escapeHtml(`<img src=x onerror="alert('x')">`)).toBe(
      "&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;",
    );
  });
  test("neutralizes a script-close breakout", () => {
    expect(escapeHtml("</script><script>alert(1)</script>")).not.toContain("<script>");
  });
  test("leaves plain text unchanged", () => {
    expect(escapeHtml("bedrock.converse.global.anthropic.claude-sonnet-5")).toBe(
      "bedrock.converse.global.anthropic.claude-sonnet-5",
    );
  });
});

describe("jsonForScript", () => {
  test("escapes < so a value cannot break out of an inline <script>", () => {
    const payload = { id: "models/x</script><script>alert(1)</script>" };
    const out = jsonForScript(payload);
    expect(out).not.toContain("</script>");
    expect(out).toContain("\\u003c");
    // Still valid JSON once parsed back (the \u003c decodes to '<').
    expect(JSON.parse(out)).toEqual(payload);
  });
  test("escapes U+2028 / U+2029 line separators", () => {
    const out = jsonForScript({ s: "a\u2028b\u2029c" });
    expect(out).toContain("\\u2028");
    expect(out).toContain("\\u2029");
    expect(JSON.parse(out)).toEqual({ s: "a\u2028b\u2029c" });
  });
});
