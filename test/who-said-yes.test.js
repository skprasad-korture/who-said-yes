'use strict';
// Run with: npm test   (node --test, no dependencies)
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const w = require('../bin/who-said-yes.js');

const FIX = path.join(__dirname, 'fixtures');
const BIN = path.join(__dirname, '..', 'bin', 'who-said-yes.js');
const run = (home, args) => execFileSync(process.execPath, [BIN, ...args], {
  env: Object.assign({}, process.env, { HOME: home }), encoding: 'utf8',
});

test('Claude Code: who let each action run', () => {
  const r = w.analyze(path.join(FIX, 'both'));
  const c = r.claude;
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(c.sessions, 2);
  assert.strictEqual(c.actions, 15);
  assert.strictEqual(c.yes, 4, 'user_temporary, plus one "yes, don\'t ask again" answered at the prompt');
  assert.strictEqual(c.yesSaved, 1);
  assert.strictEqual(c.rule, 1, 'a match to a rule saved earlier is not a yes');
  assert.strictEqual(c.no, 2, 'both refusal wordings, the duplicate record counted once');
  assert.strictEqual(c.mode, 3);
  assert.strictEqual(c.auto, 1);
  assert.strictEqual(c.settings, 1);
  assert.strictEqual(c.hook, 1);
  assert.strictEqual(c.blocked, 2, 'a classifier block and an instant no-one-there denial');
  assert.strictEqual(c.other, 0);
  assert.strictEqual(c.edits, 4);
  assert.strictEqual(c.editsUnseen, 2);
  assert.strictEqual(c.waitMedian, 45.5);
  assert.strictEqual(c.longest, 12);
  assert.strictEqual(c.longestProject, 'app');
  assert.deepStrictEqual(c.last1000, { actions: 15, yes: 4 });
  assert.deepStrictEqual(c.projects.map(p => [p.key, p.actions, p.yes, p.no]), [['app', 13, 4, 1], ['site', 2, 0, 1]]);
  assert.strictEqual(c.weeks.length, 2);
});

test('left out: subagents, programs, probes, program turns', () => {
  const s = w.analyze(path.join(FIX, 'both')).stats;
  assert.deepStrictEqual(s.left, { subagent: 2, program: 2, scratch: 1 });
  assert.strictEqual(s.programTurnActions, 1);
  assert.strictEqual(s.duplicates, 2);
  assert.strictEqual(s.badLines, 1);
});

test('Codex: approval rule per turn, programs and subagents left out', () => {
  const x = w.analyze(path.join(FIX, 'both')).codex;
  assert.strictEqual(x.sessions, 1);
  assert.strictEqual(x.actions, 3);
  assert.strictEqual(x.never, 2);
  assert.strictEqual(x.couldAsk, 1);
  assert.strictEqual(x.escalated, 1);
  assert.strictEqual(x.edits, 1);
  assert.strictEqual(x.longest, 3);
});

test('plain sentences for each kind of home folder', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'wsy-'));
  assert.strictEqual(w.analyze(empty).status, 'none');
  assert.strictEqual(w.analyze(path.join(FIX, 'codex-only')).status, 'codex-only');
  assert.strictEqual(w.analyze(path.join(FIX, 'codex-only')).codex.unrecorded, 2);
  assert.strictEqual(w.analyze(path.join(FIX, 'old-claude')).status, 'claude-no-decisions');
  assert.strictEqual(w.analyze(path.join(FIX, 'unknown')).status, 'unknown-format');
  const out = run(empty, ['--no-guess', '--no-save']);
  assert.match(out, /No agent sessions found on this computer\./);
  assert.doesNotMatch(out, /at .*\.js:\d+/, 'never a stack trace');
});

test('the printed report: order, width, words, link', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wsy-'));
  fs.cpSync(path.join(FIX, 'both'), home, { recursive: true });
  const out = run(home, ['--no-guess', '--detail', '--guess', '3']);
  const lines = out.trimEnd().split('\n');
  assert.strictEqual(lines[lines.length - 1], w.LINK);
  for (const l of lines.slice(0, -1)) assert.ok(l.length <= 80, 'too wide: ' + l);
  const at = s => out.indexOf(s);
  assert.ok(at('You guessed 3') < at('You said yes') && at('You said yes') < at('You said no'));
  assert.ok(at('You said no') < at('Longest run') && at('Longest run') < at('File edits'));
  assert.ok(at('File edits') < at('Not you:') && at('Not you:') < at('CODEX') && at('CODEX') < at('BY PROJECT'));
  assert.doesNotMatch(out, /\u2014/, 'no em dashes');
  // A second run shows the change since the first.
  const again = run(home, ['--no-guess']);
  assert.match(again, /Since your last run on /);
  assert.match(again, /Last time you\s+guessed 3\./);
});

test('json, version, help, bad options', () => {
  const j = JSON.parse(run(path.join(FIX, 'both'), ['--json', '--no-save']));
  assert.strictEqual(j.claude.yes, 4);
  assert.strictEqual(j.status, 'ok');
  assert.strictEqual(run(FIX, ['--version']).trim(), w.VERSION);
  assert.match(run(FIX, ['--help']), /--no-guess/);
  assert.strictEqual(w.parseGuess('1,000'), 1000);
  assert.strictEqual(w.parseGuess('1001'), null);
  assert.strictEqual(w.parseGuess('lots'), null);
});

test('no network code in the source', () => {
  const src = fs.readFileSync(BIN, 'utf8');
  assert.doesNotMatch(src, /require\(['"](?:node:)?(?:https?|net|dns|tls|dgram|http2)['"]\)/);
  assert.doesNotMatch(src, /\bfetch\s*\(|XMLHttpRequest|WebSocket/);
});
