---
description: Show Flash's savings: the banner, then tokens saved by command, project and day
argument-hint: "[--history N] [--plain]"
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/skills/flash/scripts/flash.mjs" gain $ARGUMENTS`

Show the output above to the user verbatim inside a code block, with no commentary before it. After the block, add at most one line pointing out the command or project that saved the most Claude tokens.
