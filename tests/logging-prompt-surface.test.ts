/**
 * Prompt-surface fingerprint tests (src/logging/prompt-surface.ts).
 *
 * The prompt surface is the WHOLE instruction surface a turn ran under — the
 * system prompt, the FULL tool definitions (names + schemas), and injected
 * instruction envelopes lifted out of the conversation — fingerprinted as one
 * sha256 over a canonical, key-sorted JSON serialization. These tests pin the
 * properties that make the fingerprint useful and safe to compute on every
 * request:
 *   - key order / whitespace never perturb it; a schema change always does;
 *   - injected `<system-reminder>` blocks are extracted and SEPARATED from the
 *     ordinary user text around them;
 *   - malformed, hostile and cyclic input never throws.
 *
 * Hermetic: pure functions, no network, no filesystem.
 */
import { describe, expect, test } from "bun:test";
import {
  INSTRUCTION_ENVELOPE_TAGS,
  computePromptSurface,
  promptVersionOf,
} from "../src/logging/prompt-surface.ts";

/** Build a surface from a loose input (every field is `unknown` by design). */
function surface(input: { system?: unknown; tools?: unknown; messages?: unknown }) {
  return computePromptSurface({
    system: input.system,
    tools: input.tools,
    messages: input.messages,
  });
}

/** Parse a canonical-JSON field back to a value for assertion. */
function parse(json: string): unknown {
  return JSON.parse(json) as unknown;
}

describe("prompt surface: canonical hashing", () => {
  test("key order does not change the hash (canonical, key-sorted JSON)", () => {
    const a = surface({
      system: { instructions: "be terse", persona: "engineer" },
      tools: [
        {
          name: "T",
          description: "d",
          input_schema: {
            type: "object",
            properties: { a: { type: "string" }, b: { type: "number" } },
          },
        },
      ],
      messages: [],
    });
    const b = surface({
      system: { persona: "engineer", instructions: "be terse" },
      tools: [
        {
          input_schema: {
            properties: { b: { type: "number" }, a: { type: "string" } },
            type: "object",
          },
          description: "d",
          name: "T",
        },
      ],
      messages: [],
    });
    expect(a.hash).toBe(b.hash);
    expect(a.systemJson).toBe(b.systemJson);
    expect(a.toolsJson).toBe(b.toolsJson);
  });

  test("a change in tool SCHEMA changes the hash (closes the names-only gap)", () => {
    const a = surface({
      system: null,
      tools: [
        { name: "T", input_schema: { type: "object", properties: { a: { type: "string" } } } },
      ],
      messages: [],
    });
    const b = surface({
      system: null,
      tools: [
        { name: "T", input_schema: { type: "object", properties: { b: { type: "number" } } } },
      ],
      messages: [],
    });
    // Identical tool NAME — a names-only fingerprint would collide here.
    expect(a.hash).not.toBe(b.hash);
    expect(a.toolsJson).not.toBe(b.toolsJson);
  });

  test("a change in a tool description changes the hash", () => {
    const a = surface({
      system: null,
      tools: [{ name: "T", description: "reads", input_schema: { type: "object" } }],
      messages: [],
    });
    const b = surface({
      system: null,
      tools: [{ name: "T", description: "writes", input_schema: { type: "object" } }],
      messages: [],
    });
    expect(a.hash).not.toBe(b.hash);
  });

  test("a transport-only key (cache_control) does not perturb the hash", () => {
    const plain = surface({
      system: null,
      tools: [{ name: "T", input_schema: { type: "object" } }],
      messages: [],
    });
    const cached = surface({
      system: null,
      tools: [
        { name: "T", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } },
      ],
      messages: [],
    });
    expect(cached.hash).toBe(plain.hash);
  });

  test("a change in the system prompt changes the hash", () => {
    const a = surface({ system: "be terse", tools: [], messages: [] });
    const b = surface({ system: "be verbose", tools: [], messages: [] });
    expect(a.hash).not.toBe(b.hash);
  });

  test("every 'no system' spelling normalizes to the same surface", () => {
    const absent = surface({ system: undefined, tools: [], messages: [] });
    const nul = surface({ system: null, tools: [], messages: [] });
    const emptyStr = surface({ system: "", tools: [], messages: [] });
    const emptyArr = surface({ system: [], tools: [], messages: [] });
    expect(nul.hash).toBe(absent.hash);
    expect(emptyStr.hash).toBe(absent.hash);
    expect(emptyArr.hash).toBe(absent.hash);
  });

  test("the conversation itself is not part of the surface fingerprint", () => {
    // The surface is about instructions, not the messages: two different
    // conversations under the same system/tools/injections fingerprint alike.
    const a = surface({ system: "s", tools: [], messages: [{ role: "user", content: "one" }] });
    const b = surface({
      system: "s",
      tools: [],
      messages: [
        { role: "user", content: "two" },
        { role: "assistant", content: "three" },
      ],
    });
    expect(a.hash).toBe(b.hash);
  });

  test("reports canonical byte lengths and a 64-hex sha256", () => {
    const s = surface({ system: "héllo", tools: [], messages: [] });
    expect(s.systemJson).toBe('"héllo"');
    expect(s.systemBytes).toBe(Buffer.byteLength(s.systemJson, "utf8"));
    expect(s.toolsJson).toBe("[]");
    expect(s.toolsBytes).toBe(2);
    expect(s.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("prompt surface: injected instruction blocks", () => {
  test("a <system-reminder> is extracted and separated from ordinary user text", () => {
    const s = surface({
      system: "sys",
      tools: [],
      messages: [
        {
          role: "user",
          content: "<system-reminder>Use tabs.</system-reminder>\nWhat time is it?",
        },
      ],
    });
    expect(parse(s.injectedJson)).toEqual(["Use tabs."]);
    // The ordinary question is NOT part of the injected surface.
    expect(s.injectedJson).not.toContain("What time is it?");
  });

  test("an injected envelope inside a text content block is extracted", () => {
    const s = surface({
      system: null,
      tools: [],
      messages: [
        { role: "user", content: [{ type: "text", text: "<instructions>Do X.</instructions>" }] },
      ],
    });
    expect(parse(s.injectedJson)).toEqual(["Do X."]);
  });

  test("an envelope quoted inside a tool_result is NOT treated as an injection", () => {
    const s = surface({
      system: null,
      tools: [],
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: "<system-reminder>evil</system-reminder>",
            },
          ],
        },
      ],
    });
    expect(parse(s.injectedJson)).toEqual([]);
  });

  test("injected blocks are deduped and sorted for a stable order", () => {
    const s = surface({
      system: null,
      tools: [],
      messages: [
        {
          role: "user",
          content:
            "<system-reminder>Zeta</system-reminder><system-reminder>Alpha</system-reminder>",
        },
        { role: "assistant", content: "ok" },
        {
          role: "user",
          content: [{ type: "text", text: "<system-reminder>Zeta</system-reminder>" }],
        },
      ],
    });
    expect(parse(s.injectedJson)).toEqual(["Alpha", "Zeta"]);
  });

  test("ordinary content with no envelope yields no injections", () => {
    const s = surface({
      system: null,
      tools: [],
      messages: [{ role: "user", content: "just talking about <not-a-reminder> tags" }],
    });
    expect(parse(s.injectedJson)).toEqual([]);
  });

  test("adding an injected envelope changes the hash", () => {
    const plain = surface({ system: "s", tools: [], messages: [{ role: "user", content: "hi" }] });
    const injected = surface({
      system: "s",
      tools: [],
      messages: [{ role: "user", content: "hi\n<system-reminder>x</system-reminder>" }],
    });
    expect(injected.hash).not.toBe(plain.hash);
  });

  test("the recognised envelope tags include Claude Code's system-reminder", () => {
    expect(INSTRUCTION_ENVELOPE_TAGS).toContain("system-reminder");
  });
});

