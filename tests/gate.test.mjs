// Run: node --test tests/gate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { findCommits, commandText, decide, runGate, programExists, STATUS, MAX_REASON_CHARS } from '../plugin/hooks/gate.mjs';

const BASE = path.resolve(tmpdir(), 'am-gate-base');

function isCommit(cmd) {
  return findCommits(cmd, BASE).length > 0;
}

// ------------------------------------------------------------- detection

test('detects git commit in common shapes', () => {
  for (const cmd of [
    'git commit -m "x"',
    'git add . && git commit -m "fix: a && b"',
    'cd sub && git commit -m x',
    'git -C sub commit -m x',
    'git -c user.name=me commit -m x',
    'GIT_AUTHOR_NAME=me git commit -m x',
    '(git commit -m x)',
    '{ git commit -m x; }',
    'if ($?) { git commit -m x }',
    'git add -A; if ($?) { git commit -m x }',
    'if true; then git commit -m x; fi',
    'bash -c "git commit -m x"',
    'bash -lc "cd sub && git commit -m x"',
    'pwsh -Command "git commit -m x"',
    'cmd /c "git commit -m x"',
    '"C:\\Program Files\\Git\\bin\\git.exe" commit -m x',
    "git commit -m @'\nline one\nline two\n'@",
    'git commit --amend --no-edit',
  ]) {
    assert.ok(isCommit(cmd), cmd);
  }
});

test('ignores things that are not commits', () => {
  for (const cmd of [
    'echo "git commit"',
    'grep -r "git commit" .',
    'git commit-tree HEAD^{tree}',
    'git log --grep commit',
    'git commit --help',
    'git commit -h',
    'git commit --dry-run',
    'git status',
    '',
  ]) {
    assert.equal(isCommit(cmd), false, cmd);
  }
});

test('resolves the folder the commit runs in', () => {
  const sub = path.resolve(BASE, 'sub');
  assert.equal(findCommits('git -C sub commit -m x', BASE)[0].dir, sub);
  assert.equal(findCommits('cd sub && git commit -m x', BASE)[0].dir, sub);
  assert.equal(findCommits('Set-Location sub; git commit -m x', BASE)[0].dir, sub);
  assert.equal(findCommits('git --work-tree=sub commit -m x', BASE)[0].dir, sub);
  const dynamic = findCommits('cd $HOME && git commit -m x', BASE)[0];
  assert.equal(dynamic.unresolved, true);
  assert.equal(dynamic.dir, BASE);
});

test('reads Codex-style argv tool input', () => {
  assert.equal(commandText({ command: ['bash', '-lc', 'git commit -m x'] }), 'git commit -m x');
  assert.equal(commandText({ command: 'git status' }), 'git status');
  assert.equal(commandText({}), '');
});

// ------------------------------------------------------------- gate runs

function makeRepo(config) {
  const dir = mkdtempSync(path.join(tmpdir(), 'am-gate-'));
  mkdirSync(path.join(dir, '.git'));
  if (config !== undefined) writeFileSync(path.join(dir, 'am-gate.json'), typeof config === 'string' ? config : JSON.stringify(config));
  return dir;
}

const OK = 'node -e "process.exit(0)"';
const FAIL = 'node -e "console.log(\'compile error CS0246\');process.exit(3)"';
const SLEEP = 'node -e "setTimeout(()=>{},20000)"';

function payload(cwd, command, tool = 'Bash') {
  return JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command }, cwd, session_id: 's' });
}

function parseStdout(stdout) {
  const lines = stdout.trim() ? stdout.trim().split(/\r?\n/) : [];
  assert.ok(lines.length <= 1, 'stdout holds at most one JSON object');
  return lines.length ? JSON.parse(lines[0]) : null;
}

/** Blocked = exit 0 + permissionDecision "deny" with a bounded reason (Claude Code and Codex). */
function denialReason(r) {
  assert.equal(r.code, 0);
  assert.equal(r.stderr, '');
  const h = parseStdout(r.stdout).hookSpecificOutput;
  assert.equal(h.hookEventName, 'PreToolUse');
  assert.equal(h.permissionDecision, 'deny');
  assert.ok(h.permissionDecisionReason.length > 0 && h.permissionDecisionReason.length <= MAX_REASON_CHARS);
  return h.permissionDecisionReason;
}

