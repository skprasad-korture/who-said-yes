#!/usr/bin/env node
// who-said-yes: counts which of your coding agent's actions you approved
// yourself, from the session logs already on your computer.
// Reads ~/.claude/projects and ~/.codex/sessions. Read only. No network.
// One file, no dependencies, Node 18 or newer. MIT licence.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const VERSION = '0.1.0';
const LINK = 'https://www.korture.ai/get?utm_source=github&utm_medium=referral' +
  '&utm_campaign=2026-11-free-tool&utm_content=cli';
const WIDTH = 80;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const REFUSAL = /^The user doesn't want to (proceed|take this action)/;
// Ported from the program and scratch rules of Sense's collector: a temp folder
// is scratch, and a chat whose every message is a one-line probe is a program.
const SCRATCH = /\/(?:private\/)?(?:tmp|var\/folders\/[^/]+\/[^/]+\/T)(?:\/|$)/;
const PROBE = /^\s*(?:reply|respond|answer)\s+(?:with\s+)?(?:exactly|only|just|the (?:single|exact|one) word)\b[^\n]{0,80}$/i;
// Text the harness writes into a user record that the person did not type.
const NOT_TYPED = /^\s*(?:<task-notification|<local-command-|<system-reminder|\[Request interrupted|\[Image: original |<bash-stdout|<bash-stderr)/;
const CODEX_WRAPPER = /^\s*(?:<[a-z_-]+[ >]|# AGENTS\.md|# Context\b|\[Image: original )/;

// ---------------------------------------------------------------- helpers

function textOf(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map(b => (b && typeof b === 'object' &&
      ['text', 'input_text', 'output_text'].includes(b.type)) ? (b.text || '') : '').join('\n');
  }
  return '';
}

function resultText(b) {
  if (typeof b.content === 'string') return b.content;
  if (Array.isArray(b.content)) return b.content.map(x => (x && x.text) || '').join('');
  return '';
}

function ms(ts) {
  const t = Date.parse(ts);
  return Number.isFinite(t) ? t : null;
}

function listFiles(dir, deep) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      if (deep === true) out.push(...listFiles(p, true));
      else if (deep === 1) out.push(...listFiles(p, false));
    } else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

function readLines(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch (e) { return null; }
  return buf;
}

function parseLines(buf, onBad) {
  const rows = [];
  for (const l of buf.toString('utf8').split('\n')) {
    if (!l.trim()) continue;
    try {
      const r = JSON.parse(l);
      if (r && typeof r === 'object' && !Array.isArray(r)) rows.push(r);
      else onBad();
    } catch (e) { onBad(); }
  }
  return rows;
}

// ---------------------------------------------------------------- Claude Code

// Each action is one tool call. `kind` says who let it run:
//   yes       you, at the prompt, in that moment
//   rule      a "don't ask again" rule you saved earlier
//   mode      the permission mode (accept edits, bypass)
//   auto      auto mode's classifier
//   settings  settings or flags (allow lists, command line)
//   hook      a hook
//   no        you said no at the prompt
//   blocked   turned down by a rule, hook, classifier or no-one-there denial
//   other     the log does not say
function classifyClaude(rec, block) {
  const t = resultText(block);
  if (REFUSAL.test(t)) return { kind: 'no' };
  const pd = rec.permissionDecision;
  if (pd && typeof pd === 'object') {
    if (pd.decision === 'reject') return { kind: 'blocked' };
    if (pd.decision === 'accept') {
      if (pd.source === 'user_temporary') return { kind: 'yes' };
      if (pd.source === 'user_permanent') {
        // A match to a rule saved earlier carries reasonType "rule". Without it
        // the person answered this prompt with "yes, don't ask again".
        return pd.reasonType === 'rule' ? { kind: 'rule' } : { kind: 'yes', saved: true };
      }
      if (pd.source === 'hook') return { kind: 'hook' };
      if (pd.source === 'config') {
        if (pd.reasonType === 'mode') return { kind: 'mode' };
        if (pd.reasonType === 'classifier') return { kind: 'auto' };
        return { kind: 'settings' };
      }
    }
    return { kind: 'other' };
  }
  if (rec.toolDenialKind) return { kind: 'blocked' };
  return { kind: 'other' };
}

function isHumanClaude(r) {
  if (r.type !== 'user' || r.isMeta === true || r.isCompactSummary === true) return false;
  if (r.turnOrigin !== undefined && r.turnOrigin !== 'human') return false;
  if (r.origin !== undefined && !(r.origin && r.origin.kind === 'human')) return false;
  const c = r.message && r.message.content;
  if (Array.isArray(c) && c.some(b => b && b.type === 'tool_result')) return false;
  const t = textOf(c);
  return t.trim() !== '' && !NOT_TYPED.test(t);
}

function queuedHuman(r) {
  const a = r.type === 'attachment' ? r.attachment : null;
  if (!a || a.type !== 'queued_command' || a.commandMode !== 'prompt') return false;
  return a.origin === undefined || (a.origin && a.origin.kind === 'human');
}

function readClaudeSession(file, seen, stats) {
  const buf = readLines(file);
  if (!buf) { stats.unreadable++; return null; }
  // Only files that carry a permission decision say who approved what.
  const hasDecisions = buf.includes('"permissionDecision"');
  if (!hasDecisions) {
    if (buf.includes('"type":"assistant"') || buf.includes('"type": "assistant"')) stats.oldFormat++;
    else stats.unknown++;
    return null;
  }
  let bad = 0;
  const rows = parseLines(buf, () => { bad++; });
  stats.badLines += bad;
  const s = {
    tool: 'claude', file, cwd: '', program: false, sub: false,
    humans: [], actions: [], longest: 0, longestAt: null,
  };
  const asked = new Map(); // tool_use_id -> { at, name }
  let programTurn = false;
  let run = 0;
  for (const r of rows) {
    if (!s.cwd && typeof r.cwd === 'string') s.cwd = r.cwd;
    if (r.isSidechain === true) s.sub = true;
    if (r.type === 'user' && String(r.entrypoint || '').startsWith('sdk')) s.program = true;
    if (r.type === 'assistant') {
      const c = r.message && r.message.content;
      if (Array.isArray(c)) {
        for (const b of c) if (b && b.type === 'tool_use') asked.set(b.id, { at: ms(r.timestamp), name: b.name });
      }
      continue;
    }
    if (isHumanClaude(r) || queuedHuman(r)) {
      programTurn = false;
      run = 0;
      s.humans.push(textOf(r.type === 'attachment' ? r.attachment.prompt : r.message.content));
      continue;
    }
    // A prompt a program sent (claude -p inside a session, a scheduled task)
    // starts a turn that is not the person's.
    if (r.type === 'user' && (r.turnOrigin === 'sdk' || r.turnOrigin === 'scheduled')) {
      programTurn = true;
      continue;
    }
    if (r.type !== 'user') continue;
    const c = r.message && r.message.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (!b || b.type !== 'tool_result' || !b.tool_use_id) continue;
      if (seen.has(b.tool_use_id)) { stats.duplicates++; continue; }
      seen.add(b.tool_use_id);
      const q = asked.get(b.tool_use_id) || {};
      const at = ms(r.timestamp);
      const k = classifyClaude(r, b);
      // In a turn a program started, only a prompt the person answered is
      // theirs: someone was there to say yes or no. The rest is left out.
      if (programTurn && k.kind !== 'yes' && k.kind !== 'no') { stats.programTurnActions++; continue; }
      s.actions.push({
        at, kind: k.kind, saved: !!k.saved, edit: EDIT_TOOLS.has(q.name),
        wait: (k.kind === 'yes' && q.at != null && at != null && at >= q.at) ? (at - q.at) / 1000 : null,
      });
      run++;
      if (run > s.longest) { s.longest = run; s.longestAt = at; }
    }
  }
  return s;
}

