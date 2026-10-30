// Run: node --test tests/agent-stage.test.mjs
// The am-auto:agent stage starter and ender: start (lock, waits, records, rules and skill files, model and effort), end
// (runId, once, under the lock), card and answer (the cards and answers as written).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANSWER_LINE, CARD_ANSWERED, CARD_END, CARD_OPEN, MAX_ANSWER_BYTES, findCards, main, newRunId, parseAgents, pickSessions, startArgs } from '../auto/scripts/agent-stage.mjs';
import { AGENT_RECORD, AGENT_STALE_MS, agentRules, inlineSkill } from '../auto/scripts/stage.mjs';
import { frontmatterModels } from '../plugin/scripts/user-models.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OWN = path.join(REPO, 'auto'); // am-auto: stage agents, claude-opinion
const AM = path.join(REPO, 'plugin'); // the core am: skills
const LIVE = 101;
const OTHER = 103;
const DEAD = 102;
const SHELL = 999;
const aliveOnly = (pid) => pid === LIVE || pid === OTHER || pid === SHELL || pid === process.pid;
const SMALL = '# p\n## Summary\n- Scale: 1 implementation runs, 1 commits\n## Steps\n1. a. Check: x\n';
const KEYS = ['agent', 'rules', 'skill', 'runId', 'model', 'effort', 'wait', 'note', 'error'];

function makeRepo(t, { plan = null, request = 'Fix the typo' } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'am-agent-stage-'));
  const cfg = mkdtempSync(path.join(os.tmpdir(), 'am-agent-stage-cfg-'));
  t.after(() => Promise.all([dir, cfg].map((d) => rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))));
  mkdirSync(path.join(dir, '.am', 'demo'), { recursive: true });
  if (request !== null) writeFileSync(path.join(dir, '.am', 'demo', 'request.md'), request);
  if (plan !== null) writeFileSync(path.join(dir, '.am', 'demo', 'plan.md'), plan);
  return { dir, cfg };
}

/** A core lookup that finds `root`. */
const coreAt = (root) => () => ({ root, source: 'list', version: '0.1.66' });
let ids = 0;
async function run({ dir, cfg }, argv, opts = {}) {
  let out = '';
  let err = '';
  const env = { CLAUDE_CONFIG_DIR: cfg, CLAUDE_PID: String(LIVE), ...(opts.env || {}) };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  const code = await main(argv, { cwd: dir, ownRoot: OWN, core: coreAt(AM), alive: aliveOnly, ppid: SHELL, pollMs: 10, waitMs: 80, settleMs: 0, lockWaitMs: 60, newRunId: () => `r${++ids}-abcdef`, ...opts, env, out: { write: (s) => (out += s) }, err: { write: (s) => (err += s) } });
  let json = null;
  try {
    json = JSON.parse(out);
  } catch {
    // Not a JSON line.
  }
  return { code, out, err, json };
}

const read = (dir, rel) => readFileSync(path.join(dir, rel), 'utf8');
const events = (dir, slug = 'demo') => (existsSync(path.join(dir, '.am', slug, 'progress.jsonl')) ? read(dir, `.am/${slug}/progress.jsonl`).trim().split('\n').map((l) => JSON.parse(l)) : []);
function taskEvents(dir, slug, lines) {
  mkdirSync(path.join(dir, '.am', slug), { recursive: true });
  writeFileSync(path.join(dir, '.am', slug, 'progress.jsonl'), lines.map((l) => `${JSON.stringify({ t: new Date().toISOString(), ...l })}\n`).join(''));
}
const fm = (name) => frontmatterModels(path.join(OWN, 'agents', `${name}.md`));

test('startArgs and newRunId: the stage, slug and flags, each flag once', () => {
  assert.deepEqual(startArgs(['do', 'demo', '--fix', '--push']), { stage: 'do', slug: 'demo', push: true, fix: true, part: false, dispatch: null });
  for (const bad of [['handover', 'demo'], ['plan', 'Demo'], ['plan'], ['plan', 'demo', '--push', '--push'], ['plan', 'demo', '--solo'], ['plan', 'demo', 'x']]) assert.equal(startArgs(bad), null, bad.join(' '));
  assert.match(newRunId(), /^[a-z0-9]+-[a-f0-9]{6}$/);
});

test('start: under the lock it writes stage.json, the skill and rules files and a start event with CLAUDE_PID, then prints one JSON line', async (t) => {
  const repo = makeRepo(t);
  const r = await run(repo, ['start', 'plan', 'demo']);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(Object.keys(r.json), KEYS);
  const { model, effort } = fm('stage-plan');
  const runId = r.json.runId;
  assert.match(runId, /^r\d+-abcdef$/);
  assert.deepEqual(r.json, { agent: 'am-auto:stage-plan', rules: '.am/demo/rules-plan.md', skill: '.am/demo/skill-plan.md', runId, model, effort, wait: null, note: null, error: null });
  assert.equal(r.out.split('\n').length, 2, 'one line');
  const rec = JSON.parse(read(repo.dir, `.am/demo/${AGENT_RECORD}`));
  assert.deepEqual({ ...rec, t: 0 }, { pid: LIVE, runId, stage: 'plan', slug: 'demo', push: false, fix: false, part: false, core: AM, t: 0 });
  assert.equal(read(repo.dir, '.am/demo/rules-plan.md'), agentRules('plan', 'demo', { runId, ownRoot: OWN }));
  assert.equal(read(repo.dir, '.am/demo/skill-plan.md'), inlineSkill(read(AM, 'skills/plan/SKILL.md'), 'Read the request in .am/demo/request.md (slug demo)', AM));
  assert.ok(!read(repo.dir, '.am/demo/skill-plan.md').startsWith('---'));
  const ev = events(repo.dir);
  assert.equal(ev.length, 1);
  assert.deepEqual({ ...ev[0], t: 0 }, { t: 0, ev: 'start', text: 'stage plan started', pid: LIVE, stage: 'plan' });
  assert.ok(!existsSync(path.join(repo.dir, '.am', '.admission.lock')), 'the lock is released');
  assert.ok(existsSync(path.join(repo.dir, '.am', '.gitignore')));
  // Each stage needs its input.
  const none = await run(makeRepo(t), ['start', 'do', 'demo']);
  assert.match(none.json.error, /no \.am\/demo\/plan\.md/);
  const bad = await run(repo, ['start', 'plan', 'demo', '--bogus']);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /^usage:/);
});