test('passing gate lets the commit through and says so', async () => {
  const repo = makeRepo({ commands: [{ name: 'build', run: OK }] });
  const r = await decide(payload(repo, 'git commit -m x'));
  assert.equal(r.code, 0);
  const out = parseStdout(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.match(out.hookSpecificOutput.additionalContext, /^am gate: pass \(1 command, /);
  assert.equal(out.systemMessage, undefined);
  rmSync(repo, { recursive: true, force: true });
});

test('failing gate denies the commit with a bounded reason', async () => {
  const repo = makeRepo({ commands: [{ name: 'build', run: FAIL }] });
  for (const tool of ['Bash', 'PowerShell']) {
    const reason = denialReason(await decide(payload(repo, 'git commit -m x', tool)));
    assert.match(reason, /compile error CS0246/);
    assert.match(reason, /do not fix them; tell the user/);
    assert.doesNotMatch(reason, /AM_GATE/);
  }
  rmSync(repo, { recursive: true, force: true });
});

test('stops at the first blocking failure and skips non-blocking commands', async () => {
  const repo = makeRepo({
    commands: [
      { name: 'slow-lint', run: SLEEP, blocking: false },
      { name: 'build', run: FAIL },
      { name: 'marker', run: 'node -e "require(\'fs\').writeFileSync(\'marker.txt\',\'x\')"' },
    ],
  });
  const reason = denialReason(await decide(payload(repo, 'git commit -m x')));
  assert.equal(existsSync(path.join(repo, 'marker.txt')), false);
  assert.doesNotMatch(reason, /slow-lint/);
  rmSync(repo, { recursive: true, force: true });
});

test('a command that hangs past its timeout blocks, and the process tree is killed', async () => {
  const repo = makeRepo({ commands: [{ name: 'hang', run: SLEEP, timeoutMs: 500 }] });
  const t0 = Date.now();
  const reason = denialReason(await decide(payload(repo, 'git commit -m x')));
  assert.match(reason, /did not finish within/);
  assert.ok(Date.now() - t0 < 10000);
  rmSync(repo, { recursive: true, force: true });
});

test('running out of the shared time budget blocks with advice', async () => {
  const repo = makeRepo({ commands: [{ name: 'long', run: SLEEP }] });
  const reason = denialReason(await decide(payload(repo, 'git commit -m x'), { budgetMs: 600 }));
  assert.match(reason, /blocking": false/);
  rmSync(repo, { recursive: true, force: true });
});

test('a missing gate command is an error that warns but does not block', async () => {
  const repo = makeRepo({ commands: [{ name: 'tool', run: 'am-gate-no-such-command-xyz' }] });
  const r = await decide(payload(repo, 'git commit -m x'));
  assert.equal(r.code, 0);
  const out = parseStdout(r.stdout);
  assert.match(out.hookSpecificOutput.additionalContext, /ERROR - could not run "tool"/);
  assert.ok(out.systemMessage);
  rmSync(repo, { recursive: true, force: true });
});

test('programExists finds PATH programs, repo scripts and shell builtins', () => {
  const repo = makeRepo();
  mkdirSync(path.join(repo, 'DevTools'));
  writeFileSync(path.join(repo, 'DevTools', 'gate-build.cmd'), '@echo off\r\n');
  assert.equal(programExists('node -e "1"', repo), true);
  const sep = process.platform === 'win32' ? '\\' : '/';
  assert.equal(programExists(`DevTools${sep}gate-build.cmd Assembly-CSharp.csproj`, repo), true);
  // /bin/sh reads the backslash as an escape, so this path cannot run off Windows.
  if (process.platform !== 'win32') assert.equal(programExists('DevTools\\gate-build.cmd x', repo), false);
  assert.equal(programExists('DevTools/missing.cmd x', repo), false);
  assert.equal(programExists('exit 0', repo), true);
  assert.equal(programExists('am-gate-no-such-command-xyz --flag', repo), false);
  rmSync(repo, { recursive: true, force: true });
});

test('no config stays quiet; broken config warns', async () => {
  const none = makeRepo();
  const quiet = await decide(payload(none, 'git commit -m x'));
  assert.deepEqual([quiet.code, quiet.stdout, quiet.stderr], [0, '', '']);
  const broken = makeRepo('{ not json');
  const warn = await decide(payload(broken, 'git commit -m x'));
  assert.equal(warn.code, 0);
  assert.match(parseStdout(warn.stdout).hookSpecificOutput.additionalContext, /ERROR - am-gate\.json/);
  rmSync(none, { recursive: true, force: true });
  rmSync(broken, { recursive: true, force: true });
});

test('git -C picks the target repository gate, not the session folder', async () => {
  const outer = makeRepo({ commands: [{ name: 'outer-ok', run: OK }] });
  const inner = path.join(outer, 'sub');
  mkdirSync(path.join(inner, '.git'), { recursive: true });
  writeFileSync(path.join(inner, 'am-gate.json'), JSON.stringify({ commands: [{ name: 'inner-build', run: FAIL }] }));
  assert.match(denialReason(await decide(payload(outer, 'git -C sub commit -m x'))), /inner-build/);
  const passed = await decide(payload(outer, 'git commit -m x'));
  assert.equal(passed.code, 0);
  rmSync(outer, { recursive: true, force: true });
});

test('Codex workdir is honored', async () => {
  const repo = makeRepo({ commands: [{ name: 'build', run: FAIL }] });
  const raw = JSON.stringify({ tool_name: 'Bash', tool_input: { command: ['bash', '-lc', 'git commit -m x'], workdir: repo }, cwd: tmpdir() });
  denialReason(await decide(raw));
  rmSync(repo, { recursive: true, force: true });
});

test('AM_GATE=off bypasses with a warning; other tools and commands are ignored', async () => {
  const repo = makeRepo({ commands: [{ name: 'build', run: FAIL }] });
  const off = await decide(payload(repo, 'git commit -m x'), { env: { ...process.env, AM_GATE: 'off' } });
  assert.equal(off.code, 0);
  assert.match(parseStdout(off.stdout).hookSpecificOutput.additionalContext, /bypassed/);
  for (const r of [
    await decide(JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: 'x' }, cwd: repo })),
    await decide(payload(repo, 'git status')),
  ]) {
    assert.deepEqual([r.code, r.stdout, r.stderr], [0, '', '']);
  }
  rmSync(repo, { recursive: true, force: true });
});

test('cli mode runs every command and reports non-blocking failures without failing', async () => {
  const repo = makeRepo({ commands: [{ name: 'build', run: OK }, { name: 'lint', run: FAIL, blocking: false }] });
  const report = await runGate({ dir: repo, mode: 'cli' });
  assert.equal(report.status, STATUS.PASS);
  assert.equal(report.commands.length, 2);
  assert.equal(report.commands[1].exit, 3);
  rmSync(repo, { recursive: true, force: true });
});
