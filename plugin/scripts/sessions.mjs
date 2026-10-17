// am sessions report: which am:auto stage sessions run on this PC now, per working tree, printed once in Korean.
//   node sessions.mjs
// Read-only: it writes, removes and stops nothing. It reads
// - the working trees: this one (`git rev-parse --show-toplevel`, else the current folder), `git worktree list --porcelain`
//   and the `repo` of every live record of this host;
// - the record folder of memory-guard.mjs (<CLAUDE_CONFIG_DIR or ~/.claude>/am-orchestrator/sessions/): which records are
//   live, the name rule and the host are memory-guard.mjs's own (liveRecords, RECORD_NAME, recordHeld, hostName), and
//   only records named by this host are read; an am:auto `.gate` record (`phase`, `repo`, `where`, `startedAt`) with no
//   worker gives a line of its own, the other records only add their working tree;
// - per task folder .am/<slug>/ of each working tree: stage-worker.json (`pid`, `t`, `stage`, `fix`, `solo`; live while its pid
//   is alive and it was touched within WORKER_STALE_MS), progress.jsonl (the last `start` since the record's `t`, a
//   `stage: "handover"` note, the last event as the latest news), compact-pending.json and the done marks of plan.md.
// - per working tree, the am-orchestrator files under .orchestrator/: lock.json (`pid`, `leaseMs`, `run`, `command`, its
//   mtime; live while its pid is alive and, when `leaseMs` is a number, it was touched within `leaseMs`, the
//   orchestrator's own rule; a dead lock's run files are not read, so a stale `running` shows nothing),
//   worker/worker.json (`owner` when its `pid` is the lock's), runs/<run>/state.json (`tasks.*.running`, `worktree`),
//   runs/<run>/tasks.json (`tasks[].id`, `title`) and runs/<run>/progress.jsonl (the last event, per `task` for a task).
//   The lock pid's session records (`phase`, `where` = `.orchestrator/runs/<run>/<id>`, `startedAt`) give a task's
//   session (or a split / answer session); with none, a running task is waiting for its stage. Its `.gate` records give
//   a gate (on the one running task whose folder, `worktree` or the tree, is the record's `where`, else a line of its
//   own) or a workspace setup line. A run whose `owner` is the pid of a live am:auto stage worker in any working tree
//   goes under that task as a hand-over, else straight under its working tree.
// A worker with no start since its record began is still waiting for its turn. Any read error skips that item.
// Reads no environment variable itself (the command line passes env); every time value, the pid check, the host,
// the record folder and the git call are function parameters. Exit codes: 0 report printed, 1 bad arguments.
// Node only, no dependencies.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { countDone } from '../hooks/handover.mjs';
import { hostName, liveRecords, sessionsDirOf } from './memory-guard.mjs';
import { pidAlive, readFrom } from './progress.mjs';
import { COMPACT_PENDING, STAGES, WORKER_FILES, WORKER_STALE_MS, hhmm } from './stage.mjs';

const USAGE = 'usage: node sessions.mjs';
export const GIT_TIMEOUT_MS = 5000;
export const NEWS_MAX = 120;
const ROLE_NAMES = { plan: '계획', do: '구현', check: '점검', commit: '커밋', fix: '수정', compact: '압축', handover: '인계', implement: '구현', split: '작업 나누기', answer: '답 반영' };
const WIN = process.platform === 'win32';

/** This working tree and the other working trees of its repository; a failed git call gives the current folder and no list. */
export function gitWorktrees(cwd) {
  const git = (args) => {
    try {
      const r = spawnSync('git', args, { cwd, timeout: GIT_TIMEOUT_MS, encoding: 'utf8', windowsHide: true });
      return r.status === 0 && !r.error ? r.stdout : null;
    } catch {
      return null;
    }
  };
  const top = git(['rev-parse', '--show-toplevel']);
  const root = top && top.trim() ? top.trim() : cwd;
  const listed = git(['worktree', 'list', '--porcelain']);
  const list = listed ? listed.split(/\r?\n/).filter((l) => l.startsWith('worktree ')).map((l) => l.slice('worktree '.length)) : [];
  return { root, list };
}

/** The key that tells two spellings of one folder apart from two folders. */
export function pathKey(p) {
  let out;
  try {
    out = realpathSync(p);
  } catch {
    out = path.resolve(p);
  }
  return WIN ? out.toLowerCase() : out;
}

