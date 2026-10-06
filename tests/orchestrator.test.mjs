// Run: node --test tests/orchestrator.test.mjs   (about a minute)
// 오케스트레이터(orchestrator/scripts/orchestrator.mjs)를 실제 claude 없이 검증한다.
// 가짜 claude(tests/fake-claude.mjs)가 각 단계의 결과 파일과 커밋을 만들고, 게이트와 스킬 파일은 이 저장소의 plugin/ 것을 그대로 쓴다.
// 다른 버전의 am 으로 돌려 보려면: AM_PLUGIN_ROOT=<그 am 의 plugin 폴더>
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { applySplit, claudeArgs, codexOpinionRules, defaults, enforceRequired, globToRegExp, lastMarker, mayOverlap, merge, nextTask, parallelism, parseArgs, parseResult, snapshot, STAGE_DEFAULTS, stageOverridden, startable, validatePlan, verdictFromFile, winQuote } from '../orchestrator/scripts/orchestrator.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ORCH = path.join(here, '..', 'orchestrator', 'scripts', 'orchestrator.mjs');
const FAKE = path.join(here, 'fake-claude.mjs');
const PLUGIN = process.env.AM_PLUGIN_ROOT || path.join(here, '..', 'plugin');
// 구현 단계가 부르는 명령: am 0.1.4 이상(am:do 있음)은 /am:do, 그 전은 /am:plan
const IMPL = existsSync(path.join(PLUGIN, 'skills', 'do', 'SKILL.md')) ? '/am:do' : '/am:plan';

const task = (id, slug, dependsOn = [], extra = {}) => ({ id, slug, group: 'g', title: `${id} 제목`, goal: '목표', designRefs: ['1장'], files: ['src/**'], dependsOn, acceptance: ['게이트 통과'], size: 'S', risk: [], ...extra });
const planOf = (tasks, decisions = []) => ({ version: 1, summary: '요약', decisions, tasks, coverage: [{ section: '1장', tasks: tasks.map((t) => t.id) }], uncovered: [] });
const CHAIN = () => planOf([task('T01', 't01-a'), task('T02', 't02-b', ['T01']), task('T03', 't03-c')]);
// 예상 파일이 저마다 다른 작업(가짜 claude 는 src/<slug>.txt 를 만든다): 서로 무관하면 함께 돌 수 있다
const own = (id, slug, dependsOn = []) => task(id, slug, dependsOn, { files: [`src/${slug}.txt`] });
const PAR = () => planOf([own('T01', 't01-a'), own('T02', 't02-b', ['T01']), own('T03', 't03-c')]);
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
// Stage defaults come from models.json (scripts/models.mjs writes STAGE_DEFAULTS), so the tests read them instead of repeating them.
const DEF = (phase) => [STAGE_DEFAULTS[phase].model, STAGE_DEFAULTS[phase].effort];
/** Values no stage uses by default: a config that names one always changes the stage it is set for. */
const unused = (key, pool) => pool.filter((v) => !Object.values(STAGE_DEFAULTS).some((s) => s[key] === v));
const [M1, M2] = unused('model', ['sonnet', 'haiku', 'fable', 'opus']);
const [E1, E2] = unused('effort', ['low', 'max', 'medium', 'high', 'xhigh']);
const E3 = ['low', 'max', 'medium', 'high', 'xhigh'].find((v) => v !== E1 && v !== E2); // only has to differ from E1 and E2

