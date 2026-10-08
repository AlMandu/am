// Run: node --test tests/orchestrator-commit.test.mjs
// 커밋 단계(안전장치, 권한 규칙, 커밋 훅 거부, 손으로 완료 처리) 테스트. 공통 도우미·전체 명령은 tests/orchestrator-helpers.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { task, planOf, own, prepared } from './orchestrator-helpers.mjs';

// ------------------------------------------------------------------ 흐름

test('안전장치: 계획 단계가 다른 파일을 건드리면 멈추고, 판정을 못 읽으면 커밋하지 않는다', () => {
  const a = prepared({ plan: planOf([task('T01', 't01-a')]), scenario: { plan: { 't01-a': ['STRAY'] } } });
  assert.equal(a.orch('run').code, 1);
  assert.match(a.state().tasks.T01.reason, /\.am\/ 밖의 파일/);
  const b = prepared({ plan: planOf([task('T01', 't01-a')]), scenario: { check: { 't01-a': ['SILENT'] } } });
  assert.equal(b.orch('run').code, 0, '표시 줄이 없으면 한 번 되물어 판정을 받는다');
  assert.ok(b.calls().some((c) => c.prompt.startsWith('Reply with exactly one line')));
  const c = prepared({ plan: planOf([task('T01', 't01-a')]), scenario: { check: { 't01-a': ['FILEONLY'] } } });
  assert.equal(c.orch('run').code, 0, '되물어도 답이 없으면 check.md 의 판정 줄을 읽는다');
  assert.equal(c.state().tasks.T01.verdict, 'NOTE');
});

test('커밋 명령이 권한 규칙에 걸리면 같은 세션에서 단순한 명령으로 한 번 다시 시킨다', () => {
  const r = prepared({ plan: planOf([task('T01', 't01-a')]), scenario: { commit: { 't01-a': ['DENIED'] } } });
  const run = r.orch('run');
  assert.equal(run.code, 0, run.out);
  const s = r.state().tasks.T01;
  assert.equal(s.status, 'done');
  assert.deepEqual(s.commits.map((c) => c.split(' ').slice(1).join(' ')), ['feat: fake commit after retry']);
  const retry = r.calls().find((c) => c.prompt.startsWith('Some of your commands were refused'));
  assert.equal(retry.argv[retry.argv.indexOf('--resume') + 1], s.sessions.commit);
  assert.match(s.notes.join('\n'), /commit 단계에서 권한 규칙에 걸린 명령 1건: Bash: git -C \/somewhere commit/);
  assert.match(readFileSync(path.join(r.runDir(), 'report.md'), 'utf8'), /권한 규칙에 걸린 명령 1건/);
  const system = readFileSync(path.join(r.repo, r.calls().find((c) => c.prompt.startsWith('/am:commit')).argv.at(-1)), 'utf8');
  assert.match(system, /No "git -C"[\s\S]*refused by the permission rules is a problem with the shape/);
});

test('다시 시켜도 권한에 걸리면 사유에 걸린 명령을 적고 멈춘다. retry --from commit 으로 이어 간다', () => {
  const r = prepared({ plan: planOf([task('T01', 't01-a')]), scenario: { commit: { 't01-a': ['DENIED', 'COMMITTED'] }, commitRetry: 'BLOCKED' } });
  assert.equal(r.orch('run').code, 1);
  const s = r.state().tasks.T01;
  assert.equal(s.status, 'blocked');
  assert.match(s.reason, /커밋 명령이 권한 규칙에 걸렸습니다: Bash: git -C \/somewhere commit/);
  assert.notEqual(r.g('diff', '--cached', '--name-only').trim(), '', '변경은 스테이징된 채 남는다');
  assert.equal(r.orch('retry', 'T01', '--from', 'commit').code, 0);
  const again = r.orch('run');
  assert.equal(again.code, 0, again.out);
  assert.equal(r.statusOf().T01, 'done');
  assert.equal(r.g('status', '--porcelain').trim(), '');
});

