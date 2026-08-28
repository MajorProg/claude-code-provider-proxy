#!/usr/bin/env sh
# ============================================================================
# bootstrap.sh — one job: ensure Bun is installed, then hand off to the Bun CLI.
#
# This is the ONLY shell script in the repo. Everything else (setup, start,
# stop, config, token generation, BIND_IP derivation) lives in the
# cross-platform Bun CLI at src/cli/index.ts. Bun cannot install itself from
# within a Bun program, so this tiny shim exists solely to bootstrap Bun on
# macOS/Linux.
#
# Usage:
#   ./bootstrap.sh setup            # install deps + configure Claude Code
#   ./bootstrap.sh up  [--local|--docker]
#   ./bootstrap.sh <any CLI command>
#
# On Windows, use bootstrap.ps1 instead.
# ============================================================================
set -eu
cd "$(dirname "$0")"

if ! command -v bun >/dev/null 2>&1; then
  echo "Bun not found — installing…"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL https://bun.sh/install | bash
  else
    echo "ERROR: curl is required to install Bun. Install curl or Bun manually." >&2
    echo "  See https://bun.sh" >&2
    exit 1
  fi
  # Make bun available on PATH for the rest of this script.
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
fi

command -v bun >/dev/null 2>&1 || {
  echo "ERROR: bun still not on PATH. Restart your shell and re-run, or add" >&2
  echo "  \$HOME/.bun/bin to your PATH." >&2
  exit 1
}

exec bun run src/cli/index.ts "$@"
