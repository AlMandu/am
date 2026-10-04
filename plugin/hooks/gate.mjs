// am commit gate.
// Finds `git commit` in a shell command, then runs the target repository's
// blocking gate commands from am-gate.json. Used by hook.mjs (PreToolUse, Claude
// Code and Codex) and by the am:check skill through the CLI:
//   node gate.mjs --run [--json] [--cwd <dir>]
// Node only, no dependencies.

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const STATUS = { PASS: 'pass', FAIL: 'fail', ERROR: 'error', UNCONFIGURED: 'unconfigured', BYPASSED: 'bypassed' };
export const CONFIG_FILE = 'am-gate.json';
// Must stay below the hooks.json timeout (900 s): a timed-out hook does not block.
export const HOOK_BUDGET_MS = 840000;
export const MAX_REASON_CHARS = 8000;
const DEFAULT_TIMEOUT_MS = 300000;
const TAIL_LINES = 40;
const TAIL_BYTES = 4000;
const OUTPUT_CAP_BYTES = 1024 * 1024;
const NOT_FOUND_EXITS = new Set([127, 9009]); // sh / cmd.exe: command not found
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

// ---------------------------------------------------------------- detection

/** Splits a command line into words and separators. Backslash is not an escape (Windows paths). */
export function tokenize(command) {
  const tokens = [];
  let buf = '';
  let quote = null;
  let hadQuote = false;
  const flush = () => {
    if (buf !== '' || hadQuote) tokens.push({ word: buf });
    buf = '';
    hadQuote = false;
  };
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      else buf += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hadQuote = true;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      flush();
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      flush();
      tokens.push({ op: two });
      i += 1;
      continue;
    }
    if (';|&\n\r(){}'.includes(ch)) {
      flush();
      tokens.push({ op: ch });
      continue;
    }
    buf += ch;
  }
  flush();
  return tokens;
}

