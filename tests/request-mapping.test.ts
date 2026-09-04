/**
 * Exhaustive request-side mapping tests (hermetic, pure functions).
 *
 * Targets every branch of anthropicToConverseRequest / anthropicToOpenAIRequest:
 * string vs block-array system, text/image/tool_use/tool_result blocks,
 * tool_result content variants (string/array/object) + is_error, all four
 * tool_choice variants, and inferenceConfig assembly. These are the request
 * translators the fixture round-trips don't drive (fixtures exercise the
 * response side).
 */
import { describe, expect, test } from "bun:test";
import { anthropicToConverseRequest } from "../src/paths/converse.ts";
import { anthropicToOpenAIRequest } from "../src/paths/mantle.ts";

/* --------------------------------------------------------------- Converse --- */

describe("anthropicToConverseRequest", () => {
  test("string system + string-content message + full inferenceConfig", () => {
    const body = anthropicToConverseRequest({
      model: "m",
      system: "sys prompt",
      max_tokens: 100,
      temperature: 0.5,
      top_p: 0.9,
      stop_sequences: ["STOP"],
      messages: [{ role: "user", content: "hello" }],
    } as never);
    expect(body.system).toEqual([{ text: "sys prompt" }]);
    expect(body.messages[0]).toEqual({ role: "user", content: [{ text: "hello" }] });
    expect(body.inferenceConfig).toEqual({
      maxTokens: 100,
      temperature: 0.5,
      topP: 0.9,
      stopSequences: ["STOP"],
    });
  });

  test("block-array system is flattened to text", () => {
    const body = anthropicToConverseRequest({
      model: "m",
      system: [
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ],
      messages: [{ role: "user", content: "x" }],
    } as never);
    expect(body.system).toEqual([{ text: "a\n\nb" }]);
  });

  test("empty/absent system and empty inferenceConfig are omitted", () => {
    const body = anthropicToConverseRequest({
      model: "m",
      system: "",
      messages: [{ role: "user", content: "x" }],
    } as never);
    expect(body.system).toBeUndefined();
    expect(body.inferenceConfig).toBeUndefined();
  });

  test("a non-string/non-array system value is ignored (system omitted)", () => {
    const body = anthropicToConverseRequest({
      model: "m",
      system: 42,
      messages: [{ role: "user", content: "x" }],
    } as never);
    expect(body.system).toBeUndefined();
  });

  test("image + tool_use + tool_result(is_error) blocks map to Converse shapes", () => {
    const body = anthropicToConverseRequest({
      model: "m",
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
            { type: "tool_use", id: "tu1", name: "calc", input: { a: 1 } },
            {
              type: "tool_result",
              tool_use_id: "tu1",
              content: "42",
              is_error: true,
            },
          ],
        },
      ],
    } as never);
    const blocks = body.messages[0]?.content as Record<string, unknown>[];
    expect(blocks[0]).toEqual({ image: { format: "png", source: { bytes: "AAAA" } } });
    expect(blocks[1]).toEqual({ toolUse: { toolUseId: "tu1", name: "calc", input: { a: 1 } } });
    expect(blocks[2]).toEqual({
      toolResult: { toolUseId: "tu1", content: [{ text: "42" }], status: "error" },
    });
  });

  test("tool_result content as text-block array and as object", () => {
    const body = anthropicToConverseRequest({
      model: "m",
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "a", content: [{ type: "text", text: "hi" }] },
            { type: "tool_result", tool_use_id: "b", content: { nested: true } },
            {
              type: "tool_result",
              tool_use_id: "c",
              content: [{ foo: 1 }, { type: "text", text: "T" }],
            },
          ],
        },
      ],
    } as never);
    const blocks = body.messages[0]?.content as Array<{ toolResult: { content: unknown } }>;
    expect(blocks[0]?.toolResult.content).toEqual([{ text: "hi" }]);
    // Non-text/array content is JSON-stringified.
    expect(blocks[1]?.toolResult.content).toEqual([{ text: JSON.stringify({ nested: true }) }]);
    // A mixed array stringifies non-text elements per element.
    expect(blocks[2]?.toolResult.content).toEqual([{ text: `${JSON.stringify({ foo: 1 })}T` }]);
  });

  test("mediaType without a slash is passed through as the format token", () => {
    const body = anthropicToConverseRequest({
      model: "m",
      messages: [
        {
          role: "user",
          content: [{ type: "image", source: { type: "base64", media_type: "png", data: "z" } }],
        },
      ],
    } as never);
    const blocks = body.messages[0]?.content as Array<{ image: { format: string } }>;
    expect(blocks[0]?.image.format).toBe("png");
  });

  test("tools with tool_choice variants: auto/any/tool/none", () => {
    const mk = (tc: unknown) =>
      anthropicToConverseRequest({
        model: "m",
        messages: [{ role: "user", content: "x" }],
        tools: [{ name: "t", description: "d", input_schema: { type: "object" } }],
        tool_choice: tc,
      } as never).toolConfig;

    expect(mk({ type: "auto" })?.toolChoice).toEqual({ auto: {} });
    expect(mk({ type: "any" })?.toolChoice).toEqual({ any: {} });
    expect(mk({ type: "tool", name: "t" })?.toolChoice).toEqual({ tool: { name: "t" } });
    // "none" has no Converse equivalent -> toolChoice omitted.
    expect(mk({ type: "none" })?.toolChoice).toBeUndefined();
    // No tool_choice at all -> still builds tools, no toolChoice key.
    expect(mk(undefined)?.tools?.[0]?.toolSpec.name).toBe("t");
  });

  test("tool without description omits the description key", () => {
    const body = anthropicToConverseRequest({
      model: "m",
      messages: [{ role: "user", content: "x" }],
      tools: [{ name: "t", input_schema: { type: "object" } }],
    } as never);
    const spec = body.toolConfig?.tools?.[0]?.toolSpec as Record<string, unknown>;
    expect("description" in spec).toBe(false);
  });

  test("Anthropic server-tool (no input_schema) is dropped, custom tool kept", () => {
    const body = anthropicToConverseRequest({
      model: "m",
      messages: [{ role: "user", content: "x" }],
      tools: [
        { type: "bash_20250825", name: "Bash" },
        { name: "Read", description: "read a file", input_schema: { type: "object" } },
      ],
    } as never);
    // Only the custom tool survives; the server-tool brick is filtered.
    expect(body.toolConfig?.tools).toHaveLength(1);
    const spec = body.toolConfig?.tools?.[0]?.toolSpec;
    expect(spec?.name).toBe("Read");
    // The forwarded schema is a real object, never undefined (the 400 trigger).
    expect(spec?.inputSchema.json).toEqual({ type: "object" });
  });

  test("only server-tools -> toolConfig omitted entirely", () => {
    const body = anthropicToConverseRequest({
      model: "m",
      messages: [{ role: "user", content: "x" }],
      tools: [
        { type: "bash_20250825", name: "Bash" },
        { type: "web_search_20250305", name: "web_search" },
      ],
    } as never);
    expect(body.toolConfig).toBeUndefined();
  });

  test("empty text blocks are dropped; message with only empty text is removed", () => {
    const body = anthropicToConverseRequest({
      model: "m",
      messages: [
        { role: "user", content: [{ type: "text", text: "" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "" },
            { type: "text", text: "kept" },
          ],
        },
      ],
    } as never);
    // The all-empty user message is removed entirely; the assistant message
    // retains only its non-empty block.
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]).toEqual({ role: "assistant", content: [{ text: "kept" }] });
  });
});

