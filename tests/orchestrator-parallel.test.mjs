// Run: node --test tests/orchestrator-parallel.test.mjs
// 동시 진행(별도 작업 공간, 합치기 충돌, 막힘, status) 테스트. 공통 도우미·전체 명령은 tests/orchestrator-helpers.mjs
import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { task, planOf, own, PAR, sleep, makeRepo, prepared, statusJson } from './orchestrator-helpers.mjs';

// ------------------------------------------------------------------ 동시 진행

test('동시 진행: 서로 무관한 작업은 별도 작업 공간에서 함께 돌고, 끝나는 대로 실행 브랜치에 한 줄로 합친다', () => {
  // T01 의 구현은 T03 의 계획이 끝나야, T03 의 구현은 T01 의 커밋이 끝나야 시작한다: 하나씩 돌면 기다리다 실패한다
  const r = prepared({ plan: PAR(), scenario: { waitFor: { 'implement:t01-a': 'plan:t03-c', 'implement:t03-c': 'commit:t01-a' } } });
  assert.match(r.orch('run', '--dry-run').out, /동시 진행 최대 3개[\s\S]*1회차  T01[\s\S]*1회차  T03[\s\S]*2회차  T02/);
  const run = r.orch('run');
  assert.equal(run.code, 0, run.out);
  assert.deepEqual(r.statusOf(), { T01: 'done', T02: 'done', T03: 'done' });
  const log = r.g('log', '--format=%s', 'main..HEAD').trim().split('\n').reverse();
  assert.equal(log[0], 'feat(t01-a): fake commit');
  assert.deepEqual([...log].sort(), ['feat(t01-a): fake commit', 'feat(t02-b): fake commit', 'feat(t03-c): fake commit']);
  assert.equal(r.g('log', '--merges', '--format=%h', 'main..HEAD').trim(), '', '병합 커밋 없이 한 줄');
  assert.match(run.out, /\[T03\] 실행 브랜치의 새 커밋 위로 옮김: 게이트를 다시 돌림/, '먼저 합쳐진 T01 위로 옮겨 게이트를 다시 돌린다');
  const cwdOf = (prompt) => r.calls().find((c) => c.prompt === prompt).cwd;
  assert.equal(cwdOf('/am:plan Plan task T03 described in .am/t03-c/brief.md (slug t03-c)'), realpathSync(r.repo), '계획은 이 저장소에서');
  assert.match(cwdOf(`/am:do t01-a`), /[\\/]\.orchestrator[\\/]wt[\\/][^\\/]+[\\/]T01$/);
  assert.match(cwdOf(`/am:do t03-c`), /[\\/]\.orchestrator[\\/]wt[\\/][^\\/]+[\\/]T03$/);
  const hashes = r.g('log', '--format=%h', 'main..HEAD');
  assert.ok(hashes.includes(r.state().tasks.T03.commits[0].split(' ')[0]), '옮긴 뒤의 커밋 해시를 기록한다');
  assert.equal(r.g('worktree', 'list').trim().split('\n').length, 1, '작업 공간이 남지 않는다');
  assert.ok(!existsSync(path.join(r.repo, '.orchestrator', 'wt', path.basename(r.runDir()))));
  assert.equal(r.g('status', '--porcelain').trim(), '');
  const report = readFileSync(path.join(r.runDir(), 'report.md'), 'utf8');
  assert.match(report, /동시 진행: 서로 무관한 작업을 최대 3개까지/);
  assert.match(report, /사람 확인: t03-c 화면에서/, '작업 공간의 check.md 를 이 저장소로 되돌려 베낀다');
});

