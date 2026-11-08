# who-said-yes

Your coding agent asks before it runs things. Most of the time, something else
answers for you: a rule you saved weeks ago, the permission mode, auto mode, a
hook. `who-said-yes` counts how many of your agent's actions you approved
yourself, at the prompt, in that moment.

It asks you to guess first.

```
npx github:skprasad-korture/who-said-yes
```

Nothing to install, no account, no email. Needs Node 18 or newer. If your
terminal says `npx: command not found`, install Node from https://nodejs.org
and run it again.

## What it prints

```
who-said-yes 0.1.0. Reads your agent logs on this computer. Sends nothing.

Out of your agent's last 1,000 actions, how many do you think you said yes to
yourself?
Your guess (0 to 1000, or Enter to skip): 150

You guessed 150. You said yes yourself to 3 of the last 1,000.

YOU, AT THE PROMPT. Claude Code, 9 Oct to 7 Nov, 64 sessions, 9,412 actions.
  You said yes        19 times, about 1 in every 495 actions
                      4 of these yeses also saved a rule
  How fast            2 min 40 s from the ask to your yes (median)
  You said no         5 times
  Longest run         312 actions in a row with no message from you
                      (my-app, 3 Nov)
  File edits          402 of 410 file edits ran with no prompt shown to you

Not you: rules you saved 230, mode 3,104, auto mode 4,880, settings 1,115,
         hooks 12.
Turned down without asking you: 47.

By project and by week: npx github:skprasad-korture/who-said-yes --detail

https://www.korture.ai/get?utm_source=github&utm_medium=referral&utm_campaign=2026-11-free-tool&utm_content=cli
```

The person comes first: your guess, your yeses and how fast they came, your
noes, the longest stretch the agent worked with no message from you, and the
file edits you never saw a prompt for. Everything that approved actions
without you comes after, in one line. It gives no advice on settings.

Run it again later and it shows what changed since your last run.

Options:

| Option | What it does |
| --- | --- |
| `--detail` | adds counts by project and by week |
| `--no-guess` | skips the guess question |
| `--guess N` | gives your guess up front |
| `--json` | prints the counts as JSON |
| `--no-save` | does not remember this run |
| `--version` | prints the version |
| `--help` | prints the options |

## What it reads

- `~/.claude/projects/*/*.jsonl`, the session logs Claude Code keeps (about 30
  days by default). Each tool call result carries a `permissionDecision` with
  a source. Newer versions of Claude Code write this field; older logs do not
  have it, and the tool says so.
- `~/.codex/sessions/**/*.jsonl`, the session logs Codex keeps. Codex writes
  down its approval rule for each turn, not each answer you give, so the Codex
  part is thinner.

It only reads these folders and never changes them. It writes one small file,
`~/.who-said-yes/last.json`, with your totals and your last guess, so the next
run can show the change. Nothing leaves your computer: the code has no network
calls at all. It is one file you can read in a few minutes:
[`bin/who-said-yes.js`](bin/who-said-yes.js).

## How it counts

| Line | Comes from |
| --- | --- |
| You said yes | `source: user_temporary`: you said yes at the prompt. Also a "yes, and don't ask again" you clicked at the prompt (`user_permanent` with no matching rule). |
| Rules you saved | `source: user_permanent` with `reasonType: rule`: a match to a "don't ask again" rule you saved earlier. |
| Mode, auto mode, settings, hooks | `source: config` with `reasonType` mode, classifier or another setting, and `source: hook`. |
| You said no | a tool result that says "The user doesn't want to proceed" or "doesn't want to take this action". Counted once per action. |
| Turned down without asking you | a rule, hook or classifier said no, or the request was turned down within a fraction of a second with no one at the prompt. |
| How fast | median time from the agent's request to your yes. |
| File edits with no prompt | Edit, Write, MultiEdit and NotebookEdit calls that ran without your yes at the prompt. |
| Longest run | the most actions in one session between two messages you typed. |

Left out on purpose: subagent sessions, sessions a program started
(`claude -p`, the Agent SDK, `codex exec`), one-line probe sessions from temp
folders, and turns a program sent inside your session, unless you answered a
prompt in that turn yourself.

The log fields are not documented by Anthropic or OpenAI and may change. If
they do, the tool says it cannot read the format rather than guessing.

## As a Claude Code plugin

```
/plugin marketplace add skprasad-korture/who-said-yes
/plugin install who-said-yes@who-said-yes
```

Then type `/who-said-yes:who-said-yes` (the plugin name, then the command).
Claude asks you the guess question, runs the same file on your computer, and
shows what it prints.

## Update and uninstall

- Update: `npx github:skprasad-korture/who-said-yes`, or `/plugin marketplace update who-said-yes`
  in Claude Code.
- Uninstall: `rm -rf ~/.who-said-yes` removes the one file it keeps. For the
  plugin, `/plugin uninstall who-said-yes`.

## How it differs from other tools

| Tool | What it counts |
| --- | --- |
| [ccusage](https://github.com/ccusage/ccusage) | tokens and money spent per day, session and model |
| [Claude Code Usage Monitor](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor) | how close you are to your plan's usage limits, live |
| Claude Code `/insights` | patterns in your sessions, with suggested fixes for CLAUDE.md |
| [WakaTime](https://wakatime.com) | time spent coding, by project and language |
| Claude Code `/fewer-permission-prompts` | reads the same logs to add common commands to your allow list, so you are asked less |
| [Microsoft AI Engineer Coach](https://github.com/microsoft/AI-Engineering-Coach) | scores your sessions against rules for good AI practice, in VS Code |
| who-said-yes | which actions you approved yourself, and which something else approved for you |

## Who made it

KORTURE.ai. We are building Sense, which helps you see your own judgment while
you work with agents. If you want to know when it is ready:
https://www.korture.ai/get?utm_source=github&utm_medium=referral&utm_campaign=2026-11-free-tool&utm_content=readme

## Licence

MIT. Copyright (c) 2026 Korture Technologies LLP.