/* ---------------------------------------------------------------- Mantle --- */

describe("anthropicToOpenAIRequest", () => {
  test("string system -> leading system message; string-content user message", () => {
    const body = anthropicToOpenAIRequest(
      { model: "m", system: "sys", messages: [{ role: "user", content: "hi" }] } as never,
      "invoke-model",
    );
    expect(body.model).toBe("invoke-model");
    expect(body.messages[0]).toEqual({ role: "system", content: "sys" });
    expect(body.messages[1]).toEqual({ role: "user", content: "hi" });
  });

  test("image block -> image_url content part", () => {
    const body = anthropicToOpenAIRequest(
      {
        model: "m",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "look" },
              {
                type: "image",
                source: { type: "base64", media_type: "image/jpeg", data: "QUJD" },
              },
            ],
          },
        ],
      } as never,
      "m",
    );
    const userMsg = body.messages.find((m) => m.role === "user");
    const parts = userMsg?.content as Array<{ type: string; image_url?: { url: string } }>;
    expect(parts.some((p) => p.type === "text")).toBe(true);
    const img = parts.find((p) => p.type === "image_url");
    expect(img?.image_url?.url).toBe("data:image/jpeg;base64,QUJD");
  });

  test("assistant tool_use -> tool_calls; user tool_result -> role:tool message", () => {
    const body = anthropicToOpenAIRequest(
      {
        model: "m",
        messages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "calling" },
              { type: "tool_use", id: "tc1", name: "calc", input: { a: 1 } },
            ],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "tc1", content: "42" }],
          },
        ],
      } as never,
      "m",
    );
    const assistant = body.messages.find((m) => m.role === "assistant");
    expect(assistant?.tool_calls?.[0]).toEqual({
      id: "tc1",
      type: "function",
      function: { name: "calc", arguments: JSON.stringify({ a: 1 }) },
    });
    // Accompanying text is kept alongside tool_calls.
    expect(assistant?.content).toBe("calling");
    const toolMsg = body.messages.find((m) => m.role === "tool");
    expect(toolMsg).toEqual({ role: "tool", tool_call_id: "tc1", content: "42" });
  });

  test("TC8: assistant tool_use with NO text sets content:null explicitly", () => {
    const body = anthropicToOpenAIRequest(
      {
        model: "m",
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "tc1", name: "calc", input: { a: 1 } }],
          },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "tc1", content: "42" }] },
        ],
      } as never,
      "m",
    );
    const assistant = body.messages.find((m) => m.role === "assistant");
    expect(assistant?.tool_calls).toHaveLength(1);
    // content is present and explicitly null (not undefined/omitted, not "").
    expect(assistant && "content" in assistant).toBe(true);
    expect(assistant?.content).toBeNull();
  });

  test("a message with only tool_result yields just the tool message", () => {
    const body = anthropicToOpenAIRequest(
      {
        model: "m",
        messages: [
          { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "r" }] },
        ],
      } as never,
      "m",
    );
    expect(body.messages).toEqual([{ role: "tool", tool_call_id: "x", content: "r" }]);
  });

  test("inference params (max_tokens/temperature/top_p/stop) map to OpenAI fields", () => {
    const body = anthropicToOpenAIRequest(
      {
        model: "m",
        max_tokens: 50,
        temperature: 0.2,
        top_p: 0.7,
        stop_sequences: ["END"],
        messages: [{ role: "user", content: "x" }],
      } as never,
      "m",
    ) as unknown as Record<string, unknown>;
    expect(body.max_tokens).toBe(50);
    expect(body.temperature).toBe(0.2);
    expect(body.top_p).toBe(0.7);
    expect(body.stop).toEqual(["END"]);
  });

  test("a non-string/non-array system value is ignored (mantle system omitted)", () => {
    const body = anthropicToOpenAIRequest(
      { model: "m", system: { obj: true }, messages: [{ role: "user", content: "x" }] } as never,
      "m",
    );
    expect(body.messages[0]?.role).toBe("user");
  });

  test("block-array system (mixed blocks) is flattened; empty -> omitted", () => {
    const withText = anthropicToOpenAIRequest(
      {
        model: "m",
        system: [{ type: "text", text: "x" }, { type: "image" }, { type: "text", text: "y" }],
        messages: [{ role: "user", content: "hi" }],
      } as never,
      "m",
    );
    // TC5: text blocks join with \n\n; the non-text (image) block is dropped.
    expect(withText.messages[0]).toEqual({ role: "system", content: "x\n\ny" });

    const emptySys = anthropicToOpenAIRequest(
      {
        model: "m",
        system: [{ type: "image" }],
        messages: [{ role: "user", content: "hi" }],
      } as never,
      "m",
    );
    // All-non-text system flattens to "" -> omitted (first message is the user).
    expect(emptySys.messages[0]?.role).toBe("user");
  });

  test("tool_result content as text-block array and as object (mantle stringify)", () => {
    const body = anthropicToOpenAIRequest(
      {
        model: "m",
        messages: [
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "a", content: [{ type: "text", text: "hi" }] },
            ],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "b", content: { nested: true } }],
          },
        ],
      } as never,
      "m",
    );
    const toolMsgs = body.messages.filter((m) => m.role === "tool");
    expect(toolMsgs[0]?.content).toBe("hi");
    expect(toolMsgs[1]?.content).toBe(JSON.stringify({ nested: true }));
  });

  test("tool_result content as array with a non-text block is JSON-stringified per element", () => {
    const body = anthropicToOpenAIRequest(
      {
        model: "m",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "c",
                content: [{ foo: 1 }, { type: "text", text: "T" }],
              },
            ],
          },
        ],
      } as never,
      "m",
    );
    const toolMsg = body.messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toBe(`${JSON.stringify({ foo: 1 })}T`);
  });

  test("tools + tool_choice variants map to OpenAI function tools", () => {
    const mk = (tc: unknown) =>
      anthropicToOpenAIRequest(
        {
          model: "m",
          messages: [{ role: "user", content: "x" }],
          tools: [{ name: "t", description: "d", input_schema: { type: "object" } }],
          tool_choice: tc,
        } as never,
        "m",
      ) as unknown as Record<string, unknown>;

    const auto = mk({ type: "auto" });
    expect((auto.tools as unknown[]).length).toBe(1);
    expect(auto.tool_choice).toBe("auto");
    expect(mk({ type: "any" }).tool_choice).toBe("required");
    expect(mk({ type: "tool", name: "t" }).tool_choice).toEqual({
      type: "function",
      function: { name: "t" },
    });
    expect(mk({ type: "none" }).tool_choice).toBe("none");
  });

  test("Anthropic server-tool (no input_schema) is dropped, custom tool kept", () => {
    const body = anthropicToOpenAIRequest(
      {
        model: "m",
        messages: [{ role: "user", content: "x" }],
        tools: [
          { type: "bash_20250825", name: "Bash" },
          { name: "Read", description: "read a file", input_schema: { type: "object" } },
        ],
      } as never,
      "m",
    );
    expect(body.tools).toHaveLength(1);
    expect(body.tools?.[0]?.function.name).toBe("Read");
    // Never undefined parameters (the 400 trigger).
    expect(body.tools?.[0]?.function.parameters).toEqual({ type: "object" });
  });

  test("only server-tools -> tools/tool_choice omitted entirely", () => {
    const body = anthropicToOpenAIRequest(
      {
        model: "m",
        messages: [{ role: "user", content: "x" }],
        tools: [{ type: "bash_20250825", name: "Bash" }],
        tool_choice: { type: "auto" },
      } as never,
      "m",
    ) as unknown as Record<string, unknown>;
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
  });

  test("empty text blocks are dropped from a mantle message", () => {
    const body = anthropicToOpenAIRequest(
      {
        model: "m",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "" },
              { type: "text", text: "kept" },
            ],
          },
        ],
      } as never,
      "m",
    );
    const user = body.messages.find((m) => m.role === "user");
    // Single non-empty text collapses to a plain string "kept".
    expect(user?.content).toBe("kept");
  });
});

