// 오케스트레이터의 진행 소식(.orchestrator/runs/<실행>/progress.jsonl)과 잠금 파일의 실행 이름.
// 끝나는 길(정상, 막힘, 실패, 중단)마다 start 하나에 end 하나가 남고, am 의 대기 명령(plugin/scripts/progress.mjs)이 그 줄을 읽을 수 있는지 본다.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { readFrom, stateLine } from '../plugin/scripts/progress.mjs';
import { makeRepo, planOf, prepared, task } from './orchestrator-helpers.mjs';

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
