// Run: node --test tests/agent-stage.test.mjs
// The am:lean stage starter and ender: start (lock, waits, records, rules and skill files, model and effort), end
// (runId, once, under the lock), card and answer (the cards and answers as written).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANSWER_LINE, CARD_ANSWERED, CARD_END, CARD_OPEN, MAX_ANSWER_BYTES, findCards, main, newRunId, startArgs } from '../auto/scripts/agent-stage.mjs';
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
  assert.deepEqual(startArgs(['do', 'demo', '--fix', '--push']), { stage: 'do', slug: 'demo', push: true, fix: true, part: false });
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