test('별도 작업 공간에서 게이트가 안 되면 doctor 가 알리고 하나씩 진행한다. worktreeSetup 으로 고치면 함께 돈다', () => {
  const r = makeRepo({ plan: PAR(), localOnly: true });
  const d = r.orch('doctor');
  assert.equal(d.code, 0, d.out);
  assert.match(d.out, /게이트 통과[\s\S]*별도 작업 공간\(git worktree\)에서는 게이트가 통과하지 않아 작업을 하나씩 진행합니다: 게이트 fail/);
  assert.equal(r.g('worktree', 'list').trim().split('\n').length, 1, '확인용 작업 공간은 지운다');
  assert.equal(r.orch('split', path.join(r.repo, 'docs', 'design.md')).code, 0);
  let st = statusJson(r);
  assert.equal(st.next, 'run', '확인했는데 안 되는 것은 doctor 로 돌려보내지 않는다');
  assert.equal(st.parallel.max, 1);
  assert.match(st.parallel.reason, /별도 작업 공간에서 게이트가 통과하지 않습니다/);
  const run = r.orch('run');
  assert.equal(run.code, 0, run.out);
  assert.match(run.out, /동시 진행 하나씩\n  하나씩 진행하는 이유: 별도 작업 공간에서 게이트가 통과하지 않습니다/);
  assert.ok(r.calls().every((c) => c.cwd === realpathSync(r.repo)));
  r.setConfig({ worktreeSetup: ['node setup.js'] });
  st = statusJson(r);
  assert.deepEqual([st.next, st.parallel.max, st.parallel.stale], ['done', 1, true], '설정이 바뀌면 다시 확인할 때까지 하나씩(next 는 그대로)');
  const d2 = r.orch('doctor');
  assert.equal(d2.code, 0, d2.out);
  assert.match(d2.out, /별도 작업 공간\(git worktree\)에서도 게이트 통과 \([\d.]+초\): 서로 무관한 작업을 최대 3개까지 동시에 진행합니다/);
  assert.deepEqual(statusJson(r).parallel, { max: 3, reason: '' });
});

test('합칠 때 충돌하면 변경을 patch 로 남기고, 실행 브랜치의 새 커밋 위에서 한 번 다시 구현한다', () => {
  const r = prepared({ plan: planOf([own('T01', 't01-a'), own('T03', 't03-c')]), scenario: { conflictFile: ['t01-a', 't03-c'], waitFor: { 'implement:t01-a': 'plan:t03-c', 'implement:t03-c': 'commit:t01-a' } } });
  const run = r.orch('run');
  assert.equal(run.code, 0, run.out);
  assert.deepEqual(r.statusOf(), { T01: 'done', T03: 'done' });
  const s = r.state().tasks.T03;
  assert.equal(s.attempts.integrate, 1);
  assert.match(s.notes.join('\n'), /먼저 합쳐진 작업과 충돌했습니다: 변경을 \.orchestrator\/runs\/[^ ]+\/T03\/integrate-1\.patch 에 남기고/);
  assert.match(readFileSync(path.join(r.runDir(), 'T03', 'integrate-1.patch'), 'utf8'), /\+from t03-c/);
  const impls = r.calls().filter((c) => c.prompt === `/am:do t03-c`);
  assert.equal(impls.length, 2, '구현을 한 번 더 한다');
  const sys = impls[1].argv[impls[1].argv.indexOf('--append-system-prompt-file') + 1];
  assert.match(readFileSync(path.resolve(impls[1].cwd, sys), 'utf8'), /could not be combined with work that other tasks committed[\s\S]*integrate-1\.patch/);
  assert.equal(r.g('show', 'HEAD:shared.txt').trim(), 'from t03-c');
  assert.equal(r.g('worktree', 'list').trim().split('\n').length, 1);
});

