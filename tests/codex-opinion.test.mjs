// Run: node --test tests/codex-opinion.test.mjs
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ANSWER_HEADER,
  CODEX_ARGS,
  EXIT_NO_SESSION,
  FrameReader,
  MAX_BRIEF_BYTES,
  MAX_PEER_PROMPT_BYTES,
  PEER_HEADERS,
  buildPrompt,
  checkBrief,
  codexArgs,
  encodeFrame,
  idleSessions,
  main,
  parseArgs,
  peerPrompt,
  reviewerLine,
  rpcOver,
  sessionProblem,
  wsAccept,
} from '../plugin/scripts/codex-opinion.mjs';
import { OPINION_MODELS, USER_EFFORTS, frontmatterModels } from '../plugin/scripts/user-models.mjs';
import { CODEX_ARGS as UTIL_CODEX_ARGS, main as utilMain } from '../util/scripts/codex-opinion.mjs';
import { createDaemon, memoryConnect } from './fake-codex-daemon.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, '..', 'plugin', 'scripts', 'codex-opinion.mjs');
const AGENT = path.join(here, '..', 'plugin', 'agents', 'second-opinion.md');
const FAKE = path.join(here, 'fake-codex.mjs');
const WIN = process.platform === 'win32';
// Built-in values read from the shipped files (scripts/models.mjs writes them where models.json exists); an absent model is ''.
const builtinArg = (prefix) => CODEX_ARGS.find((a) => a.startsWith(prefix))?.slice(prefix.length) ?? '';
const CODEX = { model: builtinArg('model='), effort: builtinArg('model_reasoning_effort=') };

const bases = [];
after(() => {
  for (const base of bases) rmSync(base, { recursive: true, force: true });
});

