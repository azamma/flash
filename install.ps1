# Installs Flash as a personal Claude Code skill (same as npx github:azamma/flash).
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Host 'Flash needs Node 18+ (https://nodejs.org)'; exit 1 }
node (Join-Path $PSScriptRoot 'bin\flash.mjs') install @args
exit $LASTEXITCODE
