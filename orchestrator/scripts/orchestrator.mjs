#!/usr/bin/env node
// am-orchestrator
// 큰 설계 문서를 작은 작업으로 쪼개고, 작업마다 am 플러그인의 plan → 구현 → check → commit 흐름을
// `claude -p` 로 돌린다. 서로 무관한 작업은 별도 작업 공간(git worktree)에서 동시에. 의존성 없음, Node 18 이상.
//
// - am 플러그인(plugin/)은 배치 러너를 두지 않는 규칙이라 이 스크립트는 같은 저장소의 별도 플러그인에 둔다.
// - am 의 스킬 본문과 게이트(gate.mjs)는 복사하지 않고, 설치된 플러그인의 것을 그대로 쓴다.
// - 모델에게 보내는 글은 영어(am 스킬 본문과 같은 규칙), 사람이 보는 출력은 한국어다.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const WIN = process.platform === 'win32';
const ORCH_DIR = '.orchestrator';
const AM_DIR = '.am';
const BASE_SKILLS = ['plan', 'check', 'commit', 'do']; // 오케스트레이터가 부르는 am 스킬(구현은 am:do)
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

// ------------------------------------------------------------------ 기본 설정

/** `.orchestrator/config.json` 에 적은 값이 이 기본값을 덮어쓴다(객체는 깊게 합침, 배열은 통째로 교체). */
export function defaults() {
  // Windows 의 Claude Code 는 PowerShell 도구도 쓰므로 Bash 규칙마다 짝을 만든다.
  const sh = (rules) => (WIN ? rules.flatMap((r) => (r.startsWith('Bash') ? [r, r.replace(/^Bash/, 'PowerShell')] : [r])) : rules);
  const read = ['Read', 'Glob', 'Grep'];
  const gitRead = ['Bash(git status *)', 'Bash(git diff *)', 'Bash(git log *)', 'Bash(git ls-files *)', 'Bash(git check-ignore *)', 'Bash(git rev-parse *)'];
  const noHuman = ['AskUserQuestion']; // 무인 실행: 질문 도구를 빼면 스킬이 글로 된 선택지로 대신한다
  // stash 는 변경을 숨기는 형태만 막는다. `git stash list`·`show` 는 점검 세션이 "숨겨 둔 변경이 없는지" 볼 때 쓰는데,
  // 통째로 막으면 그 명령과 한 줄로 묶인 게이트 실행까지 함께 거부된다.
  const stashWrites = ['push', 'save', 'pop', 'apply', 'drop', 'clear', 'create', 'store', 'branch'].flatMap((c) => [`Bash(git stash ${c})`, `Bash(git stash ${c} *)`]);
  const noHistory = ['Bash(git commit *)', 'Bash(git push)', 'Bash(git push *)', 'Bash(git reset *)', 'Bash(git checkout *)', 'Bash(git switch *)', 'Bash(git stash)', 'Bash(git stash -*)', ...stashWrites];
  const work = { mode: 'acceptEdits', allow: sh([...read, 'Edit', 'Bash']), deny: sh([...noHuman, ...noHistory]) };
  return {
    claudeCommand: ['claude'], // 실행 파일과 앞에 붙일 인자
    amPluginRoot: '', // am 의 plugin/ 폴더. 비우면 doctor 가 기록한 값 → 이 플러그인 곁 → 플러그인 캐시 순으로 찾는다
    pluginDir: '', // 적으면 모든 호출에 --plugin-dir 로 넘긴다(플러그인을 설치하지 않고 로컬 경로로 쓸 때)
    skillMode: 'auto', // auto | slash(/am:plan 호출) | inline(SKILL.md 를 읽어 지시문으로 전달)
    branch: 'orch/{run}', // 실행용 브랜치. '' 이면 현재 브랜치에서 진행
    parallel: 3, // 동시에 진행할 작업 수. 함께 도는 작업은 저마다 별도 작업 공간(git worktree)에서 구현한다. 1 이면 하나씩
    minFreeMemoryMB: null, // 다른 세션·게이트가 돌 때 남은 메모리(MB)가 이보다 적으면 새 세션을 미룬다. null 은 기본 기준(Windows 만), 0 은 끔
    worktreeSetup: [], // 새 작업 공간 안에서 먼저 돌릴 셸 명령(예: "npm ci"). 환경 변수 ORCH_MAIN_REPO 에 원래 저장소 경로가 있다
    requireGate: true, // am-gate.json 이 없으면 실행을 시작하지 않는다
    orchestratorGate: true, // check 뒤, commit 전에 오케스트레이터가 gate.mjs 를 직접 한 번 더 돌린다
    maxFixRounds: 2, // 작업 하나에서 BLOCK → 수정 → 재점검을 몇 번까지 할지
    maxSplitDepth: 1, // plan 단계가 "너무 크다"고 할 때 다시 쪼개는 깊이
    onBlock: 'stop', // stop: 막히면 멈춤 | stash: 변경을 stash 하고 서로 무관한 다음 작업으로
    taskLimits: { maxFiles: 8, maxPlanLines: 150 },
    requiredGateCommands: [], // am-gate.json 의 명령 이름. "blocking": false 라 커밋 훅에서는 돌지 않지만 오케스트레이터의 게이트에서는 통과해야 하는 것(느린 테스트 등)
    volatilePaths: [], // 빌드 도구가 빌드할 때마다 다시 쓰는 추적 파일(경로나 glob). 게이트가 같은 내용을 다시 만들어 내면 커밋하지 않고 되돌린다
    model: {}, // { default, split, plan, implement, check, commit } → --model. fix 는 implement, answer 는 plan 의 값을 물려받는다. 적지 않은 단계는 사용자 파일, 그다음 STAGE_DEFAULTS
    effort: {}, // model 과 같은 키 → --effort
    timeoutMin: { probe: 5, split: 40, plan: 75, answer: 75, implement: 90, fix: 60, check: 45, commit: 25, gate: 30 },
    extraArgs: {}, // { all: [...], implement: [...] } 단계별로 claude 에 덧붙일 플래그
    permissions: {
      // `/경로` 는 세션을 시작한 폴더(저장소 루트) 기준, `경로` 는 그때그때의 현재 폴더 기준이다.
      // 세션이 하위 폴더로 cd 한 뒤에도 루트의 .am 에 쓸 수 있도록 루트 기준 규칙을 함께 둔다.
      split: { mode: 'dontAsk', allow: sh([...read, `Edit(/${ORCH_DIR}/**)`, `Edit(${ORCH_DIR}/**)`, ...gitRead]), deny: noHuman },
      plan: { mode: 'dontAsk', allow: sh([...read, `Edit(/${AM_DIR}/**)`, `Edit(${AM_DIR}/**)`, ...gitRead]), deny: noHuman },
      implement: work,
      check: work,
      commit: { mode: 'dontAsk', allow: sh([...read, ...gitRead, 'Bash(git add *)', 'Bash(git commit *)', 'Bash(git restore *)']), deny: sh([...noHuman, 'Bash(git push)', 'Bash(git push *)']) },
    },
  };
}

// 권한 묶음을 같이 쓰는 단계
const PROFILE = { probe: 'plan', answer: 'plan', fix: 'implement' };

// 설정에 적은 값이 없을 때 단계마다 넘기는 모델과 effort. 설정과 사용자 파일보다 뒤라서 defaults() 에 넣지 않는다.
// plan·implement·check·commit 은 그 단계가 부르는 am 스킬 머리말의 값과 같아야 한다(tests/orchestrator-skill.test.mjs).
// 모델은 별칭으로 적는다: 사용자의 Claude Code 버전과 공급자에 맞는 모델로 풀린다.
export const STAGE_DEFAULTS = {
  split: { model: 'opus', effort: 'high' },
  plan: { model: 'opus', effort: 'high' },
  implement: { model: 'opus', effort: 'medium' },
  check: { model: 'opus', effort: 'high' },
  commit: { model: 'opus', effort: 'medium' },
};

// ------------------------------------------------------------------ 작은 도구

class Halt extends Error {} // 사용자에게 사유를 보여 주고 끝내는 오류
class PhaseError extends Error {} // claude 호출이 실패함: 상태를 저장해 두고 끝낸다(다시 run 하면 이어 감)
const fail = (msg) => {
  throw new Halt(msg);
};
const say = (s = '') => process.stdout.write(`${s}\n`);
/** 작업 하나의 진행 줄. 여러 작업이 함께 돌면 줄 앞에 작업 ID 를 붙인다. */
const log = (ctx, s) => say(ctx.tag ? s.replace(/^(\s*)/, `$1[${ctx.tag}] `) : s);
const now = () => new Date().toISOString();
const slashes = (p) => p.split(path.sep).join('/');
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const readText = (file) => readFileSync(file, 'utf8').replace(/^\uFEFF/, ''); // BOM 이 있어도 읽힘
const readJson = (file) => JSON.parse(readText(file));

function writeText(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file); // 쓰다가 끊겨도 반쯤 쓴 파일이 남지 않게
}
const writeJson = (file, value) => writeText(file, `${JSON.stringify(value, null, 2)}\n`);

/** 객체는 깊게 합치고 그 밖의 값은 덮어쓴다. `_` 로 시작하는 키는 메모로 보고 버린다. */
export function merge(a, b) {
  if (!isObj(a) || !isObj(b)) return b === undefined ? a : b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (k.startsWith('_')) continue;
    out[k] = isObj(v) && isObj(a[k]) ? merge(a[k], v) : v;
  }
  return out;
}

/** 작업의 files 힌트(glob)를 정규식으로. `**`, `*`, `?` 만 지원. 글자 그대로면 그 경로나 그 아래 전부. */
export function globToRegExp(glob) {
  const g = glob.replace(/\\/g, '/').replace(/^\.\//, '');
  const esc = (c) => c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  if (!/[*?]/.test(g)) return new RegExp(`^${esc(g.replace(/\/$/, ''))}(?:/.*)?$`);
  let re = '';
  for (let i = 0; i < g.length; i += 1) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      i += 1;
      if (g[i + 1] === '/') {
        i += 1;
        re += '(?:.*/)?';
      } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += esc(c);
  }
  return new RegExp(`^${re}$`);
}

/** 답변 끝의 `ORCH_STATUS: DONE` 같은 표시 줄에서 마지막 것을 읽는다. */
export function lastMarker(text, name, values) {
  const re = new RegExp(`${name}:\\s*\\**\\s*(${values.join('|')})\\b`, 'gi');
  let found = null;
  for (const m of String(text || '').matchAll(re)) found = m[1].toUpperCase();
  return found;
}

/** check.md 의 판정 줄에서 BLOCK/NOTE 를 읽는다(답변에 표시 줄이 없을 때의 대비). */
export function verdictFromFile(text) {
  const m = /^[\s#>*\-]*(?:verdict|판정|결론)[^\n]*?\b(BLOCK|NOTE)\b/im.exec(String(text || ''));
  return m ? m[1].toUpperCase() : null;
}

/** `claude -p --output-format json` 의 출력에서 result 객체를 찾는다(객체 하나, 배열, 줄 단위 JSON 모두). */
export function parseResult(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  const pick = (v) => (Array.isArray(v) ? v.findLast((e) => e && e.type === 'result') ?? null : isObj(v) ? v : null);
  try {
    return pick(JSON.parse(text));
  } catch {
    for (const line of text.split('\n').reverse()) {
      try {
        const v = JSON.parse(line);
        if (isObj(v) && v.type === 'result') return v;
      } catch {
        /* JSON 이 아닌 줄은 건너뜀 */
      }
    }
    return null;
  }
}

// ------------------------------------------------------------------ 프로세스 실행

/** Windows 에서 PATH 의 실제 파일을 찾는다. .cmd/.bat 은 셸을 거쳐야 실행된다. */
function resolveCommand(cmd) {
  if (!WIN) return { file: cmd, shell: false };
  const exts = path.extname(cmd) ? [''] : String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const dirs = /[\\/]/.test(cmd) ? [''] : String(process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = dir ? path.join(dir, cmd + ext) : cmd + ext;
      if (existsSync(p)) return { file: p, shell: /\.(cmd|bat)$/i.test(p) };
    }
  }
  return { file: cmd, shell: false };
}

