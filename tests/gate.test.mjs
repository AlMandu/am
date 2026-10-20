// Run: node --test tests/gate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findCommits, commandText, decide, runGate, programExists, findOnPath, shellCommands, gitSubcommand, programName, binName, STATUS, MAX_REASON_CHARS } from '../plugin/hooks/gate.mjs';
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

test('reads a command with the rules of the shell that runs it', () => {
  const has = (cmd, shell) => findCommits(cmd, BASE, 0, shell).length > 0;
  // bash: a backslash outside quotes makes the next character plain, so the quote opens nothing.
  assert.ok(has("echo don\\'t; git commit -m x", 'bash'));
  assert.equal(has("echo don\\'t; git commit -m x"), false);
  assert.equal(has('echo \\; git commit -m x', 'bash'), false);
  assert.ok(has("echo 'it\\'; git commit -m x", 'bash')); // no escape inside single quotes
  // pwsh: a line-end backtick joins the lines.
  assert.ok(has('git `\ncommit -m x', 'pwsh'));
  assert.ok(has('git `\r\ncommit -m x', 'powershell'));
  assert.equal(has('git `\ncommit -m x', 'bash'), false);
  // pwsh: a backtick escapes the next character, and a line-end backslash joins nothing.
  assert.ok(has("echo don`'t; git commit -m x", 'pwsh'));
  assert.ok(has('echo "it`"s"; git commit -m x', 'pwsh'));
  assert.ok(has('Set-Location C:\\repo\\\ngit commit -m x', 'pwsh'));
  for (const cmd of ['sed -i "s/\\"old\\"/\\"new\\"/" f.txt && git commit -am x', 'echo "a \\"b\\"" ; git commit -m x', 'node -e "console.log(\\"hi\\")"; git commit -m x']) {
    for (const shell of [undefined, 'bash', 'pwsh']) assert.ok(has(cmd, shell), `${shell}: ${cmd}`);
  }
  // A drive-relative folder (bash reads C:\dir as C:dir) is not resolved.
  const c = findCommits('cd C:\\dir && git commit -m x', BASE, 0, 'bash')[0];
  assert.deepEqual(c, { dir: BASE, unresolved: true });
});

test('values of commit options are not read as --dry-run or --help', () => {
  for (const cmd of ['git commit -m --dry-run', 'git commit -F --help', 'git commit --message --dry-run', 'git commit -C HEAD --amend']) {
    assert.ok(isCommit(cmd), cmd);
  }
  for (const cmd of ['git commit --dry-run -m x', 'git commit -m x --dry-run', 'git commit -am x -h']) {
    assert.equal(isCommit(cmd), false, cmd);
  }
});

test('reads Codex-style argv tool input', () => {
  assert.equal(commandText({ command: ['bash', '-lc', 'git commit -m x'] }), 'git commit -m x');
  assert.equal(commandText({ command: 'git status' }), 'git status');
  assert.equal(commandText({}), '');
});

// ------------------------------------------------------------- shell walker

test('shellCommands lists every simple command, nested shells read again with their rules', () => {
  assert.deepEqual(shellCommands('env A=1 git reset --hard && npm test | tee x', undefined), { commands: [['git', 'reset', '--hard'], ['npm', 'test'], ['tee', 'x']], tooDeep: false });
  assert.deepEqual(shellCommands('bash -c "git push origin"', undefined).commands, [['bash', '-c', 'git push origin'], ['git', 'push', 'origin']]);
  assert.deepEqual(shellCommands('cmd.exe /c git commit -m x').commands.at(-1), ['git', 'commit', '-m', 'x']);
  assert.deepEqual(shellCommands('g\\it push', 'bash').commands, [['git', 'push']]);
  assert.deepEqual(shellCommands('g\\it push').commands, [['g\\it', 'push']]);
  assert.deepEqual(shellCommands('', 'bash'), { commands: [], tooDeep: false });
  const quote = (c) => `"${c.replace(/[\\"]/g, (m) => `\\${m}`)}"`;
  const nest = (n) => {
    let c = 'ls';
    for (let i = 0; i < n; i++) c = `bash -c ${quote(c)}`;
    return c;
  };
  assert.equal(shellCommands(nest(3), 'bash').tooDeep, false);
  assert.deepEqual(shellCommands(nest(3), 'bash').commands.at(-1), ['ls']);
  assert.equal(shellCommands(nest(4), 'bash').tooDeep, true);
});