/** A repository folder with .am/x/brief.md, a folder with a fake codex, and an empty folder. */
function setup() {
  const base = mkdtempSync(path.join(tmpdir(), 'am-codex-test-'));
  bases.push(base);
  const repo = path.join(base, 'repo');
  mkdirSync(path.join(repo, '.am', 'x'), { recursive: true });
  writeFileSync(path.join(repo, '.am', 'x', 'brief.md'), '## Choices\n1. Cache: A or B\n');
  const bin = path.join(base, 'bin');
  mkdirSync(bin);
  if (WIN) writeFileSync(path.join(bin, 'codex.cmd'), `@"${process.execPath}" "${FAKE}" %*\r\n`);
  else {
    // No exec: sh stays the parent of node, so a timeout has a process tree to end.
    writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\n"${process.execPath}" "${FAKE}" "$@"\n`);
    chmodSync(path.join(bin, 'codex'), 0o755);
  }
  const empty = path.join(base, 'empty');
  mkdirSync(empty);
  return { base, repo, bin, empty, log: path.join(base, 'calls.jsonl'), config: path.join(base, 'config') };
}

// CLAUDE_CONFIG_DIR points at the test's own folder, so the user's real models file is never read.
async function call(t, argv, { mode = 'ok', pathDir = t.bin, timeoutMs = 20000, extra = {}, agentFile } = {}) {
  let text = '';
  const env = { ...process.env, CLAUDE_CONFIG_DIR: t.config, PATH: pathDir, FAKE_CODEX_MODE: mode, FAKE_CODEX_LOG: t.log, ...extra };
  const code = await main(argv, { cwd: t.repo, env, timeoutMs, out: { write: (s) => (text += s) }, ...(agentFile ? { agentFile } : {}) });
  return { code, text };
}
const calls = (t) => (existsSync(t.log) ? readFileSync(t.log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
/** Writes the user models file of the test's config folder and returns its path. */
function userFile(t, text) {
  const file = path.join(t.config, 'am', 'models.json');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof text === 'string' ? text : JSON.stringify(text));
  return file;
}
// Values picked to differ from the built-in ones, so the tests survive a change of defaults.
const other = (now, pool) => pool.find((v) => v !== now);
const REVIEWER = frontmatterModels(AGENT);

test('only a regular .md file under .am/ is accepted as the brief', () => {
  const t = setup();
  writeFileSync(path.join(t.base, 'outside.md'), 'x');
  writeFileSync(path.join(t.repo, '.am', 'x', 'brief.txt'), 'x');
  mkdirSync(path.join(t.repo, '.am', 'dir.md'));
  writeFileSync(path.join(t.repo, '.am', 'big.md'), 'x'.repeat(MAX_BRIEF_BYTES + 1));
  assert.equal(checkBrief('.am/x/brief.md', t.repo), null);
  assert.equal(checkBrief(path.join(t.repo, '.am', 'x', 'brief.md'), t.repo), null, 'absolute path inside .am');
  assert.match(checkBrief('../outside.md', t.repo), /inside \.am/);
  assert.match(checkBrief('.am/../../outside.md', t.repo), /inside \.am/);
  assert.match(checkBrief('.am/x/brief.txt', t.repo), /\.md file/);
  assert.match(checkBrief('.am/dir.md', t.repo), /not a file/);
  assert.match(checkBrief('.am/big.md', t.repo), /larger than/);
  assert.match(checkBrief('.am/missing.md', t.repo), /not found/);
  assert.match(checkBrief('.am/x/brief.md', t.base), /no \.am folder/);
  if (!WIN) {
    symlinkSync(path.join(t.base, 'outside.md'), path.join(t.repo, '.am', 'link.md'));
    assert.match(checkBrief('.am/link.md', t.repo), /inside \.am/, 'a link out of .am is followed and refused');
  }
});

test('codex not on PATH: exit 2 and nothing runs, whatever the brief', async () => {
  const t = setup();
  for (const brief of ['.am/x/brief.md', '../outside.md']) {
    const r = await call(t, [brief], { pathDir: t.empty });
    assert.equal(r.code, 2, brief);
    assert.match(r.text, /not installed/);
  }
});

test('bad arguments: exit 1 before codex starts', async () => {
  const t = setup();
  writeFileSync(path.join(t.base, 'outside.md'), 'secret');
  for (const argv of [[], ['.am/x/brief.md', '--dangerously-bypass-approvals-and-sandbox'], ['../outside.md']]) {
    const r = await call(t, argv);
    assert.equal(r.code, 1, argv.join(' '));
  }
  assert.deepEqual(calls(t), []);
});

test('answer: fixed read-only flags, prompt on stdin, only the last message printed', async () => {
  const t = setup();
  const r = await call(t, ['.am/x/brief.md'], { extra: { FAKE_CODEX_ANSWER: 'Cache: B\nWhy: fewer writes.\nRisk: none' } });
  assert.equal(r.code, 0, r.text);
  assert.equal(r.text, `${ANSWER_HEADER}\nCache: B\nWhy: fewer writes.\nRisk: none\n`);
  const [c] = calls(t);
  const out = c.argv.indexOf('--output-last-message');
  assert.deepEqual(c.argv.slice(0, out), CODEX_ARGS);
  assert.deepEqual(c.argv.slice(out + 2), ['-']);
  for (const flag of ['read-only', 'approval_policy=never', `model_reasoning_effort=${CODEX.effort}`, 'mcp_servers={}', '--ignore-rules', '--ephemeral']) assert.ok(CODEX_ARGS.includes(flag), flag);
  // An empty model leaves the user's codex config in charge.
  assert.deepEqual(CODEX_ARGS.filter((a) => a.startsWith('model=')), CODEX.model ? [`model=${CODEX.model}`] : []);
  // Each config value is the argument of its own -c, or Codex takes it for a stray argument.
  for (const v of CODEX_ARGS.filter((a) => /^(model|model_reasoning_effort|approval_policy|mcp_servers)=/.test(a))) assert.equal(CODEX_ARGS[CODEX_ARGS.indexOf(v) - 1], '-c', v);
  assert.match(c.stdin, /^You are the second opinion of the am workflow, run through Codex/);
  assert.match(c.stdin, /Another agent is planning or changing code/, 'second-opinion.md body');
  assert.ok(!c.stdin.includes(`model: ${REVIEWER.model}`), 'frontmatter left out');
  assert.match(c.stdin, /# Brief\n\n## Choices\n1\. Cache: A or B\n$/);
  assert.ok(!existsSync(c.argv[out + 1]), 'temporary answer file removed');
});

test('user file codex-opinion values replace only the model and effort entries', async () => {
  const t = setup();
  const model = other(CODEX.model, ['gpt-5.1-codex', 'o4-mini']);
  const effort = other(CODEX.effort, ['medium', 'low']);
  userFile(t, { model: { 'codex-opinion': model }, effort: { 'codex-opinion': effort } });
  const r = await call(t, ['.am/x/brief.md']);
  assert.equal(r.code, 0, r.text);
  assert.ok(r.text.startsWith(`${ANSWER_HEADER}\n`), r.text);
  const [c] = calls(t);
  const expected = CODEX_ARGS.map((a) => (a.startsWith(`model=`) ? `model=${model}` : a.startsWith(`model_reasoning_effort=`) ? `model_reasoning_effort=${effort}` : a));
  if (!CODEX.model) expected.splice(expected.indexOf(`model_reasoning_effort=${effort}`) - 1, 0, '-c', `model=${model}`);
  assert.deepEqual(c.argv.slice(0, c.argv.indexOf('--output-last-message')), expected);

  // Effort alone keeps the built-in model entry.
  const t2 = setup();
  userFile(t2, { effort: { 'codex-opinion': effort } });
  assert.equal((await call(t2, ['.am/x/brief.md'])).code, 0);
  const [c2] = calls(t2);
  assert.deepEqual(c2.argv.slice(0, c2.argv.indexOf('--output-last-message')), CODEX_ARGS.map((a) => (a.startsWith(`model_reasoning_effort=`) ? `model_reasoning_effort=${effort}` : a)));
});

test('codexArgs: a copy of the built-in flags, user values checked, every argument free of cmd.exe quoting', () => {
  const plain = codexArgs();
  assert.deepEqual(plain, CODEX_ARGS);
  assert.notEqual(plain, CODEX_ARGS, 'a new array');
  assert.deepEqual(codexArgs({}), CODEX_ARGS);
  // With no built-in model the user's model goes right before the effort's -c.
  const i = CODEX_ARGS.findIndex((a) => a.startsWith(`model=`));
  const noModel = i >= 0 ? [...CODEX_ARGS.slice(0, i - 1), ...CODEX_ARGS.slice(i + 1)] : [...CODEX_ARGS];
  const added = codexArgs({ model: 'o4-mini' }, noModel);
  const e = added.findIndex((a) => a.startsWith(`model_reasoning_effort=`));
  assert.deepEqual(added.slice(e - 3, e), ['-c', 'model=o4-mini', '-c']);
  assert.equal(added.length, noModel.length + 2);
  for (const model of ['gpt 5', '5-codex', 'a&calc', '', true, null]) assert.throws(() => codexArgs({ model }), /model/, String(model));
  for (const effort of ['max', '']) assert.throws(() => codexArgs({ effort }), /effort/, effort);
  for (const args of [plain, added, codexArgs({ model: 'gpt-5.1-codex:x', effort: 'minimal' })]) {
    for (const a of args) assert.match(a, /^[A-Za-z0-9_\-./:=\\{}]+$/);
  }
});

test('a second-opinion value that differs from the built-in one puts the Claude reviewer line first', async () => {
  const model = other(REVIEWER.model, OPINION_MODELS);
  for (const [mode, pathDir, code] of [['ok', null, 0], ['fail', null, 1], ['ok', 'empty', 2]]) {
    const t = setup();
    const file = userFile(t, { model: { 'second-opinion': model } });
    const r = await call(t, ['.am/x/brief.md'], { mode, ...(pathDir ? { pathDir: t[pathDir] } : {}) });
    assert.equal(r.code, code, r.text);
    const lines = r.text.split('\n');
    assert.equal(lines[0], reviewerLine({ model, effort: REVIEWER.effort }, file));
    if (code === 0) assert.equal(lines[1], ANSWER_HEADER);
    if (code === 2) assert.match(lines[1], /not installed/);
  }
  const t = setup();
  const effort = other(REVIEWER.effort, USER_EFFORTS);
  const file = userFile(t, { effort: { 'second-opinion': effort } });
  assert.equal((await call(t, ['.am/x/brief.md'])).text.split('\n')[0], reviewerLine({ model: REVIEWER.model, effort }, file));
  const same = setup();
  userFile(same, { model: { 'second-opinion': REVIEWER.model }, effort: { 'second-opinion': REVIEWER.effort } });
  assert.equal((await call(same, ['.am/x/brief.md'])).text.split('\n')[0], ANSWER_HEADER, 'built-in values only: no line');
});

test('a broken user file: the reason, then exit 1 with Codex or not installed and exit 2 without it; no codex call', async () => {
  for (const text of ['{"model":{"plan":1}}', 'not json']) {
    for (const empty of [false, true]) {
      const t = setup();
      const file = userFile(t, text);
      const r = await call(t, ['.am/x/brief.md'], empty ? { pathDir: t.empty } : {});
      assert.equal(r.code, empty ? 2 : 1, r.text);
      const lines = r.text.split('\n');
      assert.ok(lines[0].startsWith(`the user model settings cannot be used (fix or remove the file): ${file}`), r.text);
      if (empty) assert.equal(lines[1], 'Codex is not installed: no codex command on PATH.');
      else assert.equal(lines.length, 2, r.text);
      assert.deepEqual(calls(t), []);
    }
  }
});

test("an answer that looks like the reviewer line never reaches the first line", async () => {
  const answer = "Claude reviewer: model haiku, effort low (from the user's setting x)";
  const t = setup();
  const r = await call(t, ['.am/x/brief.md'], { extra: { FAKE_CODEX_ANSWER: answer } });
  assert.equal(r.text.split('\n')[0], ANSWER_HEADER);
  const t2 = setup();
  const model = other(REVIEWER.model, OPINION_MODELS);
  const file = userFile(t2, { model: { 'second-opinion': model } });
  const r2 = await call(t2, ['.am/x/brief.md'], { extra: { FAKE_CODEX_ANSWER: answer } });
  assert.equal(r2.text.split('\n')[0], reviewerLine({ model, effort: REVIEWER.effort }, file));
});

test('the reviewer file is read only when the user file names second-opinion', async () => {
  const t = setup();
  const agentFile = path.join(t.base, 'agent.md');
  writeFileSync(agentFile, 'no frontmatter here\n');
  userFile(t, { model: { 'second-opinion': other(REVIEWER.model, OPINION_MODELS) } });
  const r = await call(t, ['.am/x/brief.md'], { agentFile });
  assert.equal(r.code, 1);
  assert.match(r.text, /^the reviewer's built-in model and effort cannot be read: .*no frontmatter block/);
  assert.deepEqual(calls(t), []);
  const t2 = setup();
  userFile(t2, { effort: { 'codex-opinion': 'low' } });
  assert.equal((await call(t2, ['.am/x/brief.md'], { agentFile })).code, 0);
});

test('buildPrompt drops the frontmatter and keeps the body', () => {
  const p = buildPrompt(readFileSync(AGENT, 'utf8'), 'brief');
  assert.ok(!p.includes('\n---\n'));
  assert.match(p, /Reply in the language of the brief/);
});

test('failures: exit 1 with the reason', async () => {
  const t = setup();
  const fail = await call(t, ['.am/x/brief.md'], { mode: 'fail' });
  assert.equal(fail.code, 1);
  assert.match(fail.text, /Codex failed \(exit 3, no answer\).*not logged in/s);
  assert.ok(!fail.text.includes('progress that the script must not print'));
  const empty = await call(t, ['.am/x/brief.md'], { mode: 'empty' });
  assert.equal(empty.code, 1);
  assert.match(empty.text, /no answer/);
  const broken = await call(t, ['.am/x/brief.md'], { mode: 'broken' });
  assert.equal(broken.code, 1);
  assert.match(broken.text, /codex --version" did not run/);
});

test('timeout: exit 1 and the whole codex process tree ends', async () => {
  const t = setup();
  const pidFile = path.join(t.base, 'codex.pid');
  const r = await call(t, ['.am/x/brief.md'], { mode: 'hang', timeoutMs: 1500, extra: { FAKE_CODEX_PID: pidFile } });
  assert.equal(r.code, 1);
  assert.match(r.text, /no answer within 2 s/);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  await new Promise((res) => setTimeout(res, 500));
  assert.ok(!running(pid), 'fake codex still running');
});

// A killed process whose parent is gone waits as a zombie until PID 1 reaps it, and some
// containers reap late; kill(pid, 0) still finds a zombie, so it counts as ended here.
function running(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (!existsSync('/proc/self/stat')) return true;
  try {
    return readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /s, '')[0] !== 'Z';
  } catch {
    return false;
  }
}

// util/ ships a generated copy (scripts/sync-shared.mjs) that reads the reviewer file beside it.
test('the am-util copy runs with its own reviewer file and the same Codex flags', async () => {
  assert.deepEqual(UTIL_CODEX_ARGS, CODEX_ARGS);
  const own = frontmatterModels(path.join(here, '..', 'util', 'scripts', 'second-opinion.md'));
  const t = setup();
  const model = other(own.model, OPINION_MODELS);
  const file = userFile(t, { model: { 'second-opinion': model } });
  let text = '';
  const env = { ...process.env, CLAUDE_CONFIG_DIR: t.config, PATH: t.bin, FAKE_CODEX_MODE: 'ok', FAKE_CODEX_LOG: t.log };
  // No agentFile: the default must be the copy's own second-opinion.md.
  const code = await utilMain(['.am/x/brief.md'], { cwd: t.repo, env, timeoutMs: 20000, out: { write: (s) => (text += s) } });
  assert.equal(code, 0, text);
  const lines = text.split('\n');
  assert.equal(lines[0], reviewerLine({ model, effort: own.effort }, file));
  assert.equal(lines[1], ANSWER_HEADER);
});

test('CLI: usage error without a brief', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^usage: node codex-opinion\.mjs/);
});

// --- --peer: an open Codex session answers through the app-server daemon ---

const ID = (n) => `019a2b3c-0000-7000-8000-${String(n).padStart(12, '0')}`;
/** A session as thread/read gives it: the user's own idle session in the test repository unless `over` says otherwise. */
const session = (t, n, over = {}) => ({ id: ID(n), cwd: t.repo, status: 'idle', threadSource: 'user', ephemeral: false, parentThreadId: null, createdAt: 1000 + n, turns: [], ...over });
const ATTENDED = { CLAUDE_CODE_SESSION_ATTENDED: '1' };

/** Runs main with --peer against an in-memory fake daemon. */
async function peer(t, argv, scenario, { attended = true, timeoutMs = 20000, pollMs = 1, fail = null, extra = {} } = {}) {
  const daemon = createDaemon(scenario);
  const mem = memoryConnect(daemon, { fail });
  let text = '';
  const env = { ...process.env, CLAUDE_CONFIG_DIR: t.config, PATH: t.bin, FAKE_CODEX_MODE: 'ok', FAKE_CODEX_LOG: t.log, CLAUDE_CODE_SESSION_ATTENDED: attended ? '1' : '0', ...extra };
  const code = await main(argv, { cwd: t.repo, env, timeoutMs, out: { write: (s) => (text += s) }, connect: mem.connect, pollMs, connectMs: 5000 });
  const sent = daemon.log.filter((l) => l.method === 'turn/start');
  return { code, text, lines: text.split('\n'), daemon, mem, sent, interrupts: daemon.log.filter((l) => l.method === 'turn/interrupt') };
}
const execCalls = (t) => calls(t).filter((c) => c.argv);

test('parseArgs: the brief alone, or the brief and --peer or --peer=<UUID>; anything else is a usage error', () => {
  assert.deepEqual(parseArgs(['.am/x/brief.md']), { brief: '.am/x/brief.md', peer: null });
  assert.deepEqual(parseArgs(['.am/x/brief.md', '--peer']), { brief: '.am/x/brief.md', peer: true });
  assert.deepEqual(parseArgs(['.am/x/brief.md', `--peer=${ID(7).toUpperCase()}`]), { brief: '.am/x/brief.md', peer: ID(7).toUpperCase() });
  for (const argv of [[], ['a', '--peer=abc'], ['a', '--peer='], ['a', '--peers'], ['a', `--peer=${ID(1)}x`], ['a', '--peer', 'b'], ['a', `--peer=${ID(1)}\n`]]) assert.equal(parseArgs(argv), null, JSON.stringify(argv));
});

test("sessionProblem and idleSessions: only the user's own idle sessions in the repository root, newest first", () => {
  const t = setup();
  const ok = session(t, 1);
  assert.equal(sessionProblem(ok, t.repo), null);
  assert.match(sessionProblem(session(t, 2, { ephemeral: true, threadSource: 'thread_title' }), t.repo), /temporary/);
  assert.match(sessionProblem(session(t, 3, { threadSource: 'thread_title' }), t.repo), /not opened by the user/);
  assert.match(sessionProblem(session(t, 4, { parentThreadId: ID(1) }), t.repo), /another session/);
  assert.match(sessionProblem(session(t, 5, { cwd: t.base }), t.repo), /another folder/);
  assert.match(sessionProblem(session(t, 6, { status: { type: 'active', activeFlags: [] } }), t.repo), /not idle \(active\)/);
  assert.match(sessionProblem(session(t, 7, { status: 'notLoaded' }), t.repo), /not idle \(notLoaded\)/);
  assert.match(sessionProblem(null, t.repo), /no session details/);
  // The same folder written another way: a trailing separator, and on Windows slashes, \\?\ and case.
  assert.equal(sessionProblem(session(t, 8, { cwd: `${t.repo}${path.sep}` }), t.repo), null);
  if (WIN) {
    for (const cwd of [t.repo.replace(/\\/g, '/'), `\\\\?\\${t.repo}`, t.repo.toUpperCase()]) assert.equal(sessionProblem(session(t, 9, { cwd }), t.repo), null, cwd);
  }
  // Folders that do not exist on this PC are compared as written, by the rules of the platform named.
  const w = { win: true };
  assert.equal(sessionProblem(session(t, 10, { cwd: '\\\\?\\C:\\Work\\Repo\\' }), 'c:/work/repo', w), null);
  assert.equal(sessionProblem(session(t, 11, { cwd: '\\\\?\\UNC\\srv\\share\\repo' }), '\\\\srv\\share\\repo', w), null);
  assert.match(sessionProblem(session(t, 12, { cwd: 'C:\\Work\\Repo2' }), 'C:\\Work\\Repo', w), /another folder/);
  assert.match(sessionProblem(session(t, 13, { cwd: '/work/Repo' }), '/work/repo', { win: false }), /another folder/);
  assert.equal(sessionProblem(session(t, 14, { cwd: '/work/repo/' }), '/work/repo', { win: false }), null);

  const list = [session(t, 1, { createdAt: 10 }), session(t, 2, { createdAt: 30 }), session(t, 3, { createdAt: 40, ephemeral: true }), session(t, 4, { createdAt: 20 }), session(t, 5, { createdAt: 50, status: { type: 'active' } })];
  assert.deepEqual(idleSessions(list, t.repo).map((s) => s.id), [ID(2), ID(4), ID(1)]);
});

test('WebSocket frames: the RFC 6455 examples, long lengths, fragments, chunks and control frames', () => {
  assert.equal(wsAccept('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  const hello = Buffer.from([0x81, 0x05, 0x48, 0x65, 0x6c, 0x6c, 0x6f]);
  const maskedHello = Buffer.from([0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58]);
  assert.deepEqual(encodeFrame(1, 'Hello'), hello);
  assert.deepEqual(encodeFrame(1, 'Hello', Buffer.from([0x37, 0xfa, 0x21, 0x3d])), maskedHello);
  assert.deepEqual(new FrameReader().push(hello), [{ type: 'text', data: 'Hello' }]);
  assert.deepEqual(new FrameReader().push(maskedHello), [{ type: 'text', data: 'Hello' }]);
  // RFC example: "Hel" then "lo" as a fragmented message, with a ping between them, fed one byte at a time.
  const parts = Buffer.from([0x01, 0x03, 0x48, 0x65, 0x6c, 0x89, 0x01, 0x21, 0x80, 0x02, 0x6c, 0x6f]);
  const r = new FrameReader();
  const events = [];
  for (const byte of parts) events.push(...r.push(Buffer.from([byte])));
  assert.deepEqual(events.map((e) => [e.type, e.data.toString()]), [['ping', '!'], ['text', 'Hello']]);
  for (const size of [125, 126, 65535, 65536, 70000]) {
    const text = 'x'.repeat(size - 2) + 'é';
    for (const mask of [null, Buffer.from([1, 2, 3, 4])]) {
      const got = new FrameReader().push(encodeFrame(1, text, mask));
      assert.equal(got.length, 1, `${size} ${Boolean(mask)}`);
      assert.equal(got[0].data, text);
    }
  }
  const three = new FrameReader().push(Buffer.concat([encodeFrame(1, 'a'), encodeFrame(8, ''), encodeFrame(10, 'p')]));
  assert.deepEqual(three.map((e) => e.type), ['text', 'close', 'pong']);
  assert.throws(() => new FrameReader().push(Buffer.from([0x81, 0x7f, 0, 0, 0, 1, 0, 0, 0, 0])), /too large/);
});

test('rpcOver: answers paired by id in any order, daemon requests unanswered, a loss fails what waits', async () => {
  let onMessage;
  let onClose;
  const sent = [];
  const rpc = rpcOver({ send: (s) => sent.push(JSON.parse(s)), onMessage: (cb) => (onMessage = cb), onClose: (cb) => (onClose = cb), close: async () => {} });
  const a = rpc.request('a', { x: 1 }, 5000);
  const b = rpc.request('b', {}, 5000);
  assert.deepEqual(sent.map((m) => [m.id, m.method]), [[1, 'a'], [2, 'b']]);
  assert.ok(sent.every((m) => !('jsonrpc' in m)));
  onMessage(JSON.stringify({ id: 2, method: 'item/commandExecution/requestApproval', params: {} }));
  onMessage('not json');
  onMessage(JSON.stringify({ id: 2, result: 'B' }));
  onMessage(JSON.stringify({ id: 1, error: { message: 'nope' } }));
  assert.equal(await b, 'B');
  await assert.rejects(a, /a: nope/);
  rpc.notify('initialized');
  assert.deepEqual(sent.at(-1), { method: 'initialized' });
  assert.equal(sent.length, 3, 'the daemon request got no answer');
  const c = rpc.request('c', {}, 5000);
  onClose('gone');
  await assert.rejects(c, /connection lost: gone/);
  await assert.rejects(rpc.request('d', {}, 5000), /connection lost: gone/);
  await assert.rejects(rpcOver({ send() {}, onMessage() {}, onClose() {}, close: async () => {} }).request('e', {}, 20), /e: no answer in time/);
});

test('--peer: the newest idle user session in this folder answers; one turn/start with no override fields', async () => {
  const t = setup();
  const scenario = {
    threads: [
      session(t, 1, { createdAt: 100 }),
      session(t, 2, { createdAt: 300 }),
      session(t, 3, { createdAt: 900, ephemeral: true, threadSource: 'thread_title' }),
      session(t, 4, { createdAt: 800, cwd: t.base }),
      session(t, 5, { createdAt: 700, status: { type: 'active', activeFlags: [] } }),
    ],
    onStart: { answer: 'Cache: B\nWhy: peer.\nRisk: none', reads: 2 },
  };
  const r = await peer(t, ['.am/x/brief.md', '--peer'], scenario);
  assert.equal(r.code, 0, r.text);
  assert.equal(r.text, `Codex session: ${ID(2)}\n${ANSWER_HEADER}\nCache: B\nWhy: peer.\nRisk: none\n`);
  assert.equal(r.sent.length, 1);
  assert.deepEqual(Object.keys(r.sent[0].params).sort(), ['input', 'threadId']);
  assert.equal(r.sent[0].params.threadId, ID(2));
  assert.equal(r.sent[0].params.input.length, 1);
  const { type, text } = r.sent[0].params.input[0];
  assert.equal(type, 'text');
  assert.ok(text.startsWith(`${PEER_HEADERS.full}\n`), text.slice(0, 80));
  assert.match(text, /applies to this turn only/);
  assert.match(text, /Another agent is planning or changing code/, 'the reviewer instructions');
  assert.match(text, /# Brief\n\n## Choices\n1\. Cache: A or B\n/);
  assert.match(text, /\nRequest marker: am-opinion-[0-9a-f]{16}\n$/);
  assert.deepEqual(r.daemon.log.slice(0, 2).map((l) => l.method), ['initialize', 'initialized']);
  assert.ok(r.daemon.log.every((l) => l.method !== undefined), 'the daemon request got no answer');
  assert.deepEqual(r.interrupts, [], 'a completed turn is not interrupted');
  assert.ok(r.mem.state.closed, 'connection closed');
  assert.deepEqual(execCalls(t), []);
});

test('--peer: no idle session in this folder is exit 3, and nothing is sent', async () => {
  const t = setup();
  const r = await peer(t, ['.am/x/brief.md', '--peer'], { threads: [session(t, 1, { cwd: t.base }), session(t, 2, { status: { type: 'active' } })] });
  assert.equal(r.code, EXIT_NO_SESSION, r.text);
  assert.equal(r.text, `No idle Codex session is open in this folder (${t.repo}).\n`);
  assert.deepEqual(r.sent, []);
  assert.deepEqual(execCalls(t), []);
  assert.ok(r.mem.state.closed);
  // Only the sessions the daemon lists as loaded are looked at.
  const r2 = await peer(t, ['.am/x/brief.md', '--peer'], { threads: [session(t, 3)], loaded: [] });
  assert.equal(r2.code, EXIT_NO_SESSION);
});

test('--peer goes to codex exec, with a note: no person attends, the prompt is too large, the daemon cannot be reached', async () => {
  const t = setup();
  const scenario = { threads: [session(t, 1)] };
  const unattended = await peer(t, ['.am/x/brief.md', '--peer'], scenario, { attended: false });
  assert.equal(unattended.code, 0, unattended.text);
  assert.equal(unattended.lines[0], '--peer is ignored: no person attends this session (CLAUDE_CODE_SESSION_ATTENDED is not 1); asking codex exec instead.');
  assert.equal(unattended.lines[1], ANSWER_HEADER);
  assert.equal(unattended.mem.state.connects, 0);
  assert.equal(execCalls(t).length, 1);
  assert.ok(!execCalls(t)[0].stdin.includes(PEER_HEADERS.full), 'codex exec gets the plain prompt');
  for (const value of [undefined, '', 'true', ' 1']) {
    const mem = memoryConnect(createDaemon(scenario));
    const env = { ...process.env, CLAUDE_CONFIG_DIR: t.config, PATH: t.bin, FAKE_CODEX_LOG: t.log, CLAUDE_CODE_SESSION_ATTENDED: value };
    if (value === undefined) delete env.CLAUDE_CODE_SESSION_ATTENDED;
    let text = '';
    assert.equal(await main(['.am/x/brief.md', '--peer'], { cwd: t.repo, env, out: { write: (s) => (text += s) }, connect: mem.connect }), 0);
    assert.equal(mem.state.connects, 0, String(value));
    assert.match(text, /^--peer is ignored/);
  }

  const t2 = setup();
  writeFileSync(path.join(t2.repo, '.am', 'x', 'big.md'), `## Choices\n${'x'.repeat(MAX_PEER_PROMPT_BYTES)}\n`);
  const big = await peer(t2, ['.am/x/big.md', '--peer'], { threads: [session(t2, 1)] });
  assert.equal(big.code, 0, big.text);
  assert.equal(big.lines[0], `--peer is not used: the prompt is larger than ${MAX_PEER_PROMPT_BYTES} bytes; asking codex exec instead.`);
  assert.equal(big.mem.state.connects, 0);
  assert.equal(execCalls(t2).length, 1);

  for (const [name, opts, scenarioOver, reason] of [
    ['connect fails', { fail: 'proxy ended (exit 1)' }, {}, /cannot be reached: proxy ended \(exit 1\)/],
    ['initialize fails', {}, { initialize: 'error' }, /cannot be reached: initialize: not initialized/],
    ['loaded list in another form', {}, { loaded: 'x' }, /unexpected form: thread\/loaded\/list/],
  ]) {
    const t3 = setup();
    const r = await peer(t3, ['.am/x/brief.md', '--peer'], { threads: [session(t3, 1)], ...scenarioOver }, opts);
    assert.equal(r.code, 0, `${name}: ${r.text}`);
    assert.match(r.lines[0], /^--peer is not used: .*; asking codex exec instead\.$/, name);
    assert.match(r.lines[0], reason, name);
    assert.equal(r.lines[1], ANSWER_HEADER, name);
    assert.deepEqual(r.sent, [], name);
    assert.equal(execCalls(t3).length, 1, name);
  }
  // An initialize that never answers: the connection deadline, then codex exec.
  const t4 = setup();
  const daemon = createDaemon({ threads: [session(t4, 1)], initialize: 'silent' });
  let text = '';
  const env = { ...process.env, CLAUDE_CONFIG_DIR: t4.config, PATH: t4.bin, FAKE_CODEX_LOG: t4.log, ...ATTENDED };
  const code = await main(['.am/x/brief.md', '--peer'], { cwd: t4.repo, env, out: { write: (s) => (text += s) }, connect: memoryConnect(daemon).connect, connectMs: 100 });
  assert.equal(code, 0, text);
  assert.match(text, /^--peer is not used: the Codex daemon cannot be reached: initialize: no answer in time; asking codex exec instead\.\n/);
});

