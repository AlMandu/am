// Run: node --test tests/handover.test.mjs
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { countDone, decide, readPlan, withinOneRun } from '../plugin/hooks/handover.mjs';

const LARGE = '# t\n## 요약\n- 규모: 구현 2회, 커밋 3개\n## 단계\n1. 첫 단계. 확인: x\n## 변경 기록\n';
const SMALL = '# t\n## Summary\n- Scale: 1 implementation run, 1 commit\n## Steps\n1. Step. Check: x\n## Change log\n';
const FIXED = '- Hand-over: am-orchestrator run skill, run 20261008-0900, start branch main\n';
// A plan's own text that names the hand-over pieces outside a hand-over line (e.g. a step about the test files).
const STEP_MENTION = '5. `tests/orchestrator-skill.test.mjs`: pin that the am:auto hand-over line carries `run.id`. Check: x\n';
const STOP_LINE = '- BLOCKED (2026-10-08): the am-orchestrator run 20261008-1344 stopped; T03 is left in the tree.\n';
const SUMMARY_MENTION = '# t\n## Summary\n- Goal: am-orchestrator 로 넘김, run.id 20261007-1412\n## Steps\n1. a. Check: x\n## Change log\n';

const bases = [];
after(() => {
  let first;
  for (const base of bases) {
    try {
      rmSync(base, { recursive: true, force: true, maxRetries: 5 });
    } catch (err) {
      first ??= err;
    }
  }
  if (first) throw first;
});

function setup() {
  const base = mkdtempSync(path.join(tmpdir(), 'am-handover-'));
  bases.push(base);
  const repo = path.join(base, 'repo');
  mkdirSync(path.join(repo, '.git'), { recursive: true });
  return { repo, stateDir: path.join(base, 'state') };
}

function plan(repo, slug, text, mtime) {
  const file = path.join(repo, '.am', slug, 'plan.md');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  if (mtime) utimesSync(file, mtime, mtime);
  return file;
}

function hook(env, tool, file, { session = 's1', installed = true, calls } = {}) {
  const raw = JSON.stringify({ session_id: session, cwd: env.repo, tool_name: tool, tool_input: { file_path: file } });
  const r = decide(raw, { stateDir: env.stateDir, installed: () => (calls && calls.push(1), installed) });
  assert.deepEqual(Object.keys(r), ['stdout']);
  if (!r.stdout) return null;
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  return out.hookSpecificOutput.permissionDecisionReason;
}

test('reads the scale line in both languages, done marks and the hand-over line', () => {
  assert.deepEqual(readPlan(LARGE), { scale: [2, 3], started: false, handedOver: false });
  assert.deepEqual(readPlan(SMALL), { scale: [1, 1], started: false, handedOver: false });
  assert.deepEqual(readPlan('Scale: 3 implementation runs, 2 commits').scale, [3, 2]);
  assert.equal(readPlan('no scale').scale, null);
  assert.equal(readPlan('## 단계\n1. 첫 단계. (완료) 확인: x\n').started, true);
  assert.equal(readPlan('## Steps\n2. Step two (done)\n').started, true);
  // The template's own rule text mentions marking a step done; it is not a mark.
  assert.equal(readPlan('> Rules: 2) run each step\'s check and mark the step done\n').started, false);
  assert.equal(readPlan('## 변경 기록\n- am-orchestrator run 스킬로 넘김: run.id 20261007-1412, 시작 브랜치 main\n').handedOver, true);
  // An older line without a start branch is no longer read as a hand-over: a step or a stop can say as much.
  assert.equal(readPlan('## Change log\n- 오케스트레이터에 넘김 (run 20261007-1412)\n').handedOver, false);
  assert.equal(readPlan('## Change log\n- 목표: am-orchestrator 의 토큰을 줄인다\n').handedOver, false);
  assert.equal(readPlan('## Change log\n- 20261007-1412 빌드 로그\n').handedOver, false);
  assert.equal(readPlan('## Change log\n- went to the am-orchestrator run skill, run.id fix-2, start branch main\n').handedOver, true);
});

