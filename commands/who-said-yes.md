---
description: Count which of your agent's actions you approved yourself, from the logs on this computer
allowed-tools: Bash(node:*)
---

Run the local who-said-yes count for the person. It reads their Claude Code and
Codex session logs on this computer, read only, and sends nothing anywhere.

1. First ask the person exactly this, and wait for their answer:
   "Out of your agent's last 1,000 actions, how many do you think you said yes to yourself?"
   Do not guess for them and do not hint at the answer.
2. If they give a whole number from 0 to 1000, run:
   `node "${CLAUDE_PLUGIN_ROOT}/bin/who-said-yes.js" --guess <their number>`
   If they skip, run:
   `node "${CLAUDE_PLUGIN_ROOT}/bin/who-said-yes.js" --no-guess`
   Add `--detail` if they asked for the count by project or by week: $ARGUMENTS
3. Show the output exactly as printed, inside a code block. Do not add advice
   about permission settings, modes or rules, and do not summarise the numbers
   in your own words. If they ask what a line means, explain only that line.
