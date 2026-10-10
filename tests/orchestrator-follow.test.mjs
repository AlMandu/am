// Run: node --test tests/orchestrator-follow.test.mjs
// 숨은 작업 모드(--worker): 출력은 .orchestrator/worker/log 로, 잠금을 잡으면 worker.json, 끝나면 result-<pid>.json, 하트비트가 멈추면 130.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { ORCH, task, planOf, sleep, makeRepo, prepared, tmp } from './orchestrator-helpers.mjs';

const ONE = () => planOf([task('T01', 't01-a')]);
const workerDir = (r) => path.join(r.repo, '.orchestrator', 'worker');
const lockPath = (r) => path.join(r.repo, '.orchestrator', 'lock.json');
const logOf = (r) => readFileSync(path.join(workerDir(r), 'log'), 'utf8');
const resultOf = (r, pid) => JSON.parse(readFileSync(path.join(workerDir(r), `result-${pid}.json`), 'utf8'));
const results = (r) => (existsSync(workerDir(r)) ? readdirSync(workerDir(r)).filter((f) => /^result-\d+\.json$/.test(f)) : []);
const workerJson = (r) => JSON.parse(readFileSync(path.join(workerDir(r), 'worker.json'), 'utf8'));
const DEAD = 2 ** 22 + 12345;

/** 작업 모드로 끝까지 돌린다. 바깥(넘김 세션)의 AM_HANDOVER_OWNER 는 물려받지 않는다. */
const runWorker = (r, args, env = {}) => {
  const p = spawnSync(process.execPath, [ORCH, ...args, '--worker', '--repo', r.repo], { encoding: 'utf8', env: { ...r.env, AM_HANDOVER_OWNER: '', ...env } });
  return { code: p.status, pid: p.pid, stdout: p.stdout, stderr: p.stderr };
};
/** 작업 모드로 띄우기만 한다. wrapper 가 있으면 그것으로(짧은 하트비트 시간). */
const startWorker = (r, args, wrapper) => {
  const proc = spawn(process.execPath, [wrapper || ORCH, ...args, '--worker', '--repo', r.repo], { env: r.env, stdio: 'ignore' });
  proc.exited = new Promise((res) => proc.on('exit', (code) => res(code)));
  return proc;
};
const waitFile = async (file, ms = 10000) => {
  for (let i = 0; i < ms / 50 && !existsSync(file); i += 1) await sleep(50);
  assert.ok(existsSync(file), file);
};
const deadPid = async (pid) => {
  for (let i = 0; i < 100; i += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await sleep(50);
  }
  return false;
};

test('(a) run --worker: 출력은 log 로, worker.json 과 결과를 남기고 잠금을 푼다. AM_HANDOVER_OWNER 는 owner 로', () => {
  const r = prepared({ plan: ONE() });
  const p = runWorker(r, ['run']);
  assert.equal(p.code, 0, logOf(r));
  assert.equal(p.stdout, '');
  assert.equal(p.stderr, '');
  assert.match(logOf(r), /모든 작업이 끝났습니다/);
  const w = workerJson(r);
  assert.deepEqual([w.pid, w.command, w.args], [p.pid, 'run', ['run', '--repo', r.repo]]);
  assert.ok(!Number.isNaN(Date.parse(w.startedAt)));
  assert.ok(!('owner' in w));
  const res = resultOf(r, p.pid);
  assert.deepEqual([res.pid, res.command, res.code, res.delivered, res.error], [p.pid, 'run', 0, false, '']);
  assert.ok(!Number.isNaN(Date.parse(res.endedAt)));
  assert.ok(!existsSync(lockPath(r)));
  const d = runWorker(r, ['doctor', '--skip-probe'], { AM_HANDOVER_OWNER: '12345' });
  assert.equal(d.code, 0, logOf(r));
  assert.equal(workerJson(r).owner, 12345);
  assert.equal(runWorker(r, ['doctor', '--skip-probe'], { AM_HANDOVER_OWNER: 'x' }).code, 0);
  assert.ok(!('owner' in workerJson(r)));
});