/** cmd.exe 를 거칠 때 쓰는 따옴표 처리. 우리가 만드는 인자에는 `"` 와 `%` 가 없어야 한다. */
export function winQuote(arg) {
  if (/["%]/.test(arg)) fail(`Windows 의 .cmd 실행 파일에는 " 나 % 가 든 인자를 넘길 수 없습니다: ${arg}`);
  return /^[A-Za-z0-9_\-./:=\\]+$/.test(arg) ? arg : `"${arg}"`;
}

function killTree(child) {
  if (child.pid === undefined) return;
  if (WIN) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => child.kill('SIGKILL'));
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

const activeChildren = new Set(); // 지금 돌고 있는 자식 프로세스(세션, 게이트). 중단 신호를 받으면 함께 끝낸다
let onInterrupt = null; // 중단 신호를 받았을 때 상태를 정리하는 함수(run 이 등록)

// 진행 소식: 실행 폴더의 progress.jsonl 에 한 줄씩(plugin/scripts/progress.mjs 와 같은 줄 형식). 잠금 전후 어디서든 쓰므로 모듈 상태로 둔다
let progress = null; // { file, stage, started, ended }

/** 소식 한 줄을 덧붙인다. 폴더를 만들지 않고 오류는 삼킨다: 소식 때문에 일이 멈추지 않게. */
function event(fields) {
  if (!progress) return;
  if (fields.ev === 'end') progress.ended = true;
  try {
    appendFileSync(progress.file, `${JSON.stringify({ t: now(), ...fields })}\n`);
  } catch {
    /* 버린다 */
  }
}

function startEvents(runDir, fields) {
  progress = { file: path.join(runDir, 'progress.jsonl'), stage: fields.stage, started: Date.now(), ended: false };
  event({ ev: 'start', pid: process.pid, ...fields });
}
const minsSince = () => Math.max(0, Math.floor((Date.now() - progress.started) / 60000));

/** 명령 하나를 실행하고 출력을 모은다. args 가 null 이면 cmd 를 셸 명령으로 돌린다. 절대 reject 하지 않는다. */
function exec(cmd, args, { cwd, timeoutMs, env }) {
  return new Promise((resolve) => {
    let child;
    try {
      const opts = { cwd, env, windowsHide: true, detached: !WIN, stdio: ['ignore', 'pipe', 'pipe'] };
      const target = args === null ? null : resolveCommand(cmd);
      if (!target) child = spawn(cmd, { ...opts, shell: true });
      else child = target.shell ? spawn([target.file, ...args].map(winQuote).join(' '), { ...opts, shell: true }) : spawn(target.file, args, opts);
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: '', timedOut: false, spawnError: err.message });
      return;
    }
    activeChildren.add(child);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    const finish = (r) => {
      if (settled) return;
      settled = true;
      activeChildren.delete(child);
      clearTimeout(timer);
      resolve({ stdout, stderr, timedOut, spawnError: null, ...r });
    };
    child.on('error', (err) => finish({ code: null, spawnError: err.message }));
    child.on('close', (code) => finish({ code }));
  });
}

function git(repo, args, { allowFail = false, env } = {}) {
  const r = spawnSync('git', ['-c', 'core.quotepath=off', ...args], { cwd: repo, encoding: 'utf8', windowsHide: true, env, maxBuffer: 256 * 1024 * 1024 });
  if (r.error) fail(`git 을 실행하지 못했습니다: ${r.error.message}`);
  if (r.status !== 0 && !allowFail) fail(`git ${args.join(' ')} 실패\n${(r.stderr || r.stdout || '').trim()}`);
  return { code: r.status, out: (r.stdout || '').trimEnd(), err: (r.stderr || '').trim(), signal: r.signal };
}
const head = (repo) => git(repo, ['rev-parse', 'HEAD']).out.trim();
/** base 뒤에 생긴 커밋을 오래된 것부터 "짧은해시 제목" 으로. */
const commitsSince = (dir, base) => git(dir, ['log', '--reverse', '--format=%h %s', `${base}..HEAD`]).out.split('\n').filter(Boolean);

/** 작업 트리의 변경 목록(git status). 이름 바꾸기는 새 경로만 본다. */
function statusEntries(repo) {
  const parts = git(repo, ['status', '--porcelain', '-z']).out.split('\0');
  const out = [];
  for (let i = 0; i < parts.length; i += 1) {
    if (parts[i].length < 4) continue;
    const code = parts[i].slice(0, 2);
    out.push({ code, path: parts[i].slice(3) });
    if (/[RC]/.test(code)) i += 1; // 이름 바꾸기·복사는 원래 경로가 한 칸 더 따라온다
  }
  return out;
}
const MODIFIED = /^( M|M |MM)$/; // 추적 중인 파일의 내용 변경: 되돌릴 원본이 HEAD 에 있다
const isVolatile = (ctx, p) => ctx.volatile.some((re) => re.test(p));
const sha = (buf) => createHash('sha1').update(buf).digest('hex');
// 아래 거르개는 이미 읽은 statusEntries 목록을 받을 수 있다. 그 사이에 트리를 바꾸는 일이 없을 때만 넘긴다.
/** 사람이나 작업이 만든 변경. volatilePaths 에 적힌 파일은 뺀다. */
const dirtyFiles = (ctx, entries = statusEntries(ctx.repo)) => entries.filter((e) => !isVolatile(ctx, e.path)).map((e) => `${e.code} ${e.path}`);
/** 오류 문구에 붙이는 목록 미리보기: 앞 10개를 줄마다 하나씩. */
const firstTen = (list) => list.slice(0, 10).join('\n');
/** 남은 변경 전부. volatilePaths 중 추적되지 않는 것(빌드 산출물)만 뺀다. */
const leftovers = (ctx, entries = statusEntries(ctx.repo)) => entries.filter((e) => !(e.code === '??' && isVolatile(ctx, e.path))).map((e) => `${e.code} ${e.path}`);
/** 내용이 바뀐 volatilePaths 파일. */
const volatileDirty = (ctx, entries = statusEntries(ctx.repo)) => entries.filter((e) => MODIFIED.test(e.code) && isVolatile(ctx, e.path)).map((e) => e.path);

/**
 * 지금 작업 트리(무시되는 파일 제외)를 담은 tree 객체의 id. 작업 트리와 실제 인덱스는 건드리지 않는다.
 * 임시 인덱스에 전부 올려 write-tree 한다. `git stash create` 는 점검 세션이 흔히 남기는 `git add -N` 상태에서
 * 실패하기 때문에 쓰지 않는다. 만들지 못하면 null: 호출한 쪽은 "그 사이에 누가 바꿨는지" 증명할 수 없으므로 되돌리기를 건너뛴다.
 */
export function snapshot(repo) {
  const paths = git(repo, ['rev-parse', '--git-path', 'orch-snapshot-index', '--git-path', 'index'], { allowFail: true });
  const lines = paths.out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean); // 인자 순서대로 한 줄씩
  if (paths.code !== 0 || lines.length !== 2) return null;
  const tmp = path.resolve(repo, lines[0]);
  try {
    const real = path.resolve(repo, lines[1]);
    if (existsSync(real)) {
      copyFileSync(real, tmp); // 실제 인덱스를 베껴 두면 바뀐 파일만 다시 읽는다
      // git 은 "인덱스 파일의 수정 시각 이후에 바뀐 파일"만 내용을 다시 비교한다. 사본은 지금 시각을 갖게 되므로,
      // 원본의 시각(조금 앞당겨서)으로 맞춰 두지 않으면 크기가 같은 채 방금 다시 쓰인 파일을 "안 바뀜"으로 본다.
      const at = new Date(statSync(real).mtimeMs - 2000);
      utimesSync(tmp, at, at);
    }
    const env = { ...process.env, GIT_INDEX_FILE: tmp };
    if (git(repo, ['add', '-A'], { allowFail: true, env }).code !== 0) return null;
    const tree = git(repo, ['write-tree'], { allowFail: true, env });
    return tree.code === 0 ? tree.out.trim() : null;
  } catch {
    return null;
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** 두 스냅샷 사이에 내용이 바뀌거나 지워진 파일(앞 스냅샷에 있던 것만: 되돌릴 원본이 있는 것). */
function changedSince(repo, before, after) {
  const out = git(repo, ['diff-tree', '-r', '--name-status', '-z', before, after]).out.split('\0');
  const files = [];
  for (let i = 0; i + 1 < out.length; i += 2) if (out[i] === 'M' || out[i] === 'D') files.push(out[i + 1]);
  return files;
}

/** 버리려는 변경을 patch 로 남긴다(잘못 버렸을 때 되살릴 수 있게). */
function backupPatch(ctx, dir, files) {
  const patch = git(ctx.repo, ['diff', '--binary', 'HEAD', '--', ...files]).out;
  if (!patch) return;
  mkdirSync(dir, { recursive: true });
  const n = readdirSync(dir).filter((f) => /^restored-\d+\.patch$/.test(f)).length + 1;
  writeFileSync(path.join(dir, `restored-${n}.patch`), `${patch}\n`);
}

/** 빌드 도구가 다시 쓴 파일을 HEAD 상태로 되돌린다. 버리는 변경은 dir 에 patch 로 남긴다. */
function discard(ctx, dir, files, why) {
  if (!files.length) return;
  backupPatch(ctx, dir, files);
  git(ctx.repo, ['checkout', 'HEAD', '--', ...files]);
  if (ctx.state) {
    const seen = (ctx.state.restored ||= {});
    for (const f of files) seen[f] = (seen[f] || 0) + 1;
  }
  log(ctx, `    ${why} ${files.length}개를 되돌림: ${files.slice(0, 3).join(', ')}${files.length > 3 ? ' …' : ''}`);
}

/** am 과 같은 방식: 폴더가 git 에서 제외돼 있지 않으면 그 안에 `*` 한 줄짜리 .gitignore 를 둔다. */
function ensureIgnored(repo, dir) {
  mkdirSync(path.join(repo, dir), { recursive: true });
  try {
    if (readFileSync(path.join(repo, dir, '.gitignore'), 'utf8') === '*\n') return; // 이미 둔 파일이면 git 에 묻지 않는다
  } catch {
    /* 없거나 읽지 못하면 아래에서 확인한다 */
  }
  if (git(repo, ['check-ignore', '-q', dir], { allowFail: true }).code !== 0) writeFileSync(path.join(repo, dir, '.gitignore'), '*\n');
}

// ------------------------------------------------------------------ 설정과 실행 문맥

// PC 단위 사용자 모델 설정 파일 읽기. am 의 plugin/scripts/user-models.mjs 와 경로·검사·오류 문구가 같은 사본이다(플러그인끼리 import 하지 않음).
export const USER_MODEL_KEYS = ['default', 'plan', 'do', 'check', 'compactmem', 'commit', 'compact', 'run', 'split', 'second-opinion', 'codex-opinion'];
export const USER_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
// 2차 의견 서브에이전트가 받는 별칭, 그리고 cmd /C 와 TOML -c 를 거치는 Codex 모델 이름·노력 수준.
export const OPINION_MODELS = ['opus', 'sonnet', 'haiku', 'fable'];
export const CODEX_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'];
export const CODEX_MODEL = /^[A-Za-z][A-Za-z0-9._:-]*$/;

/** 이 환경의 사용자 모델 설정 파일 경로. */
export const userModelsFile = (env) => path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'am', 'models.json');

/** 메모(`_` 키)를 뺀 { model, effort }. 파일이 없으면 빈 값, 첫 문제에서 { error } (없는 파일 말고는 읽기 오류도 문제). */
export function readUserModels(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { model: {}, effort: {} };
    return { error: `${file}: cannot read the file (${oneLine(err && err.message)})` };
  }
  let data;
  try {
    data = JSON.parse(text.replace(/^﻿/, ''));
  } catch (err) {
    return { error: `${file}: not valid JSON (${oneLine(err && err.message)})` };
  }
  const problem = (what) => ({ error: `${file}: ${what}` });
  const isNote = (k) => k.startsWith('_');
  if (!isObj(data)) return problem('the top level must be a JSON object');
  for (const k of Object.keys(data)) if (k !== 'model' && k !== 'effort' && !isNote(k)) return problem(`unknown key "${k}" (use "model" or "effort")`);
  const result = {};
  for (const part of ['model', 'effort']) {
    const section = data[part] === undefined ? {} : data[part];
    if (!isObj(section)) return problem(`"${part}" must be a JSON object of stage keys`);
    result[part] = {};
    for (const [k, v] of Object.entries(section)) {
      if (isNote(k)) continue;
      if (!USER_MODEL_KEYS.includes(k)) return problem(`unknown key "${part}.${k}" (${k === 'implement' ? 'use "do"' : `use one of ${USER_MODEL_KEYS.join(', ')}`})`);
      if (part === 'model' && (typeof v !== 'string' || !v.trim())) return problem(`model.${k} must be a non-empty string (got ${JSON.stringify(v)})`);
      if (part === 'model' && k === 'second-opinion' && !OPINION_MODELS.includes(v)) return problem(`model.${k} must be one of ${OPINION_MODELS.join(', ')} (got ${JSON.stringify(v)})`);
      if (part === 'model' && k === 'codex-opinion' && !CODEX_MODEL.test(v)) return problem(`model.${k} must start with a letter and use only letters, digits and . _ : - (got ${JSON.stringify(v)})`);
      const efforts = k === 'codex-opinion' ? CODEX_EFFORTS : USER_EFFORTS;
      if (part === 'effort' && !efforts.includes(v)) return problem(`effort.${k} must be one of ${efforts.join(', ')} (got ${JSON.stringify(v)})`);
      result[part][k] = v;
    }
  }
  return result;
}

// PC 단위 사용자 설정 파일 읽기. am 의 plugin/scripts/user-settings.mjs 와 경로·검사·오류 문구가 같은 사본이다(플러그인끼리 import 하지 않음).
export const userSettingsFile = (env) => path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'am', 'settings.json');

/** 메모(`_` 키)를 뺀 { minFreeMemoryMB }. 파일이나 키가 없으면 null, 첫 문제에서 { error } (없는 파일 말고는 읽기 오류도 문제). */
export function readUserSettings(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { minFreeMemoryMB: null };
    return { error: `${file}: cannot read the file (${oneLine(err && err.message)})` };
  }
  let data;
  try {
    data = JSON.parse(text.replace(/^﻿/, ''));
  } catch (err) {
    return { error: `${file}: not valid JSON (${oneLine(err && err.message)})` };
  }
  const problem = (what) => ({ error: `${file}: ${what}` });
  const isNote = (k) => k.startsWith('_');
  if (!isObj(data)) return problem('the top level must be a JSON object');
  for (const k of Object.keys(data)) if (k !== 'minFreeMemoryMB' && !isNote(k)) return problem(`unknown key "${k}" (use "minFreeMemoryMB")`);
  const v = data.minFreeMemoryMB;
  if (v === undefined || v === null) return { minFreeMemoryMB: null };
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return { minFreeMemoryMB: v };
  return problem(`minFreeMemoryMB must be null or a finite number of 0 or more (got ${JSON.stringify(v)})`);
}

function loadConfig(repo) {
  const file = path.join(repo, ORCH_DIR, 'config.json');
  const cfg = existsSync(file) ? merge(defaults(), readJson(file)) : defaults();
  // 문자열 하나로 적으면 단계 키를 찾지 못해 모든 단계가 조용히 기본값으로 돈다. 세션을 띄우기 전에 알린다.
  for (const key of ['model', 'effort']) if (!isObj(cfg[key])) fail(`config.json 의 "${key}" 값은 단계별 값을 담은 객체여야 합니다. 예: "${key}": { "default": "${key === 'model' ? 'sonnet' : 'medium'}" }`);
  const user = readUserModels(userModelsFile(process.env));
  if (user.error) fail(`사용자 모델 설정 파일이 잘못돼 세션을 띄우지 않고 멈춥니다: ${user.error}\n파일을 고치거나 지우고(지우면 기본값으로 돕니다) 다시 실행하세요.`);
  cfg.userModels = user; // merge 뒤에 넣어 config.json 의 값과 섞이지 않는다
  const settingsFile = userSettingsFile(process.env);
  const settings = readUserSettings(settingsFile);
  if (settings.error) fail(`PC 전체 설정 파일이 잘못돼 세션을 띄우지 않고 멈춥니다: ${settings.error}\n파일을 고치거나 지우고 다시 실행하세요.`);
  cfg.memoryLimit = memoryLimitOf(cfg.minFreeMemoryMB, settings.minFreeMemoryMB, settingsFile); // merge 뒤에 넣어 config.json 의 값과 섞이지 않는다
  return cfg;
}

/** 설치된 am 플러그인을 Claude Code 플러그인 캐시에서 찾는다(위치는 추정이므로 doctor 나 설정값이 우선). */
function findPluginInCache() {
  const base = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'plugins');
  const hits = [];
  const walk = (dir, depth) => {
    if (depth > 5 || !existsSync(dir)) return;
    const manifest = path.join(dir, '.claude-plugin', 'plugin.json');
    if (existsSync(manifest) && existsSync(path.join(dir, 'hooks', 'gate.mjs'))) {
      try {
        if (isAmPlugin(dir)) hits.push({ dir, at: statSync(manifest).mtimeMs });
      } catch {
        /* 읽지 못하는 매니페스트는 건너뜀 */
      }
      return;
    }
    for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory() && e.name !== 'node_modules') walk(path.join(dir, e.name), depth + 1);
  };
  walk(base, 0);
  hits.sort((a, b) => b.at - a.at);
  return hits[0]?.dir || '';
}

const isAmPlugin = (dir) => {
  try {
    return existsSync(path.join(dir, 'hooks', 'gate.mjs')) && readJson(path.join(dir, '.claude-plugin', 'plugin.json')).name === 'am';
  } catch {
    return false;
  }
};
const versionKey = (v) => String(v).split('.').map((n) => String(parseInt(n, 10) || 0).padStart(6, '0')).join('.');

/**
 * 이 스크립트 곁에 있는 am 플러그인. 두 가지 배치를 본다.
 * - 같은 저장소(개발 중이거나 --plugin-dir 로 쓸 때): <저장소>/orchestrator/scripts → <저장소>/plugin
 * - 같은 마켓플레이스에서 설치됨: <캐시>/<마켓>/am-orchestrator/<버전>/scripts → <캐시>/<마켓>/am/<버전> (가장 높은 버전)
 */
function findSiblingAm() {
  const dev = path.resolve(SCRIPT_DIR, '..', '..', 'plugin');
  if (isAmPlugin(dev)) return dev;
  const installed = path.resolve(SCRIPT_DIR, '..', '..', '..', 'am');
  if (!existsSync(installed)) return '';
  const versions = readdirSync(installed, { withFileTypes: true })
    .filter((e) => e.isDirectory() && isAmPlugin(path.join(installed, e.name)))
    .map((e) => e.name)
    .sort((a, b) => versionKey(b).localeCompare(versionKey(a)));
  return versions.length ? path.join(installed, versions[0]) : '';
}

const hasSkill = (root, name) => Boolean(root) && existsSync(path.join(root, 'skills', name, 'SKILL.md'));
function amVersion(root) {
  try {
    return readJson(path.join(root, '.claude-plugin', 'plugin.json')).version || '?';
  } catch {
    return '?';
  }
}

/** 이 프로세스에서 git 저장소임을 이미 확인한 경로(실패한 경로는 넣지 않는다). */
const knownRepos = new Set();

function baseContext(repo) {
  const key = path.resolve(repo);
  if (!knownRepos.has(key)) {
    if (git(repo, ['rev-parse', '--show-toplevel'], { allowFail: true }).code !== 0) fail(`git 저장소가 아닙니다: ${repo}`);
    knownRepos.add(key);
  }
  const cfg = loadConfig(repo);
  const envFile = path.join(repo, ORCH_DIR, 'env.json');
  const env = existsSync(envFile) ? readJson(envFile) : null;
  // am 이 설치돼 있지 않아 doctor 가 --plugin-dir 로 넘기기로 한 경로(설정에 직접 적은 값이 우선)
  if (!cfg.pluginDir && env?.pluginDirAuto && existsSync(env.pluginDirAuto)) cfg.pluginDir = env.pluginDirAuto;
  // doctor 가 적어 둔 경로가 플러그인 업데이트로 사라졌으면 캐시에서 다시 찾는다
  const pluginRoot = cfg.amPluginRoot || (env?.pluginRoot && existsSync(env.pluginRoot) ? env.pluginRoot : '') || findSiblingAm() || findPluginInCache();
  const mode = cfg.skillMode === 'auto' ? (env ? (env.slash ? 'slash' : 'inline') : null) : cfg.skillMode;
  // repo 는 세션과 git 이 일하는 작업 트리(별도 작업 공간에서는 그 폴더), root 는 실행 상태가 있는 원래 저장소
  return { repo, root: repo, cfg, env, pluginRoot, mode, costs: {}, volatile: (cfg.volatilePaths || []).map(globToRegExp) };
}

const newTaskState = () => ({ status: 'pending', sessions: {}, attempts: {}, fixRounds: 0, notes: [], commits: [] });

function openRun(repo, opt = {}) {
  const ctx = baseContext(repo);
  const orch = path.join(repo, ORCH_DIR);
  const current = path.join(orch, 'current');
  ctx.runId = opt.run || (existsSync(current) ? readText(current).trim() : '');
  if (!ctx.runId) fail('아직 실행(run)이 없습니다. 먼저 `split <설계문서>` 를 실행하세요.');
  ctx.runDir = path.join(orch, 'runs', ctx.runId);
  ctx.planFile = path.join(ctx.runDir, 'tasks.json');
  ctx.stateFile = path.join(ctx.runDir, 'state.json');
  if (!existsSync(ctx.planFile)) fail(`작업 목록이 없습니다: ${slashes(path.relative(repo, ctx.planFile))}`);
  ctx.plan = readJson(ctx.planFile);
  ctx.state = existsSync(ctx.stateFile) ? readJson(ctx.stateFile) : { runId: ctx.runId, createdAt: now(), tasks: {}, costs: {} };
  ctx.costs = ctx.state.costs ||= {};
  // tasks.json 을 손으로 고쳐 작업이 늘었을 수 있으므로 상태를 맞춘다
  for (const t of ctx.plan.tasks || []) ctx.state.tasks[t.id] ||= newTaskState();
  return ctx;
}

/** 사람에게 보여 줄 경로: 원래 저장소 기준. */
const rel = (ctx, abs) => slashes(path.relative(ctx.root || ctx.repo, abs));
/** 세션에게 줄 경로: 세션의 작업 트리 안이면 상대 경로, 밖이면(별도 작업 공간에서 본 실행 폴더) 절대 경로. */
const sessionPath = (ctx, abs) => {
  const r = path.relative(ctx.repo, abs);
  return slashes(r.startsWith('..') || path.isAbsolute(r) ? abs : r);
};
const saveState = (ctx) => writeJson(ctx.stateFile, ctx.state);
const savePlan = (ctx) => {
  writeJson(ctx.planFile, ctx.plan);
  writeText(path.join(ctx.runDir, 'tasks.md'), renderTasks(ctx.plan));
};
const taskDir = (ctx, t) => path.join(ctx.runDir, t.id);
const amPath = (ctx, t, name) => path.join(ctx.repo, AM_DIR, t.slug, name);
const totalCost = (ctx) => Object.values(ctx.costs).reduce((s, v) => s + v, 0);

// ------------------------------------------------------------------ claude 호출

/**
 * 단계에 넘길 모델·effort 와 덧붙일 플래그. 모델과 effort 따로, 설정(단계 → 물려받는 단계 → default) → 사용자 파일(단계 키 → default) → STAGE_DEFAULTS 순.
 * 이어 가는 단계(fix, answer)는 원래 단계(implement, plan)의 값과 플래그를 물려받는다. 사용자 파일의 implement 키는 do 다.
 * 이어 가는 세션이 처음 쓰던 모델과 effort 를 그대로 쓰는지는 재 보지 못했으므로, 이어 갈 때도 처음과 같은 값을 넘긴다.
 */
function stageFlags(cfg, phase) {
  const base = PROFILE[phase];
  const builtin = STAGE_DEFAULTS[base || phase];
  const u = cfg.userModels || { model: {}, effort: {} };
  const userKey = (p) => (p === 'implement' ? 'do' : p);
  const key = userKey(base || phase);
  const model = cfg.model[phase] ?? cfg.model[base] ?? cfg.model.default ?? u.model[key] ?? u.model.default ?? builtin.model;
  const effort = cfg.effort[phase] ?? cfg.effort[base] ?? cfg.effort.default ?? u.effort[key] ?? u.effort.default ?? builtin.effort;
  return { model, effort, extra: [...(cfg.extraArgs.all || []), ...(cfg.extraArgs[phase] ?? cfg.extraArgs[base] ?? [])] };
}

/** 플래그 목록에 적힌 `--이름 값` 또는 `--이름=값` 의 값(여러 번이면 마지막). 없으면 undefined. */
function flagValue(args, name) {
  let value;
  args.forEach((a, i) => {
    if (a === name) value = args[i + 1];
    else if (a.startsWith(`${name}=`)) value = a.slice(name.length + 1);
  });
  return value;
}

/** 설정이 이 단계의 모델이나 effort 를 기본값과 다르게 정했는가(단계 키, default, 사용자 파일, extraArgs 의 --model·--effort). */
export function stageOverridden(cfg, phase) {
  const { model, effort, extra } = stageFlags(cfg, phase);
  return (flagValue(extra, '--model') ?? model) !== STAGE_DEFAULTS[phase].model || (flagValue(extra, '--effort') ?? effort) !== STAGE_DEFAULTS[phase].effort;
}

/**
 * 계획 묶음 세션이 2차 의견을 Codex 에도 물을 수 있게 여는 규칙. am 의 codex-opinion.mjs 하나만, 세션이 적을 수 있는 경로 모양마다 연다.
 * 스크립트가 플래그를 고정하고 `.am/` 안의 요약만 보내므로 `codex exec` 를 직접 열지 않는다.
 */
export function codexOpinionRules(amRoot) {
  if (!amRoot) return [];
  // Windows: Claude Code fills in its own (backslash) plugin path before the skill's `/scripts/...`, inline mode writes slashes only.
  const files = [...new Set([path.join(amRoot, 'scripts', 'codex-opinion.mjs'), `${amRoot}/scripts/codex-opinion.mjs`, `${slashes(amRoot)}/scripts/codex-opinion.mjs`])];
  const rules = files.flatMap((f) => [`Bash(node "${f}" *)`, `Bash(node ${f} *)`]);
  return WIN ? rules.flatMap((r) => [r, r.replace(/^Bash/, 'PowerShell')]) : rules;
}

export function claudeArgs(cfg, phase, { prompt, resume, systemFile, format = 'json', amRoot = '' }) {
  const profile = PROFILE[phase] || phase;
  const perm = cfg.permissions[profile];
  const args = ['-p', prompt, '--output-format', format];
  if (format === 'stream-json') args.push('--verbose');
  args.push('--permission-mode', perm.mode);
  const allow = [...(perm.allow || []), ...(profile === 'plan' ? codexOpinionRules(amRoot) : [])];
  if (allow.length) args.push('--allowedTools', allow.join(','));
  if (perm.deny?.length) args.push('--disallowedTools', perm.deny.join(','));
  // extraArgs 에 같은 플래그가 있으면 그쪽이 정한다(두 번 넘기지 않는다).
  const { model, effort, extra } = stageFlags(cfg, phase);
  if (model && flagValue(extra, '--model') === undefined) args.push('--model', model);
  if (effort && flagValue(extra, '--effort') === undefined) args.push('--effort', effort);
  if (cfg.pluginDir) args.push('--plugin-dir', cfg.pluginDir);
  if (resume) args.push('--resume', resume);
  else if (systemFile) args.push('--append-system-prompt-file', systemFile); // 이어 가는 세션은 처음의 시스템 프롬프트를 그대로 쓴다
  args.push(...extra);
  return args;
}

/** claude 를 한 번 부른다. 프롬프트·시스템 지시·원본 출력을 dir 에 번호 붙여 남긴다. */
async function runClaude(ctx, phase, { dir, prompt, system, resume }) {
  mkdirSync(dir, { recursive: true });
  const seq = String(readdirSync(dir).filter((f) => /^\d\d-.*\.out\.json$/.test(f)).length + 1).padStart(2, '0');
  const base = path.join(dir, `${seq}-${phase}`);
  let systemFile = null;
  if (system && !resume) {
    systemFile = sessionPath(ctx, `${base}.system.md`);
    writeFileSync(`${base}.system.md`, system);
  }
  const [bin, ...pre] = ctx.cfg.claudeCommand;
  // 이 PC 의 세션 자리와 남은 메모리를 확인한 뒤 띄운다. 기다린 시간은 제한 시간과 소요 분에 넣지 않는다
  const who = ctx.tag || path.basename(dir).startsWith('_') ? '' : `${path.basename(dir)} `; // 함께 도는 작업이면 log 가 작업 ID 를 붙인다
  const task = path.basename(dir).startsWith('_') ? undefined : path.basename(dir);
  const release = await takeSession({ repo: ctx.root || ctx.repo, phase, where: rel(ctx, dir) }, {
    minFreeMemoryMB: ctx.cfg.memoryLimit.setting,
    onWait: (n, max) => {
      log(ctx, `    ${who}${phase}: 이 PC 에서 오케스트레이터 세션 ${n}개가 돌고 있어 자리가 날 때까지 기다립니다 (최대 ${max}개, 바꾸려면 \`sessions <N>\`)`);
      event({ ev: 'note', stage: phase, text: `waiting for a free session slot (${n} in use, max ${max})` });
    },
    onMemoryWait: (freeMB, needMB) => {
      log(ctx, `    ${who}${phase}: PC 의 남은 메모리가 ${freeMB}MB 로 기준 ${needMB}MB 보다 적어, 다른 세션이나 게이트가 끝나거나 메모리가 생길 때까지 시작을 미룹니다 ${memorySourceText(ctx.cfg.memoryLimit)}`);
      event({ ev: 'note', stage: phase, task, text: `waiting for free memory (${freeMB} MB free, needs ${needMB} MB)` });
    },
  });
  const started = Date.now();
  let r;
  try {
    r = await exec(bin, [...pre, ...claudeArgs(ctx.cfg, phase, { prompt, resume, systemFile, amRoot: ctx.pluginRoot })], { cwd: ctx.repo, timeoutMs: ctx.cfg.timeoutMin[phase] * 60000 });
  } finally {
    release();
  }
  writeFileSync(`${base}.out.json`, r.stdout);
  if (r.stderr) writeFileSync(`${base}.err.log`, r.stderr);
  const parsed = parseResult(r.stdout);
  const mins = ((Date.now() - started) / 60000).toFixed(1);
  if (parsed?.session_id && Number.isFinite(parsed.total_cost_usd)) {
    ctx.costs[parsed.session_id] = parsed.total_cost_usd; // 이어 간 세션은 대화 전체 합계를 돌려주므로 덮어쓴다
  }
  let problem = null;
  if (r.spawnError) problem = `실행 파일을 시작하지 못했습니다 (${r.spawnError})`;
  else if (r.timedOut) problem = `${ctx.cfg.timeoutMin[phase]}분 안에 끝나지 않아 중단했습니다`;
  else if (!parsed) problem = `출력을 읽지 못했습니다 (종료 코드 ${r.code})\n${(r.stderr || r.stdout).trim().slice(-600)}`;
  else if (r.code !== 0 || parsed.is_error) problem = `claude 가 오류로 끝났습니다 (${parsed.subtype || `종료 코드 ${r.code}`})\n${String(parsed.result || r.stderr).trim().slice(-600)}`;
  if (problem) throw new PhaseError(`[${phase}] ${problem}\n로그: ${rel(ctx, base)}.*`);
  const denied = (Array.isArray(parsed.permission_denials) ? parsed.permission_denials : []).map((d) => {
    const input = (d && d.tool_input) || {};
    const what = input.command || input.file_path || '';
    return `${(d && d.tool_name) || '?'}${what ? `: ${String(what).replace(/\s+/g, ' ').slice(0, 160)}` : ''}`;
  });
  const denials = denied.length;
  log(ctx, `    ${phase}: ${mins}분${denials ? `, 권한 거부 ${denials}건` : ''}`);
  event({ ev: 'note', stage: phase, task, min: Math.floor((Date.now() - started) / 60000), text: `${phase} session ended${denials ? `, ${denials} permission denials` : ''}` });
  return { text: String(parsed.result ?? ''), sessionId: parsed.session_id || null, denials, denied };
}

/** 단계를 실행하고 답변 끝의 표시 줄을 읽는다. 표시 줄이 없으면 같은 세션에 한 번만 다시 묻는다. */
async function step(ctx, name, opts, marker, values) {
  const r = await runClaude(ctx, name, opts);
  let mark = lastMarker(r.text, marker, values);
  if (!mark && r.sessionId) {
    const ask = `Reply with exactly one line and nothing else: ${values.map((v) => `${marker}: ${v}`).join(' or ')}`;
    const again = await runClaude(ctx, name, { dir: opts.dir, prompt: ask, resume: r.sessionId });
    mark = lastMarker(again.text, marker, values);
  }
  return { ...r, mark };
}

/**
 * 이 단계의 스킬을 부르는 방식. 슬래시 호출에는 스킬 머리말의 model·effort 가 함께 실리는데, 넘긴 플래그와 어느 쪽이 쓰이는지는 알 수 없다.
 * 그래서 설정이 단계의 값을 바꿨으면 머리말을 떼고 넘기는 inline 으로 부른다. skillMode 를 slash 로 고정했으면 그대로 둔다.
 */
function callMode(ctx, phase, skill) {
  return ctx.mode === 'slash' && ctx.cfg.skillMode === 'auto' && stageOverridden(ctx.cfg, phase) && hasSkill(ctx.pluginRoot, skill) ? 'inline' : ctx.mode;
}
/** 사람에게 보여 줄 스킬 호출 방식. 설정 때문에 inline 으로 부르는 단계가 있으면 함께 적는다. */
function modeLabel(ctx) {
  const inline = ['plan', 'implement', 'check', 'commit'].filter((p) => callMode(ctx, p, p === 'implement' ? 'do' : p) !== ctx.mode);
  return inline.length ? `${ctx.mode}(${inline.join('·')} 는 설정이 모델·effort 를 바꿔 inline)` : ctx.mode;
}

/** am 스킬을 부르는 프롬프트. slash 모드는 `/am:plan ...`, inline 모드는 SKILL.md 를 채워 파일로 넘긴다. */
function skillPrompt(ctx, skill, args, dir, phase = skill) {
  if (callMode(ctx, phase, skill) === 'slash') return `/am:${skill}${args ? ` ${args}` : ''}`;
  const src = path.join(ctx.pluginRoot, 'skills', skill, 'SKILL.md');
  const body = readText(src)
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
    .split('$ARGUMENTS')
    .join(args || '')
    .split('${CLAUDE_PLUGIN_ROOT}')
    .join(slashes(ctx.pluginRoot));
  const file = path.join(dir, `skill-${skill}.md`);
  writeText(file, body);
  return `Follow the instructions in ${sessionPath(ctx, file)} exactly. They are the am:${skill} skill, invoked by the user with the arguments already filled in.`;
}

/** am 의 결정론적 게이트를 CLI 로 직접 돌린다: node gate.mjs --run --json --cwd <repo> */
async function runGate(ctx, outFile) {
  const gate = path.join(ctx.pluginRoot || '', 'hooks', 'gate.mjs');
  let report;
  if (!ctx.pluginRoot || !existsSync(gate)) report = { status: 'error', reason: `gate.mjs 를 찾지 못했습니다 (${gate})`, commands: [] };
  else {
    const r = await withGateRecord({ repo: ctx.root || ctx.repo, phase: 'gate', where: ctx.repo }, () => exec(process.execPath, [gate, '--run', '--json', '--cwd', ctx.repo], { cwd: ctx.repo, timeoutMs: ctx.cfg.timeoutMin.gate * 60000 }));
    try {
      report = JSON.parse(r.stdout);
    } catch {
      report = { status: 'error', reason: r.timedOut ? '게이트가 제한 시간 안에 끝나지 않았습니다' : `게이트 출력을 읽지 못했습니다: ${(r.stderr || r.stdout).trim().slice(-300)}`, commands: [] };
    }
  }
  report = enforceRequired(ctx, report);
  if (outFile) writeJson(outFile, report);
  return report;
}

/** am-gate.json 에 적힌 명령 이름들. 읽지 못하면 null. */
function gateCommandNames(repo) {
  try {
    return (readJson(path.join(repo, 'am-gate.json')).commands || []).map((c) => c && c.name);
  } catch {
    return null;
  }
}

/**
 * requiredGateCommands: am 의 게이트는 "blocking": false 명령이 실패해도 통과로 본다(커밋을 막지 않는 경고).
 * 무인 실행에서는 느려서 커밋 훅에 못 넣는 테스트도 통과를 확인해야 하므로, 이름을 적은 명령은 실패를 게이트 실패로 본다.
 */
export function enforceRequired(ctx, report) {
  const names = ctx.cfg.requiredGateCommands || [];
  if (!names.length || report.status !== 'pass') return report;
  const problems = [];
  for (const name of names) {
    const c = (report.commands || []).find((x) => x.name === name);
    if (!c) problems.push(`"${name}" did not run (no such command in am-gate.json)`);
    else if (c.timedOut) problems.push(`"${name}" did not finish in time`);
    else if (c.exit !== 0) problems.push(`"${name}" exited with ${c.exit}`);
  }
  if (!problems.length) return report;
  return { ...report, status: 'fail', reason: `${problems.join('; ')} (non-blocking in am-gate.json, required by the orchestrator)` };
}

/** volatilePaths 파일 가운데 아직 "빌드 산출 변화인지 작업의 변경인지" 가려내지 않은 것. */
function unsettledVolatile(ctx, s) {
  return volatileDirty(ctx).filter((f) => s.volatileKept?.[f] !== sha(readFileSync(path.join(ctx.repo, f))));
}

/**
 * 게이트를 돌리되 작업 트리에 흔적을 남기지 않는다. 겸해서 volatilePaths 파일의 변경이 빌드 도구가 만든 것인지 가려낸다.
 * 1) 바뀌어 있는 volatile 파일을 HEAD 로 되돌린 채 게이트를 돌린다. 게이트가 똑같은 내용을 다시 만들면 순수한 빌드 산출
 *    변화이므로 버리고, 다르면 작업이 고친 것으로 보고 원래 내용을 되살린다(커밋 대상).
 * 2) 게이트가 도는 동안 바뀐 추적 파일은 모두 게이트 직전 상태로 되돌린다(이때는 다른 것이 돌지 않으므로 게이트가 한 일이 확실하다).
 */
async function gateAndSettle(ctx, s, dir) {
  const { repo } = ctx;
  const files = unsettledVolatile(ctx, s);
  const saved = new Map(files.map((f) => [f, readFileSync(path.join(repo, f))]));
  if (files.length) {
    backupPatch(ctx, dir, files);
    git(repo, ['checkout', 'HEAD', '--', ...files]);
  }
  const snap = snapshot(repo); // 게이트 직전의 작업 트리
  const report = await runGate(ctx, path.join(dir, 'gate.json'));
  const reproduced = files.filter((f) => existsSync(path.join(repo, f)) && readFileSync(path.join(repo, f)).equals(saved.get(f)));
  const after = snap ? snapshot(repo) : null;
  const touched = snap && after ? changedSince(repo, snap, after) : [];
  if (touched.length && git(repo, ['restore', `--source=${snap}`, '--worktree', '--', ...touched], { allowFail: true }).code !== 0) git(repo, ['checkout', snap, '--', ...touched]); // 오래된 git 대비
  if (files.length) git(repo, ['checkout', 'HEAD', '--', ...files]); // 가려내던 파일은 일단 HEAD 로: 버릴 것은 그대로, 남길 것은 아래에서 되살린다
  for (const f of files) {
    if (reproduced.includes(f)) continue;
    writeFileSync(path.join(repo, f), saved.get(f));
    if (!s.volatileKept?.[f]) s.notes.push(`${f}: volatilePaths 파일이지만 게이트가 같은 내용을 만들지 않아 작업의 변경으로 두었습니다(커밋 대상).`);
    (s.volatileKept ||= {})[f] = sha(saved.get(f));
  }
  const seen = (ctx.state.restored ||= {});
  for (const f of new Set([...reproduced, ...touched.filter((f) => !files.includes(f))])) seen[f] = (seen[f] || 0) + 1;
  if (reproduced.length) log(ctx, `    빌드 도구가 다시 쓴 파일 ${reproduced.length}개를 되돌림: ${reproduced.slice(0, 3).join(', ')}${reproduced.length > 3 ? ' …' : ''}`);
  return report;
}

// ------------------------------------------------------------------ 모델에게 주는 지시문 (영어)

const UNATTENDED =
  'You are running inside am-orchestrator, an unattended batch run. No human is present in this session and nobody can answer a question, so never wait for input. Follow the am skill you are given; where it says to ask the user, or to stop and offer something, do what the rules below say instead.';

/** 다른 작업과 합치지 못해 구현부터 다시 하는 작업이면 세션에 알려 주는 한 줄. */
const redoNote = (ctx, t) => {
  const patch = ctx.state?.tasks[t.id]?.redoPatch;
  return patch ? `\n- An earlier attempt at this task was committed in a separate checkout, but it could not be combined with work that other tasks committed in the meantime, so it was dropped and this run starts again from the current branch. Its changes are saved in ${sessionPath(ctx, path.join(ctx.root, patch))}: read it first and reuse what still applies.` : '';
};

/** volatilePaths 가 있으면 세션에 알려 주는 한 줄. */
const volatileNote = (ctx, text) => (ctx.cfg.volatilePaths?.length ? `\n- Build tools rewrite these files on every build: ${ctx.cfg.volatilePaths.join(', ')}. ${text}` : '');

