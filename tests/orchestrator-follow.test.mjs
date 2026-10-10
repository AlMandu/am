// Run: node --test tests/orchestrator-follow.test.mjs
// 숨은 작업 모드(--worker): 출력은 .orchestrator/worker/log 로, 잠금을 잡으면 worker.json, 끝나면 result-<pid>.json, 하트비트가 멈추면 130.
// 따라가기(--worker 없이 부른 doctor·split·answer·run): 작업을 띄우거나 같은 명령의 살아 있는 작업에 붙어 그 log 범위를 내고 작업의 코드로 끝난다.
// 전달: 따라가기 없이 끝난 결과(하트비트 시간 안)는 같은 명령의 다음 호출이 새로 띄우지 않고 한 번 낸다. 다른 명령이 성공하면 전달된 것으로 본다.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
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
  const start = readFileSync(path.join(workerDir(r), 'log')).length; // prepared 의 doctor·split 도 작업으로 돌아 log 에 남았다
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
  // 이 작업의 log 범위: 잠금을 잡을 때의 크기(read-<pid>)부터 잠금을 풀 때의 크기(logTo)까지
  const from = Number(readFileSync(path.join(workerDir(r), `read-${p.pid}`), 'utf8'));
  const size = readFileSync(path.join(workerDir(r), 'log')).length;
  assert.deepEqual([from, res.logTo], [start, size]);
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
  assert.ok(!('logTo' in res2)); // 잠금 전에 끝난 작업은 log 에 범위가 없다
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
  // 진 작업은 log 에 거부를 남기지 않는다(거부는 그 작업을 띄운 따라가기가 낸다)
  assert.ok(!existsSync(path.join(workerDir(r), 'log')) || !/이미 돌고 있는 명령이 있습니다/.test(logOf(r)));
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

// ------------------------------------------------------------------ 따라가기

const DESIGN = (r) => path.join(r.repo, 'docs', 'design.md');
const logBytes = (r) => readFileSync(path.join(workerDir(r), 'log'));
const exitOf = (proc) => new Promise((res) => proc.on('close', (code) => res(code))); // close: 받은 출력을 다 모은 뒤
const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('따라가기 (a) 빠른 명령: 작업의 log 범위를 내고 그 코드로 끝난다. 잠금 전에 끝나는 것은 작업을 띄우지 않는다', () => {
  const r = makeRepo({ plan: planOf([task('T01', 't01-a')], [{ id: 'D1', what: '첫 화면', whyNow: '화면이 달라짐', options: [{ label: '목록', effect: '목록' }, { label: '상세', effect: '상세' }], recommended: '목록', undo: 'easy', blocks: ['T01'], answer: null }]) });
  const d = r.orch('doctor', '--skip-probe');
  assert.equal(d.code, 0, d.out);
  const w = workerJson(r);
  const res = resultOf(r, w.pid);
  assert.equal(Number(readFileSync(path.join(workerDir(r), `read-${w.pid}`), 'utf8')), res.logTo, '따라가기가 끝까지 읽은 위치');
  assert.equal(d.out, logBytes(r).subarray(0, res.logTo).toString('utf8'), '처음 작업이라 범위는 log 의 처음부터');
  assert.ok(existsSync(path.join(workerDir(r), `delivered-${w.pid}`)), '따라가기가 결과를 차지했다');
  assert.equal(resultOf(r, w.pid).delivered, true);
  assert.equal(r.orch('split', DESIGN(r)).code, 0);
  const run = r.orch('run');
  assert.equal(run.code, 1, run.out);
  const ans = r.orch('answer', 'T01', 'x');
  assert.equal(ans.code, 2, ans.out);
  assert.match(ans.out, /사용법: answer/);
  // 인자 없는 split·answer: 작업을 띄우지 않고 사용법
  const before = results(r).length;
  for (const cmd of ['split', 'answer']) {
    const p = r.orch(cmd);
    assert.equal(p.code, 2, p.out);
    assert.match(p.out, new RegExp(`사용법: ${cmd}`));
  }
  assert.equal(results(r).length, before);
  assert.ok(!existsSync(lockPath(r)));
  // git 저장소가 아닌 폴더: 아무것도 띄우지도 만들지도 않는다
  const dir = tmp('orch-nogit-');
  const q = spawnSync(process.execPath, [ORCH, 'doctor', '--repo', dir], { encoding: 'utf8', env: r.env });
  assert.equal(q.status, 2);
  assert.match(q.stderr, /git 저장소가 아닙니다/);
  assert.ok(!existsSync(path.join(dir, '.orchestrator')));
});

