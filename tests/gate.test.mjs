// Run: node --test tests/gate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findCommits, commandText, decide, runGate, programExists, findOnPath, STATUS, MAX_REASON_CHARS } from '../plugin/hooks/gate.mjs';
import { modelsTemplate, settingsTemplate } from '../plugin/scripts/user-files.mjs';

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
  assert.deepEqual(Object.keys(r), ['stdout']);
  const h = parseStdout(r.stdout).hookSpecificOutput;
  assert.equal(h.hookEventName, 'PreToolUse');
  assert.equal(h.permissionDecision, 'deny');
  assert.ok(h.permissionDecisionReason.length > 0 && h.permissionDecisionReason.length <= MAX_REASON_CHARS);
  return h.permissionDecisionReason;
}

test('passing gate lets the commit through and says so', async () => {
  const repo = makeRepo({ commands: [{ name: 'build', run: OK }] });
  const r = await decide(payload(repo, 'git commit -m x'));
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
  // runCommand settles on close, which waits for the grandchild that holds the pipes, so returning within 10 s shows the tree was killed
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

test('findOnPath picks regular files only, in PATH then extension order', () => {
  const d1 = mkdtempSync(path.join(tmpdir(), 'am-path1-'));
  const d2 = mkdtempSync(path.join(tmpdir(), 'am-path2-'));
  mkdirSync(path.join(d1, 'tool.cmd')); // a folder with the program's name is skipped
  writeFileSync(path.join(d2, 'tool.cmd'), '@echo off\r\n');
  const env = { PATH: [d1, d2].join(path.delimiter) };
  assert.deepEqual(findOnPath('tool', env, ['.exe', '.cmd']), { file: path.join(d2, 'tool.cmd'), shell: true });
  assert.equal(findOnPath('tool', { PATH: d1 }, ['.exe', '.cmd']), null);
  assert.deepEqual(findOnPath('tool', { Path: d2 }, ['.cmd']), { file: path.join(d2, 'tool.cmd'), shell: true });
  writeFileSync(path.join(d2, 'tool.exe'), '');
  assert.deepEqual(findOnPath('tool', env, ['.exe', '.cmd']), { file: path.join(d2, 'tool.exe'), shell: false });
  // A name with a path is checked as given, not searched on PATH.
  assert.equal(findOnPath(path.join(d2, 'tool'), { PATH: '' }, ['.cmd']).file, path.join(d2, 'tool') + '.cmd');
  assert.equal(findOnPath(path.join(d2, 'missing'), { PATH: d2 }, ['.cmd']), null);
  rmSync(d1, { recursive: true, force: true });
  rmSync(d2, { recursive: true, force: true });
});

test('no config stays quiet; broken config warns', async () => {
  const none = makeRepo();
  const quiet = await decide(payload(none, 'git commit -m x'));
  assert.deepEqual(quiet, { stdout: '' });
  const broken = makeRepo('{ not json');
  const warn = await decide(payload(broken, 'git commit -m x'));
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
  assert.match(parseStdout(passed.stdout).hookSpecificOutput.additionalContext, /^am gate: pass/);
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
  assert.match(parseStdout(off.stdout).hookSpecificOutput.additionalContext, /bypassed/);
  for (const r of [
    await decide(JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: 'x' }, cwd: repo })),
    await decide(payload(repo, 'git status')),
  ]) {
    assert.deepEqual(r, { stdout: '' });
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

// ------------------------------------------------------------- hook.mjs process

const HOOK = fileURLToPath(new URL('../plugin/hooks/hook.mjs', import.meta.url));

// Runs a hook.mjs file as a real process, with the given config folder and no AM_GATE.
function runHook(hook, configDir, input) {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir };
  delete env.AM_GATE;
  const r = spawnSync(process.execPath, [hook], { input, env, encoding: 'utf8', timeout: 30000 });
  assert.equal(r.stderr, '');
  return r;
}

test('hook.mjs creates the missing user files before the gate and stays silent', () => {
  const config = mkdtempSync(path.join(tmpdir(), 'am-hook-config-'));
  const repo = makeRepo();
  const models = path.join(config, 'am', 'models.json');
  const settings = path.join(config, 'am', 'settings.json');
  let r = runHook(HOOK, config, payload(repo, 'git status'));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(readFileSync(models, 'utf8'), modelsTemplate());
  assert.equal(readFileSync(settings, 'utf8'), settingsTemplate());
  // An existing file is never touched; only the missing one comes back.
  const own = '{"model":{"plan":"sonnet"}}';
  writeFileSync(models, own);
  rmSync(settings);
  r = runHook(HOOK, config, payload(repo, 'git status'));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(readFileSync(models, 'utf8'), own);
  assert.equal(readFileSync(settings, 'utf8'), settingsTemplate());
  rmSync(config, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

test('hook.mjs creates nothing when the config folder is missing', () => {
  const temp = mkdtempSync(path.join(tmpdir(), 'am-hook-config-'));
  const missing = path.join(temp, 'missing');
  const repo = makeRepo();
  const r = runHook(HOOK, missing, payload(repo, 'git status'));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(existsSync(missing), false);
  rmSync(temp, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

test('hook.mjs still runs the gate when the user files module cannot load', () => {
  const temp = mkdtempSync(path.join(tmpdir(), 'am-hook-copy-'));
  const config = path.join(temp, 'config');
  mkdirSync(config);
  mkdirSync(path.join(temp, 'hooks'));
  for (const name of ['hook.mjs', 'gate.mjs']) copyFileSync(fileURLToPath(new URL(`../plugin/hooks/${name}`, import.meta.url)), path.join(temp, 'hooks', name));
  const hook = path.join(temp, 'hooks', 'hook.mjs');
  const repo = makeRepo({ commands: [{ name: 'build', run: FAIL }] });
  let r = runHook(hook, config, payload(repo, 'git commit -m x'));
  assert.equal(r.status, 0);
  assert.equal(parseStdout(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
  r = runHook(hook, config, payload(repo, 'git status'));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  rmSync(temp, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

// ------------------------------------------------------------- hooks.json

test('hooks.json handlers use only type, command and timeout', () => {
  const config = JSON.parse(readFileSync(new URL('../plugin/hooks/hooks.json', import.meta.url), 'utf8'));
  let handlers = 0;
  for (const [event, groups] of Object.entries(config.hooks)) {
    for (const group of groups) {
      for (const handler of group.hooks) {
        handlers++;
        for (const key of Object.keys(handler)) assert.ok(['type', 'command', 'timeout'].includes(key), `${event}: ${key}`);
      }
    }
  }
  assert.ok(handlers > 0);
});