const SYSTEM = {
  split: (ctx, design, out) => `You are the task splitter of am-orchestrator, an unattended batch run. No human is present in this session; never wait for input.

Input: the design document at ${design}. Output: one JSON file at ${out}. Do not create or change any other file.
What this session can do: read anything in the repository; write only under ${ORCH_DIR}/ and only with the Write or Edit tool; run only read-only git commands (status, diff, log, ls-files, check-ignore, rev-parse). The permission rules refuse everything else, including writing files through Bash. Work from the repository root and do not cd into subdirectories.

Goal: turn the design document into the smallest set of tasks such that a fresh agent session can plan, implement, verify and commit each task on its own with the am workflow: one short plan document (at most ${ctx.cfg.taskLimits.maxPlanLines} lines), then the implementation, then the project's build/test gate, then one commit.

How to work
1. Read the whole design document. If it is too long to hold at once, first list its sections with line ranges, then read it section by section.
2. Explore the repository enough to know where each part of the design lands: existing modules, naming, test layout, the gate commands in am-gate.json, and the "Runtime check" section of CLAUDE.md or AGENTS.md if there is one. Also find the repository's commit rules: its pre-commit hooks, and any rule in CLAUDE.md, AGENTS.md or a contract document (for example a MODULE.md next to the code) saying that a code change must come with another change, such as a contract or history line, a changelog entry, a regenerated copy, or line references that have to be moved. For a wide search use a read-only exploration subagent if one is available.
3. Split. Rules for every task:
   - One outcome that can be verified: something the user can see, or a behavior that a test or a probe can show. Not a layer ("all the models") and not a list of files.
   - Small: about ${ctx.cfg.taskLimits.maxFiles} files or fewer, one sitting. Count every file the task will touch, not only the new code: the tests that have to change with it, shared tables such as string or data files, scenes or other generated assets, and contract documents. A screen or feature that needs a data format, a view and its wiring is usually three tasks, not one. If you would call it large, split it again. The only sizes allowed are S and M.
   - The repository must build and pass the gate after every single task, in order. Never leave a half-wired interface between two tasks. Prefer a thin end-to-end slice first and widen it afterwards.
   - Order by dependency: data formats and contracts, then core logic, then wiring, then screens, then polish. A task may depend only on tasks that come before it. Keep dependsOn minimal: name a task only when this one cannot build or cannot be verified without it.
   - Every acceptance item must be checkable: by the gate, by a test, by a runtime probe, or by a person in one line of "where / what to do / what they should see".
   - Do not invent requirements and do not drop any. Whatever you leave out of the tasks goes to "uncovered" with the reason.
   - Every task is committed on its own and must pass the repository's commit hooks on its own. Where the commit rules require a companion change, list the companion file in the task's "files" and state the rule in its "acceptance" (for example: "MODULE.md gets a history line; moved line references are updated in the same commit; the contract check passes").
   - Tag "risk" when the task touches any of: saved-data, network-contract, concurrency, migration, security, user-data-deletion. The plan step runs an extra review for these.
4. Decisions. Collect, for the whole document, only the questions that only the user can answer: what the user will see or feel, what is in or out of scope, and choices that are hard to undo. Do not ask about technical choices: the plan step of each task settles them. Write each decision as a card that someone who has seen neither the code nor this session can answer: what is being decided (one sentence, no code names), why it must be decided now, 2-4 options with what the user would experience and what it costs (your recommendation first), the recommendation with a one-sentence reason, and whether it is easy to change later. In "blocks" name the tasks that cannot be planned before the answer. Leave "answer" as null.
5. Coverage. For every section of the design document that holds requirements, list the tasks that cover it.

Write the task text (title, goal, acceptance, decision cards) in the language of the design document. Ids and slugs are ASCII: ids T01, T02, ...; slugs short kebab-case English that start with the lowercase id, for example t03-inventory-save.

JSON shape, exactly these keys:
{
  "version": 1,
  "summary": "what the whole design delivers, 3 lines or fewer",
  "decisions": [
    { "id": "D1", "what": "", "whyNow": "", "options": [ { "label": "", "effect": "", "cost": "" } ], "recommended": "label and one-sentence reason", "undo": "easy | hard", "blocks": ["T03"], "answer": null }
  ],
  "tasks": [
    { "id": "T01", "slug": "t01-short-name", "group": "section or feature area", "title": "", "goal": "the outcome, 1-3 lines", "designRefs": ["section heading or line range"], "files": ["path or glob this task is expected to touch"], "dependsOn": [], "acceptance": [""], "size": "S | M", "risk": [] }
  ],
  "coverage": [ { "section": "", "tasks": ["T01"] } ],
  "uncovered": [ { "section": "", "reason": "" } ]
}

Before you finish, read the file back and check: it is valid JSON; ids and slugs are unique; every dependsOn id exists and appears earlier in the list; no size other than S or M; every task has designRefs and at least one acceptance item; every id in "blocks" and in "coverage" exists.
End your final reply with exactly one line: ORCH_STATUS: DONE`,

  plan: (ctx, t) => `${UNATTENDED}

This is task ${t.id} of a larger design. Its slug is ${t.slug}; use exactly this slug. Read the brief at ${AM_DIR}/${t.slug}/brief.md first, then the sections it names in the design document.
- Plan this task only. The rest of the design is other tasks' work; mention it under Risks only if this task cannot be verified without it.
- Always write ${AM_DIR}/${t.slug}/plan.md, even when the change looks small. Skip the stop that offers to do a small change directly.
- Do not implement in this session. Do not create or change any file outside ${AM_DIR}/${t.slug}/.
- What this session can do: read anything in the repository; create or change files only under ${AM_DIR}/${t.slug}/ and only with the Write or Edit tool (the folder already exists, do not create it); run only read-only git commands (status, diff, log, ls-files, check-ignore, rev-parse) and the Codex second-opinion command of the skill's rules, with its brief saved as ${AM_DIR}/${t.slug}/opinion-<round>.md (never over brief.md). The permission rules refuse everything else, including writing files through Bash. A refusal is never a reason to leave the plan unsaved: save it with the Write tool at ${AM_DIR}/${t.slug}/plan.md.
- Work from the repository root and do not cd into subdirectories: a command that combines cd with git is refused. To look around, use the Read, Grep and Glob tools rather than shell pipelines: read hook scripts (for example .githooks/pre-commit) and tool sources with the Read tool. Running project tools (node, make and the like) is refused in this session; that Codex second-opinion command is the only exception.
- Commit rules: this task is committed on its own, the commit runs the repository's commit hooks, and the session that commits cannot edit files. Find out what the hooks and the project's rules (CLAUDE.md, AGENTS.md, contract documents such as a MODULE.md next to the code) require together with a code change, for example a contract or history line, a changelog entry, or line references that move, and make each of those a step of the plan with its own check, even when the brief's file list does not mention the file.
- Decisions: the answers under "Decisions already made" in the brief are final. For any other question about what the user sees or what is in scope, take your recommendation, record it under Decisions in plan.md with a one-line reason and the mark (auto-decided), translated into the plan's language ((자동 결정) in a Korean plan), and go on. Technical choices are settled the way the skill says (through its second opinion where it has one), with at most 1 more round after the reviewers' first answers in this session because the session has a time limit; never wait for the user on them, except a choice its two reviewers still split on after that round. Leave a decision open only when the plan cannot avoid one of the following and neither the brief nor the design document settles it: deleting user data or files that existed before this run, changing a saved-data format or migrating data, changing anything outside this repository, an action that the user's or the project's instructions say needs confirmation, or a technical choice its two reviewers still split on. For an open decision write the decision card in plan.md under Decisions, marked OPEN, and repeat the card in your final reply.
- Too big: if a faithful plan needs more than ${ctx.cfg.taskLimits.maxPlanLines} lines, or clearly more than ${ctx.cfg.taskLimits.maxFiles} files, do not write plan.md. Write ${AM_DIR}/${t.slug}/split.json instead, with 2-5 items that can each be verified on their own while the repository keeps building after each one, text in the language of the brief:
  { "reason": "", "tasks": [ { "key": "kebab-case", "title": "", "goal": "", "files": [""], "acceptance": [""], "dependsOn": ["key of an earlier item"], "size": "S | M", "risk": [] } ] }
- End your final reply with exactly one line: ORCH_STATUS: READY, ORCH_STATUS: NEEDS_DECISION or ORCH_STATUS: TOO_BIG`,

  implement: (ctx, t, again) => `${UNATTENDED}

This is task ${t.id}, slug ${t.slug}. Implement ${AM_DIR}/${t.slug}/plan.md with the steps of the am:do skill.
- The orchestrator runs the am:check skill and the am:commit skill in separate sessions after you finish. So do everything except that hand-off: run the agent runtime checks you can do here (the last step of the am:do skill), but do not use the am:check skill.
- Do not commit, push, stash, reset or switch branches.
- Stay inside this task. Do not start other parts of the design document.
- Build side effects: when a build, a test run or an editor tool that you ran rewrites tracked files that are not part of this task (for example regenerated scenes or settings whose real content did not change), restore them before you finish with: git restore -- <paths>. git checkout and commands that stash changes are refused in this session; git restore is allowed.
- Where the skill would ask the user, do this instead:
  - A question about what the user sees or what is in scope, including an open decision left in the plan and a plan that turns out wrong in that way: take your recommendation, record it under Decisions in plan.md with a one-line reason and the mark (auto-decided), translated into the plan's language ((자동 결정) in a Korean plan), and go on. Technical choices are settled the way the skill says, with at most 1 more round after the reviewers' first answers in this session because the session has a time limit. A technical choice its two reviewers still split on is never auto-decided: stop as below.
  - Done marks that do not match the files: redo a done step whose change is missing; run the Check of an unmarked step that already looks done and mark it if it passes. Log either under Change log.
- If the plan turns out to be wrong in any other way, make the smallest fix and record what changed and why under Change log in plan.md.
- Stop only when a step's Check fails and you cannot fix it, when the two reviewers of a technical choice still split on it after that round (write its decision card under Decisions in plan.md, marked OPEN), or when the next action would delete user data or files that existed before this run, change a saved-data format or migrate data, change anything outside this repository, or do something that the user's or the project's instructions say needs confirmation. Then leave the files as they are, record the reason and the open question in plan.md, and put the decision card in your final reply.${volatileNote(ctx, 'Changes that show up in them after a build are build output: restore them with git restore before you finish, unless the plan requires editing them.')}${again ? '\n- An earlier attempt at this task was interrupted or blocked. Uncommitted changes from it may be in the working tree: inspect them first and continue from there.' : ''}${redoNote(ctx, t)}
- End your final reply with exactly one line: ORCH_STATUS: DONE or ORCH_STATUS: BLOCKED`,

  check: (ctx, t) => `${UNATTENDED}

This is task ${t.id}, slug ${t.slug}. Check this task's uncommitted changes against ${AM_DIR}/${t.slug}/plan.md.
- Do not ask anything. Whatever only a person can verify goes into the human checklist in check.md and in your reply.
- Do not settle or reopen technical choices in this session. Report a choice that needs settling or proves unworkable as a BLOCK finding; the implementing session settles it.
- Verify by running, not by reading. Run the gate and the project's runtime checks and tests yourself in this session. What the implementing session recorded (logs, the Change log, an earlier check.md) is not evidence that something passes. If a check cannot be run here, say so in check.md and put it on the human checklist.
- Build side effects: tracked files that only a build or tool rewrote (for example regenerated scenes or settings whose real content did not change), whether your own runs caused it or the plan's Change log says the implementing session left them, must stay out of the commit. Restore them before you finish with: git restore -- <paths>. git checkout and commands that stash changes are refused in this session; git restore is allowed.
- Always write ${AM_DIR}/${t.slug}/check.md.
- Whatever would make the repository's commit hooks reject the commit is a confirmed defect: BLOCK. That includes a contract document or changelog that the project's rules require to change together with this code and that was not changed. If the project documents a way to run its pre-commit check without committing, run it.${volatileNote(ctx, 'Changes in them that the plan does not call for are build output: do not report them as unexpected changes; restore them with git restore before you finish.')}
- End your final reply with exactly one line: ORCH_VERDICT: BLOCK or ORCH_VERDICT: NOTE`,

  commit: (ctx, t) => `${UNATTENDED}

This is task ${t.id}, slug ${t.slug}. The orchestrator asks for this commit on the user's behalf; that counts as the user asking.
- The working tree was clean when this task started, so every uncommitted change you see at the start comes from this task. Commit all of it, with three exceptions: ${AM_DIR}/ and ignored files; anything that looks secret; and build output, meaning a tracked file that check.md or the plan's Change log names as rewritten by a build or tool and to be kept out of the commit. Do not commit build output: restore it with git restore -- <paths>, and name every file you restored in your final reply, one per line, as ORCH_RESTORED: <path>. A modified file that neither document names as build output is this task's change: commit it.
- The commit gate runs the build while you commit, and the build may rewrite tracked files. A file that becomes modified only after your first git commit is the gate's doing: leave it alone, the orchestrator restores it.
- Command shape: the permission rules of this session allow only plain "git add ...", "git commit ..." and "git restore -- ..." commands, plus read-only git commands (status, diff, log). Run each one as its own command from the repository root. No "git -C", no cd, no pipes, no "&&" or ";" chains, no output filters such as head or tail, no heredoc and no command substitution. For a message with several paragraphs use several -m flags.
- A command refused by the permission rules is a problem with the shape of the command, not with the gate: run it again in the plain form above.
- Never push. If a hook rejects the commit (the am commit gate, or a pre-commit check of this repository), do not bypass it, do not use --no-verify and do not retry another way. Copy what the hook printed into your final reply, word for word: the orchestrator hands it to the implementing session to fix.
- End your final reply with exactly one line: ORCH_STATUS: COMMITTED, ORCH_STATUS: BLOCKED or ORCH_STATUS: NOTHING`,
};

// 계획을 세웠지만 파일로 남기지 못했을 때 같은 세션에 저장만 다시 시키는 말
const planSavePrompt = (t) =>
  `The plan was not saved: ${AM_DIR}/${t.slug}/plan.md does not exist. In this session only the Write and Edit tools can create files, and only under ${AM_DIR}/${t.slug}/ (the folder already exists); Bash cannot write files here. Save the plan now with the Write tool at exactly ${AM_DIR}/${t.slug}/plan.md, or ${AM_DIR}/${t.slug}/split.json if the task is too big. Then finish any step of the skill you had to skip, such as the risk review. End with exactly one line: ORCH_STATUS: READY, ORCH_STATUS: NEEDS_DECISION or ORCH_STATUS: TOO_BIG`;

// 커밋 훅이 커밋을 거부했을 때 구현 세션에 넘기는 말
const commitRejectedPrompt = (reply) =>
  `The commit for this task did not go through. Read ${reply} for what the commit session reported: usually the output of a commit hook, either the am commit gate or a pre-commit check of this repository such as a contract or lint check. Fix exactly what it requires, for example a contract document or changelog entry that must change together with the code, or line references that moved. Log it under Change log in the plan and do not commit. End with exactly one line: ORCH_STATUS: DONE or ORCH_STATUS: BLOCKED`;

// 커밋 명령이 권한 규칙에 걸렸을 때 같은 세션에 한 번 더 시키는 말
const COMMIT_RETRY =
  'Some of your commands were refused by the permission rules, not by the commit gate. If the gate itself failed, do not retry and report it. Otherwise commit again with plain commands only: git add with the paths, then git commit with -m flags, each as its own command from the repository root, with no -C, no cd, no pipes, no chains, no heredoc and no command substitution. End with exactly one line: ORCH_STATUS: COMMITTED, ORCH_STATUS: BLOCKED or ORCH_STATUS: NOTHING';

function writeBrief(ctx, t) {
  const decided = (ctx.plan.decisions || []).filter((d) => d.answer && (d.blocks || []).includes(t.id));
  const deps = t.dependsOn.map((id) => ctx.plan.tasks.find((x) => x.id === id) || (ctx.plan.splitHistory || []).find((x) => x.id === id)).filter(Boolean);
  const others = ctx.plan.tasks.filter((x) => x.id !== t.id);
  const lines = [
    `# Task brief: ${t.id} ${t.title}`,
    '',
    '(Generated by am-orchestrator from tasks.json. Edit tasks.json, not this file.)',
    '',
    `- Slug: ${t.slug}`,
    `- Design document: ${sessionPath(ctx, path.join(ctx.runDir, 'design.md'))} (snapshot of ${ctx.plan.design})`,
    `- Sections to read: ${t.designRefs.join('; ')}`,
    `- Risk tags: ${(t.risk || []).join(', ') || 'none'}`,
    '',
    '## Goal',
    t.goal,
    '',
    '## Acceptance',
    ...t.acceptance.map((a) => `- ${a}`),
    '',
    '## Expected files (a hint, not a limit)',
    ...(t.files.length ? t.files.map((f) => `- ${f}`) : ['- (none given)']),
    '',
    '## Depends on (already committed)',
    ...(deps.length ? deps.map((d) => `- ${d.id} ${d.title}: for what was actually built read ${AM_DIR}/${d.slug}/plan.md (Summary, Change log)`) : ['- nothing']),
    '',
    '## Decisions already made',
    ...(decided.length ? decided.map((d) => `- ${d.what} → ${d.answer}`) : ['- none']),
    '',
    '## Out of scope (other tasks of the same design)',
    ...(others.length ? others.map((x) => `- ${x.id} ${x.title}`) : ['- nothing']),
    '',
  ];
  writeText(amPath(ctx, t, 'brief.md'), lines.join('\n'));
}

// ------------------------------------------------------------------ 작업 목록 검증과 재분할

const ID_RE = /^[A-Za-z][A-Za-z0-9]*(\.\d+)*$/;
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const strs = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim() !== '');

/** tasks.json 의 오류 목록. 비어 있으면 통과. */
export function validatePlan(plan) {
  const errs = [];
  if (!isObj(plan)) return ['root must be a JSON object'];
  if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) return ['"tasks" must be a non-empty array'];
  const seen = new Set();
  const slugs = new Set();
  for (const [i, t] of plan.tasks.entries()) {
    const at = `tasks[${i}]${isObj(t) && t.id ? ` (${t.id})` : ''}`;
    if (!isObj(t)) {
      errs.push(`${at}: must be an object`);
      continue;
    }
    if (typeof t.id !== 'string' || !ID_RE.test(t.id)) errs.push(`${at}: "id" must look like T01`);
    else if (seen.has(t.id)) errs.push(`${at}: duplicate id`);
    if (typeof t.slug !== 'string' || !SLUG_RE.test(t.slug) || t.slug.length > 60) errs.push(`${at}: "slug" must be kebab-case English, 60 characters or fewer`);
    else if (slugs.has(t.slug)) errs.push(`${at}: duplicate slug`);
    for (const k of ['title', 'goal']) if (typeof t[k] !== 'string' || t[k].trim() === '') errs.push(`${at}: "${k}" is required`);
    if (!strs(t.designRefs) || t.designRefs.length === 0) errs.push(`${at}: "designRefs" needs at least one entry`);
    if (!strs(t.acceptance) || t.acceptance.length === 0) errs.push(`${at}: "acceptance" needs at least one checkable item`);
    if (!strs(t.files)) errs.push(`${at}: "files" must be an array of paths or globs`);
    if (t.size !== 'S' && t.size !== 'M') errs.push(`${at}: "size" must be S or M; split anything larger`);
    if (!Array.isArray(t.dependsOn)) errs.push(`${at}: "dependsOn" must be an array`);
    else for (const d of t.dependsOn) if (!seen.has(d)) errs.push(`${at}: dependsOn "${d}" must be the id of an earlier task`);
    if (t.risk !== undefined && !Array.isArray(t.risk)) errs.push(`${at}: "risk" must be an array`);
    if (typeof t.id === 'string') seen.add(t.id);
    if (typeof t.slug === 'string') slugs.add(t.slug);
  }
  const dids = new Set();
  for (const [i, d] of (plan.decisions || []).entries()) {
    const at = `decisions[${i}]${isObj(d) && d.id ? ` (${d.id})` : ''}`;
    if (!isObj(d) || typeof d.id !== 'string' || d.id.trim() === '' || dids.has(d.id)) {
      errs.push(`${at}: needs a unique "id"`);
      continue;
    }
    dids.add(d.id);
    if (typeof d.what !== 'string' || d.what.trim() === '') errs.push(`${at}: "what" is required`);
    if (!Array.isArray(d.options) || d.options.length < 2) errs.push(`${at}: needs at least 2 options`);
    for (const b of d.blocks || []) if (!seen.has(b)) errs.push(`${at}: blocks "${b}" is not a task id`);
    if (d.answer !== null && d.answer !== undefined && typeof d.answer !== 'string') errs.push(`${at}: "answer" must be null or a string`);
  }
  if (!Array.isArray(plan.coverage) || plan.coverage.length === 0) errs.push('"coverage" must list which tasks cover each section of the design document');
  else for (const c of plan.coverage) for (const id of (isObj(c) && c.tasks) || []) if (!seen.has(id)) errs.push(`coverage "${c.section}": "${id}" is not a task id`);
  return errs;
}

/** plan 단계가 "너무 크다"고 내놓은 split.json 을 받아, 부모 작업을 하위 작업들로 바꾼다. */
export function applySplit(plan, parent, split) {
  if (!isObj(split) || !Array.isArray(split.tasks) || split.tasks.length < 2) throw new Error('split.json needs a "tasks" array with at least 2 items');
  const keys = new Map();
  const subs = split.tasks.map((s, i) => {
    if (!isObj(s) || typeof s.key !== 'string' || !SLUG_RE.test(s.key)) throw new Error(`split.json tasks[${i}]: "key" must be kebab-case`);
    const sub = {
      id: `${parent.id}.${i + 1}`,
      slug: `${parent.slug}-${i + 1}-${s.key}`.slice(0, 60).replace(/-$/, ''),
      group: parent.group,
      title: s.title,
      goal: s.goal,
      designRefs: strs(s.designRefs) && s.designRefs.length ? s.designRefs : parent.designRefs,
      files: Array.isArray(s.files) ? s.files : [],
      dependsOn: [...parent.dependsOn, ...(s.dependsOn || []).map((k) => keys.get(k) ?? `?${k}`)],
      acceptance: s.acceptance,
      size: s.size === 'S' ? 'S' : 'M',
      risk: Array.isArray(s.risk) ? s.risk : parent.risk || [],
    };
    keys.set(s.key, sub.id);
    return sub;
  });
  const ids = subs.map((s) => s.id);
  const swap = (list) => (list || []).flatMap((id) => (id === parent.id ? ids : [id]));
  const next = structuredClone(plan);
  const at = next.tasks.findIndex((t) => t.id === parent.id);
  next.tasks.splice(at, 1, ...subs);
  for (const t of next.tasks) if (!ids.includes(t.id)) t.dependsOn = swap(t.dependsOn);
  for (const d of next.decisions || []) d.blocks = swap(d.blocks);
  for (const c of next.coverage || []) c.tasks = swap(c.tasks);
  (next.splitHistory ||= []).push({ id: parent.id, slug: parent.slug, title: parent.title, reason: split.reason || '', into: ids });
  const errs = validatePlan(next);
  if (errs.length) throw new Error(errs.join('; '));
  return next;
}

// ------------------------------------------------------------------ 사람이 읽는 출력

const RUNNING_KO = { plan: '계획 중', implement: '구현 중', check: '점검 중', fix: '수정 중', commit: '커밋 중' };
/** 표에 보여 줄 상태: 세션이 돌고 있으면 그 단계를 보여 준다. */
const statusLabel = (s) => (s.running ? `진행 중(${RUNNING_KO[s.running] || s.running})` : STATUS_KO[s.status] || s.status);
const STATUS_KO = { pending: '대기', 'needs-decision': '결정 필요', planned: '계획됨', implemented: '구현됨', checked: '점검 통과', committed: '커밋됨(합치기 전)', done: '완료', blocked: '막힘', split: '재분할됨' };
const openDecisions = (plan, t) => (plan.decisions || []).filter((d) => !d.answer && (d.blocks || []).includes(t.id));

function decisionCard(d) {
  const lines = [`### ${d.id}. ${d.what}`, '', `- 지금 정해야 하는 이유: ${d.whyNow || '-'}`];
  for (const [i, o] of (d.options || []).entries()) lines.push(`- 선택지 ${i + 1}. **${o.label}**: ${o.effect || ''}${o.cost ? ` (대가: ${o.cost})` : ''}`);
  lines.push(`- 추천: ${d.recommended || '-'}`, `- 나중에 바꾸기: ${d.undo === 'hard' ? '어려움' : '쉬움'}`, `- 막고 있는 작업: ${(d.blocks || []).join(', ') || '-'}`, `- 답: ${d.answer || '(아직 없음)'}`, '');
  return lines.join('\n');
}

function renderTasks(plan) {
  const lines = [`# 작업 목록`, '', `설계 문서: ${plan.design}`, '', plan.summary || '', '', '| 순서 | ID | 크기 | 작업 | 먼저 끝나야 하는 것 | 위험 |', '|---|---|---|---|---|---|'];
  for (const [i, t] of plan.tasks.entries()) lines.push(`| ${i + 1} | ${t.id} | ${t.size} | ${t.title} | ${t.dependsOn.join(', ') || '-'} | ${(t.risk || []).join(', ') || '-'} |`);
  lines.push('', '## 사용자가 정해야 하는 것', '');
  if (!(plan.decisions || []).length) lines.push('없음', '');
  for (const d of plan.decisions || []) lines.push(decisionCard(d));
  lines.push('## 작업 상세', '');
  for (const t of plan.tasks) {
    lines.push(`### ${t.id} ${t.title}  \`${t.slug}\``, '', t.goal, '', `- 설계 문서 위치: ${t.designRefs.join('; ')}`, `- 예상 파일: ${t.files.join(', ') || '-'}`, '- 완료 조건:');
    for (const a of t.acceptance) lines.push(`  - ${a}`);
    lines.push('');
  }
  lines.push('## 설계 문서 대비', '');
  for (const c of plan.coverage || []) lines.push(`- ${c.section} → ${(c.tasks || []).join(', ')}`);
  if ((plan.uncovered || []).length) {
    lines.push('', '### 작업에 넣지 않은 부분', '');
    for (const u of plan.uncovered) lines.push(`- ${u.section}: ${u.reason}`);
  }
  for (const h of plan.splitHistory || []) lines.push('', `- 재분할: ${h.id} ${h.title} → ${h.into.join(', ')} (${h.reason})`);
  return `${lines.join('\n')}\n`;
}

/** 막힌 단계별로 사람이 이어 가는 방법. 별도 작업 공간에서 막혔으면 그 폴더를 먼저 알려 준다. */
function resumeHint(t, stage, s = {}) {
  const where = s.worktree ? `변경은 별도 작업 공간 \`${s.worktree}\` 에 있습니다(손으로 고치거나 커밋할 때는 그 폴더에서). ` : '';
  return where + stageHint(t, stage);
}

