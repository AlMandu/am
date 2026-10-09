// Run: node --test tests/orchestrator.test.mjs
// 공통 도우미·전체 명령은 tests/orchestrator-helpers.mjs
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { applySplit, claudeArgs, codexOpinionRules, DEFAULT_MAX_SESSIONS, defaults, globToRegExp, lastMarker, mayOverlap, merge, nextTask, parallelism, parseArgs, parseResult, readUserModels, recordHeld, STAGE_DEFAULTS, stageOverridden, startable, userModelsFile, validatePlan, verdictFromFile, winQuote } from '../orchestrator/scripts/orchestrator.mjs';
import { task, planOf, CHAIN, own, DEF, M1, M2, E1, E2, E3, prepared, tmp } from './orchestrator-helpers.mjs';

// ------------------------------------------------------------------ 순수 함수

test('validatePlan: 올바른 목록은 통과, 흔한 실수는 잡는다', () => {
  assert.deepEqual(validatePlan(CHAIN()), []);
  const bad = CHAIN();
  bad.tasks[0].size = 'L';
  bad.tasks[0].acceptance = [];
  bad.tasks[1].dependsOn = ['T03']; // 뒤에 오는 작업에 의존
  bad.tasks[2].slug = 't01-a';
  const errs = validatePlan(bad).join('\n');
  for (const frag of ['"size" must be S or M', '"acceptance"', 'dependsOn "T03"', 'duplicate slug']) assert.match(errs, new RegExp(frag));
  assert.match(validatePlan({ tasks: [task('T01', 't01-a')] }).join('\n'), /coverage/);
  assert.match(validatePlan(planOf([task('T01', 't01-a')], [{ id: 'D1', what: 'x', options: [{ label: 'a' }], blocks: ['T09'] }])).join('\n'), /at least 2 options[\s\S]*blocks "T09"/);
});

test('applySplit: 부모를 하위 작업으로 바꾸고 의존·결정·대비표를 고친다', () => {
  const plan = planOf([task('T01', 't01-a'), task('T02', 't02-b', ['T01']), task('T03', 't03-c', ['T02'])], [{ id: 'D1', what: 'x', options: [{ label: 'a' }, { label: 'b' }], blocks: ['T02'], answer: null }]);
  const next = applySplit(plan, plan.tasks[1], { reason: 'big', tasks: [{ key: 'core', title: 'c', goal: 'g', files: [], acceptance: ['ok'], dependsOn: [] }, { key: 'ui', title: 'u', goal: 'g', files: [], acceptance: ['ok'], dependsOn: ['core'] }] });
  assert.deepEqual(next.tasks.map((t) => t.id), ['T01', 'T02.1', 'T02.2', 'T03']);
  assert.deepEqual(next.tasks[1].dependsOn, ['T01']);
  assert.deepEqual(next.tasks[2].dependsOn, ['T01', 'T02.1']);
  assert.deepEqual(next.tasks[3].dependsOn, ['T02.1', 'T02.2']);
  assert.equal(next.tasks[2].slug, 't02-b-2-ui');
  assert.deepEqual(next.decisions[0].blocks, ['T02.1', 'T02.2']);
  assert.deepEqual(next.coverage[0].tasks, ['T01', 'T02.1', 'T02.2', 'T03']);
  assert.equal(plan.tasks.length, 3, '원본은 그대로');
  assert.throws(() => applySplit(plan, plan.tasks[1], { tasks: [{ key: 'a', title: 't', goal: 'g', acceptance: ['ok'], dependsOn: ['nope'] }, { key: 'b', title: 't', goal: 'g', acceptance: ['ok'] }] }));
});

test('nextTask: 의존 작업과 결정 대기를 지킨다', () => {
  const plan = planOf([task('T01', 't01-a'), task('T02', 't02-b', ['T01']), task('T03', 't03-c')], [{ id: 'D1', what: 'x', options: [{ label: 'a' }, { label: 'b' }], blocks: ['T03'], answer: null }]);
  const state = { tasks: { T01: { status: 'blocked' }, T02: { status: 'pending' }, T03: { status: 'pending' } } };
  assert.equal(nextTask(plan, state), null);
  plan.decisions[0].answer = 'a';
  assert.equal(nextTask(plan, state).id, 'T03');
  state.tasks.T01.status = 'implemented';
  assert.equal(nextTask(plan, state).id, 'T01', '중단된 작업을 먼저 이어 간다');
});