test('따라가기 (e) 신호는 작업에 넘긴다: SIGTERM 이면 작업이 세션을 끝내고 130', { skip: process.platform === 'win32' }, async () => {
  const r = prepared({ plan: ONE(), scenario: { implement: { 't01-a': ['SLOW', 'DONE'] } } });
  const proc = r.start('run');
  const exited = exitOf(proc);
  await waitFile(path.join(r.repo, '.orchestrator', 'fake-slow.pid'));
  const sessionPid = Number(readFileSync(path.join(r.repo, '.orchestrator', 'fake-slow.pid'), 'utf8'));
  const w = workerJson(r);
  proc.kill('SIGTERM');
  assert.equal(await exited, 130, proc.out);
  assert.equal(resultOf(r, w.pid).code, 130);
  assert.ok(await deadPid(sessionPid), '세션 프로세스가 남아 있지 않다');
  assert.match(proc.out, /중단했습니다/);
  assert.ok(!existsSync(lockPath(r)));
});

test('따라가기 (f)(g) 도는 split 에 인자 없는 split 이 붙는다: 둘 다 0 이고 둘 다 끝 줄을 내며 실행은 하나', { skip: process.platform === 'win32' }, async () => {
  const r = makeRepo({ scenario: { slowSplit: 1000 } });
  assert.equal(r.orch('doctor').code, 0);
  const first = r.start('split', DESIGN(r));
  const firstExit = exitOf(first);
  await waitFile(path.join(r.repo, '.orchestrator', 'fake-slow-split.pid'));
  const second = r.orch('split');
  assert.equal(second.code, 0, second.out);
  assert.equal(await firstExit, 0, first.out);
  for (const out of [first.out, second.out]) assert.match(out, /작업 \d+개로 나눴습니다/);
  const runs = readdirSync(path.join(r.repo, '.orchestrator', 'runs'));
  assert.equal(runs.length, 1);
  assert.equal(readFileSync(path.join(r.repo, '.orchestrator', 'current'), 'utf8').trim(), runs[0]);
});

test('따라가기 (g) 다른 프로세스의 작업에 붙는다: 덧붙은 줄을 내고, 결과 없이 사라지면 3(옛 결과는 무시)', async () => {
  const r = makeRepo();
  mkdirSync(workerDir(r), { recursive: true });
  const logFile = path.join(workerDir(r), 'log');
  writeFileSync(logFile, '이전 작업의 줄\n');
  const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  const pid = sleeper.pid;
  const startedAt = new Date().toISOString();
  writeFileSync(path.join(workerDir(r), `result-${pid}.json`), JSON.stringify({ pid, command: 'doctor', code: 0, error: '', endedAt: new Date(Date.now() - 60000).toISOString(), delivered: false }));
  writeFileSync(path.join(workerDir(r), `read-${pid}`), String(statSync(logFile).size));
  writeFileSync(path.join(workerDir(r), 'worker.json'), JSON.stringify({ pid, command: 'doctor', args: ['doctor'], startedAt }));
  writeFileSync(lockPath(r), JSON.stringify({ pid, command: 'doctor', startedAt }));
  // 결과를 기다리는 시간만 짧게(이 테스트는 작업을 띄우지 않는다)
  const wrapper = path.join(tmp('orch-wrap-'), 'wrapper.mjs');
  writeFileSync(wrapper, `import { cli } from ${JSON.stringify(pathToFileURL(ORCH).href)};\nawait cli(process.argv.slice(2), { resultWaitMs: 200 });\n`);
  const proc = spawn(process.execPath, [wrapper, 'doctor', '--repo', r.repo], { env: r.env, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.out = '';
  for (const st of [proc.stdout, proc.stderr]) st.setEncoding('utf8').on('data', (d) => (proc.out += d));
  const exited = exitOf(proc);
  await sleep(300);
  appendFileSync(logFile, '붙은 작업의 줄 한글\n');
  for (let i = 0; i < 100 && !proc.out.includes('붙은 작업의 줄'); i += 1) await sleep(50);
  assert.match(proc.out, /붙은 작업의 줄 한글\n/);
  assert.ok(!proc.out.includes('이전 작업의 줄'));
  sleeper.kill('SIGKILL');
  assert.equal(await exited, 3, proc.out);
  assert.match(proc.out, /결과를 남기지 않고/);
});

test('따라가기 (k) 따라가기를 강제로 죽여도 작업은 돌고, 다시 붙은 따라가기가 남은 줄을 빠짐·겹침 없이 낸다', { skip: process.platform === 'win32' }, async () => {
  const r = makeRepo({ scenario: { slowSplit: 1000 } });
  assert.equal(r.orch('doctor').code, 0);
  const from = statSync(path.join(workerDir(r), 'log')).size;
  const first = r.start('split', DESIGN(r));
  const firstExit = exitOf(first);
  await waitFile(path.join(r.repo, '.orchestrator', 'fake-slow-split.pid'));
  await sleep(600); // 분할 세션이 기다리는 동안 따라가기는 낼 것을 다 내고 위치를 저장했다
  const w = workerJson(r);
  first.kill('SIGKILL');
  await firstExit;
  assert.ok(pidAlive(w.pid), '작업은 따라가기와 함께 죽지 않는다');
  const second = r.orch('split');
  assert.equal(second.code, 0, second.out);
  const res = resultOf(r, w.pid);
  assert.equal(first.out + second.out, logBytes(r).subarray(from, res.logTo).toString('utf8'));
});

// ------------------------------------------------------------------ 전달

const marked = (r, pid) => existsSync(path.join(workerDir(r), `delivered-${pid}`));
/** 따라가기 없이 끝난 가짜 결과: log 끝에 text 를 덧붙여 그 범위를 이 결과의 범위로 둔다. */
const fakeResult = (r, pid, fields, text = '') => {
  mkdirSync(workerDir(r), { recursive: true });
  const logFile = path.join(workerDir(r), 'log');
  const from = existsSync(logFile) ? statSync(logFile).size : 0;
  appendFileSync(logFile, text);
  writeFileSync(path.join(workerDir(r), `read-${pid}`), String(from));
  writeFileSync(path.join(workerDir(r), `result-${pid}.json`), JSON.stringify({ pid, code: 0, error: '', endedAt: new Date().toISOString(), delivered: false, logTo: statSync(logFile).size, ...fields }));
};
const follow = (r, ...args) => spawnSync(process.execPath, [ORCH, ...args, '--repo', r.repo], { encoding: 'utf8', env: r.env });
const sleeper = () => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });

