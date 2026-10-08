// 오케스트레이터의 진행 소식(.orchestrator/runs/<실행>/progress.jsonl), 잠금 파일의 실행 이름, 그 소식을 기다리는 progress 명령.
// 끝나는 길(정상, 막힘, 실패, 중단)마다 start 하나에 end 하나가 남는지, 대기가 따라갈 실행을 제대로 고르고 am 의 대기 명령과 같은 규격으로 내는지 본다.
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { PROGRESS_DEFAULTS, waitProgress } from '../orchestrator/scripts/orchestrator.mjs';
import { readFrom, stateLine } from '../plugin/scripts/progress.mjs';
import { makeRepo, planOf, prepared, sleep, task, tmp } from './orchestrator-helpers.mjs';

const KEYS = ['t', 'ev', 'text', 'pid', 'stage', 'task', 'status', 'min'];
const EVS = ['start', 'step', 'note', 'alert', 'end'];
const ONE = () => planOf([task('T01', 't01-a')]);
const eventFile = (r) => path.join(r.runDir(), 'progress.jsonl');
const raw = (r) => (existsSync(eventFile(r)) ? readFileSync(eventFile(r), 'utf8') : '(no event file)');

/** 이벤트 파일의 줄을 형식 검사하며 읽는다. 마지막 start 뒤에는 end 가 정확히 하나. */
function events(r) {
  const text = raw(r);
  const list = text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const e = JSON.parse(line);
      for (const k of Object.keys(e)) assert.ok(KEYS.includes(k), `unknown key ${k}: ${line}`);
      assert.equal(new Date(e.t).toISOString(), e.t, line);
      assert.ok(EVS.includes(e.ev), line);
      assert.match(e.text, /^[\x20-\x7e]+$/, line);
      if (e.ev === 'start') assert.ok(Number.isInteger(e.pid), line);
      else assert.equal(e.pid, undefined, line);
      if (e.min !== undefined) assert.ok(Number.isInteger(e.min) && e.min >= 0, line);
      return e;
    });
  const last = list.map((e) => e.ev).lastIndexOf('start');
  assert.ok(last >= 0, `no start\n${text}`);
  assert.equal(list.slice(last + 1).filter((e) => e.ev === 'end').length, 1, `one end after the last start\n${text}`);
  return list;
}

const has = (list, want) => list.some((e) => Object.entries(want).every(([k, v]) => e[k] === v));

let chain; // (a)(b) 가 같이 쓰는 저장소

test('(a) split 은 새 실행 폴더에 start 와 done 인 end 를 남긴다', () => {
  chain = prepared();
  const list = events(chain);
  const msg = raw(chain);
  assert.equal(list[0].ev, 'start', msg);
  assert.equal(list[0].stage, 'split', msg);
  assert.equal(list[0].pid > 0, true, msg);
  assert.ok(has(list, { ev: 'note', stage: 'split', text: 'split session ended' }), msg);
  assert.equal(list.at(-1).ev, 'end', msg);
  assert.equal(list.at(-1).status, 'done', msg);
});

test('(b) run 은 작업과 단계마다 소식을 남기고, am 의 대기 명령이 그대로 읽는다', () => {
  const r = chain;
  const res = r.orch('run');
  assert.equal(res.code, 0, res.out);
  const list = events(r);
  const msg = raw(r);
  const start = list.map((e) => e.ev).lastIndexOf('start');
  const run = list.slice(start);
  assert.equal(run[0].stage, 'run', msg);
  assert.match(run[0].text, /3 tasks/, msg);
  for (const id of ['T01', 'T02', 'T03']) {
    assert.ok(has(run, { ev: 'step', task: id, text: 'task started' }), `${id} task started\n${msg}`);
    for (const stage of ['plan', 'implement', 'check', 'commit']) assert.ok(has(run, { ev: 'step', task: id, stage, text: `${stage} started` }), `${id} ${stage}\n${msg}`);
    assert.ok(has(run, { ev: 'step', task: id, status: 'done' }), `${id} done\n${msg}`);
    assert.ok(has(run, { ev: 'note', task: id, stage: 'plan', text: 'plan session ended' }), `${id} session note\n${msg}`);
    assert.ok(run.some((e) => e.ev === 'note' && e.task === id && e.stage === 'check' && /^verdict NOTE, gate pass$/.test(e.text)), `${id} verdict note\n${msg}`);
  }
  assert.equal(run.at(-1).ev, 'end', msg);
  assert.equal(run.at(-1).status, 'done', msg);
  // T01 의 대기 쪽(am)과 같은 형식인지: 모든 줄이 읽히고 끝난 상태다
  const read = readFrom(eventFile(r), 0);
  assert.equal(read.events.length, list.length, msg);
  assert.equal(stateLine(read.events), 'state: ended');
});