test('커밋에서 막힌 작업을 손으로 커밋한 뒤 done 으로 완료 처리하면 다음 작업이 이어진다', () => {
  const r = prepared({ plan: planOf([task('T01', 't01-a'), task('T02', 't02-b', ['T01'])]), scenario: { commit: { 't01-a': ['DENIED'] }, commitRetry: 'BLOCKED' } });
  assert.equal(r.orch('run').code, 1);
  assert.match(r.orch('done', 'T01').out, /커밋하지 않은 변경이 남아/);
  r.g('commit', '-q', '-m', 'feat: by hand');
  assert.equal(r.orch('done', 'T01').code, 0);
  assert.deepEqual(r.state().tasks.T01.commits.map((c) => c.split(' ').slice(1).join(' ')), ['feat: by hand']);
  assert.equal(r.orch('run').code, 0);
  assert.deepEqual(r.statusOf(), { T01: 'done', T02: 'done' });
});

test('커밋 훅이 커밋을 거부하면 구현 세션이 고치고 점검부터 다시 한 뒤 커밋한다', () => {
  const r = prepared({ plan: planOf([task('T01', 't01-a'), task('T02', 't02-b', ['T01'])]), scenario: { commit: { 't01-a': ['REJECT', 'COMMITTED'] } } });
  const run = r.orch('run');
  assert.equal(run.code, 0, run.out);
  assert.deepEqual(r.statusOf(), { T01: 'done', T02: 'done' });
  const s = r.state().tasks.T01;
  assert.equal(s.fixRounds, 1);
  assert.match(run.out, /커밋 훅이 커밋을 거부함: 구현 세션에 넘겨 고친 뒤 다시 점검/);
  const calls = r.calls();
  const fix = calls.find((c) => c.prompt.startsWith('The commit for this task did not go through'));
  assert.equal(fix.argv[fix.argv.indexOf('--resume') + 1], s.sessions.implement, '파일을 고칠 수 있는 구현 세션에 넘긴다');
  assert.match(fix.prompt, /Read \.orchestrator\/runs\/[^/]+\/T01\/commit-rejected-1\.md/);
  assert.match(readFileSync(path.join(r.runDir(), 'T01', 'commit-rejected-1.md'), 'utf8'), /R1 MODULE\.md must change together/);
  assert.equal(calls.filter((c) => c.prompt === '/am:check t01-a').length, 2, '고친 뒤 점검을 다시 거친다');
  assert.equal(calls.filter((c) => c.prompt.startsWith('/am:commit task T01')).length, 2);
  assert.ok(r.g('show', '--name-only', '--format=', 'HEAD~1').includes('MODULE.md'), '훅이 요구한 파일이 작업의 커밋에 들어간다');
  assert.match(s.notes.join('\n'), /커밋 훅이 한 번 거부해 고친 뒤 다시 점검했습니다/);
  const sys = (prefix) => readFileSync(path.join(r.repo, calls.find((c) => c.prompt.startsWith(prefix)).argv.at(-1)), 'utf8');
  assert.match(sys('Split the design document'), /commit rules: its pre-commit hooks[\s\S]*must pass the repository's commit hooks on its own/);
  assert.match(sys('/am:plan Plan task'), /Commit rules: this task is committed on its own[\s\S]*even when the brief's file list does not mention the file/);
  assert.match(sys('/am:check'), /would make the repository's commit hooks reject the commit is a confirmed defect: BLOCK/);
  assert.match(sys('/am:commit'), /do not use --no-verify[\s\S]*Copy what the hook printed into your final reply/);
});

test('고쳐도 커밋 훅이 계속 거부하면 훅이 한 말과 함께 멈춘다', () => {
  const r = prepared({ plan: planOf([task('T01', 't01-a')]), scenario: { commit: { 't01-a': ['REJECT'] } }, config: { maxFixRounds: 1 } });
  assert.equal(r.orch('run').code, 1);
  const s = r.state().tasks.T01;
  assert.equal(s.status, 'blocked');
  assert.equal(s.blockedAt, 'check');
  assert.match(s.reason, /수정을 1번 했지만 커밋 훅이 커밋을 거부했습니다\. 훅이 한 말: .*commit-rejected-2\.md/);
  assert.match(readFileSync(path.join(r.runDir(), 'report.md'), 'utf8'), /직접 고친 뒤 `retry T01 --from check`/);
  assert.equal(r.g('log', '--format=%s', 'main..HEAD').trim(), '', '거부된 커밋은 만들어지지 않는다');
});