test('동시 진행 판단: 예상 파일 겹침, 지금 시작할 작업, 동시에 돌릴 수', () => {
  assert.equal(mayOverlap(['src/a.txt'], ['src/b.txt']), false);
  assert.equal(mayOverlap(['src/**'], ['src/b.txt']), true);
  assert.equal(mayOverlap(['Assets/Scripts/Save/**'], ['Assets/Scripts/UI/**']), false);
  assert.equal(mayOverlap(['.\\Docs\\A.md'], ['docs/a.md']), true, '역슬래시, ./, 대소문자를 정리해 비교');
  assert.equal(mayOverlap(['**/*.cs'], ['x/y.txt']), true);
  assert.equal(mayOverlap([], ['x']), true, '빈 힌트는 모두와 겹친다');
  const plan = planOf([own('T01', 't01-a'), own('T02', 't02-b', ['T01']), own('T03', 't03-c'), task('T04', 't04-d', [], { files: ['src/t03-c.txt'] })]);
  const state = { tasks: { T01: { status: 'pending' }, T02: { status: 'pending' }, T03: { status: 'pending' }, T04: { status: 'pending' } } };
  const ids = (list) => list.map((t) => t.id);
  assert.deepEqual(ids(startable(plan, state, [], 3)), ['T01', 'T03'], 'T02 는 의존 대기, T04 는 T03 과 겹침');
  assert.deepEqual(ids(startable(plan, state, [], 1)), ['T01']);
  assert.deepEqual(ids(startable(plan, state, ['T03'], 3)), ['T01'], '계획 중인 작업과도 겹침을 본다');
  state.tasks.T01 = { status: 'planned', running: 'implement' };
  assert.deepEqual(ids(startable(plan, state, ['T01'], 3)), [], '이 저장소에서 구현 중인 작업은 혼자 돈다');
  state.tasks.T01.worktree = '.orchestrator/wt/r/T01';
  assert.deepEqual(ids(startable(plan, state, ['T01'], 3)), ['T03'], '별도 작업 공간에서 구현 중이면 다른 작업을 띄운다');
  state.tasks.T01 = { status: 'planned' };
  assert.deepEqual(ids(startable(plan, state, [], 3, { exclusive: true })), ['T01'], '이 저장소가 더러우면 하다 만 작업 하나만');
  assert.deepEqual(ids(startable(plan, state, ['T03'], 3, { exclusive: true })), []);
  state.tasks.T01 = { status: 'implemented' };
  assert.deepEqual(ids(startable(plan, state, [], 3)), ['T01'], '이 저장소에서 구현을 마친 작업은 혼자 이어 간다');
  assert.deepEqual(ids(startable(plan, state, ['T03'], 3)), [], '다른 작업이 끝날 때까지 기다린다');
  assert.equal(defaults().parallel, 3);
  assert.deepEqual(parallelism({ parallel: 1 }, null, 'k'), { max: 1, reason: '' });
  assert.equal(parallelism({ parallel: 3 }, { worktree: { ok: true, key: 'k' } }, 'k').max, 3);
  assert.deepEqual([parallelism({ parallel: 3 }, { worktree: { ok: true, key: 'old' } }, 'k').max, parallelism({ parallel: 3 }, { worktree: { ok: true, key: 'old' } }, 'k').stale], [1, true], 'am-gate.json 이나 worktreeSetup 이 바뀌면 다시 확인');
  const no = parallelism({ parallel: 3 }, { worktree: { ok: false, key: 'k', reason: '게이트 fail' } }, 'k');
  assert.deepEqual([no.max, no.stale], [1, undefined]);
  assert.match(no.reason, /게이트 fail/);
  assert.equal(parallelism({ parallel: 'x' }, null, 'k').max, 1);
  // 이 PC 의 동시 세션 제한: 그보다 많이 함께 돌리지 않는다
  assert.deepEqual([parallelism({ parallel: 3 }, { worktree: { ok: true, key: 'k' } }, 'k', 2).max, parallelism({ parallel: 3 }, { worktree: { ok: true, key: 'k' } }, 'k', 2).sessions], [2, true]);
  const one = parallelism({ parallel: 3 }, { worktree: { ok: true, key: 'k' } }, 'k', 1);
  assert.equal(one.max, 1);
  assert.match(one.reason, /동시에 돌릴 세션을 1개로 제한/);
  assert.deepEqual(parallelism({ parallel: 2 }, { worktree: { ok: true, key: 'k' } }, 'k', 3), { max: 2, reason: '' }, '제한보다 적으면 그대로');
  assert.equal(DEFAULT_MAX_SESSIONS, 3);
});

