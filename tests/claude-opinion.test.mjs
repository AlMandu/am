// Run: node --test tests/claude-opinion.test.mjs
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANSWER_HEADER, CONTRARIAN, buildPrompt, checkBrief, claudeArgs, main, parseArgs, reviewerName } from '../plugin/scripts/claude-opinion.mjs';
import { MAX_BRIEF_BYTES, checkBrief as codexCheckBrief } from '../plugin/scripts/codex-opinion.mjs';
import { EMPTY_MCP_CONFIG } from '../plugin/scripts/stage.mjs';
import { FRONTMATTER, OPINION_MODELS, USER_EFFORTS, frontmatterModels } from '../plugin/scripts/user-models.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, '..', 'plugin', 'scripts', 'claude-opinion.mjs');
const AGENT = path.join(here, '..', 'plugin', 'agents', 'second-opinion.md');
const FAKE = path.join(here, 'fake-claude.mjs');
const WIN = process.platform === 'win32';
const REVIEWER = frontmatterModels(AGENT);
const BODY = readFileSync(AGENT, 'utf8').replace(FRONTMATTER, '').trim();

const bases = [];
after(() => {
  for (const base of bases) rmSync(base, { recursive: true, force: true });
});

/** A repository folder with .am/x/brief.md, a folder with a fake claude, and an empty folder. */
function setup() {
  const base = mkdtempSync(path.join(tmpdir(), 'am-claude-test-'));
  bases.push(base);
  const repo = path.join(base, 'repo');
  mkdirSync(path.join(repo, '.am', 'x'), { recursive: true });
  writeFileSync(path.join(repo, '.am', 'x', 'brief.md'), '## Choices\n1. Cache: A or B\n');
  const bin = path.join(base, 'bin');
  mkdirSync(bin);
  if (WIN) writeFileSync(path.join(bin, 'claude.cmd'), `@"${process.execPath}" "${FAKE}" %*\r\n`);
  else {
    // No exec: sh stays the parent of node, so a timeout has a process tree to end.
    writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\n"${process.execPath}" "${FAKE}" "$@"\n`);
    chmodSync(path.join(bin, 'claude'), 0o755);
  }
  const empty = path.join(base, 'empty');
  mkdirSync(empty);
  return { base, repo, bin, empty, log: path.join(base, 'calls.jsonl'), config: path.join(base, 'config') };
}

// CLAUDE_CONFIG_DIR points at the test's own folder, so the user's real models file is never read.
async function call(t, argv, { mode = 'ok', pathDir = t.bin, timeoutMs = 20000, killGraceMs, extra = {}, agentFile } = {}) {
  let text = '';
  const env = { ...process.env, CLAUDE_CONFIG_DIR: t.config, PATH: pathDir, FAKE_CLAUDE_OPINION: mode, FAKE_CLAUDE_OPINION_LOG: t.log };
  delete env.AM_HANDOVER_OWNER; // only a test that sets it sees it
  Object.assign(env, extra);
  const opts = { cwd: t.repo, env, timeoutMs, out: { write: (s) => (text += s) } };
  if (killGraceMs !== undefined) opts.killGraceMs = killGraceMs;
  if (agentFile) opts.agentFile = agentFile;
  const code = await main(argv, opts);
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
const BRIEF = '.am/x/brief.md';

test('answer: the fixed read-only flags on the reviewer frontmatter values, an empty MCP config, prompt on stdin', async () => {
  const t = setup();
  const r = await call(t, [BRIEF], { extra: { FAKE_CLAUDE_ANSWER: 'Cache: B\nWhy: fewer writes.\nRisk: none' } });
  assert.equal(r.code, 0, r.text);
  assert.equal(r.text, `${ANSWER_HEADER}\nCache: B\nWhy: fewer writes.\nRisk: none\n`, 'stderr progress stays out');
  const [c] = calls(t);
  const mcpFile = c.argv[c.argv.indexOf('--mcp-config') + 1];
  assert.deepEqual(c.argv, claudeArgs(mcpFile, REVIEWER));
  for (const flag of ['--plugin-dir', '--output-format', '--allowedTools', '--dangerously-skip-permissions']) assert.ok(!c.argv.includes(flag), flag);
  assert.equal(c.mcp, EMPTY_MCP_CONFIG);
  assert.ok(!existsSync(path.dirname(mcpFile)), 'temporary folder removed');
  assert.equal(c.env.DISABLE_AUTOUPDATER, '1');
  assert.equal(c.env.FORCE_PROMPT_CACHING_5M, '1');
  assert.ok(c.stdin.startsWith('You are the second opinion of the am workflow, run as a separate Claude session'), c.stdin.slice(0, 120));
  assert.ok(c.stdin.includes(BODY), 'second-opinion.md body');
  assert.ok(!c.stdin.includes(`model: ${REVIEWER.model}`), 'frontmatter left out');
  assert.ok(c.stdin.endsWith('# Brief\n\n## Choices\n1. Cache: A or B\n'));
  assert.ok(!c.stdin.includes(CONTRARIAN));
});

test('claudeArgs: exact flags, only known model and effort values', () => {
  assert.deepEqual(claudeArgs('m.json', { model: 'opus', effort: 'high' }), [
    '-p', '--tools', 'Read,Grep,Glob', '--permission-mode', 'dontAsk', '--strict-mcp-config', '--mcp-config', 'm.json', '--disable-slash-commands', '--model', 'opus', '--effort', 'high',
  ]);
  for (const model of ['claude-opus-5-5', 'opus --x', '', undefined]) assert.throws(() => claudeArgs('m', { model, effort: 'high' }), /model/, String(model));
  for (const effort of ['minimal', '', undefined]) assert.throws(() => claudeArgs('m', { model: 'opus', effort }), /effort/, String(effort));
});

test('user file second-opinion values go into the flags; default is ignored; no reviewer line', async () => {
  const t = setup();
  const model = other(REVIEWER.model, OPINION_MODELS);
  const effort = other(REVIEWER.effort, USER_EFFORTS);
  userFile(t, { model: { 'second-opinion': model }, effort: { 'second-opinion': effort } });
  const r = await call(t, [BRIEF]);
  assert.equal(r.code, 0, r.text);
  assert.ok(r.text.startsWith(`${ANSWER_HEADER}\n`), r.text);
  const [c] = calls(t);
  assert.deepEqual(c.argv, claudeArgs(c.argv[c.argv.indexOf('--mcp-config') + 1], { model, effort }));

  const t2 = setup();
  userFile(t2, { model: { default: model }, effort: { default: effort } });
  assert.equal((await call(t2, [BRIEF])).code, 0);
  const [c2] = calls(t2);
  assert.deepEqual(c2.argv, claudeArgs(c2.argv[c2.argv.indexOf('--mcp-config') + 1], REVIEWER));
});

test('a bad or broken user file: exit 1 with the reason and no claude call, even without Claude', async () => {
  for (const text of ['{"model":{"second-opinion":"claude-opus-5-5"}}', '{"effort":{"second-opinion":"minimal"}}', 'not json']) {
    for (const empty of [false, true]) {
      const t = setup();
      const file = userFile(t, text);
      const r = await call(t, [BRIEF], empty ? { pathDir: t.empty } : {});
      assert.equal(r.code, 1, r.text);
      assert.ok(r.text.startsWith(`the user model settings cannot be used (fix or remove the file): ${file}`), r.text);
      assert.deepEqual(calls(t), []);
    }
  }
});

test('the reviewer file without frontmatter: exit 1, no call', async () => {
  const t = setup();
  const agentFile = path.join(t.base, 'agent.md');
  writeFileSync(agentFile, 'no frontmatter here\n');
  const r = await call(t, [BRIEF], { agentFile });
  assert.equal(r.code, 1);
  assert.match(r.text, /^the reviewer's built-in model and effort cannot be read: .*no frontmatter block/);
  assert.deepEqual(calls(t), []);
});

test('the brief check is the one of codex-opinion; bad briefs: exit 1, no call', async () => {
  assert.equal(checkBrief, codexCheckBrief, 'the same function, not a copy');
  const t = setup();
  writeFileSync(path.join(t.base, 'outside.md'), 'secret');
  writeFileSync(path.join(t.repo, '.am', 'x', 'brief.txt'), 'x');
  writeFileSync(path.join(t.repo, '.am', 'big.md'), 'x'.repeat(MAX_BRIEF_BYTES + 1));
  for (const [brief, re] of [['../outside.md', /inside \.am/], ['.am/x/brief.txt', /\.md file/], ['.am/big.md', /larger than/], ['.am/missing.md', /not found/]]) {
    const r = await call(t, [brief]);
    assert.equal(r.code, 1, brief);
    assert.match(r.text, re, brief);
  }
  assert.deepEqual(calls(t), []);
});

test('bad arguments: usage and exit 1 before claude starts', async () => {
  const t = setup();
  const b = BRIEF;
  for (const argv of [[], ['--as', '2'], [b, '--as'], [b, '--as', '3'], [b, '--as=2'], [b, '--as', '2', 'x'], [b, '--as', '1', '--as', '2'], [b, '--model', 'haiku'], ['--as', '2', b]]) {
    const r = await call(t, argv);
    assert.equal(r.code, 1, argv.join(' '));
    assert.match(r.text, /^usage: node claude-opinion\.mjs/, argv.join(' '));
  }
  assert.deepEqual(calls(t), []);
  assert.deepEqual(parseArgs([b]), { brief: b, as: null });
  assert.deepEqual(parseArgs([b, '--as', '2']), { brief: b, as: '2' });
});

test('--as: the name line for 1 and 2, the contrarian rule only for 2', async () => {
  const t = setup();
  for (const argv of [[BRIEF], [BRIEF, '--as', '1'], [BRIEF, '--as', '2']]) assert.equal((await call(t, argv)).code, 0);
  const [none, one, two] = calls(t);
  assert.ok(!none.stdin.includes('You are Claude '), 'no name line without --as');
  assert.ok(one.stdin.startsWith(`${reviewerName('1')}\n\n`));
  assert.ok(!one.stdin.includes(CONTRARIAN));
  assert.ok(two.stdin.startsWith(`${reviewerName('2')}\n\n${CONTRARIAN}\n\n`));
  for (const c of [none, one, two]) {
    assert.ok(c.stdin.includes(BODY));
    assert.ok(c.stdin.endsWith('# Brief\n\n## Choices\n1. Cache: A or B\n'));
  }
  assert.equal(buildPrompt('---\nmodel: x\n---\nbody\n', 'b', '2'), `${reviewerName('2')}\n\n${CONTRARIAN}\n\n${buildPrompt('body', 'b').split('\n\n')[0]}\n\nbody\n\n# Brief\n\nb\n`);
});

