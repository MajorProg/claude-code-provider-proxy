import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZipLimitError, buildZip } from "../src/http/zip.ts";

describe("buildZip", () => {
  test("produces an archive that the system unzip can read back", async () => {
    const zip = buildZip([
      { name: "a.txt", data: "hello world" },
      { name: "nested/b.json", data: JSON.stringify({ x: 1 }) },
    ]);
    expect(zip[0]).toBe(0x50); // 'P'
    expect(zip[1]).toBe(0x4b); // 'K'

    const dir = await mkdtemp(join(tmpdir(), "zip-test-"));
    try {
      const zipPath = join(dir, "out.zip");
      await writeFile(zipPath, zip);
      // Extract with the system unzip and verify contents.
      const proc = Bun.spawn(["unzip", "-o", zipPath, "-d", dir], {
        stdout: "ignore",
        stderr: "ignore",
      });
      const code = await proc.exited;
      expect(code).toBe(0);
      expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("hello world");
      expect(await readFile(join(dir, "nested/b.json"), "utf-8")).toBe('{"x":1}');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("empty archive is valid", () => {
    const zip = buildZip([]);
    // EOCD-only: 22 bytes.
    expect(zip.length).toBe(22);
    expect(zip[0]).toBe(0x50);
  });

  test("throws ZipLimitError past the entry-count limit (Task 29 — no silent corruption)", () => {
    // 0xffff (65535) is the uint16 total-entries max; one more must throw
    // rather than wrap the field and produce a corrupt archive.
    const tooMany = Array.from({ length: 0x10000 }, (_, i) => ({
      name: `f${i}.txt`,
      data: "x",
    }));
    expect(() => buildZip(tooMany)).toThrow(ZipLimitError);
  });
});
