// Run: node --test tests/orchestrator-rewrite.test.mjs
// 설정 없이 빌드가 다시 쓴 파일과 git add -N 테스트. 공통 도우미·전체 명령은 tests/orchestrator-helpers.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { makeRepo, prepared, TWO, committedFiles } from './orchestrator-helpers.mjs';

// ------------------------------------------------------------------ 빌드 도구가 다시 쓰는 파일

test('doctor: 깨끗한 트리에서 게이트가 다시 쓴 추적 파일을 알려 주고 되돌려 둔다', () => {
  const r = makeRepo({ churn: true });
  const d = r.orch('doctor');
  assert.equal(d.code, 0, d.out);
  assert.match(d.out, /게이트가 추적 중인 파일 1개를 다시 썼습니다\(되돌려 둠\): settings\.asset[\s\S]*volatilePaths/);
  assert.equal(r.g('status', '--porcelain').trim(), '');
  r.setConfig({ volatilePaths: ['settings.asset'] });
  assert.match(r.orch('doctor').out, /게이트가 다시 쓰는 파일 1개는 volatilePaths 로 처리됩니다/);
});

test('설정 없이도: 오케스트레이터의 게이트와 커밋 훅의 빌드가 다시 쓴 파일은 되돌리고 막지 않는다', () => {
  const r = prepared({ plan: TWO(), churn: true, scenario: { commitRunsGate: true } });
  const run = r.orch('run');
  assert.equal(run.code, 0, run.out);
  assert.deepEqual(r.statusOf(), { T01: 'done', T02: 'done' });
  assert.ok(!committedFiles(r).includes('settings.asset'), '빌드가 다시 쓴 값은 커밋에 들어가지 않는다');
  assert.equal(r.g('status', '--porcelain').trim(), '');
  assert.match(run.out, /커밋 중 게이트가 다시 쓴 파일 1개를 되돌림: settings\.asset/);
  assert.ok(r.state().restored['settings.asset'] >= 2);
  assert.match(readFileSync(path.join(r.runDir(), 'T01', 'restored-1.patch'), 'utf8'), /\+prefilter: 2/);
  assert.match(readFileSync(path.join(r.runDir(), 'report.md'), 'utf8'), /빌드 도구가 다시 써서 되돌린 파일[\s\S]*settings\.asset \(\d+번\) — volatilePaths 에 없음/);
});

test('설정 없이: 세션 안의 빌드가 다시 쓴 파일은 작업의 커밋에 함께 들어가고 막지 않는다', () => {
  const r = prepared({ plan: TWO(), churn: true, scenario: { checkRunsGate: true, commitRunsGate: true } });
  const run = r.orch('run');
  assert.equal(run.code, 0, run.out);
  assert.equal(committedFiles(r).filter((f) => f === 'settings.asset').length, 1, '첫 작업의 커밋에 한 번 들어가고 그 뒤로는 바뀌지 않는다');
  assert.match(r.state().tasks.T01.notes.join('\n'), /예상 파일 밖 변경 1개: settings\.asset/);
});

test('점검 세션이 git add -N 을 해 둔 상태에서도 게이트·커밋 훅이 다시 쓴 파일을 가려 되돌린다', () => {
  // git stash create 는 intent-to-add 항목이 있으면 실패한다. 스냅샷이 그 방식이면 이 보호가 조용히 꺼진다.
  const scenario = { checkAddsIntent: true, commitRunsGate: true };
  const a = prepared({ plan: TWO(), churn: true, scenario });
  const run = a.orch('run');
  assert.equal(run.code, 0, run.out);
  assert.deepEqual(a.statusOf(), { T01: 'done', T02: 'done' });
  assert.ok(!committedFiles(a).includes('settings.asset'));
  assert.match(run.out, /커밋 중 게이트가 다시 쓴 파일 1개를 되돌림: settings\.asset/);
  assert.equal(a.g('status', '--porcelain').trim(), '');
  const b = prepared({ plan: TWO(), churn: true, config: { volatilePaths: ['settings.asset'] }, scenario: { ...scenario, checkRunsGate: true } });
  assert.equal(b.orch('run').code, 0);
  assert.ok(!committedFiles(b).includes('settings.asset'));
});