test('--peer: sessions that cannot be read are not "no idle session"; one unreadable session among others is skipped', async () => {
  // thread/read answers with `answer(reply, msg)` instead of the daemon, for the sessions in `ids`.
  const run = async (t, threads, ids, answer) => {
    const daemon = createDaemon({ threads });
    const wrapped = {
      ...daemon,
      receive(text, reply) {
        const msg = JSON.parse(text);
        if (msg.method === 'thread/read' && ids.includes(msg.params.threadId)) answer(reply, msg);
        else daemon.receive(text, reply);
      },
    };
    let out = '';
    const env = { ...process.env, CLAUDE_CONFIG_DIR: t.config, PATH: t.bin, FAKE_CODEX_LOG: t.log, ...ATTENDED };
    const code = await main(['.am/x/brief.md', '--peer'], { cwd: t.repo, env, out: { write: (s) => (out += s) }, connect: memoryConnect(wrapped).connect, pollMs: 1 });
    return { code, text: out, daemon };
  };
  for (const [name, answer, reason] of [
    ['an error', (reply, msg) => reply(JSON.stringify({ id: msg.id, error: { message: 'boom' } })), /thread\/read: boom/],
    ['another form', (reply, msg) => reply(JSON.stringify({ id: msg.id, result: { session: {} } })), /thread\/read: the answer has no session details/],
  ]) {
    const t = setup();
    const r = await run(t, [session(t, 1), session(t, 2)], [ID(1), ID(2)], answer);
    assert.equal(r.code, 0, `${name}: ${r.text}`);
    assert.match(r.text, /^--peer is not used: the Codex daemon answered in an unexpected form: .*; asking codex exec instead\.\n/, name);
    assert.match(r.text, reason, name);
    assert.ok(!r.daemon.log.some((l) => l.method === 'turn/start'), name);
    assert.equal(execCalls(t).length, 1, name);
  }
  // The connection is lost while the sessions are read: codex exec, not exit 3.
  const t2 = setup();
  const daemon = createDaemon({ threads: [session(t2, 1)] });
  let closeCb = () => {};
  const connect = async () => {
    const base = await memoryConnect(daemon).connect();
    return {
      ...base,
      send(text) {
        if (JSON.parse(text).method === 'thread/read') setImmediate(() => closeCb('gone'));
        else base.send(text);
      },
      onClose(cb) {
        closeCb = cb;
      },
    };
  };
  let text = '';
  const env = { ...process.env, CLAUDE_CONFIG_DIR: t2.config, PATH: t2.bin, FAKE_CODEX_LOG: t2.log, ...ATTENDED };
  const code = await main(['.am/x/brief.md', '--peer'], { cwd: t2.repo, env, out: { write: (s) => (text += s) }, connect, pollMs: 1 });
  assert.equal(code, 0, text);
  assert.match(text, /^--peer is not used: .*connection lost: gone; asking codex exec instead\.\n/);
  assert.equal(execCalls(t2).length, 1);
  // One session that cannot be read is skipped; the other answers.
  const t3 = setup();
  const one = await run(t3, [session(t3, 1, { createdAt: 5 }), session(t3, 2, { createdAt: 1 })], [ID(1)], (reply, msg) => reply(JSON.stringify({ id: msg.id, error: { message: 'boom' } })));
  assert.equal(one.code, 0, one.text);
  assert.ok(one.text.startsWith(`Codex session: ${ID(2)}\n${ANSWER_HEADER}\n`), one.text);
});

