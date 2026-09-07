/**
 * Claude Code configuration writer.
 *
 * Points Claude Code at the proxy by merging ANTHROPIC_* env vars into
 * ~/.claude/settings.json. If an existing settings file is present, it is
 * backed up (timestamped) before any change, so a user's prior configuration
 * is never lost.
 *
 * The base URL is always 127.0.0.1: Claude Code runs on the same host as the
 * proxy in both local and Docker run modes.
 *
 * Also pins ANTHROPIC_DEFAULT_SONNET_MODEL / ANTHROPIC_DEFAULT_HAIKU_MODEL to
 * the same canonical proxy ids as ANTHROPIC_MODEL / ANTHROPIC_SMALL_FAST_MODEL.
 * Without these, Claude Code's auto-mode permission classifier calls the bare
 * upstream alias "claude-sonnet-5" directly (see docs.claude.com/en/permission
 * -modes, "the classifier runs on Claude Sonnet 5 by default"), which the
 * proxy rejects as an invalid canonical id (`Invalid canonical model id:
 * "claude-sonnet-5"`) — surfacing as "auto mode cannot determine the safety of
 * <tool>". Setting these vars makes the `sonnet`/`haiku` aliases the
 * classifier resolves against resolve to a canonical id the proxy accepts.
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ok, warn } from "./util.ts";

export interface ClaudeSettingsInput {
  baseUrl: string;
  authToken: string;
  mainModel: string;
  /** @deprecated fastModel is superseded by haikuModel (ANTHROPIC_SMALL_FAST_MODEL is deprecated upstream); still required for the legacy write below. */
  fastModel: string;
  /** Pins the `sonnet` alias — also what the auto-mode classifier resolves against. */
  sonnetModel: string;
  /** Pins the `haiku` alias (background-task model). */
  haikuModel: string;
  /**
   * Pins the `opus` alias — on third-party providers this is ALSO the target of
   * Claude Code's automatic model fallback, so it must resolve to a proxy id
   * (e.g. virtual.anthropic.global.opus-like) or fallbacks error out.
   */
  opusModel: string;
  /** ANTHROPIC_DEFAULT_MODEL (lowest-priority default for new sessions). */
  defaultModel: string;
  /** CLAUDE_CODE_SUBAGENT_MODEL (subagents / teammates / workflows). */
  subagentModel: string;
  /**
   * True when .env still relies on the deprecated ANTHROPIC_SMALL_FAST_MODEL
   * (ANTHROPIC_DEFAULT_HAIKU_MODEL unset): write BOTH the new haiku var and the
   * legacy one so older Claude Code versions keep working.
   */
  legacySmallFast: boolean;
  /**
   * Optional max context window (tokens) for the selected model. Claude Code
   * only knows the window of Anthropic's own models; for any proxied non-Claude
   * model it assumes 200k and warns. Setting this teaches it the real window so
   * auto-compaction doesn't trim prematurely. Omitted when unset in .env.
   */
  maxContextTokens?: string;
  /** Optional ANTHROPIC_CUSTOM_MODEL_OPTION (+ display name/description). */
  customModelOption?: string;
  customModelOptionName?: string;
  customModelOptionDescription?: string;
  /**
   * Optional display/capability triplets for pinned aliases on third-party
   * gateways, keyed by alias (e.g. "opus" → { name, capabilities }).
   */
  aliasMeta?: Readonly<
    Partial<
      Record<
        "opus" | "sonnet" | "haiku",
        { name?: string; description?: string; capabilities?: string }
      >
    >
  >;
}

/**
 * Pure env-block builder for {@link writeClaudeSettings} — the testable seam
 * (writeClaudeSettings itself touches the real ~/.claude/settings.json).
 * Computes the complete ANTHROPIC and CLAUDE_CODE model-variable family,
 * preserves unrelated previous env keys, and forces ANTHROPIC_API_KEY to ""
 * (a non-empty value makes Claude Code bypass the proxy — README gotcha).
 */
