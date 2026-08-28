/**
 * Unit tests for the shared path-neutral request normalizer
 * (src/paths/normalize.ts), consumed by Path C (Converse) and Path M (Mantle).
 *
 * Covers the three normalizations plus ordering and malformed-input tolerance:
 *   - system-role messages hoisted out of `messages` into `system` (in order,
 *     after any dedicated system prompt);
 *   - empty text blocks dropped, and messages left empty removed;
 *   - Anthropic server-tools (no input_schema) filtered, custom tools kept.
 */
import { describe, expect, test } from "bun:test";
import { normalizeForIrPaths } from "../src/paths/normalize.ts";

describe("normalizeForIrPaths — system hoisting", () => {
  test("hoists a system-role message out of messages into system", () => {
    const n = normalizeForIrPaths({
      messages: [
        { role: "user", content: "hi" },
        { role: "system", content: [{ type: "text", text: "<system-reminder>be terse" }] },
      ],
    });
    // System text captured; the conversation retains only the user turn.
    expect(n.system).toEqual(["<system-reminder>be terse"]);
    expect(n.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  test("dedicated system prompt comes first, then hoisted ones in order", () => {
    const n = normalizeForIrPaths({
      system: "DEDICATED",
      messages: [
        { role: "system", content: "R1" },
        { role: "user", content: "hi" },
        { role: "system", content: "R2" },
      ],
    });
    expect(n.system).toEqual(["DEDICATED", "R1", "R2"]);
    expect(n.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  test("block-array system field is flattened to text", () => {
    const n = normalizeForIrPaths({
      system: [
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ],
      messages: [{ role: "user", content: "hi" }],
    });
    expect(n.system).toEqual(["ab"]);
  });

  test("empty system-role message contributes nothing", () => {
    const n = normalizeForIrPaths({
      messages: [
        { role: "system", content: [{ type: "text", text: "" }] },
        { role: "user", content: "hi" },
      ],
    });
    expect(n.system).toEqual([]);
    expect(n.messages).toHaveLength(1);
  });
});

describe("normalizeForIrPaths — empty-text filtering", () => {
  test("drops empty text blocks but keeps non-empty ones", () => {
    const n = normalizeForIrPaths({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "" },
            { type: "text", text: "kept" },
          ],
        },
      ],
    });
    expect(n.messages).toEqual([{ role: "user", content: [{ type: "text", text: "kept" }] }]);
  });

  test("removes a message whose blocks were all empty", () => {
    const n = normalizeForIrPaths({
      messages: [
        { role: "assistant", content: [{ type: "text", text: "prev" }] },
        { role: "user", content: [{ type: "text", text: "" }] },
      ],
    });
    expect(n.messages).toEqual([{ role: "assistant", content: [{ type: "text", text: "prev" }] }]);
  });

  test("empty string content message is dropped", () => {
    const n = normalizeForIrPaths({
      messages: [
        { role: "user", content: "real" },
        { role: "user", content: "" },
      ],
    });
    expect(n.messages).toEqual([{ role: "user", content: "real" }]);
  });

  test("non-text blocks (tool_use/image) are preserved", () => {
    const n = normalizeForIrPaths({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "" },
            { type: "tool_use", id: "t1", name: "Read", input: {} },
          ],
        },
      ],
    });
    expect(n.messages).toEqual([
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
    ]);
  });
});

describe("normalizeForIrPaths — tool filtering", () => {
  test("keeps custom tools (with input_schema), drops server-tools", () => {
    const n = normalizeForIrPaths({
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { type: "bash_20250825", name: "Bash" },
        { name: "Read", description: "read a file", input_schema: { type: "object" } },
        { type: "web_search_20250305", name: "web_search" },
      ],
    });
    expect(n.tools).toEqual([
      { name: "Read", description: "read a file", input_schema: { type: "object" } },
    ]);
  });

  test("omits description key when absent", () => {
    const n = normalizeForIrPaths({
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "T", input_schema: { type: "object" } }],
    });
    expect(n.tools[0] && "description" in n.tools[0]).toBe(false);
  });

  test("no tools -> empty tools array", () => {
    const n = normalizeForIrPaths({ messages: [{ role: "user", content: "hi" }] });
    expect(n.tools).toEqual([]);
  });
});

describe("normalizeForIrPaths — malformed / edge input", () => {
  test("tolerates non-array messages and non-array tools", () => {
    const n = normalizeForIrPaths({ messages: "nope", tools: 42, system: null });
    expect(n).toEqual({ system: [], messages: [], tools: [] });
  });

  test("skips null / non-object message entries", () => {
    const n = normalizeForIrPaths({
      messages: [null, 7, "x", { role: "user", content: "ok" }],
    });
    expect(n.messages).toEqual([{ role: "user", content: "ok" }]);
  });

  test("skips messages with an unknown role", () => {
    const n = normalizeForIrPaths({
      messages: [
        { role: "tool", content: "ignored" },
        { role: "user", content: "kept" },
      ],
    });
    expect(n.messages).toEqual([{ role: "user", content: "kept" }]);
  });

  test("empty request -> all-empty result", () => {
    expect(normalizeForIrPaths({})).toEqual({ system: [], messages: [], tools: [] });
  });
});
