# who-said-yes, Claude Code plugin

This folder is the Claude Code plugin. It holds one command,
`/who-said-yes:who-said-yes`, written in Markdown. The command asks for your
guess first, then runs the open source counter with
`npx github:skprasad-korture/who-said-yes#v0.1.0` and shows what it prints.

The counter reads your Claude Code and Codex session logs on this computer,
read only, and sends nothing anywhere. Its code and full README are at
https://github.com/skprasad-korture/who-said-yes.

Install:

```
/plugin marketplace add skprasad-korture/who-said-yes
/plugin install who-said-yes@who-said-yes
```
