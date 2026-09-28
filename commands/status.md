---
description: Check Flash's provider, key and model, and show lifetime savings
argument-hint: "[--provider typesafe|openrouter]"
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/skills/flash/scripts/flash.mjs" status $ARGUMENTS`

Report the result in one or two lines. If it says `not configured` or the key was rejected, tell the user to run this in the prompt, which keeps the key out of the chat:
`! node "${CLAUDE_PLUGIN_ROOT}/skills/flash/scripts/flash.mjs" setup --provider <typesafe|openrouter>`
with the plugin path spelled out in full.