/* ------------------------------------------------------------- TC6 images --- */

describe("TC6 image source handling", () => {
  const base64Block = {
    type: "image",
    source: { type: "base64", media_type: "image/jpeg", data: "QUJD" },
  };
  const urlBlock = { type: "image", source: { type: "url", url: "https://x/img.png" } };

  test("Converse: base64 image maps to image.source.bytes with the format", () => {
    const body = anthropicToConverseRequest({
      model: "m",
      max_tokens: 8,
      messages: [{ role: "user", content: [base64Block] }],
    } as never);
    const content = body.messages[0]?.content as Array<Record<string, unknown>>;
    const img = content.find((c) => "image" in c)?.image as Record<string, unknown>;
    expect(img.format).toBe("jpeg");
    expect((img.source as Record<string, unknown>).bytes).toBe("QUJD");
  });

  test("Converse: url image degrades to a placeholder text block (bytes-only backend)", () => {
    const body = anthropicToConverseRequest({
      model: "m",
      max_tokens: 8,
      messages: [{ role: "user", content: [urlBlock] }],
    } as never);
    const content = body.messages[0]?.content as Array<Record<string, unknown>>;
    expect(
      content.some((c) => typeof c.text === "string" && c.text.includes("image url omitted")),
    ).toBe(true);
    expect(content.some((c) => "image" in c)).toBe(false);
  });

  test("OpenAI: base64 image maps to a data: URI image_url", () => {
    const body = anthropicToOpenAIRequest(
      { model: "m", max_tokens: 8, messages: [{ role: "user", content: [base64Block] }] } as never,
      "m",
    );
    const parts = body.messages[0]?.content as Array<Record<string, unknown>>;
    const img = parts.find((p) => p.type === "image_url")?.image_url as { url: string };
    expect(img.url).toBe("data:image/jpeg;base64,QUJD");
  });

  test("OpenAI: url image passes the URL straight through to image_url", () => {
    const body = anthropicToOpenAIRequest(
      { model: "m", max_tokens: 8, messages: [{ role: "user", content: [urlBlock] }] } as never,
      "m",
    );
    const parts = body.messages[0]?.content as Array<Record<string, unknown>>;
    const img = parts.find((p) => p.type === "image_url")?.image_url as { url: string };
    expect(img.url).toBe("https://x/img.png");
  });
});

describe("G3 tool-call id sanitization (request side)", () => {
  test("tool_use id and matching tool_result id sanitize to the same valid id", () => {
    const dirty = "toolu:01/A#b";
    const body = anthropicToOpenAIRequest(
      {
        model: "m",
        max_tokens: 8,
        messages: [
          { role: "assistant", content: [{ type: "tool_use", id: dirty, name: "t", input: {} }] },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: dirty, content: "ok" }],
          },
        ],
      } as never,
      "m",
    );
    // Find the assistant tool_call id and the tool message tool_call_id.
    const asst = body.messages.find((m) => m.role === "assistant") as {
      tool_calls?: Array<{ id: string }>;
    };
    const toolMsg = body.messages.find((m) => m.role === "tool") as { tool_call_id?: string };
    const callId = asst.tool_calls?.[0]?.id;
    expect(callId).toBe("toolu_01_A_b");
    expect(callId ?? "").not.toMatch(/[^a-zA-Z0-9_-]/); // fully valid
    // Crucially, both sides sanitized to the SAME id so the pairing survives.
    expect(toolMsg.tool_call_id).toBe("toolu_01_A_b");
  });
});