test('start: another run of the working tree makes it wait (one note, nothing written); once that ends it starts', async (t) => {
  const repo = makeRepo(t);
  taskEvents(repo.dir, 'a', [{ ev: 'start', text: 's', pid: OTHER, stage: 'do' }]);
  const r = await run(repo, ['start', 'plan', 'demo']);
  assert.equal(r.code, 0);
  assert.deepEqual(Object.keys(r.json), KEYS);
  assert.match(r.json.wait, /waiting for another run of this repository: a \(do stage running\)/);
  for (const k of KEYS.filter((k) => k !== 'wait')) assert.equal(r.json[k], null, k);
  assert.deepEqual(events(repo.dir).map((e) => [e.ev, e.stage]), [['note', 'wait']], 'one wait note over several looks');
  assert.ok(!existsSync(path.join(repo.dir, '.am', 'demo', AGENT_RECORD)));
  assert.ok(!existsSync(path.join(repo.dir, '.am', 'demo', 'rules-plan.md')));
  taskEvents(repo.dir, 'a', [{ ev: 'start', text: 's', pid: OTHER, stage: 'commit' }, { ev: 'end', text: 'e', stage: 'commit', status: 'COMMITTED' }]);
  const go = await run(repo, ['start', 'plan', 'demo']);
  assert.equal(go.json.agent, 'am-auto:stage-plan');
  assert.deepEqual(events(repo.dir).map((e) => e.ev), ['note', 'start']);
  // Another stage taking the start lock right now is waited for too.
  const held = makeRepo(t);
  writeFileSync(path.join(held.dir, '.am', '.admission.lock'), JSON.stringify({ pid: OTHER, t: Date.now() }));
  assert.match((await run(held, ['start', 'plan', 'demo'])).json.wait, /another stage of this repository is starting \(pid 103\)/);
});

test('start: push, fix and part', async (t) => {
  const repo = makeRepo(t, { plan: SMALL });
  const push = await run(repo, ['start', 'commit', 'demo', '--push']);
  assert.equal(push.json.agent, 'am-auto:stage-commit-push');
  assert.equal(push.json.model, fm('stage-commit-push').model);
  assert.ok(read(repo.dir, push.json.rules).includes('(the push keyword is that confirmation for the push)'));
  assert.equal(read(repo.dir, push.json.skill), inlineSkill(read(AM, 'skills/commit/SKILL.md'), 'push', AM));
  await run(repo, ['end', 'demo', push.json.runId, 'COMMITTED']);
  const fix = await run(repo, ['start', 'do', 'demo', '--fix']);
  assert.equal(fix.json.agent, 'am-auto:stage-do');
  assert.ok(read(repo.dir, fix.json.rules).includes('Read .am/demo/check.md first'));
  assert.equal(JSON.parse(read(repo.dir, `.am/demo/${AGENT_RECORD}`)).fix, true);
  // A part of demo: not held by its owner's gap between stages.
  const part = makeRepo(t, { plan: SMALL });
  mkdirSync(path.join(part.dir, '.am', 'demo-p1'));
  writeFileSync(path.join(part.dir, '.am', 'demo-p1', 'request.md'), 'Part 1 of 2 of .am/demo/plan.md: steps 1-2');
  taskEvents(part.dir, 'demo', [{ ev: 'start', text: 's', pid: DEAD, stage: 'plan' }, { ev: 'end', text: 'e', stage: 'plan', status: 'READY' }]);
  const p = await run(part, ['start', 'plan', 'demo-p1', '--part']);
  assert.equal(p.json.error, null, p.json.error);
  assert.equal(p.json.agent, 'am-auto:stage-plan');
  const rules = read(part.dir, p.json.rules);
  assert.ok(rules.includes('This is a part plan') && !rules.includes('## Parts'));
  assert.equal(JSON.parse(read(part.dir, `.am/demo-p1/${AGENT_RECORD}`)).part, true);
  // Without --part the owner's gap holds it.
  const plain = makeRepo(t, { plan: SMALL });
  mkdirSync(path.join(plain.dir, '.am', 'demo-p1'));
  writeFileSync(path.join(plain.dir, '.am', 'demo-p1', 'request.md'), 'Part 1 of 2 of .am/demo/plan.md: steps 1-2');
  taskEvents(plain.dir, 'demo', [{ ev: 'start', text: 's', pid: DEAD, stage: 'plan' }, { ev: 'end', text: 'e', stage: 'plan', status: 'READY' }]);
  assert.match((await run(plain, ['start', 'plan', 'demo-p1'])).json.wait, /demo \(between stages\)/);
  // A part slug, its request's first words and the owner's plan are all required.
  assert.match((await run(makeRepo(t), ['start', 'plan', 'demo', '--part'])).json.error, /--part needs a part slug/);
  const wrong = makeRepo(t, { plan: SMALL });
  mkdirSync(path.join(wrong.dir, '.am', 'demo-p2'));
  writeFileSync(path.join(wrong.dir, '.am', 'demo-p2', 'request.md'), 'Part 1 of 2 of .am/demo/plan.md: steps 1-2');
  assert.match((await run(wrong, ['start', 'plan', 'demo-p2', '--part'])).json.error, /does not start with `Part 2 of <N> of \.am\/demo\/plan\.md:`/);
  const orphan = makeRepo(t);
  mkdirSync(path.join(orphan.dir, '.am', 'x-p1'));
  writeFileSync(path.join(orphan.dir, '.am', 'x-p1', 'request.md'), 'Part 1 of 2 of .am/x/plan.md: steps');
  assert.match((await run(orphan, ['start', 'plan', 'x-p1', '--part'])).json.error, /no \.am\/x\/plan\.md/);
  assert.ok(!existsSync(path.join(orphan.dir, '.am', 'x-p1', AGENT_RECORD)));
});