test('(b) 멈춤(2): 결과에 코드와 메시지. 잠금 전 실패도 결과를 남긴다', () => {
  const r = prepared({ plan: ONE() });
  const p = runWorker(r, ['answer', 'T01', 'x']);
  assert.equal(p.code, 2);
  assert.equal(p.stdout + p.stderr, '');
  const res = resultOf(r, p.pid);
  assert.equal(res.code, 2);
  assert.match(res.error, /사용법: answer/);
  assert.ok(!existsSync(lockPath(r)));
  // git 저장소가 아닌 폴더: 잠금을 잡기 전에 끝남
  const dir = tmp('orch-nogit-');
  const q = spawnSync(process.execPath, [ORCH, 'doctor', '--worker', '--repo', dir], { encoding: 'utf8', env: r.env });
  assert.equal(q.status, 2);
  assert.equal(q.stdout + q.stderr, '');
  const res2 = resultOf({ repo: dir }, q.pid);
  assert.equal(res2.code, 2);
  assert.match(res2.error, /git 저장소가 아닙니다/);
  assert.ok(!existsSync(path.join(dir, '.orchestrator', 'worker', 'worker.json')));
});

test('(c) 잠금 경쟁: 살아 있는 잠금에 진 작업은 worker.json 도 결과도 남기지 않는다', () => {
  const r = prepared({ plan: ONE() });
  writeFileSync(lockPath(r), JSON.stringify({ pid: process.pid, command: 'run', startedAt: 'x' }));
  mkdirSync(workerDir(r), { recursive: true });
  writeFileSync(path.join(workerDir(r), 'worker.json'), '{"pid":1}');
  const p = runWorker(r, ['doctor', '--skip-probe']);
  assert.equal(p.code, 2);
  assert.equal(readFileSync(path.join(workerDir(r), 'worker.json'), 'utf8'), '{"pid":1}');
  assert.ok(!existsSync(path.join(workerDir(r), `result-${p.pid}.json`)));
  assert.match(logOf(r), /이미 돌고 있는 명령이 있습니다: run/);
  // 읽을 수 없는 잠금: 1분 안이면 거부, 넘으면 치운다
  writeFileSync(lockPath(r), '{');
  assert.equal(runWorker(r, ['doctor', '--skip-probe']).code, 2);
  const old = new Date(Date.now() - 120000);
  utimesSync(lockPath(r), old, old);
  assert.equal(runWorker(r, ['doctor', '--skip-probe']).code, 0, logOf(r));
  assert.ok(!existsSync(lockPath(r)));
});

// Windows 에서는 끝에서 보내는 SIGINT 를 검사할 수 없다(orchestrator-drive.test.mjs 의 잠금 테스트와 같은 이유)
test('(c) 동시에 띄운 작업 넷: 하나만 잠금을 잡는다', { skip: process.platform === 'win32' }, async () => {
  const r = prepared({ plan: ONE(), scenario: { implement: { 't01-a': ['SLOW', 'DONE'] } } });
  const procs = [0, 1, 2, 3].map(() => startWorker(r, ['run']));
  await waitFile(path.join(r.repo, '.orchestrator', 'fake-slow.pid'));
  const losers = [];
  for (const proc of procs) {
    const code = await Promise.race([proc.exited, sleep(5000).then(() => 'running')]);
    if (code !== 'running') losers.push([proc, code]);
  }
  assert.equal(losers.length, 3);
  for (const [proc, code] of losers) {
    assert.equal(code, 2);
    assert.ok(!existsSync(path.join(workerDir(r), `result-${proc.pid}.json`)));
  }
  const winner = procs.find((p) => !losers.some(([l]) => l === p));
  assert.equal(workerJson(r).pid, winner.pid);
  winner.kill('SIGINT');
  assert.equal(await winner.exited, 130);
});