test('전달 (c) 따라가기 없이 끝난 answer 의 결과: 인자 없는 answer 가 남은 줄과 멈춘 이유를 한 번 내고, 그다음은 사용법', () => {
  const r = makeRepo();
  fakeResult(r, DEAD, { command: 'answer', code: 2, error: '멈춘 이유 X' }, '남은 줄\n\n멈춘 이유 X\n');
  const before = results(r).length;
  const p = follow(r, 'answer');
  assert.equal(p.status, 2, p.stdout + p.stderr);
  assert.equal(p.stdout, '남은 줄\n');
  assert.match(p.stderr, /멈춘 이유 X/);
  assert.equal(resultOf(r, DEAD).delivered, true);
  assert.ok(marked(r, DEAD));
  assert.equal(results(r).length, before, '새 작업을 띄우지 않았다');
  const q = follow(r, 'answer');
  assert.equal(q.status, 2);
  assert.match(q.stdout + q.stderr, /사용법: answer/);
  assert.ok(!/멈춘 이유/.test(q.stdout + q.stderr));
});

test('전달 (c) 따라가기를 죽인 split: 끝난 뒤 인자 없는 split 이 남은 줄과 0 을 내고, 그다음은 사용법', { skip: process.platform === 'win32' }, async () => {
  const r = makeRepo({ scenario: { slowSplit: 1000 } });
  assert.equal(r.orch('doctor').code, 0);
  const from = statSync(path.join(workerDir(r), 'log')).size;
  const first = r.start('split', DESIGN(r));
  const firstExit = exitOf(first);
  await waitFile(path.join(r.repo, '.orchestrator', 'fake-slow-split.pid'));
  const w = workerJson(r);
  first.kill('SIGKILL');
  await firstExit;
  assert.ok(await deadPid(w.pid), '작업이 끝나지 않았다');
  const second = follow(r, 'split');
  assert.equal(second.status, 0, second.stdout + second.stderr);
  const res = resultOf(r, w.pid);
  assert.equal(first.out + second.stdout + second.stderr, logBytes(r).subarray(from, res.logTo).toString('utf8'));
  assert.match(second.stdout, /작업 \d+개로 나눴습니다/);
  assert.equal(readdirSync(path.join(r.repo, '.orchestrator', 'runs')).length, 1);
  const third = follow(r, 'split');
  assert.equal(third.status, 2);
  assert.match(third.stdout + third.stderr, /사용법: split/);
});

