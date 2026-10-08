// Run: node --test tests/orchestrator-plan.test.mjs
// 계획 단계(너무 큰 작업 나누기, 결정, split 형식, 계획 저장) 테스트. 공통 도우미·전체 명령은 tests/orchestrator-helpers.mjs
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { task, planOf, CHAIN, makeRepo, prepared, statusJson } from './orchestrator-helpers.mjs';

// ------------------------------------------------------------------ 흐름

test('계획이 "너무 크다"고 하면 하위 작업으로 나눠 진행한다', () => {
  const r = prepared({ scenario: { plan: { 't02-b': ['TOO_BIG'] } } });
  const run = r.orch('run');
  assert.equal(run.code, 0, run.out);
  assert.deepEqual(r.statusOf(), { T01: 'done', T02: 'split', 'T02.1': 'done', 'T02.2': 'done', T03: 'done' });
  const plan = JSON.parse(readFileSync(path.join(r.runDir(), 'tasks.json'), 'utf8'));
  assert.deepEqual(plan.tasks.map((t) => t.id), ['T01', 'T02.1', 'T02.2', 'T03']);
  assert.equal(plan.splitHistory[0].id, 'T02');
});

test('재분할 깊이 한도에 닿으면 막힘으로 남긴다', () => {
  const r = prepared({ plan: planOf([task('T01', 't01-a')]), scenario: { plan: { 't01-a': ['TOO_BIG'], 't01-a-1-core': ['TOO_BIG'] } } });
  assert.equal(r.orch('run').code, 1);
  assert.equal(r.statusOf()['T01.1'], 'blocked');
  assert.match(r.state().tasks['T01.1'].reason, /깊이 한도/);
});

test('결정: 미리 뽑힌 결정과 계획 중 나온 결정 모두 답해야 풀린다', () => {
  const plan = planOf([task('T01', 't01-a'), task('T02', 't02-b', ['T01']), task('T03', 't03-c')], [{ id: 'D1', what: '첫 화면을 무엇으로 할까', whyNow: '화면 구성이 달라짐', options: [{ label: '목록', effect: '목록이 먼저' }, { label: '상세', effect: '상세가 먼저' }], recommended: '목록', undo: 'easy', blocks: ['T03'], answer: null }]);
  const r = prepared({ plan, scenario: { plan: { 't01-a': ['NEEDS_DECISION'] } } });
  assert.match(readFileSync(path.join(r.runDir(), 'tasks.md'), 'utf8'), /D1\. 첫 화면을 무엇으로 할까[\s\S]*선택지 1\. \*\*목록\*\*/);
  const run = r.orch('run');
  assert.equal(run.code, 1, run.out);
  assert.deepEqual(r.statusOf(), { T01: 'needs-decision', T02: 'pending', T03: 'pending' });
  assert.match(r.orch('status').out, /T03\s+결정 대기\(D1\)/);
  const report = readFileSync(path.join(r.runDir(), 'report.md'), 'utf8');
  assert.match(report, /decide D1/);
  assert.match(report, /answer T01/);
  assert.match(readFileSync(path.join(r.runDir(), 'T01', 'decision.md'), 'utf8'), /which screen first/);
  assert.equal(r.orch('decide', 'D1', '목록으로').code, 0);
  const a = r.orch('answer', 'T01', '목록', '화면', '먼저');
  assert.equal(a.code, 0, a.out);
  assert.match(readFileSync(path.join(r.repo, '.am', 't01-a', 'answers.md'), 'utf8'), /목록 화면 먼저/);
  assert.equal(r.statusOf().T01, 'planned');
  const again = r.orch('run');
  assert.equal(again.code, 0, again.out);
  assert.deepEqual(r.statusOf(), { T01: 'done', T02: 'done', T03: 'done' });
  assert.match(readFileSync(path.join(r.repo, '.am', 't03-c', 'brief.md'), 'utf8'), /첫 화면을 무엇으로 할까 → 목록으로/);
});

test('split: 형식이 틀린 작업 목록은 같은 세션에 고쳐 달라고 다시 요청한다', () => {
  const bad = CHAIN();
  bad.tasks[1].size = 'L';
  const r = makeRepo({ fixtures: [bad, CHAIN()] });
  assert.equal(r.orch('doctor').code, 0);
  const s = r.orch('split', path.join(r.repo, 'docs', 'design.md'));
  assert.equal(s.code, 0, s.out);
  assert.match(s.out, /형식 오류 1개/);
  const retry = r.calls().find((c) => c.prompt.startsWith('tasks.json failed validation'));
  assert.ok(retry.argv.includes('--resume'));
  assert.match(readFileSync(path.join(r.runDir(), '_split', 'errors.txt'), 'utf8'), /"size" must be S or M/);
});