function stageHint(t, stage) {
  const again = (from) => `\`retry ${t.id} --from ${from}\` 뒤 \`run\``;
  if (stage === 'plan') return `원인을 고친 뒤 ${again('plan')} (계획을 처음부터 다시 세움). 계획을 직접 \`${AM_DIR}/${t.slug}/plan.md\` 로 저장했다면 ${again('implement')}`;
  if (stage === 'implement') return `${again('implement')} (남은 변경을 먼저 살펴보고 이어서 구현함)`;
  if (stage === 'commit') return `남은 변경이 작업의 것이면 커밋한 뒤 \`done ${t.id}\`. 빌드 도구가 빌드할 때마다 다시 쓰는 파일이면 config.json 의 \`volatilePaths\` 에 그 경로를 적고 \`done ${t.id}\` (자동으로 되돌림). 커밋 자체가 안 됐다면 ${again('commit')}`;
  return `직접 고친 뒤 ${again('check')}. 손으로 커밋까지 끝냈으면 \`done ${t.id}\``;
}

/** 글에서 re 에 맞는 줄만, 앞의 목록 기호를 떼고 돌려준다. */
function markedLines(text, re) {
  return text
    .split('\n')
    .filter((l) => re.test(l))
    .map((l) => l.replace(/^[\s\-*>]+/, '').trim());
}

const AUTO_MARK = /\((?:auto-decided|자동 결정)\)/i;
/** 계획 문서에서 "(자동 결정)" 표시가 붙은 줄: 세션이 사용자 대신 정한 화면·범위 선택. */
function autoDecided(ctx, t) {
  const file = amPath(ctx, t, 'plan.md');
  if (!existsSync(file)) return [];
  return markedLines(readText(file), AUTO_MARK);
}

// am 공통 규칙의 2차 의견 표시: "(second opinion)", "(second opinion, Codex agreed)". "(no second opinion)" 은 맞지 않는다
const SECOND_MARK = /\(second opinion/i;
/** 계획 문서에서 2차 의견으로 정한 기술 선택 줄. */
function secondOpinions(ctx, t) {
  const file = amPath(ctx, t, 'plan.md');
  if (!existsSync(file)) return [];
  return markedLines(readText(file), SECOND_MARK);
}

const OPINION_POLL_MS = 5000;
/** 세션 동안 plan.md 를 지켜 새로 생기거나 바뀐 2차 의견 줄마다 소식을 남긴다. 돌려주는 함수로 멈추고 마지막으로 한 번 더 읽는다. */
function watchOpinions(ctx, t, stage) {
  const seen = new Set(secondOpinions(ctx, t));
  const scan = (whole) => {
    try {
      const file = amPath(ctx, t, 'plan.md');
      if (!existsSync(file)) return;
      let text = readText(file);
      if (!whole && !text.endsWith('\n')) text = text.slice(0, text.lastIndexOf('\n') + 1); // 쓰는 중인 마지막 줄은 다음 읽기로
      for (const line of markedLines(text, SECOND_MARK)) {
        if (seen.has(line)) continue;
        seen.add(line);
        event({ ev: 'step', task: t.id, stage, text: `second opinion: ${line}` });
      }
    } catch {
      /* 읽기 실패(EBUSY 등)는 다음 읽기로 */
    }
  };
  const timer = setInterval(() => scan(false), OPINION_POLL_MS);
  timer.unref();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    scan(true);
  };
}

function writeReport(ctx) {
  ctx = ctx.main || ctx; // 함께 도는 작업의 문맥이어도 원래 저장소의 .am 을 읽는다
  const { plan, state } = ctx;
  const par = parallelOf(ctx);
  const st = (t) => state.tasks[t.id];
  const done = plan.tasks.filter((t) => st(t).status === 'done');
  const lines = [
    `# 실행 보고 ${ctx.runId}`,
    '',
    `- 설계 문서: ${plan.design}`,
    `- 브랜치: ${state.branch || '-'} (push 하지 않음)`,
    `- 진행: ${done.length} / ${plan.tasks.length} 완료${plan.tasks.filter((t) => st(t).running).map((t) => `, 지금 ${t.id} ${RUNNING_KO[st(t).running] || st(t).running}`).join('')}`,
    `- 동시 진행: ${par.max > 1 ? `서로 무관한 작업을 최대 ${par.max}개까지${par.sessions ? ' (이 PC 의 동시 세션 제한)' : ''}` : `하나씩${par.reason ? ` (${par.reason})` : ''}`}`,
    '',
    '## 사람이 할 일',
    '',
  ];
  const blocked = plan.tasks.filter((t) => st(t).status === 'blocked');
  const waiting = plan.tasks.filter((t) => st(t).status === 'needs-decision');
  const undecided = (plan.decisions || []).filter((d) => !d.answer);
  if (!blocked.length && !waiting.length && !undecided.length) lines.push('막힌 작업이나 기다리는 결정은 없습니다.', '');
  for (const d of undecided) lines.push(decisionCard(d), `답하기: \`decide ${d.id} "<답>"\``, '');
  for (const t of waiting) lines.push(`### ${t.id} ${t.title}: 계획 중 결정이 필요함`, '', `결정 카드: ${rel(ctx, path.join(taskDir(ctx, t), 'decision.md'))}`, `답하기: \`answer ${t.id} "<답>"\``, '');
  for (const t of blocked) {
    lines.push(`### ${t.id} ${t.title}: 막힘`, '', `- 사유: ${st(t).reason}`, `- 로그: ${rel(ctx, taskDir(ctx, t))}/`);
    if (st(t).stash) lines.push(`- 변경은 stash 에 보관: \`${st(t).stash}\``);
    lines.push(`- 이어 가기: ${resumeHint(t, st(t).blockedAt, st(t))}`, '');
  }
  const decided = plan.tasks.flatMap((t) => autoDecided(ctx, t).map((l) => `- ${t.id}: ${l}`));
  lines.push('## 사용자 대신 정한 것 (자동 결정)', '', ...(decided.length ? decided : ['없음']), '');
  const opinions = plan.tasks.flatMap((t) => secondOpinions(ctx, t).map((l) => `- ${t.id}: ${l}`));
  lines.push('## 2차 의견으로 정한 것', '', ...(opinions.length ? opinions : ['없음']), '');
  lines.push('## 실행 확인 체크리스트 (작업별 check.md)', '');
  for (const t of done) {
    const file = amPath(ctx, t, 'check.md');
    lines.push(`### ${t.id} ${t.title}`, '', existsSync(file) ? readText(file).trim() : '(check.md 없음)', '');
  }
  lines.push('## 작업별 결과', '', '| ID | 상태 | 판정 | 게이트 | 수정 횟수 | 커밋 | 작업 |', '|---|---|---|---|---|---|---|');
  for (const t of plan.tasks) {
    const s = st(t);
    lines.push(`| ${t.id} | ${statusLabel(s)} | ${s.verdict || '-'} | ${s.gate || '-'} | ${s.fixRounds || 0} | ${(s.commits || []).map((c) => c.split(' ')[0]).join(' ') || '-'} | ${t.title} |`);
  }
  const notes = plan.tasks.flatMap((t) => (st(t).notes || []).map((n) => `- ${t.id}: ${n}`));
  if (notes.length) lines.push('', '## 참고 (커밋을 막지 않은 것)', '', ...notes);
  const restored = Object.entries(state.restored || {});
  if (restored.length) {
    lines.push('', '## 빌드 도구가 다시 써서 되돌린 파일', '', '커밋에 넣지 않았습니다. 버린 변경은 작업 폴더의 `restored-N.patch` 에 남아 있습니다.', '');
    for (const [f, n] of restored) lines.push(`- ${f} (${n}번)${isVolatile(ctx, f) ? '' : ' — volatilePaths 에 없음'}`);
  }
  writeText(path.join(ctx.runDir, 'report.md'), `${lines.join('\n')}\n`);
}

// ------------------------------------------------------------------ 작업 하나의 흐름

/** 시작하거나 이어 갈 수 있는 작업: 끝나지도 막히지도 않았고, 의존 작업이 모두 완료됐고, 기다리는 결정이 없다. */
function canStart(plan, state, t) {
  const s = state.tasks[t.id].status;
  if (s === 'done' || s === 'blocked' || s === 'needs-decision' || s === 'split') return false;
  if (!t.dependsOn.every((d) => state.tasks[d]?.status === 'done')) return false;
  return !(s === 'pending' && openDecisions(plan, t).length);
}

/** 다음에 돌릴 작업: 목록 순서대로 시작할 수 있는 첫 작업. */
export function nextTask(plan, state) {
  return plan.tasks.find((t) => canStart(plan, state, t)) || null;
}

/** 작업의 예상 파일(files 힌트) 두 묶음이 같은 파일을 가리킬 수 있는지. 첫 와일드카드 앞의 글자 그대로인 부분을 접두어로 비교하고, 빈 힌트는 모두와 겹친다고 본다. */
export function mayOverlap(a, b) {
  if (!a?.length || !b?.length) return true;
  const stem = (g) => {
    const s = String(g).replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
    const i = s.search(/[*?]/);
    return i < 0 ? s.replace(/\/$/, '') : s.slice(0, i);
  };
  return a.some((x) => b.some((y) => stem(x).startsWith(stem(y)) || stem(y).startsWith(stem(x))));
}

const BUILDING = ['implement', 'check', 'fix', 'commit']; // 작업 트리를 바꾸는 단계

/**
 * 지금 시작할 작업들(목록 순서). active 는 돌고 있는 작업 ID, max 는 돌고 있는 것을 포함해 함께 돌 수 있는 수.
 * - 이 저장소의 작업 트리에서 구현 중인 작업이 있으면 그것 혼자 돈다.
 * - exclusive(이 저장소에 커밋하지 않은 변경이 있음)이거나 이 저장소에서 구현을 마친 작업이 남아 있으면, 아무것도 돌지 않을 때 하나만: 이 저장소에서 하다 만 작업이 먼저.
 * - 그 밖에는 돌고 있는 작업(계획 중 포함)과 예상 파일이 겹치지 않는 것을 max 까지.
 */
export function startable(plan, state, active, max, { exclusive = false } = {}) {
  const st = (id) => state.tasks[id];
  if (active.some((id) => !st(id).worktree && BUILDING.includes(st(id).running))) return [];
  const ready = plan.tasks.filter((t) => !active.includes(t.id) && canStart(plan, state, t));
  // 구현을 마친 채 이 저장소에 남은 작업(중단된 점검·커밋 등)은 이 저장소의 작업 트리를 쓰므로 혼자 돌아야 한다
  const inMain = ready.find((t) => !st(t.id).worktree && ['implemented', 'checked'].includes(st(t.id).status));
  if (exclusive || inMain) {
    if (active.length || !ready.length) return [];
    return [inMain || ready.find((t) => !st(t.id).worktree && st(t.id).status === 'planned') || ready[0]];
  }
  const busy = active.map((id) => plan.tasks.find((t) => t.id === id)).filter(Boolean);
  const out = [];
  for (const t of ready) {
    if (active.length + out.length >= max) break;
    if (![...busy, ...out].some((o) => mayOverlap(o.files, t.files))) out.push(t);
  }
  return out;
}

/**
 * 함께 돌릴 작업 수. 둘 이상은 doctor 가 별도 작업 공간에서 게이트를 확인했고 그 뒤 게이트 설정이 그대로일 때만.
 * stale: 확인한 적이 없거나 am-gate.json·worktreeSetup 이 바뀌어 doctor 를 다시 돌려야 함.
 * sessions: 이 PC 의 동시 세션 제한. 그보다 많이 함께 돌리지 않는다.
 */
export function parallelism(cfg, env, key, sessions = Infinity) {
  const want = Math.max(1, Math.floor(Number(cfg.parallel)) || 1);
  let r;
  if (want === 1) r = { max: 1, reason: '' };
  else {
    const probe = env?.worktree;
    if (!probe || probe.key !== key) r = { max: 1, stale: true, reason: '별도 작업 공간에서 게이트가 되는지 아직 확인하지 않았습니다(처음이거나 am-gate.json·worktreeSetup 이 바뀜). `doctor` 를 다시 실행하면 확인합니다' };
    else r = probe.ok ? { max: want, reason: '' } : { max: 1, reason: `별도 작업 공간에서 게이트가 통과하지 않습니다: ${probe.reason}` };
  }
  if (r.max <= sessions) return r;
  return { ...r, max: sessions, sessions: true, reason: sessions === 1 ? '이 PC 에서 동시에 돌릴 세션을 1개로 제한했습니다(`sessions <N>` 으로 바꿈)' : r.reason };
}

/** 작업 공간 확인 결과가 아직 맞는지 가리는 열쇠: am-gate.json 과 worktreeSetup 의 해시. */
const worktreeKey = (repo, cfg) => {
  const gate = path.join(repo, 'am-gate.json');
  return sha(`${existsSync(gate) ? readText(gate) : ''}\n${JSON.stringify(cfg.worktreeSetup || [])}`);
};
/** 이 PC 의 동시 세션 제한까지 넣은 동시 진행 수. 보여 주는 곳과 dry-run 이 쓴다(run 은 작업을 고를 때마다 제한을 다시 읽음). */
const parallelOf = (ctx) => parallelism(ctx.cfg, ctx.env, worktreeKey(ctx.root, ctx.cfg), sessionLimit());
const parLabel = (par) => (par.max > 1 ? `최대 ${par.max}개${par.sessions ? '(이 PC 의 동시 세션 제한)' : ''}` : '하나씩');

// ------------------------------------------------------------------ 별도 작업 공간 (함께 도는 작업)

const WORKTREES = path.join(ORCH_DIR, 'wt');
const gatePasses = (cfg, g) => g.status === 'pass' || (g.status === 'unconfigured' && !cfg.requireGate);

/** 세션과 git 이 일할 작업 트리만 바꾼 문맥. 계획·상태·비용은 원래 것을 함께 쓴다. */
const inWorktree = (ctx, dir) => Object.assign(Object.create(ctx), { repo: dir, isolated: true });

/**
 * 작업 공간을 지운다. 폴더가 이미 사라졌어도 git 의 등록만 지운다(사용자의 다른 worktree 를 건드리는 전역 prune 은 쓰지 않는다).
 * 파일이 잡혀 있어 못 지우면(Windows 의 백신·빌드 서버 등) 그대로 두고 false.
 */
function removeWorktree(repo, dir) {
  git(repo, ['worktree', 'remove', '--force', dir], { allowFail: true });
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    return true;
  } catch {
    return false;
  }
}

/** 원래 저장소의 지금 커밋에서 떨어져 나온(detached) git worktree 를 만들고 worktreeSetup 을 돌린다. */
async function addWorktree(ctx, dir) {
  removeWorktree(ctx.root, dir); // 지난번에 끊기며 남은 것
  mkdirSync(path.dirname(dir), { recursive: true });
  const base = head(ctx.root);
  const limit = ctx.cfg.timeoutMin.gate * 60000;
  const r = await exec('git', ['worktree', 'add', '--detach', dir, base], { cwd: ctx.root, timeoutMs: limit });
  if (r.code !== 0) return { base, problem: `git worktree add 실패: ${(r.spawnError || r.stderr || r.stdout).trim().slice(-300)}` };
  ensureIgnored(dir, AM_DIR);
  for (const command of ctx.cfg.worktreeSetup || []) {
    const s = await withGateRecord({ repo: ctx.root, phase: 'worktreeSetup', where: dir }, () => exec(command, null, { cwd: dir, timeoutMs: limit, env: { ...process.env, ORCH_MAIN_REPO: ctx.root } }));
    if (s.code !== 0) return { base, problem: `worktreeSetup 명령 "${command}" 실패 (${s.timedOut ? '시간 초과' : `종료 코드 ${s.code}`}): ${(s.spawnError || s.stderr || s.stdout).trim().slice(-300)}` };
  }
  return { base, problem: '' };
}

/** .am/<slug>/ 의 파일을 다른 작업 트리로 베낀다(.am 은 git 에서 제외돼 worktree 에 따라오지 않는다). */
function copyAm(from, to, slug) {
  const src = path.join(from, AM_DIR, slug);
  if (!existsSync(src)) return;
  const dst = path.join(to, AM_DIR, slug);
  mkdirSync(dst, { recursive: true });
  for (const e of readdirSync(src, { withFileTypes: true })) if (e.isFile()) copyFileSync(path.join(src, e.name), path.join(dst, e.name));
}

/**
 * 구현부터 쓸 작업 트리를 고른다. 이미 고른 작업 공간이 있으면 그것(이어 가는 세션은 처음 폴더에서만 열린다),
 * 다른 작업이 돌고 있으면 새 작업 공간, 혼자면 이 저장소(빌드 캐시를 그대로 쓰고, 끝날 때까지 다른 작업을 시작하지 않는다).
 */
async function chooseWorkspace(ctx, t, active) {
  const s = ctx.state.tasks[t.id];
  if (s.worktree) {
    const dir = path.join(ctx.root, s.worktree);
    if (existsSync(dir)) return inWorktree(ctx, dir);
    s.notes.push('별도 작업 공간이 사라져 구현부터 다시 했습니다.');
    Object.assign(s, { status: 'planned', worktree: undefined, wtBase: undefined, baseSha: undefined, sessions: { plan: s.sessions.plan }, commitBase: undefined, commits: [], fixRounds: 0 });
  }
  if (s.status !== 'planned') return ctx;
  if ([...active.keys()].every((id) => id === t.id)) {
    s.baseSha ||= head(ctx.root); // 합치지 못해 다시 구현하는 작업은 기준 커밋이 비어 있다
    return ctx;
  }
  const dir = path.join(ctx.root, WORKTREES, ctx.runId, t.id);
  const { base, problem } = await addWorktree(ctx, dir);
  if (problem) {
    removeWorktree(ctx.root, dir);
    throw new PhaseError(`[workspace] ${t.id} 의 별도 작업 공간을 만들지 못했습니다: ${problem}`);
  }
  copyAm(ctx.root, dir, t.slug);
  for (const id of t.dependsOn) {
    const dep = ctx.plan.tasks.find((x) => x.id === id) || (ctx.plan.splitHistory || []).find((x) => x.id === id);
    if (dep) copyAm(ctx.root, dir, dep.slug);
  }
  Object.assign(s, { worktree: slashes(path.relative(ctx.root, dir)), wtBase: base, baseSha: base });
  saveState(ctx);
  const w = inWorktree(ctx, dir);
  writeBrief(w, t); // 설계 문서 경로를 작업 공간에서 본 경로로
  log(w, `    별도 작업 공간에서 진행: ${s.worktree}`);
  return w;
}

let integrating = Promise.resolve(); // 실행 브랜치에 합치는 일은 한 번에 하나씩

/** 별도 작업 공간에서 커밋까지 마친 작업을 실행 브랜치에 합친다. 반환값: done | planned(다시 구현) | blocked */
function integrate(ctx, t) {
  const job = () => integrateNow(ctx, t);
  const p = integrating.then(job, job);
  integrating = p.catch(() => {});
  return p;
}

async function integrateNow(ctx, t) {
  const s = ctx.state.tasks[t.id];
  const { root } = ctx;
  const dir = path.join(root, s.worktree);
  const w = inWorktree(ctx, dir);
  git(dir, ['rebase', '--abort'], { allowFail: true }); // 지난번에 끊긴 rebase 가 남아 있으면 치운다
  const before = head(root);
  if (git(root, ['merge-base', '--is-ancestor', before, head(dir)], { allowFail: true }).code !== 0) {
    // 그사이 다른 작업이 실행 브랜치에 합쳐졌다: 이 작업의 커밋을 그 위로 옮기고 게이트를 다시 돌린다
    const rb = git(dir, ['rebase', '--quiet', before], { allowFail: true });
    if (rb.code !== 0) {
      const conflicted = !rb.signal && git(dir, ['diff', '--name-only', '--diff-filter=U'], { allowFail: true }).out.trim() !== '';
      git(dir, ['rebase', '--abort'], { allowFail: true });
      // 충돌이 아니면(중단 신호, 그 밖의 git 오류) 변경을 버리지 않고 멈춘다: 다시 run 하면 합치기부터 이어 간다
      if (!conflicted) throw new PhaseError(`[integrate] ${t.id} 를 실행 브랜치 위로 옮기지 못했습니다${rb.signal ? ` (${rb.signal})` : ''}: ${(rb.err || rb.out).slice(-300)}`);
      return redoTask(ctx, t, '실행 브랜치에 먼저 합쳐진 작업과 충돌했습니다');
    }
    Object.assign(s, { wtBase: before, needsGate: true });
    saveState(ctx);
  }
  if (s.needsGate && ctx.cfg.orchestratorGate) {
    log(w, '    실행 브랜치의 새 커밋 위로 옮김: 게이트를 다시 돌림');
    const g = await gateAndSettle(w, s, taskDir(ctx, t));
    event({ ev: 'note', task: t.id, stage: 'check', text: `gate ${g.status} after moving onto the run branch` });
    if (!gatePasses(ctx.cfg, g)) return redoTask(ctx, t, `실행 브랜치의 새 커밋 위로 옮긴 뒤 게이트 ${g.status}${g.reason ? ` (${g.reason})` : ''}`);
  }
  // 이 작업의 커밋은 작업 공간의 기준 커밋(옮겼으면 옮긴 위치) 뒤의 것: 합치기를 다시 해도(중단 뒤) 같은 목록이 나온다
  const commits = commitsSince(dir, s.wtBase);
  await fastForward(root, head(dir));
  copyAm(dir, root, t.slug);
  Object.assign(s, { status: 'done', commits, worktree: undefined, wtBase: undefined, needsGate: undefined, redoPatch: undefined, commitBase: undefined, reason: undefined, blockedAt: undefined, updatedAt: now() });
  saveState(ctx); // 완료를 먼저 남기고 작업 공간을 지운다: 지우다 끊겨도 다시 구현하지 않는다(남은 폴더는 실행이 끝날 때 정리)
  removeWorktree(root, dir);
  log(w, `    ✓ 실행 브랜치에 합침: ${commits.join(' / ')}`);
  event({ ev: 'step', task: t.id, status: 'done', text: 'merged into the run branch' });
  return 'done';
}

/**
 * 실행 브랜치를 fast-forward 한다. 이 저장소에서 도는 계획 세션의 git status 가 잠깐 index.lock 을 잡고 있을 수 있으므로,
 * 그 때문에 실패하면 조금 기다렸다 다시 한다.
 */
async function fastForward(root, tip) {
  for (let i = 0; ; i += 1) {
    const r = git(root, ['merge', '--ff-only', '--quiet', tip], { allowFail: true });
    if (r.code === 0) return;
    if (!/index\.lock/.test(r.err) || i >= 20) fail(`git merge --ff-only ${tip} 실패\n${r.err || r.out}`);
    await new Promise((res) => setTimeout(res, 250));
  }
}

/** 합치지 못한 작업: 변경을 patch 로 남기고 작업 공간을 지운 뒤, 처음 한 번은 실행 브랜치의 지금 커밋 위에서 구현부터 다시 한다. */
function redoTask(ctx, t, why) {
  const s = ctx.state.tasks[t.id];
  const dir = path.join(ctx.root, s.worktree);
  const logDir = taskDir(ctx, t);
  const n = (s.attempts.integrate = (s.attempts.integrate || 0) + 1);
  const patch = path.join(logDir, `integrate-${n}.patch`);
  mkdirSync(logDir, { recursive: true });
  writeFileSync(patch, `${git(dir, ['diff', '--binary', s.wtBase, 'HEAD']).out}\n`);
  removeWorktree(ctx.root, dir);
  const reset = { worktree: undefined, wtBase: undefined, needsGate: undefined, baseSha: undefined, commitBase: undefined, commits: [], fixRounds: 0, sessions: { plan: s.sessions.plan }, updatedAt: now() };
  if (n > 1) {
    Object.assign(s, reset, { status: 'blocked', blockedAt: 'implement', reason: `${why}. 다시 구현해도 합치지 못했습니다. 버린 변경: ${rel(ctx, patch)}` });
    saveState(ctx);
    log(ctx, `    ✗ 막힘: ${why}`);
    event({ ev: 'alert', task: t.id, stage: 'implement', status: 'blocked', text: 'task blocked: could not merge it into the run branch' });
    return 'blocked';
  }
  Object.assign(s, reset, { status: 'planned', redoPatch: rel(ctx, patch) });
  s.notes.push(`${why}: 변경을 ${rel(ctx, patch)} 에 남기고 실행 브랜치의 새 커밋 위에서 구현부터 다시 했습니다.`);
  saveState(ctx);
  log(ctx, `    ${why}: 구현부터 다시 함`);
  return 'planned';
}

/** 재분할 결과를 반영한다. 반환값: 'split' 또는 'blocked'. */
function splitTask(ctx, t, block) {
  const file = amPath(ctx, t, 'split.json');
  const depth = (t.id.match(/\./g) || []).length;
  if (depth >= ctx.cfg.maxSplitDepth) return block(`계획 단계가 "한 작업으로는 크다"고 했지만 재분할 깊이 한도(${ctx.cfg.maxSplitDepth})에 닿았습니다. tasks.json 에서 직접 나눠 주세요.`);
  if (!existsSync(file)) return block('계획 단계가 "한 작업으로는 크다"고 했지만 split.json 을 남기지 않았습니다.');
  try {
    (ctx.main || ctx).plan = applySplit(ctx.plan, t, readJson(file)); // 함께 도는 작업들이 보는 원래 문맥의 계획을 바꾼다
  } catch (err) {
    return block(`split.json 을 적용하지 못했습니다: ${err.message}`);
  }
  ctx.state.tasks[t.id].status = 'split';
  for (const sub of ctx.plan.tasks) ctx.state.tasks[sub.id] ||= newTaskState();
  savePlan(ctx);
  saveState(ctx);
  log(ctx, `    → 더 작게 나눔: ${ctx.plan.splitHistory.at(-1).into.join(', ')}`);
  event({ ev: 'step', task: t.id, status: 'split', text: `split into ${ctx.plan.splitHistory.at(-1).into.join(', ')}` });
  return 'split';
}

/**
 * 작업 하나를 현재 상태에서 끝까지 진행한다. 반환값: done | committed(별도 작업 공간에서 커밋함, 합치기 전) | blocked | needs-decision | split
 * ctx.workspace 가 있으면(함께 도는 작업이 있을 수 있음) 계획 뒤 그것으로 구현부터 쓸 작업 트리를 고른다.
 */