/** 임시 저장소 하나: 게이트(BROKEN 파일이 있으면 실패), 설계 문서, 오케스트레이터 설정. */
function makeRepo({ plan = CHAIN(), scenario = {}, config = {}, fixtures, churn = false, slow = false, localOnly = false } = {}) {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'orch-'));
  const g = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'test@example.com');
  g('config', 'user.name', 'test');
  // churn: 빌드할 때마다 추적 중인 설정 파일의 값을 다시 쓰는 게이트(Unity 가 URP 설정을 고쳐 쓰는 상황)
  const rewrite = churn ? "if (fs.existsSync('settings.asset')) fs.writeFileSync('settings.asset', fs.readFileSync('settings.asset', 'utf8').replace(/prefilter: \\d/, 'prefilter: 2'));\n" : '';
  // localOnly: git 에서 제외된 파일(LOCAL_ONLY)이 있어야 통과하는 게이트. 새 작업 공간(worktree)에는 그 파일이 없다
  const local = localOnly ? "if (!fs.existsSync('LOCAL_ONLY')) process.exit(3);\n" : '';
  writeFileSync(path.join(repo, 'gate-check.js'), `const fs = require('fs');\n${rewrite}${local}process.exit(fs.existsSync('BROKEN') ? 1 : 0);\n`);
  if (localOnly) {
    writeFileSync(path.join(repo, '.gitignore'), 'LOCAL_ONLY\n');
    writeFileSync(path.join(repo, 'LOCAL_ONLY'), '');
    writeFileSync(path.join(repo, 'setup.js'), "require('fs').copyFileSync(require('path').join(process.env.ORCH_MAIN_REPO, 'LOCAL_ONLY'), 'LOCAL_ONLY');\n");
  }
  if (churn) writeFileSync(path.join(repo, 'settings.asset'), 'prefilter: 0\n');
  // slow: 커밋 훅에서는 돌지 않는 비차단 검사("blocking": false). SLOW_BROKEN 파일이 있으면 실패한다
  const commands = [{ name: 'test', run: 'node gate-check.js' }];
  if (slow) {
    commands.push({ name: 'slow', run: 'node slow-check.js', blocking: false });
    writeFileSync(path.join(repo, 'slow-check.js'), "process.exit(require('fs').existsSync('SLOW_BROKEN') ? 1 : 0);\n");
  }
  writeFileSync(path.join(repo, 'am-gate.json'), JSON.stringify({ commands }));
  mkdirSync(path.join(repo, 'docs'));
  writeFileSync(path.join(repo, 'docs', 'design.md'), '# 설계\n## 1장\n내용\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'init');
  const aux = mkdtempSync(path.join(os.tmpdir(), 'orch-aux-'));
  const files = (fixtures || [plan]).map((p, i) => {
    const f = path.join(aux, `tasks-${i}.json`);
    writeFileSync(f, typeof p === 'string' ? p : JSON.stringify(p));
    return f;
  });
  const scenarioFile = path.join(aux, 'scenario.json');
  writeFileSync(scenarioFile, JSON.stringify(fixtures ? { ...scenario, split: files } : scenario));
  mkdirSync(path.join(repo, '.orchestrator'));
  writeFileSync(path.join(repo, '.orchestrator', '.gitignore'), '*\n');
  writeFileSync(path.join(repo, '.orchestrator', 'config.json'), JSON.stringify({ claudeCommand: [process.execPath, FAKE], amPluginRoot: PLUGIN, ...config }));
  const env = { ...process.env, FAKE_SCENARIO: scenarioFile, FAKE_TASKS: files[0], FAKE_PLUGIN_ROOT: PLUGIN, AM_GATE: '' };
  const orch = (...args) => {
    const r = spawnSync(process.execPath, [ORCH, ...args, '--repo', repo], { encoding: 'utf8', env: { ...env, ...orch.env } });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  orch.env = {};
  const runDir = () => path.join(repo, '.orchestrator', 'runs', readFileSync(path.join(repo, '.orchestrator', 'current'), 'utf8').trim());
  const state = () => JSON.parse(readFileSync(path.join(runDir(), 'state.json'), 'utf8'));
  const statusOf = () => Object.fromEntries(Object.entries(state().tasks).map(([id, s]) => [id, s.status]));
  const calls = () => readFileSync(path.join(repo, '.orchestrator', 'fake-calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const setConfig = (extra) => {
    const file = path.join(repo, '.orchestrator', 'config.json');
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), ...extra }));
  };
  const start = (...args) => spawn(process.execPath, [ORCH, ...args, '--repo', repo], { env: { ...env, ...orch.env }, stdio: 'ignore' });
  return { repo, g, orch, runDir, state, statusOf, calls, setConfig, start };
}

function prepared(opts) {
  const r = makeRepo(opts);
  const d = r.orch('doctor');
  assert.equal(d.code, 0, d.out);
  const s = r.orch('split', path.join(r.repo, 'docs', 'design.md'));
  assert.equal(s.code, 0, s.out);
  return r;
}

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

// ------------------------------------------------------------------ 흐름