test('split: 끝내 형식을 못 맞추면 실행을 만들지 않는다', () => {
  const r = makeRepo({ fixtures: ['{ not json'] });
  assert.equal(r.orch('doctor').code, 0);
  const s = r.orch('split', path.join(r.repo, 'docs', 'design.md'));
  assert.equal(s.code, 2);
  assert.ok(!existsSync(path.join(r.repo, '.orchestrator', 'current')));
});

test('계획을 파일로 남기지 못하면 같은 세션에 저장을 다시 시킨다', () => {
  const r = prepared({ plan: planOf([task('T01', 't01-a')]), scenario: { plan: { 't01-a': ['NOSAVE'] } } });
  const run = r.orch('run');
  assert.equal(run.code, 0, run.out);
  const s = r.state().tasks.T01;
  assert.equal(s.status, 'done');
  const save = r.calls().find((c) => c.prompt.startsWith('The plan was not saved'));
  assert.equal(save.argv[save.argv.indexOf('--resume') + 1], s.sessions.plan);
  assert.match(s.notes.join('\n'), /plan 단계에서 권한 규칙에 걸린 명령 2건: Write: \/elsewhere\/t01-a\/plan\.md \| Bash: cat > /);
  const system = readFileSync(path.join(r.repo, r.calls().find((c) => c.prompt.startsWith('/am:plan Plan task')).argv.at(-1)), 'utf8');
  assert.match(system, /only with the Write or Edit tool[\s\S]*A refusal is never a reason to leave the plan unsaved/);
});

test('다시 시켜도 저장하지 못하면 "결정 필요"가 아니라 막힘으로 남기고, 사유와 이어 가는 방법을 적는다', () => {
  const r = prepared({ plan: planOf([task('T01', 't01-a'), task('T02', 't02-b', ['T01'])]), scenario: { plan: { 't01-a': ['NOSAVE', 'READY'] }, planSave: 'FAIL' } });
  assert.equal(r.orch('run').code, 1);
  const s = r.state().tasks.T01;
  assert.equal(s.status, 'blocked');
  assert.equal(s.blockedAt, 'plan');
  assert.match(s.reason, /파일로 저장하지 못했습니다\. 권한 규칙에 걸린 명령: Write: \/elsewhere\/t01-a\/plan\.md/);
  assert.match(readFileSync(path.join(r.runDir(), 'T01', 'plan-reply.md'), 'utf8'), /plan body that could not be saved/);
  const report = readFileSync(path.join(r.runDir(), 'report.md'), 'utf8');
  assert.match(report, /retry T01 --from plan[\s\S]*\.am\/t01-a\/plan\.md[\s\S]*retry T01 --from implement/);
  // 길 1: 사람이 계획을 직접 저장하고 구현부터 이어 간다
  writeFileSync(path.join(r.repo, '.am', 't01-a', 'plan.md'), '# 손으로 저장한 계획\n');
  assert.equal(r.orch('retry', 'T01', '--from', 'implement').code, 0);
  const again = r.orch('run');
  assert.equal(again.code, 0, again.out);
  assert.deepEqual(r.statusOf(), { T01: 'done', T02: 'done' });
  assert.equal(r.calls().filter((c) => c.prompt.startsWith('/am:plan Plan task T01')).length, 1, '계획 세션을 다시 돌리지 않는다');
});

test('계획 저장 실패 뒤 retry --from plan 은 계획을 처음부터 다시 세운다', () => {
  const r = prepared({ plan: planOf([task('T01', 't01-a')]), scenario: { plan: { 't01-a': ['NOSAVE', 'READY'] }, planSave: 'FAIL' } });
  assert.equal(r.orch('run').code, 1);
  assert.equal(r.orch('retry', 'T01', '--from', 'plan').code, 0);
  assert.equal(r.orch('run').code, 0);
  assert.equal(r.statusOf().T01, 'done');
  assert.equal(r.calls().filter((c) => c.prompt.startsWith('/am:plan Plan task T01')).length, 2);
});

// ------------------------------------------------------------------ 스킬이 몰기 위한 기능: status --json, 잠금, am 찾기

test('answer 뒤 "너무 크다"던 작업을 나누지 못하면 계획 단계에서 막히고, 안내는 계획부터 다시를 가리킨다', () => {
  const r = prepared({ plan: planOf([task('T01', 't01-a')]), scenario: { plan: { 't01-a': ['NEEDS_DECISION'] }, answer: { 't01-a': ['TOO_BIG'] } } });
  assert.equal(r.orch('run').code, 1);
  assert.equal(r.statusOf().T01, 'needs-decision');
  r.orch('answer', 'T01', 'x');
  const s = r.state().tasks.T01;
  assert.deepEqual([s.status, s.blockedAt], ['blocked', 'plan']);
  assert.match(s.reason, /split\.json/);
  const st = statusJson(r);
  assert.deepEqual(st.blocked.map((b) => [b.id, b.stage]), [['T01', 'plan']]);
  assert.match(st.blocked[0].hint, /retry T01 --from plan/);
  assert.match(readFileSync(path.join(r.repo, st.run.report), 'utf8'), /이어 가기: .*--from plan/);
});
