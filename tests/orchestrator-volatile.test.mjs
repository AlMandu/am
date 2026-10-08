// Run: node --test tests/orchestrator-volatile.test.mjs
// volatilePaths 와 커밋 세션의 빌드 산출물 되돌림 테스트. 공통 도우미·전체 명령은 tests/orchestrator-helpers.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { task, prepared, TWO, committedFiles } from './orchestrator-helpers.mjs';

// ------------------------------------------------------------------ 빌드 도구가 다시 쓰는 파일

test('volatilePaths: 세션 안의 빌드가 다시 쓴 파일도 게이트가 같은 내용을 만들면 커밋하지 않고 되돌린다', () => {
  const r = prepared({ plan: TWO(), churn: true, config: { volatilePaths: ['settings.asset'] }, scenario: { checkRunsGate: true, commitRunsGate: true } });
  const run = r.orch('run');
  assert.equal(run.code, 0, run.out);
  assert.deepEqual(r.statusOf(), { T01: 'done', T02: 'done' });
  assert.ok(!committedFiles(r).includes('settings.asset'));
  assert.equal(r.g('status', '--porcelain').trim(), '');
  assert.equal(r.g('show', 'HEAD:settings.asset'), 'prefilter: 0\n');
  assert.match(run.out, /빌드 도구가 다시 쓴 파일 1개를 되돌림: settings\.asset/);
  assert.equal(r.calls().filter((c) => c.prompt.startsWith('/am:check')).length, 2, '가려내기는 원래 돌리던 게이트로 하므로 세션이 늘지 않는다');
  const sys = (prefix) => readFileSync(path.join(r.repo, r.calls().find((c) => c.prompt.startsWith(prefix)).argv.at(-1)), 'utf8');
  assert.match(sys('/am:check'), /Build tools rewrite these files on every build: settings\.asset\. Changes in them that the plan does not call for are build output/);
  assert.match(sys(`/am:do t01-a`), /Build tools rewrite these files on every build: settings\.asset/);
  assert.match(sys('/am:commit'), /A file that becomes modified only after your first git commit is the gate's doing/);
  assert.match(readFileSync(path.join(r.runDir(), 'report.md'), 'utf8'), /settings\.asset \(\d+번\)\n/);
});

test('volatilePaths: 작업이 그 파일을 실제로 고쳤으면(게이트가 같은 내용을 못 만들면) 버리지 않고 커밋한다', () => {
  const r = prepared({ plan: TWO(), churn: true, config: { volatilePaths: ['settings.asset'] }, scenario: { editVolatile: ['t01-a'], checkRunsGate: true, commitRunsGate: true } });
  const run = r.orch('run');
  assert.equal(run.code, 0, run.out);
  assert.deepEqual(r.statusOf(), { T01: 'done', T02: 'done' });
  assert.equal(r.g('show', 'HEAD:settings.asset'), 'prefilter: 2\nshadows: on\n', '작업의 수정이 커밋에 남는다');
  assert.match(r.state().tasks.T01.notes.join('\n'), /settings\.asset: volatilePaths 파일이지만 게이트가 같은 내용을 만들지 않아 작업의 변경으로 두었습니다/);
  assert.equal(r.g('status', '--porcelain').trim(), '');
});

test('커밋 세션이 점검이 지목한 빌드 산출물을 되돌리고 알리면 기록으로 남긴다', () => {
  const r = prepared({ plan: TWO(), churn: true, scenario: { checkRunsGate: true, commit: { 't01-a': ['RESTORE'] } } });
  const run = r.orch('run');
  assert.equal(run.code, 0, run.out);
  assert.equal(r.g('show', 'HEAD:settings.asset').startsWith('prefilter:'), true);
  assert.ok(!r.g('show', '--name-only', '--format=', 'HEAD~1').includes('settings.asset'), '되돌린 파일은 그 작업의 커밋에 없다');
  assert.match(r.state().tasks.T01.notes.join('\n'), /커밋 세션이 빌드 산출물로 보고 커밋에서 빼고 되돌린 파일 1개: settings\.asset/);
  const sys = readFileSync(path.join(r.repo, r.calls().find((c) => c.prompt.startsWith('/am:commit')).argv.at(-1)), 'utf8');
  assert.match(sys, /Do not commit build output: restore it with git restore -- <paths>[\s\S]*ORCH_RESTORED: <path>/);
  assert.match(readFileSync(path.join(r.runDir(), 'report.md'), 'utf8'), /빌드 도구가 다시 써서 되돌린 파일[\s\S]*settings\.asset/);
});

test('커밋 세션이 변경을 남겨 두면 막히고, volatilePaths 에 적은 뒤 done 또는 retry --from commit 으로 이어 간다', () => {
  const scenario = { checkRunsGate: true, commit: { 't01-a': ['LEAVE'] } };
  const a = prepared({ plan: TWO(), churn: true, scenario });
  assert.equal(a.orch('run').code, 1);
  const s = a.state().tasks.T01;
  assert.equal(s.status, 'blocked');
  assert.equal(s.blockedAt, 'commit');
  assert.match(s.reason, /커밋 뒤에도 변경 1개가 남았습니다:  M settings\.asset\. 커밋 세션의 설명: .*commit-reply\.md/);
  assert.equal(s.commits.length, 1);
  assert.match(readFileSync(path.join(a.runDir(), 'report.md'), 'utf8'), /volatilePaths[\s\S]*done T01/);
  assert.match(a.orch('done', 'T01').out, /커밋하지 않은 변경이 남아 있습니다[\s\S]*settings\.asset/);
  a.setConfig({ volatilePaths: ['settings.asset'] });
  const done = a.orch('done', 'T01');
  assert.equal(done.code, 0, done.out);
  assert.match(done.out, /빌드 도구가 다시 쓴 파일\(volatilePaths\) 1개를 되돌림: settings\.asset/);
  assert.equal(a.state().tasks.T01.commits.length, 1, '같은 커밋을 두 번 세지 않는다');
  assert.equal(a.orch('run').code, 0);
  assert.deepEqual(a.statusOf(), { T01: 'done', T02: 'done' });
  assert.ok(!committedFiles(a).includes('settings.asset'));

  const b = prepared({ plan: TWO(), churn: true, scenario });
  assert.equal(b.orch('run').code, 1);
  b.setConfig({ volatilePaths: ['settings.asset'] });
  assert.equal(b.orch('retry', 'T01', '--from', 'commit').code, 0);
  const again = b.orch('run');
  assert.equal(again.code, 0, again.out);
  assert.deepEqual(b.statusOf(), { T01: 'done', T02: 'done' });
  assert.equal(b.calls().filter((c) => c.prompt.startsWith('/am:commit task T01')).length, 1, '이미 커밋된 작업은 커밋 세션을 다시 부르지 않는다');
  assert.ok(!committedFiles(b).includes('settings.asset'));
});
