// Run: node --test tests/codex-opinion.test.mjs
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANSWER_HEADER, CODEX_ARGS, MAX_BRIEF_BYTES, buildPrompt, checkBrief, codexArgs, main, reviewerLine } from '../plugin/scripts/codex-opinion.mjs';
import { OPINION_MODELS, USER_EFFORTS } from '../plugin/scripts/user-models.mjs';
import { load } from '../scripts/models.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, '..', 'plugin', 'scripts', 'codex-opinion.mjs');
const AGENT = path.join(here, '..', 'plugin', 'agents', 'second-opinion.md');
const FAKE = path.join(here, 'fake-codex.mjs');
const WIN = process.platform === 'win32';
// Codex model and effort come from models.json at the repository root (scripts/models.mjs writes them into CODEX_ARGS).
const MODELS = load().am;
const CODEX = MODELS['codex-opinion'];

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
const REVIEWER = MODELS['second-opinion'];

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
  assert.match(c.stdin, /^You are the second opinion of the am workflow, run through Codex/);
  assert.match(c.stdin, /Another agent is planning or changing code/, 'second-opinion.md body');
  assert.ok(!c.stdin.includes(`model: ${MODELS['second-opinion'].model}`), 'frontmatter left out');
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

test('a broken user file: exit 1 with the reason and no codex call, even without Codex', async () => {
  for (const text of ['{"model":{"plan":1}}', 'not json']) {
    for (const empty of [false, true]) {
      const t = setup();
      const file = userFile(t, text);
      const r = await call(t, ['.am/x/brief.md'], empty ? { pathDir: t.empty } : {});
      assert.equal(r.code, 1, r.text);
      assert.ok(r.text.startsWith(`the user model settings cannot be used (fix or remove the file): ${file}`), r.text);
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
  assert.throws(() => process.kill(pid, 0), 'fake codex still running');
});

test('CLI: usage error without a brief', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^usage: node codex-opinion\.mjs/);
});
