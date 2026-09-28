#!/usr/bin/env sh
# Installs Flash as a personal Claude Code skill, then asks for your Jev key once.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
DEST="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/flash"
command -v node >/dev/null 2>&1 || { echo "Flash needs Node 18+ (https://nodejs.org)"; exit 1; }
mkdir -p "$DEST"
cp -R "$DIR/skills/flash/." "$DEST/"
echo "Installed to $DEST"
node "$DEST/scripts/flash.mjs" status >/dev/null 2>&1 || node "$DEST/scripts/flash.mjs" setup
node "$DEST/scripts/flash.mjs" status
