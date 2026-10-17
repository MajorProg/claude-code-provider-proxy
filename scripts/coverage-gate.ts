#!/usr/bin/env bun
/**
 * Coverage gate — the invariant that keeps the suite at 100% LINE and FUNCTION
 * coverage for every module under `src/`, so the number can never regress
 * silently. Run it with `bun run test:coverage`.
 *
 * What it does:
 *   1. Runs the FULL `bun test` suite with an lcov report written to a fresh
 *      TEMP directory (never `./coverage` inside the repo).
 *   2. Parses the lcov (`SF:` file, `LF`/`LH` lines, `FNF`/`FNH` functions).
 *   3. Asserts 100% lines and 100% functions for every `.ts` file under `src/`.
 *   4. Asserts THE COMPLETENESS INVARIANT: every `.ts` file under `src/` on disk
 *      must APPEAR in the lcov report. Bun instruments only files that were
 *      LOADED, so a namespace no test imports is simply ABSENT from the report —
 *      which is exactly how `src/logging/writer-worker.ts` once sat unmeasured
 *      while the report still looked complete. A file missing from the report
 *      is a FAILURE, not a pass.
 *   5. Prints a per-file table of anything below 100% or missing, and exits
 *      non-zero (via `process.exitCode`, so buffered output still flushes).
 *
 * The ALLOWLIST below is the only way a line may be excluded, and it is a
 * line-scoped, reason-bearing exception list — never a lowered threshold. A
 * line-scoped entry (rather than a whole-file one) means a NEW uncovered line
 * anywhere in the file still fails the gate; the exemption is exact.
 *
 * Passing `--all` prints the full per-file table (not just failures).
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SRC_DIR = join(ROOT, "src");

/** A line-scoped exemption. `lines` is a compact spec: "108,111,114" or
 *  "1655-1751,1758-1761"; omitted means NO line is exempt. `funcs` permits that
 *  many uncovered FUNCTION bodies for the file — needed only where a whole
 *  function owns no executable line of its own (an empty callback, an entrypoint
 *  body), so a line-scoped entry cannot name it (lcov reports function COUNTS,
 *  not which line each lives on). */
interface AllowEntry {
  readonly file: string;
  readonly lines?: string;
  readonly funcs?: number;
  readonly reason: string;
}

/**
 * The ONLY permitted coverage exceptions. Each entry names exact line numbers
 * (never a threshold) and the verified reason it is genuinely not measurable.
 * Delete an entry the moment its lines become reachable.
 */