test('(c) 구현이 막히면 alert 와 stopped 인 end', () => {
  const r = prepared({ plan: ONE(), scenario: { implement: { 't01-a': ['BLOCKED'] } } });
  const res = r.orch('run');
  assert.equal(res.code, 1, res.out);
  const list = events(r);
  const msg = raw(r);
  assert.ok(has(list, { ev: 'alert', task: 'T01', status: 'blocked', stage: 'implement' }), msg);
  assert.equal(list.at(-1).ev, 'end', msg);
  assert.equal(list.at(-1).status, 'stopped', msg);
});

test('(d) 결정이 필요하면 alert, 그 뒤 answer 가 start 와 planned 인 end 를 덧붙인다', () => {
  const r = prepared({ plan: ONE(), scenario: { plan: { 't01-a': ['NEEDS_DECISION'] } } });
  assert.equal(r.orch('run').code, 1);
  let list = events(r);
  assert.ok(has(list, { ev: 'alert', task: 'T01', status: 'needs-decision' }), raw(r));
  const before = list.length;
  const res = r.orch('answer', 'T01', '목록');
  assert.equal(res.code, 0, res.out);
  list = events(r);
  const msg = raw(r);
  const added = list.slice(before);
  assert.equal(added[0].ev, 'start', msg);
  assert.equal(added[0].stage, 'answer', msg);
  assert.equal(added[0].task, 'T01', msg);
  assert.equal(added.at(-1).ev, 'end', msg);
  assert.equal(added.at(-1).status, 'planned', msg);
});

test('(e) 세션이 오류로 끝나면 종료 처리가 failed 인 end 를 남기고 잠금을 푼다', () => {
  const r = prepared({ plan: ONE(), scenario: { implement: { 't01-a': ['CRASH'] } } });
  const res = r.orch('run');
  assert.equal(res.code, 2, res.out);
  const list = events(r);
  assert.equal(list.at(-1).ev, 'end', raw(r));
  assert.equal(list.at(-1).status, 'failed', raw(r));
  assert.ok(!existsSync(path.join(r.repo, '.orchestrator', 'lock.json')));
});

test('(f) 잠금은 잡는 순간부터 실행 이름을 담는다: split 은 새 이름', () => {
  const r = makeRepo({ scenario: { snapshotLock: true } });
  const design = path.join(r.repo, 'docs', 'design.md');
  assert.equal(r.orch('doctor').code, 0);
  assert.equal(r.orch('split', design, '--run', 'old').code, 0);
  const res = r.orch('split', design);
  assert.equal(res.code, 0, res.out);
  const orch = path.join(r.repo, '.orchestrator');
  const lock = JSON.parse(readFileSync(path.join(orch, 'fake-split-lock.json'), 'utf8'));
  const current = readFileSync(path.join(orch, 'current'), 'utf8').trim();
  assert.match(current, /^\d{8}-\d{4}$/);
  assert.equal(lock.run, current);
  assert.equal(lock.command, 'split');
  assert.equal(readFileSync(path.join(orch, 'fake-split-current.txt'), 'utf8').trim(), 'old');
});

test('(g) 이벤트 파일에 쓰지 못해도 run 은 그대로 끝난다', () => {
  const r = prepared();
  rmSync(eventFile(r));
  mkdirSync(eventFile(r));
  const res = r.orch('run');
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /모든 작업이 끝났습니다/);
  assert.match(res.out, /완료 3 \/ 3/);
  assert.doesNotMatch(res.out, /\n\s+at /);
});