test('(c) 죽은 주인의 잠금을 넷이 함께 치워도 잠금을 쥔 것은 한 번에 하나', async () => {
  const r = makeRepo();
  // 게이트가 겹쳐 돌면 표시를 남긴다(잠금을 쥔 doctor 만 게이트를 돌린다)
  const marks = tmp('orch-overlap-');
  const busy = JSON.stringify(path.join(marks, 'busy'));
  const overlap = JSON.stringify(path.join(marks, 'overlap'));
  writeFileSync(path.join(r.repo, 'gate-check.js'), `const fs = require('fs');\ntry { fs.writeFileSync(${busy}, '', { flag: 'wx' }); } catch { fs.appendFileSync(${overlap}, 'x'); }\nsetTimeout(() => fs.rmSync(${busy}, { force: true }), 300);\n`);
  r.g('commit', '-qam', 'slow gate');
  writeFileSync(lockPath(r), JSON.stringify({ pid: DEAD, command: 'run', startedAt: 'x' }));
  const procs = [0, 1, 2, 3].map(() => startWorker(r, ['doctor', '--skip-probe']));
  const codes = await Promise.all(procs.map((p) => p.exited));
  const won = procs.filter((_, i) => codes[i] === 0);
  assert.ok(won.length >= 1, codes.join(' '));
  assert.ok(codes.every((c) => c === 0 || c === 2), codes.join(' '));
  assert.ok(!existsSync(path.join(marks, 'overlap')), '두 작업이 함께 잠금을 쥐었다');
  for (const p of won) assert.equal(resultOf(r, p.pid).code, 0);
  assert.equal(results(r).length, won.length);
  assert.ok(!existsSync(lockPath(r)));
});

test('(c) 결과가 보이면 잠금은 이미 풀려 있다: 바로 띄운 다음 작업이 잡는다', async () => {
  const r = makeRepo();
  const first = startWorker(r, ['doctor', '--skip-probe', '--skip-gate']);
  await waitFile(path.join(workerDir(r), `result-${first.pid}.json`));
  assert.equal(runWorker(r, ['doctor', '--skip-probe', '--skip-gate']).code, 0, logOf(r));
  assert.equal(await first.exited, 0);
});

test('(d) 하트비트가 바뀌는 동안은 돌고, 멈추면 Ctrl+C 와 같이 정리하고 130', { skip: process.platform === 'win32' }, async () => {
  const r = prepared({ plan: ONE(), scenario: { implement: { 't01-a': ['SLOW', 'DONE'] } } });
  const dir = tmp('orch-wrap-');
  const wrapper = path.join(dir, 'wrapper.mjs');
  writeFileSync(wrapper, `import { cli } from ${JSON.stringify(pathToFileURL(ORCH).href)};\nawait cli(process.argv.slice(2), { heartbeatMs: 1000, pollMs: 50 });\n`);
  const proc = startWorker(r, ['run'], wrapper);
  const beat = path.join(workerDir(r), 'heartbeat');
  let n = 0;
  const timer = setInterval(() => writeFileSync(beat, String((n += 1))), 200);
  await waitFile(path.join(r.repo, '.orchestrator', 'fake-slow.pid'));
  const sessionPid = Number(readFileSync(path.join(r.repo, '.orchestrator', 'fake-slow.pid'), 'utf8'));
  const early = await Promise.race([proc.exited, sleep(2200).then(() => 'running')]);
  clearInterval(timer);
  assert.equal(early, 'running');
  assert.equal(await proc.exited, 130);
  assert.ok(await deadPid(sessionPid), '세션 프로세스가 남아 있지 않다');
  assert.ok(Object.values(r.state().tasks).every((t) => !t.running));
  const res = resultOf(r, proc.pid);
  assert.deepEqual([res.code, res.delivered], [130, true]);
  assert.match(res.error, /하트비트/);
  assert.ok(!existsSync(lockPath(r)));
});

test('(e) SIGINT 를 받은 작업은 130, delivered 는 false', { skip: process.platform === 'win32' }, async () => {
  const r = prepared({ plan: ONE(), scenario: { implement: { 't01-a': ['SLOW', 'DONE'] } } });
  const proc = startWorker(r, ['run']);
  await waitFile(path.join(r.repo, '.orchestrator', 'fake-slow.pid'));
  proc.kill('SIGINT');
  assert.equal(await proc.exited, 130);
  const res = resultOf(r, proc.pid);
  assert.deepEqual([res.code, res.delivered], [130, false]);
  assert.match(res.error, /SIGINT/);
  assert.ok(!existsSync(lockPath(r)));
});

test('(f) 사용법에는 작업 모드가 보이지 않는다', () => {
  const p = spawnSync(process.execPath, [ORCH], { encoding: 'utf8', env: makeRepo().env });
  assert.equal(p.status, 0);
  assert.match(p.stdout, /사용법/);
  assert.ok(!/worker/.test(p.stdout));
});