test('전달 (d) 성공한 명령만 다른 작업의 미전달 결과를 전달된 것으로 표시한다', () => {
  const r = prepared({ plan: planOf([task('T01', 't01-a')], [{ id: 'D1', what: '첫 화면', whyNow: '화면이 달라짐', options: [{ label: '목록', effect: '목록' }, { label: '상세', effect: '상세' }], recommended: '목록', undo: 'easy', blocks: ['T01'], answer: null }]) });
  fakeResult(r, DEAD, { command: 'run', code: 1 }, '옛 run 줄\n');
  assert.equal(r.orch('decide', 'X', 'y').code, 2);
  assert.equal(resultOf(r, DEAD).delivered, false);
  assert.ok(!marked(r, DEAD));
  const steps = [['decide', 'D1', '목록'], ['retry', 'T01'], ['done', 'T01'], ['doctor', '--skip-probe']];
  steps.forEach((args, i) => {
    if (i) fakeResult(r, DEAD + i, { command: 'run', code: 1 }, '옛 run 줄\n');
    const p = r.orch(...args);
    assert.equal(p.code, 0, `${args.join(' ')}: ${p.out}`);
    assert.equal(resultOf(r, DEAD + i).delivered, true, args.join(' '));
    assert.ok(marked(r, DEAD + i), args.join(' '));
  });
  assert.ok(!r.orch('run').out.includes('옛 run 줄'));
});

test('전달 (c4) 하트비트 시간 밖의 결과는 내지 않고, 잠금을 쥔 작업의 결과는 미리 내지 않고 붙는다', async () => {
  const r = makeRepo();
  const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
  fakeResult(r, DEAD, { command: 'doctor', endedAt: ago(31) }, '옛 doctor 줄\n');
  const before = results(r).length;
  const old = r.orch('doctor', '--skip-probe');
  assert.equal(old.code, 0, old.out);
  assert.ok(!old.out.includes('옛 doctor 줄'));
  assert.equal(results(r).length, before + 1);
  assert.ok(!marked(r, DEAD), '창 밖의 결과는 표시하지 않는다');
  fakeResult(r, DEAD + 1, { command: 'doctor', endedAt: ago(29) }, '옛 doctor 줄\n');
  const fresh = r.orch('doctor', '--skip-probe');
  assert.equal(fresh.code, 0, fresh.out);
  assert.equal(fresh.out, '옛 doctor 줄\n');
  assert.equal(results(r).length, before + 2);
  // 살아 있는 잠금 주인의 결과: 재사용된 pid 의 옛것일 수 있어 내지 않고 붙는다
  const s = sleeper();
  const startedAt = new Date().toISOString();
  fakeResult(r, s.pid, { command: 'doctor', code: 5, endedAt: startedAt });
  writeFileSync(path.join(workerDir(r), 'worker.json'), JSON.stringify({ pid: s.pid, command: 'doctor', args: ['doctor'], startedAt }));
  writeFileSync(lockPath(r), JSON.stringify({ pid: s.pid, command: 'doctor', startedAt }));
  const proc = r.start('doctor');
  const exited = exitOf(proc);
  await sleep(500);
  assert.equal(proc.exitCode, null, '미리 전달하지 않고 붙어 있다');
  assert.equal(proc.out, '');
  s.kill('SIGKILL');
  assert.equal(await exited, 5, proc.out);
  assert.ok(marked(r, s.pid));
});

test('전달 (gap) 같은 명령의 작업이 잠금을 지운 뒤 결과를 쓰기 전이면 결과를 기다려 낸다', async () => {
  const r = makeRepo();
  const s = sleeper();
  mkdirSync(workerDir(r), { recursive: true });
  writeFileSync(path.join(workerDir(r), 'worker.json'), JSON.stringify({ pid: s.pid, command: 'doctor', args: ['doctor'], startedAt: new Date().toISOString() }));
  const proc = r.start('doctor');
  const exited = exitOf(proc);
  await sleep(300);
  fakeResult(r, s.pid, { command: 'doctor', code: 4 }, '끝 틈 줄\n');
  assert.equal(await exited, 4, proc.out);
  s.kill('SIGKILL');
  assert.equal(proc.out, '끝 틈 줄\n');
  assert.deepEqual(results(r), [`result-${s.pid}.json`]);
});