test('gitSubcommand skips global options; programName drops Windows endings', () => {
  assert.deepEqual(gitSubcommand(['-C', 'd', '-c', 'a=b', '--git-dir=x', '--work-tree', 'y', '--no-pager', 'checkout', 'main']), { sub: 'checkout', rest: ['main'], dynamic: false });
  assert.deepEqual(gitSubcommand(['$SUB', 'x']), { sub: '$SUB', rest: ['x'], dynamic: true });
  assert.deepEqual(gitSubcommand(['--version']), { sub: undefined, rest: [], dynamic: false });
  assert.equal(programName('C:\\Tools\\Codex.exe'), 'codex');
  assert.equal(programName('/usr/local/bin/claude.cmd'), 'claude');
  assert.equal(programName('run.ps1'), 'run');
  assert.equal(binName('claude.cmd'), 'claude.cmd');
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
  assert.ok(Date.now() - t0 < 10000);
  rmSync(repo, { recursive: true, force: true });
});

// Starts a grandchild that holds the gate's pipes for argv[2] ms (argv[3] 'detached': out of the tree kill), writes its pid and exits.
const HOLDER_SCRIPT = [
  "const { spawn } = require('child_process');",
  "const g = spawn(process.execPath, ['-e', 'setTimeout(()=>{},' + process.argv[2] + ')'], { stdio: 'inherit', detached: process.argv[3] === 'detached', windowsHide: true });",
  "require('fs').writeFileSync('holder.pid', String(g.pid));",
  'g.unref();',
].join('\n');