export function buildClaudeEnv(
  input: ClaudeSettingsInput,
  prevEnv: Record<string, unknown>,
): Record<string, unknown> {
  /** Optional _NAME/_DESCRIPTION/_SUPPORTED_CAPABILITIES triplet for one alias. */
  const metaEntries = (alias: "opus" | "sonnet" | "haiku", varBase: string) => {
    const m = input.aliasMeta?.[alias];
    return {
      ...(m?.name ? { [`${varBase}_NAME`]: m.name } : {}),
      ...(m?.description ? { [`${varBase}_DESCRIPTION`]: m.description } : {}),
      ...(m?.capabilities ? { [`${varBase}_SUPPORTED_CAPABILITIES`]: m.capabilities } : {}),
    };
  };
  return {
    ...prevEnv,
    ANTHROPIC_BASE_URL: input.baseUrl,
    ANTHROPIC_AUTH_TOKEN: input.authToken,
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_MODEL: input.mainModel,
    ANTHROPIC_DEFAULT_MODEL: input.defaultModel,
    ANTHROPIC_DEFAULT_SONNET_MODEL: input.sonnetModel,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: input.haikuModel,
    ANTHROPIC_DEFAULT_OPUS_MODEL: input.opusModel,
    CLAUDE_CODE_SUBAGENT_MODEL: input.subagentModel,
    // Deprecated upstream; written ONLY while .env still uses it, for older
    // Claude Code versions. cmdSetup/cmdConfigClaude print a deprecation notice.
    ...(input.legacySmallFast ? { ANTHROPIC_SMALL_FAST_MODEL: input.fastModel } : {}),
    ...(input.maxContextTokens ? { CLAUDE_CODE_MAX_CONTEXT_TOKENS: input.maxContextTokens } : {}),
    ...(input.customModelOption ? { ANTHROPIC_CUSTOM_MODEL_OPTION: input.customModelOption } : {}),
    ...(input.customModelOptionName
      ? { ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: input.customModelOptionName }
      : {}),
    ...(input.customModelOptionDescription
      ? { ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION: input.customModelOptionDescription }
      : {}),
    ...metaEntries("opus", "ANTHROPIC_DEFAULT_OPUS_MODEL"),
    ...metaEntries("sonnet", "ANTHROPIC_DEFAULT_SONNET_MODEL"),
    ...metaEntries("haiku", "ANTHROPIC_DEFAULT_HAIKU_MODEL"),
  };
}

/** Standard Claude Code settings path: ~/.claude/settings.json */
export function claudeSettingsPath(): string {
  return join(homedir(), ".claude", "settings.json");
}

/** Timestamp suffix like 20260827T170000 for backup filenames. */
function backupStamp(now: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `T${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  );
}

/**
 * Back up an existing settings file to `<file>.backup-<timestamp>`.
 * Returns the backup path, or null if there was nothing to back up.
 */
export function backupClaudeSettings(settingsFile: string, now: Date = new Date()): string | null {
  if (!existsSync(settingsFile)) return null;
  const backup = `${settingsFile}.backup-${backupStamp(now)}`;
  copyFileSync(settingsFile, backup);
  // The settings file holds ANTHROPIC_AUTH_TOKEN; keep the backup owner-only too.
  try {
    chmodSync(backup, 0o600);
  } catch {
    // Best-effort (e.g. non-POSIX FS); the copy still succeeded.
  }
  return backup;
}

/**
 * Merge the proxy env vars into Claude Code's settings.json without clobbering
 * unrelated keys. Backs up any existing file first.
 *
 * Note ANTHROPIC_API_KEY is intentionally set to "" — a non-empty value makes
 * Claude Code bypass the proxy (README "mandatory gotcha").
 */
export function writeClaudeSettings(input: ClaudeSettingsInput): {
  backup: string | null;
  file: string;
} {
  const file = claudeSettingsPath();
  const dir = join(homedir(), ".claude");
  mkdirSync(dir, { recursive: true });

  const backup = backupClaudeSettings(file);
  if (backup) warn(`Backed up existing Claude settings -> ${backup}`);

  let current: Record<string, unknown> = {};
  if (existsSync(file)) {
    const text = readFileSync(file, "utf8").trim();
    if (text.length > 0) {
      try {
        current = JSON.parse(text) as Record<string, unknown>;
      } catch {
        warn("Existing ~/.claude/settings.json is not valid JSON; starting fresh (backup kept).");
      }
    }
  }

  const prevEnv = (current.env ?? {}) as Record<string, unknown>;
  current.env = buildClaudeEnv(input, prevEnv);

  // Written owner-only (0o600): the file holds ANTHROPIC_AUTH_TOKEN. Atomic
  // temp-file + rename so a crash mid-write can't corrupt Claude Code's settings.
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600); // enforce perms even where the mode option is ignored
  } catch {
    // Best-effort on non-POSIX filesystems.
  }
  renameSync(tmp, file); // atomic replace on the same filesystem
  ok(`Configured Claude Code -> ${file}`);
  return { backup, file };
}