test('start: an open stage of this task holds a new one, even with the same pid, until stage.json goes stale', async (t) => {
  const repo = makeRepo(t);
  const first = await run(repo, ['start', 'plan', 'demo']);
  const again = await run(repo, ['start', 'plan', 'demo']);
  assert.match(again.json.wait, /waiting for this task's open stage: the plan stage of this task \(pid 101\) has not ended/);
  const rec = path.join(repo.dir, '.am', 'demo', AGENT_RECORD);
  const old = new Date(Date.now() - AGENT_STALE_MS - 60000);
  utimesSync(rec, old, old);
  assert.ok((await run(repo, ['start', 'plan', 'demo'], { settleMs: 60000 })).json.wait, 'trusted for the settle time');
  const late = await run(repo, ['start', 'plan', 'demo']);
  assert.equal(late.json.error, null);
  assert.notEqual(late.json.runId, first.json.runId);
  assert.equal(JSON.parse(read(repo.dir, `.am/demo/${AGENT_RECORD}`)).runId, late.json.runId);
  // The ended stage no longer holds anything.
  await run(repo, ['end', 'demo', late.json.runId, 'READY']);
  assert.equal((await run(repo, ['start', 'do', 'demo'], { env: {} })).json.error, 'no .am/demo/plan.md: run the plan stage first');
});

test('start: CLAUDE_PID must name the running session, not the shell', async (t) => {
  for (const [pid, re] of [[undefined, /CLAUDE_PID is not a process ID \(not set\)/], ['abc', /CLAUDE_PID is not a process ID \("abc"\)/], [String(DEAD), /CLAUDE_PID 102 is not a running process/], [String(SHELL), /CLAUDE_PID 999 is the shell that runs this script/]]) {
    const repo = makeRepo(t);
    const r = await run(repo, ['start', 'plan', 'demo'], { env: { CLAUDE_PID: pid } });
    assert.equal(r.code, 0);
    assert.match(r.json.error, re);
    assert.deepEqual(Object.keys(r.json), KEYS);
    assert.ok(!existsSync(path.join(repo.dir, '.am', 'demo', AGENT_RECORD)));
    assert.deepEqual(events(repo.dir), []);
  }
});

test('start: the skill comes from the core am and the stage agent and claude-opinion from this plugin; no core, nothing written', async (t) => {
  const core = mkdtempSync(path.join(os.tmpdir(), 'am-agent-core-'));
  t.after(() => rm(core, { recursive: true, force: true }));
  mkdirSync(path.join(core, 'skills', 'plan'), { recursive: true });
  writeFileSync(path.join(core, 'skills', 'plan', 'SKILL.md'), '---\nmodel: sonnet\neffort: low\n---\nRequest: $ARGUMENTS\nRun `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-opinion.mjs" <brief file>`\n');
  const repo = makeRepo(t);
  const r = await run(repo, ['start', 'plan', 'demo'], { core: coreAt(core) });
  assert.equal(r.json.error, null, r.json.error);
  assert.deepEqual([r.json.model, r.json.effort], [fm('stage-plan').model, fm('stage-plan').effort], 'the stage agent of this plugin');
  const slashed = (p) => p.split(path.sep).join('/');
  const skill = read(repo.dir, r.json.skill);
  assert.equal(skill, `Request: Read the request in .am/demo/request.md (slug demo)\nRun \`node "${slashed(core)}/scripts/codex-opinion.mjs" <brief file>\`\n`);
  const rules = read(repo.dir, r.json.rules);
  assert.ok(rules.includes(`\`node "${slashed(OWN)}/scripts/claude-opinion.mjs" <brief file>\``) && !rules.includes(slashed(core)), 'claude-opinion of this plugin');
  assert.equal(JSON.parse(read(repo.dir, `.am/demo/${AGENT_RECORD}`)).core, core);

  const none = makeRepo(t);
  const f = await run(none, ['start', 'plan', 'demo'], { core: () => ({ error: 'The am plugin is not installed: run x.' }) });
  assert.equal(f.code, 0);
  assert.deepEqual(f.json, { ...Object.fromEntries(KEYS.map((k) => [k, null])), error: 'the am plugin cannot be used: The am plugin is not installed: run x.' });
  for (const name of [AGENT_RECORD, 'skill-plan.md', 'rules-plan.md', 'progress.jsonl']) assert.ok(!existsSync(path.join(none.dir, '.am', 'demo', name)), name);
});

test('end: only the open stage of the same runId, once, under the lock; an unknown status is failed', async (t) => {
  const repo = makeRepo(t);
  const { runId } = (await run(repo, ['start', 'plan', 'demo'])).json;
  const wrong = await run(repo, ['end', 'demo', 'r0-000000', 'READY']);
  assert.deepEqual(wrong.json, { ended: false, status: null, reason: `runId r0-000000 is not the stage's runId ${runId}` });
  assert.deepEqual(events(repo.dir).map((e) => e.ev), ['start']);
  // Another holder of the start lock: nothing is read or written.
  const lock = path.join(repo.dir, '.am', '.admission.lock');
  writeFileSync(lock, JSON.stringify({ pid: OTHER, t: Date.now() }));
  const recFile = path.join(repo.dir, '.am', 'demo', AGENT_RECORD);
  const before = [readFileSync(recFile), readFileSync(path.join(repo.dir, '.am', 'demo', 'progress.jsonl'))];
  const busy = await run(repo, ['end', 'demo', runId, 'READY']);
  assert.equal(busy.json.ended, false);
  assert.match(busy.json.reason, /^busy: the start lock is held \(pid 103\)/);
  assert.deepEqual([readFileSync(recFile), readFileSync(path.join(repo.dir, '.am', 'demo', 'progress.jsonl'))], before);
  writeFileSync(lock, JSON.stringify({ pid: DEAD, t: Date.now() }));
  const ok = await run(repo, ['end', 'demo', runId, 'READY'], { now: () => JSON.parse(readFileSync(recFile, 'utf8')).t + 3 * 60000 });
  assert.deepEqual(ok.json, { ended: true, status: 'READY', reason: '' });
  const ev = events(repo.dir).at(-1);
  assert.deepEqual({ ...ev, t: 0 }, { t: 0, ev: 'end', text: 'plan stage ended', stage: 'plan', status: 'READY', min: 3 });
  const rec = JSON.parse(readFileSync(recFile, 'utf8'));
  assert.equal(rec.status, 'READY');
  assert.ok(Number.isFinite(rec.ended));
  assert.equal(rec.core, AM, 'the core folder stays after end');
  const twice = await run(repo, ['end', 'demo', runId, 'READY']);
  assert.deepEqual(twice.json, { ended: false, status: 'READY', reason: `the stage of runId ${runId} has already ended` });
  assert.equal(events(repo.dir).filter((e) => e.ev === 'end').length, 1);
  assert.ok(!existsSync(lock), 'the dead holder\'s lock was taken and released');
  // A status the stage cannot give ends it failed; BLOCKED is valid in every stage.
  const next = (await run(repo, ['start', 'plan', 'demo'])).json.runId;
  const odd = await run(repo, ['end', 'demo', next, 'DONE']);
  assert.deepEqual(odd.json, { ended: true, status: 'failed', reason: 'the stage gave an unknown status: DONE' });
  assert.equal(events(repo.dir).at(-1).status, 'failed');
  const third = (await run(repo, ['start', 'plan', 'demo'])).json.runId;
  assert.equal((await run(repo, ['end', 'demo', third, 'BLOCKED'])).json.status, 'BLOCKED');
  assert.deepEqual((await run(makeRepo(t), ['end', 'demo', 'x', 'READY'])).json, { ended: false, status: null, reason: `no readable .am/demo/${AGENT_RECORD}` });
  assert.equal((await run(repo, ['end', 'demo', 'x'])).code, 1);
});

const CARD = [
  '**What is decided**: 화면에 무엇을 보일지',
  '',
  '```sh',
  'echo "$HOME" $& `x`',
  '```',
  '1. A - 그대로 (추천)',
  '2. B - 바꿈',
];
const planWith = (cards, eol = '\n') => ['# 계획', '## 결정', '- 앞의 결정 (자동 결정)', ...cards.flatMap((c) => [CARD_OPEN, ...c, CARD_END, '']), '## 단계', '1. a', ''].join(eol);

test('card and answer: the cards and the answer as written, plan.md unchanged outside them', async (t) => {
  const repo = makeRepo(t, { plan: planWith([CARD]) });
  const c = await run(repo, ['card', 'demo']);
  assert.equal(c.code, 0);
  assert.equal(c.out, `${CARD.join('\n')}\n`);
  const reply = '- B 로 해 주세요.\n  `$1` 과 "따옴표" 그대로\n\n```\n$& code\n```\n';
  writeFileSync(path.join(repo.dir, '.am', 'demo', 'answer.txt'), reply);
  const a = await run(repo, ['answer', 'demo', '.am/demo/answer.txt']);
  assert.equal(a.code, 0, a.err);
  assert.deepEqual(a.json, { answered: 1 });
  const after = read(repo.dir, '.am/demo/plan.md');
  const expected = planWith([]).replace('\n## 단계', `\n${[CARD_ANSWERED, ...CARD, ANSWER_LINE, ...reply.replace(/\n+$/, '').split('\n'), CARD_END, ''].join('\n')}\n## 단계`.replaceAll('$', '$$$$'));
  assert.equal(after, expected);
  assert.ok(!after.includes('OPEN'));
  assert.equal((await run(repo, ['card', 'demo'])).code, 2, 'no open card left');
  assert.equal((await run(repo, ['answer', 'demo', '.am/demo/answer.txt'])).code, 2);
  assert.equal(read(repo.dir, '.am/demo/plan.md'), expected);
});

test('card and answer: CRLF, two cards, no card, unmatched marks, bad answers, an open stage', async (t) => {
  const two = [['첫 카드', '1. A'], ['둘째 카드', '1. X']];
  const crlf = makeRepo(t, { plan: planWith(two, '\r\n') });
  assert.equal((await run(crlf, ['card', 'demo'])).out, '첫 카드\n1. A\n\n둘째 카드\n1. X\n');
  writeFileSync(path.join(crlf.dir, 'a.md'), 'A 와 X\r\n둘째 줄\r\n');
  assert.deepEqual((await run(crlf, ['answer', 'demo', 'a.md'])).json, { answered: 2 });
  const card = (lines) => [CARD_ANSWERED, ...lines, ANSWER_LINE, 'A 와 X', '둘째 줄', CARD_END, ''];
  assert.equal(read(crlf.dir, '.am/demo/plan.md'), ['# 계획', '## 결정', '- 앞의 결정 (자동 결정)', ...card(two[0]), ...card(two[1]), '## 단계', '1. a', ''].join('\r\n'));
  // No card at all, a card with no end, an end with no card.
  assert.equal((await run(makeRepo(t, { plan: SMALL }), ['card', 'demo'])).code, 2);
  for (const text of [`${CARD_OPEN}\nq\n`, `q\n${CARD_END}\n`, `${CARD_OPEN}\n${CARD_OPEN}\n${CARD_END}\n`]) {
    const repo = makeRepo(t, { plan: text });
    writeFileSync(path.join(repo.dir, 'a.md'), 'A');
    const c = await run(repo, ['card', 'demo']);
    assert.equal(c.code, 1, text);
    assert.match(c.err, /plan\.md: line \d+/);
    assert.equal((await run(repo, ['answer', 'demo', 'a.md'])).code, 1, text);
    assert.equal(read(repo.dir, '.am/demo/plan.md'), text);
  }
  assert.equal((await run(makeRepo(t), ['card', 'demo'])).code, 1, 'no plan.md');
  // Answers that cannot be used leave plan.md as it is.
  const repo = makeRepo(t, { plan: planWith([CARD]) });
  const plan = read(repo.dir, '.am/demo/plan.md');
  for (const [text, re] of [['  \n', /is empty/], [`A\n  ${CARD_END}\n`, /starts with <!-- am:card/], ['x'.repeat(MAX_ANSWER_BYTES + 1), /larger than/]]) {
    writeFileSync(path.join(repo.dir, 'a.md'), text);
    const r = await run(repo, ['answer', 'demo', 'a.md']);
    assert.equal(r.code, 1);
    assert.match(r.err, re);
  }
  assert.equal((await run(repo, ['answer', 'demo', 'missing.md'])).code, 1);
  // While a stage of the task is open no answer is written.
  writeFileSync(path.join(repo.dir, 'a.md'), 'A');
  const { runId } = (await run(repo, ['start', 'do', 'demo'])).json;
  const open = await run(repo, ['answer', 'demo', 'a.md']);
  assert.equal(open.code, 1);
  assert.match(open.err, /still open/);
  assert.equal(read(repo.dir, '.am/demo/plan.md'), plan);
  await run(repo, ['end', 'demo', runId, 'NEEDS_DECISION']);
  assert.equal((await run(repo, ['answer', 'demo', 'a.md'])).code, 0);
  assert.equal(findCards(read(repo.dir, '.am/demo/plan.md')).cards[0].answered, true);
});

test('start: the user models file - none, stage and default keys, broken, not an alias', async (t) => {
  const write = (repo, data) => {
    mkdirSync(path.join(repo.cfg, 'am'), { recursive: true });
    writeFileSync(path.join(repo.cfg, 'am', 'models.json'), typeof data === 'string' ? data : JSON.stringify(data));
  };
  const none = makeRepo(t, { plan: SMALL });
  const n = (await run(none, ['start', 'do', 'demo'])).json;
  assert.deepEqual([n.model, n.effort, n.note], [fm('stage-do').model, fm('stage-do').effort, null]);
  const set = makeRepo(t, { plan: SMALL });
  write(set, { model: { do: 'sonnet', plan: 'haiku' }, effort: { default: 'low' } });
  const s = (await run(set, ['start', 'do', 'demo'])).json;
  assert.deepEqual([s.model, s.effort, s.note], ['sonnet', 'low', null]);
  const broken = makeRepo(t, { plan: SMALL });
  write(broken, '{ not json');
  const b = (await run(broken, ['start', 'do', 'demo'])).json;
  assert.match(b.error, /the user model settings cannot be used .*not valid JSON/);
  assert.ok(!existsSync(path.join(broken.dir, '.am', 'demo', AGENT_RECORD)));
  assert.ok(!existsSync(path.join(broken.dir, '.am', 'demo', 'rules-do.md')));
  assert.deepEqual(events(broken.dir), []);
  const full = makeRepo(t, { plan: SMALL });
  write(full, { model: { default: 'claude-opus-4-5' }, effort: { check: 'max' } });
  const f = (await run(full, ['start', 'check', 'demo'])).json;
  assert.equal(f.model, fm('stage-check').model);
  assert.equal(f.effort, 'max');
  assert.match(f.note, /model "claude-opus-4-5" in .*models\.json is not one of opus, sonnet, haiku, fable; the stage agent's \w+ is used/);
  assert.equal(f.error, null);
});

// ------------------------------------------------------------------ dispatch, claim, outcome, wait, close

const T1 = 201;
const T2 = 202;
const T3 = 203;
const aliveRelay = (pid) => aliveOnly(pid) || [T1, T2, T3].includes(pid);
const DKEYS = ['dispatchId', 'target', 'message', 'resume', 'done', 'none', 'error'];
const FLOW = `${OWN.split(path.sep).join('/')}/flow/relay-part.md`;

/** A repository whose task demo has a plan and a part demo-p<k> for each k (request and plan). */
function makeParts(t, ks = [1]) {
  const repo = makeRepo(t, { plan: SMALL });
  for (const k of ks) {
    mkdirSync(path.join(repo.dir, '.am', `demo-p${k}`), { recursive: true });
    writeFileSync(path.join(repo.dir, '.am', `demo-p${k}`, 'request.md'), `Part ${k} of 2 of .am/demo/plan.md: steps`);
    writeFileSync(path.join(repo.dir, '.am', `demo-p${k}`, 'plan.md'), SMALL);
  }
  return repo;
}
const row = (dir, name, pid, startedAt, fields = {}) => ({ kind: 'interactive', status: 'idle', cwd: dir, pid, sessionId: `s-${name}`, name, startedAt, ...fields });
const listOf = (rows) => async () => ({ code: 0, stdout: JSON.stringify(rows), stderr: '' });
let dids = 0;
const relay = (repo, argv, opts = {}) => run(repo, argv, { alive: aliveRelay, newDispatchId: () => `d${++dids}-abcdef`, relayWaitMs: 60, relayPollMs: 10, ...opts });
const dispatchFile = (dir, part = 'demo-p1') => path.join(dir, '.am', part, 'dispatch.json');
const readD = (dir, part) => JSON.parse(readFileSync(dispatchFile(dir, part), 'utf8'));
const writeD = (dir, part, fields) => writeFileSync(dispatchFile(dir, part), JSON.stringify({ id: 'x1-abcdef', part, target: { name: 'A', sessionId: 's-A', pid: T1 }, driver: { pid: LIVE, sessionId: null }, push: false, t: Date.now(), state: 'open', claimedBy: null, claimedAt: null, reason: null, outcome: null, ...fields }));
const asPid = (pid) => ({ env: { CLAUDE_PID: String(pid) } });

test('pickSessions and parseAgents: idle interactive sessions of this folder, latest first, unique names, not the driver', (t) => {
  const { dir } = makeRepo(t);
  const other = mkdtempSync(path.join(os.tmpdir(), 'am-agent-other-'));
  t.after(() => rm(other, { recursive: true, force: true }));
  const rows = [
    row(dir, 'A', T1, '2026-01-01T00:00:00Z'),
    row(`${dir}${path.sep}`, 'B', T2, '2026-02-01T00:00:00Z'),
    row(dir, 'busy', 301, '2026-04-01T00:00:00Z', { status: 'busy' }),
    row(dir, 'bg', 302, '2026-04-01T00:00:00Z', { kind: 'background' }),
    row(other, 'away', 303, '2026-04-01T00:00:00Z'),
    row(dir, 'me', LIVE, '2026-04-01T00:00:00Z'),
    row(dir, 'dup', 304, '2026-04-01T00:00:00Z'),
    row(other, 'dup', 305, '2026-04-01T00:00:00Z', { status: 'busy' }),
    'not a row',
  ];
  const names = (o) => pickSessions(rows, { cwd: dir, driverPid: LIVE, ...o }).candidates.map((c) => c.name);
  assert.deepEqual(names({}), ['B', 'A']);
  assert.deepEqual(pickSessions(rows, { cwd: dir, driverPid: LIVE }).candidates[0], { name: 'B', sessionId: 's-B', pid: T2 });
  // Windows compares folders without case.
  const upper = [...rows, row(dir.toUpperCase(), 'U', T3, '2026-03-01T00:00:00Z')];
  assert.deepEqual(pickSessions(upper, { cwd: dir, driverPid: LIVE, platform: 'win32' }).candidates.map((c) => c.name), ['U', 'B', 'A']);
  if (process.platform !== 'win32' && dir !== dir.toUpperCase()) assert.deepEqual(pickSessions(upper, { cwd: dir, driverPid: LIVE, platform: 'linux' }).candidates.map((c) => c.name), ['B', 'A']);
  assert.match(pickSessions([row(dir, 'dup', 1, 0), row(other, 'dup', 2, 0)], { cwd: dir, driverPid: LIVE }).none, /only sessions whose name another session shares/);
  assert.match(pickSessions([], { cwd: dir, driverPid: LIVE }).none, /no idle interactive session is open in this folder/);
  assert.deepEqual(parseAgents('[1]'), { rows: [1] });
  assert.deepEqual(parseAgents('{"agents":[1],"n":2}'), { rows: [1] });
  assert.match(parseAgents('{"a":[],"b":[]}').error, /not a list/);
  assert.match(parseAgents('nope').error, /not JSON/);
});

test('dispatch: writes an open dispatch.json for the picked session and prints the message', async (t) => {
  const repo = makeParts(t);
  const rows = [row(repo.dir, 'A', T1, '2026-01-01T00:00:00Z'), row(repo.dir, 'B', T2, '2026-02-01T00:00:00Z'), row(repo.dir, 'me', LIVE, '2026-03-01T00:00:00Z')];
  const r = await relay(repo, ['dispatch', 'demo-p1', '--push'], { listAgents: listOf(rows), env: { CLAUDE_PID: String(LIVE), CLAUDE_CODE_SESSION_ID: 'drv' } });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(Object.keys(r.json), DKEYS);
  const id = r.json.dispatchId;
  assert.match(id, /^[a-z0-9]+-[a-f0-9]{6}$/);
  assert.deepEqual(r.json.target, { name: 'B', sessionId: 's-B', pid: T2 });
  assert.equal(r.json.message, [`am-auto relay request: run part demo-p1 of ${repo.dir} (dispatch ${id}).`, `Repository root: ${repo.dir}`, `Flow file: ${FLOW}`, 'Part: demo-p1', `Dispatch: ${id}`, 'Push: yes', 'Read the flow file and follow it for this part. Do not reply to the sender.'].join('\n'));
  assert.deepEqual([r.json.resume, r.json.done, r.json.none, r.json.error], [false, null, null, null]);
  const d = readD(repo.dir, 'demo-p1');
  assert.deepEqual({ ...d, t: 0 }, { id, part: 'demo-p1', target: r.json.target, driver: { pid: LIVE, sessionId: 'drv' }, push: true, t: 0, state: 'open', claimedBy: null, claimedAt: null, reason: null, outcome: null });
  assert.ok(!existsSync(path.join(repo.dir, '.am', '.admission.lock')), 'the lock is released');
  // An open dispatch that nobody claimed is replaced; its id no longer claims.
  const again = await relay(repo, ['dispatch', 'demo-p1'], { listAgents: listOf(rows) });
  assert.notEqual(again.json.dispatchId, id);
  assert.match(again.json.message, /Push: no/);
  assert.equal((await relay(repo, ['claim', 'demo-p1', id], asPid(OTHER))).json.claimed, false);
  // Arguments and the part.
  assert.equal((await relay(repo, ['dispatch', 'Demo-p1'])).code, 1);
  assert.equal((await relay(repo, ['dispatch', 'demo-p1', '--fix'])).code, 1);
  assert.match((await relay(repo, ['dispatch', 'demo'], { listAgents: listOf(rows) })).json.error, /--part needs a part slug/);
  assert.match((await relay(repo, ['dispatch', 'demo-p1'], { listAgents: listOf(rows), env: { CLAUDE_PID: undefined } })).json.error, /CLAUDE_PID is not a process ID/);
});

test('dispatch: other dispatches, open stages and the parts already given decide the session', async (t) => {
  const repo = makeParts(t, [1, 2, 3]);
  const rows = [row(repo.dir, 'A', T1, '2026-01-01T00:00:00Z'), row(repo.dir, 'B', T2, '2026-02-01T00:00:00Z'), row(repo.dir, 'C', T3, '2026-03-01T00:00:00Z')];
  const pick = async (list = rows) => (await relay(repo, ['dispatch', 'demo-p1'], { listAgents: listOf(list) })).json;
  assert.equal((await pick()).target.name, 'C');
  // The target of another open dispatch, and a pid with an open stage.json, are left out.
  writeD(repo.dir, 'demo-p2', { target: { name: 'C', sessionId: 's-C', pid: T3 } });
  assert.equal((await pick()).target.name, 'B');
  mkdirSync(path.join(repo.dir, '.am', 'other'));
  const stageRec = path.join(repo.dir, '.am', 'other', AGENT_RECORD);
  writeFileSync(stageRec, JSON.stringify({ pid: T2, runId: 'r-000000', stage: 'do' }));
  assert.equal((await pick()).target.name, 'A');
  writeFileSync(stageRec, JSON.stringify({ pid: T2, runId: 'r-000000', stage: 'do', ended: 1 }));
  assert.equal((await pick()).target.name, 'B', 'an ended stage holds nothing');
  // A live claim of another part holds its claimer too.
  writeD(repo.dir, 'demo-p2', { target: { name: 'C', sessionId: 's-C', pid: T3 }, state: 'claimed', claimedBy: T1, claimedAt: Date.now() });
  writeFileSync(stageRec, JSON.stringify({ pid: T2, runId: 'r-000000', stage: 'do' }));
  assert.match((await pick()).none, /every idle session of this folder is the target of another dispatch or runs a stage/);
  // A session another part of the owner was given comes after one that was not.
  rmSync(path.join(repo.dir, '.am', 'other'), { recursive: true });
  writeD(repo.dir, 'demo-p2', { target: { name: 'C', sessionId: 's-C', pid: T3 }, state: 'closed' });
  writeD(repo.dir, 'demo-p3', { target: { name: 'B', sessionId: 's-B', pid: T2 }, state: 'ended', outcome: { status: 'COMMITTED', stage: 'commit', t: 1 } });
  assert.equal((await pick()).target.name, 'A');
  // Every session was given a part: the first one.
  assert.equal((await pick(rows.slice(1))).target.name, 'C');
});

test('dispatch: resume a live claim, done after a commit end, a new dispatch after any other end', async (t) => {
  const repo = makeParts(t);
  const rows = [row(repo.dir, 'A', T1, '2026-01-01T00:00:00Z')];
  const go = (o = {}) => relay(repo, ['dispatch', 'demo-p1'], { listAgents: listOf(rows), ...o });
  const first = (await go()).json;
  assert.deepEqual((await relay(repo, ['claim', 'demo-p1', first.dispatchId], asPid(OTHER))).json, { claimed: true, reason: '' });
  const before = readFileSync(dispatchFile(repo.dir));
  const resumed = (await go()).json;
  assert.deepEqual(resumed, { dispatchId: first.dispatchId, target: first.target, message: null, resume: true, done: null, none: null, error: null });
  assert.deepEqual(readFileSync(dispatchFile(repo.dir)), before, 'nothing written');
  // A recorded commit end: done, nothing written.
  assert.deepEqual((await relay(repo, ['outcome', 'demo-p1', first.dispatchId, 'COMMITTED', 'commit'], asPid(OTHER))).json, { recorded: true, reason: '' });
  const ended = readFileSync(dispatchFile(repo.dir));
  const done = (await go()).json;
  assert.deepEqual(done.done, { status: 'COMMITTED', stage: 'commit' });
  assert.deepEqual([done.dispatchId, done.message, done.none], [first.dispatchId, null, null]);
  assert.deepEqual(readFileSync(dispatchFile(repo.dir)), ended);
  // A claim whose session died after the commit stage ended NOTHING: done; an end before the claim does not count.
  const claimedAt = Date.now() - 60000;
  writeD(repo.dir, 'demo-p1', { state: 'claimed', claimedBy: DEAD, claimedAt });
  taskEvents(repo.dir, 'demo-p1', [{ ev: 'end', text: 'e', stage: 'commit', status: 'NOTHING' }]);
  assert.deepEqual((await go()).json.done, { status: 'NOTHING', stage: 'commit' });
  writeFileSync(path.join(repo.dir, '.am', 'demo-p1', 'progress.jsonl'), `${JSON.stringify({ t: new Date(claimedAt - 1000).toISOString(), ev: 'end', text: 'e', stage: 'commit', status: 'COMMITTED' })}\n`);
  writeD(repo.dir, 'demo-p1', { state: 'claimed', claimedBy: DEAD, claimedAt });
  const fresh = (await go()).json;
  assert.equal(fresh.done, null);
  assert.equal(readD(repo.dir, 'demo-p1').state, 'open', 'a new dispatch');
  // NEEDS_DECISION, BLOCKED or unable: a new dispatch.
  for (const [status, stage] of [['NEEDS_DECISION', 'plan'], ['BLOCKED', 'do'], ['unable', null]]) {
    writeD(repo.dir, 'demo-p1', { state: 'ended', outcome: { status, stage, t: 1 } });
    const n = (await go()).json;
    assert.ok(n.dispatchId && n.dispatchId !== 'x1-abcdef' && n.message && n.done === null, status);
    assert.equal(readD(repo.dir, 'demo-p1').state, 'open');
  }
});

test('dispatch: a list that fails or cannot be read, no session, a fake claude command; close', async (t) => {
  const repo = makeParts(t);
  for (const [listed, re] of [
    [{ code: 1, stdout: '', stderr: 'boom\nmore' }, /^list failed: claude agents --json ended with code 1: boom$/],
    [{ code: 0, stdout: 'nope' }, /^list failed: the output is not JSON$/],
    [{ code: null, stdout: '', spawnError: 'spawn claude ENOENT' }, /^list failed: spawn claude ENOENT$/],
    [{ code: null, stdout: '', timedOut: true }, /^list failed: .*did not end within 120 seconds$/],
    [{ code: 0, stdout: '[]' }, /^no idle interactive session is open in this folder$/],
  ]) {
    const r = await relay(repo, ['dispatch', 'demo-p1'], { listAgents: async () => listed });
    assert.match(r.json.none, re);
    assert.equal(r.json.dispatchId, null);
    assert.ok(!existsSync(dispatchFile(repo.dir)), 'nothing written');
  }
  const wrapped = await relay(repo, ['dispatch', 'demo-p1'], { listAgents: async () => ({ code: 0, stdout: JSON.stringify({ agents: [row(repo.dir, 'A', T1, 1)] }) }) });
  assert.equal(wrapped.json.target.name, 'A');
  // The default list runs the claude command with `agents --json`.
  const fake = path.join(repo.dir, 'fake-claude.mjs');
  writeFileSync(fake, `process.stdout.write(JSON.stringify(process.argv.slice(2).join(' ') === 'agents --json' ? [${JSON.stringify(row(repo.dir, 'F', T2, 5))}] : []));\n`);
  const real = await relay(repo, ['dispatch', 'demo-p1'], { claude: [process.execPath, fake], listAgents: undefined });
  assert.equal(real.json.target?.name, 'F', JSON.stringify(real.json));
  // close: only the open dispatch of that id.
  const id = real.json.dispatchId;
  assert.deepEqual((await relay(repo, ['close', 'demo-p1', 'x9-abcdef', 'send failed'])).json, { closed: false, reason: `dispatch x9-abcdef is not the dispatch of demo-p1 (${id})` });
  assert.deepEqual((await relay(repo, ['close', 'demo-p1', id, 'send failed'])).json, { closed: true, reason: 'send failed' });
  assert.deepEqual([readD(repo.dir, 'demo-p1').state, readD(repo.dir, 'demo-p1').reason], ['closed', 'send failed']);
  assert.equal((await relay(repo, ['close', 'demo-p1', id, 'again'])).json.closed, false);
  assert.equal((await relay(repo, ['close', 'demo-p1', id])).code, 1);
});

test('claim and outcome: only the open dispatch, by the claiming session, once', async (t) => {
  const repo = makeParts(t);
  const id = 'x1-abcdef';
  writeD(repo.dir, 'demo-p1', { state: 'closed', reason: 'gone: x' });
  assert.match((await relay(repo, ['claim', 'demo-p1', id], asPid(OTHER))).json.reason, /is closed \(gone: x\)/);
  writeD(repo.dir, 'demo-p1', {});
  assert.match((await relay(repo, ['claim', 'demo-p1', 'x2-abcdef'], asPid(OTHER))).json.reason, /is not the dispatch of demo-p1/);
  assert.match((await relay(repo, ['outcome', 'demo-p1', id, 'COMMITTED', 'commit'], asPid(OTHER))).json.reason, /is open, not claimed/);
  const c = await relay(repo, ['claim', 'demo-p1', id], asPid(OTHER));
  assert.deepEqual(c.json, { claimed: true, reason: '' });
  const d = readD(repo.dir, 'demo-p1');
  assert.deepEqual([d.state, d.claimedBy, Number.isFinite(d.claimedAt)], ['claimed', OTHER, true]);
  assert.equal((await relay(repo, ['claim', 'demo-p1', id], asPid(OTHER))).json.claimed, true, 'the same session again');
  assert.deepEqual((await relay(repo, ['claim', 'demo-p1', id], asPid(LIVE))).json, { claimed: false, reason: `dispatch ${id} is claimed by pid ${OTHER}` });
  assert.match((await relay(repo, ['outcome', 'demo-p1', id, 'COMMITTED', 'commit'], asPid(LIVE))).json.reason, /claimed by pid 103, not this session \(pid 101\)/);
  assert.deepEqual((await relay(repo, ['outcome', 'demo-p1', id, 'NEEDS_DECISION', 'plan'], asPid(OTHER))).json, { recorded: true, reason: '' });
  assert.equal(readD(repo.dir, 'demo-p1').outcome.status, 'NEEDS_DECISION');
  assert.equal(readD(repo.dir, 'demo-p1').state, 'ended');
  assert.match((await relay(repo, ['outcome', 'demo-p1', id, 'COMMITTED', 'commit'], asPid(OTHER))).json.reason, /has already ended/);
  assert.match((await relay(repo, ['claim', 'demo-p1', id], asPid(OTHER))).json.reason, /is ended/);
  // unable has no stage; a status the stage cannot give is a usage error.
  writeD(repo.dir, 'demo-p1', { state: 'claimed', claimedBy: OTHER, claimedAt: Date.now() });
  assert.deepEqual((await relay(repo, ['outcome', 'demo-p1', id, 'unable', '-'], asPid(OTHER))).json, { recorded: true, reason: '' });
  assert.deepEqual({ ...readD(repo.dir, 'demo-p1').outcome, t: 0 }, { status: 'unable', stage: null, t: 0 });
  for (const bad of [['DONE', 'commit'], ['unable', 'do'], ['READY', '-'], ['READY', 'handover']]) assert.equal((await relay(repo, ['outcome', 'demo-p1', id, ...bad], asPid(OTHER))).code, 1, bad.join(' '));
  assert.equal((await relay(repo, ['claim', 'demo-p1', 'bad'])).code, 1);
  // Busy: nothing written.
  writeD(repo.dir, 'demo-p1', {});
  writeFileSync(path.join(repo.dir, '.am', '.admission.lock'), JSON.stringify({ pid: OTHER, t: Date.now() }));
  assert.match((await relay(repo, ['claim', 'demo-p1', id], asPid(OTHER))).json.reason, /^busy: the start lock is held \(pid 103\)/);
  assert.equal(readD(repo.dir, 'demo-p1').state, 'open');
});

test('start: a part another session claimed refuses other starts at once; --dispatch only for its claimer', async (t) => {
  assert.deepEqual(startArgs(['do', 'demo-p1', '--part', '--dispatch', 'x1-abcdef', '--push']), { stage: 'do', slug: 'demo-p1', push: true, fix: false, part: true, dispatch: 'x1-abcdef' });
  for (const bad of [['do', 'demo', '--dispatch'], ['do', 'demo', '--dispatch', 'bad'], ['do', 'demo', '--dispatch', 'x1-abcdef', '--dispatch', 'x1-abcdef']]) assert.equal(startArgs(bad), null, bad.join(' '));
  const repo = makeParts(t);
  const id = 'x1-abcdef';
  writeD(repo.dir, 'demo-p1', { state: 'claimed', claimedBy: OTHER, claimedAt: Date.now() });
  const plain = await relay(repo, ['start', 'do', 'demo-p1', '--part']);
  assert.equal(plain.json.error, `part demo-p1 is being run by session A (dispatch ${id}); no other run starts its stages while that session holds it`);
  assert.equal(plain.json.wait, null, 'refused, not waited for');
  const otherPid = await relay(repo, ['start', 'do', 'demo-p1', '--part', '--dispatch', id]);
  assert.match(otherPid.json.error, /claimed by pid 103, not this session \(pid 101\)/);
  assert.match((await relay(repo, ['start', 'do', 'demo-p1', '--part', '--dispatch', 'x2-abcdef'], asPid(OTHER))).json.error, /the dispatch of demo-p1 is x1-abcdef now/);
  assert.ok(!existsSync(path.join(repo.dir, '.am', 'demo-p1', AGENT_RECORD)));
  assert.deepEqual(events(repo.dir, 'demo-p1'), []);
  assert.ok(!existsSync(path.join(repo.dir, '.am', '.admission.lock')), 'the lock is released');
  const ok = await relay(repo, ['start', 'do', 'demo-p1', '--part', '--dispatch', id], asPid(OTHER));
  assert.equal(ok.json.error, null, ok.json.error);
  assert.equal(ok.json.agent, 'am-auto:stage-do');
  assert.equal(JSON.parse(read(repo.dir, `.am/demo-p1/${AGENT_RECORD}`)).pid, OTHER);
  await relay(repo, ['end', 'demo-p1', ok.json.runId, 'DONE'], asPid(OTHER));
  for (const state of ['closed', 'ended', 'open']) {
    writeD(repo.dir, 'demo-p1', { state, claimedBy: state === 'open' ? null : OTHER });
    assert.match((await relay(repo, ['start', 'check', 'demo-p1', '--part', '--dispatch', id], asPid(OTHER))).json.error, new RegExp(`the dispatch is ${state}, not claimed`));
  }
  // A dead claim no longer holds a start without --dispatch.
  writeD(repo.dir, 'demo-p1', { state: 'claimed', claimedBy: DEAD, claimedAt: Date.now() });
  assert.equal((await relay(repo, ['start', 'check', 'demo-p1', '--part'])).json.error, null);
});

test('wait: ended, closed, gone, unclaimed, stale, running and superseded', async (t) => {
  const repo = makeParts(t);
  const id = 'x1-abcdef';
  const w = async (o = {}) => (await relay(repo, ['wait', 'demo-p1', id], o)).json;
  writeD(repo.dir, 'demo-p1', { state: 'ended', outcome: { status: 'COMMITTED', stage: 'commit', t: 1 } });
  assert.deepEqual(await w(), { state: 'ended', status: 'COMMITTED', stage: 'commit', reason: null });
  writeD(repo.dir, 'demo-p1', { state: 'closed', reason: 'send failed' });
  assert.deepEqual(await w(), { state: 'closed', status: null, stage: null, reason: 'send failed' });
  // The claimer died after the commit stage ended: ended, nothing written.
  const claimedAt = Date.now() - 60000;
  writeD(repo.dir, 'demo-p1', { state: 'claimed', claimedBy: DEAD, claimedAt });
  taskEvents(repo.dir, 'demo-p1', [{ ev: 'end', text: 'e', stage: 'commit', status: 'COMMITTED' }]);
  assert.deepEqual(await w(), { state: 'ended', status: 'COMMITTED', stage: 'commit', reason: null });
  assert.equal(readD(repo.dir, 'demo-p1').state, 'claimed');
  // Gone: the claimer, or before a claim the target, is not running; the dispatch is closed.
  rmSync(path.join(repo.dir, '.am', 'demo-p1', 'progress.jsonl'));
  const gone = await w();
  assert.equal(gone.state, 'gone');
  assert.match(gone.reason, /the session that claimed it \(pid 102\) is not running/);
  assert.deepEqual([readD(repo.dir, 'demo-p1').state, readD(repo.dir, 'demo-p1').reason], ['closed', `gone: ${gone.reason}`]);
  assert.equal((await relay(repo, ['claim', 'demo-p1', id], asPid(OTHER))).json.claimed, false, 'a closed dispatch is not claimed');
  writeD(repo.dir, 'demo-p1', { target: { name: 'A', sessionId: 's-A', pid: DEAD } });
  assert.match((await w()).reason, /the target session \(pid 102\) is not running/);
  // Unclaimed for claimMs.
  writeD(repo.dir, 'demo-p1', { t: Date.now() - 5000 });
  assert.equal((await w({ claimMs: 1000 })).state, 'unclaimed');
  assert.match(readD(repo.dir, 'demo-p1').reason, /^unclaimed: /);
  // Stale: claimed by a live session but nothing touched for agentStaleMs.
  writeD(repo.dir, 'demo-p1', { state: 'claimed', claimedBy: OTHER, claimedAt: Date.now() });
  const old = new Date(Date.now() - AGENT_STALE_MS - 60000);
  utimesSync(dispatchFile(repo.dir), old, old);
  assert.equal((await w()).state, 'stale');
  assert.match((await relay(repo, ['start', 'do', 'demo-p1', '--part', '--dispatch', id], asPid(OTHER))).json.error, /the dispatch is closed, not claimed/);
  // A stage that started while wait waited for the lock keeps the claim: staleness is checked again under the lock.
  writeD(repo.dir, 'demo-p1', { state: 'claimed', claimedBy: OTHER, claimedAt: Date.now() });
  utimesSync(dispatchFile(repo.dir), old, old);
  const lockFile = path.join(repo.dir, '.am', '.admission.lock');
  const stageFile = path.join(repo.dir, '.am', 'demo-p1', AGENT_RECORD);
  writeFileSync(lockFile, JSON.stringify({ pid: OTHER, t: Date.now() }));
  setTimeout(() => {
    writeFileSync(stageFile, '{}');
    rmSync(lockFile);
  }, 100);
  assert.equal((await w({ lockWaitMs: 2000, relayWaitMs: 600 })).state, 'running');
  assert.equal(readD(repo.dir, 'demo-p1').state, 'claimed', 'not closed');
  rmSync(stageFile);
  // Running: a live claim past the wait.
  writeD(repo.dir, 'demo-p1', { state: 'claimed', claimedBy: OTHER, claimedAt: Date.now() });
  const began = Date.now();
  assert.deepEqual(await w({ relayWaitMs: 100 }), { state: 'running', status: null, stage: null, reason: null });
  assert.ok(Date.now() - began >= 90);
  // An open dispatch whose target is alive, within claimMs: running too.
  writeD(repo.dir, 'demo-p1', {});
  assert.equal((await w()).state, 'running');
  // Superseded: another id, or no record.
  writeD(repo.dir, 'demo-p1', { id: 'x2-abcdef' });
  assert.deepEqual(await w(), { state: 'closed', status: null, stage: null, reason: 'superseded' });
  assert.equal(readD(repo.dir, 'demo-p1').state, 'open', 'the newer dispatch is left alone');
  rmSync(dispatchFile(repo.dir));
  assert.equal((await w()).reason, 'superseded');
  // An unreadable record is looked at again.
  writeFileSync(dispatchFile(repo.dir), '{');
  assert.equal((await w()).state, 'running');
  assert.equal((await relay(repo, ['wait', 'demo-p1'])).code, 1);
});