// Windows 에서는 끝에서 보내는 SIGINT 를 검사할 수 없다(orchestrator-drive.test.mjs 의 잠금 테스트와 같은 이유).
test('(h) 중단하면 interrupted 인 end', { skip: process.platform === 'win32' }, async () => {
  const r = prepared({ plan: ONE(), scenario: { implement: { 't01-a': ['SLOW'] } } });
  const proc = r.start('run');
  const pidFile = path.join(r.repo, '.orchestrator', 'fake-slow.pid');
  for (let i = 0; i < 200 && !existsSync(pidFile); i += 1) await new Promise((res) => setTimeout(res, 50));
  assert.ok(existsSync(pidFile), proc.out);
  const exited = new Promise((res) => proc.on('exit', (code) => res(code)));
  proc.kill('SIGINT');
  assert.equal(await exited, 130);
  const list = events(r);
  assert.equal(list.at(-1).ev, 'end', raw(r));
  assert.equal(list.at(-1).status, 'interrupted', raw(r));
});

// ---- 대기(waitProgress): 가상 시계로 돌린다

const T0 = Date.parse('2026-10-08T00:00:00.000Z');
const LIVE = 4242;
const alive = (pid) => pid === LIVE;
const D = PROGRESS_DEFAULTS;
const START = { ev: 'start', text: 'run started: 3 tasks', pid: LIVE, stage: 'run' };
const START_LINE = 'start: run started: 3 tasks [stage=run]';

/** 가상 시계가 달린 임시 폴더. sleep 이 시계를 올리며 그때까지 예약된 일을 시각 순서대로 실행한다. 줄의 t 는 가상 시각이다. */
function clock(current) {
  const repo = tmp('orch-wait-');
  const orch = path.join(repo, '.orchestrator');
  let t = T0;
  const jobs = [];
  const w = {
    repo,
    now: () => t,
    elapsed: () => t - T0,
    sleep: async (ms) => {
      const until = t + ms;
      jobs.sort((a, b) => a.at - b.at);
      while (jobs.length && jobs[0].at <= until) {
        const job = jobs.shift();
        t = Math.max(t, job.at);
        job.fn();
      }
      t = until;
    },
    at: (ms, fn) => jobs.push({ at: T0 + ms, fn }),
    dir: (run) => path.join(orch, 'runs', run),
    file: (run) => path.join(w.dir(run), 'progress.jsonl'),
    cursorFile: (run, consumer = 'terminal') => path.join(w.dir(run), `progress.${consumer}.cursor`),
    add: (run, fields) => {
      mkdirSync(w.dir(run), { recursive: true });
      appendFileSync(w.file(run), `${JSON.stringify({ t: new Date(t).toISOString(), ...fields })}\n`);
    },
    addAt: (ms, run, fields) => w.at(ms, () => w.add(run, fields)),
    current: (run) => {
      mkdirSync(orch, { recursive: true });
      writeFileSync(path.join(orch, 'current'), `${run}\n`);
    },
    lock: (run, pid = LIVE) => {
      mkdirSync(orch, { recursive: true });
      writeFileSync(path.join(orch, 'lock.json'), JSON.stringify({ pid, command: 'run', startedAt: new Date(t).toISOString(), run }));
    },
    unlock: () => rmSync(path.join(orch, 'lock.json'), { force: true }),
    cursor: (run, consumer) => (existsSync(w.cursorFile(run, consumer)) ? readFileSync(w.cursorFile(run, consumer), 'utf8') : null),
    size: (run) => readFileSync(w.file(run)).length,
  };
  if (current) w.current(current);
  return w;
}

/** 대기 한 번. 낸 줄들과 낸 시각(테스트 시작부터의 ms)을 돌려준다. */
async function waitOn(w, { onWrite, ...opts } = {}) {
  const writes = [];
  let at = null;
  const out = {
    write(s) {
      if (onWrite) onWrite();
      writes.push(s);
      at = w.elapsed();
    },
  };
  const code = await waitProgress(w.repo, { now: w.now, sleep: w.sleep, alive, out, ...opts });
  assert.equal(code, 0);
  assert.equal(writes.length, 1, 'one write per wait');
  assert.ok(writes[0].endsWith('\n'));
  return { lines: writes[0].trimEnd().split('\n'), at };
}

test('대기: 기본값은 am 과 같은 키이고 전체 수명이 8분 30초를 넘지 않는다', () => {
  assert.deepEqual(Object.keys(D).sort(), ['batchMs', 'maxLifeMs', 'pollMs', 'quietMs', 'startWaitMs']);
  assert.equal(D.batchMs, 30000);
  assert.equal(D.quietMs, 480000);
  assert.equal(D.startWaitMs, 60000);
  assert.ok(D.startWaitMs <= D.quietMs && D.quietMs < D.maxLifeMs && D.maxLifeMs <= 510000);
});