async function runTask(ctx, t) {
  const s = ctx.state.tasks[t.id];
  const dir = taskDir(ctx, t);
  const { cfg } = ctx;
  let { repo } = ctx;
  const begin = (name) => {
    stage = name === 'fix' ? 'check' : name;
    s.running = name;
    saveState(ctx);
    writeReport(ctx); // 보고서가 항상 지금 상태를 보여 주도록
    event({ ev: 'step', task: t.id, stage: name, text: `${name} started` });
  };
  const set = (status, extra = {}) => {
    Object.assign(s, { status, updatedAt: now() }, extra);
    saveState(ctx);
  };
  let stage = 'plan'; // 지금 어느 단계인지: 막혔을 때 보고서가 이어 가는 방법을 단계에 맞게 안내한다
  const block = (reason, extra = {}) => {
    set('blocked', { reason, blockedAt: stage, ...extra });
    log(ctx, `    ✗ 막힘: ${reason.split('\n')[0]}`);
    event({ ev: 'alert', task: t.id, stage: s.blockedAt, status: 'blocked', text: `task blocked at ${s.blockedAt}` });
    return 'blocked';
  };
  const bump = (name) => {
    s.attempts[name] = (s.attempts[name] || 0) + 1;
    return s.attempts[name] > 1;
  };
  // 권한 규칙에 걸린 명령은 보고서의 참고에 남긴다(무엇을 허용 목록에 넣을지 판단할 근거)
  const noteDenied = (name, r) => {
    if (r.denials) s.notes.push(`${name} 단계에서 권한 규칙에 걸린 명령 ${r.denials}건: ${r.denied.slice(0, 3).join(' | ')}${r.denials > 3 ? ' …' : ''}`);
    return r;
  };
  // 세션 하나를 2차 의견 감시로 감싼다(ctx 는 그 시점의 작업 트리)
  const watched = async (name, run) => {
    const stopWatch = watchOpinions(ctx, t, name);
    try {
      return await run();
    } finally {
      stopWatch();
    }
  };

  // 1) 계획: am:plan 이 .am/<slug>/plan.md 를 쓴다
  if (s.status === 'pending') {
    const entries = statusEntries(repo);
    const stale = volatileDirty(ctx, entries);
    discard(ctx, dir, stale, '이전 빌드가 다시 쓴 파일'); // 작업 시작 시점에 남아 있는 volatile 변경은 지난 빌드의 흔적이다
    const stray = dirtyFiles(ctx, stale.length ? undefined : entries); // 되돌린 파일이 있으면 다시 읽는다
    if (stray.length) fail(`${t.id} 를 시작하려면 작업 트리가 깨끗해야 합니다. 커밋하거나 치운 뒤 다시 실행하세요.\n${firstTen(stray)}`);
    writeBrief(ctx, t);
    begin('plan');
    bump('plan');
    const args = `Plan task ${t.id} described in ${AM_DIR}/${t.slug}/brief.md (slug ${t.slug})`;
    const marks = ['READY', 'NEEDS_DECISION', 'TOO_BIG'];
    // 세션이 남겨야 하는 파일: 보통은 plan.md, "너무 크다"면 split.json
    const saved = (mark) => existsSync(amPath(ctx, t, mark === 'TOO_BIG' ? 'split.json' : 'plan.md'));
    let r;
    const stopWatch = watchOpinions(ctx, t, 'plan'); // 저장 재시도까지 한 감시로 덮는다
    try {
      r = noteDenied('plan', await step(ctx, 'plan', { dir, system: SYSTEM.plan(ctx, t), prompt: skillPrompt(ctx, 'plan', args, dir) }, 'ORCH_STATUS', marks));
      s.sessions.plan = r.sessionId;
      if (!saved(r.mark) && r.sessionId) {
        // 계획은 세웠는데 파일로 남기지 못한 경우(대개 권한 규칙에 걸림): 같은 세션에 저장만 한 번 다시 시킨다
        log(ctx, '    계획이 파일로 저장되지 않음: 같은 세션에 저장을 다시 요청');
        const again = noteDenied('plan(저장 재시도)', await step(ctx, 'plan', { dir, prompt: planSavePrompt(t), resume: r.sessionId }, 'ORCH_STATUS', marks));
        r = { ...again, mark: again.mark || r.mark, text: `${r.text}\n\n---\n\n${again.text}` };
      }
    } finally {
      stopWatch();
    }
    const touched = dirtyFiles(ctx);
    if (touched.length) return block(`계획 단계가 ${AM_DIR}/ 밖의 파일을 바꿨습니다(되돌리지 않고 그대로 뒀습니다): ${touched.slice(0, 5).join(', ')}`);
    if (!saved(r.mark)) {
      writeText(path.join(dir, 'plan-reply.md'), r.text); // 세션이 답변에 적은 계획 본문을 잃지 않게 남긴다
      const why = r.denials ? ` 권한 규칙에 걸린 명령: ${r.denied.slice(0, 3).join(' | ')}.` : '';
      return block(`계획 세션이 계획을 파일로 저장하지 못했습니다.${why} 세션의 답변: ${rel(ctx, path.join(dir, 'plan-reply.md'))}`);
    }
    if (r.mark === 'TOO_BIG') return splitTask(ctx, t, block);
    if (r.mark === 'NEEDS_DECISION') {
      writeText(path.join(dir, 'decision.md'), r.text);
      set('needs-decision', { reason: '계획 중 사용자만 정할 수 있는 결정이 나옴' });
      log(ctx, `    ? 결정 필요: ${rel(ctx, path.join(dir, 'decision.md'))}`);
      event({ ev: 'alert', task: t.id, stage: 'plan', status: 'needs-decision', text: 'task needs a decision' });
      return 'needs-decision';
    }
    if (r.mark !== 'READY') return block('계획 세션이 끝 표시(ORCH_STATUS)를 남기지 않았습니다.');
    const planLines = readText(amPath(ctx, t, 'plan.md')).split('\n').length;
    if (planLines > cfg.taskLimits.maxPlanLines) s.notes.push(`계획 문서가 ${planLines}줄입니다(권장 ${cfg.taskLimits.maxPlanLines}줄 이하).`);
    set('planned', { baseSha: head(repo) });
  }

  // 구현부터 쓸 작업 트리: 함께 도는 작업이 있으면 별도 작업 공간(git worktree). 이 아래의 ctx·repo 는 그 작업 트리를 가리킨다
  if (ctx.workspace) {
    ctx = await ctx.workspace(t);
    ({ repo } = ctx);
  }

  // 2) 구현: 새 세션에서 am:do <slug> 로 구현한다
  if (s.status === 'planned') {
    begin('implement');
    const again = bump('implement');
    const r = noteDenied('implement', await watched('implement', () => step(ctx, 'implement', { dir, system: SYSTEM.implement(ctx, t, again), prompt: skillPrompt(ctx, 'do', t.slug, dir, 'implement') }, 'ORCH_STATUS', ['DONE', 'BLOCKED'])));
    s.sessions.implement = r.sessionId;
    if (r.mark !== 'DONE') {
      writeText(path.join(dir, 'blocked.md'), r.text);
      return block(`구현 세션이 끝내지 못했습니다. 설명: ${rel(ctx, path.join(dir, 'blocked.md'))}`);
    }
    if (head(repo) !== s.baseSha) s.notes.push('구현 세션이 지시와 달리 직접 커밋했습니다.');
    else if (!statusEntries(repo).length) return block('구현 세션이 끝났지만 바뀐 파일이 없습니다.');
    set('implemented');
  }

  // 3)~4) 점검과 커밋. 커밋 훅이 커밋을 거부하면 구현 세션이 고친 뒤 점검부터 다시 한다
  for (;;) {
    // 3) 점검: am:check(BLOCK/NOTE) + 오케스트레이터가 직접 돌리는 게이트. 막히면 구현 세션을 이어 고친다
    if (s.status === 'implemented') {
      for (;;) {
        begin('check');
        bump('check');
        const c = noteDenied('check', await step(ctx, 'check', { dir, system: SYSTEM.check(ctx, t), prompt: skillPrompt(ctx, 'check', t.slug, dir) }, 'ORCH_VERDICT', ['BLOCK', 'NOTE']));
        s.sessions.check = c.sessionId;
        const checkFile = amPath(ctx, t, 'check.md');
        const checkText = existsSync(checkFile) ? readText(checkFile) : '';
        if (checkText) writeText(path.join(dir, `check-${s.attempts.check}.md`), checkText);
        const verdict = c.mark || verdictFromFile(checkText);
        const gate = cfg.orchestratorGate ? await gateAndSettle(ctx, s, dir) : null;
        const gateOk = !gate || gatePasses(cfg, gate);
        Object.assign(s, { verdict: verdict || '?', gate: gate ? gate.status : '(생략)' });
        saveState(ctx);
        log(ctx, `    판정 ${s.verdict}, 게이트 ${s.gate}`);
        event({ ev: 'note', task: t.id, stage: 'check', text: `verdict ${s.verdict}, gate ${gate ? s.gate : 'skipped'}` });
        if (!verdict) return block('점검 세션의 판정(BLOCK/NOTE)을 읽지 못했습니다.');
        if (verdict === 'NOTE' && gateOk) break;
        const why = `판정 ${verdict}, 게이트 ${s.gate}${gate?.reason ? ` (${gate.reason})` : ''}`;
        if (s.fixRounds >= cfg.maxFixRounds) return block(`수정을 ${s.fixRounds}번 했지만 점검을 통과하지 못했습니다: ${why}`);
        if (!s.sessions.implement) return block(`점검을 통과하지 못했고 이어 갈 구현 세션이 없습니다: ${why}`);
        s.fixRounds += 1;
        begin('fix');
        const fix = `am:check blocked this task. Read ${AM_DIR}/${t.slug}/check.md and ${sessionPath(ctx, path.join(dir, 'gate.json'))}, fix only what they report, log it under Change log in the plan, and do not commit. End with exactly one line: ORCH_STATUS: DONE or ORCH_STATUS: BLOCKED`;
        const f = noteDenied('fix', await watched('fix', () => step(ctx, 'fix', { dir, prompt: fix, resume: s.sessions.implement }, 'ORCH_STATUS', ['DONE', 'BLOCKED'])));
        if (f.mark !== 'DONE') {
          writeText(path.join(dir, 'blocked.md'), f.text);
          return block(`수정 세션이 끝내지 못했습니다. 설명: ${rel(ctx, path.join(dir, 'blocked.md'))}`);
        }
      }
      set('checked');
    }

    // 4) 커밋: am:commit. 에이전트가 git commit 을 실행하는 순간 am 의 커밋 게이트 훅이 한 번 더 막아 준다
    if (s.status === 'checked') {
      begin('commit');
      bump('commit');
      if (!s.commitBase) {
        s.commitBase = head(repo); // 이 뒤에 생긴 커밋만 이 작업의 커밋으로 센다
        saveState(ctx);
      }
      const finished = ctx.isolated ? 'committed' : 'done'; // 별도 작업 공간의 커밋은 실행 브랜치에 합친 뒤에 완료
      if (cfg.orchestratorGate && unsettledVolatile(ctx, s).length) {
        // 점검을 거치지 않고 커밋 단계로 들어온 경우(retry --from commit 등): 커밋 전에 volatile 파일을 게이트로 가려낸다
        log(ctx, '    volatilePaths 파일이 바뀌어 있음: 게이트로 빌드 산출 변화인지 확인');
        const g = await gateAndSettle(ctx, s, dir);
        if (!gatePasses(cfg, g)) return block(`커밋 전 게이트 ${g.status}: ${g.reason}`);
      }
      if (!leftovers(ctx).length && s.commits?.length) {
        // 커밋은 이미 끝났고 남은 변경도 없다(막혔던 작업을 다시 돌린 경우)
        set(finished, { commitBase: undefined, reason: undefined, blockedAt: undefined });
        log(ctx, `    ✓ ${ctx.isolated ? '커밋함' : '완료'}: 남은 변경 없음 (${s.commits.join(' / ')})`);
        event({ ev: 'step', task: t.id, stage: 'commit', status: finished, text: `task ${finished}, nothing left to commit` });
        return finished;
      }
      const marks = ['COMMITTED', 'BLOCKED', 'NOTHING'];
      const snap = snapshot(repo); // 커밋 직전의 작업 트리
      let r = noteDenied('commit', await step(ctx, 'commit', { dir, system: SYSTEM.commit(ctx, t), prompt: skillPrompt(ctx, 'commit', `task ${t.id} ${t.slug}`, dir) }, 'ORCH_STATUS', marks));
      s.sessions.commit = r.sessionId;
      let made = commitsSince(repo, s.commitBase);
      let deniedLast = r.denials;
      if (!made.length && r.denials && r.sessionId) {
        // 게이트가 아니라 권한 규칙에 걸려 커밋을 못 한 경우: 명령 모양을 알려 주고 같은 세션에서 한 번만 다시 시킨다
        log(ctx, '    커밋 명령이 권한 규칙에 걸림: 단순한 명령으로 다시 요청');
        r = noteDenied('commit(재시도)', await step(ctx, 'commit', { dir, prompt: COMMIT_RETRY, resume: r.sessionId }, 'ORCH_STATUS', marks));
        made = commitsSince(repo, s.commitBase);
        deniedLast = r.denials;
      }
      if (!made.length && !deniedLast && r.mark !== 'NOTHING' && leftovers(ctx).length) {
        // 커밋할 변경이 있는데도 커밋이 안 됐다: 커밋 훅(am 게이트나 저장소의 pre-commit 검사)이 거부한 것이다.
        // 커밋 세션은 파일을 고칠 수 없으므로, 훅이 한 말을 구현 세션에 넘겨 고치게 하고 점검부터 다시 한다.
        const reply = path.join(dir, `commit-rejected-${s.attempts.commit}.md`);
        writeText(reply, r.text);
        if (s.fixRounds >= cfg.maxFixRounds || !s.sessions.implement) {
          const tried = s.sessions.implement ? `수정을 ${s.fixRounds}번 했지만 ` : '';
          return block(`${tried}커밋 훅이 커밋을 거부했습니다. 훅이 한 말: ${rel(ctx, reply)}`, { blockedAt: 'check' });
        }
        log(ctx, '    커밋 훅이 커밋을 거부함: 구현 세션에 넘겨 고친 뒤 다시 점검');
        s.fixRounds += 1;
        begin('fix');
        const f = noteDenied('fix', await watched('fix', () => step(ctx, 'fix', { dir, prompt: commitRejectedPrompt(sessionPath(ctx, reply)), resume: s.sessions.implement }, 'ORCH_STATUS', ['DONE', 'BLOCKED'])));
        if (f.mark !== 'DONE') {
          writeText(path.join(dir, 'blocked.md'), f.text);
          return block(`커밋 훅이 거부한 것을 고치지 못했습니다. 설명: ${rel(ctx, path.join(dir, 'blocked.md'))}`);
        }
        s.notes.push(`커밋 훅이 한 번 거부해 고친 뒤 다시 점검했습니다(${rel(ctx, reply)}).`);
        set('implemented');
        continue;
      }
      if (!made.length) {
        writeText(path.join(dir, 'blocked.md'), r.text);
        const why = deniedLast ? `커밋 명령이 권한 규칙에 걸렸습니다: ${r.denied.slice(0, 2).join(' | ')}` : '커밋할 변경이 없음';
        return block(`커밋이 만들어지지 않았습니다(${why}). 설명: ${rel(ctx, path.join(dir, 'blocked.md'))}`);
      }
      const commits = [...new Set([...(s.commits || []), ...made])];
      // 커밋 세션이 "점검이 빌드 산출물이라고 적은 파일"을 커밋하지 않고 되돌렸다고 알린 것: 기록으로 남긴다
      const restoredBySession = [...r.text.matchAll(/^\s*ORCH_RESTORED:\s*(.+?)\s*$/gm)].map((m) => m[1]);
      if (restoredBySession.length) {
        s.notes.push(`커밋 세션이 빌드 산출물로 보고 커밋에서 빼고 되돌린 파일 ${restoredBySession.length}개: ${restoredBySession.slice(0, 5).join(', ')}${restoredBySession.length > 5 ? ' …' : ''}`);
        const seen = (ctx.state.restored ||= {});
        for (const f of restoredBySession) seen[f] = (seen[f] || 0) + 1;
      }
      // 커밋 도중 커밋 게이트(훅)의 빌드가 다시 쓴 파일: 커밋 직전의 내용이 그대로 HEAD 에 들어갔는데도 지금 바뀌어 있다면
      // 그 변경은 커밋 세션이 도는 동안 생긴 것이고, 이 세션은 파일을 고칠 수 없으므로 게이트가 한 일이다.
      const blob = (rev, p) => {
        const b = git(repo, ['rev-parse', '--verify', '--quiet', `${rev}:${p}`], { allowFail: true });
        return b.code === 0 ? b.out.trim() : null;
      };
      const entries = snap ? statusEntries(repo) : undefined;
      const byGate = snap ? entries.filter((e) => MODIFIED.test(e.code) && blob(snap, e.path) !== null && blob(snap, e.path) === blob('HEAD', e.path)).map((e) => e.path) : [];
      discard(ctx, dir, byGate, '커밋 중 게이트가 다시 쓴 파일');
      const left = leftovers(ctx, byGate.length ? undefined : entries); // 되돌린 파일이 있으면 다시 읽는다
      if (left.length) {
        writeText(path.join(dir, 'commit-reply.md'), r.text);
        return block(`커밋 뒤에도 변경 ${left.length}개가 남았습니다: ${left.slice(0, 5).join(', ')}${left.length > 5 ? ' …' : ''}. 커밋 세션의 설명: ${rel(ctx, path.join(dir, 'commit-reply.md'))}`, { commits, commitBase: undefined });
      }
      if (t.files.length) {
        const hints = t.files.map(globToRegExp);
        const outside = git(repo, ['diff', '--name-only', `${s.commitBase}..HEAD`])
          .out.split('\n')
          .filter((f) => f && !f.endsWith('.meta') && !hints.some((re) => re.test(f))); // .meta 는 자산마다 따라붙는 파일이라 뺀다
        if (outside.length) s.notes.push(`예상 파일 밖 변경 ${outside.length}개: ${outside.slice(0, 5).join(', ')}${outside.length > 5 ? ' …' : ''}`);
      }
      set(finished, { commits, commitBase: undefined, reason: undefined });
      log(ctx, `    ✓ ${ctx.isolated ? '커밋함' : '완료'}: ${made.join(' / ')}`);
      event({ ev: 'step', task: t.id, stage: 'commit', status: finished, text: `task ${finished}: ${made.length} commit${made.length === 1 ? '' : 's'}` });
    }
    break;
  }
  return s.status;
}

// ------------------------------------------------------------------ 잠금

// 한 저장소에서 상태를 바꾸는 명령은 한 번에 하나만 돈다. run 이 도는 동안 다른 run·retry 가 끼어들면
// 두 세션이 같은 작업 트리를 고치거나 state.json 을 서로 덮어쓴다(이 스크립트를 에이전트가 몰 때 특히 흔한 실수).
const lockFile = (repo) => path.join(repo, ORCH_DIR, 'lock.json');

/** 살아 있는 잠금이면 그 내용, 없거나 주인이 죽었으면 null. */
function readLock(repo, alive = pidAlive) {
  let lock;
  try {
    lock = readJson(lockFile(repo));
  } catch {
    return null;
  }
  return alive(lock?.pid) ? lock : null;
}

/** 살아 있는 다른 명령에 져서 끝낸다. 작업 모드면 진 작업으로 표시해 worker.json 과 결과를 남기지 않는다. */
function busy(held) {
  if (worker) worker.lost = true;
  fail(`이 저장소에서 이미 돌고 있는 명령이 있습니다: ${held.command ?? '알 수 없음'} (pid ${held.pid ?? '알 수 없음'}, ${held.startedAt ?? '알 수 없는 때'} 시작). 끝난 뒤 다시 하세요. 진행 상황은 \`status\` 로 볼 수 있습니다.`);
}

const LOCK_STALE_MS = 60000; // 읽을 수 없는 잠금·치우기 잠금이 이만큼 고쳐지지 않았으면 주인이 죽은 것으로 본다
const olderThan = (file, ms) => {
  try {
    return Date.now() - statSync(file).mtimeMs > ms;
  } catch {
    return true; // 그사이 없어짐
  }
};
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * 잠금 파일을 배타적으로 만든다: 동시에 시작한 두 프로세스가 둘 다 잡지 못하게. 잡았으면 null, 살아 있는 주인이 있으면 그 내용({} 는 읽을 수 없는 잠금).
 * 완성된 임시 파일을 hard link 로 걸고(반쯤 쓴 잠금이 보이지 않게), hard link 가 안 되는 파일 시스템에서만 `wx` 로 직접 쓴다.
 * 죽은 주인의 잠금은 치우기 잠금(.break) 안에서 다시 확인한 뒤에만 지운다: 그사이 잡은 살아 있는 새 주인을 밀어내지 않게.
 */
function createLock(file, value, alive = pidAlive) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const tmp = `${file}.${process.pid}.tmp`;
  const make = () => {
    writeFileSync(tmp, text);
    try {
      linkSync(tmp, file);
    } catch (err) {
      if (err.code === 'EEXIST') throw err;
      writeFileSync(file, text, { flag: 'wx' }); // hard link 를 못 거는 파일 시스템
    } finally {
      rmSync(tmp, { force: true });
    }
  };
  // 주인: 살아 있으면 그 내용, 죽었으면 'dead', 그사이 없어졌으면 'gone'
  const owner = () => {
    let lock;
    try {
      lock = readJson(file);
    } catch (err) {
      if (err.code === 'ENOENT') return 'gone';
      return olderThan(file, LOCK_STALE_MS) ? 'dead' : {};
    }
    return isObj(lock) && Number.isInteger(lock.pid) && lock.pid > 0 && alive(lock.pid) ? lock : 'dead';
  };
  const brk = `${file}.break`;
  for (let i = 0; i < 3; i += 1) {
    try {
      make();
      return null;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    const o = owner();
    if (o === 'gone') continue;
    if (o !== 'dead') return o;
    // 치우기 잠금을 기다린다(최대 약 1초). 쥔 채 죽은 것은 60초가 지나야 지운다
    let took = false;
    for (let w = 0; w < 50 && !took; w += 1) {
      try {
        writeFileSync(brk, String(process.pid), { flag: 'wx' });
        took = true;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        if (olderThan(brk, LOCK_STALE_MS)) rmSync(brk, { force: true });
        else pause(20);
      }
    }
    if (!took) break;
    try {
      if (owner() === 'dead') rmSync(file, { force: true });
    } finally {
      rmSync(brk, { force: true });
    }
  }
  const o = owner();
  return isObj(o) ? o : {};
}

function acquireLock(repo, command, run) {
  const held = readLock(repo);
  if (held) busy(held);
  ensureIgnored(repo, ORCH_DIR);
  const other = createLock(lockFile(repo), { pid: process.pid, command, startedAt: now(), ...(run ? { run } : {}) });
  if (other) busy(other);
  process.on('exit', (exitCode) => {
    // 끝 소식을 남기지 못한 채 끝나면(오류, 중단) 잠금을 지우기 전에 남긴다
    try {
      if (progress && !progress.ended) {
        const code = exitCode ?? process.exitCode ?? 0;
        const status = code === 130 ? 'interrupted' : code !== 0 ? 'failed' : 'ended';
        event({ ev: 'end', stage: progress.stage, status, text: `${progress.stage} ${status} (exit ${code})`, min: minsSince() });
      }
    } catch {
      /* 잠금은 아래에서 늘 지운다 */
    }
    try {
      if (readJson(lockFile(repo)).pid === process.pid) rmSync(lockFile(repo), { force: true });
    } catch {
      /* 이미 없으면 그만 */
    }
    // 작업 모드의 결과는 잠금을 지운 뒤에: 결과를 보고 바로 띄운 다음 작업이 이 잠금에 지지 않게
    writeResult(exitCode);
  });
  if (worker) workerHeld();
}

// ------------------------------------------------------------------ 작업 프로세스(--worker)

// 숨은 --worker: doctor·split·answer·run 을 터미널 없이 돌리는 작업 프로세스. 하는 일은 같고, 출력은 .orchestrator/worker/log 로,
// 잠금을 잡으면 worker.json, 끝나면 result-<pid>.json 을 남긴다. heartbeat 파일이 heartbeatMs 동안 바뀌지 않으면 Ctrl+C 와 같이 멈춘다.
export const WORKER_DEFAULTS = { heartbeatMs: 30 * 60000, pollMs: 5000 };
const WORKER_COMMANDS = ['doctor', 'split', 'answer', 'run'];
let worker = null; // 작업 모드의 상태. 작업 모드가 아니면 null

/** 작업 모드를 시작한다: 출력을 log 로 돌리고, 잠금 전에 끝나는 경우의 결과 쓰기를 등록한다. */
function startWorker(repo, command, argv, timing) {
  const dir = path.join(repo, ORCH_DIR, 'worker');
  mkdirSync(dir, { recursive: true });
  const logFile = path.join(dir, 'log');
  worker = { dir, command, args: argv.filter((a) => a !== '--worker'), timing, held: false, lost: false, written: false, delivered: false, error: '' };
  // 모든 출력은 이 두 함수를 거친다. 동기로 덧붙여, 바로 뒤에 process.exit 해도 빠지지 않게
  for (const stream of [process.stdout, process.stderr]) {
    stream.write = (chunk, encoding, cb) => {
      const done = typeof encoding === 'function' ? encoding : cb;
      try {
        appendFileSync(logFile, typeof chunk === 'string' ? chunk : Buffer.from(chunk), typeof encoding === 'string' ? encoding : undefined);
      } catch {
        /* 로그를 못 써도 일은 계속한다 */
      }
      if (typeof done === 'function') process.nextTick(done);
      return true;
    };
  }
  // 잠금을 잡은 뒤의 결과는 acquireLock 의 종료 리스너가 잠금을 지운 다음에 쓴다
  process.on('exit', (code) => {
    if (!worker.held) writeResult(code);
  });
}

/** 결과 파일을 한 번만 쓴다. 살아 있는 다른 잠금에 진 작업은 쓰지 않는다. */
function writeResult(exitCode) {
  if (!worker || worker.written || worker.lost) return;
  worker.written = true;
  try {
    writeJson(path.join(worker.dir, `result-${process.pid}.json`), { pid: process.pid, command: worker.command, code: exitCode ?? process.exitCode ?? 0, error: worker.error, endedAt: now(), delivered: worker.delivered });
  } catch {
    /* 결과가 끝내 없으면 부른 쪽이 실패로 본다 */
  }
}

/** 잠금을 잡은 직후: worker.json 을 쓰고 하트비트 감시를 시작한다. */
function workerHeld() {
  worker.held = true;
  const owner = /^\d+$/.test(process.env.AM_HANDOVER_OWNER || '') && Number(process.env.AM_HANDOVER_OWNER) > 0 ? { owner: Number(process.env.AM_HANDOVER_OWNER) } : {};
  writeJson(path.join(worker.dir, 'worker.json'), { pid: process.pid, command: worker.command, args: worker.args, startedAt: now(), ...owner });
  // 폴링 횟수로만 센다: 벽시계를 보지 않아 잠자기·시계 변경에 속지 않는다
  const { heartbeatMs, pollMs } = worker.timing;
  const beat = path.join(worker.dir, 'heartbeat');
  const read = () => {
    try {
      return readFileSync(beat, 'utf8');
    } catch {
      return '';
    }
  };
  let last = read();
  let still = 0;
  setInterval(() => {
    const cur = read();
    if (cur === last) still += 1;
    else [last, still] = [cur, 0];
    if (still * pollMs >= heartbeatMs) {
      worker.delivered = true;
      interrupt(`하트비트가 ${Math.round(heartbeatMs / 1000)}초 동안 바뀌지 않아 멈췄습니다`);
    }
  }, pollMs).unref(); // 명령이 끝나면 프로세스도 끝나게
}

