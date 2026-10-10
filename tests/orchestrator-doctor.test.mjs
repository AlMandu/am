// Run: node --test tests/orchestrator-doctor.test.mjs
// doctor, requiredGateCommands, 세션 지시문, 시작 조건 테스트. 공통 도우미·전체 명령은 tests/orchestrator-helpers.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { enforceRequired } from '../orchestrator/scripts/orchestrator.mjs';
import { here, ORCH, PLUGIN, task, planOf, tmp, makeRepo, prepared, statusJson } from './orchestrator-helpers.mjs';

// ------------------------------------------------------------------ 흐름

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
  const impl = sys(`/am:do t01-a`);
  assert.match(impl, /Build side effects:[\s\S]*restore them before you finish with: git restore -- <paths>\. git checkout and commands that stash changes are refused/);
  assert.match(impl, /settings\.asset\. Changes that show up in them after a build are build output: restore them with git restore/);
  const check = sys('/am:check');
  assert.match(check, /Verify by running, not by reading\.[\s\S]*is not evidence that something passes/);
  assert.match(check, /must stay out of the commit\. Restore them before you finish with: git restore -- <paths>/);
});

test('구현은 am:do 로 부르고, 묻는 자리는 am:auto 와 같은 규칙으로 처리한다', () => {
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

test('doctor: am 이 오래돼 필요한 스킬이 없으면 업데이트를 안내하고, am 폴더가 아니면 찾지 못했다고 한다', () => {
  // am:do 가 없는 오래된 플러그인 사본을 만든다
  const old = tmp('orch-oldam-');
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
  assert.equal(d.code, 2, d.out);
  assert.match(d.out, /am 이 오래돼 am:do 이 없습니다\. am 을 업데이트하세요 \(am 0\.1\.2: /);
  assert.doesNotMatch(d.out, /찾지 못했습니다/);
  // am 폴더가 아닌 곳
  const none = tmp('orch-noam-');
  const n = makeRepo({ plan: planOf([task('T01', 't01-a')]), config: { amPluginRoot: none } });
  n.orch.env = { FAKE_PLUGIN_ROOT: none };
  const nd = n.orch('doctor');
  assert.equal(nd.code, 2, nd.out);
  assert.match(nd.out, /am 플러그인 폴더\(hooks\/gate\.mjs, skills\/\*\/SKILL\.md\)를 찾지 못했습니다/);
  assert.doesNotMatch(nd.out, /오래돼/);
});

test('doctor: 오케스트레이터 settings.json 에 적은 minFreeMemoryMB 는 쓰이지 않는다고 경고만 하고 실패시키지 않는다', () => {
  const r = makeRepo();
  const orchFile = path.join(r.home, 'am-orchestrator', 'settings.json');
  const amFile = path.join(r.home, 'am', 'settings.json');
  const none = r.orch('doctor');
  assert.equal(none.code, 0, none.out);
  assert.doesNotMatch(none.out, /쓰이지 않습니다/);
  mkdirSync(path.dirname(orchFile), { recursive: true });
  writeFileSync(orchFile, JSON.stringify({ maxSessions: 2 }));
  const plain = r.orch('doctor');
  assert.equal(plain.code, 0, plain.out);
  assert.doesNotMatch(plain.out, /쓰이지 않습니다/);
  writeFileSync(orchFile, JSON.stringify({ maxSessions: 2, minFreeMemoryMB: 6144 }));
  const d = r.orch('doctor');
  assert.equal(d.code, 0, d.out);
  assert.ok(d.out.includes(`  ! ${orchFile} 의 minFreeMemoryMB(6144)는 쓰이지 않습니다. PC 전체 남은 메모리 기준은 ${amFile} 의 minFreeMemoryMB 에 적으세요`), d.out);
  assert.match(d.out, /준비됐습니다/);
  assert.equal(statusJson(r).ready, true);
});

// ------------------------------------------------------------------ 동시 진행

test('doctor 는 설정 파일이 없으면 만들고, am 플러그인을 곁에서 찾는다(같은 저장소, 같은 마켓플레이스 설치)', () => {
  const amVersion = JSON.parse(readFileSync(path.join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8')).version;
  const bare = () => {
    const repo = tmp('orch-bare-');
    const g = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 'test@example.com');
    g('config', 'user.name', 'test');
    writeFileSync(path.join(repo, 'am-gate.json'), JSON.stringify({ commands: [{ name: 'test', run: 'node -e 0' }] }));
    g('add', '-A');
    g('commit', '-q', '-m', 'init');
    return { repo, g };
  };
  const env = { ...process.env, CLAUDE_CONFIG_DIR: tmp('orch-nocache-'), AM_GATE: '' };
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
  const cache = tmp('orch-cache-');
  const script = path.join(cache, 'am-workflow', 'am-orchestrator', '0.1.0', 'scripts', 'orchestrator.mjs');
  mkdirSync(path.dirname(script), { recursive: true });
  writeFileSync(script, readFileSync(ORCH));
  for (const v of ['0.1.6', '0.1.10', '0.1.9']) {
    const dir = path.join(cache, 'am-workflow', 'am', v);
    for (const f of ['hooks/gate.mjs', 'skills/plan/SKILL.md', 'skills/check/SKILL.md', 'skills/commit/SKILL.md', 'skills/do/SKILL.md']) {
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
