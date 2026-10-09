// Run: node --test tests/orchestrator-sessions.test.mjs
// 이 PC 전체의 동시 세션 제한·남은 메모리 대기와 같은 초 스냅샷 테스트. 공통 도우미·전체 명령은 tests/orchestrator-helpers.mjs
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DEFAULT_MIN_FREE_MEMORY_MB, memoryShortMB, snapshot } from '../orchestrator/scripts/orchestrator.mjs';
import { task, planOf, PAR, sleep, makeRepo, prepared, statusJson } from './orchestrator-helpers.mjs';

// ------------------------------------------------------------------ 이 PC 전체의 동시 세션 수

test('sessions: 이 PC 의 동시 세션 제한을 보고 바꾸며, 값은 Claude 설정 폴더 아래에 남는다', () => {
  const r = makeRepo();
  const file = path.join(r.home, 'am-orchestrator', 'settings.json');
  let out = r.orch('sessions');
  assert.equal(out.code, 0, out.out);
  assert.match(out.out, /최대 3개 \(기본값\)/);
  assert.ok(out.out.includes(`설정 파일: ${file}`), out.out);
  assert.match(out.out, /지금 도는 세션 0개/);
  out = r.orch('sessions', '2');
  assert.equal(out.code, 0, out.out);
  assert.match(out.out, /바꿨습니다: 최대 2개\.[\s\S]*최대 2개 \(직접 정함\)/);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { maxSessions: 2 });
  assert.equal(statusJson(r).sessions.max, 2);
  for (const bad of ['0', 'x', '1.5']) {
    const b = r.orch('sessions', bad);
    assert.equal(b.code, 2, bad);
    assert.match(b.out, /사용법: sessions/);
  }
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { maxSessions: 2 }, '잘못된 값은 저장하지 않는다');
  writeFileSync(file, JSON.stringify({ maxSessions: 0 }));
  assert.match(r.orch('sessions').out, /최대 3개 \(settings\.json 의 maxSessions 값이 잘못돼 기본값을 씀: 0\)/);
  writeFileSync(file, '{ broken');
  assert.match(r.orch('sessions').out, /최대 3개 \(settings\.json 을 읽지 못해 기본값을 씀\)/);
  out = r.orch('sessions', 'default');
  assert.equal(out.code, 0, out.out);
  assert.match(out.out, /기본값\(3개\)으로 되돌렸습니다\.[\s\S]*최대 3개 \(기본값\)/);
  // 설정 폴더에 쓸 수 없으면 이유와 함께 멈춘다
  writeFileSync(path.join(r.home, 'not-a-folder'), '');
  r.orch.env = { CLAUDE_CONFIG_DIR: path.join(r.home, 'not-a-folder') };
  const blocked = r.orch('sessions', '2');
  r.orch.env = {};
  assert.equal(blocked.code, 2, blocked.out);
  assert.match(blocked.out, /설정을 저장하지 못했습니다: .*CLAUDE_CONFIG_DIR/);
});

test('이 PC 의 세션 제한이 1이면 parallel 이 3이어도 하나씩 돌고, 세션 기록은 끝나면 지워진다', () => {
  const r = makeRepo({ plan: PAR() });
  assert.equal(r.orch('sessions', '1').code, 0);
  const d = r.orch('doctor');
  assert.equal(d.code, 0, d.out);
  assert.match(d.out, /이 PC 의 동시 세션 제한 1개\(직접 정함, 모든 실행을 합쳐 셈\)/);
  assert.match(d.out, /서로 무관한 작업을 최대 1개까지 동시에 진행합니다\(parallel 3, 이 PC 의 동시 세션 제한 1\)/);
  assert.equal(r.orch('split', path.join(r.repo, 'docs', 'design.md')).code, 0);
  const st = statusJson(r);
  assert.deepEqual([st.parallel.max, st.sessions.max, st.sessions.inUse, st.sessions.shared], [1, 1, 0, true]);
  assert.match(st.parallel.reason, /동시에 돌릴 세션을 1개로 제한/);
  const run = r.orch('run');
  assert.equal(run.code, 0, run.out);
  assert.match(run.out, /동시 진행 하나씩\n  하나씩 진행하는 이유: 이 PC 에서 동시에 돌릴 세션을 1개로 제한했습니다/);
  assert.deepEqual(r.statusOf(), { T01: 'done', T02: 'done', T03: 'done' });
  assert.ok(r.calls().every((c) => c.cwd === realpathSync(r.repo)), '별도 작업 공간을 쓰지 않는다');
  assert.ok(existsSync(path.join(r.home, 'am-orchestrator', 'sessions')), '기록은 테스트용 Claude 설정 폴더 아래에 생긴다');
  assert.deepEqual(r.records(), [], '끝나면 기록이 남지 않는다');
});

