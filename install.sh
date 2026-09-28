#!/usr/bin/env sh
# Installs Flash as a personal Claude Code skill (same as npx github:azamma/flash).
command -v node >/dev/null 2>&1 || { echo "Flash needs Node 18+ (https://nodejs.org)"; exit 1; }
exec node "$(dirname "$0")/bin/flash.mjs" install "$@"