const readJson = (file) => {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
};
const readText = (file) => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};
const lastEvent = (events) => (events.length ? events[events.length - 1] : null);
const newsOf = (event) => (event ? { text: event.text, t: Date.parse(event.t) } : null);
const doneOf = (tree, slug, role) => {
  if (role !== 'do') return null;
  const text = readText(path.join(tree, '.am', slug, 'plan.md'));
  return text === null ? null : countDone(text);
};

// The task of one live stage worker in a task folder, or null.
function workerTask(tree, slug, { now, alive }) {
  const dir = path.join(tree, '.am', slug);
  const file = path.join(dir, WORKER_FILES.record);
  let mtimeMs;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    return null;
  }
  const rec = readJson(file);
  if (!rec || !Number.isInteger(rec.pid) || rec.pid <= 0 || !alive(rec.pid)) return null;
  if (now() - mtimeMs > WORKER_STALE_MS) return null;
  const began = Number.isFinite(rec.t) ? rec.t : mtimeMs;
  const { events } = readFrom(path.join(dir, 'progress.jsonl'), 0);
  const at = events.findLastIndex((e) => e.ev === 'start' && Date.parse(e.t) >= began);
  const waiting = at < 0;
  const handover = !waiting && events.slice(at + 1).some((e) => e.ev === 'note' && e.stage === 'handover');
  let role = String(rec.stage ?? '');
  if (existsSync(path.join(dir, COMPACT_PENDING))) role = 'compact';
  else if (handover) role = 'handover';
  else if (rec.fix === true) role = 'fix';
  const startedAt = waiting ? began : Date.parse(events[at].t);
  const done = rec.stage === 'do' && !handover && !waiting ? doneOf(tree, slug, 'do') : null;
  return { slug, pid: rec.pid, role, waiting, startedAt, done, news: newsOf(lastEvent(events)), solo: typeof rec.solo === 'string' && rec.solo !== '' };
}

// Whether the task's stage-worker.json, live or not, names a solo owner: the task runs under am:auto-one.
const soloOf = (tree, slug) => {
  const solo = readJson(path.join(tree, '.am', slug, WORKER_FILES.record))?.solo;
  return typeof solo === 'string' && solo !== '';
};

// One folder name: no separator and no `..`.
const oneName = (s) => (typeof s === 'string' && s && !/[\\/]/.test(s) && !s.includes('..') ? s : null);

// The live am-orchestrator run of a working tree, or null: { run, command, owner, children }.
function orchestratorRun(tree, { now, alive, records }) {
  const orch = path.join(tree, '.orchestrator');
  const lockPath = path.join(orch, 'lock.json');
  let mtimeMs;
  try {
    mtimeMs = statSync(lockPath).mtimeMs;
  } catch {
    return null;
  }
  const lock = readJson(lockPath);
  if (!lock || !Number.isInteger(lock.pid) || lock.pid <= 0 || !alive(lock.pid)) return null;
  if (typeof lock.leaseMs === 'number' && Number.isFinite(lock.leaseMs) && now() - mtimeMs > lock.leaseMs) return null;
  const worker = readJson(path.join(orch, 'worker', 'worker.json'));
  const owner = worker && worker.pid === lock.pid && Number.isInteger(worker.owner) && worker.owner > 0 ? worker.owner : null;
  const run = oneName(lock.run);
  const command = typeof lock.command === 'string' && lock.command ? lock.command : null;
  const children = [];
  if (!run) return { run, command, owner, children };
  const runDir = path.join(orch, 'runs', run);
  const listed = readJson(path.join(runDir, 'tasks.json'));
  const tasks = Array.isArray(listed?.tasks) ? listed.tasks.filter((t) => t && typeof t.id === 'string' && t.id) : [];
  const state = readJson(path.join(runDir, 'state.json'));
  const states = state && state.tasks && typeof state.tasks === 'object' ? state.tasks : {};
  const { events } = readFrom(path.join(runDir, 'progress.jsonl'), 0);
  const mine = records.filter((r) => r.pid === lock.pid);
  // Session records of this run by task ID (the latest start wins); a split session has its own child.
  const prefix = `.orchestrator/runs/${run}/`;
  const byId = new Map();
  let split = null;
  for (const r of mine) {
    if (r.gate || typeof r.data.where !== 'string') continue;
    const where = r.data.where.replace(/\\/g, '/');
    const id = where.startsWith(prefix) ? where.slice(prefix.length) : '';
    if (!id || id.includes('/')) continue;
    const at = Date.parse(r.data.startedAt);
    if (r.data.phase === 'split') {
      if (!split || at > split.startedAt) split = { kind: 'split', startedAt: at, news: newsOf(lastEvent(events)) };
    } else if (!byId.has(id) || at > byId.get(id).startedAt) byId.set(id, { phase: String(r.data.phase ?? ''), startedAt: at });
  }
  if (split) children.push(split);
  const working = [];
  for (const t of tasks) {
    const running = typeof states[t.id]?.running === 'string' && states[t.id].running ? states[t.id].running : null;
    const rec = byId.get(t.id);
    if (!running && rec?.phase !== 'answer') continue;
    const child = {
      kind: 'task',
      id: t.id,
      title: typeof t.title === 'string' ? t.title : '',
      role: rec ? rec.phase || running : running,
      waiting: !rec,
      startedAt: rec ? rec.startedAt : null,
      news: newsOf(lastEvent(events.filter((e) => e.task === t.id))),
    };
    children.push(child);
    if (running) working.push({ child, key: pathKey(path.resolve(tree, typeof states[t.id].worktree === 'string' ? states[t.id].worktree : '.')) });
  }
  // A gate goes on the one running task that builds in its folder, else on a line of its own; a workspace setup always has its own.
  for (const r of mine) {
    if (!r.gate) continue;
    const phase = r.data.phase;
    const at = Date.parse(r.data.startedAt);
    if (phase === 'gate') {
      const key = typeof r.data.where === 'string' ? pathKey(r.data.where) : null;
      const hits = key ? working.filter((w) => w.key === key) : [];
      if (hits.length === 1) hits[0].child.gateAt = at;
      else children.push({ kind: 'gate', startedAt: at });
    } else if (phase === 'worktreeSetup') children.push({ kind: 'worktreeSetup', startedAt: at });
  }
  return { run, command, owner, children };
}