test('정상 흐름: 세 작업을 순서대로 계획 → 구현 → 점검 → 커밋', () => {
  const r = prepared();
  assert.ok(existsSync(path.join(r.runDir(), 'tasks.md')) && existsSync(path.join(r.runDir(), 'design.md')));
  const dry = r.orch('run', '--dry-run');
  assert.match(dry.out, new RegExp(`T01[\\s\\S]*T02[\\s\\S]*T03[\\s\\S]*${IMPL} t01-a[\\s\\S]*/am:check t01-a[\\s\\S]*/am:commit task T01 t01-a`));
  const run = r.orch('run');
  assert.equal(run.code, 0, run.out);
  assert.deepEqual(r.statusOf(), { T01: 'done', T02: 'done', T03: 'done' });
  assert.equal(r.g('rev-parse', '--abbrev-ref', 'HEAD').trim(), `orch/${path.basename(r.runDir())}`);
  assert.deepEqual(r.g('log', '--format=%s', 'main..HEAD').trim().split('\n').reverse(), ['feat(t01-a): fake commit', 'feat(t02-b): fake commit', 'feat(t03-c): fake commit']);
  assert.equal(r.g('status', '--porcelain').trim(), '', '.am 과 .orchestrator 는 git 에 안 잡힌다');
  assert.ok(r.calls().every((c) => c.cwd === realpathSync(r.repo)), '예상 파일이 모두 겹치면(src/**) 하나씩, 이 저장소에서 돈다');
  const prompts = r.calls().map((c) => c.prompt).filter((p) => p.startsWith('/am:'));
  assert.deepEqual(prompts.slice(0, 4), ['/am:plan Plan task T01 described in .am/t01-a/brief.md (slug t01-a)', `${IMPL} t01-a`, '/am:check t01-a', '/am:commit task T01 t01-a']);
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

test('계획이 "너무 크다"고 하면 하위 작업으로 나눠 진행한다', () => {
  const r = prepared({ scenario: { plan: { 't02-b': ['TOO_BIG'] } } });
  const run = r.orch('run');
  assert.equal(run.code, 0, run.out);
  assert.deepEqual(r.statusOf(), { T01: 'done', T02: 'split', 'T02.1': 'done', 'T02.2': 'done', T03: 'done' });
  const plan = JSON.parse(readFileSync(path.join(r.runDir(), 'tasks.json'), 'utf8'));
  assert.deepEqual(plan.tasks.map((t) => t.id), ['T01', 'T02.1', 'T02.2', 'T03']);
  assert.equal(plan.splitHistory[0].id, 'T02');
});

test('재분할 깊이 한도에 닿으면 막힘으로 남긴다', () => {
  const r = prepared({ plan: planOf([task('T01', 't01-a')]), scenario: { plan: { 't01-a': ['TOO_BIG'], 't01-a-1-core': ['TOO_BIG'] } } });
  assert.equal(r.orch('run').code, 1);
  assert.equal(r.statusOf()['T01.1'], 'blocked');
  assert.match(r.state().tasks['T01.1'].reason, /깊이 한도/);
});

test('결정: 미리 뽑힌 결정과 계획 중 나온 결정 모두 답해야 풀린다', () => {
  const plan = planOf([task('T01', 't01-a'), task('T02', 't02-b', ['T01']), task('T03', 't03-c')], [{ id: 'D1', what: '첫 화면을 무엇으로 할까', whyNow: '화면 구성이 달라짐', options: [{ label: '목록', effect: '목록이 먼저' }, { label: '상세', effect: '상세가 먼저' }], recommended: '목록', undo: 'easy', blocks: ['T03'], answer: null }]);
  const r = prepared({ plan, scenario: { plan: { 't01-a': ['NEEDS_DECISION'] } } });
  assert.match(readFileSync(path.join(r.runDir(), 'tasks.md'), 'utf8'), /D1\. 첫 화면을 무엇으로 할까[\s\S]*선택지 1\. \*\*목록\*\*/);
  const run = r.orch('run');
  assert.equal(run.code, 1, run.out);
  assert.deepEqual(r.statusOf(), { T01: 'needs-decision', T02: 'pending', T03: 'pending' });
  assert.match(r.orch('status').out, /T03\s+결정 대기\(D1\)/);
  const report = readFileSync(path.join(r.runDir(), 'report.md'), 'utf8');
  assert.match(report, /decide D1/);
  assert.match(report, /answer T01/);
  assert.match(readFileSync(path.join(r.runDir(), 'T01', 'decision.md'), 'utf8'), /which screen first/);
  assert.equal(r.orch('decide', 'D1', '목록으로').code, 0);
  const a = r.orch('answer', 'T01', '목록', '화면', '먼저');
  assert.equal(a.code, 0, a.out);
  assert.match(readFileSync(path.join(r.repo, '.am', 't01-a', 'answers.md'), 'utf8'), /목록 화면 먼저/);
  assert.equal(r.statusOf().T01, 'planned');
  const again = r.orch('run');
  assert.equal(again.code, 0, again.out);
  assert.deepEqual(r.statusOf(), { T01: 'done', T02: 'done', T03: 'done' });
  assert.match(readFileSync(path.join(r.repo, '.am', 't03-c', 'brief.md'), 'utf8'), /첫 화면을 무엇으로 할까 → 목록으로/);
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
  const systems = r.calls().filter((c) => c.prompt === `${IMPL} t02-b`).map((c) => readFileSync(path.join(r.repo, c.argv[c.argv.indexOf('--append-system-prompt-file') + 1]), 'utf8'));
  assert.ok(!/earlier attempt/.test(systems[0]) && /earlier attempt/.test(systems[1]), '두 번째 시도에는 남은 변경을 먼저 보라고 알려 준다');
});

test('split: 형식이 틀린 작업 목록은 같은 세션에 고쳐 달라고 다시 요청한다', () => {
  const bad = CHAIN();
  bad.tasks[1].size = 'L';
  const r = makeRepo({ fixtures: [bad, CHAIN()] });
  assert.equal(r.orch('doctor').code, 0);
  const s = r.orch('split', path.join(r.repo, 'docs', 'design.md'));
  assert.equal(s.code, 0, s.out);
  assert.match(s.out, /형식 오류 1개/);
  const retry = r.calls().find((c) => c.prompt.startsWith('tasks.json failed validation'));
  assert.ok(retry.argv.includes('--resume'));
  assert.match(readFileSync(path.join(r.runDir(), '_split', 'errors.txt'), 'utf8'), /"size" must be S or M/);
});

test('split: 끝내 형식을 못 맞추면 실행을 만들지 않는다', () => {
  const r = makeRepo({ fixtures: ['{ not json'] });
  assert.equal(r.orch('doctor').code, 0);
  const s = r.orch('split', path.join(r.repo, 'docs', 'design.md'));
  assert.equal(s.code, 2);
  assert.ok(!existsSync(path.join(r.repo, '.orchestrator', 'current')));
});

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
  assert.deepEqual(flags(calls.find((c) => c.prompt === `${IMPL} t01-a`)), DEF('implement'));
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

test('계획을 파일로 남기지 못하면 같은 세션에 저장을 다시 시킨다', () => {
  const r = prepared({ plan: planOf([task('T01', 't01-a')]), scenario: { plan: { 't01-a': ['NOSAVE'] } } });
  const run = r.orch('run');
  assert.equal(run.code, 0, run.out);
  const s = r.state().tasks.T01;
  assert.equal(s.status, 'done');
  const save = r.calls().find((c) => c.prompt.startsWith('The plan was not saved'));
  assert.equal(save.argv[save.argv.indexOf('--resume') + 1], s.sessions.plan);
  assert.match(s.notes.join('\n'), /plan 단계에서 권한 규칙에 걸린 명령 2건: Write: \/elsewhere\/t01-a\/plan\.md \| Bash: cat > /);
  const system = readFileSync(path.join(r.repo, r.calls().find((c) => c.prompt.startsWith('/am:plan Plan task')).argv.at(-1)), 'utf8');
  assert.match(system, /only with the Write or Edit tool[\s\S]*A refusal is never a reason to leave the plan unsaved/);
});

test('다시 시켜도 저장하지 못하면 "결정 필요"가 아니라 막힘으로 남기고, 사유와 이어 가는 방법을 적는다', () => {
  const r = prepared({ plan: planOf([task('T01', 't01-a'), task('T02', 't02-b', ['T01'])]), scenario: { plan: { 't01-a': ['NOSAVE', 'READY'] }, planSave: 'FAIL' } });
  assert.equal(r.orch('run').code, 1);
  const s = r.state().tasks.T01;
  assert.equal(s.status, 'blocked');
  assert.equal(s.blockedAt, 'plan');
  assert.match(s.reason, /파일로 저장하지 못했습니다\. 권한 규칙에 걸린 명령: Write: \/elsewhere\/t01-a\/plan\.md/);
  assert.match(readFileSync(path.join(r.runDir(), 'T01', 'plan-reply.md'), 'utf8'), /plan body that could not be saved/);
  const report = readFileSync(path.join(r.runDir(), 'report.md'), 'utf8');
  assert.match(report, /retry T01 --from plan[\s\S]*\.am\/t01-a\/plan\.md[\s\S]*retry T01 --from implement/);
  // 길 1: 사람이 계획을 직접 저장하고 구현부터 이어 간다
  writeFileSync(path.join(r.repo, '.am', 't01-a', 'plan.md'), '# 손으로 저장한 계획\n');
  assert.equal(r.orch('retry', 'T01', '--from', 'implement').code, 0);
  const again = r.orch('run');
  assert.equal(again.code, 0, again.out);
  assert.deepEqual(r.statusOf(), { T01: 'done', T02: 'done' });
  assert.equal(r.calls().filter((c) => c.prompt.startsWith('/am:plan Plan task T01')).length, 1, '계획 세션을 다시 돌리지 않는다');
});

test('계획 저장 실패 뒤 retry --from plan 은 계획을 처음부터 다시 세운다', () => {
  const r = prepared({ plan: planOf([task('T01', 't01-a')]), scenario: { plan: { 't01-a': ['NOSAVE', 'READY'] }, planSave: 'FAIL' } });
  assert.equal(r.orch('run').code, 1);
  assert.equal(r.orch('retry', 'T01', '--from', 'plan').code, 0);
  assert.equal(r.orch('run').code, 0);
  assert.equal(r.statusOf().T01, 'done');
  assert.equal(r.calls().filter((c) => c.prompt.startsWith('/am:plan Plan task T01')).length, 2);
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

test('Ctrl+C: 돌고 있던 세션도 함께 끝내고, 다시 실행하면 끊긴 단계부터 이어 간다', async () => {
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

test('requiredGateCommands: 비차단 명령이라도 이름을 적어 두면 실패를 게이트 실패로 보고 고치게 한다', () => {
  const cmds = (slowExit) => ({ status: 'pass', reason: '', commands: [{ name: 'test', blocking: true, exit: 0, timedOut: false }, { name: 'slow', blocking: false, exit: slowExit, timedOut: false }] });
  const ctx = (names) => ({ cfg: { requiredGateCommands: names } });
  assert.equal(enforceRequired(ctx([]), cmds(1)).status, 'pass', '적지 않으면 am 의 판정 그대로');
  assert.equal(enforceRequired(ctx(['slow']), cmds(0)).status, 'pass');
  const failed = enforceRequired(ctx(['slow']), cmds(1));
  assert.equal(failed.status, 'fail');
  assert.match(failed.reason, /"slow" exited with 1 \(non-blocking in am-gate\.json, required by the orchestrator\)/);
  assert.match(enforceRequired(ctx(['nope']), cmds(0)).reason, /"nope" did not run/);
  assert.equal(enforceRequired(ctx(['slow']), { status: 'fail', reason: 'x', commands: [] }).reason, 'x', '이미 실패한 결과는 건드리지 않는다');

  // 적지 않았을 때: 비차단 검사가 깨져 있어도 그대로 커밋된다
  const loose = prepared({ plan: planOf([task('T01', 't01-a')]), slow: true, scenario: { breakSlow: ['t01-a'] } });
  assert.equal(loose.orch('run').code, 0);
  assert.equal(loose.state().tasks.T01.fixRounds, 0);
  assert.ok(existsSync(path.join(loose.repo, 'SLOW_BROKEN')));

  // 적었을 때: 점검 세션이 통과라 해도 오케스트레이터의 게이트가 잡아 구현 세션이 고친다
  const strict = prepared({ plan: planOf([task('T01', 't01-a')]), slow: true, scenario: { breakSlow: ['t01-a'] }, config: { requiredGateCommands: ['slow'] } });
  const run = strict.orch('run');
  assert.equal(run.code, 0, run.out);
  const s = strict.state().tasks.T01;
  assert.equal(s.status, 'done');
  assert.equal(s.fixRounds, 1);
  assert.ok(!existsSync(path.join(strict.repo, 'SLOW_BROKEN')));
  assert.match(run.out, /판정 NOTE, 게이트 fail[\s\S]*판정 NOTE, 게이트 pass/);
});

test('requiredGateCommands 에 am-gate.json 에 없는 이름을 적으면 doctor 와 run 이 알려 준다', () => {
  const r = makeRepo({ slow: true, config: { requiredGateCommands: ['unity-editmode'] } });
  const d = r.orch('doctor');
  assert.equal(d.code, 2);
  assert.match(d.out, /requiredGateCommands 에 적은 이름이 am-gate\.json 에 없습니다: unity-editmode/);
  r.setConfig({ requiredGateCommands: ['slow'] });
  assert.equal(r.orch('doctor').code, 0);
  assert.equal(r.orch('split', path.join(r.repo, 'docs', 'design.md')).code, 0);
  r.setConfig({ requiredGateCommands: ['typo'] });
  const run = r.orch('run');
  assert.equal(run.code, 2);
  assert.match(run.out, /requiredGateCommands 에 적은 이름이 am-gate\.json 에 없습니다: typo/);
});

test('지시문: 빌드 부작용은 세션이 git restore 로 되돌리고, 점검은 직접 돌려서 확인한다', () => {
  const r = prepared({ plan: planOf([task('T01', 't01-a')]), config: { volatilePaths: ['settings.asset'] } });
  assert.equal(r.orch('run').code, 0);
  const sys = (prefix) => readFileSync(path.join(r.repo, r.calls().find((c) => c.prompt.startsWith(prefix)).argv.at(-1)), 'utf8');
  const impl = sys(`${IMPL} t01-a`);
  assert.match(impl, /Build side effects:[\s\S]*restore them before you finish with: git restore -- <paths>\. git checkout and commands that stash changes are refused/);
  assert.match(impl, /settings\.asset\. Changes that show up in them after a build are build output: restore them with git restore/);
  const check = sys('/am:check');
  assert.match(check, /Verify by running, not by reading\.[\s\S]*is not evidence that something passes/);
  assert.match(check, /must stay out of the commit\. Restore them before you finish with: git restore -- <paths>/);
});

test('am 0.1.4 이상: 구현은 am:do 로 부르고, 묻는 자리는 am:auto 와 같은 규칙으로 처리한다', { skip: IMPL !== '/am:do' }, () => {
  const r = prepared({ plan: planOf([task('T01', 't01-a')]), scenario: { autoDecide: ['t01-a'] } });
  const d = r.orch('doctor');
  assert.match(d.out, /\/am:plan, \/am:check, \/am:commit, \/am:do 사용 가능/);
  const run = r.orch('run');
  assert.equal(run.code, 0, run.out);
  assert.match(run.out, /구현 스킬 am:do/);
  const calls = r.calls();
  assert.ok(calls.some((c) => c.prompt === '/am:do t01-a'));
  assert.ok(!calls.some((c) => c.prompt === '/am:plan t01-a'), 'am:plan <slug> 는 더 이상 구현하지 않으므로 부르지 않는다');
  const sys = (prefix) => readFileSync(path.join(r.repo, calls.find((c) => c.prompt.startsWith(prefix)).argv.at(-1)), 'utf8');
  const impl = sys('/am:do t01-a');
  assert.match(impl, /with the steps of the am:do skill[\s\S]*do not use the am:check skill/);
  assert.match(impl, /record it under Decisions in plan\.md with a one-line reason and the mark \(auto-decided\)[\s\S]*Done marks that do not match the files/);
  assert.match(impl, /Stop only when a step's Check fails and you cannot fix it, when the two reviewers of a technical choice still split on it after that round \(write its decision card under Decisions in plan\.md, marked OPEN\), or when the next action would delete user data/);
  assert.match(impl, /A technical choice its two reviewers still split on is never auto-decided/);
  const plan = sys('/am:plan Plan task');
  assert.match(plan, /take your recommendation, record it under Decisions in plan\.md[\s\S]*\(자동 결정\) in a Korean plan[\s\S]*Leave a decision open only when the plan cannot avoid one of the following/);
  assert.match(sys('Split the design document'), /Do not ask about technical choices: the plan step of each task settles them/);
  const report = readFileSync(path.join(r.runDir(), 'report.md'), 'utf8');
  assert.match(report, /## 사용자 대신 정한 것 \(자동 결정\)\n\n- T01: 첫 화면은 목록으로 한다 - 지금 화면과 가장 비슷함 \(자동 결정\)/);
});

test('am 0.1.3 이하(am:do 없음): 구현은 예전처럼 am:plan <slug> 로 부른다', () => {
  // am:do 가 없는 플러그인 사본을 만든다
  const old = mkdtempSync(path.join(os.tmpdir(), 'orch-oldam-'));
  for (const name of ['plan', 'check', 'commit']) {
    mkdirSync(path.join(old, 'skills', name), { recursive: true });
    writeFileSync(path.join(old, 'skills', name, 'SKILL.md'), readFileSync(path.join(PLUGIN, 'skills', name, 'SKILL.md')));
  }
  mkdirSync(path.join(old, 'hooks'));
  writeFileSync(path.join(old, 'hooks', 'gate.mjs'), readFileSync(path.join(PLUGIN, 'hooks', 'gate.mjs')));
  mkdirSync(path.join(old, '.claude-plugin'));
  writeFileSync(path.join(old, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'am', version: '0.1.2' }));
  const r = makeRepo({ plan: planOf([task('T01', 't01-a')]), config: { amPluginRoot: old } });
  r.orch.env = { FAKE_PLUGIN_ROOT: old };
  const d = r.orch('doctor');
  assert.equal(d.code, 0, d.out);
  assert.match(d.out, /am 0\.1\.2 플러그인 폴더: .*\(am:do 없음: 구현은 예전 방식대로 am:plan <slug> 로 부릅니다\)/);
  assert.equal(r.orch('split', path.join(r.repo, 'docs', 'design.md')).code, 0);
  const run = r.orch('run');
  assert.equal(run.code, 0, run.out);
  assert.match(run.out, /구현 스킬 am:plan/);
  const call = r.calls().find((c) => c.prompt === '/am:plan t01-a');
  assert.ok(call);
  assert.match(readFileSync(path.join(r.repo, call.argv.at(-1)), 'utf8'), /by the rules at the top of that file[\s\S]*follow rules 1 to 4 and skip rule 5/);
  assert.match(readFileSync(path.join(r.runDir(), 'report.md'), 'utf8'), /## 사용자 대신 정한 것 \(자동 결정\)\n\n없음/);
});

test('스냅샷은 같은 초 안에 같은 크기로 다시 쓰인 파일도 놓치지 않는다', async () => {
  // git 은 수정 시각을 초 단위로 비교한다. 빌드가 설정 값 한 글자만 바꾸면(크기 같음) 인덱스 사본의 시각에 따라 "안 바뀜"으로 보일 수 있다.
  const r = makeRepo({ churn: true });
  const blobOf = (tree) => r.g('rev-parse', `${tree}:settings.asset`).trim();
  await new Promise((res) => setTimeout(res, 1000 - (Date.now() % 1000) + 50)); // 초가 막 바뀐 직후
  r.g('checkout', 'HEAD', '--', 'settings.asset');
  writeFileSync(path.join(r.repo, 'settings.asset'), 'prefilter: 2\n'); // 같은 초, 같은 크기
  await new Promise((res) => setTimeout(res, 1100)); // 스냅샷은 다음 초에
  const tree = snapshot(r.repo);
  assert.ok(tree);
  assert.notEqual(blobOf(tree), blobOf('HEAD'), '다시 쓰인 내용이 스냅샷에 들어 있어야 한다');
  assert.equal(r.g('diff', '--cached', '--name-only').trim(), '', '실제 인덱스는 건드리지 않는다');
});

// ------------------------------------------------------------------ 스킬이 몰기 위한 기능: status --json, 잠금, am 찾기

const statusJson = (r) => JSON.parse(r.orch('status', '--json').out);

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

test('잠금: 실행 중에는 다른 명령이 끼어들지 못하고, status 는 무엇이 돌고 있는지 알려 준다', async () => {
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
  assert.match(cwdOf(`${IMPL} t01-a`), /\/\.orchestrator\/wt\/[^/]+\/T01$/);
  assert.match(cwdOf(`${IMPL} t03-c`), /\/\.orchestrator\/wt\/[^/]+\/T03$/);
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
  const impls = r.calls().filter((c) => c.prompt === `${IMPL} t03-c`);
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
  const impls = r.calls().filter((c) => c.prompt === `${IMPL} t03-c`);
  assert.equal(impls[1].cwd, impls[0].cwd, '같은 작업 공간에서 이어 간다');
  assert.equal(r.g('worktree', 'list').trim().split('\n').length, 1);
});

test('함께 도는 동안 status 는 작업마다 단계와 작업 공간을 보여 주고, Ctrl+C 는 세션을 모두 끝낸다', async () => {
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
  const pids = ['t01-a', 't03-c'].map((slug) => Number(readFileSync(pidFile(slug), 'utf8')));
  const exited = new Promise((res) => proc.on('exit', (code) => res(code)));
  proc.kill('SIGINT');
  assert.equal(await exited, 130);
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

test('doctor 는 설정 파일이 없으면 만들고, am 플러그인을 곁에서 찾는다(같은 저장소, 같은 마켓플레이스 설치)', () => {
  const amVersion = JSON.parse(readFileSync(path.join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8')).version;
  const bare = () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), 'orch-bare-'));
    const g = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 'test@example.com');
    g('config', 'user.name', 'test');
    writeFileSync(path.join(repo, 'am-gate.json'), JSON.stringify({ commands: [{ name: 'test', run: 'node -e 0' }] }));
    g('add', '-A');
    g('commit', '-q', '-m', 'init');
    return { repo, g };
  };
  const env = { ...process.env, CLAUDE_CONFIG_DIR: mkdtempSync(path.join(os.tmpdir(), 'orch-nocache-')), AM_GATE: '' };
  const doctor = (script, repo) => {
    const d = spawnSync(process.execPath, [script, 'doctor', '--skip-probe', '--repo', repo], { encoding: 'utf8', env });
    return `${d.stdout}${d.stderr}`;
  };
  // 1) 같은 저장소: orchestrator/scripts 옆의 plugin/
  const a = bare();
  let out = doctor(ORCH, a.repo);
  assert.match(out, /설정 파일을 만들었습니다: \.orchestrator\/config\.json/);
  assert.ok(existsSync(path.join(a.repo, '.orchestrator', 'config.json')));
  const made = JSON.parse(readFileSync(path.join(a.repo, '.orchestrator', 'config.json'), 'utf8'));
  assert.deepEqual([made.model, made.effort], [{}, {}], '모델과 effort 는 비워 둔다: 적지 않은 단계는 스크립트의 단계별 기본값으로 돈다');
  assert.equal(a.g('status', '--porcelain').trim(), '', '.orchestrator 는 git 에 잡히지 않는다');
  if (!process.env.AM_PLUGIN_ROOT) assert.ok(out.includes(`am ${amVersion} 플러그인 폴더: ${path.resolve(here, '..', 'plugin')}`), out);
  // 2) 같은 마켓플레이스에서 설치된 배치: <캐시>/<마켓>/am-orchestrator/<버전>/scripts 와 <캐시>/<마켓>/am/<버전>
  const cache = mkdtempSync(path.join(os.tmpdir(), 'orch-cache-'));
  const script = path.join(cache, 'am-workflow', 'am-orchestrator', '0.1.0', 'scripts', 'orchestrator.mjs');
  mkdirSync(path.dirname(script), { recursive: true });
  writeFileSync(script, readFileSync(ORCH));
  for (const v of ['0.1.6', '0.1.10', '0.1.9']) {
    const dir = path.join(cache, 'am-workflow', 'am', v);
    for (const f of ['hooks/gate.mjs', 'skills/plan/SKILL.md', 'skills/check/SKILL.md', 'skills/commit/SKILL.md']) {
      mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      writeFileSync(path.join(dir, f), readFileSync(path.join(PLUGIN, f)));
    }
    mkdirSync(path.join(dir, '.claude-plugin'));
    writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'am', version: v }));
  }
  out = doctor(script, bare().repo);
  // 스크립트는 자기 위치를 실제 경로로 안다(macOS 의 임시 폴더는 /var → /private/var 링크)
  assert.ok(out.includes(`am 0.1.10 플러그인 폴더: ${path.join(realpathSync(cache), 'am-workflow', 'am', '0.1.10')}`), `가장 높은 버전을 고른다\n${out}`);
});

// 곁의 am(이 저장소의 plugin/)을 찾는 동작을 보므로, 다른 am 을 지정해 돌릴 때는 건너뛴다
test('doctor: 로그인이 안 돼 있으면 알려 주고, am 이 설치돼 있지 않으면 곁의 am 을 --plugin-dir 로 넘긴다', { skip: Boolean(process.env.AM_PLUGIN_ROOT) }, () => {
  const a = makeRepo();
  a.orch.env = { FAKE_NOT_LOGGED_IN: '1' };
  const d = a.orch('doctor');
  assert.equal(d.code, 2);
  assert.match(d.out, /claude -p 시험 호출이 답을 받지 못했습니다: Not logged in/);
  assert.deepEqual([statusJson(a).ready, statusJson(a).next], [false, 'doctor'], '문제가 남아 있으면 다음 할 일은 여전히 doctor');

  const b = makeRepo({ plan: planOf([task('T01', 't01-a')]), config: { amPluginRoot: '' } });
  b.orch.env = { FAKE_AM_NOT_INSTALLED: '1' };
  const d2 = b.orch('doctor');
  assert.equal(d2.code, 0, d2.out);
  assert.ok(d2.out.includes(`am 플러그인이 설치돼 있지 않아, 띄우는 세션마다 --plugin-dir 로 넘깁니다: ${path.resolve(PLUGIN)}`), d2.out);
  assert.match(d2.out, /스킬 호출 방식: slash/);
  assert.equal(b.orch('split', path.join(b.repo, 'docs', 'design.md')).code, 0);
  assert.equal(b.orch('run').code, 0);
  const sessions = b.calls().filter((c) => c.prompt.startsWith('/am:'));
  assert.ok(sessions.length >= 4 && sessions.every((c) => c.argv.includes('--plugin-dir')), '띄우는 세션마다 am 을 실어 준다');
});

// ------------------------------------------------------------------ 빌드 도구가 다시 쓰는 파일

const TWO = () => planOf([task('T01', 't01-a'), task('T02', 't02-b', ['T01'])]);
const committedFiles = (r) => r.g('log', '--name-only', '--format=', 'main..HEAD').split('\n').filter(Boolean);

test('doctor: 깨끗한 트리에서 게이트가 다시 쓴 추적 파일을 알려 주고 되돌려 둔다', () => {
  const r = makeRepo({ churn: true });
  const d = r.orch('doctor');
  assert.equal(d.code, 0, d.out);
  assert.match(d.out, /게이트가 추적 중인 파일 1개를 다시 썼습니다\(되돌려 둠\): settings\.asset[\s\S]*volatilePaths/);
  assert.equal(r.g('status', '--porcelain').trim(), '');
  r.setConfig({ volatilePaths: ['settings.asset'] });
  assert.match(r.orch('doctor').out, /게이트가 다시 쓰는 파일 1개는 volatilePaths 로 처리됩니다/);
});

test('설정 없이도: 오케스트레이터의 게이트와 커밋 훅의 빌드가 다시 쓴 파일은 되돌리고 막지 않는다', () => {
  const r = prepared({ plan: TWO(), churn: true, scenario: { commitRunsGate: true } });
  const run = r.orch('run');
  assert.equal(run.code, 0, run.out);
  assert.deepEqual(r.statusOf(), { T01: 'done', T02: 'done' });
  assert.ok(!committedFiles(r).includes('settings.asset'), '빌드가 다시 쓴 값은 커밋에 들어가지 않는다');
  assert.equal(r.g('status', '--porcelain').trim(), '');
  assert.match(run.out, /커밋 중 게이트가 다시 쓴 파일 1개를 되돌림: settings\.asset/);
  assert.ok(r.state().restored['settings.asset'] >= 2);
  assert.match(readFileSync(path.join(r.runDir(), 'T01', 'restored-1.patch'), 'utf8'), /\+prefilter: 2/);
  assert.match(readFileSync(path.join(r.runDir(), 'report.md'), 'utf8'), /빌드 도구가 다시 써서 되돌린 파일[\s\S]*settings\.asset \(\d+번\) — volatilePaths 에 없음/);
});

test('설정 없이: 세션 안의 빌드가 다시 쓴 파일은 작업의 커밋에 함께 들어가고 막지 않는다', () => {
  const r = prepared({ plan: TWO(), churn: true, scenario: { checkRunsGate: true, commitRunsGate: true } });
  const run = r.orch('run');
  assert.equal(run.code, 0, run.out);
  assert.equal(committedFiles(r).filter((f) => f === 'settings.asset').length, 1, '첫 작업의 커밋에 한 번 들어가고 그 뒤로는 바뀌지 않는다');
  assert.match(r.state().tasks.T01.notes.join('\n'), /예상 파일 밖 변경 1개: settings\.asset/);
});

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
  assert.match(sys(`${IMPL} t01-a`), /Build tools rewrite these files on every build: settings\.asset/);
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

test('점검 세션이 git add -N 을 해 둔 상태에서도 게이트·커밋 훅이 다시 쓴 파일을 가려 되돌린다', () => {
  // git stash create 는 intent-to-add 항목이 있으면 실패한다. 스냅샷이 그 방식이면 이 보호가 조용히 꺼진다.
  const scenario = { checkAddsIntent: true, commitRunsGate: true };
  const a = prepared({ plan: TWO(), churn: true, scenario });
  const run = a.orch('run');
  assert.equal(run.code, 0, run.out);
  assert.deepEqual(a.statusOf(), { T01: 'done', T02: 'done' });
  assert.ok(!committedFiles(a).includes('settings.asset'));
  assert.match(run.out, /커밋 중 게이트가 다시 쓴 파일 1개를 되돌림: settings\.asset/);
  assert.equal(a.g('status', '--porcelain').trim(), '');
  const b = prepared({ plan: TWO(), churn: true, config: { volatilePaths: ['settings.asset'] }, scenario: { ...scenario, checkRunsGate: true } });
  assert.equal(b.orch('run').code, 0);
  assert.ok(!committedFiles(b).includes('settings.asset'));
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

test('시작 조건: 게이트 설정이 없거나 작업 트리가 더러우면 시작하지 않는다', () => {
  const r = prepared();
  writeFileSync(path.join(r.repo, 'scratch.txt'), 'x');
  const dirty = r.orch('run');
  assert.equal(dirty.code, 2);
  assert.match(dirty.out, /작업 트리가 깨끗해야/);
  rmSync(path.join(r.repo, 'scratch.txt'));
  r.orch.env = { AM_GATE: 'off' };
  assert.match(r.orch('run').out, /AM_GATE=off/);
  const n = makeRepo();
  n.g('rm', '-q', 'am-gate.json');
  n.g('commit', '-q', '-m', 'no gate');
  const d = n.orch('doctor');
  assert.equal(d.code, 2);
  assert.match(d.out, /am-gate\.json 이 없습니다/);
});