test('대기: 줄바꿈으로 끝난 줄만 읽고, 이벤트가 아닌 줄은 건너뛰되 위치는 지나간다', async () => {
  const w = clock('a');
  w.add('a', START);
  const partial = '{"t":"x","ev":"alert","te';
  appendFileSync(w.file('a'), `not json\n[1]\nnull\n{"ev":"other","text":"x"}\n{"t":"x","ev":"alert","text":"첫 소식 é"}\n${partial}`);
  let r = await waitOn(w);
  assert.equal(r.at, 0);
  assert.deepEqual(r.lines, [START_LINE, 'alert: 첫 소식 é', 'state: running (run, 0 min)']);
  assert.equal(w.cursor('a'), String(w.size('a') - Buffer.byteLength(partial))); // 글자 수가 아니라 바이트
  // 덜 쓴 마지막 줄은 다음 대기의 것이다
  appendFileSync(w.file('a'), 'xt":"second"}\r\n');
  r = await waitOn(w);
  assert.deepEqual(r.lines, ['alert: second', 'state: running (run, 0 min)']);
  assert.equal(w.cursor('a'), String(w.size('a')));
});

test('대기: 커서는 출력한 뒤에 임시 파일로 바꾸고, 임시 파일은 남지 않는다', async () => {
  const w = clock('a');
  w.add('a', START);
  await waitOn(w);
  const old = w.cursor('a');
  w.add('a', { ev: 'alert', text: 'blocked' });
  let seen;
  const r = await waitOn(w, { onWrite: () => (seen = w.cursor('a')) });
  assert.deepEqual(r.lines, ['alert: blocked', 'state: running (run, 0 min)']);
  assert.equal(seen, old);
  assert.equal(w.cursor('a'), String(w.size('a')));
  assert.ok(Number(w.cursor('a')) > Number(old));
  assert.deepEqual(readdirSync(w.dir('a')).sort(), ['progress.jsonl', 'progress.terminal.cursor']);
});

test('대기: 커서를 바꾸지 못해도 출력은 나오고 커서는 그대로다', async () => {
  const w = clock('a');
  w.add('a', START);
  await waitOn(w);
  const old = w.cursor('a');
  const stuck = `${w.cursorFile('a')}.${process.pid}.tmp`;
  mkdirSync(stuck);
  w.add('a', { ev: 'alert', text: 'blocked' });
  const r = await waitOn(w);
  assert.deepEqual(r.lines, ['alert: blocked', 'state: running (run, 0 min)']);
  assert.equal(w.cursor('a'), old);
  assert.ok(existsSync(stuck));
});

test('대기: 소비자마다 커서가 따로다', async () => {
  const w = clock('a');
  w.add('a', START);
  w.add('a', { ev: 'alert', text: 'blocked' });
  const lines = [START_LINE, 'alert: blocked', 'state: running (run, 0 min)'];
  let r = await waitOn(w, { consumer: 'main' });
  assert.deepEqual(r.lines, lines);
  const mainCursor = w.cursor('a', 'main');
  assert.equal(mainCursor, String(w.size('a')));
  assert.equal(w.cursor('a'), null);
  r = await waitOn(w);
  assert.deepEqual(r.lines, lines);
  assert.equal(w.cursor('a'), String(w.size('a')));
  assert.equal(w.cursor('a', 'main'), mainCursor);
});

test('대기: step 은 정확히 30초 뒤에 그 사이 줄과 함께 나오고, start 도 같다', async () => {
  const w = clock('a');
  w.add('a', START);
  w.add('a', { ev: 'step', text: 'first', task: 'T01' });
  w.addAt(10000, 'a', { ev: 'note', text: 'a note' });
  w.addAt(29000, 'a', { ev: 'step', text: 'late one' });
  let r = await waitOn(w);
  assert.equal(r.at, 30000);
  assert.deepEqual(r.lines, [START_LINE, 'step: first [task=T01]', 'note: a note', 'step: late one', 'state: running (run, 0 min)']);
  assert.equal(w.cursor('a'), String(w.size('a')));
  // 다시 돌리면 같은 줄이 없다. start 하나만 있어도 30초 모은다
  w.addAt(40000, 'a', { ev: 'start', text: 'answer started', pid: LIVE, stage: 'answer' });
  r = await waitOn(w);
  assert.equal(r.at, 70000);
  assert.deepEqual(r.lines, ['start: answer started [stage=answer]', 'state: running (answer, 0 min)']);
});