test('recordHeld: 같은 호스트의 죽은 pid 와 5분 넘게 새로 고치지 않은 기록은 빈 자리, 막 깨어났으면 기다려 준다', () => {
  const now = 10 * 60000;
  const alive = (pid) => pid === 1;
  const o = { now, myHost: 'me', alive };
  assert.equal(recordHeld({ host: 'me', pid: 1, mtimeMs: now - 1000 }, o), true);
  assert.equal(recordHeld({ host: 'me', pid: 2, mtimeMs: now - 1000 }, o), false, '같은 호스트의 죽은 pid');
  assert.equal(recordHeld({ host: 'other', pid: 2, mtimeMs: now - 1000 }, o), true, '다른 호스트 이름의 pid 는 확인할 수 없어 새로 고친 시각만 본다');
  assert.equal(recordHeld({ host: 'other', pid: 2, mtimeMs: now - 6 * 60000 }, o), false, '5분 넘게 새로 고치지 않음');
  assert.equal(recordHeld({ host: 'me', pid: 1, mtimeMs: now - 6 * 60000 }, o), false, 'pid 가 재사용됐어도 새로 고치지 않으면 빈 자리');
  assert.equal(recordHeld({ host: 'other', pid: 2, mtimeMs: now - 6 * 60000 }, { ...o, woke: true }), true, '잠자기에서 막 깨어났으면 주인이 새로 고칠 때까지 기다린다');
  assert.equal(recordHeld({ host: 'me', pid: 2, mtimeMs: now }, { ...o, woke: true }), false, '죽은 pid 는 깨어난 직후에도 빈 자리');
  assert.equal(recordHeld({ host: 'me', pid: 1, mtimeMs: now - 6 * 60000 }, { ...o, young: true }), true, '막 시작한 프로세스는 같은 호스트의 살아 있는 주인이 새로 고칠 때까지 기다린다');
  assert.equal(recordHeld({ host: 'other', pid: 1, mtimeMs: now - 6 * 60000 }, { ...o, young: true }), false, '다른 호스트 이름은 확인할 수 없어 새로 고친 시각만 본다');
});

test('작은 도구들', () => {
  assert.ok(globToRegExp('src/**').test('src/a/b.cs'));
  assert.ok(globToRegExp('Assets/**/*.cs').test('Assets/Scripts/Save/A.cs'));
  assert.ok(globToRegExp('Assets/**/*.cs').test('Assets/A.cs'));
  assert.ok(!globToRegExp('Assets/*.cs').test('Assets/Scripts/A.cs'));
  assert.ok(globToRegExp('docs').test('docs/x.md') && globToRegExp('a.txt').test('a.txt') && !globToRegExp('a.txt').test('a.txt2'));
  assert.equal(lastMarker('x\nORCH_STATUS: READY\ny\nORCH_STATUS: TOO_BIG', 'ORCH_STATUS', ['READY', 'TOO_BIG']), 'TOO_BIG');
  assert.equal(lastMarker('**ORCH_VERDICT: note**', 'ORCH_VERDICT', ['BLOCK', 'NOTE']), 'NOTE');
  assert.equal(lastMarker('no marker', 'ORCH_STATUS', ['DONE']), null);
  assert.equal(verdictFromFile('# 점검\n- 판정: **BLOCK** (게이트 실패)\n'), 'BLOCK');
  assert.equal(verdictFromFile('Verdict: NOTE\nBLOCK 사유 없음'), 'NOTE');
  assert.equal(verdictFromFile('게이트 통과'), null);
  assert.equal(parseResult('{"type":"result","result":"a","session_id":"s"}').session_id, 's');
  assert.equal(parseResult('[{"type":"system"},{"type":"result","result":"b"}]').result, 'b');
  assert.equal(parseResult('warn: x\n{"type":"result","result":"c"}\n').result, 'c');
  assert.equal(parseResult('not json'), null);
  assert.deepEqual(merge({ a: { b: 1, c: 2 }, d: [1] }, { a: { b: 9 }, d: [2], _notes: 'x' }), { a: { b: 9, c: 2 }, d: [2] });
  assert.equal(winQuote('--permission-mode'), '--permission-mode');
  assert.equal(winQuote('Read,Edit(.am/**),Bash(git status *)'), '"Read,Edit(.am/**),Bash(git status *)"');
  assert.equal(winQuote('/am:plan t01-a'), '"/am:plan t01-a"');
  assert.throws(() => winQuote('say "hi"'));
  assert.deepEqual(parseArgs(['retry', 'T01', '--from', 'check', '--dry-run']), { pos: ['retry', 'T01'], opt: { from: 'check', 'dry-run': true } });
});