test('다른 실행이 이 PC 의 세션 자리를 모두 쓰고 있으면 기다렸다가 이어 가고, 주인 없는 기록은 세지 않는다', async () => {
  const r = prepared({ plan: planOf([task('T01', 't01-a')]), config: { parallel: 1 } }); // 하나씩 돌면 로그 머리표가 없어 기다림 줄이 작업 ID 를 직접 적는다
  assert.equal(r.orch('sessions', '1').code, 0);
  const dir = path.join(r.home, 'am-orchestrator', 'sessions');
  mkdirSync(dir, { recursive: true });
  const host = os.hostname().replace(/[^\w.-]/g, '_') || 'host';
  writeFileSync(path.join(dir, `${host}~2147483647~1.json`), '{}'); // 있을 수 없는 프로세스 번호의 기록(끝난 프로세스의 번호는 동시에 도는 다른 테스트가 다시 받을 수 있다)
  const old = path.join(dir, 'old-host~1~1.json');
  writeFileSync(old, '{}');
  const past = new Date(Date.now() - 10 * 60000);
  utimesSync(old, past, past); // 10분 동안 새로 고치지 않은 기록(강제 종료된 다른 PC 이름의 실행)
  assert.match(r.orch('sessions').out, /지금 도는 세션 0개/);
  const other = path.join(dir, 'other-host~4242~1.json');
  writeFileSync(other, JSON.stringify({ repo: '/elsewhere', phase: 'implement' })); // 다른 실행이 쥔 자리
  assert.match(r.orch('sessions').out, /지금 도는 세션 1개\n  - \/elsewhere  implement/);
  const proc = r.start('run');
  const exited = new Promise((res) => proc.on('exit', (code) => res(code)));
  try {
    for (let i = 0; i < 200 && !/자리가 날 때까지 기다립니다/.test(proc.out); i += 1) await sleep(50);
    assert.match(proc.out, /\n {4}T01 plan: 이 PC 에서 오케스트레이터 세션 1개가 돌고 있어 자리가 날 때까지 기다립니다 \(최대 1개, 바꾸려면 `sessions <N>`\)/);
    await sleep(1500);
    assert.equal(r.calls().filter((c) => c.prompt.startsWith('/am:plan Plan task')).length, 0, '자리가 날 때까지 세션을 띄우지 않는다');
    assert.equal(statusJson(r).next, 'wait');
  } finally {
    rmSync(other, { force: true }); // 실패해도 실행이 5분 기다리며 남지 않게
  }
  assert.equal(await exited, 0, proc.out);
  assert.equal(r.statusOf().T01, 'done');
  assert.deepEqual(r.records(), [], '주인 없는 기록도 정리된다');
});

// ------------------------------------------------------------------ 남은 메모리

