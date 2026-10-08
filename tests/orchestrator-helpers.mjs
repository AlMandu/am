// 오케스트레이터 테스트의 공통 도우미. 테스트 파일이 아니라(이름이 .test.mjs 가 아님) 아래 테스트 파일들이 import 한다.
// Run: node --test tests/orchestrator.test.mjs tests/orchestrator-plan.test.mjs tests/orchestrator-commit.test.mjs tests/orchestrator-drive.test.mjs tests/orchestrator-doctor.test.mjs tests/orchestrator-parallel.test.mjs tests/orchestrator-volatile.test.mjs tests/orchestrator-rewrite.test.mjs tests/orchestrator-sessions.test.mjs tests/orchestrator-progress.test.mjs
// node --test 는 파일들을 동시에 돌린다. 배정 규칙: 주제별 파일(plan·commit·drive·doctor·parallel·volatile·rewrite·sessions·progress, 나머지는 orchestrator.test.mjs), 파일 하나를 혼자 돌려 약 30초 이하,
// 오래 걸리는 테스트는 서로 다른 파일에 둔다. 여기에는 둘 이상의 파일이 쓰는 것만 둔다.
// 오케스트레이터(orchestrator/scripts/orchestrator.mjs)를 실제 claude 없이 검증한다.
// 가짜 claude(tests/fake-claude.mjs)가 각 단계의 결과 파일과 커밋을 만들고, 게이트와 스킬 파일은 이 저장소의 plugin/ 것을 그대로 쓴다.
// 다른 버전의 am 으로 돌려 보려면: AM_PLUGIN_ROOT=<그 am 의 plugin 폴더>
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { STAGE_DEFAULTS } from '../orchestrator/scripts/orchestrator.mjs';

export const here = path.dirname(fileURLToPath(import.meta.url));
export const ORCH = path.join(here, '..', 'orchestrator', 'scripts', 'orchestrator.mjs');
export const FAKE = path.join(here, 'fake-claude.mjs');
export const PLUGIN = process.env.AM_PLUGIN_ROOT || path.join(here, '..', 'plugin');

export const task = (id, slug, dependsOn = [], extra = {}) => ({ id, slug, group: 'g', title: `${id} 제목`, goal: '목표', designRefs: ['1장'], files: ['src/**'], dependsOn, acceptance: ['게이트 통과'], size: 'S', risk: [], ...extra });
export const planOf = (tasks, decisions = []) => ({ version: 1, summary: '요약', decisions, tasks, coverage: [{ section: '1장', tasks: tasks.map((t) => t.id) }], uncovered: [] });
export const CHAIN = () => planOf([task('T01', 't01-a'), task('T02', 't02-b', ['T01']), task('T03', 't03-c')]);
// 예상 파일이 저마다 다른 작업(가짜 claude 는 src/<slug>.txt 를 만든다): 서로 무관하면 함께 돌 수 있다
export const own = (id, slug, dependsOn = []) => task(id, slug, dependsOn, { files: [`src/${slug}.txt`] });
export const PAR = () => planOf([own('T01', 't01-a'), own('T02', 't02-b', ['T01']), own('T03', 't03-c')]);
export const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
// Stage defaults come from models.json (scripts/models.mjs writes STAGE_DEFAULTS), so the tests read them instead of repeating them.
export const DEF = (phase) => [STAGE_DEFAULTS[phase].model, STAGE_DEFAULTS[phase].effort];
/** Values no stage uses by default: a config that names one always changes the stage it is set for. */
const unused = (key, pool) => pool.filter((v) => !Object.values(STAGE_DEFAULTS).some((s) => s[key] === v));
export const [M1, M2] = unused('model', ['sonnet', 'haiku', 'fable', 'opus']);
export const [E1, E2] = unused('effort', ['low', 'max', 'medium', 'high', 'xhigh']);
export const E3 = ['low', 'max', 'medium', 'high', 'xhigh'].find((v) => v !== E1 && v !== E2); // only has to differ from E1 and E2

const tmpDirs = [];
after(() => {
  let first;
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    } catch (err) {
      first ??= err;
    }
  }
  if (first) throw first;
});

/** A new folder under the OS temp folder, removed after the last test of this file. */
export function tmp(prefix) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/** 임시 저장소 하나: 게이트(BROKEN 파일이 있으면 실패), 설계 문서, 오케스트레이터 설정. */
export function makeRepo({ plan = CHAIN(), scenario = {}, config = {}, fixtures, churn = false, slow = false, localOnly = false } = {}) {
  const repo = tmp('orch-');
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
  const aux = tmp('orch-aux-');
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
  // 이 PC 의 동시 세션 제한과 돌고 있는 세션 기록은 Claude 설정 폴더 아래에 생긴다: 저장소마다 임시 폴더를 써 실제 홈 폴더와 다른 테스트를 건드리지 않는다
  const home = path.join(aux, 'claude-config');
  const env = { ...process.env, FAKE_SCENARIO: scenarioFile, FAKE_TASKS: files[0], FAKE_PLUGIN_ROOT: PLUGIN, AM_GATE: '', CLAUDE_CONFIG_DIR: home, FAKE_MAIN_REPO: repo };
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
  // 끝나기를 기다리지 않고 띄운다. 출력은 proc.out 에 모인다
  const start = (...args) => {
    const proc = spawn(process.execPath, [ORCH, ...args, '--repo', repo], { env: { ...env, ...orch.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    proc.out = '';
    for (const s of [proc.stdout, proc.stderr]) s.setEncoding('utf8').on('data', (d) => (proc.out += d));
    return proc;
  };
  const records = () => {
    const dir = path.join(home, 'am-orchestrator', 'sessions');
    return existsSync(dir) ? readdirSync(dir) : [];
  };
  return { repo, g, orch, runDir, state, statusOf, calls, setConfig, start, home, records };
}

export function prepared(opts) {
  const r = makeRepo(opts);
  const d = r.orch('doctor');
  assert.equal(d.code, 0, d.out);
  const s = r.orch('split', path.join(r.repo, 'docs', 'design.md'));
  assert.equal(s.code, 0, s.out);
  return r;
}

export const statusJson = (r) => JSON.parse(r.orch('status', '--json').out);

export const TWO = () => planOf([task('T01', 't01-a'), task('T02', 't02-b', ['T01'])]);
export const committedFiles = (r) => r.g('log', '--name-only', '--format=', 'main..HEAD').split('\n').filter(Boolean);