// ------------------------------------------------------------------ 이 PC 전체의 동시 세션 수

// 이 PC 에서 오케스트레이터가 띄우는 claude 세션은 모든 실행·저장소를 합쳐 최대 N개까지 함께 돈다.
// 값(settings.json)과 돌고 있는 세션 기록(sessions/)은 Claude 설정 폴더 아래에 둔다. 플러그인 폴더는 업데이트 때 바뀌어 거기 두면 사라진다.
// 기록은 세션이 도는 동안 주인이 30초마다 수정 시각을 새로 고친다. 5분 넘게 그대로인 기록은 주인이 사라진 것으로 본다
// (강제 종료·터미널 닫힘·재부팅으로 지우지 못한 기록. pid 는 재사용될 수 있어 그것만으로는 가리지 못한다).
export const DEFAULT_MAX_SESSIONS = 3;
// Claude Code 는 메모리가 매우 부족하면 쉬는 세션의 백그라운드 실행을 끈다. 다른 세션·게이트가 돌 때 남은 메모리가 이보다 적으면 새 세션을 미룬다
export const DEFAULT_MIN_FREE_MEMORY_MB = 6144;

/**
 * 새 세션을 메모리 때문에 미뤄야 하면 { freeMB, needMB }, 아니면 null. busy 는 자기 것을 뺀, 이 PC 에서 돌고 있는 세션·게이트 기록 수.
 * setting(minFreeMemoryMB): null·없음·빈 문자열·잘못된 값은 기본 기준(win32 에서만), 0 은 끔, 양수는 어느 OS 에서나 그 값.
 */
export function memoryShortMB({ busy, freeBytes, setting, platform }) {
  const n = customMemoryMB(setting);
  const custom = n !== null;
  const needMB = custom ? n : DEFAULT_MIN_FREE_MEMORY_MB;
  if (busy <= 0 || needMB === 0 || (!custom && platform !== 'win32')) return null;
  const freeMB = Math.floor(freeBytes / 1048576);
  return freeMB < needMB ? { freeMB, needMB } : null;
}

/** 직접 적은 기준(0 이상의 유한한 수, 또는 그렇게 읽히는 빈칸 아닌 문자열)이면 그 수, 아니면 null. */
function customMemoryMB(setting) {
  if (typeof setting === 'number' || (typeof setting === 'string' && setting.trim() !== '')) {
    const n = Number(setting);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}

/**
 * 남은 메모리 기준과 그 출처: 쓸 수 있는 저장소 값(.orchestrator/config.json) → PC 전체 값(pcFile) → 기본.
 * { setting, source: 'repo' | 'pc' | 'default', file }. setting 은 memoryShortMB 에 그대로 넘긴다.
 */
export function memoryLimitOf(repoValue, pcValue, pcFile) {
  const repo = customMemoryMB(repoValue);
  if (repo !== null) return { setting: repo, source: 'repo', file: '.orchestrator/config.json' };
  if (pcValue !== null && pcValue !== undefined) return { setting: pcValue, source: 'pc', file: pcFile };
  return { setting: null, source: 'default', file: pcFile };
}

/** 대기 줄 끝에 붙는 기준의 출처 문구(괄호 포함). */
export function memorySourceText(limit) {
  if (limit.source === 'default') return `(기준: 기본값, 바꾸거나 끄려면(0) ${limit.file} 의 minFreeMemoryMB)`;
  return `(기준: ${limit.file} 의 minFreeMemoryMB, 끄려면 0)`;
}
export const HEARTBEAT_MS = 30000;
export const STALE_MS = 5 * 60000;
// 잠자기에서 깨면 모든 기록이 오래돼 보인다. 이 프로세스가 90초 넘게 멈춰 있었으면(잠자기·시계 변경) 2분 동안은 오래된 기록도 산다고 본다:
// 그사이 살아 있는 주인은 새로 고친다
const WAKE_GAP_MS = 90000;
const WAKE_GRACE_MS = 2 * 60000;
const userDir = (env = process.env) => path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'am-orchestrator');
const settingsFile = () => path.join(userDir(), 'settings.json');
export const sessionsDir = (env = process.env) => path.join(userDir(env), 'sessions');
// 기록 이름에 넣는 호스트 이름. macOS 는 네트워크를 바꾸면 호스트 이름이 바뀌므로 그때그때 읽는다
export const hostName = () => os.hostname().replace(/[^\w.-]/g, '_') || 'host';
export const RECORD_NAME = /^(.+)~(\d+)~\d+(\.gate)?\.json$/;

/** settings.json 의 내용. 없으면 {}, 읽지 못하면(깨진 JSON 등) null. */
function readSettings() {
  try {
    const s = readJson(settingsFile());
    return isObj(s) ? s : null;
  } catch (err) {
    return err.code === 'ENOENT' ? {} : null;
  }
}

/** 지금 적용되는 제한. source: default(정한 값 없음) | set | invalid(잘못된 값이라 기본값을 씀, raw 에 그 값) | unreadable(파일을 읽지 못해 기본값) */
function sessionSetting() {
  const settings = readSettings();
  if (!settings) return { max: DEFAULT_MAX_SESSIONS, source: 'unreadable' };
  const raw = settings.maxSessions;
  if (raw === undefined || raw === null) return { max: DEFAULT_MAX_SESSIONS, source: 'default' };
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? { max: n, source: 'set' } : { max: DEFAULT_MAX_SESSIONS, source: 'invalid', raw };
}
const sessionLimit = () => sessionSetting().max;
const SOURCE_KO = { default: '기본값', set: '직접 정함', invalid: 'settings.json 의 maxSessions 값이 잘못돼 기본값을 씀', unreadable: 'settings.json 을 읽지 못해 기본값을 씀' };

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // 프로세스는 있지만 신호를 보낼 권한이 없음
  }
};

/**
 * 세션 기록 하나가 아직 자리를 쥐고 있는가. 호스트 이름이 지금과 같고 pid 가 죽었으면 아니다(다른 호스트 이름의 pid 는 확인할 수 없다).
 * 5분 넘게 새로 고쳐지지 않았으면 아니다. 단 이 프로세스가 막 깨어났으면(woke) 주인이 새로 고칠 때까지 산다고 본다.
 * 막 시작한 프로세스(young)는 PC 가 잠자기에서 막 깼는지 알 수 없으므로, 같은 호스트에서 pid 가 살아 있는 기록은 한 번 새로 고칠 때까지 산다고 본다.
 */
export function recordHeld({ host, pid, mtimeMs }, { now, myHost, alive, woke = false, young = false }) {
  if (host === myHost) {
    if (!alive(pid)) return false;
    if (young) return true;
  }
  return woke || now - mtimeMs <= STALE_MS;
}

let lastTick = 0; // 이 프로세스가 마지막으로 깨어 있던 때(벽시계)
let wokeAt = 0;
const noteAwake = () => {
  const t = Date.now();
  if (lastTick && t - lastTick > WAKE_GAP_MS) wokeAt = t;
  lastTick = t;
};

/**
 * 이 PC 에서 돌고 있는 세션·게이트 기록(recordHeld 로 가림, 게이트는 gate: true). clean 이면 자리를 쥐지 않은 기록을 지운다.
 * clean 이 아니면(보여 주기만 할 때) 아무것도 지우지 않는다. 세션 수 제한에는 세션 기록만 센다(sessionsOnly).
 */
function liveSessions({ clean = true } = {}) {
  const dir = sessionsDir();
  let names;
  try {
    names = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  if (clean) noteAwake();
  const opts = { now: Date.now(), myHost: hostName(), alive: pidAlive, woke: Boolean(wokeAt) && Date.now() - wokeAt < WAKE_GRACE_MS, young: clean && process.uptime() * 1000 < HEARTBEAT_MS + 15000 };
  const out = [];
  for (const name of names) {
    const m = RECORD_NAME.exec(name); // 게이트 기록 이름은 예전 버전의 규칙(~\d+\.json)에 맞지 않아 예전 버전은 세지 않는다
    if (!m) continue;
    const file = path.join(dir, name);
    if (leftover.has(file)) continue; // 이 프로세스가 놓았는데 지우지 못한 기록
    let mtimeMs;
    try {
      mtimeMs = statSync(file).mtimeMs;
    } catch {
      continue; // 그사이 주인이 놓음
    }
    const pid = Number(m[2]);
    if (!recordHeld({ host: m[1], pid, mtimeMs }, opts)) {
      if (clean) {
        try {
          rmSync(file, { force: true });
        } catch {
          /* 다른 프로세스가 먼저 지웠거나 잡고 있으면 다음에 */
        }
      }
      continue;
    }
    let rec = {};
    try {
      rec = readJson(file);
    } catch {
      /* 쓰는 중이거나 다시 만드는 중: 이름과 수정 시각만으로 센다 */
    }
    out.push({ ...rec, file, pid, gate: Boolean(m[3]) });
  }
  return out;
}
const sessionsOnly = (live) => live.filter((s) => !s.gate);

const heldSessions = new Map(); // 이 프로세스가 잡고 있는 자리 기록 → 내용. 끝날 때(Ctrl+C 포함) 지운다
const leftover = new Set(); // 놓았지만 지우지 못한 기록(Windows 에서 백신 등이 잠깐 잡음). 세지 않고, 타이머와 끝날 때 다시 지운다
const removeRecord = (file) => {
  try {
    rmSync(file, { force: true });
    leftover.delete(file);
  } catch {
    leftover.add(file);
  }
};
let sessionSeq = 0;
let shareWarned = false;

/** 처음 자리를 잡을 때 한 번: 끝날 때 기록을 지우는 처리와, 깨어 있음을 적고 잡고 있는 기록의 수정 시각을 새로 고치는 타이머. */
function startSessionHooks() {
  noteAwake();
  process.on('exit', () => {
    for (const f of [...heldSessions.keys(), ...leftover]) removeRecord(f); // 그래도 남은 기록은 5분 뒤 빈 자리로 본다
  });
  // 동기로만 다룬다: 놓기(heldSessions 에서 빼고 지움) 사이에 끼어들어 놓은 기록을 되살리지 않게
  setInterval(() => {
    noteAwake();
    for (const f of [...leftover]) removeRecord(f);
    const t = new Date();
    for (const [file, content] of heldSessions) {
      try {
        utimesSync(file, t, t);
      } catch (err) {
        if (err.code !== 'ENOENT') continue;
        try {
          writeFileSync(file, content); // 다른 프로세스가 오래된 것으로 잘못 보고 지웠으면 다시 만든다
        } catch {
          /* 다음 차례에 다시 */
        }
      }
    }
  }, HEARTBEAT_MS).unref();
}

const FS_BUSY = ['EPERM', 'EBUSY', 'EACCES']; // 백신·색인 프로그램이 잠깐 잡는 경우(Windows)

/** 기록 하나를 새로 잡는다: 파일 경로와 놓는 함수. */
function newRecord(kind = '') {
  if (!sessionSeq) startSessionHooks();
  sessionSeq += 1;
  const file = path.join(sessionsDir(), `${hostName()}~${process.pid}~${sessionSeq}${kind}.json`);
  const release = () => {
    heldSessions.delete(file);
    removeRecord(file);
  };
  return { file, release };
}

/** 기록을 쓰고 heldSessions 에 넣는다(다시 쓴 자기 기록은 leftover 에서 빼 다시 센다). 쓰지 못하면 그 오류. */
async function writeRecord(file, info) {
  const content = `${JSON.stringify({ pid: process.pid, host: os.hostname(), ...info, startedAt: now() })}\n`;
  for (let i = 0; ; i += 1) {
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, content);
      break;
    } catch (err) {
      if (i < 3 && FS_BUSY.includes(err.code)) {
        await new Promise((res) => setTimeout(res, 50 * (i + 1)));
        continue;
      }
      return err;
    }
  }
  leftover.delete(file);
  heldSessions.set(file, content);
  return null;
}

/**
 * 이 PC 의 세션 자리 하나를 잡고, 놓는 함수를 돌려준다. 내 기록을 먼저 쓰고 살아 있는 기록을 센 뒤 제한을 넘거나 메모리가 모자라면
 * 지우고 1~3초 뒤 다시 한다(세고 나서 쓰면 둘이 마지막 자리를 함께 잡을 수 있다). 처음 기다릴 때 onWait(쓰는 수, 제한)·onMemoryWait(남은 MB, 기준 MB).
 * 기록 폴더에 쓰지 못하면 한 번 알리고 이번 세션은 세지 않고 진행한다(한 실행 안의 제한은 작업을 고를 때 지킨다). 다음 세션 때 다시 시도한다.
 */
async function takeSession(info, { onWait, onMemoryWait, minFreeMemoryMB } = {}) {
  const { file, release } = newRecord();
  let waited = false;
  let memoryWaited = false;
  for (;;) {
    const max = sessionLimit();
    const err = await writeRecord(file, info);
    if (err) {
      if (!shareWarned) say(`  ! 세션 기록 폴더에 쓰지 못해 다른 실행과 함께 세지 못합니다(${err.code || err.message}): ${sessionsDir()}\n    이 실행 안에서는 동시 세션 제한(${max}개)을 그대로 지킵니다. 다음 세션부터 다시 시도합니다.`);
      shareWarned = true;
      return () => {};
    }
    const live = liveSessions();
    const n = sessionsOnly(live).length;
    if (n > max) {
      release();
      if (!waited && onWait) onWait(n - 1, max);
      waited = true;
    } else {
      const short = memoryShortMB({ busy: live.length - 1, freeBytes: os.freemem(), setting: minFreeMemoryMB, platform: process.platform });
      if (!short) return release;
      release();
      if (!memoryWaited && onMemoryWait) onMemoryWait(short.freeMB, short.needMB);
      memoryWaited = true;
    }
    await new Promise((res) => setTimeout(res, 1000 + Math.random() * 2000));
  }
}

/** 오케스트레이터가 세션 밖에서 직접 돌리는 게이트·worktreeSetup 이 도는 동안 게이트 기록을 둔다: 메모리 확인에서만 센다. */
async function withGateRecord(info, fn) {
  const { file, release } = newRecord('.gate');
  await writeRecord(file, info); // 쓰지 못하면 세지 않고 진행
  try {
    return await fn();
  } finally {
    release();
  }
}

/** doctor 가 기록 폴더에 쓸 수 있는지 본다(쓰고 바로 지움). 쓸 수 있으면 null, 아니면 이유. */
function sessionsWritable() {
  const probe = path.join(sessionsDir(), `${hostName()}~${process.pid}~doctor.tmp`);
  try {
    mkdirSync(sessionsDir(), { recursive: true });
    writeFileSync(probe, '');
    rmSync(probe, { force: true });
    return null;
  } catch (err) {
    return err.code || err.message;
  }
}

// ------------------------------------------------------------------ 명령

/** 설정 파일이 없으면 만든다. 만들었으면 true. */
function ensureConfig(repo) {
  ensureIgnored(repo, ORCH_DIR);
  const file = path.join(repo, ORCH_DIR, 'config.json');
  if (existsSync(file)) return false;
  {
    const d = defaults();
    writeJson(file, {
      _notes: '여기 적은 값만 기본값을 덮어씁니다. 전체 기본값은 orchestrator.mjs 의 defaults() 참고. _ 로 시작하는 키는 무시됩니다.',
      claudeCommand: d.claudeCommand,
      amPluginRoot: '',
      pluginDir: '',
      skillMode: d.skillMode,
      branch: d.branch,
      parallel: d.parallel,
      worktreeSetup: [],
      requireGate: d.requireGate,
      orchestratorGate: d.orchestratorGate,
      maxFixRounds: d.maxFixRounds,
      maxSplitDepth: d.maxSplitDepth,
      onBlock: d.onBlock,
      taskLimits: d.taskLimits,
      requiredGateCommands: [],
      volatilePaths: [],
      model: {},
      effort: {},
      extraArgs: {},
    });
  }
  return true;
}

/** sessions: 이 PC 의 동시 세션 제한을 보여 주거나(인자 없음) 정한다(<N> 또는 default). 저장소와 상관없고 잠금도 잡지 않는다. */
function cmdSessions(arg) {
  const file = settingsFile();
  if (arg !== undefined) {
    if (arg !== 'default' && !(/^\d+$/.test(arg) && Number(arg) >= 1)) fail('사용법: sessions [<1 이상의 정수> | default]');
    const settings = readSettings() || {}; // 읽지 못하는 파일은 새로 쓴다
    if (arg === 'default') delete settings.maxSessions;
    else settings.maxSessions = Number(arg);
    try {
      writeJson(file, settings);
    } catch (err) {
      fail(`설정을 저장하지 못했습니다: ${file} (${err.code || err.message}). 이 폴더에 쓸 수 있게 하거나, 환경 변수 CLAUDE_CONFIG_DIR 로 쓸 수 있는 Claude 설정 폴더를 가리키세요.`);
    }
    say(arg === 'default' ? `기본값(${DEFAULT_MAX_SESSIONS}개)으로 되돌렸습니다.` : `바꿨습니다: 최대 ${arg}개.`);
    say('돌고 있는 실행에도 그다음 세션부터 적용됩니다.');
  }
  const cur = sessionSetting();
  say(`이 PC 에서 오케스트레이터가 동시에 돌리는 claude 세션: 최대 ${cur.max}개 (${SOURCE_KO[cur.source]}${cur.source === 'invalid' ? `: ${JSON.stringify(cur.raw)}` : ''})`);
  say(`설정 파일: ${file}`);
  const live = sessionsOnly(liveSessions({ clean: false }));
  say(`지금 도는 세션 ${live.length}개`);
  for (const s of live) say(`  - ${s.repo || '?'}  ${s.phase || '?'}${s.where ? `  ${s.where}` : ''}  (${s.startedAt || '?'} 시작, pid ${s.pid})`);
  if (arg === undefined) say('바꾸려면 `sessions <N>` (1 이상), 기본값으로 되돌리려면 `sessions default`');
}

function cmdInit(repo) {
  baseContext(repo);
  const file = `${ORCH_DIR}/config.json`;
  say(ensureConfig(repo) ? `만들었습니다: ${file}` : `이미 있습니다: ${file}`);
  say('다음: `doctor` 로 환경을 확인하세요.');
}