const ALLOWLIST: readonly AllowEntry[] = [
  {
    file: "src/http/zip.ts",
    lines: "109,118",
    reason:
      "Two ZIP v2.0 size guards, kept as defense-in-depth before a corrupt header could " +
      "reach an archive. Line 109 rejects a single entry > 4GiB (which would overflow the " +
      "uint32 size fields) with a message that NAMES the offending entry — kept because it " +
      "is reachable and reports more usefully than the generic cap below, but exercising it " +
      "needs a multi-GiB in-memory buffer. Line 118 is the 512MiB total-bytes cap, which " +
      "likewise needs an impractically large allocation to trip. Neither is a behaviour a " +
      "hermetic test should allocate for, so both are allowlisted rather than driven. (The " +
      "former `offset > 4GiB` guard was DELETED as provably unreachable: while " +
      "ZIP_TOTAL_BYTES_LIMIT stays below ZIP_MAX_UINT32 the total cap already bounds the " +
      "local-header offset, so a separate 4GiB offset check can never fire.)",
  },
  {
    file: "src/cli/index.ts",
    lines: "984",
    reason:
      "The single `main().then(setExitCode).catch(cliErrorExit)` call inside the " +
      "`import.meta.main` boot guard. import.meta.main is false under bun:test (the module " +
      "is imported, not run as the entrypoint), and a spawned child process does not " +
      "contribute to Bun's in-process line coverage — so the call site itself is the one " +
      "thing no test can execute. BOTH handlers it names are hoisted out into separately " +
      "tested exports instead of inline arrows (cliErrorExit and setExitCode), which is why " +
      "this entry is one line and permits no uncovered function. Everything else in this " +
      "file is exercised in-process: resolveBindIp's no-LAN-interface branch and " +
      "cmdDoctor's matching 'none derivable' arm are covered via the injected " +
      "networkInterfaces() seam, and cmdPing is driven through the real main() dispatch " +
      "with an AbortController plus the pollStatus/sleep seams — including the watcher " +
      "signal threaded into the in-flight poll and the resolved exit code returned from " +
      "main().",
  },
  {
    file: "src/server.ts",
    lines: "173,598,644,723,1656-1761,1766-1772",
    funcs: 3,
    reason:
      "Lines 173 and 598 are bun lcov TERMINATOR ARTIFACTS, not code: 173 is the bare `);` " +
      "closing the Response.json(...) ternary whose line 172 executed 78x, and 598 is the " +
      "`}` closing the ZipLimitError catch whose throw on line 597 executed 43x — a line " +
      "carrying only a terminator cannot be reached independently, so no test can cover it. " +
      "Line 644 is unreachable BY CONSTRUCTION: the enclosing branch needs mode.enabled with " +
      "the dev sentinel, which requires AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY present " +
      "(bedrock-mode.ts:71), and config validation guarantees primaryRegion matches a " +
      "regions entry (config.ts:843) — so all three terms of the throw condition are always " +
      'false. Line 723 is a defense-in-depth guard in the count_tokens exec ("Filtered ' +
      'above; kept for the type checker"): the model list is filtered to countTokensPath- ' +
      "capable targets before dispatch, so the throw is unreachable. Lines 1656-1772 are " +
      "main() and the import.meta.main boot guard — the server's process entrypoint; main " +
      "is not exported and binds a port, so it is reachable only as a child process " +
      "(exercised behaviourally in server-coverage.test.ts), which carries no in-process " +
      "line coverage. The 3 permitted uncovered functions are precisely main(), the nested " +
      "reloadRuntime(), and the boot guard's .catch arrow — all inside this line range.",
  },
  {
    file: "src/paths/converse.ts",
    lines: "109,113",
    reason:
      'The type-block mapper\'s `default` arm: assertNever(block, "AnthropicBlock.type"). ' +
      "It is unreachable BY CONSTRUCTION — the switch is exhaustive over AnthropicBlock, so " +
      "a new union variant turns this into a compile error rather than a runtime path.",
  },
  {
    file: "src/logging/writer-worker.ts",
    lines: "107",
    reason:
      'The closing brace of the `case "close"` block in the worker\'s message switch. Its ' +
      "body (lines 105-106) DOES execute yet bun's lcov " +
      "reports the trailing brace 0 — a bun line-attribution artifact, not uncovered code.",
  },
  {
    file: "src/model/catalog.ts",
    funcs: 1,
    reason:
      "The IMPLICIT constructor of class SourceBackoff (declared at line 57 with fields and " +
      "methods but no explicit constructor). Bun counts an implicit class constructor as a " +
      "function it can never mark covered, so this is a tooling blind spot, not untested " +
      "code — there is no function body in the source to exercise. Verified by minimal " +
      "reproduction: adding only `constructor() {}` moves the file from 51/52 to 52/52 with " +
      "no other change. Any REAL uncovered function here raises the count and fails the gate.",
  },
  {
    file: "src/stream/converse-events.ts",
    funcs: 1,
    reason:
      "The IMPLICIT constructor of class EventStreamDecoder (declared at line 39 with a field " +
      "and methods but no explicit constructor). Bun counts an implicit class constructor as " +
      "a function it can never mark covered, so this is a tooling blind spot, not untested " +
      "code — there is no function body in the source to exercise. Verified by minimal " +
      "reproduction: adding only `constructor() {}` moves the file from 10/11 to 11/11 with " +
      "no other change. Any REAL uncovered function here raises the count and fails the gate.",
  },
  {
    file: "src/stream/openai-sse.ts",
    funcs: 1,
    reason:
      "The IMPLICIT constructor of class SseLineParser (declared at line 84 with fields and " +
      "methods but no explicit constructor). Bun counts an implicit class constructor as a " +
      "function it can never mark covered, so this is a tooling blind spot, not untested " +
      "code — there is no function body in the source to exercise. Verified by minimal " +
      "reproduction: adding only `constructor() {}` moves the file from 17/18 to 18/18 with " +
      "no other change. Any REAL uncovered function here raises the count and fails the gate.",
  },
];