test('memoryShortMB: 다른 세션·게이트가 돌 때만, 남은 메모리가 기준보다 적으면 기다리게 한다', { timeout: 10000 }, () => {
  const MB = 1048576;
  const short = (o) => memoryShortMB({ busy: 1, freeBytes: 100 * MB, setting: 500, platform: 'linux', ...o });
  assert.deepEqual(short({}), { freeMB: 100, needMB: 500 });
  assert.equal(short({ busy: 0 }), null, '혼자면 바로 시작');
  assert.equal(short({ setting: 0 }), null);
  assert.equal(short({ setting: '0' }), null);
  assert.equal(short({ freeBytes: 500 * MB }), null);
  assert.deepEqual(short({ setting: '500', platform: 'darwin' }), { freeMB: 100, needMB: 500 }, '직접 적은 값은 어느 OS 에서나');
  assert.equal(DEFAULT_MIN_FREE_MEMORY_MB, 3072);
  for (const setting of [null, undefined, '', 'abc', -5]) {
    assert.equal(short({ setting }), null, `기본 기준은 win32 에서만: ${setting}`);
    assert.deepEqual(short({ setting, platform: 'win32', freeBytes: 3071 * MB }), { freeMB: 3071, needMB: 3072 }, String(setting));
    assert.equal(short({ setting, platform: 'win32', freeBytes: 3072 * MB }), null, String(setting));
  }
});