/** Groups tokens into the simple commands of a compound line. */
export function segments(tokens) {
  const out = [];
  let cur = [];
  for (const t of tokens) {
    if (t.op !== undefined) {
      if (cur.length > 0) out.push(cur);
      cur = [];
    } else {
      cur.push(t.word);
    }
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

const PREFIX_WORDS = new Set(['sudo', 'command', 'env', 'nice', 'time', 'exec', 'builtin', 'if', 'then', 'do', 'else', 'elif', 'while', 'until', '!', '&']);
const CD_WORDS = new Set(['cd', 'chdir', 'pushd', 'set-location', 'sl', 'push-location']);
const UNRESOLVED_DIR_WORDS = new Set(['popd', 'pop-location']);
const SHELL_BINS = new Set(['bash', 'sh', 'zsh', 'dash', 'pwsh', 'powershell', 'cmd']);
const GIT_OPTS_WITH_VALUE = new Set(['-c', '--namespace', '--super-prefix', '--config-env', '--exec-path']);
const NOT_A_COMMIT = new Set(['--help', '-h', '--dry-run']);

function binName(word) {
  return path.basename(word.replace(/\\/g, '/')).toLowerCase().replace(/\.exe$/, '');
}

function isDynamic(word) {
  return /[$%`~]/.test(word);
}

/** Resolves a directory argument; Git Bash style /c/x becomes C:/x on Windows. */
function resolveDir(base, target) {
  const msys = process.platform === 'win32' && /^\/([a-zA-Z])(\/|$)/.exec(target);
  return path.resolve(base, msys ? `${msys[1]}:/${target.slice(3)}` : target);
}

function stripPrefixes(words) {
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || PREFIX_WORDS.has(w.toLowerCase())) i += 1;
    else break;
  }
  return words.slice(i);
}

/** Directory argument of cd / Set-Location; null when it cannot be resolved statically. */
function cdTarget(args) {
  const rest = args.filter((a) => !/^-(path|literalpath|l|p)$/i.test(a));
  const target = rest[0];
  if (target === undefined || target === '-' || isDynamic(target)) return null;
  return target;
}

/** The script a shell receives via -c / -Command / /c, or null. */
function innerScript(bin, args) {
  if (bin === 'cmd') {
    const i = args.findIndex((a) => /^\/[ck]$/i.test(a));
    return i >= 0 ? args.slice(i + 1).join(' ') : null;
  }
  if (bin === 'pwsh' || bin === 'powershell') {
    const i = args.findIndex((a) => /^-(c|command)$/i.test(a));
    return i >= 0 ? args.slice(i + 1).join(' ') : null;
  }
  const i = args.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a));
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : null;
}

/** git argv after the binary: {dir, unresolved} for a real commit, else null. */
function gitCommit(args, dir) {
  let d = dir;
  let unresolved = false;
  let gitDir = null;
  let workTree = null;
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === '-C') {
      const v = args[i + 1];
      if (v === undefined) return null;
      if (isDynamic(v)) unresolved = true;
      else d = resolveDir(d, v);
      i += 2;
      continue;
    }
    const eq = a.indexOf('=');
    const flag = eq > 0 ? a.slice(0, eq) : a;
    if (flag === '--git-dir' || flag === '--work-tree') {
      const v = eq > 0 ? a.slice(eq + 1) : args[i + 1];
      if (flag === '--git-dir') gitDir = v;
      else workTree = v;
      i += eq > 0 ? 1 : 2;
      continue;
    }
    if (eq < 0 && GIT_OPTS_WITH_VALUE.has(a)) {
      i += 2;
      continue;
    }
    if (a.startsWith('-')) {
      i += 1;
      continue;
    }
    if (a !== 'commit') return null;
    if (args.slice(i + 1).some((r) => NOT_A_COMMIT.has(r))) return null;
    const location = workTree ?? gitDir;
    if (location !== null && location !== undefined) {
      if (isDynamic(location)) unresolved = true;
      else d = workTree ? resolveDir(d, workTree) : path.dirname(resolveDir(d, gitDir));
    }
    return { dir: d, unresolved };
  }
  return null;
}

/** Every `git commit` in a command line, with the directory it runs in. */
export function findCommits(command, baseDir, depth = 0) {
  const found = [];
  if (typeof command !== 'string' || command.trim() === '' || depth > 3) return found;
  let dir = baseDir;
  let unresolved = false;
  for (const raw of segments(tokenize(command))) {
    const words = stripPrefixes(raw);
    if (words.length === 0) continue;
    const head = words[0].toLowerCase();
    const bin = binName(words[0]);
    if (CD_WORDS.has(head)) {
      const target = cdTarget(words.slice(1));
      if (target === null) unresolved = true;
      else dir = resolveDir(dir, target);
    } else if (UNRESOLVED_DIR_WORDS.has(head)) {
      unresolved = true;
    } else if (SHELL_BINS.has(bin)) {
      const inner = innerScript(bin, words.slice(1));
      if (inner) {
        for (const c of findCommits(inner, dir, depth + 1)) found.push({ dir: c.dir, unresolved: unresolved || c.unresolved });
      }
    } else if (bin === 'git') {
      const c = gitCommit(words.slice(1), dir);
      if (c) found.push({ dir: c.dir, unresolved: unresolved || c.unresolved });
    }
  }
  return found;
}

/** Command text from a hook payload's tool_input (Claude: string; Codex may send argv). */
export function commandText(toolInput) {
  const c = toolInput && toolInput.command;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c) || c.length === 0) return '';
  const bin = binName(String(c[0]));
  if (SHELL_BINS.has(bin)) {
    const inner = innerScript(bin, c.slice(1).map(String));
    if (inner) return inner;
  }
  return c.map((x) => (/\s/.test(String(x)) ? `"${x}"` : String(x))).join(' ');
}

// ------------------------------------------------------------------ config

/** Nearest ancestor holding `.git`; the start directory when there is none. */
export function findRepoRoot(startDir) {
  let dir = path.resolve(startDir);
  const fsRoot = path.parse(dir).root;
  for (;;) {
    if (existsSync(path.join(dir, '.git'))) return dir;
    if (dir === fsRoot) return path.resolve(startDir);
    dir = path.dirname(dir);
  }
}

/** {config} | {error} | null when the repository has no am-gate.json. */
export function loadConfig(root) {
  const file = path.join(root, CONFIG_FILE);
  if (!existsSync(file)) return null;
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (err) {
    return { error: `${CONFIG_FILE}: ${err.message}` };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { error: `${CONFIG_FILE}: root must be an object` };
  if (!Array.isArray(raw.commands) || raw.commands.length === 0) return { error: `${CONFIG_FILE}: "commands" must be a non-empty array` };
  const commands = [];
  for (let i = 0; i < raw.commands.length; i += 1) {
    const c = raw.commands[i];
    if (c === null || typeof c !== 'object' || typeof c.run !== 'string' || c.run.trim() === '') {
      return { error: `${CONFIG_FILE}: commands[${i}] needs a "run" string` };
    }
    commands.push({
      name: typeof c.name === 'string' && c.name.trim() ? c.name : `command-${i + 1}`,
      run: c.run,
      blocking: c.blocking !== false, // absent means blocking
      timeoutMs: Number.isFinite(c.timeoutMs) && c.timeoutMs > 0 ? c.timeoutMs : null,
    });
  }
  const timeoutMs = Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0 ? raw.timeoutMs : DEFAULT_TIMEOUT_MS;
  return { config: { timeoutMs, commands } };
}

// ----------------------------------------------------------------- running

// `run` goes through a shell, so the real command is a grandchild: kill the whole tree.
function killTree(child) {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => child.kill('SIGKILL'));
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

/** Runs one shell command (cmd.exe on Windows, /bin/sh elsewhere) with a hard timeout. Never rejects. */
export function runCommand(run, { cwd, timeoutMs }) {
  return new Promise((resolve) => {
    const started = Date.now();
    let child;
    try {
      child = spawn(run, { cwd, shell: true, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ spawnError: err.message, exit: null, timedOut: false, output: '', durationMs: 0 });
      return;
    }
    let output = '';
    const onData = (d) => {
      output += d;
      if (output.length > OUTPUT_CAP_BYTES) output = output.slice(-OUTPUT_CAP_BYTES);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, Math.max(1, timeoutMs));
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ output, durationMs: Date.now() - started, timedOut, ...r });
    };
    child.on('error', (err) => finish({ spawnError: err.message, exit: null }));
    child.on('close', (code) => finish({ spawnError: null, exit: code === null ? 1 : code }));
  });
}

const SHELL_BUILTINS = new Set(['echo', 'exit', 'cd', 'call', 'set', 'true', 'false', 'test', '[', 'type', 'start', 'if', 'for']);

/**
 * True when the program a `run` string starts with exists. Checked up front because
 * cmd.exe reports a missing program as plain exit 1 with a localized message.
 */
export function programExists(run, cwd, env = process.env) {
  const first = segments(tokenize(run))[0];
  const program = first && first[0];
  if (!program || SHELL_BUILTINS.has(program.toLowerCase()) || isDynamic(program)) return true;
  const win = process.platform === 'win32';
  const exts = win ? ['', ...String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)] : [''];
  const has = (p) => exts.some((e) => existsSync(p + e));
  if (/[\\/]/.test(program) || program.startsWith('.')) return has(path.resolve(cwd, program));
  const dirs = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  return (win && has(path.join(cwd, program))) || dirs.some((d) => has(path.join(d, program)));
}

function tailOf(text) {
  const lines = text.replace(/\r\n/g, '\n').trimEnd().split('\n');
  let tail = lines.slice(-TAIL_LINES).join('\n');
  if (tail.length > TAIL_BYTES) tail = tail.slice(-TAIL_BYTES);
  return tail;
}

/**
 * Runs the gate for the repository containing `dir`.
 * mode 'hook': blocking commands only, stop at the first failure, shared time budget.
 * mode 'cli' : every command, no budget (am:check reports non-blocking results too).
 */
export async function runGate({ dir, mode = 'cli', budgetMs = HOOK_BUDGET_MS, env = process.env }) {
  const root = findRepoRoot(dir);
  const report = { status: STATUS.PASS, reason: '', root, commands: [], durationMs: 0 };
  if (String(env.AM_GATE || '').trim().toLowerCase() === 'off') {
    return { ...report, status: STATUS.BYPASSED, reason: 'AM_GATE=off' };
  }
  const loaded = loadConfig(root);
  if (!loaded) return { ...report, status: STATUS.UNCONFIGURED, reason: `no ${CONFIG_FILE} in ${root}` };
  if (loaded.error) return { ...report, status: STATUS.ERROR, reason: loaded.error };

  const started = Date.now();
  const hook = mode === 'hook';
  for (const cmd of loaded.config.commands) {
    if (hook && !cmd.blocking) continue;
    const own = cmd.timeoutMs ?? loaded.config.timeoutMs;
    const remaining = hook ? budgetMs - (Date.now() - started) : Infinity;
    if (remaining <= 0) {
      report.status = STATUS.FAIL;
      report.reason = `gate time budget (${Math.round(budgetMs / 1000)}s) ran out before "${cmd.name}" - mark slow commands "blocking": false so they run only in am:check`;
      break;
    }
    const limit = Math.min(own, remaining);
    const res = programExists(cmd.run, root, env)
      ? await runCommand(cmd.run, { cwd: root, timeoutMs: limit })
      : { spawnError: 'program not found', exit: null, timedOut: false, output: '', durationMs: 0 };
    const entry = { name: cmd.name, run: cmd.run, blocking: cmd.blocking, exit: res.timedOut ? null : res.exit, timedOut: res.timedOut, durationMs: res.durationMs, tail: tailOf(res.output) };
    report.commands.push(entry);
    if (res.spawnError || NOT_FOUND_EXITS.has(res.exit)) {
      if (!cmd.blocking) continue;
      report.status = STATUS.ERROR;
      report.reason = `could not run "${cmd.name}"${res.spawnError ? ` - ${res.spawnError}` : ' - command not found'}`;
      break;
    }
    if (res.timedOut || res.exit !== 0) {
      if (!cmd.blocking) continue;
      report.status = STATUS.FAIL;
      report.reason = res.timedOut
        ? `"${cmd.name}" did not finish within ${Math.round(limit / 1000)}s` + (limit < own ? ' (gate time budget) - mark slow commands "blocking": false' : '')
        : `"${cmd.name}" exited with ${res.exit}`;
      if (hook) break;
    }
  }
  report.durationMs = Date.now() - started;
  return report;
}

export function formatReport(report) {
  const lines = [`gate: ${report.status}${report.reason ? ` - ${report.reason}` : ''}`, `  repo: ${report.root}`];
  for (const c of report.commands) {
    const verdict = c.timedOut ? 'TIMEOUT' : c.exit === 0 ? 'ok' : `exit ${c.exit}`;
    lines.push(`  - ${c.name} (${c.blocking ? 'blocking' : 'non-blocking'}): ${verdict}, ${(c.durationMs / 1000).toFixed(1)}s  [${c.run}]`);
    if (verdict !== 'ok' && c.tail) for (const l of c.tail.split('\n')) lines.push(`      | ${l}`);
  }
  return lines.join('\n');
}

// -------------------------------------------------------------------- hook

function contextOutput(message, { warn }) {
  const out = { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: message } };
  if (warn) out.systemMessage = message;
  return JSON.stringify(out) + '\n';
}

function denyOutput(reason) {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }) + '\n';
}

/**
 * PreToolUse decision for one hook payload. Returns {code, stdout, stderr}.
 * Contract: always exit 0; stdout is empty or one JSON object. Blocking uses
 * permissionDecision "deny": Codex 0.160 ran the command despite exit 2 (measured).
 */
export async function decide(raw, { env = process.env, budgetMs = HOOK_BUDGET_MS } = {}) {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { code: 0, stdout: contextOutput('am gate: hook input was not JSON - this command was not checked.', { warn: true }), stderr: '' };
  }
  if (!payload || !SHELL_TOOLS.has(payload.tool_name)) return { code: 0, stdout: '', stderr: '' };
  const input = payload.tool_input || {};
  const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();
  const base = typeof input.workdir === 'string' && input.workdir ? resolveDir(cwd, input.workdir) : cwd;
  const commits = findCommits(commandText(input), base);
  if (commits.length === 0) return { code: 0, stdout: '', stderr: '' };

  const notes = [];
  const passed = [];
  const started = Date.now();
  for (const target of new Map(commits.map((c) => [c.dir, c])).values()) {
    if (target.unresolved) notes.push(`could not tell which folder the commit runs in; checked ${target.dir}`);
    const report = await runGate({ dir: target.dir, mode: 'hook', budgetMs: budgetMs - (Date.now() - started), env });
    if (report.status === STATUS.FAIL) {
      let text = `am gate: commit blocked - a gate command failed.\n${formatReport(report)}\n\n` +
        'Fix the failure and commit again. If it comes from files outside your current task, do not fix them; tell the user.';
      if (notes.length) text += `\nNote: ${notes.join('; ')}`;
      if (text.length > MAX_REASON_CHARS) text = text.slice(0, MAX_REASON_CHARS - 20) + '\n...(truncated)';
      return { code: 0, stdout: denyOutput(text), stderr: '' };
    }
    if (report.status === STATUS.ERROR) {
      return { code: 0, stdout: contextOutput(`am gate: ERROR - ${report.reason}. This commit was NOT checked; tell the user.`, { warn: true }), stderr: '' };
    }
    if (report.status === STATUS.BYPASSED) {
      return { code: 0, stdout: contextOutput('am gate: bypassed by AM_GATE=off - this commit was not checked.', { warn: true }), stderr: '' };
    }
    if (report.status === STATUS.PASS) passed.push(report);
  }
  if (passed.length === 0) return { code: 0, stdout: '', stderr: '' }; // unconfigured: stay quiet
  const n = passed.reduce((s, r) => s + r.commands.length, 0);
  const secs = (passed.reduce((s, r) => s + r.durationMs, 0) / 1000).toFixed(1);
  const extra = notes.length ? ` - ${notes.join('; ')}` : '';
  return { code: 0, stdout: contextOutput(`am gate: pass (${n} command${n === 1 ? '' : 's'}, ${secs}s)${extra}`, { warn: false }), stderr: '' };
}

/** Reads all of stdin; gives up after 5 s so a hook without input cannot hang. */
export function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    const timer = setTimeout(() => {
      process.stdin.destroy();
      resolve(data);
    }, 5000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      data += c;
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(data);
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

// --------------------------------------------------------------------- CLI

async function cli(argv) {
  if (!argv.includes('--run')) {
    process.stdout.write('usage: node gate.mjs --run [--json] [--cwd <dir>]\n');
    return 2;
  }
  const i = argv.indexOf('--cwd');
  const dir = i >= 0 && argv[i + 1] ? argv[i + 1] : process.cwd();
  const report = await runGate({ dir, mode: 'cli' });
  process.stdout.write(argv.includes('--json') ? JSON.stringify(report, null, 2) + '\n' : formatReport(report) + '\n');
  return report.status === STATUS.FAIL ? 1 : report.status === STATUS.ERROR ? 3 : 0;
}

// Compare real paths: import.meta.url has symlinks resolved, argv[1] does not
// (a linked ~/.claude or plugin cache, macOS /var -> /private/var).
const isMain = () => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
};

if (isMain()) {
  cli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
