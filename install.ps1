# Installs Flash as a personal Claude Code skill, then asks for your Jev key once.
$ErrorActionPreference = 'Stop'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Host 'Flash needs Node 18+ (https://nodejs.org)'; exit 1 }
$base = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $HOME '.claude' }
$dest = Join-Path $base 'skills\flash'
New-Item -ItemType Directory -Force $dest | Out-Null
Copy-Item -Recurse -Force (Join-Path $PSScriptRoot 'skills\flash\*') $dest
Write-Host "Installed to $dest"
$qs = Join-Path $dest 'scripts\flash.mjs'
node $qs status *> $null
if ($LASTEXITCODE -ne 0) { node $qs setup }
node $qs status