/** Expand a compact line spec ("108,111,114" / "1655-1751,1758-1761") to a set. */
function expandLines(spec: string): Set<number> {
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    const t = part.trim();
    if (t === "") continue;
    const dash = t.indexOf("-");
    if (dash === -1) {
      out.add(Number(t));
    } else {
      const start = Number(t.slice(0, dash));
      const end = Number(t.slice(dash + 1));
      for (let n = start; n <= end; n++) out.add(n);
    }
  }
  return out;
}

/** Every `.ts` file under `dir`, as repo-relative POSIX paths. */
function listSrcTs(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      listSrcTs(full, acc);
    } else if (entry.name.endsWith(".ts")) {
      acc.push(relative(ROOT, full).split(sep).join("/"));
    }
  }
  return acc;
}

interface LcovRecord {
  lf: number;
  lh: number;
  fnf: number;
  fnh: number;
  uncoveredLines: number[];
}

/** Parse a bun lcov report into per-file records. */
function parseLcov(text: string): Map<string, LcovRecord> {
  const records = new Map<string, LcovRecord>();
  let file: string | null = null;
  let lf = 0;
  let lh = 0;
  let fnf = 0;
  let fnh = 0;
  let uncovered: number[] = [];

  const flush = (): void => {
    if (file !== null) records.set(file, { lf, lh, fnf, fnh, uncoveredLines: uncovered });
    file = null;
    lf = 0;
    lh = 0;
    fnf = 0;
    fnh = 0;
    uncovered = [];
  };

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      flush();
      file = line.slice(3);
    } else if (line.startsWith("DA:")) {
      const comma = line.indexOf(",", 3);
      const ln = Number(line.slice(3, comma));
      const hits = Number(line.slice(comma + 1));
      if (hits === 0) uncovered.push(ln);
    } else if (line.startsWith("LF:")) lf = Number(line.slice(3));
    else if (line.startsWith("LH:")) lh = Number(line.slice(3));
    else if (line.startsWith("FNF:")) fnf = Number(line.slice(4));
    else if (line.startsWith("FNH:")) fnh = Number(line.slice(4));
    else if (line === "end_of_record") flush();
  }
  flush();
  return records;
}

interface Failure {
  file: string;
  kind: "missing" | "lines" | "funcs";
  badLines: number[];
  lf: number;
  lh: number;
  fnf: number;
  fnh: number;
}