// ---------------------------------------------------------------- Codex

function readCodexSession(file, seen, stats) {
  const buf = readLines(file);
  if (!buf) { stats.unreadable++; return null; }
  let bad = 0;
  const rows = parseLines(buf, () => { bad++; });
  stats.badLines += bad;
  const s = {
    tool: 'codex', file, cwd: '', program: false, sub: false,
    humans: [], actions: [], longest: 0, longestAt: null, known: false,
  };
  let policy = null;
  let run = 0;
  let headerAt = null; // the 2025 format stamps only its first line
  for (const r of rows) {
    const q = (r.payload && typeof r.payload === 'object') ? r.payload : null;
    if (headerAt == null && r.timestamp && r.type === undefined) headerAt = ms(r.timestamp);
    if (r.type === 'session_meta' && q) {
      s.known = true;
      if (typeof q.cwd === 'string') s.cwd = q.cwd;
      if (q.source && typeof q.source === 'object' && 'subagent' in q.source) s.sub = true;
      if (q.source === 'exec' || q.originator === 'codex_exec') s.program = true;
      continue;
    }
    if (r.type === 'turn_context' && q) {
      s.known = true;
      policy = typeof q.approval_policy === 'string' ? q.approval_policy : policy;
      if (!s.cwd && typeof q.cwd === 'string') s.cwd = q.cwd;
      continue;
    }
    // Modern records wrap the item in `payload`; the 2025 format did not.
    const item = r.type === 'response_item' ? q : (['message', 'function_call', 'custom_tool_call', 'local_shell_call'].includes(r.type) ? r : null);
    if (!item) continue;
    s.known = true;
    if (item.type === 'message' && item.role === 'user') {
      const t = textOf(item.content);
      if (t.trim() && !CODEX_WRAPPER.test(t)) { s.humans.push(t); run = 0; }
      continue;
    }
    if (!['function_call', 'custom_tool_call', 'local_shell_call'].includes(item.type)) continue;
    const id = item.call_id || item.id;
    if (id) {
      if (seen.has(id)) { stats.duplicates++; continue; }
      seen.add(id);
    }
    const args = typeof item.arguments === 'string' ? item.arguments : (typeof item.input === 'string' ? item.input : '');
    const at = r.timestamp ? ms(r.timestamp) : headerAt;
    s.actions.push({
      at,
      kind: policy === 'never' ? 'never' : policy ? 'could-ask' : 'unrecorded',
      escalated: /require_escalated|"with_escalated_permissions"\s*:\s*true/.test(args),
      edit: item.name === 'apply_patch' || args.includes('*** Begin Patch'),
    });
    run++;
    if (run > s.longest) { s.longest = run; s.longestAt = at; }
  }
  return s;
}