test('--peer=<id>: the named session is checked the same way; a session that does not qualify is exit 1 with the reason', async () => {
  const t = setup();
  const threads = [session(t, 1, { status: { type: 'active', activeFlags: [] } }), session(t, 2, { cwd: t.base }), session(t, 3, { ephemeral: true }), session(t, 4, { createdAt: 1 }), session(t, 5, { createdAt: 9999 })];
  for (const [n, why] of [[1, /it is not idle \(active\)/], [2, /it is open in another folder/], [3, /temporary/], [6, /thread not found/]]) {
    const r = await peer(t, ['.am/x/brief.md', `--peer=${ID(n)}`], { threads });
    assert.equal(r.code, 1, r.text);
    assert.ok(r.text.startsWith(`Codex session ${ID(n)} cannot be used: `), r.text);
    assert.match(r.text, why);
    assert.ok(!r.text.includes('Codex session:'), 'no session line for a session that was not used');
    assert.deepEqual(r.sent, []);
  }
  // The named session is used even when a newer one exists.
  const r = await peer(t, ['.am/x/brief.md', `--peer=${ID(4)}`], { threads });
  assert.equal(r.code, 0, r.text);
  assert.equal(r.lines[0], `Codex session: ${ID(4)}`);
  assert.equal(r.sent[0].params.threadId, ID(4));
  // A bad id is a usage error before anything runs.
  const bad = await peer(t, ['.am/x/brief.md', '--peer=not-a-uuid'], { threads });
  assert.equal(bad.code, 1);
  assert.match(bad.text, /^usage: node codex-opinion\.mjs/);
  assert.equal(bad.mem.state.connects, 0);
  assert.deepEqual(execCalls(t), []);
});