test('대기: alert 와 end 는 다음 확인에 나온다', async () => {
  const w = clock('a');
  w.add('a', START);
  w.add('a', { ev: 'step', text: 'first' });
  w.addAt(4500, 'a', { ev: 'alert', text: 'needs a decision', task: 'T02' });
  let r = await waitOn(w);
  assert.equal(r.at, 5000);
  assert.deepEqual(r.lines, [START_LINE, 'step: first', 'alert: needs a decision [task=T02]', 'state: running (run, 0 min)']);
  w.addAt(7200, 'a', { ev: 'end', text: 'done 3 of 3', status: 'done', min: 1 });
  r = await waitOn(w);
  assert.equal(r.at, 8000);
  assert.deepEqual(r.lines, ['end: done 3 of 3 [status=done min=1]', 'state: ended']);
});

test('대기: note 만 있으면 8분 뒤 상태 줄만 나오고 커서는 그대로다', async () => {
  const w = clock('a');
  w.add('a', START);
  await waitOn(w);
  const cursor = w.cursor('a');
  w.addAt(60000, 'a', { ev: 'note', text: 'session ended' });
  let r = await waitOn(w);
  assert.equal(r.at, 30000 + D.quietMs);
  assert.deepEqual(r.lines, ['state: running (run, 8 min)']);
  assert.equal(w.cursor('a'), cursor);
  w.addAt(520000, 'a', { ev: 'step', text: 'news' });
  r = await waitOn(w);
  assert.equal(r.at, 520000 + D.batchMs);
  assert.deepEqual(r.lines, ['note: session ended', 'step: news', 'state: running (run, 9 min)']);
});

test('대기: 대기 중에 pid 가 죽으면 남은 줄과 함께 끝난 상태를 낸다', async () => {
  const w = clock('a');
  w.add('a', START);
  await waitOn(w);
  w.addAt(40000, 'a', { ev: 'note', text: 'asked again' });
  let dead = false;
  w.at(45500, () => {
    dead = true;
  });
  const r = await waitOn(w, { alive: (pid) => !dead && pid === LIVE });
  assert.equal(r.at, 46000);
  assert.deepEqual(r.lines, ['note: asked again', 'state: ended']);
  assert.equal(w.cursor('a'), String(w.size('a')));
});

test('대기: 끝난 상태에서 시작하면 새 start 를 기다린다: 오면 이어 가고, 안 오면 60초에 끝난 상태', async () => {
  const w = clock('a');
  w.add('a', START);
  w.add('a', { ev: 'end', text: 'stopped', status: 'stopped' });
  w.addAt(20000, 'a', { ev: 'start', text: 'answer started', pid: LIVE, stage: 'answer' });
  let r = await waitOn(w);
  assert.equal(r.at, 20000); // 못 읽은 이전 명령의 end 가 새 start 와 함께 바로 나온다
  assert.deepEqual(r.lines, [START_LINE, 'end: stopped [status=stopped]', 'start: answer started [stage=answer]', 'state: running (answer, 0 min)']);

  const idle = clock('a');
  idle.add('a', START);
  idle.add('a', { ev: 'end', text: 'stopped', status: 'stopped' });
  r = await waitOn(idle);
  assert.equal(r.at, D.startWaitMs);
  assert.deepEqual(r.lines, [START_LINE, 'end: stopped [status=stopped]', 'state: ended']);
  const cursor = idle.cursor('a');
  r = await waitOn(idle);
  assert.equal(r.at, 2 * D.startWaitMs);
  assert.deepEqual(r.lines, ['state: ended']);
  assert.equal(idle.cursor('a'), cursor);
});

test('대기: pid 가 없는 start 는 생존 확인 없이 끝난 상태다', async () => {
  const w = clock('a');
  w.add('a', { ev: 'start', text: 'run started', stage: 'run' });
  const asked = [];
  const r = await waitOn(w, { alive: (pid) => (asked.push(pid), true) });
  assert.equal(r.at, D.startWaitMs);
  assert.deepEqual(r.lines, ['start: run started [stage=run]', 'state: ended']);
  assert.deepEqual(asked, []);
});