test('claudeArgs: 단계별 권한과 이어 가기', () => {
  const cfg = merge(defaults(), { model: { default: 'sonnet', implement: 'opus' }, pluginDir: '/p', extraArgs: { all: ['--effort', 'high'] } });
  const plan = claudeArgs(cfg, 'plan', { prompt: '/am:plan x', systemFile: 's.md' });
  assert.deepEqual(plan.slice(0, 6), ['-p', '/am:plan x', '--output-format', 'json', '--permission-mode', 'dontAsk']);
  assert.match(plan[plan.indexOf('--allowedTools') + 1], /Edit\(\/\.am\/\*\*\),Edit\(\.am\/\*\*\)/, '저장소 루트 기준 규칙이 함께 들어간다(세션이 cd 해도 루트의 .am 에 쓸 수 있게)');
  assert.match(claudeArgs(cfg, 'split', { prompt: 'x' }).join(' '), /Edit\(\/\.orchestrator\/\*\*\)/);
  assert.ok(!plan[plan.indexOf('--allowedTools') + 1].split(',').includes('Bash'), '계획 단계는 임의 셸 명령을 못 쓴다');
  assert.equal(plan[plan.indexOf('--append-system-prompt-file') + 1], 's.md');
  assert.equal(plan[plan.indexOf('--model') + 1], 'sonnet');
  const fix = claudeArgs(cfg, 'fix', { prompt: 'x', resume: 'sid', systemFile: 's.md' });
  assert.equal(fix[fix.indexOf('--resume') + 1], 'sid');
  assert.ok(!fix.includes('--append-system-prompt-file'));
  assert.equal(fix[fix.indexOf('--permission-mode') + 1], 'acceptEdits');
  assert.match(fix[fix.indexOf('--disallowedTools') + 1], /Bash\(git commit \*\).*Bash\(git push \*\)/);
  assert.equal(fix[fix.indexOf('--model') + 1], 'opus', 'fix 는 implement 의 모델을 물려받는다');
  const reask = claudeArgs(cfg, 'plan', { prompt: 'x', resume: 'sid' });
  assert.equal(reask[reask.indexOf('--model') + 1], 'sonnet', '이어 가는 세션에도 처음과 같은 모델을 넘긴다');
  const eff = merge(defaults(), { extraArgs: { plan: ['--effort', 'medium'], implement: ['--effort', 'high'], fix: ['--effort', 'low'] } });
  assert.deepEqual(claudeArgs(eff, 'answer', { prompt: 'x', resume: 's' }).slice(-2), ['--effort', 'medium'], 'answer 는 plan 의 플래그를 물려받는다');
  assert.deepEqual(claudeArgs(eff, 'fix', { prompt: 'x', resume: 's' }).slice(-2), ['--effort', 'low'], '따로 적으면 그 값이 우선');
  const check = claudeArgs(eff, 'check', { prompt: 'x' });
  assert.equal(check[check.indexOf('--effort') + 1], STAGE_DEFAULTS.check.effort, '플래그를 적지 않은 단계는 기본 effort 로');
  const denied = fix[fix.indexOf('--disallowedTools') + 1].split(',');
  assert.ok(denied.includes('Bash(git stash)') && denied.includes('Bash(git stash push *)') && denied.includes('Bash(git stash pop)'));
  assert.ok(!denied.includes('Bash(git stash *)'), 'git stash list 처럼 읽기만 하는 명령은 막지 않는다');
  const commit = claudeArgs(cfg, 'commit', { prompt: 'x' });
  assert.match(commit[commit.indexOf('--allowedTools') + 1], /Bash\(git restore \*\)/, '커밋 세션은 빌드 산출물을 되돌릴 수 있다');
  assert.match(commit[commit.indexOf('--allowedTools') + 1], /Bash\(git commit \*\)/);
  assert.match(commit[commit.indexOf('--disallowedTools') + 1], /Bash\(git push \*\)/);
  for (const stage of ['implement', 'check', 'fix', 'commit']) {
    const a = claudeArgs(cfg, stage, { prompt: 'x' });
    const no = a[a.indexOf('--disallowedTools') + 1].split(',');
    assert.ok(no.includes('Bash(git push)') && no.includes('Bash(git push *)'), `${stage} 는 인자 없는 git push 도 막는다`);
  }
});

