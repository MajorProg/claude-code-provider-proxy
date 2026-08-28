import { describe, expect, test } from "bun:test";
import { BadModelIdError } from "../src/errors.ts";
import {
  type CanonicalId,
  formatCanonicalId,
  isAnthropic,
  parseCanonicalId,
} from "../src/model/canonical-id.ts";

describe("parseCanonicalId", () => {
  test("parses a simple id", () => {
    expect(parseCanonicalId("bedrock.mantle.global.zai.glm-5")).toEqual({
      provider: "bedrock",
      backend: "mantle",
      profilePrefix: "global",
      nativeModelId: "zai.glm-5",
    });
  });

  test("preserves dots AND colons in nativeModelId (first-3-dots rule)", () => {
    expect(parseCanonicalId("bedrock.converse.us.amazon.nova-lite-v1:0")).toEqual({
      provider: "bedrock",
      backend: "converse",
      profilePrefix: "us",
      nativeModelId: "amazon.nova-lite-v1:0",
    });
  });

  test("preserves full anthropic native id with version + colon", () => {
    const parsed = parseCanonicalId(
      "bedrock.converse.global.anthropic.claude-haiku-4-5-20251001-v1:0",
    );
    expect(parsed.nativeModelId).toBe("anthropic.claude-haiku-4-5-20251001-v1:0");
    expect(parsed.profilePrefix).toBe("global");
  });

  test("handles nativeModelId that is itself dotted (qwen)", () => {
    const parsed = parseCanonicalId("bedrock.mantle.us.qwen.qwen3-coder-30b-a3b-v1:0");
    expect(parsed.nativeModelId).toBe("qwen.qwen3-coder-30b-a3b-v1:0");
  });

  test.each([
    "",
    "bedrock",
    "bedrock.mantle",
    "bedrock.mantle.global", // no native id
    "bedrock..global.model", // empty backend
    "bedrock.mantle..model", // empty prefix
    "bedrock.mantle.global.", // empty native id
    "bedrock.unknownbackend.global.model", // invalid backend
  ])("rejects invalid id: %p", (bad) => {
    expect(() => parseCanonicalId(bad)).toThrow(BadModelIdError);
  });
});

describe("formatCanonicalId", () => {
  test("round-trips with parse", () => {
    const id = "bedrock.converse.us.amazon.nova-lite-v1:0";
    const parts: CanonicalId = parseCanonicalId(id);
    expect(formatCanonicalId(parts)).toBe(id);
  });
});

describe("isAnthropic", () => {
  test.each([
    ["anthropic.claude-sonnet-5", true],
    ["claude-haiku-4-5", true],
    ["ANTHROPIC.Claude-Opus-5", true],
    ["zai.glm-5", false],
    ["amazon.nova-lite-v1:0", false],
    ["qwen.qwen3-coder-30b-a3b-v1:0", false],
  ])("isAnthropic(%p) === %p", (id, expected) => {
    expect(isAnthropic(id as string)).toBe(expected);
  });
});