test('대기: 전체 수명은 maxLifeMs 를 넘지 않는다', async () => {
  const w = clock('a');
  w.add('a', START);
  let r = await waitOn(w, { batchMs: 3600000 });
  assert.equal(r.at, D.maxLifeMs);
  assert.deepEqual(r.lines, [START_LINE, 'state: running (run, 8 min)']);
  assert.equal(w.cursor('a'), String(w.size('a')));
  // 모으던 묶음이 없으면 상태 줄만
  r = await waitOn(w, { quietMs: 3600000 });
  assert.equal(r.at, 2 * D.maxLifeMs);
  assert.deepEqual(r.lines, ['state: running (run, 17 min)']);
});

test('대기: 다른 대기가 커서를 옮기면 같은 줄을 다시 내지 않고, 커서는 뒤로 가지 않는다', async () => {
  const w = clock('a');
  w.add('a', START);
  await waitOn(w);
  w.addAt(31000, 'a', { ev: 'step', text: 'taken by the other wait' });
  w.at(40000, () => writeFileSync(w.cursorFile('a'), String(w.size('a'))));
  w.addAt(50000, 'a', { ev: 'step', text: 'mine' });
  let r = await waitOn(w);
  assert.equal(r.at, 50000 + D.batchMs);
  assert.deepEqual(r.lines, ['step: mine', 'state: running (run, 1 min)']);
  assert.equal(w.cursor('a'), String(w.size('a')));
  // 내는 동안 다른 대기가 커서를 더 앞으로 옮기면 그 값이 남는다
  w.add('a', { ev: 'alert', text: 'both saw this' });
  let ahead;
  r = await waitOn(w, {
    onWrite: () => {
      w.add('a', { ev: 'note', text: 'later' });
      ahead = String(w.size('a'));
      writeFileSync(w.cursorFile('a'), ahead);
    },
  });
  assert.deepEqual(r.lines, ['alert: both saw this', 'state: running (run, 1 min)']);
  assert.equal(w.cursor('a'), ahead);
  // 이벤트 파일이 커서보다 짧아지면 처음부터 읽고 커서를 바꾼다
  writeFileSync(w.file('a'), '');
  w.add('a', START);
  w.add('a', { ev: 'alert', text: 'new file' });
  r = await waitOn(w);
  assert.deepEqual(r.lines, [START_LINE, 'alert: new file', 'state: running (run, 0 min)']);
  assert.equal(w.cursor('a'), String(w.size('a')));
});

test('대기: 이벤트 파일을 읽지 못하거나 출력이 던져도 0 으로 끝난다', async () => {
  const w = clock('a');
  mkdirSync(w.file('a'), { recursive: true });
  const r = await waitOn(w);
  assert.ok(r.at <= D.maxLifeMs);
  assert.deepEqual(r.lines, ['state: ended']);
  assert.equal(w.cursor('a'), null);
  const code = await waitProgress(w.repo, { now: w.now, sleep: w.sleep, alive, out: { write: () => { throw new Error('closed'); } } });
  assert.equal(code, 0);
});

test('대기: 중간의 읽기 오류는 끝난 상태가 아니라 변화 없음이다', async () => {
  const w = clock('a');
  w.add('a', START);
  await waitOn(w);
  const file = w.file('a');
  const kept = readFileSync(file);
  w.at(40000, () => {
    rmSync(file);
    mkdirSync(file);
  });
  w.at(50000, () => {
    rmSync(file, { recursive: true });
    writeFileSync(file, kept);
    w.add('a', { ev: 'step', text: 'after the error' });
  });
  const r = await waitOn(w);
  assert.equal(r.at, 50000 + D.batchMs);
  assert.deepEqual(r.lines, ['step: after the error', 'state: running (run, 1 min)']);
});

test('대기: 실행이 하나도 없으면 60초 뒤 끝난 상태만 내고 아무 파일도 만들지 않는다', async () => {
  const w = clock();
  const r = await waitOn(w);
  assert.equal(r.at, D.startWaitMs);
  assert.deepEqual(r.lines, ['state: ended']);
  assert.deepEqual(readdirSync(w.repo), []);
});

test('대기: current 가 다른 실행으로 바뀌면 그 실행의 줄을 내고, 커서는 실행마다 따로다', async () => {
  const w = clock('a');
  w.add('a', START);
  w.add('a', { ev: 'alert', text: 'from a' });
  await waitOn(w);
  const cursorA = w.cursor('a');
  w.at(4500, () => {
    w.add('b', { ...START, text: 'run started: 1 tasks' });
    w.add('b', { ev: 'alert', text: 'from b' });
    w.current('b');
  });
  const r = await waitOn(w);
  assert.equal(r.at, 5000);
  assert.deepEqual(r.lines, ['start: run started: 1 tasks [stage=run]', 'alert: from b', 'state: running (run, 0 min)']);
  assert.equal(w.cursor('b'), String(w.size('b')));
  assert.equal(w.cursor('a'), cursorA);
});