test('the fixed hand-over line counts only under a Change log heading', () => {
  for (const head of ['## Change log', '## 변경 기록', '### Change log', '## Changelog', '## 변경 이력']) {
    assert.equal(readPlan(`# t\n## Steps\n1. a\n${head}\n${FIXED}`).handedOver, true, head);
  }
  assert.equal(readPlan(`# t\n## Change log\n- 2026-10-08 ${FIXED.slice(2)}`).handedOver, true);
  assert.equal(readPlan(`# t\n## Change log\n- 2026-10-08: ${FIXED.slice(2)}`).handedOver, true);
  assert.equal(readPlan(`# t\n## Change log\n## Next\n${FIXED}`).handedOver, false);
  assert.equal(readPlan(`# t\n## Steps\n${FIXED}## Change log\n`).handedOver, false);
  assert.equal(readPlan(`# t\n## Change log\n### Notes\n${FIXED}`).handedOver, true); // a sub-heading stays in the section
  assert.equal(readPlan(`# t\n### Change log\n## Next\n${FIXED}`).handedOver, false);
});

test('older hand-over lines of real plans count; a stop line does not', () => {
  const old = [
    '- am-orchestrator run 스킬로 넘김: run.id 20261007-1916, 시작 브랜치 main (작업 20개).',
    '- 구현을 am-orchestrator 의 run 스킬에 넘김: 실행 ID 20261008-0731, 시작 브랜치 main (작업 5개).',
    '- 구현을 am-orchestrator 의 run 스킬(오케스트레이터)에 넘겼다: run id 20261008-1344, 시작 브랜치 main. 작업 7개(T01~T07, 작업마다 커밋 1개)로 나뉘었고 서로 무관한 작업은 최대 3개까지 동시에 돈다.',
  ];
  const stop = '- 멈춤(2026-10-08): 다시 이어 간 구현 명령이 PC 메모리 부족으로 Claude Code 에 의해 또 중단됐다(명령 자체의 실패가 아님). 그 시점까지 T01(383b24f)과 T02(d06ebe4)가 브랜치 `orch/20261008-1344` 에 커밋됐고, T03 의 변경(오케스트레이터 스크립트와 테스트)은 작업 트리에 커밋되지 않은 채 있다. 사용자가 요청하면 같은 slug 로 이어 간다.';
  for (const line of old) assert.equal(readPlan(`# t\n## 변경 기록\n${line}\n`).handedOver, true, line);
  assert.equal(readPlan(`# t\n## Change log\n${stop}\n`).handedOver, false);
  assert.equal(readPlan(`# t\n## Change log\n${old[2]}\n${stop}\n`).handedOver, true); // a later stop keeps the hand-over
  assert.equal(readPlan(`# t\n## Change log\n${FIXED}${STOP_LINE}`).handedOver, true);
});

test('mentions of the hand-over outside a Change log hand-over line are not a hand-over', () => {
  assert.equal(readPlan(`# t\n## Steps\n${STEP_MENTION}## Change log\n`).handedOver, false);
  assert.equal(readPlan(`# t\n## Steps\n1. a. Check: x\n## Change log\n${STOP_LINE}`).handedOver, false);
  assert.equal(readPlan(SUMMARY_MENTION).handedOver, false);
  const env = setup();
  plan(env.repo, 'big', LARGE.replace('## 요약\n', `## 요약\n- 목표: am-orchestrator 로 넘김, run.id 20261007-1412\n`));
  assert.ok(hook(env, 'Edit', path.join(env.repo, 'a.js')));
});