async function cmdDoctor(repo, opt) {
  baseContext(repo); // git 저장소인지부터 확인
  if (ensureConfig(repo)) say(`설정 파일을 만들었습니다: ${ORCH_DIR}/config.json (기본값 그대로)\n`);
  const ctx = baseContext(repo);
  let bad = 0;
  const ok = (m) => say(`  ✓ ${m}`);
  const warn = (m) => say(`  ! ${m}`);
  const no = (m) => {
    bad += 1;
    say(`  ✗ ${m}`);
  };
  say('환경 확인');
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 18) ok(`Node ${process.versions.node}`);
  else no(`Node ${process.versions.node}: 18 이상이 필요합니다`);
  if (git(repo, ['rev-parse', 'HEAD'], { allowFail: true }).code === 0) ok(`git 저장소, 현재 브랜치 ${git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).out}`);
  else no('커밋이 하나도 없는 저장소입니다. 첫 커밋을 만든 뒤 다시 실행하세요.');
  const stray = dirtyFiles(ctx);
  if (stray.length) warn(`커밋하지 않은 변경 ${stray.length}개: run 을 시작하기 전에 정리해야 합니다`);

  const [bin, ...pre] = ctx.cfg.claudeCommand;
  const v = await exec(bin, [...pre, '--version'], { cwd: repo, timeoutMs: 60000 });
  const version = v.code === 0 ? v.stdout.trim().split('\n')[0] : '';
  if (version) ok(`claude ${version}`);
  else no(`claude 를 실행하지 못했습니다 (${v.spawnError || v.stderr.trim() || `종료 코드 ${v.code}`}). config.json 의 claudeCommand 를 확인하세요.`);

  const env = { slash: false, pluginRoot: ctx.cfg.amPluginRoot || '' };
  let commands = null; // 비대화형 세션에 실려 온 슬래시 명령(시험 호출을 했을 때만)
  if (version && !opt['skip-probe']) {
    // 세션 시작 정보(system/init)로 am 플러그인과 스킬이 비대화형 실행에 실려 오는지 보고, 답이 실제로 오는지(로그인)도 본다
    const probe = async (pluginDir) => {
      const cfg = pluginDir ? { ...ctx.cfg, pluginDir } : ctx.cfg;
      const args = claudeArgs(cfg, 'probe', { prompt: 'Reply with the single word OK.', format: 'stream-json' });
      const r = await exec(bin, [...pre, ...args], { cwd: repo, timeoutMs: ctx.cfg.timeoutMin.probe * 60000 });
      const found = { init: null, result: null, r };
      for (const line of r.stdout.split('\n')) {
        try {
          const e = JSON.parse(line);
          if (e && e.type === 'system' && e.subtype === 'init' && !found.init) found.init = e;
          else if (e && e.type === 'result') found.result = e;
        } catch {
          /* JSON 이 아닌 줄은 건너뜀 */
        }
      }
      return found;
    };
    const amOf = (init) => (init.plugins || []).find((p) => p && p.name === 'am');
    let { init, result, r } = await probe('');
    if (init && !amOf(init) && !ctx.cfg.pluginDir) {
      // 세션에 am 이 없다(설치하지 않고 --plugin-dir 로 쓰는 경우 등). 곁에서 찾은 am 을 --plugin-dir 로 넘겨 다시 본다
      const near = env.pluginRoot || findSiblingAm() || findPluginInCache();
      if (near) {
        const again = await probe(near);
        if (again.init && amOf(again.init)) {
          ({ init, result, r } = again);
          env.pluginDirAuto = near;
          warn(`am 플러그인이 설치돼 있지 않아, 띄우는 세션마다 --plugin-dir 로 넘깁니다: ${near}`);
        }
      }
    }
    if (!init) no(`claude -p 시험 호출에서 세션 정보를 받지 못했습니다 (종료 코드 ${r.code}). ${(r.stderr || r.stdout).trim().slice(-300)}`);
    else {
      commands = (init.slash_commands || []).map((c) => String(c).replace(/^\//, ''));
      const plugin = amOf(init);
      for (const e of init.plugin_errors || []) warn(`플러그인 로드 오류: ${e.plugin || ''} ${e.message || ''}`);
      if (plugin?.path && env.pluginRoot && path.resolve(plugin.path) !== path.resolve(env.pluginRoot)) warn(`세션이 싣는 am 플러그인(${plugin.path})과 config.json 의 amPluginRoot(${env.pluginRoot})가 다릅니다. 게이트와 스킬 판별은 amPluginRoot 쪽을 씁니다.`);
      if (plugin?.path && !env.pluginRoot) env.pluginRoot = plugin.path;
      if (plugin) ok(`am 플러그인 로드됨: ${plugin.path}`);
      else warn('세션에 am 플러그인이 보이지 않습니다. 설치하거나 config.json 의 pluginDir 에 am 의 plugin/ 경로를 적으세요.');
      if (!result || result.is_error) no(`claude -p 시험 호출이 답을 받지 못했습니다: ${String(result?.result || (r.stderr || '').trim() || `종료 코드 ${r.code}`).slice(0, 200)}`);
    }
  } else if (opt['skip-probe']) {
    env.slash = ctx.cfg.skillMode === 'slash';
    warn('시험 호출을 건너뜀: 스킬이 실제로 실려 오는지는 확인하지 않았습니다');
  }
  if (!env.pluginRoot) env.pluginRoot = findSiblingAm() || findPluginInCache();
  const root = env.pluginRoot;
  const needed = BASE_SKILLS;
  env.skills = needed;
  if (commands) {
    const missing = needed.map((n) => `am:${n}`).filter((c) => !commands.includes(c));
    env.slash = missing.length === 0;
    if (env.slash) ok(`비대화형 실행에서 ${needed.map((n) => `/am:${n}`).join(', ')} 사용 가능`);
    else warn(`비대화형 실행에 없는 스킬: ${missing.join(', ')} → SKILL.md 를 직접 읽어 넘기는 방식(inline)으로 동작합니다`);
  }
  const absent = BASE_SKILLS.filter((n) => !hasSkill(root, n));
  if (root && existsSync(path.join(root, 'hooks', 'gate.mjs')) && !absent.length) ok(`am ${amVersion(root)} 플러그인 폴더: ${root}`);
  else if (root && existsSync(path.join(root, 'hooks', 'gate.mjs'))) no(`am 이 오래돼 ${absent.map((n) => `am:${n}`).join(', ')} 이 없습니다. am 을 업데이트하세요 (am ${amVersion(root)}: ${root})`);
  else no(`am 플러그인 폴더(hooks/gate.mjs, skills/*/SKILL.md)를 찾지 못했습니다${root ? `: ${root}` : ''}. config.json 의 amPluginRoot 에 am 저장소의 plugin/ 경로를 적으세요.`);

  if (String(process.env.AM_GATE || '').trim().toLowerCase() === 'off') no('환경 변수 AM_GATE=off 가 설정돼 있습니다. 게이트가 꺼진 채로는 무인 실행을 하지 않습니다.');
  const limit = sessionSetting();
  const unshared = sessionsWritable();
  env.sessionsShared = !unshared;
  const limitNote = `${SOURCE_KO[limit.source]}${limit.source === 'invalid' ? `: ${JSON.stringify(limit.raw)}` : ''}`;
  if (unshared) warn(`이 PC 의 동시 세션 제한 ${limit.max}개(${limitNote}): 기록 폴더에 쓸 수 없어(${unshared}) 다른 실행과 함께 세지 못합니다. 한 실행 안에서는 지킵니다: ${sessionsDir()}`);
  else if (limit.source === 'invalid' || limit.source === 'unreadable') warn(`이 PC 의 동시 세션 제한 ${limit.max}개(${limitNote}). \`sessions <N>\` 으로 다시 정하세요: ${settingsFile()}`);
  else ok(`이 PC 의 동시 세션 제한 ${limit.max}개(${limitNote}, 모든 실행을 합쳐 셈). 바꾸려면 \`sessions <N>\``);
  // 오케스트레이터 settings.json 의 minFreeMemoryMB 는 읽지 않는다: 잘못 적은 자리를 알려 준다
  const orchSettings = readSettings();
  if (orchSettings && Object.hasOwn(orchSettings, 'minFreeMemoryMB')) warn(`${settingsFile()} 의 minFreeMemoryMB(${JSON.stringify(orchSettings.minFreeMemoryMB)})는 쓰이지 않습니다. PC 전체 남은 메모리 기준은 ${userSettingsFile(process.env)} 의 minFreeMemoryMB 에 적으세요(저장소별 값은 .orchestrator/config.json).`);
  const parallel = Math.max(1, Math.floor(Number(ctx.cfg.parallel)) || 1);
  const key = worktreeKey(repo, ctx.cfg);
  if (!existsSync(path.join(repo, 'am-gate.json'))) {
    if (ctx.cfg.requireGate) no('am-gate.json 이 없습니다. 빌드·테스트 명령을 적어 저장소 루트에 두세요(또는 config.json 에서 requireGate: false).');
    else warn('am-gate.json 이 없습니다: 자동 빌드·테스트 확인 없이 진행됩니다');
    if (parallel > 1) env.worktree = { ok: true, key }; // 별도 작업 공간에서 확인할 게이트가 없다
  } else if (missingRequired(ctx).length) {
    no(`config.json 의 requiredGateCommands 에 적은 이름이 am-gate.json 에 없습니다: ${missingRequired(ctx).join(', ')}`);
  } else if (root && !opt['skip-gate']) {
    const cleanBefore = statusEntries(repo).length === 0;
    const report = await runGate({ ...ctx, pluginRoot: root }, null);
    const secs = ((report.durationMs || 0) / 1000).toFixed(1);
    if (report.status === 'pass') ok(`게이트 통과 (${secs}초, 명령 ${report.commands.length}개)`);
    else no(`게이트 ${report.status}: ${report.reason}. 시작 전에 게이트가 통과하는 상태여야 합니다.`);
    const blockingMs = (report.commands || []).filter((c) => c.blocking).reduce((n, c) => n + c.durationMs, 0);
    if (cleanBefore) {
      // 깨끗한 작업 트리에서 게이트만 돌렸으므로, 지금 바뀌어 있는 파일은 게이트(빌드)가 쓴 것이다
      const after = statusEntries(repo);
      const rewritten = after.filter((e) => MODIFIED.test(e.code)).map((e) => e.path);
      if (rewritten.length) git(repo, ['checkout', 'HEAD', '--', ...rewritten]);
      const undeclared = rewritten.filter((f) => !isVolatile(ctx, f));
      if (undeclared.length) warn(`게이트가 추적 중인 파일 ${undeclared.length}개를 다시 썼습니다(되돌려 둠): ${undeclared.join(', ')}\n    커밋 기록에 남기지 않으려면 config.json 의 volatilePaths 에 넣으세요. 넣지 않으면 그 변경이 작업의 커밋에 함께 들어갑니다.`);
      else if (rewritten.length) ok(`게이트가 다시 쓰는 파일 ${rewritten.length}개는 volatilePaths 로 처리됩니다`);
      const created = after.filter((e) => e.code === '??' && !isVolatile(ctx, e.path)).map((e) => e.path);
      if (created.length) warn(`게이트가 git 에서 제외되지 않은 파일을 만들었습니다: ${created.join(', ')}. .gitignore 에 넣으세요(그대로 두면 작업 시작이 막힙니다).`);
    }
    if (blockingMs > 600000) warn(`차단 명령 합계 ${(blockingMs / 1000).toFixed(0)}초: 커밋 한 번의 예산(840초)에 가깝습니다. 느린 명령은 "blocking": false 로`);
    if (report.status === 'pass' && parallel > 1) {
      const probe = await probeWorktree({ ...ctx, pluginRoot: root }, report);
      env.worktree = { ...probe, key };
      if (probe.ok) ok(`별도 작업 공간(git worktree)에서도 게이트 통과 (${(probe.ms / 1000).toFixed(1)}초): 서로 무관한 작업을 최대 ${Math.min(parallel, limit.max)}개까지 동시에 진행합니다${limit.max < parallel ? `(parallel ${parallel}, 이 PC 의 동시 세션 제한 ${limit.max})` : ''}`);
      else warn(`별도 작업 공간(git worktree)에서는 게이트가 통과하지 않아 작업을 하나씩 진행합니다: ${probe.reason}\n    git 에서 제외된 폴더(설치한 의존성 등)가 없어서라면 config.json 의 worktreeSetup 에 그것을 만드는 명령을 적고 doctor 를 다시 실행하세요. 동시 진행을 끄려면 parallel: 1`);
    }
  }
  if (opt['skip-gate'] && parallel > 1 && !env.worktree) {
    env.worktree = { ok: false, key, reason: 'doctor --skip-gate 로 확인을 건너뜀' };
    warn('게이트 확인을 건너뛰어 별도 작업 공간에서 게이트가 되는지 모릅니다: 작업을 하나씩 진행합니다');
  }
  env.ok = bad === 0; // 문제가 남아 있으면 status 가 다음 할 일을 다시 doctor 로 알려 준다
  writeJson(path.join(repo, ORCH_DIR, 'env.json'), env);
  const mode = ctx.cfg.skillMode === 'auto' ? (env.slash ? 'slash' : 'inline') : ctx.cfg.skillMode;
  say(`\n스킬 호출 방식: ${mode}`);
  if (bad) fail(`해결할 문제 ${bad}개가 있습니다.`);
  say('준비됐습니다. 다음: `split <설계문서>`');
}

/**
 * 별도 작업 공간에서도 게이트가 되는지 본다. git 에서 제외된 의존 폴더나 빌드 캐시(Unity 의 Library·.csproj 등)가 없어 실패하는 프로젝트가 있다.
 * 이 저장소에서 종료 코드 0 이던 명령이 모두 0 이어야 통과(게이트는 비차단 명령의 실패를 통과로 보므로 따로 본다).
 * 제한 시간은 max(2분, 이 저장소 게이트 시간의 3배)(최대 timeoutMin.gate): 캐시 없이 처음부터 빌드하느라 훨씬 오래 걸리면 동시 진행이 오히려 느리다.
 */
async function probeWorktree(ctx, mainReport) {
  const dir = path.join(ctx.root, WORKTREES, '_doctor');
  try {
    const { problem } = await addWorktree(ctx, dir);
    if (problem) return { ok: false, reason: problem };
    const minutes = Math.min(ctx.cfg.timeoutMin.gate, Math.max(2, ((mainReport.durationMs || 0) * 3) / 60000));
    const report = await runGate({ ...ctx, repo: dir, cfg: { ...ctx.cfg, timeoutMin: { ...ctx.cfg.timeoutMin, gate: minutes } } }, null);
    if (report.status !== 'pass') return { ok: false, reason: String(report.reason).includes('제한 시간') ? `게이트가 ${minutes.toFixed(1)}분 안에 끝나지 않았습니다(빌드 캐시 없이 처음부터 빌드하는 듯)` : `게이트 ${report.status}: ${report.reason}` };
    const passed = (name) => (report.commands || []).find((c) => c.name === name)?.exit === 0;
    const failed = (mainReport.commands || []).filter((c) => c.exit === 0 && !passed(c.name)).map((c) => c.name);
    if (failed.length) return { ok: false, reason: `이 저장소에서는 통과하는 명령이 실패함: ${failed.join(', ')}` };
    return { ok: true, ms: report.durationMs || 0 };
  } finally {
    removeWorktree(ctx.root, dir);
  }
}

/** requiredGateCommands 에 적은 이름이 am-gate.json 에 없으면 그 이름들을 돌려준다. */
function missingRequired(ctx) {
  const want = ctx.cfg.requiredGateCommands || [];
  if (!want.length) return [];
  const have = gateCommandNames(ctx.repo) || [];
  return want.filter((n) => !have.includes(n));
}

function requireReady(ctx) {
  if (!ctx.mode) fail('먼저 `doctor` 를 실행하세요(스킬 호출 방식을 정해야 합니다).');
  const needRoot = ctx.mode === 'inline' || ctx.cfg.orchestratorGate;
  if (needRoot && !(ctx.pluginRoot && existsSync(path.join(ctx.pluginRoot, 'hooks', 'gate.mjs')))) fail('am 플러그인 폴더를 찾지 못했습니다. `doctor` 를 실행하거나 config.json 의 amPluginRoot 를 적으세요.');
}

/** 새 실행의 이름: 지금 시각(YYYYMMDD-HHMM). */
function newRunId() {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
}

/** `current` 에 적힌 실행 이름. 없거나 읽지 못하면 빈 문자열. */
function currentRun(repo) {
  try {
    return readText(path.join(repo, ORCH_DIR, 'current')).trim();
  } catch {
    return '';
  }
}

async function cmdSplit(repo, designArg, opt) {
  if (!designArg) fail('사용법: split <설계문서 경로>');
  const design = path.resolve(designArg);
  if (!existsSync(design)) fail(`설계 문서를 찾지 못했습니다: ${design}`);
  const ctx = baseContext(repo);
  if (!ctx.env) fail('먼저 `doctor` 를 실행하세요.');
  ensureIgnored(repo, ORCH_DIR);
  ctx.runId = opt.run || newRunId();
  ctx.runDir = path.join(repo, ORCH_DIR, 'runs', ctx.runId);
  ctx.planFile = path.join(ctx.runDir, 'tasks.json');
  ctx.stateFile = path.join(ctx.runDir, 'state.json');
  if (existsSync(ctx.planFile)) fail(`이미 있는 실행입니다: ${ctx.runId}. 다른 이름을 --run 으로 주세요.`);
  mkdirSync(ctx.runDir, { recursive: true });
  const snapshot = path.join(ctx.runDir, 'design.md');
  copyFileSync(design, snapshot); // 작업을 뽑은 시점의 설계 문서를 고정해 둔다
  startEvents(ctx.runDir, { stage: 'split', text: 'split started' });
  const designName = design.startsWith(repo + path.sep) ? slashes(path.relative(repo, design)) : slashes(design);
  const dir = path.join(ctx.runDir, '_split');
  const out = rel(ctx, ctx.planFile);
  say(`설계 문서를 작업으로 나누는 중 (실행 ${ctx.runId})`);
  const r = await step(ctx, 'split', { dir, system: SYSTEM.split(ctx, rel(ctx, snapshot), out), prompt: `Split the design document ${rel(ctx, snapshot)} into tasks and write ${out}.` }, 'ORCH_STATUS', ['DONE']);
  let errs = [];
  for (let round = 0; ; round += 1) {
    try {
      ctx.plan = readJson(ctx.planFile);
      errs = validatePlan(ctx.plan);
    } catch (err) {
      errs = [`${out} could not be read as JSON: ${err.message}`];
    }
    if (!errs.length || round >= 2 || !r.sessionId) break;
    const errFile = path.join(dir, 'errors.txt');
    writeText(errFile, `${errs.join('\n')}\n`);
    say(`    작업 목록 형식 오류 ${errs.length}개: 고쳐 달라고 다시 요청`);
    await step(ctx, 'split', { dir, resume: r.sessionId, prompt: `tasks.json failed validation. Read ${rel(ctx, errFile)}, fix ${out}, and stop. End with exactly one line: ORCH_STATUS: DONE` }, 'ORCH_STATUS', ['DONE']);
  }
  if (errs.length) fail(`작업 목록이 형식 검사를 통과하지 못했습니다. ${out} 을 직접 고친 뒤 \`status\` 로 확인하세요.\n- ${errs.join('\n- ')}`);
  ctx.plan.design = designName;
  ctx.state = { runId: ctx.runId, createdAt: now(), tasks: {}, costs: ctx.costs };
  for (const t of ctx.plan.tasks) ctx.state.tasks[t.id] = newTaskState();
  savePlan(ctx);
  saveState(ctx);
  writeText(path.join(repo, ORCH_DIR, 'current'), `${ctx.runId}\n`);
  const open = (ctx.plan.decisions || []).filter((x) => !x.answer);
  say(`\n작업 ${ctx.plan.tasks.length}개로 나눴습니다. 검토: ${rel(ctx, path.join(ctx.runDir, 'tasks.md'))}`);
  if ((ctx.plan.uncovered || []).length) say(`작업에 넣지 않은 설계 부분 ${ctx.plan.uncovered.length}곳이 있습니다(같은 문서의 "설계 문서 대비" 참고).`);
  if (open.length) say(`사용자가 정해야 하는 것 ${open.length}개: ${open.map((x) => x.id).join(', ')} → \`decide <ID> "<답>"\``);
  say('작업 목록이 괜찮으면: `run`  (순서와 실제 호출 명령만 보려면 `run --dry-run`)');
  event({ ev: 'end', stage: 'split', status: 'done', text: `split into ${ctx.plan.tasks.length} tasks, ${open.length} open decisions`, min: minsSince() });
}

/**
 * 이 스크립트를 모는 쪽(사람이나 에이전트)이 다음에 할 일을 정할 수 있게 상태를 구조로 돌려준다.
 * next: doctor | split | wait | fix-tasks | decide | answer | blocked | run | done | stuck
 */
function statusData(repo, opt) {
  const base = baseContext(repo);
  const par = parallelOf(base);
  // 별도 작업 공간 확인이 없거나 낡았으면(stale) run 은 하나씩 돈다. next 는 바꾸지 않는다: 진행 중인 실행이 있을 때 doctor 로 돌려보내면 스킬이 새 실행을 만든다
  const data = { ready: Boolean(base.env) && base.env.ok !== false, running: null, run: null, next: 'doctor', parallel: { max: par.max, reason: par.reason, ...(par.stale ? { stale: true } : {}) }, sessions: { max: sessionLimit(), inUse: sessionsOnly(liveSessions({ clean: false })).length, shared: base.env?.sessionsShared ?? null }, errors: [], decisions: [], needsDecision: [], blocked: [], autoDecided: [], secondOpinions: [], costUsd: 0 };
  const current = path.join(repo, ORCH_DIR, 'current');
  const runId = opt.run || (existsSync(current) ? readText(current).trim() : '');
  let ctx = null;
  if (runId && existsSync(path.join(repo, ORCH_DIR, 'runs', runId, 'tasks.json'))) {
    try {
      ctx = openRun(repo, { run: runId });
      data.errors = validatePlan(ctx.plan);
    } catch (err) {
      data.errors = [`tasks.json could not be read: ${err.message}`];
    }
  }
  let runnable = false;
  let allDone = false;
  if (ctx && !data.errors.length) {
    const { plan, state } = ctx;
    const st = (t) => state.tasks[t.id];
    data.run = {
      id: ctx.runId,
      design: plan.design,
      branch: state.branch || null,
      total: plan.tasks.length,
      done: plan.tasks.filter((t) => st(t).status === 'done').length,
      report: rel(ctx, path.join(ctx.runDir, 'report.md')),
      tasks: rel(ctx, path.join(ctx.runDir, 'tasks.md')),
      tasksJson: rel(ctx, ctx.planFile),
    };
    data.decisions = (plan.decisions || [])
      .filter((d) => !d.answer && (!(d.blocks || []).length || d.blocks.some((id) => state.tasks[id]?.status !== 'done')))
      .map((d) => ({ id: d.id, what: d.what, whyNow: d.whyNow, options: d.options, recommended: d.recommended, undo: d.undo, blocks: d.blocks || [] }));
    data.needsDecision = plan.tasks.filter((t) => st(t).status === 'needs-decision').map((t) => ({ id: t.id, title: t.title, file: rel(ctx, path.join(taskDir(ctx, t), 'decision.md')) }));
    data.blocked = plan.tasks
      .filter((t) => st(t).status === 'blocked')
      .map((t) => ({ id: t.id, title: t.title, stage: st(t).blockedAt || null, reason: st(t).reason, hint: resumeHint(t, st(t).blockedAt, st(t)), logs: rel(ctx, taskDir(ctx, t)), workspace: st(t).worktree || null }));
    data.autoDecided = plan.tasks.flatMap((t) => autoDecided(ctx, t).map((l) => `${t.id}: ${l}`));
    data.secondOpinions = plan.tasks.flatMap((t) => secondOpinions(ctx, t).map((l) => `${t.id}: ${l}`));
    data.costUsd = Number(totalCost(ctx).toFixed(2));
    runnable = Boolean(nextTask(plan, state));
    allDone = data.run.done === data.run.total;
    const active = plan.tasks.filter((t) => st(t).running);
    if (active.length) data.active = { task: active[0].id, title: active[0].title, stage: st(active[0]).running, tasks: active.map((t) => ({ task: t.id, title: t.title, stage: st(t).running, workspace: st(t).worktree || null })) };
  }
  const lock = readLock(repo);
  if (lock) data.running = { pid: lock.pid, command: lock.command, startedAt: lock.startedAt, ...(data.active || {}) };
  delete data.active;
  if (lock) data.next = 'wait';
  else if (!data.ready) data.next = 'doctor';
  else if (data.errors.length) data.next = 'fix-tasks';
  else if (!ctx) data.next = 'split';
  else if (data.decisions.length) data.next = 'decide';
  else if (data.needsDecision.length) data.next = 'answer';
  else if (data.blocked.length) data.next = 'blocked';
  else if (runnable) data.next = 'run';
  else data.next = allDone ? 'done' : 'stuck';
  return data;
}

function cmdStatus(repo, opt) {
  if (opt.json) {
    say(JSON.stringify(statusData(repo, opt), null, 2));
    return;
  }
  const ctx = openRun(repo, opt);
  const errs = validatePlan(ctx.plan);
  say(`실행 ${ctx.runId}  |  설계 문서: ${ctx.plan.design}  |  브랜치: ${ctx.state.branch || '(아직 시작 안 함)'}`);
  for (const t of ctx.plan.tasks) {
    const s = ctx.state.tasks[t.id];
    const waits = s.status === 'pending' ? openDecisions(ctx.plan, t).map((d) => d.id) : [];
    const deps = t.dependsOn.filter((d) => ctx.state.tasks[d]?.status !== 'done');
    let label = statusLabel(s);
    if (waits.length) label = `결정 대기(${waits.join(',')})`;
    else if (s.status === 'pending' && deps.length) label = `대기(${deps.join(',')} 먼저)`;
    say(`  ${t.id.padEnd(7)} ${label.padEnd(16)} ${t.title}${s.status === 'blocked' ? `\n          사유: ${String(s.reason).split('\n')[0]}` : ''}`);
  }
  if (errs.length) say(`\n작업 목록 형식 오류:\n- ${errs.join('\n- ')}`);
  say(`\n보고서: ${rel(ctx, path.join(ctx.runDir, 'report.md'))}`);
}

function cmdDecide(repo, id, answer, opt) {
  const ctx = openRun(repo, opt);
  const d = (ctx.plan.decisions || []).find((x) => x.id === id);
  if (!d || !answer) fail(`사용법: decide <결정 ID> "<답>"  (결정 목록: ${(ctx.plan.decisions || []).map((x) => x.id).join(', ') || '없음'})`);
  d.answer = answer;
  savePlan(ctx);
  say(`${id} 의 답을 기록했습니다. 풀린 작업: ${(d.blocks || []).join(', ') || '-'}`);
}

async function cmdAnswer(repo, id, answer, opt) {
  const ctx = openRun(repo, opt);
  requireReady(ctx);
  const t = ctx.plan.tasks.find((x) => x.id === id);
  const s = t && ctx.state.tasks[id];
  if (!t || !answer || s.status !== 'needs-decision') fail('사용법: answer <작업 ID> "<답>"  (상태가 "결정 필요"인 작업에만 씁니다)');
  if (!s.sessions.plan) fail('이어 갈 계획 세션이 없습니다. `retry` 로 계획부터 다시 하세요.');
  startEvents(ctx.runDir, { stage: 'answer', task: id, text: 'answer started' });
  // 답은 파일로 넘긴다: 한글·따옴표가 명령줄을 거치지 않게
  appendFileSync(amPath(ctx, t, 'answers.md'), `\n## ${now()}\n${answer}\n`);
  const prompt = `The user answered the open decisions in ${AM_DIR}/${t.slug}/answers.md. Record the answers under Decisions in the plan, finish ${AM_DIR}/${t.slug}/plan.md, and do not implement. End with exactly one line: ORCH_STATUS: READY, ORCH_STATUS: NEEDS_DECISION or ORCH_STATUS: TOO_BIG`;
  let r;
  const stopWatch = watchOpinions(ctx, t, 'answer');
  try {
    r = await step(ctx, 'answer', { dir: taskDir(ctx, t), prompt, resume: s.sessions.plan }, 'ORCH_STATUS', ['READY', 'NEEDS_DECISION', 'TOO_BIG']);
  } finally {
    stopWatch();
  }
  if (r.mark === 'READY' && existsSync(amPath(ctx, t, 'plan.md'))) {
    Object.assign(s, { status: 'planned', baseSha: head(repo), reason: undefined, updatedAt: now() });
    say(`${id}: 계획이 완성됐습니다. \`run\` 으로 이어 가세요.`);
  } else if (r.mark === 'TOO_BIG') {
    splitTask(ctx, t, (reason) => {
      Object.assign(s, { status: 'blocked', reason, blockedAt: 'plan', updatedAt: now() });
      say(reason);
      event({ ev: 'alert', stage: 'plan', task: id, status: 'blocked', text: 'task blocked: could not split it' });
      return 'blocked';
    });
  } else {
    writeText(path.join(taskDir(ctx, t), 'decision.md'), r.text);
    say(`${id}: 아직 결정이 남았습니다. ${rel(ctx, path.join(taskDir(ctx, t), 'decision.md'))}`);
    event({ ev: 'alert', stage: 'plan', task: id, status: 'needs-decision', text: 'task needs a decision' });
  }
  saveState(ctx);
  writeReport(ctx);
  event({ ev: 'end', stage: 'answer', task: id, status: s.status, text: `answer ended: ${s.status}`, min: minsSince() }); // planned, split, blocked 또는 needs-decision
}

function cmdRetry(repo, id, opt) {
  const ctx = openRun(repo, opt);
  const t = ctx.plan.tasks.find((x) => x.id === id);
  if (!t) fail('사용법: retry <작업 ID> [--from plan|implement|check|commit]');
  const s = ctx.state.tasks[id];
  const from = opt.from || (existsSync(amPath(ctx, t, 'plan.md')) ? 'implement' : 'plan');
  const status = { plan: 'pending', implement: 'planned', check: 'implemented', commit: 'checked' }[from];
  if (!status) fail('--from 은 plan, implement, check, commit 중 하나입니다.');
  if (from !== 'plan' && !existsSync(amPath(ctx, t, 'plan.md'))) fail('계획 문서가 없어 계획부터 다시 해야 합니다: --from plan');
  let base = head(repo);
  let dropped = '';
  const dir = s.worktree && path.join(repo, s.worktree);
  if (dir && from !== 'plan') {
    if (existsSync(dir)) base = head(dir); // 별도 작업 공간에서 이어 간다(사라졌으면 run 이 구현부터 다시 한다)
  } else if (dir) {
    // 계획부터 다시 하면 구현도 새로 한다: 작업 공간의 변경은 patch 로 남기고 지운다
    if (existsSync(dir)) {
      git(dir, ['add', '-A'], { allowFail: true });
      const diff = git(dir, ['diff', '--cached', '--binary', s.wtBase || 'HEAD'], { allowFail: true }).out;
      if (diff) {
        dropped = path.join(taskDir(ctx, t), `worktree-${(s.attempts.plan || 0) + 1}.patch`);
        mkdirSync(path.dirname(dropped), { recursive: true });
        writeFileSync(dropped, `${diff}\n`);
      }
      removeWorktree(repo, dir);
    }
    Object.assign(s, { worktree: undefined, wtBase: undefined, needsGate: undefined, sessions: {} });
  }
  Object.assign(s, { status, fixRounds: 0, reason: undefined, blockedAt: undefined, baseSha: base, commitBase: undefined, updatedAt: now() });
  delete s.attempts.integrate; // 사람이 다시 시키면 합치기 충돌 때 다시 구현하는 한 번도 새로
  saveState(ctx);
  say(`${id}: ${from} 단계부터 다시 합니다. \`run\` 으로 진행하세요.${s.stash ? `\n보관해 둔 변경이 있습니다. 먼저 되살리세요: git stash list 에서 "${s.stash}"` : ''}${dropped ? `\n별도 작업 공간의 변경은 ${rel(ctx, dropped)} 에 남기고 지웠습니다.` : ''}`);
}

function cmdDone(repo, id, opt) {
  const ctx = openRun(repo, opt);
  const t = ctx.plan.tasks.find((x) => x.id === id);
  if (!t) fail('사용법: done <작업 ID>  (사람이 직접 고치고 커밋까지 끝낸 작업을 완료로 표시)');
  const s = ctx.state.tasks[id];
  if (s.worktree && existsSync(path.join(repo, s.worktree))) {
    // 별도 작업 공간에서 막힌 작업: 거기서 커밋까지 끝냈으면 다음 run 이 실행 브랜치에 합친다
    const w = inWorktree(ctx, path.join(repo, s.worktree));
    discard(w, taskDir(ctx, t), volatileDirty(w), '빌드 도구가 다시 쓴 파일(volatilePaths)');
    const dirtyW = dirtyFiles(w);
    if (dirtyW.length) fail(`별도 작업 공간 ${s.worktree} 에 커밋하지 않은 변경이 남아 있습니다. 그 폴더에서 커밋하거나 치운 뒤 다시 실행하세요.\n${firstTen(dirtyW)}`);
    if (head(w.repo) !== s.wtBase) {
      Object.assign(s, { status: 'committed', reason: undefined, blockedAt: undefined, commitBase: undefined, updatedAt: now() });
      s.notes.push('사람이 별도 작업 공간에서 직접 완료 처리함');
      saveState(ctx);
      writeReport(ctx);
      say(`${id}: 별도 작업 공간의 커밋을 다음 \`run\` 이 실행 브랜치에 합칩니다.`);
      return;
    }
    removeWorktree(repo, w.repo); // 커밋이 없다: 이 저장소에서 직접 끝낸 것으로 본다
    Object.assign(s, { worktree: undefined, wtBase: undefined, baseSha: undefined, commitBase: undefined });
  }
  discard(ctx, taskDir(ctx, t), volatileDirty(ctx), '빌드 도구가 다시 쓴 파일(volatilePaths)');
  const dirty = dirtyFiles(ctx);
  if (dirty.length) fail(`커밋하지 않은 변경이 남아 있습니다. 커밋하거나 치운 뒤 다시 실행하세요.\n${firstTen(dirty)}`);
  const base = s.commitBase || s.baseSha;
  const made = base ? commitsSince(repo, base) : [];
  Object.assign(s, { status: 'done', commits: [...new Set([...(s.commits || []), ...made])], commitBase: undefined, reason: undefined, blockedAt: undefined, updatedAt: now() });
  s.notes.push('사람이 직접 완료 처리함');
  saveState(ctx);
  writeReport(ctx);
  say(`${id}: 완료로 표시했습니다.`);
}

function dryRun(ctx) {
  const par = parallelOf(ctx);
  say(`실행 ${ctx.runId}: 스킬 호출 방식 ${modeLabel(ctx)}, 동시 진행 ${parLabel(par)}\n\n순서 (같은 회차의 작업은 함께 돎)`);
  const state = structuredClone(ctx.state);
  const order = [];
  for (let round = 1; ; round += 1) {
    const batch = startable(ctx.plan, state, [], par.max);
    if (!batch.length) break;
    for (const t of batch) {
      order.push(t);
      state.tasks[t.id].status = 'done';
      say(`  ${round}회차  ${t.id}  ${t.title}  (먼저: ${t.dependsOn.join(', ') || '-'})`);
    }
  }
  const rest = ctx.plan.tasks.filter((t) => !order.includes(t) && ctx.state.tasks[t.id].status !== 'done');
  for (const t of rest) say(`  ${t.id}  ${t.title}  → 지금은 못 함: ${openDecisions(ctx.plan, t).map((d) => `결정 ${d.id}`).join(', ') || STATUS_KO[ctx.state.tasks[t.id].status] || '의존 작업 대기'}`);
  const t = order[0];
  if (!t) return;
  const show = (name, prompt) => say(`\n[${name}]\n${[...ctx.cfg.claudeCommand, ...claudeArgs(ctx.cfg, name, { prompt, systemFile: `<${name}.system.md>`, amRoot: ctx.pluginRoot })].map((a) => (/^[\w\-./:=]+$/.test(a) ? a : `"${a}"`)).join(' ')}`);
  say(`\n첫 작업 ${t.id} 에서 실행할 명령 (inline 방식이면 프롬프트가 SKILL.md 를 채운 파일을 가리킵니다)`);
  show('plan', `/am:plan Plan task ${t.id} described in ${AM_DIR}/${t.slug}/brief.md (slug ${t.slug})`);
  show('implement', `/am:do ${t.slug}`);
  show('check', `/am:check ${t.slug}`);
  show('commit', `/am:commit task ${t.id} ${t.slug}`);
}

async function cmdRun(repo, opt) {
  const ctx = openRun(repo, opt);
  requireReady(ctx);
  const errs = validatePlan(ctx.plan);
  if (errs.length) fail(`작업 목록에 형식 오류가 있습니다:\n- ${errs.join('\n- ')}`);
  if (opt['dry-run']) return dryRun(ctx);
  const { cfg, state } = ctx;
  // 아래 검사에서 멈춰도 종료 처리가 끝 소식을 남기도록 먼저 시작을 알린다
  startEvents(ctx.runDir, { stage: 'run', text: `run started: ${ctx.plan.tasks.length} tasks` });
  if (String(process.env.AM_GATE || '').trim().toLowerCase() === 'off') fail('환경 변수 AM_GATE=off 가 설정돼 있습니다. 게이트가 꺼진 채로는 무인 실행을 하지 않습니다.');
  const missing = missingRequired(ctx);
  if (missing.length) fail(`config.json 의 requiredGateCommands 에 적은 이름이 am-gate.json 에 없습니다: ${missing.join(', ')}`);
  if (cfg.requireGate && !existsSync(path.join(repo, 'am-gate.json'))) fail('am-gate.json 이 없습니다. 무인 실행에는 빌드·테스트 게이트가 필요합니다(config.json 의 requireGate 로 끌 수 있음).');
  ensureIgnored(repo, ORCH_DIR);
  ensureIgnored(repo, AM_DIR); // am:plan 은 .am 이 이미 있으면 .gitignore 를 만들지 않으므로 여기서 챙긴다

  const current = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).out;
  if (!state.branch) {
    const name = cfg.branch ? cfg.branch.replace('{run}', ctx.runId) : current;
    if (name !== current) {
      if (dirtyFiles(ctx).length) fail('실행용 브랜치를 만들려면 작업 트리가 깨끗해야 합니다.');
      const exists = git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], { allowFail: true }).code === 0;
      git(repo, exists ? ['checkout', name] : ['checkout', '-b', name]);
    }
    state.branch = name;
    saveState(ctx);
  } else if (current !== state.branch) fail(`현재 브랜치(${current})가 이 실행의 브랜치(${state.branch})와 다릅니다. \`git checkout ${state.branch}\` 뒤에 다시 실행하세요.`);

  for (const x of Object.values(state.tasks)) delete x.running; // 지난 실행이 중단되며 남긴 표시
  onInterrupt = () => {
    for (const x of Object.values(state.tasks)) delete x.running;
    saveState(ctx);
    writeReport(ctx);
  };
  // par 는 이 PC 의 세션 제한을 넣지 않은 값: 로그 머리표는 이것을 따른다(실행 중 제한을 올리면 여러 작업의 로그가 섞이지 않게).
  // 함께 돌릴 수는 작업을 고를 때마다 제한을 다시 읽어 정한다.
  const par = opt.only ? { max: 1, reason: '' } : parallelism(cfg, ctx.env, worktreeKey(ctx.root, cfg));
  const shown = opt.only ? par : parallelOf(ctx);
  say(`실행 ${ctx.runId}  브랜치 ${state.branch}  am ${amVersion(ctx.pluginRoot)}  스킬 호출 방식 ${modeLabel(ctx)}  구현 스킬 am:do  동시 진행 ${parLabel(shown)}`);
  if (shown.reason) say(`  하나씩 진행하는 이유: ${shown.reason}`);
  const limit = Number(opt['max-tasks']) || Infinity;
  const active = new Map(); // 돌고 있는 작업 ID → 끝나면 { t, result, error } 를 내는 약속(reject 하지 않음)
  const errors = [];
  let finished = 0;
  let stopped = '';
  const launch = (t) => {
    // 작업마다 문맥을 따로 둔다: 로그 머리표와, 계획 뒤 작업 트리를 고르는 함수. 계획·상태는 원래 문맥의 것을 함께 쓴다
    const c = Object.assign(Object.create(ctx), { main: ctx, ...(par.max > 1 ? { tag: t.id } : {}) });
    c.workspace = (x) => chooseWorkspace(c, x, active);
    say(`\n▶ ${t.id} ${t.title}  [${STATUS_KO[state.tasks[t.id].status]}부터]`);
    event({ ev: 'step', task: t.id, status: state.tasks[t.id].status, text: 'task started' });
    const job = (async () => {
      await null; // 같은 회차에 띄우는 작업이 모두 active 에 들어간 뒤 시작한다(작업 트리를 고를 때 서로를 보도록)
      const result = await runTask(c, t);
      return result === 'committed' ? integrate(c, t) : result;
    })();
    active.set(t.id, job.then((result) => ({ t, result }), (error) => ({ t, error })));
  };
  const pick = () => {
    if (stopped || errors.length) return [];
    if (opt.only) {
      const t = ctx.plan.tasks.find((x) => x.id === opt.only);
      if (!t) fail(`작업이 없습니다: ${opt.only}`);
      const s = state.tasks[t.id].status;
      if (active.size || ['done', 'blocked', 'needs-decision', 'split'].includes(s)) return [];
      if (!canStart(ctx.plan, state, t)) fail(`${t.id} 는 아직 시작할 수 없습니다(의존 작업 또는 결정 대기).`);
      return [t];
    }
    return startable(ctx.plan, state, [...active.keys()], Math.min(par.max, sessionLimit(), limit - finished), { exclusive: dirtyFiles(ctx).length > 0 });
  };
  try {
    for (;;) {
      for (const t of pick()) launch(t);
      if (!active.size) break;
      // 하나가 끝나는 대로 결과를 정리하고, 그 사이 시작할 수 있게 된 작업을 띄운다
      const { t, result, error } = await Promise.race(active.values());
      active.delete(t.id);
      delete state.tasks[t.id].running;
      saveState(ctx);
      writeReport(ctx);
      if (error) {
        errors.push(error); // 새 작업은 시작하지 않고, 돌고 있는 작업은 끝까지 기다린다
        continue;
      }
      if (result === 'blocked') {
        const left = state.tasks[t.id].worktree ? [] : statusEntries(repo); // 별도 작업 공간의 변경은 그 폴더에 그대로 둔다
        if (cfg.onBlock === 'stash') {
          if (left.length) {
            const label = `am-orchestrator ${ctx.runId} ${t.id}`;
            git(repo, ['stash', 'push', '-u', '-m', label]);
            state.tasks[t.id].stash = label;
            saveState(ctx);
            say(`    변경을 stash 에 보관하고 다음 작업으로 넘어갑니다: ${label}`);
          }
        } else stopped ||= `${t.id} 에서 막혀 멈췄습니다.${active.size ? ' 돌고 있던 작업은 끝까지 진행했습니다.' : ''}`;
      }
      if (result === 'done' && (finished += 1) >= limit) stopped ||= `--max-tasks ${limit} 에 닿아 멈췄습니다.`;
    }
  } catch (err) {
    await Promise.all(active.values()); // 돌고 있는 세션이 혼자 파일을 고치지 않도록 끝날 때까지 기다린다
    for (const x of Object.values(state.tasks)) delete x.running;
    errors.push(err);
  }
  if (!Object.values(state.tasks).some((x) => x.worktree)) {
    try {
      rmSync(path.join(repo, WORKTREES, ctx.runId), { recursive: true, force: true, maxRetries: 3 }); // 지우다 남은 작업 공간 폴더
    } catch {
      /* 잡혀 있는 파일이 있으면 다음 실행에 맡긴다 */
    }
  }
  if (errors.length) {
    saveState(ctx);
    writeReport(ctx);
    const other = errors.find((e) => !(e instanceof PhaseError));
    if (other) throw other;
    fail(`${errors.map((e) => e.message).join('\n\n')}\n\n상태는 저장했습니다. 원인을 해결한 뒤 \`run\` 을 다시 실행하면 이 단계부터 이어 갑니다.`);
  }
  writeReport(ctx);
  const count = (st) => ctx.plan.tasks.filter((t) => state.tasks[t.id].status === st).length;
  const total = ctx.plan.tasks.length;
  const undecided = count('needs-decision') + ctx.plan.tasks.filter((t) => state.tasks[t.id].status === 'pending' && openDecisions(ctx.plan, t).length).length;
  say(`\n${stopped || (count('done') === total ? '모든 작업이 끝났습니다.' : '지금 진행할 수 있는 작업이 더 없습니다.')}`);
  say(`완료 ${count('done')} / ${total}, 막힘 ${count('blocked')}, 결정 필요 ${undecided}`);
  say(`보고서: ${rel(ctx, path.join(ctx.runDir, 'report.md'))}  (push 는 하지 않았습니다)`);
  event({ ev: 'end', stage: 'run', status: count('done') === total ? 'done' : 'stopped', text: `done ${count('done')} of ${total}, blocked ${count('blocked')}, needs decision ${undecided}`, min: minsSince() });
  if (count('done') !== total) process.exitCode = 1;
}