test('대기: 실행 고르기는 opts.run, 살아 있는 잠금, current 순서이고 주인이 죽은 잠금은 무시한다', async () => {
  const w = clock('a');
  for (const run of ['a', 'b', 'c']) {
    w.add(run, START);
    w.add(run, { ev: 'alert', text: `from ${run}` });
  }
  const linesOf = (run) => [START_LINE, `alert: from ${run}`, 'state: running (run, 0 min)'];
  // 실제로는 살아 있는 pid 지만 받은 alive 로는 죽은 주인: 잠금을 무시하고 current 를 따른다
  w.lock('b', process.pid);
  assert.deepEqual((await waitOn(w)).lines, linesOf('a'));
  assert.equal(w.cursor('b'), null);
  // 실제로는 없는 pid 지만 받은 alive 로는 살아 있는 주인: 잠금의 실행을 따른다
  w.lock('b');
  assert.deepEqual((await waitOn(w)).lines, linesOf('b'));
  assert.deepEqual((await waitOn(w, { run: 'c' })).lines, linesOf('c'));
  assert.deepEqual(['a', 'b', 'c'].map((run) => w.cursor(run)), ['a', 'b', 'c'].map((run) => String(w.size(run))));
});

test('대기: split 흉내 - 잠금만 먼저 잡히고 조금 뒤 새 실행의 start 가 오면 그 실행을 이어 읽는다', async () => {
  const w = clock('old');
  w.add('old', START);
  w.add('old', { ev: 'end', text: 'done 3 of 3', status: 'done' });
  writeFileSync(w.cursorFile('old'), '7');
  w.at(5000, () => w.lock('new'));
  w.addAt(5400, 'new', { ev: 'start', text: 'split started', pid: LIVE, stage: 'split' });
  w.addAt(20000, 'new', { ev: 'step', text: 'split session started', stage: 'split' });
  const r = await waitOn(w);
  assert.equal(r.at, 36000); // start 를 처음 본 확인(6초)부터 30초
  assert.deepEqual(r.lines, ['start: split started [stage=split]', 'step: split session started [stage=split]', 'state: running (split, 0 min)']);
  assert.equal(w.cursor('new'), String(w.size('new')));
  assert.equal(w.cursor('old'), '7');
});

test('대기: 잠금과 새 start 사이의 틈 - 잠금이 가리킨 실행의 끝난 옛 start 를 새것으로 읽지 않는다', async () => {
  const w = clock('other');
  w.add('x', START);
  w.add('x', { ev: 'end', text: 'stopped', status: 'stopped' });
  w.at(2000, () => w.lock('x'));
  w.at(5000, () => {
    w.add('x', { ev: 'start', text: 'answer started', pid: LIVE, stage: 'answer', task: 'T01' });
    w.add('x', { ev: 'alert', text: 'T01 blocked', task: 'T01' });
  });
  const r = await waitOn(w);
  assert.equal(r.at, 5000);
  assert.deepEqual(r.lines, [START_LINE, 'end: stopped [status=stopped]', 'start: answer started [stage=answer task=T01]', 'alert: T01 blocked [task=T01]', 'state: running (answer, 0 min)']);
  assert.equal(w.cursor('other'), null);
});

test('대기: 확인 사이에 통째로 끝난 명령 - current 가 새 실행으로 바뀌어 있으면 그 줄들과 끝난 상태를 낸다', async () => {
  const w = clock('a');
  w.at(3500, () => {
    w.add('b', { ev: 'start', text: 'split started', pid: LIVE, stage: 'split' });
    w.add('b', { ev: 'end', text: 'split into 3 tasks, 0 open decisions', status: 'done', stage: 'split' });
    w.current('b');
  });
  const r = await waitOn(w);
  assert.equal(r.at, 4000);
  assert.deepEqual(r.lines, ['start: split started [stage=split]', 'end: split into 3 tasks, 0 open decisions [stage=split status=done]', 'state: ended']);
  assert.equal(w.cursor('b'), String(w.size('b')));
});