// The task folders of a working tree: folders under .am/ whose names do not start with a dot.
function taskFolders(tree) {
  try {
    return readdirSync(path.join(tree, '.am'), { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * The snapshot of this PC: { trees: [{ path, current, tasks: [{ slug, pid, role, waiting, startedAt, done, news, solo, run }],
 * runs: [run] }] }, this working tree first; a run is { run, command, children }. Never throws on a read error.
 */
export function collect({ cwd = process.cwd(), env = {}, now = Date.now, alive = pidAlive, host = hostName, worktrees = gitWorktrees, dir = sessionsDirOf(env) } = {}) {
  let wt;
  try {
    wt = worktrees(cwd) || {};
  } catch {
    wt = {};
  }
  const root = typeof wt.root === 'string' && wt.root ? wt.root : cwd;
  const myHost = host();
  const records = [];
  for (const r of liveRecords(dir, { now: now(), alive, myHost, young: false })) {
    if (r.host !== myHost) continue;
    const data = readJson(r.file);
    if (data) records.push({ ...r, data });
  }
  const trees = [];
  const byKey = new Map();
  const addTree = (p, current = false) => {
    if (typeof p !== 'string' || !p) return null;
    const key = pathKey(p);
    if (!byKey.has(key)) {
      const tree = { path: p, current, tasks: [], runs: [] };
      byKey.set(key, tree);
      trees.push(tree);
    }
    return byKey.get(key);
  };
  addTree(root, true);
  for (const p of Array.isArray(wt.list) ? wt.list : []) addTree(p);
  for (const r of records) addTree(r.data.repo);

  for (const tree of trees) {
    for (const slug of taskFolders(tree.path)) {
      const task = workerTask(tree.path, slug, { now, alive });
      if (task) tree.tasks.push(task);
    }
  }
  // An am:auto stage whose worker is not seen (no record, or one gone stale) still holds its `.gate` record.
  for (const r of records) {
    const m = r.gate ? /^am:auto (\S+)$/.exec(String(r.data.phase ?? '')) : null;
    if (!m || !STAGES.includes(m[1]) || typeof r.data.where !== 'string') continue;
    const tree = addTree(r.data.repo);
    const slug = path.basename(r.data.where);
    if (!tree || !slug || tree.tasks.some((t) => t.slug === slug)) continue;
    const { events } = readFrom(path.join(tree.path, '.am', slug, 'progress.jsonl'), 0);
    tree.tasks.push({ slug, role: m[1], waiting: false, startedAt: Date.parse(r.data.startedAt), done: doneOf(tree.path, slug, m[1]), news: newsOf(lastEvent(events)), solo: soloOf(tree.path, slug) });
  }
  // A live orchestrator run goes under the am:auto task whose stage worker handed it over, else under its working tree.
  const runs = [];
  for (const tree of trees) {
    const run = orchestratorRun(tree.path, { now, alive, records });
    if (run) runs.push({ tree, run });
  }
  for (const { tree, run } of runs) {
    const { owner, ...shown } = run;
    const task = owner === null ? null : trees.flatMap((t) => t.tasks).find((t) => t.pid === owner);
    if (task) task.run = shown;
    else tree.runs.push(shown);
  }
  return { trees };
}

const minutes = (from, to) => Math.max(0, Math.floor((to - from) / 60000)) || 0;

/** News text on one line, cut at NEWS_MAX characters. */
export function shortNews(text) {
  const one = String(text).replace(/\s+/g, ' ').trim();
  const chars = [...one];
  return chars.length > NEWS_MAX ? `${chars.slice(0, NEWS_MAX).join('')}…` : one;
}

const newsText = (news, t) => (news ? ` · 마지막 소식: ${shortNews(news.text)}${Number.isFinite(news.t) ? ` (${minutes(news.t, t)}분 전)` : ''}` : '');

// The head of an orchestrator run line, with no indent.
function runHead(run) {
  const name = run.run ? `am-orchestrator 실행 ${run.run}` : run.command ? `am-orchestrator ${run.command} 명령` : 'am-orchestrator 실행';
  return `${name}${run.children.length ? '' : ' · 다음 작업 준비 중'}`;
}

// The lines under an orchestrator run.
function runLines(run, indent, t) {
  return run.children.map((c) => {
    if (c.kind === 'split') return `${indent}작업 나누기 세션, ${minutes(c.startedAt, t)}분째${newsText(c.news, t)}`;
    if (c.kind === 'gate') return `${indent}게이트 확인 중, ${minutes(c.startedAt, t)}분째`;
    if (c.kind === 'worktreeSetup') return `${indent}작업 공간 준비 중, ${minutes(c.startedAt, t)}분째`;
    const role = ROLE_NAMES[c.role] || c.role;
    let what;
    if (Number.isFinite(c.gateAt)) what = `게이트 확인 중, ${minutes(c.gateAt, t)}분째`;
    else if (c.waiting) what = `${role} 단계 대기 중`;
    else what = `${role} 세션, ${minutes(c.startedAt, t)}분째`;
    return `${indent}${c.id}${c.title ? ` ${c.title}` : ''} — ${what}${newsText(c.news, t)}`;
  });
}

/** The Korean report of a snapshot. */
export function render(snapshot, { now = Date.now } = {}) {
  const trees = (snapshot?.trees || []).filter((t) => t.tasks.length || t.runs?.length);
  if (!trees.length) return '지금 돌고 있는 am 세션이 없습니다.\n';
  const t = now();
  const lines = [`세션 보고 (${hhmm(t)})`];
  for (const tree of trees) {
    lines.push(`${tree.path}${tree.current ? ' (현재 작업 트리)' : ''}`);
    for (const task of tree.tasks) {
      const role = ROLE_NAMES[task.role] || task.role;
      let line = `  ${task.solo ? 'am:auto-one' : 'am:auto-multi'} 작업 ${task.slug} — ${role} ${task.waiting ? '단계 대기 중' : '단계 세션'}, ${minutes(task.startedAt, t)}분째`;
      if (task.role === 'do' && Number.isInteger(task.done)) line += ` · ${task.done}단계 완료`;
      lines.push(line + newsText(task.news, t));
      if (task.run) lines.push(`    └ 인계: ${runHead(task.run)}`, ...runLines(task.run, '      ', t));
    }
    for (const run of tree.runs || []) lines.push(`  ${runHead(run)}`, ...runLines(run, '    ', t));
  }
  return `${lines.join('\n')}\n`;
}

/** The command line. Returns the exit code: 1 for any argument, else 0. */
export function main(argv, { out = process.stdout, ...opts } = {}) {
  if (argv.length) {
    out.write(`${USAGE}\n`);
    return 1;
  }
  out.write(render(collect(opts), opts));
  return 0;
}

// Compare real paths: import.meta.url has symlinks resolved, argv[1] does not.
const isMain = () => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
};

if (isMain()) {
  process.exitCode = main(process.argv.slice(2), { cwd: process.cwd(), env: process.env });
}