describe("prompt surface: defensive on the hot path", () => {
  test("malformed input never throws", () => {
    const inputs: Array<{ system: unknown; tools: unknown; messages: unknown }> = [
      { system: undefined, tools: undefined, messages: undefined },
      { system: 42, tools: [null, 1, "x", { name: 5 }], messages: "not an array" },
      { system: null, tools: {}, messages: [{ content: 5 }, null, 7] },
      {
        system: { a: [1, { b: undefined }] },
        tools: [{ name: "T", input_schema: null }],
        messages: [{}],
      },
      { system: true, tools: [["nested"]], messages: [{ content: [{ text: 42 }] }] },
    ];
    for (const input of inputs) {
      expect(() => computePromptSurface(input)).not.toThrow();
      expect(computePromptSurface(input).hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("a cyclic value degrades instead of recursing forever", () => {
    const cyclic: Record<string, unknown> = { name: "cyc" };
    cyclic.self = cyclic;
    const s = computePromptSurface({ system: cyclic, tools: [], messages: [] });
    expect(s.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("promptVersionOf", () => {
  test("prefers an explicit promptVersion, then the surface hash, else null", () => {
    expect(promptVersionOf({ promptVersion: "explicit" })).toBe("explicit");
    const s = surface({ system: "s", tools: [], messages: [] });
    expect(promptVersionOf({ promptSurface: s })).toBe(s.hash);
    expect(promptVersionOf({ promptVersion: "explicit", promptSurface: s })).toBe("explicit");
    expect(promptVersionOf({})).toBeNull();
    expect(promptVersionOf({ promptVersion: "" })).toBeNull();
  });
});
