// Run: node --test tests/orchestrator-drive.test.mjs
// 스킬이 모는 기능(status --json, 잠금)과 스킬을 부르는 방식(slash/inline) 테스트. 공통 도우미·전체 명령은 tests/orchestrator-helpers.mjs
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { task, planOf, DEF, M1, E1, makeRepo, prepared, statusJson } from './orchestrator-helpers.mjs';

// ------------------------------------------------------------------ 스킬이 몰기 위한 기능: status --json, 잠금, am 찾기

test('status --json: 다음에 할 일(next)과 답할 결정·막힌 작업을 구조로 알려 준다', () => {
  const plan = planOf([task('T01', 't01-a'), task('T02', 't02-b', ['T01']), task('T03', 't03-c')], [{ id: 'D1', what: '첫 화면을 무엇으로 할까', whyNow: '화면 구성이 달라짐', options: [{ label: '목록', effect: '목록이 먼저' }, { label: '상세', effect: '상세가 먼저' }], recommended: '목록', undo: 'easy', blocks: ['T03'], answer: null }]);
  const r = makeRepo({ plan, scenario: { plan: { 't01-a': ['NEEDS_DECISION'] }, autoDecide: ['t03-c'] } });
  let st = statusJson(r);
  assert.deepEqual([st.ready, st.next, st.run, st.running], [false, 'doctor', null, null]);
  assert.equal(r.orch('doctor').code, 0);
  assert.equal(statusJson(r).next, 'split');
  assert.equal(r.orch('split', path.join(r.repo, 'docs', 'design.md')).code, 0);
  st = statusJson(r);
  assert.equal(st.next, 'decide', '실행 전에 답할 결정부터');
  assert.deepEqual(st.decisions.map((d) => [d.id, d.what, d.options.length, d.recommended, d.blocks]), [['D1', '첫 화면을 무엇으로 할까', 2, '목록', ['T03']]]);
  assert.deepEqual([st.run.total, st.run.done, st.run.branch], [3, 0, null]);
  assert.ok(existsSync(path.join(r.repo, st.run.tasks)) && existsSync(path.join(r.repo, st.run.tasksJson)));
  assert.equal(r.orch('decide', 'D1', '목록').code, 0);
  assert.equal(statusJson(r).next, 'run');
  assert.equal(r.orch('run').code, 1, '답을 기다리는 작업이 남으면 1');
  st = statusJson(r);
  assert.equal(st.next, 'answer');
  assert.deepEqual(st.needsDecision.map((n) => n.id), ['T01']);
  assert.match(readFileSync(path.join(r.repo, st.needsDecision[0].file), 'utf8'), /which screen first/);
  assert.equal(st.run.done, 1, '무관한 작업(T03)은 그사이 끝난다');
  assert.deepEqual(st.autoDecided, ['T03: 첫 화면은 목록으로 한다 - 지금 화면과 가장 비슷함 (자동 결정)']);
  assert.equal(r.orch('answer', 'T01', '목록 먼저').code, 0);
  assert.equal(statusJson(r).next, 'run');
  assert.equal(r.orch('run').code, 0);
  st = statusJson(r);
  assert.deepEqual([st.next, st.run.done, st.run.total], ['done', 3, 3]);
  assert.ok(st.costUsd > 0 && existsSync(path.join(r.repo, st.run.report)));
  assert.match(st.run.branch, /^orch\//);
});

test('status --json: 막힌 작업은 단계·사유·이어 가는 방법과 함께, 형식이 틀린 작업 목록은 오류와 함께 알려 준다', () => {
  const r = prepared({ plan: planOf([task('T01', 't01-a'), task('T02', 't02-b', ['T01'])]), scenario: { implement: { 't01-a': ['BLOCKED', 'DONE'] } } });
  assert.equal(r.orch('run').code, 1);
  let st = statusJson(r);
  assert.equal(st.next, 'blocked');
  assert.deepEqual(st.blocked.map((b) => [b.id, b.stage]), [['T01', 'implement']]);
  assert.match(st.blocked[0].hint, /retry T01 --from implement/);
  assert.ok(existsSync(path.join(r.repo, st.blocked[0].logs)));
  assert.equal(r.orch('retry', 'T01', '--from', 'implement').code, 0);
  assert.equal(statusJson(r).next, 'run');
  assert.equal(r.orch('run').code, 0);
  const tasks = path.join(r.repo, statusJson(r).run.tasksJson);
  const broken = JSON.parse(readFileSync(tasks, 'utf8'));
  broken.tasks[0].size = 'L';
  writeFileSync(tasks, JSON.stringify(broken));
  st = statusJson(r);
  assert.equal(st.next, 'fix-tasks');
  assert.match(st.errors.join('\n'), /"size" must be S or M/);
});

test('스킬의 절차(status --json 의 next 만 보고 다음 명령을 정함)대로 몰면 질문에 답해 가며 끝까지 간다', () => {
  // orchestrator/skills/run/SKILL.md 의 4단계를 그대로 옮긴 운전자. 사용자의 답은 미리 정해 둔 것으로 대신한다.
  const plan = planOf([task('T01', 't01-a'), task('T02', 't02-b', ['T01']), task('T03', 't03-c')], [{ id: 'D1', what: '첫 화면을 무엇으로 할까', whyNow: '화면 구성이 달라짐', options: [{ label: '목록', effect: '목록이 먼저' }, { label: '상세', effect: '상세가 먼저' }], recommended: '목록', undo: 'easy', blocks: ['T03'], answer: null }]);
  const r = makeRepo({ plan, scenario: { plan: { 't01-a': ['NEEDS_DECISION'] }, implement: { 't02-b': ['BLOCKED', 'DONE'] } } });
  const seen = [];
  const asked = [];
  for (let step = 0; step < 30; step += 1) {
    const st = statusJson(r);
    seen.push(st.next);
    if (st.next === 'done') break;
    if (st.next === 'doctor') assert.equal(r.orch('doctor').code, 0);
    else if (st.next === 'split') assert.equal(r.orch('split', path.join(r.repo, 'docs', 'design.md')).code, 0);
    else if (st.next === 'decide') {
      for (const d of st.decisions) {
        asked.push(`${d.id}: ${d.what}`); // 여기서 사용자에게 결정 카드로 묻는다
        assert.equal(r.orch('decide', d.id, d.options[0].label).code, 0);
      }
    } else if (st.next === 'answer') {
      for (const n of st.needsDecision) {
        asked.push(`${n.id}: ${readFileSync(path.join(r.repo, n.file), 'utf8').split('\n')[0]}`);
        assert.equal(r.orch('answer', n.id, '첫 번째 안으로').code, 0);
      }
    } else if (st.next === 'blocked') {
      for (const b of st.blocked) assert.equal(r.orch('retry', b.id, '--from', b.stage).code, 0); // 원인을 없앤 뒤 안내(hint)대로
    } else if (st.next === 'run') assert.ok([0, 1].includes(r.orch('run').code));
    else assert.fail(`스킬이 다루지 않는 next: ${st.next}`);
  }
  assert.deepEqual(seen, ['doctor', 'split', 'decide', 'run', 'answer', 'run', 'blocked', 'run', 'done']);
  assert.deepEqual(asked, ['D1: 첫 화면을 무엇으로 할까', 'T01: Decision card: which screen first? 1) list 2) detail'], '사용자에게 묻는 것은 답이 필요한 두 번뿐');
  assert.deepEqual(r.statusOf(), { T01: 'done', T02: 'done', T03: 'done' });
});

// Windows 에서는 끝에서 보내는 SIGINT 를 검사할 수 없다(위 Ctrl+C 테스트와 같은 이유).
test('잠금: 실행 중에는 다른 명령이 끼어들지 못하고, status 는 무엇이 돌고 있는지 알려 준다', { skip: process.platform === 'win32' }, async () => {
  const r = prepared({ plan: planOf([task('T01', 't01-a')]), scenario: { implement: { 't01-a': ['SLOW', 'DONE'] } } });
  const proc = r.start('run');
  const pidFile = path.join(r.repo, '.orchestrator', 'fake-slow.pid');
  for (let i = 0; i < 200 && !existsSync(pidFile); i += 1) await new Promise((res) => setTimeout(res, 50));
  assert.ok(existsSync(pidFile), '느린 세션이 시작됨');
  const st = statusJson(r);
  assert.equal(st.next, 'wait');
  assert.deepEqual([st.running.pid, st.running.command, st.running.task, st.running.stage], [proc.pid, 'run', 'T01', 'implement']);
  for (const args of [['run'], ['retry', 'T01'], ['done', 'T01'], ['doctor']]) {
    const second = r.orch(...args);
    assert.equal(second.code, 2, args.join(' '));
    assert.match(second.out, /이미 돌고 있는 명령이 있습니다: run \(pid \d+/);
  }
  assert.equal(r.orch('run', '--dry-run').code, 0, '읽기만 하는 명령은 된다');
  const exited = new Promise((res) => proc.on('exit', (code) => res(code)));
  proc.kill('SIGINT');
  assert.equal(await exited, 130);
  assert.ok(!existsSync(path.join(r.repo, '.orchestrator', 'lock.json')), '끝나면 잠금을 푼다');
  assert.equal(statusJson(r).running, null);
  // 주인이 죽은 잠금(강제 종료 등)은 무시한다
  writeFileSync(path.join(r.repo, '.orchestrator', 'lock.json'), JSON.stringify({ pid: 2 ** 22 + 12345, command: 'run', startedAt: 'x' }));
  assert.equal(statusJson(r).next, 'run');
  assert.equal(r.orch('run').code, 0);
  assert.equal(r.g('status', '--porcelain').trim(), '', '잠금 파일은 git 에 잡히지 않는다');
});

test('잠금: dry-run 을 구현한 것은 run 뿐이라, 다른 명령에 --dry-run 을 붙여도 잠금을 건너뛰지 않는다', () => {
  const r = prepared({ plan: planOf([task('T01', 't01-a')]) });
  const lock = path.join(r.repo, '.orchestrator', 'lock.json');
  // 이 테스트 프로세스가 살아 있으므로 잠금의 주인이 살아 있는 것으로 보인다
  writeFileSync(lock, JSON.stringify({ pid: process.pid, command: 'run', startedAt: 'x' }));
  try {
    for (const args of [['split', 'x', '--dry-run'], ['retry', 'T01', '--dry-run']]) {
      const second = r.orch(...args);
      assert.equal(second.code, 2, `${args.join(' ')}\n${second.out}`);
      assert.match(second.out, /이미 돌고 있는 명령이 있습니다: run \(pid \d+/);
    }
    assert.equal(r.orch('run', '--dry-run').code, 0, '읽기만 하는 run --dry-run 은 된다');
    const st = statusJson(r);
    assert.equal(st.next, 'wait');
    assert.equal(st.running.command, 'run');
  } finally {
    rmSync(lock, { force: true });
  }
});

// ------------------------------------------------------------------ 흐름

test('슬래시 스킬이 없으면 SKILL.md 를 채워 넘기는 방식으로 같은 흐름이 돈다', () => {
  const r = makeRepo({ plan: planOf([task('T01', 't01-a')]) });
  r.orch.env = { FAKE_NO_SLASH: '1' };
  const d = r.orch('doctor');
  assert.equal(d.code, 0, d.out);
  assert.match(d.out, /스킬 호출 방식: inline/);
  assert.equal(r.orch('split', path.join(r.repo, 'docs', 'design.md')).code, 0);
  const run = r.orch('run');
  assert.equal(run.code, 0, run.out);
  assert.equal(r.statusOf().T01, 'done');
  assert.ok(r.calls().some((c) => /^Follow the instructions in \.orchestrator\/runs\/[^/]+\/T01\/skill-check\.md exactly/.test(c.prompt)));
  const skill = readFileSync(path.join(r.runDir(), 'T01', 'skill-check.md'), 'utf8');
  assert.ok(!skill.startsWith('---') && !skill.includes('$ARGUMENTS') && !skill.includes('${CLAUDE_PLUGIN_ROOT}'));
  assert.match(skill, /Target: t01-a/);
});

test('설정이 단계의 모델이나 effort 를 바꾸면 그 단계의 스킬만 inline 으로 불러 넘긴 값이 쓰이게 한다', () => {
  const one = () => planOf([task('T01', 't01-a')]);
  const flags = (c) => ['--model', '--effort'].map((f) => c.argv[c.argv.indexOf(f) + 1]);
  const r = prepared({ plan: one(), config: { model: { commit: M1 }, effort: { check: E1 } } });
  assert.match(r.orch('run', '--dry-run').out, /스킬 호출 방식 slash\(check·commit 는 설정이 모델·effort 를 바꿔 inline\)/);
  const run = r.orch('run');
  assert.equal(run.code, 0, run.out);
  assert.match(run.out, /스킬 호출 방식 slash\(check·commit 는 설정이 모델·effort 를 바꿔 inline\)/);
  const calls = r.calls();
  // 바꾸지 않은 단계는 슬래시 호출 그대로, 기본값으로(스킬 머리말과 같은 값이라 어느 쪽이 쓰여도 같다)
  assert.deepEqual(flags(calls.find((c) => c.prompt.startsWith('/am:plan Plan task T01'))), DEF('plan'));
  assert.deepEqual(flags(calls.find((c) => c.prompt === `/am:do t01-a`)), DEF('implement'));
  // 바꾼 단계는 머리말을 뗀 SKILL.md 를 넘기므로 플래그만 남는다
  assert.deepEqual(flags(calls.find((c) => /T01\/skill-check\.md exactly/.test(c.prompt))), [DEF('check')[0], E1]);
  assert.deepEqual(flags(calls.find((c) => /T01\/skill-commit\.md exactly/.test(c.prompt))), [M1, DEF('commit')[1]]);
  assert.ok(!calls.some((c) => c.prompt.startsWith('/am:check') || c.prompt.startsWith('/am:commit')));
  assert.ok(!readFileSync(path.join(r.runDir(), 'T01', 'skill-commit.md'), 'utf8').startsWith('---'));
  // skillMode 를 slash 로 고정했으면 바꾼 단계도 슬래시 호출 그대로 둔다
  const s = prepared({ plan: one(), config: { skillMode: 'slash', model: { commit: M1 } } });
  const fixed = s.orch('run');
  assert.equal(fixed.code, 0, fixed.out);
  assert.match(fixed.out, /스킬 호출 방식 slash {2}구현 스킬/);
  assert.deepEqual(flags(s.calls().find((c) => c.prompt === '/am:commit task T01 t01-a')), [M1, DEF('commit')[1]]);
  // 객체가 아닌 값(문자열 하나)은 조용히 기본값으로 돌리지 않고, 세션을 띄우기 전에 알린다
  s.setConfig({ effort: 'low' });
  const bad = s.orch('run');
  assert.equal(bad.code, 2, bad.out);
  assert.match(bad.out, /config\.json 의 "effort" 값은 단계별 값을 담은 객체여야 합니다/);
});