/** 다른 호스트의 기록 하나를 둔 채 run 을 띄워 메모리 대기 줄을 기다린다. 기록을 지우면 이어서 끝난다. */
async function waitsForMemory(r, name, record) {
  const dir = path.join(r.home, 'am-orchestrator', 'sessions');
  mkdirSync(dir, { recursive: true });
  const other = path.join(dir, name);
  writeFileSync(other, JSON.stringify(record));
  const proc = r.start('run');
  const exited = new Promise((res) => proc.on('exit', (code) => res(code)));
  try {
    for (let i = 0; i < 200 && !/시작을 미룹니다/.test(proc.out); i += 1) await sleep(50);
    assert.match(proc.out, /\n {4}T01 plan: PC 의 남은 메모리가 \d+MB 로 기준 1000000000MB 보다 적어, 다른 세션이나 게이트가 끝나거나 메모리가 생길 때까지 시작을 미룹니다 \(끄려면 config\.json 의 minFreeMemoryMB: 0\)/);
    await sleep(1500);
    assert.equal(r.calls().filter((c) => c.prompt.startsWith('/am:plan Plan task')).length, 0, '메모리가 생길 때까지 세션을 띄우지 않는다');
    assert.equal(statusJson(r).next, 'wait');
  } finally {
    rmSync(other, { force: true });
  }
  assert.equal(await exited, 0, proc.out);
  assert.equal(r.statusOf().T01, 'done');
  assert.deepEqual(r.records(), [], '세션·게이트 기록이 남지 않는다');
  const notes = readFileSync(path.join(r.runDir(), 'progress.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(notes.some((e) => e.ev === 'note' && e.task === 'T01' && /^waiting for free memory \(\d+ MB free, needs 1000000000 MB\)$/.test(e.text)), JSON.stringify(notes));
}

test('다른 세션이 돌고 남은 메모리가 기준보다 적으면 세션 시작을 미루고, 그 세션이 끝나면 이어 간다', { timeout: 60000 }, async () => {
  const r = prepared({ plan: planOf([task('T01', 't01-a')]), config: { parallel: 1, minFreeMemoryMB: 1e9 } });
  await waitsForMemory(r, 'other-host~4242~1.json', { repo: '/elsewhere', phase: 'implement' });
});

test('게이트 기록은 동시 세션 수에는 세지 않고 메모리 확인에서만 센다', { timeout: 60000 }, async () => {
  const r = prepared({ plan: planOf([task('T01', 't01-a')]), config: { parallel: 1 } });
  const dir = path.join(r.home, 'am-orchestrator', 'sessions');
  mkdirSync(dir, { recursive: true });
  const gate = path.join(dir, 'other-host~4243~1.gate.json');
  writeFileSync(gate, JSON.stringify({ repo: '/elsewhere', phase: 'gate' }));
  assert.match(r.orch('sessions').out, /지금 도는 세션 0개/);
  assert.equal(statusJson(r).sessions.inUse, 0);
  const run = r.orch('run'); // minFreeMemoryMB 0: 바로 진행
  assert.equal(run.code, 0, run.out);
  assert.doesNotMatch(run.out, /시작을 미룹니다/);
  assert.equal(r.statusOf().T01, 'done');
  rmSync(gate, { force: true });
  const r2 = prepared({ plan: planOf([task('T01', 't01-a')]), config: { parallel: 1, minFreeMemoryMB: 1e9 } });
  await waitsForMemory(r2, 'other-host~4243~1.gate.json', { repo: '/elsewhere', phase: 'gate' });
});

// ------------------------------------------------------------------ 흐름

test('스냅샷은 같은 초 안에 같은 크기로 다시 쓰인 파일도 놓치지 않는다', async () => {
  // git 은 수정 시각을 초 단위로 비교한다. 빌드가 설정 값 한 글자만 바꾸면(크기 같음) 인덱스 사본의 시각에 따라 "안 바뀜"으로 보일 수 있다.
  // 초와 크기가 같으면 git 은 "인덱스 파일의 초 <= 항목의 초"일 때만 내용을 다시 비교한다. 시계에 맞춰 같은 초에 쓰는 대신
  // 파일의 시각을 직접 되돌리고 인덱스 파일을 항목보다 1초 뒤로 둔다. snapshot() 이 사본의 시각을 앞당기면 사본이 항목보다
  // 1초 앞이라 내용을 비교해 잡고, 앞당기지 않으면 놓친다(제품은 2초를 앞당기고, 여기서 검사하는 간격은 1초다).
  // 한계: utimesSync 는 밀리초 아래를 되돌리지 못한다. 나노초까지 비교하는 git(USE_NSEC 빌드)이나 core.fsmonitor 를 켠 PC 에서는
  // 앞당기기가 없어도 통과한다.
  const r = makeRepo({ churn: true });
  r.g('config', 'core.trustctime', 'false'); // POSIX 에서는 utimesSync 가 ctime 을 지금으로 바꿔 그것만으로 "바뀜"이 된다
  const blobOf = (tree) => r.g('rev-parse', `${tree}:settings.asset`).trim();
  const file = path.join(r.repo, 'settings.asset');
  r.g('checkout', 'HEAD', '--', 'settings.asset');
  const before = statSync(file);
  const second = Math.floor(before.mtimeMs / 1000); // 인덱스 항목에 적힌 초
  writeFileSync(file, readFileSync(file, 'utf8').replace('prefilter: 0', 'prefilter: 2')); // 같은 크기
  const at = new Date(Math.floor(before.mtimeMs));
  utimesSync(file, at, at); // 같은 초
  const after = statSync(file);
  assert.deepEqual([Math.floor(after.mtimeMs / 1000), after.size], [second, before.size], 'git 이 보는 초와 크기가 같아야 이 테스트가 뜻이 있다');
  const indexAt = new Date((second + 1) * 1000 + 500);
  utimesSync(path.join(r.repo, '.git', 'index'), indexAt, indexAt); // 여기서 snapshot() 까지 git 명령을 넣으면 인덱스가 다시 쓰여 이 시각이 풀린다
  await sleep(1100); // 사본이 원본의 시각이 아니라 지금 시각을 갖는 곳에서도 사본의 초가 항목의 초보다 뒤가 되게
  const tree = snapshot(r.repo);
  assert.ok(tree);
  assert.notEqual(blobOf(tree), blobOf('HEAD'), '다시 쓰인 내용이 스냅샷에 들어 있어야 한다');
  assert.equal(r.g('diff', '--cached', '--name-only').trim(), '', '실제 인덱스는 건드리지 않는다');
});
