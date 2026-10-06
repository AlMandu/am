// Run: node --test tests/codex-opinion.test.mjs
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODEX_ARGS, MAX_BRIEF_BYTES, buildPrompt, checkBrief, main } from '../plugin/scripts/codex-opinion.mjs';
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
  return { base, repo, bin, empty, log: path.join(base, 'calls.jsonl') };
}

async function call(t, argv, { mode = 'ok', pathDir = t.bin, timeoutMs = 20000, extra = {} } = {}) {
  let text = '';
  const env = { ...process.env, PATH: pathDir, FAKE_CODEX_MODE: mode, FAKE_CODEX_LOG: t.log, ...extra };
  const code = await main(argv, { cwd: t.repo, env, timeoutMs, out: { write: (s) => (text += s) } });
  return { code, text };
}
const calls = (t) => (existsSync(t.log) ? readFileSync(t.log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);

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
  assert.equal(r.text, 'Cache: B\nWhy: fewer writes.\nRisk: none\n');
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