test('claudeArgs: 계획 묶음 세션은 am 의 codex-opinion.mjs 하나만 더 실행할 수 있다', () => {
  const cfg = defaults();
  const am = path.join(os.tmpdir(), 'am plugin');
  const script = `${am.split(path.sep).join('/')}/scripts/codex-opinion.mjs`;
  for (const phase of ['plan', 'answer', 'probe']) {
    const a = claudeArgs(cfg, phase, { prompt: 'x', amRoot: am });
    const allow = a[a.indexOf('--allowedTools') + 1].split(',');
    assert.ok(allow.includes(`Bash(node "${script}" *)`) && allow.includes(`Bash(node ${script} *)`), phase);
    assert.ok(allow.includes(`Bash(node "${am}/scripts/codex-opinion.mjs" *)`), '세션이 적는 모양: 플러그인 경로 그대로 + /scripts/...');
    assert.ok(!allow.some((r) => /codex exec|^Bash$|Bash\(node \*/.test(r)), 'codex 나 node 를 통째로 열지 않는다');
  }
  assert.deepEqual(codexOpinionRules(''), [], 'am 경로를 모르면 열지 않는다');
  const without = claudeArgs(cfg, 'plan', { prompt: 'x' });
  assert.ok(!without[without.indexOf('--allowedTools') + 1].includes('codex-opinion'));
  for (const phase of ['split', 'commit']) {
    const a = claudeArgs(cfg, phase, { prompt: 'x', amRoot: am });
    assert.ok(!a.join(' ').includes('codex-opinion'), phase);
  }
  assert.equal(cfg.timeoutMin.plan, 75, '2차 의견 토론까지 들어가는 계획 세션의 시간');
  assert.equal(cfg.timeoutMin.answer, 75);
});

test('claudeArgs: 설정에 적지 않은 단계는 기본 모델과 effort 로 돈다', () => {
  /** 그 단계에 넘기는 [--model, --effort] 값. 같은 플래그를 두 번 넘기면 실패. */
  const of = (cfg, phase, opts = {}) => {
    const a = claudeArgs(cfg, phase, { prompt: 'x', ...opts });
    return ['--model', '--effort'].map((flag) => {
      assert.equal(a.indexOf(flag), a.lastIndexOf(flag), `${phase}: ${flag} 는 한 번만 넘긴다`);
      return a.includes(flag) ? a[a.indexOf(flag) + 1] : null;
    });
  };
  assert.ok(M1 && M2 && E1 && E2, '기본값에 쓰지 않은 모델과 effort 가 2개씩 있어야 시험할 수 있다');
  const d = defaults();
  for (const phase of ['split', 'plan', 'implement', 'check', 'commit']) assert.deepEqual(of(d, phase), DEF(phase), phase);
  assert.deepEqual(of(d, 'probe', { format: 'stream-json' }), DEF('plan'), 'doctor 의 시험 호출은 plan 의 값으로: 그 모델을 못 쓰는 계정은 doctor 에서 드러난다');
  assert.deepEqual(of(d, 'fix', { resume: 's' }), DEF('implement'), '이어 가는 세션에도 처음과 같은 값을 넘긴다');
  assert.deepEqual(of(d, 'answer', { resume: 's' }), DEF('plan'));
  assert.deepEqual(of(d, 'split', { resume: 's' }), DEF('split'), '표시 줄을 되묻는 호출도 같다');
  // 설정: 단계에 적은 값 → 물려받는 단계의 값 → default → 기본값
  const cfg = merge(defaults(), { model: { default: M1, implement: M2 }, effort: { default: E1, implement: E2, fix: E3 } });
  assert.deepEqual(of(cfg, 'check'), [M1, E1], 'default 는 적지 않은 모든 단계에 쓰인다');
  assert.deepEqual(of(cfg, 'implement'), [M2, E2]);
  assert.deepEqual(of(cfg, 'fix', { resume: 's' }), [M2, E3]);
  assert.deepEqual(of(cfg, 'answer', { resume: 's' }), [M1, E1]);
  // extraArgs 에 같은 플래그가 있으면 그쪽 것만 넘긴다
  const extra = merge(defaults(), { extraArgs: { all: ['--effort', E1], commit: ['--model', M2] } });
  assert.deepEqual(of(extra, 'commit'), [M2, E1]);
  assert.deepEqual(of(extra, 'plan'), [DEF('plan')[0], E1]);
  // `--이름=값` 한 덩어리로 적어도 같다
  const joined = merge(defaults(), { extraArgs: { commit: [`--model=${M2}`], check: [`--effort=${E1}`] } });
  assert.deepEqual(of(joined, 'commit'), [null, DEF('commit')[1]], `모델은 extraArgs 의 --model=${M2} 만 넘긴다`);
  assert.ok(claudeArgs(joined, 'commit', { prompt: 'x' }).includes(`--model=${M2}`));
  assert.deepEqual(of(joined, 'check'), [DEF('check')[0], null]);
  assert.ok(stageOverridden(joined, 'commit') && stageOverridden(joined, 'check') && !stageOverridden(joined, 'plan'));
  // 설정이 단계의 값을 기본값과 다르게 정했는지: 어디에 적었든(단계 키, default, extraArgs) 넘기는 값으로 본다
  const stages = ['plan', 'implement', 'check', 'commit'];
  assert.deepEqual(stages.filter((p) => stageOverridden(d, p)), []);
  assert.deepEqual(stages.filter((p) => stageOverridden(cfg, p)), stages);
  assert.deepEqual(stages.filter((p) => stageOverridden(extra, p)), stages);
  const same = merge(defaults(), { model: Object.fromEntries(stages.map((p) => [p, DEF(p)[0]])), effort: { commit: DEF('commit')[1] }, extraArgs: { plan: ['--effort', DEF('plan')[1]] } });
  assert.deepEqual(stages.filter((p) => stageOverridden(same, p)), [], '기본값과 같은 값을 적은 것은 바꾼 것이 아니다');
  assert.deepEqual(stages.filter((p) => stageOverridden(merge(defaults(), { effort: { implement: E2 } }), p)), ['implement']);
});

test('사용자 모델 설정 파일: am 과 같은 경로와 검사', () => {
  const dir = tmp('orch-user-');
  assert.equal(userModelsFile({ CLAUDE_CONFIG_DIR: dir }), path.join(dir, 'am', 'models.json'));
  const file = path.join(dir, 'models.json');
  assert.deepEqual(readUserModels(file), { model: {}, effort: {} }, '파일이 없으면 빈 값');
  writeFileSync(file, '{"model":{"implement":"opus"}}');
  const implement = readUserModels(file).error;
  assert.ok(implement.includes(file) && implement.includes('"do"'), implement);
  writeFileSync(file, '{"effort":{"check":"huge"}}');
  const huge = readUserModels(file).error;
  assert.ok(huge.includes(file) && huge.includes('huge'), huge);
});

test('claudeArgs: 사용자 파일은 저장소 설정 다음 층(모델·effort 따로)', () => {
  const of = (cfg, phase, opts = {}) => {
    const a = claudeArgs(cfg, phase, { prompt: 'x', ...opts });
    return ['--model', '--effort'].map((flag) => {
      assert.equal(a.indexOf(flag), a.lastIndexOf(flag), `${phase}: ${flag} 는 한 번만 넘긴다`);
      return a.includes(flag) ? a[a.indexOf(flag) + 1] : null;
    });
  };
  const withUser = (repo, model = {}, effort = {}) => ({ ...merge(defaults(), repo), userModels: { model, effort } });
  const all = withUser({}, { default: M1 });
  for (const phase of ['split', 'plan', 'implement', 'check', 'commit']) assert.deepEqual(of(all, phase), [M1, DEF(phase)[1]], phase);
  assert.deepEqual(of(all, 'fix', { resume: 's' }), [M1, DEF('implement')[1]]);
  assert.deepEqual(of(all, 'answer', { resume: 's' }), [M1, DEF('plan')[1]]);
  assert.deepEqual(of(all, 'probe', { format: 'stream-json' }), [M1, DEF('plan')[1]]);
  // 저장소 default 가 사용자 단계 키보다 앞서고, effort 는 저장소에 없으니 사용자 default 가 쓰인다
  assert.deepEqual(of(withUser({ model: { default: M2 } }, { check: M1 }, { default: E1 }), 'check'), [M2, E1]);
  // 사용자 키 do 는 implement·fix, plan 은 answer·probe
  const keyed = withUser({}, { do: M1, plan: M2 });
  assert.deepEqual(of(keyed, 'implement'), [M1, DEF('implement')[1]]);
  assert.deepEqual(of(keyed, 'fix', { resume: 's' }), [M1, DEF('implement')[1]]);
  assert.deepEqual(of(keyed, 'answer', { resume: 's' }), [M2, DEF('plan')[1]]);
  assert.deepEqual(of(keyed, 'probe', { format: 'stream-json' }), [M2, DEF('plan')[1]]);
  assert.deepEqual(of(withUser({ model: { implement: M2 } }, { do: M1 }), 'fix', { resume: 's' })[0], M2, '저장소의 implement 가 사용자 do 보다 우선');
  // extraArgs 의 플래그가 사용자 값보다 우선
  const extra = withUser({ extraArgs: { commit: ['--model', M2], check: [`--effort=${E2}`] } }, { default: M1 }, { default: E1 });
  assert.deepEqual(of(extra, 'commit'), [M2, E1]);
  assert.deepEqual(of(extra, 'check'), [M1, null]);
  assert.ok(claudeArgs(extra, 'check', { prompt: 'x' }).includes(`--effort=${E2}`));
  // 사용자 값만으로 기본값과 달라진 단계만 바꾼 것으로 본다
  const stages = ['plan', 'implement', 'check', 'commit'];
  assert.deepEqual(stages.filter((p) => stageOverridden(withUser({}, { check: M1 }), p)), ['check']);
  assert.deepEqual(stages.filter((p) => stageOverridden(withUser({}, { plan: DEF('plan')[0] }, { commit: DEF('commit')[1] }), p)), []);
});

test('사용자 파일이 단계 값을 바꾸면 inline 으로 부르고, 깨졌으면 세션 전에 멈춘다', () => {
  const r = prepared({ plan: planOf([task('T01', 't01-a')]) });
  const file = path.join(r.home, 'am', 'models.json');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ model: { check: M1 } }));
  const dry = r.orch('run', '--dry-run');
  assert.equal(dry.code, 0, dry.out);
  assert.match(dry.out, /스킬 호출 방식 slash\(check 는 설정이 모델·effort 를 바꿔 inline\)/);
  assert.match(dry.out, new RegExp(`\\[check\\]\\n[^\\n]*--model ${M1}`));
  writeFileSync(file, '{"effort":{"check":"huge"}}');
  const before = r.calls().length;
  const run = r.orch('run');
  assert.equal(run.code, 2, run.out);
  assert.ok(run.out.includes(file) && run.out.includes('사용자 모델 설정 파일이 잘못돼 세션을 띄우지 않고 멈춥니다'), run.out);
  assert.equal(r.calls().length, before, '세션을 띄우지 않는다');
});