async function main(): Promise<void> {
  const showAll = process.argv.includes("--all");
  const allow = new Map(
    ALLOWLIST.map((e) => [
      e.file,
      {
        spec: e.lines ?? null,
        allowed: e.lines === undefined ? new Set<number>() : expandLines(e.lines),
        funcs: e.funcs ?? 0,
        reason: e.reason,
      },
    ]),
  );

  const covDir = mkdtempSync(join(tmpdir(), "ccpp-cov-gate-"));
  const srcFiles = listSrcTs(SRC_DIR).sort();
  const failures: Failure[] = [];
  const rows: string[] = [];
  let suiteExit = 0;
  let records = new Map<string, LcovRecord>();

  try {
    // Deterministic child env: drop any inherited coverage config so the child
    // can only use the --coverage-dir we pass, and can never write ./coverage.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !k.startsWith("BUN_COVERAGE")) env[k] = v;
    }

    const proc = Bun.spawn(
      ["bun", "test", "--coverage", "--coverage-reporter=lcov", `--coverage-dir=${covDir}`],
      { cwd: ROOT, env, stdio: ["inherit", "inherit", "inherit"] },
    );
    suiteExit = await proc.exited;

    let lcov = "";
    try {
      lcov = readFileSync(join(covDir, "lcov.info"), "utf8");
    } catch {
      console.error(`\ncoverage gate: no lcov report was produced in ${covDir}`);
      process.exitCode = 1;
      return;
    }
    records = parseLcov(lcov);

    // ---- completeness invariant -------------------------------------------
    for (const f of srcFiles) {
      if (!records.has(f)) {
        failures.push({ file: f, kind: "missing", badLines: [], lf: 0, lh: 0, fnf: 0, fnh: 0 });
      }
    }

    // ---- line + function coverage -----------------------------------------
    for (const f of srcFiles) {
      const r = records.get(f);
      if (r === undefined) continue;
      const a = allow.get(f);
      // The allowlist exempts exact line numbers; every OTHER uncovered line —
      // including a line that only became uncovered after this entry was written
      // — fails. That is what makes the exemption precise rather than a threshold.
      const allowedLines = a?.allowed ?? new Set<number>();
      const badLines = r.uncoveredLines.filter((l) => !allowedLines.has(l));
      const funcsShort = r.fnf - r.fnh;
      const funcsAllowed = a?.funcs ?? 0;

      const lineOk = badLines.length === 0;
      const funcOk = funcsShort <= funcsAllowed;

      const pctLines = r.lf === 0 ? 100 : (r.lh / r.lf) * 100;
      const pctFuncs = r.fnf === 0 ? 100 : (r.fnh / r.fnf) * 100;

      if (!lineOk || !funcOk || showAll) {
        rows.push(
          formatRow(f, pctFuncs, pctLines, badLines.length > 0 ? badLines : r.uncoveredLines),
        );
      }
      if (!lineOk) {
        failures.push({
          file: f,
          kind: "lines",
          badLines,
          lf: r.lf,
          lh: r.lh,
          fnf: r.fnf,
          fnh: r.fnh,
        });
      }
      if (!funcOk) {
        failures.push({
          file: f,
          kind: "funcs",
          badLines: [],
          lf: r.lf,
          lh: r.lh,
          fnf: r.fnf,
          fnh: r.fnh,
        });
      }
    }

    // ---- report ------------------------------------------------------------
    console.log("\n── coverage gate ───────────────────────────────────────────────");
    if (rows.length > 0) {
      console.log("File | % Funcs | % Lines | Uncovered Line #s");
      for (const row of rows) console.log(row);
    } else {
      console.log("every src/ file is at 100% lines and functions.");
    }

    if (suiteExit !== 0) {
      console.error(`\ncoverage gate: the test suite itself FAILED (bun test exit ${suiteExit}).`);
    }

    if (failures.length > 0) {
      console.error(`\ncoverage gate: ${failures.length} failure(s):`);
      for (const f of failures) {
        if (f.kind === "missing") {
          console.error(
            `  MISSING  ${f.file} — not present in the lcov report; no test loads it (the completeness invariant). Add a test that imports and exercises it.`,
          );
        } else if (f.kind === "lines") {
          console.error(
            `  LINES    ${f.file} — ${f.lh}/${f.lf} lines; uncovered & not allowlisted: ${compact(f.badLines)}`,
          );
          const a = allow.get(f.file);
          if (a !== undefined) {
            // Show the current spec so the operator can grow the exact allowlist.
            console.error(`           current allowlist spec: "${a.spec ?? "(none)"}"`);
          }
        } else {
          console.error(
            `  FUNCS    ${f.file} — ${f.fnh}/${f.fnf} functions; ${f.fnf - f.fnh} uncovered (allowlist permits ${allow.get(f.file)?.funcs ?? 0}).`,
          );
        }
      }
    }

    if (failures.length > 0 || suiteExit !== 0) {
      console.error("\ncoverage gate: FAILED");
      process.exitCode = 1;
    } else {
      console.log(`\ncoverage gate: OK (${srcFiles.length} src files, all 100%/100%)`);
    }
  } finally {
    rmSync(covDir, { recursive: true, force: true });
  }
}

/** A fixed-width summary row for the gate table. */
function formatRow(file: string, pctFuncs: number, pctLines: number, uncovered: number[]): string {
  const f = `${pctFuncs === 100 ? "100" : pctFuncs.toFixed(1)}%`;
  const l = `${pctLines === 100 ? "100" : pctLines.toFixed(1)}%`;
  const lines = uncovered.length === 0 ? "-" : compact(uncovered);
  return `${file} | ${f} | ${l} | ${lines}`;
}

/** Collapse a sorted line list to a compact "1-5,9,20-22" spec. */
function compact(lines: number[]): string {
  if (lines.length === 0) return "-";
  const sorted = [...lines].sort((a, b) => a - b);
  const parts: string[] = [];
  let start = sorted[0] as number;
  let prev = start;
  for (let i = 1; i < sorted.length; i++) {
    const n = sorted[i] as number;
    if (n === prev + 1) {
      prev = n;
      continue;
    }
    parts.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = n;
    prev = n;
  }
  parts.push(start === prev ? `${start}` : `${start}-${prev}`);
  return parts.join(",");
}

await main();