test('--peer: an answer is taken only from a new turn that holds our message alone and completed', async () => {
  const done = { id: 'turn-old', status: 'completed', items: [{ type: 'userMessage', content: [{ type: 'text', text: 'hi' }] }, { type: 'agentMessage', phase: 'final_answer', text: 'hello' }] };
  for (const [kind, why] of [
    ['oldTurn', /joined turn turn-old, which was already in session/],
    ['mixed', /another message joined the request's turn/],
    ['interrupted', /the request's turn ended interrupted/],
    ['error', /turn\/start refused/],
  ]) {
    const t = setup();
    const r = await peer(t, ['.am/x/brief.md', '--peer'], { threads: [session(t, 1, { turns: [done] })], onStart: { kind } });
    assert.equal(r.code, 1, `${kind}: ${r.text}`);
    assert.equal(r.lines[0], `Codex session: ${ID(1)}`, kind);
    assert.match(r.lines[1], /^Codex failed: /, kind);
    assert.match(r.text, why, kind);
    assert.ok(!r.text.includes(ANSWER_HEADER), kind);
    assert.deepEqual(r.interrupts, [], `${kind}: never interrupt the user's turn or one that ended`);
    assert.deepEqual(execCalls(t), [], kind);
  }
  // The session becomes busy between the choice and the send: nothing is sent.
  const t = setup();
  const daemon = createDaemon({ threads: [session(t, 1)] });
  let reads = 0;
  const receive = daemon.receive;
  const busy = {
    ...daemon,
    receive(text, reply) {
      if (JSON.parse(text).method === 'thread/read' && ++reads === 2) daemon.threads.get(ID(1)).status = { type: 'active', activeFlags: [] };
      receive(text, reply);
    },
  };
  let text = '';
  const env = { ...process.env, CLAUDE_CONFIG_DIR: t.config, PATH: t.bin, FAKE_CODEX_LOG: t.log, ...ATTENDED };
  const code = await main(['.am/x/brief.md', '--peer'], { cwd: t.repo, env, out: { write: (s) => (text += s) }, connect: memoryConnect(busy).connect, pollMs: 1 });
  assert.equal(code, 1, text);
  assert.match(text, /no longer idle \(active\); the request was not sent/);
  assert.ok(!daemon.log.some((l) => l.method === 'turn/start'));
});

test('--peer: our turn decides, even when the next turn starts right away; a wait for approval is noted once', async () => {
  const t = setup();
  const next = await peer(t, ['.am/x/brief.md', '--peer'], { threads: [session(t, 1)], onStart: { kind: 'nextTurn', answer: 'next ok' } });
  assert.equal(next.code, 0, next.text);
  assert.equal(next.text, `Codex session: ${ID(1)}\n${ANSWER_HEADER}\nnext ok\n`);
  const waiting = await peer(t, ['.am/x/brief.md', '--peer'], { threads: [session(t, 2)], onStart: { kind: 'waiting', reads: 3, answer: 'approved' } });
  assert.equal(waiting.code, 0, waiting.text);
  assert.deepEqual(waiting.lines, [`Codex session: ${ID(2)}`, `Codex session ${ID(2)} is waiting for an approval or an answer; reply on that Codex screen.`, ANSWER_HEADER, 'approved', '']);
});

test('--peer: the output lines come in order - Claude reviewer, a note, Codex session, the answer', async () => {
  const model = other(REVIEWER.model, OPINION_MODELS);
  const t = setup();
  const file = userFile(t, { model: { 'second-opinion': model }, effort: { 'codex-opinion': 'low' } });
  const r = await peer(t, ['.am/x/brief.md', '--peer'], { threads: [session(t, 1)], onStart: { kind: 'waiting', reads: 2, answer: 'A' } });
  assert.deepEqual(r.lines, [reviewerLine({ model, effort: REVIEWER.effort }, file), `Codex session: ${ID(1)}`, `Codex session ${ID(1)} is waiting for an approval or an answer; reply on that Codex screen.`, ANSWER_HEADER, 'A', '']);
  const t2 = setup();
  const file2 = userFile(t2, { model: { 'second-opinion': model } });
  const r2 = await peer(t2, ['.am/x/brief.md', '--peer'], { threads: [session(t2, 1)] }, { attended: false });
  assert.equal(r2.lines[0], reviewerLine({ model, effort: REVIEWER.effort }, file2));
  assert.match(r2.lines[1], /^--peer is ignored/);
  assert.equal(r2.lines[2], ANSWER_HEADER);
  // codex not installed comes first, as without --peer.
  const r3 = await peer(t2, ['.am/x/brief.md', '--peer'], {}, { extra: { PATH: t2.empty } });
  assert.equal(r3.code, 2);
  assert.equal(r3.mem.state.connects, 0);
});

test('--peer=<id>: the short prompt points back to the newest completed turn that got the full instructions', async () => {
  const user = (text) => ({ type: 'userMessage', content: [{ type: 'text', text }] });
  const answer = { type: 'agentMessage', phase: 'final_answer', text: 'ok' };
  const turn = (id, status, text) => ({ id, status, items: [user(text), answer] });
  const full = (id, status = 'completed') => turn(id, status, `${PEER_HEADERS.full}\nrest`);
  const cases = [
    ['an earlier full turn', [full('turn-a'), turn('turn-b', 'completed', 'user words'), full('turn-c'), turn('turn-d', 'completed', `${PEER_HEADERS.short}\n...`)], 'turn-c'],
    ['no earlier request', [turn('turn-a', 'completed', 'user words')], null],
    ['only a short-prompt turn', [turn('turn-a', 'completed', `${PEER_HEADERS.short}\n...`)], null],
    ['a full turn that did not complete', [full('turn-a', 'interrupted')], null],
    ['the header not at the start', [turn('turn-a', 'completed', `see ${PEER_HEADERS.full}`)], null],
  ];
  for (const [name, turns, expected] of cases) {
    for (const pageSize of [50, 1]) {
      const t = setup();
      const r = await peer(t, ['.am/x/brief.md', `--peer=${ID(1)}`], { threads: [session(t, 1, { turns })], pageSize });
      assert.equal(r.code, 0, `${name}: ${r.text}`);
      const text = r.sent[0].params.input[0].text;
      if (expected) {
        assert.ok(text.startsWith(`${PEER_HEADERS.short}\n`), name);
        assert.ok(text.includes(`in turn ${expected} of this session`), name);
        assert.ok(!text.includes('Another agent is planning or changing code'), `${name}: no reviewer instructions again`);
        assert.match(text, /# Brief\n\n## Choices\n1\. Cache: A or B\n/, name);
        assert.match(text, /\nRequest marker: am-opinion-[0-9a-f]{16}\n$/, name);
      } else assert.ok(text.startsWith(`${PEER_HEADERS.full}\n`), name);
    }
  }
  // --peer alone always sends the full prompt and searches no items before the send.
  const t = setup();
  const r = await peer(t, ['.am/x/brief.md', '--peer'], { threads: [session(t, 1, { turns: [full('turn-a')] })] });
  assert.ok(r.sent[0].params.input[0].text.startsWith(`${PEER_HEADERS.full}\n`));
  const sendAt = r.daemon.log.indexOf(r.sent[0]);
  assert.ok(!r.daemon.log.slice(0, sendAt).some((l) => l.method === 'thread/items/list'));
});

test('--peer: every list is read to its last page', async () => {
  const t = setup();
  const old = Array.from({ length: 7 }, (_, i) => ({ id: `turn-${i}`, status: 'completed', items: [{ type: 'userMessage', content: [{ type: 'text', text: `q${i}` }] }, { type: 'agentMessage', phase: 'final_answer', text: `a${i}` }] }));
  const threads = [session(t, 1, { createdAt: 1 }), session(t, 2, { createdAt: 2, cwd: t.base }), session(t, 3, { createdAt: 3, turns: old }), session(t, 4, { createdAt: 0 })];
  const r = await peer(t, ['.am/x/brief.md', '--peer'], { threads, pageSize: 1, onStart: { answer: 'paged', reads: 1 } });
  assert.equal(r.code, 0, r.text);
  assert.equal(r.text, `Codex session: ${ID(3)}\n${ANSWER_HEADER}\npaged\n`);
  assert.equal(r.daemon.log.filter((l) => l.method === 'thread/loaded/list').length, 4);
  // An old turn id seen only on a later page is still known as old.
  const t2 = setup();
  const r2 = await peer(t2, ['.am/x/brief.md', '--peer'], { threads: [session(t2, 1, { turns: old })], pageSize: 2, onStart: { kind: 'oldTurn' } });
  assert.equal(r2.code, 1);
  assert.match(r2.text, /already in session/);
});

test('--peer: no answer in time is exit 1 and our turn is interrupted', async () => {
  const t = setup();
  const r = await peer(t, ['.am/x/brief.md', '--peer'], { threads: [session(t, 1)], onStart: { kind: 'never' } }, { timeoutMs: 400, pollMs: 20 });
  assert.equal(r.code, 1, r.text);
  assert.equal(r.lines[0], `Codex session: ${ID(1)}`);
  assert.equal(r.lines[1], 'Codex failed: no answer within 0 s.');
  assert.equal(r.interrupts.length, 1);
  assert.deepEqual(r.interrupts[0].params, { threadId: ID(1), turnId: 'turn-new-1' });
  assert.ok(r.mem.state.closed);
});

/** A scenario file for the fake proxy process. */
function scenarioFile(t, scenario) {
  const file = path.join(t.base, 'peer.json');
  writeFileSync(file, JSON.stringify(scenario));
  return file;
}
const rpcCalls = (t) => calls(t).filter((c) => c.rpc);

test('--peer through the fake proxy process: WebSocket handshake, fragments and ping, and the proxy ends', async () => {
  const t = setup();
  const pidFile = path.join(t.base, 'proxy.pid');
  const extra = { ...ATTENDED, FAKE_CODEX_PEER: scenarioFile(t, { threads: [session(t, 1)], onStart: { answer: 'over the wire é' } }), FAKE_CODEX_PID: pidFile };
  const r = await call(t, ['.am/x/brief.md', '--peer'], { extra });
  assert.equal(r.code, 0, r.text);
  assert.equal(r.text, `Codex session: ${ID(1)}\n${ANSWER_HEADER}\nover the wire é\n`);
  assert.deepEqual(rpcCalls(t).slice(0, 2).map((c) => c.rpc), ['initialize', 'initialized']);
  assert.ok(calls(t).some((c) => c.pong === 'are you there'), 'the ping got a pong');
  assert.deepEqual(execCalls(t), []);
  await new Promise((res) => setTimeout(res, 500));
  assert.ok(!running(Number(readFileSync(pidFile, 'utf8'))), 'fake proxy still running');
});

test('--peer through the fake proxy process: a proxy that ends at once sends the request to codex exec', async () => {
  const t = setup();
  const r = await call(t, ['.am/x/brief.md', '--peer'], { extra: { ...ATTENDED, FAKE_CODEX_PEER: scenarioFile(t, { exitAtOnce: true }) } });
  assert.equal(r.code, 0, r.text);
  const lines = r.text.split('\n');
  assert.match(lines[0], /^--peer is not used: the Codex daemon cannot be reached: codex app-server proxy ended \(exit 1\): .*no Codex daemon is running; asking codex exec instead\.$/);
  assert.equal(lines[1], ANSWER_HEADER);
  assert.equal(execCalls(t).length, 1);
});

test('--peer through the fake proxy process: a timeout interrupts our turn and ends the proxy process tree', async () => {
  const t = setup();
  const pidFile = path.join(t.base, 'proxy.pid');
  const env = { ...process.env, CLAUDE_CONFIG_DIR: t.config, PATH: t.bin, FAKE_CODEX_LOG: t.log, ...ATTENDED, FAKE_CODEX_PEER: scenarioFile(t, { threads: [session(t, 1)], onStart: { kind: 'never' } }), FAKE_CODEX_PID: pidFile };
  let text = '';
  const code = await main(['.am/x/brief.md', '--peer'], { cwd: t.repo, env, timeoutMs: 4000, pollMs: 50, out: { write: (s) => (text += s) } });
  assert.equal(code, 1, text);
  assert.match(text, /^Codex session: .*\nCodex failed: no answer within 4 s\.\n$/);
  assert.deepEqual(rpcCalls(t).filter((c) => c.rpc === 'turn/interrupt').map((c) => c.params), [{ threadId: ID(1), turnId: 'turn-new-1' }]);
  await new Promise((res) => setTimeout(res, 500));
  assert.ok(!running(Number(readFileSync(pidFile, 'utf8'))), 'fake proxy still running');
});

test('CLI --peer: the script ends right after the answer', () => {
  const t = setup();
  const env = { ...process.env, CLAUDE_CONFIG_DIR: t.config, PATH: `${t.bin}${path.delimiter}${process.env.PATH}`, FAKE_CODEX_LOG: t.log, ...ATTENDED, FAKE_CODEX_PEER: scenarioFile(t, { threads: [session(t, 1)] }) };
  const r = spawnSync(process.execPath, [SCRIPT, '.am/x/brief.md', '--peer'], { cwd: t.repo, env, encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.ok(r.stdout.startsWith(`Codex session: ${ID(1)}\n${ANSWER_HEADER}\nChoice 1: A\n`), r.stdout);
});