// ------------------------------------------------------------------ 흐름

test('정상 흐름: 세 작업을 순서대로 계획 → 구현 → 점검 → 커밋', () => {
  const r = prepared();
  assert.ok(existsSync(path.join(r.runDir(), 'tasks.md')) && existsSync(path.join(r.runDir(), 'design.md')));
  const dry = r.orch('run', '--dry-run');
  assert.match(dry.out, new RegExp(`T01[\\s\\S]*T02[\\s\\S]*T03[\\s\\S]*/am:do t01-a[\\s\\S]*/am:check t01-a[\\s\\S]*/am:commit task T01 t01-a`));
  const run = r.orch('run');
  assert.equal(run.code, 0, run.out);
  assert.deepEqual(r.statusOf(), { T01: 'done', T02: 'done', T03: 'done' });
  assert.equal(r.g('rev-parse', '--abbrev-ref', 'HEAD').trim(), `orch/${path.basename(r.runDir())}`);
  assert.deepEqual(r.g('log', '--format=%s', 'main..HEAD').trim().split('\n').reverse(), ['feat(t01-a): fake commit', 'feat(t02-b): fake commit', 'feat(t03-c): fake commit']);
  assert.equal(r.g('status', '--porcelain').trim(), '', '.am 과 .orchestrator 는 git 에 안 잡힌다');
  assert.ok(r.calls().every((c) => c.cwd === realpathSync(r.repo)), '예상 파일이 모두 겹치면(src/**) 하나씩, 이 저장소에서 돈다');
  const prompts = r.calls().map((c) => c.prompt).filter((p) => p.startsWith('/am:'));
  assert.deepEqual(prompts.slice(0, 4), ['/am:plan Plan task T01 described in .am/t01-a/brief.md (slug t01-a)', `/am:do t01-a`, '/am:check t01-a', '/am:commit task T01 t01-a']);
  const brief = readFileSync(path.join(r.repo, '.am', 't02-b', 'brief.md'), 'utf8');
  assert.match(brief, /T01 T01 제목: for what was actually built read \.am\/t01-a\/plan\.md/);
  assert.match(brief, /## Out of scope[\s\S]*T03 T03 제목/);
  const report = readFileSync(path.join(r.runDir(), 'report.md'), 'utf8');
  assert.match(report, /3 \/ 3 완료/);
  assert.match(report, /사람 확인: t02-b 화면에서/, '작업별 check.md 의 사람 확인 항목이 보고서에 모인다');
  assert.equal(r.state().tasks.T01.gate, 'pass');
  assert.equal(r.orch('run').code, 0, '다시 실행해도 할 일이 없다');
});

test('점검에서 막히면 구현 세션을 이어 고치고 다시 점검한다', () => {
  const r = prepared({ plan: planOf([task('T01', 't01-a')]), scenario: { breakGate: ['t01-a'] } });
  const run = r.orch('run');
  assert.equal(run.code, 0, run.out);
  const s = r.state().tasks.T01;
  assert.equal(s.status, 'done');
  assert.equal(s.fixRounds, 1);
  const fix = r.calls().find((c) => c.prompt.startsWith('am:check blocked'));
  assert.equal(fix.argv[fix.argv.indexOf('--resume') + 1], s.sessions.implement);
  assert.ok(existsSync(path.join(r.runDir(), 'T01', 'check-1.md')) && existsSync(path.join(r.runDir(), 'T01', 'check-2.md')));
});

test('점검 세션이 통과라 해도 게이트가 실패하면 커밋하지 않는다', () => {
  const r = prepared({ scenario: { breakGateAlways: ['t01-a'], check: { 't01-a': ['SILENT'] } }, config: { maxFixRounds: 1 } });
  const run = r.orch('run');
  assert.equal(run.code, 1, run.out);
  assert.deepEqual(r.statusOf(), { T01: 'blocked', T02: 'pending', T03: 'pending' });
  assert.match(r.state().tasks.T01.reason, /게이트 fail/);
  assert.equal(r.g('log', '--format=%s', 'main..HEAD').trim(), '', '커밋 없음');
  assert.ok(!r.calls().some((c) => c.prompt.startsWith('/am:commit')));
  assert.match(readFileSync(path.join(r.runDir(), 'report.md'), 'utf8'), /T01 T01 제목: 막힘/);
  // 사람이 고친 뒤 점검부터 다시
  rmSync(path.join(r.repo, 'BROKEN'));
  assert.equal(r.orch('retry', 'T01', '--from', 'check').code, 0);
  assert.equal(r.orch('run', '--only', 'T01').code, 1, '나머지 작업이 남아 종료 코드는 1');
  assert.equal(r.statusOf().T01, 'done');
});

test('onBlock=stash: 막힌 작업은 보관하고 무관한 작업을 이어 간다', () => {
  const r = prepared({ scenario: { implement: { 't01-a': ['BLOCKED'] } }, config: { onBlock: 'stash' } });
  const run = r.orch('run');
  assert.equal(run.code, 1, run.out);
  assert.deepEqual(r.statusOf(), { T01: 'blocked', T02: 'pending', T03: 'done' });
  assert.match(r.g('stash', 'list'), new RegExp(`am-orchestrator ${path.basename(r.runDir())} T01`));
  assert.equal(r.state().tasks.T01.stash, `am-orchestrator ${path.basename(r.runDir())} T01`);
  assert.equal(r.g('show', '--stat', '--format=', 'HEAD').includes('t01-a'), false, '막힌 작업의 변경은 다음 커밋에 섞이지 않는다');
  assert.match(readFileSync(path.join(r.runDir(), 'report.md'), 'utf8'), /변경은 stash 에 보관/);
});

test('claude 가 오류로 끝나면 상태를 남기고 멈췄다가, 다시 실행하면 그 단계부터 이어 간다', () => {
  const r = prepared({ scenario: { implement: { 't02-b': ['CRASH', 'DONE'] } } });
  const run = r.orch('run');
  assert.equal(run.code, 2, run.out);
  assert.match(run.out, /\[implement\][\s\S]*다시 실행하면/);
  assert.deepEqual(r.statusOf(), { T01: 'done', T02: 'planned', T03: 'pending' });
  const again = r.orch('run');
  assert.equal(again.code, 0, again.out);
  assert.deepEqual(r.statusOf(), { T01: 'done', T02: 'done', T03: 'done' });
  const systems = r.calls().filter((c) => c.prompt === `/am:do t02-b`).map((c) => readFileSync(path.join(r.repo, c.argv[c.argv.indexOf('--append-system-prompt-file') + 1]), 'utf8'));
  assert.ok(!/earlier attempt/.test(systems[0]) && /earlier attempt/.test(systems[1]), '두 번째 시도에는 남은 변경을 먼저 보라고 알려 준다');
});

test('보고서와 status 는 지금 돌고 있는 단계를 보여 주고, 예상 파일 밖 변경에서 .meta 는 뺀다', () => {
  const r = prepared({ plan: planOf([task('T01', 't01-a'), task('T02', 't02-b', ['T01'])]), scenario: { snapshotReport: true, extraFiles: ['docs/note.md', 'lib/thing.cs.meta'] } });
  assert.equal(r.orch('run').code, 0);
  const during = readFileSync(path.join(r.repo, '.orchestrator', 'report-during-implement.md'), 'utf8');
  assert.match(during, /진행: 1 \/ 2 완료, 지금 T02 구현 중/);
  assert.match(during, /\| T02 \| 진행 중\(구현 중\) \|/);
  const after = readFileSync(path.join(r.runDir(), 'report.md'), 'utf8');
  assert.ok(!after.includes('진행 중'), '끝나면 표시가 사라진다');
  const notes = r.state().tasks.T01.notes.join('\n');
  assert.match(notes, /예상 파일 밖 변경 1개: docs\/note\.md/);
  assert.ok(!notes.includes('.meta'));
});

// Windows 에서 child.kill('SIGINT') 는 신호 처리기를 거치지 않고 바로 끝내므로(종료 코드 null) 검사할 수 없다.
test('Ctrl+C: 돌고 있던 세션도 함께 끝내고, 다시 실행하면 끊긴 단계부터 이어 간다', { skip: process.platform === 'win32' }, async () => {
  const r = prepared({ plan: planOf([task('T01', 't01-a')]), scenario: { implement: { 't01-a': ['SLOW', 'DONE'] } } });
  const proc = r.start('run');
  const pidFile = path.join(r.repo, '.orchestrator', 'fake-slow.pid');
  for (let i = 0; i < 200 && !existsSync(pidFile); i += 1) await new Promise((res) => setTimeout(res, 50));
  assert.ok(existsSync(pidFile), '느린 세션이 시작됨');
  const sessionPid = Number(readFileSync(pidFile, 'utf8'));
  const exited = new Promise((res) => proc.on('exit', (code) => res(code)));
  proc.kill('SIGINT');
  assert.equal(await exited, 130);
  let alive = true;
  for (let i = 0; i < 100 && alive; i += 1) {
    try {
      process.kill(sessionPid, 0);
      await new Promise((res) => setTimeout(res, 50));
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false, '세션 프로세스가 남아 있지 않다');
  assert.equal(r.statusOf().T01, 'planned');
  assert.match(r.orch('status').out, /T01\s+계획됨/, '중단하면 진행 중 표시를 지우고 저장된 단계를 보여 준다');
  assert.equal(r.orch('run').code, 0);
  assert.equal(r.statusOf().T01, 'done');
  assert.ok(!r.orch('status').out.includes('진행 중'));
});