test('대기: 잠금으로 따라가던 실행은 잠금이 사라져도 놓지 않고 그 end 를 낸다', async () => {
  const w = clock('other');
  w.lock('x');
  w.add('x', START);
  await waitOn(w);
  w.at(40500, () => {
    w.add('x', { ev: 'end', text: 'run failed (exit 2)', status: 'failed', stage: 'run' });
    w.unlock();
  });
  const r = await waitOn(w);
  assert.equal(r.at, 41000);
  assert.deepEqual(r.lines, ['end: run failed (exit 2) [stage=run status=failed]', 'state: ended']);
  assert.equal(w.cursor('other'), null);
});

// ---- progress 명령: 실제 프로세스, 실제 시계

let cmdRepo; // 아래 세 테스트가 같이 쓰는 저장소
const DESIGN = (r) => path.join(r.repo, 'docs', 'design.md');
/** 실행 폴더들에 있는 커서 파일: `<실행>/<파일 이름>`. */
function cursorFiles(r) {
  const runs = path.join(r.repo, '.orchestrator', 'runs');
  return readdirSync(runs).flatMap((run) => readdirSync(path.join(runs, run)).filter((f) => f.endsWith('.cursor')).map((f) => `${run}/${f}`)).sort();
}

test('progress: 먼저 띄운 대기가 뒤에 시작한 split 의 소식을 내고 끝난다', { timeout: 90000 }, async () => {
  const r = (cmdRepo = makeRepo());
  assert.equal(r.orch('doctor').code, 0);
  assert.equal(r.orch('split', DESIGN(r), '--run', 'old').code, 0);
  const proc = r.start('progress');
  const closed = new Promise((res) => proc.on('close', (code) => res(code)));
  await sleep(2000);
  const res = r.orch('split', DESIGN(r));
  assert.equal(res.code, 0, res.out);
  assert.equal(await closed, 0, proc.out);
  const lines = proc.out.trimEnd().split('\n');
  assert.ok(lines.includes('start: split started [stage=split]'), proc.out);
  assert.ok(lines.some((l) => l.startsWith('end: split into 3 tasks')), proc.out);
  assert.equal(lines.at(-1), 'state: ended', proc.out);
  assert.deepEqual(cursorFiles(r), [`${path.basename(r.runDir())}/progress.terminal.cursor`]);
});

test('progress: 다른 명령이 잠금을 잡고 있어도 돈다', () => {
  const r = cmdRepo;
  const lock = path.join(r.repo, '.orchestrator', 'lock.json');
  const at = new Date().toISOString();
  writeFileSync(lock, JSON.stringify({ pid: process.pid, command: 'run', startedAt: at, run: path.basename(r.runDir()) }));
  try {
    appendFileSync(eventFile(r), `${JSON.stringify({ t: at, ev: 'start', text: 'run started: 3 tasks', pid: process.pid, stage: 'run' })}\n${JSON.stringify({ t: at, ev: 'alert', text: 'T01 blocked', task: 'T01', status: 'blocked' })}\n`);
    const res = r.orch('progress', '--consumer', 'main');
    assert.equal(res.code, 0, res.out);
    const lines = res.out.trimEnd().split('\n');
    assert.ok(lines.includes('alert: T01 blocked [task=T01 status=blocked]'), res.out);
    assert.match(lines.at(-1), /^state: running \(run, \d+ min\)$/, res.out);
    const retry = r.orch('retry', 'T01');
    assert.equal(retry.code, 2, retry.out);
    assert.match(retry.out, /이미 돌고 있는 명령/);
  } finally {
    rmSync(lock, { force: true });
  }
});

test('progress: 잘못 부르면 이유, 사용법, state: ended 를 내고 종료 코드 1', () => {
  const r = cmdRepo;
  const before = cursorFiles(r);
  const began = Date.now();
  for (const args of [['--consumer', 'Main'], ['--run', '../x'], ['--other'], ['extra']]) {
    const res = r.orch('progress', ...args);
    const lines = res.out.trimEnd().split('\n');
    assert.equal(res.code, 1, res.out);
    assert.equal(lines.length, 3, res.out);
    assert.equal(lines[1], 'usage: node orchestrator.mjs progress [--run <run>] [--consumer <name>]');
    assert.equal(lines[2], 'state: ended');
  }
  assert.ok(Date.now() - began < 20000, 'ends at once');
  assert.deepEqual(cursorFiles(r), before);
});