test('claude not on PATH: exit 2 and nothing runs, whatever the brief', async () => {
  const t = setup();
  for (const brief of [BRIEF, '../outside.md']) {
    const r = await call(t, [brief], { pathDir: t.empty });
    assert.equal(r.code, 2, brief);
    assert.equal(r.text, 'Claude is not installed: no claude command on PATH.\n');
  }
});

test('failures: exit 1 with the reason', async () => {
  const t = setup();
  const fail = await call(t, [BRIEF], { mode: 'fail' });
  assert.equal(fail.code, 1);
  assert.match(fail.text, /^Claude failed \(exit 1, no answer\).*not logged in/s);
  const empty = await call(t, [BRIEF], { mode: 'empty' });
  assert.equal(empty.code, 1);
  assert.match(empty.text, /no answer/);
});

test('the hand-over owner never reaches the reviewer session', async () => {
  const t = setup();
  assert.equal((await call(t, [BRIEF], { extra: { AM_HANDOVER_OWNER: '12345' } })).code, 0);
  assert.equal(calls(t)[0].env.AM_HANDOVER_OWNER, null);
});

test('timeout: exit 1 and the whole claude process tree ends', async () => {
  const t = setup();
  const pidFile = path.join(t.base, 'claude.pid');
  const r = await call(t, [BRIEF], { mode: 'hang', timeoutMs: 1500, extra: { FAKE_CLAUDE_PID: pidFile } });
  assert.equal(r.code, 1);
  assert.match(r.text, /no answer within 2 s/);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  await new Promise((res) => setTimeout(res, 500));
  assert.ok(!running(pid), 'fake claude still running');
});

test('timeout with a grandchild holding the pipes: ends after the grace time', { skip: WIN }, async () => {
  const t = setup();
  const pidFile = path.join(t.base, 'orphan.pid');
  const started = Date.now();
  let orphan = null;
  try {
    const r = await call(t, [BRIEF], { mode: 'orphan', timeoutMs: 1000, killGraceMs: 300, extra: { FAKE_CLAUDE_PID: pidFile } });
    assert.equal(r.code, 1);
    assert.match(r.text, /no answer within 1 s/);
    assert.ok(Date.now() - started < 8000, `took ${Date.now() - started} ms`);
  } finally {
    if (existsSync(pidFile)) orphan = Number(readFileSync(pidFile, 'utf8'));
    if (orphan) {
      try {
        process.kill(orphan, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }
  assert.ok(orphan, 'the orphan pid was written');
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

test('CLI: usage error without a brief', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^usage: node claude-opinion\.mjs/);
});
