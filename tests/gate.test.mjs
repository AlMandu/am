// Run: node --test tests/gate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
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

test('skips prefix words with their options and values', () => {
  for (const cmd of [
    'env -i git commit -m x',
    'env -u X git commit -m x',
    'env -i A=1 git commit -m x',
    'sudo -u me git commit -m x',
    'sudo -g staff -E git commit -m x',
    'nice -n 5 git commit -m x',
    'nice -5 git commit -m x',
    'time -p git commit -m x',
    'command -p git commit -m x',
    'timeout 600 git commit -m x',
    'timeout -s KILL 10 git commit -m x',
    'timeout -k 5 --preserve-status 60 git commit -m x',
    'nohup git commit -m x',
    'sudo -u me timeout 60 nice -n 5 git commit -m x',
  ]) {
    assert.ok(isCommit(cmd), cmd);
  }
  for (const cmd of ['timeout 600 git status', 'env -u X git log --grep=commit', 'nohup echo git commit']) {
    assert.equal(isCommit(cmd), false, cmd);
  }
});

test('shell comments and line continuations do not hide a commit', () => {
  for (const cmd of [
    "# let's commit\ngit commit -m x",
    "git add . # don't forget\ngit commit -m x",
    'git \\\ncommit -m x',
    'git \\\r\ncommit -m x',
    'git add . && \\\n  git commit -m x',
    'bash -c "git \\\ncommit -m x"',
  ]) {
    assert.ok(isCommit(cmd), cmd);
  }
  for (const cmd of [
    '# git commit -m x',
    'git status # then git commit',
    'echo "# git commit"',
    "echo 'git \\\ncommit'",
    'git log --grep=commit',
  ]) {
    assert.equal(isCommit(cmd), false, cmd);
  }
  // A # inside a word is not a comment.
  assert.ok(isCommit('git commit -m issue#12'));
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

test('cmd cd /d changes to the folder after /d', () => {
  assert.equal(findCommits('cmd /c "cd /d repo && git commit -m x"', BASE)[0].dir, path.resolve(BASE, 'repo'));
  assert.equal(findCommits('cmd /c "CD /D repo && git commit -m x"', BASE)[0].dir, path.resolve(BASE, 'repo'));
  assert.equal(findCommits('cmd /c "chdir /d repo && git commit -m x"', BASE)[0].dir, path.resolve(BASE, 'repo'));
  const bare = findCommits('cmd /c "cd /d && git commit -m x"', BASE)[0];
  assert.equal(bare.dir, BASE);
  assert.equal(bare.unresolved, true);
});

test('cd /d keeps its meaning outside cmd', () => {
  const slashD = process.platform === 'win32' ? path.resolve('d:/') : path.resolve(BASE, '/d');
  for (const cmd of ['bash -c "cd /d && git commit -m x"', 'pwsh -Command "cd /d -PassThru; git commit -m x"', 'cd /d; git commit -m x']) {
    assert.equal(findCommits(cmd, BASE)[0].dir, slashD, cmd);
  }
  assert.equal(commandText({ command: ['cmd', '/c', 'cd /d repo && git commit -m x'] }), 'cd /d repo && git commit -m x');
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

test('a commit after cmd cd /d is checked in that folder (argv and string)', async () => {
  const repo = makeRepo({ commands: [{ name: 'build', run: FAIL }] });
  const name = path.basename(repo);
  for (const command of [['cmd', '/c', `cd /d ${name} && git commit -m x`], `cmd /c "cd /d ${name} && git commit -m x"`]) {
    const r = await decide(payload(path.dirname(repo), command));
    assert.notEqual(r.stdout, '', JSON.stringify(command));
    assert.ok(denialReason(r).includes(repo), JSON.stringify(command));
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

test('programExists on Windows finds PATH programs, repo scripts and shell builtins', () => {
  const repo = makeRepo();
  mkdirSync(path.join(repo, 'DevTools'));
  writeFileSync(path.join(repo, 'DevTools', 'gate-build.cmd'), '@echo off\r\n');
  const win = (run) => programExists(run, repo, process.env, 'win32');
  assert.equal(win('node -e "1"'), true);
  const sep = process.platform === 'win32' ? '\\' : '/';
  assert.equal(win(`DevTools${sep}gate-build.cmd Assembly-CSharp.csproj`), true);
  assert.equal(win('DevTools/missing.cmd x'), false);
  assert.equal(win('exit 0'), true);
  assert.equal(win('pushd sub && make'), true);
  assert.equal(win('am-gate-no-such-command-xyz --flag'), false);
  // Leading NAME=value words are not the program.
  assert.equal(win('CI=true node -e "1"'), true);
  assert.equal(win('CI=true am-gate-no-such-command-xyz'), false);
  rmSync(repo, { recursive: true, force: true });
});

test('programExists off Windows leaves a missing program to exit 127', () => {
  const repo = makeRepo();
  for (const run of ['am-gate-no-such-command-xyz --flag', 'CI=true npm test', 'export X=1 && npm test', 'source env.sh && make', '[[ -f x ]] && npm test']) {
    assert.equal(programExists(run, repo, process.env, 'linux'), true, run);
  }
  rmSync(repo, { recursive: true, force: true });
});

test('gate commands that start with a shell word or assignment run off Windows', { skip: process.platform === 'win32' }, async () => {
  for (const run of [`CI=true ${OK}`, `export X=1 && ${OK}`, `[ -d . ] && ${OK}`]) {
    const repo = makeRepo({ commands: [{ name: 'ok', run }] });
    const out = parseStdout((await decide(payload(repo, 'git commit -m x'))).stdout);
    assert.match(out.hookSpecificOutput.additionalContext, /am gate: pass/, run);
    rmSync(repo, { recursive: true, force: true });
  }
  const repo = makeRepo({ commands: [{ name: 'build', run: `export X=1 && ${FAIL}` }] });
  assert.match(denialReason(await decide(payload(repo, 'git commit -m x'))), /"build" exited with 3/);
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

test('hook.mjs ends with the crash notice and exit 0 when gate.mjs cannot load', () => {
  const repo = makeRepo();
  for (const gate of [null, 'export const = ;\n']) {
    const temp = mkdtempSync(path.join(tmpdir(), 'am-hook-copy-'));
    const config = path.join(temp, 'config');
    mkdirSync(config);
    mkdirSync(path.join(temp, 'hooks'));
    copyFileSync(HOOK, path.join(temp, 'hooks', 'hook.mjs'));
    if (gate !== null) writeFileSync(path.join(temp, 'hooks', 'gate.mjs'), gate);
    const r = runHook(path.join(temp, 'hooks', 'hook.mjs'), config, payload(repo, 'git commit -m x'));
    assert.equal(r.status, 0);
    assert.ok(r.stdout.endsWith('\n'));
    assert.equal(r.stdout.trim().split('\n').length, 1);
    const out = JSON.parse(r.stdout);
    assert.ok(out.systemMessage.startsWith('am gate: hook crashed ('), out.systemMessage);
    assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(out.hookSpecificOutput.permissionDecision, undefined);
    rmSync(temp, { recursive: true, force: true });
  }
  rmSync(repo, { recursive: true, force: true });
});

// ------------------------------------------------------------- interrupt

const GATE = fileURLToPath(new URL('../plugin/hooks/gate.mjs', import.meta.url));
// A gate command that starts a grandchild, writes both pids, then waits.
const PIDS_SCRIPT = [
  "const { spawn } = require('child_process');",
  "const fs = require('fs');",
  "const g = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore' });",
  "fs.writeFileSync('pids.tmp', JSON.stringify([process.pid, g.pid]));",
  "fs.renameSync('pids.tmp', 'pids.json');",
  'setTimeout(() => {}, 60000);',
].join('\n');

function makeInterruptRepo() {
  const repo = makeRepo({ commands: [{ name: 'slow', run: 'node pids.js' }] });
  writeFileSync(path.join(repo, 'pids.js'), PIDS_SCRIPT);
  return repo;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A killed process whose parent is gone waits as a zombie until PID 1 reaps it, and some
// containers reap late; kill(pid, 0) still finds a zombie, so it counts as ended here.
function alive(pid) {
  try {
    process.kill(pid, 0);
  } catch (err) {
    return err.code !== 'ESRCH';
  }
  if (!existsSync('/proc/self/stat')) return true;
  try {
    return readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /s, '')[0] !== 'Z';
  } catch {
    return false;
  }
}

async function waitFor(check, limitMs) {
  const end = Date.now() + limitMs;
  while (Date.now() < end) {
    const v = check();
    if (v) return v;
    await sleep(50);
  }
  return check();
}

/** Starts a process, waits for the gate command's pids, sends SIGTERM, returns {code, signal, stdout, stderr, pids, gone}. */
async function interrupt(args, { env = process.env, input } = {}, repo) {
  const child = spawn(process.execPath, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
  child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
  const closed = new Promise((r) => child.on('close', (code, signal) => r({ code, signal })));
  if (input !== undefined) child.stdin.end(input);
  else child.stdin.end();
  let pids = [];
  try {
    const file = path.join(repo, 'pids.json');
    assert.ok(await waitFor(() => existsSync(file), 10000), 'gate command did not start');
    pids = JSON.parse(readFileSync(file, 'utf8'));
    child.kill('SIGTERM');
    const { code, signal } = await closed;
    const gone = await waitFor(() => pids.every((p) => !alive(p)), 5000);
    return { code, signal, stdout, stderr, pids, gone };
  } finally {
    for (const p of pids) if (alive(p)) try { process.kill(p, 'SIGKILL'); } catch {}
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    rmSync(repo, { recursive: true, force: true });
  }
}

test('an interrupted gate CLI stops the running gate commands and exits 128 + signal', { skip: process.platform === 'win32' }, async () => {
  const repo = makeInterruptRepo();
  const r = await interrupt([GATE, '--run', '--json', '--cwd', repo], {}, repo);
  assert.ok(r.gone, `left running: ${JSON.stringify(r)}`);
  assert.equal(r.code, 143, JSON.stringify(r));
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /interrupted by SIGTERM/);
});

test('an interrupted hook stops the running gate commands and exits 0 with no output', { skip: process.platform === 'win32' }, async () => {
  const config = mkdtempSync(path.join(tmpdir(), 'am-hook-config-'));
  const env = { ...process.env, CLAUDE_CONFIG_DIR: config };
  delete env.AM_GATE;
  const repo = makeInterruptRepo();
  try {
    const r = await interrupt([HOOK], { env, input: payload(repo, 'git commit -m x') }, repo);
    assert.ok(r.gone, `left running: ${JSON.stringify(r)}`);
    assert.equal(r.code, 0, JSON.stringify(r));
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, '');
  } finally {
    rmSync(config, { recursive: true, force: true });
  }
});

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

test('importing gate.mjs, codex-opinion.mjs or stage.mjs attaches no signal handler', () => {
  const urls = ['../plugin/hooks/gate.mjs', '../plugin/scripts/codex-opinion.mjs', '../plugin/scripts/stage.mjs'].map((p) => new URL(p, import.meta.url).href);
  const code = `for (const u of ${JSON.stringify(urls)}) await import(u); console.log(JSON.stringify(${JSON.stringify(SIGNALS)}.map((s) => process.listenerCount(s))));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').pop()), [0, 0, 0]);
});

test('runGate removes its signal handlers when it ends, passing or failing', async () => {
  const count = () => SIGNALS.map((s) => process.listenerCount(s));
  const before = count();
  for (const run of [OK, FAIL]) {
    const repo = makeRepo({ commands: [{ name: 'build', run }] });
    const report = await runGate({ dir: repo, mode: 'cli' });
    assert.equal(report.status, run === OK ? STATUS.PASS : STATUS.FAIL);
    assert.deepEqual(count(), before);
    rmSync(repo, { recursive: true, force: true });
  }
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
