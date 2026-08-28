# ============================================================================
# bootstrap.ps1 — one job: ensure Bun is installed, then hand off to the Bun CLI.
#
# The Windows counterpart to bootstrap.sh. Everything else (setup, start, stop,
# config, token generation, BIND_IP derivation) lives in the cross-platform Bun
# CLI at src/cli/index.ts. Bun cannot install itself from within a Bun program,
# so this shim bootstraps Bun on Windows.
#
# Usage (PowerShell):
#   .\bootstrap.ps1 setup
#   .\bootstrap.ps1 up --local
#   .\bootstrap.ps1 <any CLI command>
# ============================================================================
$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

function Test-Command($name) {
  $null = Get-Command $name -ErrorAction SilentlyContinue
  return $?
}

if (-not (Test-Command "bun")) {
  Write-Host "Bun not found - installing..."
  # Official Windows install (PowerShell one-liner from https://bun.sh).
  powershell -c "irm bun.sh/install.ps1 | iex"
  # Make bun available on PATH for the rest of this session.
  $bunBin = Join-Path $env:USERPROFILE ".bun\bin"
  if (Test-Path $bunBin) {
    $env:PATH = "$bunBin;$env:PATH"
  }
}

if (-not (Test-Command "bun")) {
  Write-Error "bun still not on PATH. Restart PowerShell and re-run, or add %USERPROFILE%\.bun\bin to PATH."
  exit 1
}

bun run src/cli/index.ts @args
exit $LASTEXITCODE