/** Runs one gate command in a repo holding HOLDER_SCRIPT; returns {report, ms, holderAlive}, and always stops the holder. */
async function runHeld(run, timeoutMs) {
  const repo = makeRepo({ commands: [{ name: 'held', run, timeoutMs }] });
  writeFileSync(path.join(repo, 'holder.js'), HOLDER_SCRIPT);
  let pid = null;
  try {
    const t0 = Date.now();
    const report = await runGate({ dir: repo, mode: 'hook' });
    const ms = Date.now() - t0;
    pid = Number(readFileSync(path.join(repo, 'holder.pid'), 'utf8'));
    return { report, ms, holderAlive: !(await waitFor(() => !alive(pid), 2000)) };
  } finally {
    if (pid && alive(pid)) try { process.kill(pid, 'SIGKILL'); } catch {}
    await sleep(200);
    rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

test('a grandchild that keeps the pipes open does not hold up a finished command', async () => {
  const { report, ms } = await runHeld('node holder.js 15000 detached', 10000);
  assert.equal(report.status, STATUS.PASS, JSON.stringify(report));
  assert.ok(ms < 8000, `${ms} ms`);
});

test('a finished command keeps its own exit code while a grandchild holds the pipes', async () => {
  const and = process.platform === 'win32' ? '&' : ';';
  const { report, ms } = await runHeld(`node holder.js 15000 detached ${and} exit 3`, 10000);
  assert.equal(report.status, STATUS.FAIL, JSON.stringify(report));
  assert.match(report.reason, /exited with 3/);
  assert.ok(ms < 8000, `${ms} ms`);
});

test('after the shell ends, a grandchild in its process group is stopped', { skip: process.platform === 'win32' }, async () => {
  const { report, ms, holderAlive } = await runHeld('node holder.js 15000', 10000);
  assert.equal(report.status, STATUS.PASS, JSON.stringify(report));
  assert.ok(ms < 8000, `${ms} ms`);
  assert.equal(holderAlive, false);
});

test('a timeout ends on time even when a grandchild outside the tree keeps the pipes', async () => {
  const and = process.platform === 'win32' ? '&' : ';';
  const { report, ms } = await runHeld(`node holder.js 30000 detached ${and} ${SLEEP}`, 2000);
  assert.equal(report.status, STATUS.FAIL);
  assert.match(report.reason, /did not finish within/);
  assert.ok(ms < 8000, `${ms} ms`);
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

test('a plain-string commit is checked when the tool shell reading or the plain reading finds it', async () => {
  const repo = makeRepo({ commands: [{ name: 'build', run: FAIL }] });
  for (const tool of ['Bash', 'PowerShell']) {
    for (const cmd of [
      'git commit -m --dry-run',
      'sed -i "s/\\"old\\"/\\"new\\"/" f.txt && git commit -am x',
      'echo "a \\"b\\"" ; git commit -m x',
      'node -e "console.log(\\"hi\\")"; git commit -m x',
      'echo "C:\\dir\\" ; git commit -m x',
      `cd ${repo} && git commit -m x`,
    ]) {
      assert.match(denialReason(await decide(payload(repo, cmd, tool))), /compile error/, `${tool}: ${cmd}`);
    }
    assert.deepEqual(await decide(payload(repo, 'echo "git commit"', tool)), { stdout: '' });
  }
  denialReason(await decide(payload(repo, "echo don\\'t; git commit -m x", 'Bash')));
  denialReason(await decide(payload(repo, 'git `\ncommit -m x', 'PowerShell')));
  rmSync(repo, { recursive: true, force: true });
});

test('a repository runs its gate once when the readings give different folders in it', async () => {
  const repo = makeRepo({ commands: [{ name: 'count', run: 'node -e "require(\'fs\').appendFileSync(\'runs.txt\',\'x\')"' }] });
  // plain reading: sub\dir, bash reading: subdir; both walk up to the same repository
  const out = parseStdout((await decide(payload(repo, 'cd sub\\dir && git commit -m x', 'Bash'))).stdout);
  assert.match(out.hookSpecificOutput.additionalContext, /^am gate: pass \(1 command, /);
  assert.equal(readFileSync(path.join(repo, 'runs.txt'), 'utf8'), 'x');
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

// ------------------------------------------------------------- hook.mjs and stage agents

const STAGE_PREFIX_AUTO = 'am-auto:stage-';
// A module that marks its loading with a file named mark, beside it; decide gives { stdout: out(payload) }.
const markerModule = (mark, out) => `import { writeFileSync } from 'node:fs';\nwriteFileSync(new URL('./${mark}', import.meta.url), 'x');\nexport function decide(p) { return { stdout: (${out})(typeof p === 'string' ? JSON.parse(p) : p) }; }\n`;

// A copy of am's hook.mjs beside a gate.mjs that marks its loading and decides with the real gate, and a stage-hook.mjs
// that only marks its loading (am no longer has one: nothing may load it).
function hookCopy() {
  const temp = mkdtempSync(path.join(tmpdir(), 'am-hook-copy-'));
  mkdirSync(path.join(temp, 'config'));
  mkdirSync(path.join(temp, 'hooks'));
  copyFileSync(HOOK, path.join(temp, 'hooks', 'hook.mjs'));
  const realGate = new URL('../plugin/hooks/gate.mjs', import.meta.url).href;
  writeFileSync(path.join(temp, 'hooks', 'gate.mjs'), `import { writeFileSync } from 'node:fs';\nwriteFileSync(new URL('./gate-loaded', import.meta.url), 'x');\nexport { decide } from ${JSON.stringify(realGate)};\n`);
  writeFileSync(path.join(temp, 'hooks', 'stage-hook.mjs'), "import { writeFileSync } from 'node:fs';\nwriteFileSync(new URL('./stage-hook-loaded', import.meta.url), 'x');\nexport async function main() {}\nexport async function stageOutput() { return ''; }\n");
  const loaded = (name) => existsSync(path.join(temp, 'hooks', `${name}-loaded`));
  return { temp, hook: path.join(temp, 'hooks', 'hook.mjs'), config: path.join(temp, 'config'), loaded };
}

function hookOut(r) {
  assert.equal(r.status, 0);
  return parseStdout(r.stdout);
}

test('hook.mjs: am-auto stage agent input ends with no output and loads neither the gate nor anything else', () => {
  const failing = makeRepo({ commands: [{ name: 'build', run: FAIL }] });
  const c = hookCopy();
  const bash = JSON.parse(payload(failing, 'git commit -m x'));
  const write = { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(failing, 'x.txt'), content: 'x' }, cwd: failing };
  const stop = { hook_event_name: 'SubagentStop', stop_hook_active: false, last_assistant_message: 'text', cwd: failing };
  for (const agent of ['am-auto:stage-commit', 'am-auto:stage-do', 'am-auto:stage-x']) {
    for (const p of [bash, write, stop]) {
      const input = JSON.stringify({ ...p, agent_type: agent, agent_id: 'a1' });
      const r = runHook(c.hook, c.config, input);
      assert.equal(r.status, 0, input);
      assert.equal(r.stdout, '', input);
    }
  }
  assert.equal(c.loaded('gate'), false);
  assert.equal(c.loaded('stage-hook'), false);
  for (const d of [failing, c.temp]) rmSync(d, { recursive: true, force: true });
});

test('hook.mjs: any other input, the old am:stage- names included, keeps the gate output', async () => {
  const repo = makeRepo();
  const failing = makeRepo({ commands: [{ name: 'build', run: FAIL }] });
  const c = hookCopy();
  const write = { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(repo, 'x.txt'), content: 'x' }, cwd: repo };
  const stop = { hook_event_name: 'SubagentStop', stop_hook_active: false, last_assistant_message: 'text', cwd: repo };
  const inputs = [];
  for (const extra of [{}, { agent_type: '' }, { agent_id: 'a1' }, { agent_type: 'other:stage-plan', agent_id: 'a1' }, { agent_type: 'am:stage-commit', agent_id: 'a1' }, { agent_type: 'am-auto:multi', agent_id: 'a1' }]) {
    inputs.push(payload(repo, 'git status'), JSON.stringify({ ...write, ...extra }), JSON.stringify({ ...stop, ...extra }));
    inputs.push(JSON.stringify({ ...JSON.parse(payload(failing, 'git commit -m x')), ...extra }));
  }
  let denied = 0;
  for (const input of inputs) {
    const r = runHook(c.hook, c.config, input);
    assert.equal(r.status, 0);
    const expected = (await decide(input)).stdout;
    if (expected === '') assert.equal(r.stdout, '', input);
    else {
      const decision = parseStdout(expected).hookSpecificOutput.permissionDecision;
      if (decision === 'deny') denied++;
      assert.equal(parseStdout(r.stdout).hookSpecificOutput.permissionDecision, decision, input);
    }
  }
  assert.equal(denied, 6, 'every failing commit was denied');
  assert.equal(c.loaded('gate'), true);
  assert.equal(c.loaded('stage-hook'), false);
  for (const d of [repo, failing, c.temp]) rmSync(d, { recursive: true, force: true });
});

// ------------------------------------------------------------- auto/hooks/stage-hook.mjs, the stage agent entry

const STAGE_HOOK = fileURLToPath(new URL('../auto/hooks/stage-hook.mjs', import.meta.url));
const GUARD_DENY_BASH = markerModule('guard-loaded', "(p) => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: p.tool_input && p.tool_input.command === 'refused' ? 'deny' : 'allow', permissionDecisionReason: 'guard' } }) + '\\n'");
const GATE_SILENT = markerModule('gate-loaded', "() => ''");

// stage-hook.mjs alone with marking fakes of stage-guard.mjs (guard text, null: none) and gate.mjs; run(input) calls its
// main() as am-auto's hooks.json does.
function stageHookCopy(guard = GUARD_DENY_BASH) {
  const temp = mkdtempSync(path.join(tmpdir(), 'am-stage-hook-'));
  copyFileSync(STAGE_HOOK, path.join(temp, 'stage-hook.mjs'));
  if (guard !== null) writeFileSync(path.join(temp, 'stage-guard.mjs'), guard);
  writeFileSync(path.join(temp, 'gate.mjs'), GATE_SILENT);
  const url = pathToFileURL(path.join(temp, 'stage-hook.mjs')).href;
  const run = (input) => spawnSync(process.execPath, ['-e', `import(${JSON.stringify(url)}).then((m) => m.main())`], { input, cwd: temp, encoding: 'utf8', timeout: 30000 });
  const loaded = (name) => existsSync(path.join(temp, `${name}-loaded`));
  const reset = () => ['guard', 'gate'].forEach((n) => rmSync(path.join(temp, `${n}-loaded`), { force: true }));
  return { temp, run, loaded, reset };
}

test('stage-hook.mjs: input that is no am-auto stage agent gives empty output and loads neither the guard nor the gate', () => {
  const s = stageHookCopy();
  const bash = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git status' }, cwd: s.temp };
  const write = { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(s.temp, 'x'), content: 'x' }, cwd: s.temp };
  const stop = { hook_event_name: 'SubagentStop', stop_hook_active: false, cwd: s.temp };
  const inputs = ['not json', ''];
  for (const extra of [{}, { agent_type: '' }, { agent_type: 'other:stage-plan', agent_id: 'a1' }, { agent_type: 'am:stage-do', agent_id: 'a1' }]) inputs.push(...[bash, write, stop].map((p) => JSON.stringify({ ...p, ...extra })));
  for (const input of inputs) {
    const r = s.run(input);
    assert.equal(r.status, 0, input);
    assert.equal(r.stdout, '', input);
    assert.equal(r.stderr, '', input);
  }
  assert.equal(s.loaded('guard'), false);
  assert.equal(s.loaded('gate'), false);
  rmSync(s.temp, { recursive: true, force: true });
});

test('stage-hook.mjs: a command the guard refuses never loads the gate; an allowed one does', () => {
  const s = stageHookCopy();
  const base = { hook_event_name: 'PreToolUse', agent_type: `${STAGE_PREFIX_AUTO}do`, agent_id: 'a1', cwd: s.temp, tool_name: 'Bash' };
  let r = s.run(JSON.stringify({ ...base, tool_input: { command: 'refused' } }));
  assert.equal(r.status, 0);
  assert.equal(parseStdout(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(s.loaded('guard'), true);
  assert.equal(s.loaded('gate'), false);
  s.reset();
  r = s.run(JSON.stringify({ ...base, tool_input: { command: 'git status' } }));
  assert.equal(parseStdout(r.stdout).hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(s.loaded('gate'), true);
  rmSync(s.temp, { recursive: true, force: true });
});

test('stage-hook.mjs: a stage guard that is missing or cannot load denies the tool call and blocks the stop once', () => {
  for (const guard of [null, 'export const = ;\n']) {
    const s = stageHookCopy(guard);
    const base = { agent_type: `${STAGE_PREFIX_AUTO}do`, agent_id: 'a1', cwd: s.temp };
    for (const tool of [{ tool_name: 'Bash', tool_input: { command: 'npm test' } }, { tool_name: 'Write', tool_input: { file_path: path.join(s.temp, 'x') } }]) {
      const out = hookOut(s.run(JSON.stringify({ ...base, hook_event_name: 'PreToolUse', ...tool })));
      assert.equal(out.hookSpecificOutput.permissionDecision, 'deny', String(guard));
      assert.match(out.hookSpecificOutput.permissionDecisionReason, /^am stage hook:/);
    }
    const out = hookOut(s.run(JSON.stringify({ ...base, hook_event_name: 'SubagentStop', stop_hook_active: false })));
    assert.equal(out.decision, 'block');
    assert.ok(out.reason.length > 0);
    const again = s.run(JSON.stringify({ ...base, hook_event_name: 'SubagentStop', stop_hook_active: true }));
    assert.equal(again.status, 0);
    assert.equal(again.stdout, '');
    assert.equal(s.loaded('gate'), false);
    rmSync(s.temp, { recursive: true, force: true });
  }
});

test('stage-hook.mjs imports nothing statically, and it and stage-guard.mjs name the same am-auto prefix', async () => {
  assert.doesNotMatch(readFileSync(STAGE_HOOK, 'utf8'), /^import\b/m);
  const hook = await import('../auto/hooks/stage-hook.mjs');
  const guard = await import('../auto/hooks/stage-guard.mjs');
  assert.equal(hook.STAGE_PREFIX, guard.STAGE_PREFIX);
  assert.equal(hook.STAGE_PREFIX, STAGE_PREFIX_AUTO);
  for (const name of Object.keys(guard.STAGE_AGENTS)) assert.ok(name.startsWith(STAGE_PREFIX_AUTO), name);
});

// ------------------------------------------------------------- am-auto's hooks.json, run as Claude Code runs it

const AUTO_ROOT = fileURLToPath(new URL('../auto', import.meta.url));
const autoHooks = () => JSON.parse(readFileSync(path.join(AUTO_ROOT, 'hooks', 'hooks.json'), 'utf8'));

/** Runs one hooks.json command string with CLAUDE_PLUGIN_ROOT at auto/: its `node -e "<code>"` code, run directly
 * rather than through the shell of the test PC. */
function runAutoCommand(command, input, env) {
  const m = /^node -e "(.*)"$/.exec(command);
  assert.ok(m, command);
  return spawnSync(process.execPath, ['-e', m[1]], { input, env: { ...env, CLAUDE_PLUGIN_ROOT: AUTO_ROOT }, encoding: 'utf8', timeout: 60000 });
}

test("am-auto's hooks.json commands run the stage guard, then the gate for an allowed shell command", () => {
  const config = mkdtempSync(path.join(tmpdir(), 'am-hook-config-'));
  const env = { ...process.env, CLAUDE_CONFIG_DIR: config, CLAUDE_PID: String(process.pid) };
  delete env.AM_GATE;
  const hooks = autoHooks().hooks;
  const [bashCmd, fileCmd] = hooks.PreToolUse.map((g) => g.hooks[0].command);
  const stopCmd = hooks.SubagentStop[0].hooks[0].command;
  const runId = 'abc123-0a1b2c';
  for (const [run, expected] of [[FAIL, 'deny'], [OK, 'allow']]) {
    const repo = makeRepo({ commands: [{ name: 'build', run }] });
    mkdirSync(path.join(repo, '.am', 'task'), { recursive: true });
    writeFileSync(path.join(repo, '.am', 'task', 'stage.json'), JSON.stringify({ pid: process.pid, runId, stage: 'commit', slug: 'task', push: false, t: Date.now() }));
    const base = { agent_type: `${STAGE_PREFIX_AUTO}commit`, agent_id: 'a1', cwd: repo };
    const bash = (command) => JSON.stringify({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });
    const out = hookOut(runAutoCommand(bashCmd, bash('git commit -F .am/task/commit-message.txt'), env));
    assert.equal(out.hookSpecificOutput.permissionDecision, expected);
    if (expected === 'deny') assert.match(out.hookSpecificOutput.permissionDecisionReason, /^am gate: commit blocked/);
    else assert.match(out.hookSpecificOutput.additionalContext, /^am gate: pass/);
    // A command the guard refuses never reaches the gate.
    const refused = hookOut(runAutoCommand(bashCmd, bash('git commit -m "feat(x): y"'), env));
    assert.equal(refused.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(refused.hookSpecificOutput.permissionDecisionReason, /^am stage hook:/);
    // The file tools go to the guard alone: the commit stage writes only its own files under .am/.
    const write = (file) => JSON.stringify({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(repo, file), content: 'x' } });
    assert.equal(hookOut(runAutoCommand(fileCmd, write('.am/task/commits.md'), env)).hookSpecificOutput.permissionDecision, 'allow');
    assert.equal(hookOut(runAutoCommand(fileCmd, write('src.txt'), env)).hookSpecificOutput.permissionDecision, 'deny');
    // SubagentStop: the guard's verdict on the final answer.
    const stop = (text) => JSON.stringify({ ...base, hook_event_name: 'SubagentStop', stop_hook_active: false, last_assistant_message: text });
    assert.equal(hookOut(runAutoCommand(stopCmd, stop('done'), env)).decision, 'block');
    const ok = runAutoCommand(stopCmd, stop(`AM_STAGE: BLOCKED ${runId}`), env);
    assert.equal(ok.status, 0);
    assert.equal(ok.stdout, '');
    // Input that is no stage agent: no output, whatever the tool, even a failing commit.
    for (const cmd of [bashCmd, fileCmd, stopCmd]) {
      const r = runAutoCommand(cmd, payload(repo, 'git commit -m x'), env);
      assert.equal(r.status, 0);
      assert.equal(r.stdout, '');
      assert.equal(r.stderr, '');
    }
    rmSync(repo, { recursive: true, force: true });
  }
  rmSync(config, { recursive: true, force: true });
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
  const urls = ['../plugin/hooks/gate.mjs', '../plugin/scripts/codex-opinion.mjs', '../auto/scripts/stage.mjs'].map((p) => new URL(p, import.meta.url).href);
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

const AM_HOOKS = new URL('../plugin/hooks/hooks.json', import.meta.url);
const AUTO_HOOKS = new URL('../auto/hooks/hooks.json', import.meta.url);
const commandsOf = (config) => Object.values(config.hooks).flatMap((groups) => groups.flatMap((g) => g.hooks.map((h) => h.command)));

test('hooks.json handlers of am and am-auto use only type, command and timeout', () => {
  for (const file of [AM_HOOKS, AUTO_HOOKS]) {
    const config = JSON.parse(readFileSync(file, 'utf8'));
    let handlers = 0;
    for (const [event, groups] of Object.entries(config.hooks)) {
      for (const group of groups) {
        for (const handler of group.hooks) {
          handlers++;
          for (const key of Object.keys(handler)) assert.ok(['type', 'command', 'timeout'].includes(key), `${file}: ${event}: ${key}`);
        }
      }
    }
    assert.ok(handlers > 0, String(file));
  }
});

test("am's hooks.json keeps its exact bytes", async () => {
  const { createHash } = await import('node:crypto');
  const sha = createHash('sha256').update(readFileSync(AM_HOOKS)).digest('hex');
  assert.equal(sha, 'a57310a701c71e251258fd7b25b2346a8bae465ffdce9216603052d1e4421430', 'plugin/hooks/hooks.json changed: every Codex user would have to approve the hook again');
});

test("am-auto's hooks.json sends the shell tools, the file tools and SubagentStop to stage-hook.mjs", () => {
  const config = JSON.parse(readFileSync(AUTO_HOOKS, 'utf8'));
  const command = "node -e \"import(require('url').pathToFileURL(process.env.CLAUDE_PLUGIN_ROOT+'/hooks/stage-hook.mjs')).then((m) => m.main())\"";
  assert.deepEqual(Object.keys(config.hooks), ['PreToolUse', 'SubagentStop']);
  assert.deepEqual(config.hooks.PreToolUse, [
    { matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command, timeout: 900 }] },
    { matcher: 'Write|Edit|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command, timeout: 60 }] },
  ]);
  assert.deepEqual(config.hooks.SubagentStop, [{ hooks: [{ type: 'command', command, timeout: 60 }] }]);
  // Claude Code may merge identical commands of two plugins into one.
  const am = new Set(commandsOf(JSON.parse(readFileSync(AM_HOOKS, 'utf8'))));
  for (const c of commandsOf(config)) assert.ok(!am.has(c), c);
});

test('plugin/ holds none of the files that moved to auto/', () => {
  const plugin = fileURLToPath(new URL('../plugin', import.meta.url));
  const moved = [
    ...['stage', 'agent-stage', 'progress', 'sessions', 'memory-guard', 'proc-tree', 'claude-opinion'].map((n) => path.join('scripts', `${n}.mjs`)),
    ...['handover', 'stage-guard', 'stage-hook'].map((n) => path.join('hooks', `${n}.mjs`)),
    ...['plan', 'do', 'check', 'commit', 'commit-push'].map((n) => path.join('agents', `stage-${n}.md`)),
    ...['auto-multi', 'auto-one', 'auto-agent', 'sessions', 'multi', 'one', 'agent'].map((n) => path.join('skills', n)),
  ];
  for (const rel of moved) assert.equal(existsSync(path.join(plugin, rel)), false, `plugin/${rel}`);
  for (const rel of moved.slice(0, -7)) assert.equal(existsSync(path.join(AUTO_ROOT, rel)), true, `auto/${rel}`);
});

test("am's hooks.json sends the shell tools, the file tools and SubagentStop to hook.mjs", () => {
  const config = JSON.parse(readFileSync(AM_HOOKS, 'utf8'));
  const command = "node -e \"import(require('url').pathToFileURL(process.env.CLAUDE_PLUGIN_ROOT+'/hooks/hook.mjs'))\"";
  assert.deepEqual(Object.keys(config.hooks), ['PreToolUse', 'SubagentStop']);
  assert.deepEqual(config.hooks.PreToolUse, [
    { matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command, timeout: 900 }] },
    { matcher: 'Write|Edit|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command, timeout: 60 }] },
  ]);
  assert.deepEqual(config.hooks.SubagentStop, [{ hooks: [{ type: 'command', command, timeout: 60 }] }]);
});