// ---------------------------------------------------------------- collect

function excluded(s) {
  if (s.sub) return 'subagent';
  if (s.program) return 'program';
  if (s.cwd && SCRATCH.test(s.cwd)) return 'scratch';
  if (s.humans.length && s.humans.every(t => PROBE.test(t))) return 'program';
  return null;
}

function collect(home) {
  const claudeRoot = path.join(home, '.claude', 'projects');
  const codexRoot = path.join(home, '.codex', 'sessions');
  const stats = {
    claudeFiles: 0, codexFiles: 0, oldFormat: 0, unknown: 0, unreadable: 0, badLines: 0,
    duplicates: 0, programTurnActions: 0,
    left: { subagent: 0, program: 0, scratch: 0 },
  };
  // Top level of each project folder only: subagent transcripts live deeper.
  const claudeFiles = listFiles(claudeRoot, 1);
  const codexFiles = listFiles(codexRoot, true);
  stats.claudeFiles = claudeFiles.length;
  stats.codexFiles = codexFiles.length;
  const sessions = [];
  const seenClaude = new Set();
  const seenCodex = new Set();
  // Oldest first so a resumed session's copied history counts once, where it began.
  const byTime = files => files.map(f => { let m = 0; try { m = fs.statSync(f).mtimeMs; } catch (e) { /* skip */ } return [f, m]; })
    .sort((a, b) => a[1] - b[1]).map(x => x[0]);
  for (const f of byTime(claudeFiles)) {
    const s = readClaudeSession(f, seenClaude, stats);
    if (!s) continue;
    const why = excluded(s);
    if (why) { stats.left[why]++; continue; }
    sessions.push(s);
  }
  let codexKnown = 0;
  for (const f of byTime(codexFiles)) {
    const s = readCodexSession(f, seenCodex, stats);
    if (!s) continue;
    if (!s.known) { stats.unknown++; continue; }
    codexKnown++;
    const why = excluded(s);
    if (why) { stats.left[why]++; continue; }
    sessions.push(s);
  }
  stats.codexKnown = codexKnown;
  return { sessions, stats, roots: { claude: fs.existsSync(claudeRoot), codex: fs.existsSync(codexRoot) } };
}