test('am:plan keeps the Change log heading in English, where readPlan looks for the hand-over line', () => {
  const skill = readFileSync(new URL('../plugin/skills/plan/SKILL.md', import.meta.url), 'utf8');
  assert.match(skill, /translated headings, except `## Change log`, which stays in English/);
  const head = /^\s*(## Change log)\s*$/m.exec(skill);
  assert.ok(head, 'the skeleton has the heading');
  assert.equal(readPlan(`# t\n${head[1]}\n${FIXED}`).handedOver, true);
});

test('countDone counts the done marks of both languages and leaves readPlan as it was', () => {
  assert.equal(countDone(LARGE), 0);
  assert.equal(countDone(SMALL), 0);
  const mixed = '# t\n## 요약\n- 규모: 구현 2회, 커밋 3개\n## 단계\n1. 첫 단계. (완료) 확인: x\n2. Step two (done)\n3. 셋째 단계. 확인: y\n4. Step four (DONE)\n## 변경 기록\n';
  const before = readPlan(mixed);
  assert.equal(countDone(mixed), 3);
  assert.equal(countDone(mixed), 3); // the counting copy keeps no position between calls
  assert.deepEqual(readPlan(mixed), before);
  assert.deepEqual(readPlan(mixed), { scale: [2, 3], started: true, handedOver: false });
  // The template's own rule text mentions marking a step done; it is not a mark.
  assert.equal(countDone('> Rules: 2) run each step\'s check and mark the step done\n1. Step. Check: x\n'), 0);
  const plain = readPlan(LARGE);
  countDone(LARGE);
  assert.deepEqual(readPlan(LARGE), plain);
});

test('withinOneRun is true only for at most 1 implementation run and 1 commit', () => {
  for (const scale of [[1, 1], [0, 1], [1, 0]]) assert.ok(withinOneRun(scale), String(scale));
  for (const scale of [[2, 1], [1, 2], null]) assert.ok(!withinOneRun(scale), String(scale));
  assert.ok(withinOneRun(readPlan(SMALL).scale));
  assert.ok(!withinOneRun(readPlan(LARGE).scale));
});

test('denies an edit while this session\'s large plan is neither handed over nor started', () => {
  const env = setup();
  const p = path.join(env.repo, '.am', 'big', 'plan.md');
  assert.equal(hook(env, 'Write', p), null); // creating the plan binds it
  plan(env.repo, 'big', LARGE);
  const reason = hook(env, 'Edit', path.join(env.repo, 'src', 'a.js'));
  assert.match(reason, /\.am\/big\/plan\.md \(the plan this session created\) says 2 implementation runs and 3 commits/);
  assert.match(reason, /hand this plan over to the run skill/);
  assert.ok(hook(env, 'Write', path.join(env.repo, 'b.txt')));
  assert.ok(hook(env, 'MultiEdit', path.join(env.repo, 'c.txt')));
  assert.ok(existsSync(path.join(env.stateDir, 's1.json')));
});

test('lets through what a hand-over writes, reads, other tools and files outside a repository', () => {
  const env = setup();
  plan(env.repo, 'big', LARGE);
  for (const f of ['.am/big/opinion-1.md', '.am/.gitignore', '.orchestrator/config.json', '.orchestrator/tasks.json', 'am-gate.json']) {
    assert.equal(hook(env, 'Write', path.join(env.repo, f)), null, f);
  }
  assert.equal(hook(env, 'Read', path.join(env.repo, 'src', 'a.js')), null);
  const raw = JSON.stringify({ session_id: 's1', cwd: env.repo, tool_name: 'Bash', tool_input: { command: 'echo x > src/a.js' } });
  assert.equal(decide(raw, { stateDir: env.stateDir, installed: () => true }).stdout, '');
  assert.equal(hook(env, 'Write', path.join(path.dirname(env.repo), 'outside.txt')), null);
  assert.equal(decide('not json', { stateDir: env.stateDir }).stdout, '');
});

test('allows a small plan, a started plan, a handed-over plan and a missing orchestrator', () => {
  const env = setup();
  const file = plan(env.repo, 'p', SMALL);
  const edit = (o) => hook(env, 'Edit', path.join(env.repo, 'a.js'), o);
  assert.equal(edit(), null);
  writeFileSync(file, LARGE.replace('1. 첫 단계.', '1. 첫 단계. (완료)'));
  assert.equal(edit(), null);
  writeFileSync(file, LARGE + '- am-orchestrator run 스킬로 넘김, run.id 20261007-1412, 시작 브랜치 main\n');
  assert.equal(edit(), null);
  writeFileSync(file, LARGE);
  assert.equal(edit({ session: 'other', installed: false }), null);
  assert.ok(edit({ session: 'third' }));
});

test('checks installation once per session and only when a plan would be blocked', () => {
  const env = setup();
  const file = plan(env.repo, 'p', SMALL);
  const calls = [];
  hook(env, 'Edit', path.join(env.repo, 'a.js'), { calls });
  assert.equal(calls.length, 0);
  writeFileSync(file, LARGE);
  hook(env, 'Edit', path.join(env.repo, 'a.js'), { calls });
  hook(env, 'Edit', path.join(env.repo, 'b.js'), { calls });
  assert.equal(calls.length, 1);
});

test('a plan without a scale line is denied once', () => {
  const env = setup();
  plan(env.repo, 'p', '# t\n## 단계\n1. a\n');
  hook(env, 'Read', path.join(env.repo, '.am', 'p', 'plan.md'));
  assert.match(hook(env, 'Edit', path.join(env.repo, 'a.js')), /\.am\/p\/plan\.md \(the plan this session read\) has no Scale line/);
  assert.equal(hook(env, 'Edit', path.join(env.repo, 'a.js')), null);
});

test('judges the session\'s own plan, not a newer one, and ranks created over edited over read', () => {
  const env = setup();
  const old = Date.now() / 1000 - 3600;
  plan(env.repo, 'mine', SMALL, old);
  plan(env.repo, 'other', LARGE); // newer, e.g. an orchestrator task plan or another session's
  hook(env, 'Read', path.join(env.repo, '.am', 'mine', 'plan.md'));
  assert.equal(hook(env, 'Edit', path.join(env.repo, 'a.js')), null);
  // Without a bound plan the newest decides, and the reason says how to bind.
  assert.match(hook(env, 'Edit', path.join(env.repo, 'a.js'), { session: 's2' }), /\.am\/other\/plan\.md \(the newest plan: this session has not read, edited or created one yet; if it is not yours, read or edit your own plan\.md first/);
  // An edit outranks a read; a later read does not move the binding.
  hook(env, 'Read', path.join(env.repo, '.am', 'other', 'plan.md'), { session: 's3' });
  hook(env, 'Edit', path.join(env.repo, '.am', 'mine', 'plan.md'), { session: 's3' });
  hook(env, 'Read', path.join(env.repo, '.am', 'other', 'plan.md'), { session: 's3' });
  assert.equal(hook(env, 'Edit', path.join(env.repo, 'a.js'), { session: 's3' }), null);
});

test('a later am:auto in the same session takes over the binding; a task plan without a scale line does not', () => {
  const env = setup();
  const write = (slug, text) => {
    const file = path.join(env.repo, '.am', slug, 'plan.md');
    assert.equal(decide(JSON.stringify({ session_id: 's1', cwd: env.repo, tool_name: 'Write', tool_input: { file_path: file, content: text } }), { stateDir: env.stateDir, installed: () => true }).stdout, '');
    plan(env.repo, slug, text);
  };
  write('big', LARGE);
  assert.ok(hook(env, 'Edit', path.join(env.repo, 'a.js')));
  write('small', SMALL); // a second am:auto request, stopped first one
  assert.equal(hook(env, 'Edit', path.join(env.repo, 'a.js')), null);
  write('big2', LARGE);
  assert.ok(hook(env, 'Edit', path.join(env.repo, 'a.js')));
  // Editing a plan that has no scale line (an orchestrator task plan) keeps the binding.
  const task = plan(env.repo, 'task-1', '# task\n## 단계\n1. a\n');
  const raw = JSON.stringify({ session_id: 's1', cwd: env.repo, tool_name: 'Edit', tool_input: { file_path: task, old_string: 'a', new_string: 'b' } });
  decide(raw, { stateDir: env.stateDir, installed: () => true });
  assert.match(hook(env, 'Edit', path.join(env.repo, 'a.js')), /\.am\/big2\/plan\.md/);
});

test('lets through edits in the run\'s task worktrees, which have their own .git', () => {
  const env = setup();
  plan(env.repo, 'big', LARGE);
  const wt = path.join(env.repo, '.orchestrator', 'wt', '20261007-1412', 'T01');
  mkdirSync(wt, { recursive: true });
  writeFileSync(path.join(wt, '.git'), 'gitdir: x\n');
  plan(wt, 'task-1', '# task\n');
  assert.equal(hook(env, 'Edit', path.join(wt, 'src', 'a.js')), null);
  assert.equal(hook(env, 'Edit', path.join(wt, '.am', 'task-1', 'plan.md')), null);
  assert.ok(hook(env, 'Edit', path.join(env.repo, 'src', 'a.js')));
});