// ------------------------------------------------------------------ 진행 소식 기다리기

// am 의 대기 명령(plugin/scripts/progress.mjs)과 같은 규격이다: 같은 이벤트 줄에는 같은 출력을 낸다.
// am 과 따로 설치되므로 그 파일을 import 하지 않고 다시 쓴다. 시간 값은 모두 인자로 받는다.
export const PROGRESS_DEFAULTS = { batchMs: 30000, quietMs: 480000, startWaitMs: 60000, pollMs: 1000, maxLifeMs: 510000 };
const PROGRESS_EVENTS = ['start', 'step', 'note', 'alert', 'end'];
const PROGRESS_SHOWN = ['stage', 'task', 'status', 'min', 'src'];
const PROGRESS_ENDED = 'state: ended';
const PROGRESS_USAGE = 'usage: node orchestrator.mjs progress [--run <run>] [--consumer <name>]';
const oneLine = (v) => String(v).replace(/\s+/g, ' ').trim();

function parseProgressLine(line) {
  try {
    const e = JSON.parse(line);
    return isObj(e) && PROGRESS_EVENTS.includes(e.ev) && typeof e.text === 'string' ? e : null;
  } catch {
    return null;
  }
}

// 이벤트 파일을 한 번 읽는다: 줄바꿈으로 끝난 줄과 그 바이트 위치. 없는 파일은 빈 파일, 다른 읽기 오류는 null(이번 확인은 변화 없음)
function scanProgress(file) {
  let buf;
  try {
    buf = readFileSync(file);
  } catch (err) {
    if (!err || err.code !== 'ENOENT') return null;
    buf = Buffer.alloc(0);
  }
  const items = [];
  let pos = 0;
  for (let nl = buf.indexOf(10, pos); nl >= 0; nl = buf.indexOf(10, pos)) {
    const line = buf.toString('utf8', pos, nl).replace(/\r$/, '');
    const e = parseProgressLine(line);
    if (e) items.push({ event: e, pos, line });
    pos = nl + 1;
  }
  return { items, next: pos, size: buf.length };
}

// 커서부터의 줄. 커서보다 짧은 파일은 다시 쓰인 것이라 처음부터 읽는다
function unreadProgress(snap, offset) {
  const from = offset > snap.size ? 0 : offset;
  return { items: snap.items.filter((i) => i.pos >= from), next: Math.max(from, snap.next) };
}

/** 이벤트 하나의 출력 줄. pid 와 모르는 필드는 내지 않는다. */
function progressLine(e) {
  const fields = PROGRESS_SHOWN.filter((k) => e[k] !== undefined && e[k] !== null && oneLine(e[k]) !== '').map((k) => `${k}=${oneLine(e[k])}`);
  return `${e.ev}: ${oneLine(e.text)}${fields.length ? ` [${fields.join(' ')}]` : ''}`;
}

// 마지막 start 의 명령이 아직 돌고 있으면 그 start, 아니면 null: 뒤에 end 가 있거나 pid 가 양의 정수가 아니거나 죽었으면 끝난 것
function runningStart(events, alive) {
  const at = events.map((e) => e.ev).lastIndexOf('start');
  if (at < 0) return null;
  const start = events[at];
  const after = events.slice(at + 1);
  if (after.some((e) => e.ev === 'end')) return null;
  if (!Number.isInteger(start.pid) || start.pid <= 0 || !alive(start.pid)) return null;
  return { start, handover: after.some((e) => e.ev === 'note' && e.stage === 'handover') };
}

function progressState(running, nowMs) {
  if (!running) return PROGRESS_ENDED;
  const { start, handover } = running;
  const what = handover ? 'handover' : oneLine(typeof start.stage === 'string' && start.stage ? start.stage : start.text);
  const min = Math.max(0, Math.floor((nowMs() - Date.parse(start.t)) / 60000)) || 0;
  return `state: running (${what}, ${min} min)`;
}

function readCursor(file) {
  try {
    const text = readFileSync(file, 'utf8');
    return /^\d+$/.test(text) ? Number(text) : 0;
  } catch {
    return 0;
  }
}

function sizeOf(file) {
  try {
    return statSync(file).size;
  } catch (err) {
    return err && err.code === 'ENOENT' ? 0 : Infinity;
  }
}

// 커서를 임시 파일로 바꿔 넣는다. 뒤로 옮기지 않는다(이벤트 파일이 커서보다 짧아졌을 때만 예외)
function saveCursor(file, next, events) {
  const at = readCursor(file);
  if (at > next && at <= sizeOf(events)) return;
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, String(next));
    renameSync(tmp, file);
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* 같은 줄이 다음에 한 번 더 나온다 */
    }
  }
}

async function progressLoop(repo, o) {
  const began = o.now();
  let followed = ''; // 이 대기가 잠금으로 마지막에 고른 실행: 잠금이 사라진 뒤에도 그 실행의 end 를 읽는다
  // 따라갈 실행을 확인할 때마다 다시 고른다: --run → 살아 있는 잠금 → 따라가던 실행 → current
  const pick = () => {
    if (o.run) return { run: o.run, by: 'run' };
    const lock = readLock(repo, o.alive);
    if (lock && typeof lock.run === 'string' && lock.run) followed = lock.run;
    if (followed) return { run: followed, by: 'lock' };
    const run = currentRun(repo);
    return { run, by: run ? 'current' : 'none' };
  };
  // 확인 한 번: 고른 실행의 이벤트 파일을 한 번 읽어 읽지 않은 줄과 상태를 함께 얻는다. 실행이 없으면 빈 파일처럼 다룬다
  const look = () => {
    const { run, by } = pick();
    const dir = path.join(repo, ORCH_DIR, 'runs', run);
    const events = path.join(dir, 'progress.jsonl');
    const cursor = path.join(dir, `progress.${o.consumer}.cursor`);
    const snap = run ? scanProgress(events) : { items: [], next: 0, size: 0 };
    if (!snap) return null;
    const { items, next } = unreadProgress(snap, run ? readCursor(cursor) : 0);
    const last = snap.items.filter((i) => i.event.ev === 'start').pop();
    return { run, by, events, cursor, unread: items, next, running: runningStart(snap.items.map((i) => i.event), o.alive), lastStart: last ? `${last.pos}:${last.line}` : '' };
  };
  const emit = (snap, items) => {
    o.out.write([...items.map((i) => progressLine(i.event)), snap ? progressState(snap.running, o.now) : PROGRESS_ENDED].map((l) => `${l}\n`).join(''));
    if (items.length) saveCursor(snap.cursor, snap.next, snap.events);
    return 0;
  };
  const has = (snap, kinds) => snap.unread.some((i) => kinds.includes(i.event.ev));

  let good = null; // 파일을 읽을 수 있었던 마지막 확인
  let phase; // 읽기에 성공한 첫 확인 전에는 undefined, 그 뒤 'start'(새 start 를 기다림) 또는 'normal'
  const seen = new Map(); // 실행 이름 → 처음 본 마지막 start. 그 실행의 옛 start 를 새것으로 잘못 읽지 않게 한다
  let batchAt = null;
  for (;;) {
    const t = o.now();
    const snap = look();
    if (snap) {
      if (phase === 'normal' && good && good.run !== snap.run) batchAt = null;
      good = snap;
      if (phase !== 'normal') {
        // 잠금은 새 start 보다 먼저 잡히므로 잠금으로 처음 고른 실행은 기억만 한다. current 는 split 이 끝날 때만 바뀐다
        if (snap.running) phase = 'normal';
        else if (phase === 'start' && seen.has(snap.run) && snap.lastStart && snap.lastStart !== seen.get(snap.run)) phase = 'normal';
        else if (phase === 'start' && !seen.has(snap.run) && snap.by === 'current' && snap.lastStart) phase = 'normal';
        else {
          if (!seen.has(snap.run)) seen.set(snap.run, snap.lastStart);
          phase = 'start';
        }
      }
      if (phase === 'start') {
        if (t - began >= o.startWaitMs) return emit(snap, snap.unread);
      } else {
        if (!snap.running || has(snap, ['alert', 'end'])) return emit(snap, snap.unread);
        if (has(snap, ['step', 'start'])) {
          batchAt ??= t;
          if (t - batchAt >= o.batchMs) return emit(snap, snap.unread);
        } else {
          batchAt = null; // 같은 소비자의 다른 대기가 그 묶음을 가져갔다
        }
      }
    }
    if (t - began >= o.maxLifeMs) return emit(good, good && batchAt !== null ? good.unread : []);
    if (batchAt === null && t - began >= o.quietMs) return emit(good, []);
    const deadlines = [began + o.maxLifeMs];
    if (phase === 'start') deadlines.push(began + o.startWaitMs);
    if (batchAt !== null) deadlines.push(batchAt + o.batchMs);
    else deadlines.push(began + o.quietMs);
    const left = deadlines.map((d) => d - t).filter((ms) => ms > 0);
    await o.sleep(Math.min(o.pollMs, ...left));
  }
}

/**
 * 소비자가 아직 못 본 소식을 기다렸다가 상태 줄과 함께 내고 0 을 돌려준다(어떤 오류에도 던지지 않는다).
 * opts: run, consumer(기본 terminal), PROGRESS_DEFAULTS 의 값들, now, sleep(ms), alive(pid), out.
 */
export async function waitProgress(repo, opts = {}) {
  try {
    const given = Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined));
    return await progressLoop(repo, { ...PROGRESS_DEFAULTS, run: '', consumer: 'terminal', now: Date.now, sleep: (ms) => new Promise((res) => setTimeout(res, ms)), alive: pidAlive, out: process.stdout, ...given });
  } catch {
    return 0;
  }
}

/** progress 명령. 잘못 부르면 이유·사용법·`state: ended` 를 내고 종료 코드 1, 받아들인 대기는 무슨 일이 있어도 0. 저장소 검사와 잠금 없이 돈다. */
async function cmdProgress(repo, extra, opt) {
  const bad = (why) => {
    process.stdout.write(`${why}\n${PROGRESS_USAGE}\n${PROGRESS_ENDED}\n`);
    process.exitCode = 1;
  };
  const unknown = Object.keys(opt).find((k) => !['repo', 'run', 'consumer'].includes(k));
  if (unknown !== undefined) return bad(`unknown option: --${oneLine(unknown)}`);
  if (extra.length) return bad(`unexpected argument: ${oneLine(extra[0])}`);
  for (const k of ['repo', 'run', 'consumer']) if (k in opt && typeof opt[k] !== 'string') return bad(`--${k} needs a value`);
  const consumer = 'consumer' in opt ? opt.consumer : 'terminal';
  if (!/^[a-z0-9-]+$/.test(consumer)) return bad(`invalid consumer name: ${oneLine(consumer)}`);
  if ('run' in opt && (!opt.run.trim() || ['.', '..'].includes(opt.run) || /[\\/]/.test(opt.run))) return bad(`invalid run name: ${oneLine(opt.run)}`);
  try {
    await waitProgress(repo, { run: opt.run, consumer });
  } catch {
    /* 받아들인 대기는 부른 쪽을 실패시키지 않는다 */
  }
  return undefined;
}

// ------------------------------------------------------------------ 진입점

const USAGE = `am-orchestrator: 설계 문서를 작업으로 나누고 작업마다 am 의 plan → do → check → commit 을 돌립니다.

사용법: node orchestrator.mjs <명령> [--repo <대상 저장소>] [--run <실행 ID>]

  init                      대상 저장소에 .orchestrator/config.json 을 만듭니다(doctor 가 없으면 알아서 만듦)
  doctor [--skip-probe] [--skip-gate]
                            claude, am 플러그인, 스킬, 게이트를 확인합니다
  split <설계문서>           설계 문서를 작업 목록(tasks.json)으로 나눕니다
  status [--json]           작업별 상태를 봅니다. --json 은 다음에 할 일(next)과 답할 결정·막힌 작업을 구조로 냅니다
  progress [--consumer <이름>]
                            새 진행 소식을 기다렸다가 출력하고 끝납니다(최대 8분 30초). 다른 명령이 도는 중에도 됩니다
  decide <결정ID> "<답>"     작업 목록에 딸린 결정에 답합니다
  run [--dry-run] [--only <작업ID>] [--max-tasks N]
                            진행할 수 있는 작업을 돌립니다. 서로 무관한 작업은 동시에(중단된 곳부터 이어 감)
  answer <작업ID> "<답>"     계획 중에 나온 결정에 답하고 계획을 마무리합니다
  retry <작업ID> [--from plan|implement|check|commit]
                            막힌 작업을 지정한 단계부터 다시 하게 합니다
  done <작업ID>              사람이 직접 끝낸 작업을 완료로 표시합니다
  sessions [<N> | default]  이 PC 에서 모든 실행을 합쳐 동시에 돌릴 claude 세션 수를 보거나 바꿉니다(기본 ${DEFAULT_MAX_SESSIONS}). 저장소와 상관없음`;

const VALUE_FLAGS = new Set(['repo', 'run', 'only', 'max-tasks', 'from', 'consumer']);

export function parseArgs(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) pos.push(a);
    else if (VALUE_FLAGS.has(a.slice(2))) opt[a.slice(2)] = argv[(i += 1)];
    else opt[a.slice(2)] = true;
  }
  return { pos, opt };
}

async function main(argv, timing = WORKER_DEFAULTS) {
  const { pos, opt } = parseArgs(argv);
  const [cmd, a, ...rest] = pos;
  const repo = path.resolve(opt.repo || process.cwd());
  if (opt.worker && WORKER_COMMANDS.includes(cmd) && !(cmd === 'run' && opt['dry-run'])) startWorker(repo, cmd, argv, timing);
  // 상태를 바꾸는 명령은 한 번에 하나만: 실행 중에 다른 명령이 끼어들지 못하게 잠근다
  // dry-run 을 구현한 것은 run 뿐이라 그것만 잠금 없이 돈다(다른 명령은 --dry-run 을 붙여도 실제로 실행된다)
  if (['doctor', 'split', 'decide', 'answer', 'run', 'retry', 'done'].includes(cmd) && !(cmd === 'run' && opt['dry-run'])) {
    baseContext(repo);
    // 잠금에 실행 이름을 담는다: split 은 새 이름을 여기서 정해 넘기고, doctor 는 실행과 상관없다
    if (cmd === 'split') opt.run ||= newRunId();
    acquireLock(repo, cmd, cmd === 'doctor' ? '' : opt.run || currentRun(repo));
  }
  switch (cmd) {
    case 'init':
      return cmdInit(repo);
    case 'doctor':
      return cmdDoctor(repo, opt);
    case 'split':
      return cmdSplit(repo, a, opt);
    case 'status':
      return cmdStatus(repo, opt);
    case 'progress':
      return cmdProgress(repo, pos.slice(1), opt);
    case 'decide':
      return cmdDecide(repo, a, rest.join(' '), opt);
    case 'answer':
      return cmdAnswer(repo, a, rest.join(' '), opt);
    case 'run':
      return cmdRun(repo, opt);
    case 'retry':
      return cmdRetry(repo, a, opt);
    case 'done':
      return cmdDone(repo, a, opt);
    case 'sessions':
      return cmdSessions(a);
    default:
      say(USAGE);
      return undefined;
  }
}

// 실제 경로끼리 비교한다: import.meta.url 은 심볼릭 링크를 푼 경로, argv[1] 은 받은 그대로다(링크된 ~/.claude, macOS 의 /var → /private/var).
const isMain = () => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
};

/** 중단: 돌고 있던 세션을 그대로 두면 혼자 계속 파일을 고치므로 함께 끝낸다. 상태는 단계가 바뀔 때마다 저장돼 있어, 다시 run 하면 끊긴 단계부터 이어 간다. */
function interrupt(reason) {
  for (const child of activeChildren) killTree(child);
  if (onInterrupt) onInterrupt();
  if (worker) worker.error = reason;
  process.stderr.write('\n중단했습니다. 돌고 있던 세션도 끝냈습니다. 다시 `run` 하면 끊긴 단계부터 이어 갑니다.\n');
  process.exit(130);
}

/** 명령줄 진입점. 시간 값은 테스트가 짧게 넘길 수 있게 매개변수로 받는다. */
export async function cli(argv, timing = WORKER_DEFAULTS) {
  // Ctrl+C 나 종료 신호
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => interrupt(`${sig} 신호를 받았습니다`));
  try {
    await main(argv, timing);
  } catch (err) {
    if (worker) worker.error = err && err.message ? err.message : String(err);
    if (err instanceof Halt || err instanceof PhaseError) {
      process.stderr.write(`\n${err.message}\n`);
      process.exitCode = 2;
    } else {
      process.stderr.write(`${err && err.stack ? err.stack : err}\n`);
      process.exitCode = 3;
    }
  }
}

if (isMain()) cli(process.argv.slice(2));