// ---------------------------------------------------------------- count

function median(xs) {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function weekStart(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

function projectName(cwd) {
  if (!cwd) return 'folder not recorded';
  return path.basename(cwd.replace(/[\\/]+$/, '')) || cwd;
}

function countClaude(sessions, since) {
  const list = sessions.filter(s => s.tool === 'claude');
  const all = [];
  for (const s of list) for (const a of s.actions) all.push(Object.assign({ project: projectName(s.cwd) }, a));
  const c = {
    sessions: list.filter(s => s.actions.length).length,
    actions: all.length,
    yes: 0, yesSaved: 0, no: 0, rule: 0, mode: 0, auto: 0, settings: 0, hook: 0, blocked: 0, other: 0,
    edits: 0, editsUnseen: 0, waitMedian: null, first: null, last: null,
    longest: 0, longestProject: null, longestAt: null,
    last1000: null, projects: [], weeks: [], since: null,
  };
  const waits = [];
  for (const a of all) {
    c[a.kind] = (c[a.kind] || 0) + 1;
    if (a.saved) c.yesSaved++;
    if (a.wait != null) waits.push(a.wait);
    if (a.edit && a.kind !== 'no' && a.kind !== 'blocked') {
      c.edits++;
      if (a.kind !== 'yes') c.editsUnseen++;
    }
    if (a.at != null) {
      if (c.first == null || a.at < c.first) c.first = a.at;
      if (c.last == null || a.at > c.last) c.last = a.at;
    }
  }
  c.waitMedian = median(waits);
  for (const s of list) {
    if (s.longest > c.longest) { c.longest = s.longest; c.longestProject = projectName(s.cwd); c.longestAt = s.longestAt; }
  }
  const timed = all.filter(a => a.at != null).sort((a, b) => b.at - a.at);
  if (timed.length) {
    const lastN = timed.slice(0, 1000);
    c.last1000 = { actions: lastN.length, yes: lastN.filter(a => a.kind === 'yes').length };
  }
  const group = (key) => {
    const m = new Map();
    for (const a of all) {
      const k = key(a);
      if (k == null) continue;
      const g = m.get(k) || { key: k, actions: 0, yes: 0, no: 0, editsUnseen: 0 };
      g.actions++;
      if (a.kind === 'yes') g.yes++;
      if (a.kind === 'no') g.no++;
      if (a.edit && a.kind !== 'yes' && a.kind !== 'no' && a.kind !== 'blocked') g.editsUnseen++;
      m.set(k, g);
    }
    return [...m.values()];
  };
  c.projects = group(a => a.project).sort((x, y) => y.actions - x.actions);
  c.weeks = group(a => (a.at == null ? null : weekStart(a.at))).sort((x, y) => x.key - y.key);
  if (since != null) {
    const fresh = all.filter(a => a.at != null && a.at > since);
    c.since = { actions: fresh.length, yes: fresh.filter(a => a.kind === 'yes').length, no: fresh.filter(a => a.kind === 'no').length };
  }
  return c;
}

function countCodex(sessions) {
  const list = sessions.filter(s => s.tool === 'codex');
  const c = { sessions: list.filter(s => s.actions.length).length, actions: 0, never: 0, couldAsk: 0, unrecorded: 0, escalated: 0, edits: 0, longest: 0, longestProject: null, longestAt: null, first: null, last: null };
  for (const s of list) {
    for (const a of s.actions) {
      c.actions++;
      if (a.kind === 'never') c.never++;
      else if (a.kind === 'could-ask') c.couldAsk++;
      else c.unrecorded++;
      if (a.escalated) c.escalated++;
      if (a.edit) c.edits++;
      if (a.at != null) {
        if (c.first == null || a.at < c.first) c.first = a.at;
        if (c.last == null || a.at > c.last) c.last = a.at;
      }
    }
    if (s.longest > c.longest) { c.longest = s.longest; c.longestProject = projectName(s.cwd); c.longestAt = s.longestAt; }
  }
  return c;
}

function analyze(home, opts) {
  opts = opts || {};
  const { sessions, stats, roots } = collect(home);
  const claude = countClaude(sessions, opts.since == null ? null : opts.since);
  const codex = countCodex(sessions);
  let status = 'ok';
  const claudeHas = claude.actions > 0;
  const codexHas = codex.actions > 0;
  if (!claudeHas && !codexHas) {
    if (stats.oldFormat > 0) status = 'claude-no-decisions';
    else if (stats.claudeFiles + stats.codexFiles === 0) status = 'none';
    else if (stats.unknown > 0 && stats.oldFormat === 0 && stats.codexKnown === 0) status = 'unknown-format';
    else status = 'none-usable';
  } else if (claudeHas && !codexHas) status = 'claude-only';
  else if (!claudeHas && codexHas) status = stats.oldFormat > 0 ? 'codex-only-old-claude' : 'codex-only';
  return { version: VERSION, status, claude, codex, stats, roots };
}

// ---------------------------------------------------------------- words

function n(x) { return Number(x || 0).toLocaleString('en-US'); }

function day(t) {
  const d = new Date(t);
  return d.getDate() + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
}

function dayYear(t) { return day(t) + ' ' + new Date(t).getFullYear(); }

function span(a, b) {
  if (a == null || b == null) return '';
  const now = new Date().getFullYear();
  const y = new Date(a).getFullYear() !== new Date(b).getFullYear() || new Date(b).getFullYear() !== now;
  if (day(a) === day(b)) return y ? dayYear(a) : day(a);
  return (y ? dayYear(a) : day(a)) + ' to ' + (y ? dayYear(b) : day(b));
}

function duration(sec) {
  if (sec == null) return null;
  if (sec < 60) return Math.round(sec) + ' s';
  if (sec < 3600) {
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return m + ' min' + (s ? ' ' + s + ' s' : '');
  }
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h + ' h' + (m ? ' ' + m + ' min' : '');
}

function times(x) { return n(x) + (x === 1 ? ' time' : ' times'); }

function many(x, one, more) { return n(x) + ' ' + (x === 1 ? one : (more || one + 's')); }

// Wrap text to the terminal width with a hanging indent.
function wrap(text, indent, first) {
  const pad = ' '.repeat(indent);
  const words = text.split(' ');
  const lines = [];
  let line = first != null ? first : pad;
  for (const w of words) {
    const sep = (line === '' || line.endsWith(' ')) ? '' : ' ';
    if ((line + sep + w).length > WIDTH && line.trim() !== '') {
      lines.push(line.replace(/\s+$/, ''));
      line = pad + w;
    } else line += sep + w;
  }
  if (line.trim()) lines.push(line.replace(/\s+$/, ''));
  return lines;
}

function row(label, value, indent) {
  const lab = (' '.repeat(indent || 2) + label).padEnd(22);
  return wrap(value, 22, lab);
}

function fit(s, w) { return s.length > w ? s.slice(0, w - 1) + '.' : s; }

const SENTENCES = {
  none: 'No agent sessions found on this computer. who-said-yes reads Claude Code' +
    ' sessions in ~/.claude/projects and Codex sessions in ~/.codex/sessions.' +
    ' Work with one of them for a while, then run this again.',
  'claude-no-decisions': 'Your Claude Code sessions are here, but they do not record who' +
    ' approved each action. Newer versions of Claude Code write this down. Update' +
    ' Claude Code, work for a day, then run this again.',
  'unknown-format': 'Found session files, but not in a format this version of' +
    ' who-said-yes can read. Nothing was counted. Try the newest version: npx' +
    ' who-said-yes@latest',
  'none-usable': 'Found session files, but none with actions you started yourself.' +
    ' Sessions run by a program (claude -p, the Agent SDK, codex exec) and subagent' +
    ' sessions are left out on purpose.',
};

function render(r, opts) {
  opts = opts || {};
  const out = [];
  const push = (...ls) => out.push(...ls);
  if (SENTENCES[r.status]) {
    push(...wrap(SENTENCES[r.status], 0, ''), '', LINK);
    return out.join('\n');
  }
  const c = r.claude;
  const x = r.codex;
  if (opts.guess != null && c.last1000) {
    const l = c.last1000;
    const of = l.actions >= 1000 ? 'the last 1,000' : 'the last ' + n(l.actions) + ' (all there are)';
    push(...wrap('You guessed ' + n(opts.guess) + '. You said yes yourself to ' + n(l.yes) + ' of ' + of + '.', 0, ''), '');
  }
  if (c.actions) {
    push(...wrap('YOU, AT THE PROMPT. Claude Code, ' + span(c.first, c.last) + ', ' +
      many(c.sessions, 'session') + ', ' + many(c.actions, 'action') + '.', 2, ''));
    const every = c.yes ? ', about 1 in every ' + n(Math.round(c.actions / c.yes)) + ' actions' : '';
    push(...row('You said yes', times(c.yes) + every));
    if (c.yesSaved) push(...row('', n(c.yesSaved) + ' of these yeses also saved a rule'));
    const w = duration(c.waitMedian);
    if (w) push(...row('How fast', w + ' from the ask to your yes (median)'));
    push(...row('You said no', times(c.no)));
    if (c.longest) {
      push(...row('Longest run', many(c.longest, 'action') + ' in a row with no message from you (' +
        c.longestProject + (c.longestAt ? ', ' + day(c.longestAt) : '') + ')'));
    }
    push(...row('File edits', c.edits
      ? n(c.editsUnseen) + ' of ' + n(c.edits) + ' file edits ran with no prompt shown to you'
      : 'none in these sessions'));
    push('');
    // A no-break space keeps each label on the same line as its number.
    const parts = [
      'rules you saved\u00a0' + n(c.rule), 'mode\u00a0' + n(c.mode), 'auto mode\u00a0' + n(c.auto),
      'settings\u00a0' + n(c.settings), 'hooks\u00a0' + n(c.hook),
    ];
    push(...wrap('Not you: ' + parts.join(', ') + '.', 9, '').map(l => l.replace(/\u00a0/g, ' ')));
    push(...wrap('Turned down without asking you: ' + n(c.blocked) + '.' +
      (c.other ? ' No decision in the log: ' + n(c.other) + '.' : ''), 0, ''));
  } else if (r.stats.oldFormat) {
    push(...wrap('Claude Code: your sessions here do not record who approved each action.' +
      ' Newer versions of Claude Code write this down.', 0, ''));
  } else {
    push(...wrap('No Claude Code sessions found, so your own yeses and noes cannot be' +
      ' counted. Codex keeps less, so this shows only the Codex part.', 0, ''));
  }
  if (x.actions) {
    push('');
    push(...wrap('CODEX. ' + span(x.first, x.last) + ', ' + many(x.sessions, 'session') + ', ' +
      many(x.actions, 'action') + '.', 2, ''));
    push(...wrap('Codex writes down its approval rule for each turn, not each yes you give,' +
      ' so your own yeses and noes cannot be counted here.', 2, '  '));
    if (x.never) push(...row('Never asks', many(x.never, 'action') + ' ran under the rule "never ask"'));
    if (x.couldAsk) push(...row('Could ask', many(x.couldAsk, 'action') + ' ran where Codex could ask you'));
    if (x.escalated) push(...row('Asked to step out', times(x.escalated) + ' Codex asked to leave its sandbox'));
    if (x.unrecorded) push(...row('Not recorded', many(x.unrecorded, 'action') + ' from older logs with no rule written'));
    if (x.longest) push(...row('Longest run', many(x.longest, 'action') + ' in a row with no message from you (' + x.longestProject + (x.longestAt ? ', ' + day(x.longestAt) : '') + ')'));
  } else if (c.actions) {
    push('', 'Codex: no sessions found.');
  }
  if (opts.detail && c.actions) {
    push('', 'BY PROJECT (Claude Code)');
    push('  ' + 'project'.padEnd(34) + 'actions'.padStart(10) + 'your yes'.padStart(10) + 'your no'.padStart(9) + 'unseen edits'.padStart(13));
    for (const p of c.projects.slice(0, 15)) {
      push('  ' + fit(p.key, 33).padEnd(34) + n(p.actions).padStart(10) + n(p.yes).padStart(10) + n(p.no).padStart(9) + n(p.editsUnseen).padStart(13));
    }
    if (c.projects.length > 15) push('  and ' + n(c.projects.length - 15) + ' more');
    push('', 'BY WEEK (Claude Code)');
    push('  ' + 'week of'.padEnd(34) + 'actions'.padStart(10) + 'your yes'.padStart(10) + 'your no'.padStart(9) + 'per 1,000'.padStart(13));
    for (const w of c.weeks) {
      const per = w.actions ? (w.yes * 1000 / w.actions).toFixed(1) : '0';
      push('  ' + day(w.key).padEnd(34) + n(w.actions).padStart(10) + n(w.yes).padStart(10) + n(w.no).padStart(9) + per.padStart(13));
    }
  } else if (c.actions) {
    push('', 'By project and by week: npx github:skprasad-korture/who-said-yes --detail');
  }
  if (opts.previous && c.since) {
    const p = opts.previous;
    push('');
    const words = 'Since your last run on ' + day(p.at) + ': ' + (c.since.actions
      ? many(c.since.actions, 'new action') + ', you said yes to ' + n(c.since.yes) + ' and no to ' + n(c.since.no) + '.'
      : 'no new actions.') +
      (p.guess != null ? ' Last time you guessed ' + n(p.guess) + '.' : '');
    push(...wrap(words, 0, ''));
  }
  push('', LINK);
  return out.join('\n');
}

function toJSON(r, opts) {
  const c = Object.assign({}, r.claude);
  c.weeks = c.weeks.map(w => Object.assign({}, w, { key: new Date(w.key).toISOString().slice(0, 10) }));
  for (const k of ['first', 'last', 'longestAt']) if (c[k] != null) c[k] = new Date(c[k]).toISOString();
  const x = Object.assign({}, r.codex);
  for (const k of ['first', 'last', 'longestAt']) if (x[k] != null) x[k] = new Date(x[k]).toISOString();
  return JSON.stringify({
    version: r.version, status: r.status, message: SENTENCES[r.status] || null,
    guess: opts.guess == null ? null : opts.guess,
    claude: c, codex: x, stats: r.stats,
    previous: opts.previous || null, link: LINK.replace('utm_content=cli', 'utm_content=cli-json'),
  }, null, 2);
}

// ---------------------------------------------------------------- state

function statePath(home) { return path.join(home, '.who-said-yes', 'last.json'); }

function loadState(home) {
  try {
    const s = JSON.parse(fs.readFileSync(statePath(home), 'utf8'));
    return (s && typeof s.at === 'number') ? s : null;
  } catch (e) { return null; }
}

function saveState(home, r, guess) {
  try {
    fs.mkdirSync(path.dirname(statePath(home)), { recursive: true });
    const c = r.claude;
    fs.writeFileSync(statePath(home), JSON.stringify({
      version: VERSION, at: Date.now(), guess: guess == null ? null : guess,
      claude: { actions: c.actions, yes: c.yes, no: c.no, editsUnseen: c.editsUnseen },
      codex: { actions: r.codex.actions },
    }, null, 2) + '\n');
  } catch (e) { /* a run still works without the state file */ }
}

// ---------------------------------------------------------------- main

const HELP = [
  'who-said-yes ' + VERSION,
  '',
  'Counts which of your coding agent\'s actions you approved yourself, from the',
  'session logs on this computer. Reads ~/.claude/projects and ~/.codex/sessions.',
  'Read only. Nothing leaves your computer.',
  '',
  'Usage: npx github:skprasad-korture/who-said-yes [options]',
  '',
  '  --detail       add counts by project and by week',
  '  --no-guess     skip the guess question',
  '  --guess N      give your guess up front (0 to 1000)',
  '  --json         print the counts as JSON',
  '  --no-save      do not remember this run (~/.who-said-yes/last.json)',
  '  --version      print the version',
  '  --help         print this',
].join('\n');

function parseArgs(argv) {
  const o = { detail: false, guess: null, ask: true, json: false, save: true, help: false, version: false, bad: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--detail') o.detail = true;
    else if (a === '--no-guess') o.ask = false;
    else if (a === '--json') o.json = true;
    else if (a === '--no-save') o.save = false;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--version' || a === '-v') o.version = true;
    else if (a === '--guess' || a.startsWith('--guess=')) {
      const v = a.includes('=') ? a.split('=')[1] : argv[++i];
      const g = parseGuess(v);
      if (g == null) o.bad = 'The guess should be a whole number from 0 to 1000.';
      else o.guess = g;
    } else o.bad = 'Unknown option ' + a + '. Run npx github:skprasad-korture/who-said-yes --help to see the options.';
  }
  return o;
}

function parseGuess(v) {
  if (v == null) return null;
  const t = String(v).replace(/,/g, '').trim();
  if (!/^\d+$/.test(t)) return null;
  const g = Number(t);
  return g <= 1000 ? g : null;
}

function ask(question) {
  return new Promise(resolve => {
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.on('SIGINT', () => { rl.close(); process.stdout.write('\n'); process.exit(0); });
    rl.question(question, a => { rl.close(); resolve(a); });
  });
}

async function main(argv) {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) {
    console.log('who-said-yes needs Node 18 or newer. You have Node ' + process.versions.node + '. Get a newer one at nodejs.org.');
    return 0;
  }
  const o = parseArgs(argv);
  if (o.version) { console.log(VERSION); return 0; }
  if (o.help) { console.log(HELP); return 0; }
  if (o.bad) { console.log(o.bad); return 2; }
  const home = os.homedir();
  const previous = loadState(home);
  let guess = o.guess;
  const interactive = !o.json && o.ask && guess == null && process.stdin.isTTY && process.stdout.isTTY;
  if (!o.json) console.log('who-said-yes ' + VERSION + '. Reads your agent logs on this computer. Sends nothing.\n');
  if (interactive) {
    // Only ask when there is something to compare the guess against.
    const quick = listFiles(path.join(home, '.claude', 'projects'), 1).length > 0;
    if (quick) {
      for (const l of wrap('Out of your agent\'s last 1,000 actions, how many do you think you said yes to yourself?', 0, '')) console.log(l);
      for (;;) {
        const a = (await ask('Your guess (0 to 1000, or Enter to skip): ')).trim();
        if (a === '') break;
        const g = parseGuess(a);
        if (g != null) { guess = g; break; }
        console.log('A whole number from 0 to 1000, please.');
      }
      console.log('');
    }
  }
  if (!o.json && process.stdout.isTTY) process.stdout.write('Counting...\r');
  const r = analyze(home, { since: previous ? previous.at : null });
  if (!o.json && process.stdout.isTTY) process.stdout.write('           \r');
  if (o.json) console.log(toJSON(r, { guess, previous }));
  else console.log(render(r, { guess, previous, detail: o.detail }));
  if (o.save && r.claude.actions + r.codex.actions > 0) saveState(home, r, guess);
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, () => {
    console.log('who-said-yes stopped on something it did not expect, and counted nothing.' +
      ' Please tell us at github.com/skprasad-korture/who-said-yes/issues');
    process.exitCode = 1;
  });
  process.on('uncaughtException', () => {
    console.log('who-said-yes stopped on something it did not expect, and counted nothing.');
    process.exit(1);
  });
}

module.exports = { analyze, render, toJSON, parseArgs, parseGuess, classifyClaude, VERSION, LINK };