test('별도 작업 공간에서 막히면 새 작업은 시작하지 않고 그 폴더를 알려 준다. retry 뒤 같은 폴더에서 이어 간다', () => {
  const r = prepared({ plan: PAR(), scenario: { implement: { 't03-c': ['BLOCKED', 'DONE'] }, waitFor: { 'implement:t01-a': 'plan:t03-c', 'commit:t01-a': 'implement:t03-c' } } });
  const run = r.orch('run');
  assert.equal(run.code, 1, run.out);
  assert.deepEqual(r.statusOf(), { T01: 'done', T02: 'pending', T03: 'blocked' });
  assert.match(run.out, /T03 에서 막혀 멈췄습니다\. 돌고 있던 작업은 끝까지 진행했습니다/);
  const st = statusJson(r);
  assert.equal(st.next, 'blocked');
  const ws = st.blocked[0].workspace;
  assert.match(ws, /^\.orchestrator\/wt\/[^/]+\/T03$/);
  assert.ok(st.blocked[0].hint.startsWith(`변경은 별도 작업 공간 \`${ws}\` 에 있습니다`), st.blocked[0].hint);
  assert.match(readFileSync(path.join(r.repo, ws, 'src', 't03-c.txt'), 'utf8'), /partial/);
  assert.match(readFileSync(path.join(r.runDir(), 'report.md'), 'utf8'), new RegExp(`변경은 별도 작업 공간 \`${ws.replace(/\./g, '\\.')}\``));
  assert.equal(r.g('status', '--porcelain').trim(), '', '이 저장소는 깨끗하다');
  assert.equal(r.orch('retry', 'T03', '--from', 'implement').code, 0);
  const again = r.orch('run');
  assert.equal(again.code, 0, again.out);
  assert.deepEqual(r.statusOf(), { T01: 'done', T02: 'done', T03: 'done' });
  const impls = r.calls().filter((c) => c.prompt === `/am:do t03-c`);
  assert.equal(impls[1].cwd, impls[0].cwd, '같은 작업 공간에서 이어 간다');
  assert.equal(r.g('worktree', 'list').trim().split('\n').length, 1);
});

// Windows 에서 child.kill('SIGINT') 는 신호 처리기를 거치지 않고 바로 끝내므로(종료 코드 null) 검사할 수 없다.
test('함께 도는 동안 status 는 작업마다 단계와 작업 공간을 보여 주고, Ctrl+C 는 세션을 모두 끝낸다', { skip: process.platform === 'win32' }, async () => {
  const r = prepared({ plan: planOf([own('T01', 't01-a'), own('T03', 't03-c')]), scenario: { implement: { 't01-a': ['SLOW', 'DONE'], 't03-c': ['SLOW', 'DONE'] } } });
  const proc = r.start('run');
  const pidFile = (slug) => path.join(r.repo, '.orchestrator', `fake-slow-${slug}.pid`);
  for (let i = 0; i < 300 && !(existsSync(pidFile('t01-a')) && existsSync(pidFile('t03-c'))); i += 1) await sleep(50);
  assert.ok(existsSync(pidFile('t01-a')) && existsSync(pidFile('t03-c')), '두 세션이 함께 돈다');
  const st = statusJson(r);
  assert.equal(st.next, 'wait');
  assert.deepEqual(st.running.tasks.map((x) => [x.task, x.stage]), [['T01', 'implement'], ['T03', 'implement']]);
  assert.ok(st.running.tasks.every((x) => /^\.orchestrator\/wt\//.test(x.workspace)));
  assert.deepEqual([st.running.task, st.running.stage], ['T01', 'implement'], '첫 작업은 예전 필드로도 보인다');
  assert.deepEqual([st.sessions.inUse, r.records().length], [2, 2], '돌고 있는 세션마다 이 PC 의 자리 기록이 하나');
  const pids = ['t01-a', 't03-c'].map((slug) => Number(readFileSync(pidFile(slug), 'utf8')));
  const exited = new Promise((res) => proc.on('exit', (code) => res(code)));
  proc.kill('SIGINT');
  assert.equal(await exited, 130);
  assert.deepEqual(r.records(), [], 'Ctrl+C 로 끝나도 자리 기록을 지운다');
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  for (let i = 0; i < 100 && pids.some(alive); i += 1) await sleep(50);
  assert.deepEqual(pids.map(alive), [false, false], '세션 프로세스가 남아 있지 않다');
  assert.deepEqual(r.statusOf(), { T01: 'planned', T03: 'planned' });
  const run = r.orch('run');
  assert.equal(run.code, 0, run.out);
  assert.deepEqual(r.statusOf(), { T01: 'done', T03: 'done' });
  assert.equal(r.g('worktree', 'list').trim().split('\n').length, 1);
});
