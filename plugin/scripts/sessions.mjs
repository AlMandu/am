// am sessions report: which am:auto stage sessions run on this PC now, per working tree, printed once in Korean.
//   node sessions.mjs
// Read-only: it writes, removes and stops nothing. It reads
// - the working trees: this one (`git rev-parse --show-toplevel`, else the current folder), `git worktree list --porcelain`
//   and the `repo` of every live record of this host;
// - the record folder of memory-guard.mjs (<CLAUDE_CONFIG_DIR or ~/.claude>/am-orchestrator/sessions/): which records are
//   live, the name rule and the host are memory-guard.mjs's own (liveRecords, RECORD_NAME, recordHeld, hostName), and
//   only records named by this host are read; an am:auto `.gate` record (`phase`, `repo`, `where`, `startedAt`) with no
//   worker gives a line of its own, the other records only add their working tree;
// - per task folder .am/<slug>/ of each working tree: stage-worker.json (`pid`, `t`, `stage`, `fix`; live while its pid
//   is alive and it was touched within WORKER_STALE_MS), progress.jsonl (the last `start` since the record's `t`, a
//   `stage: "handover"` note, the last event as the latest news), compact-pending.json and the done marks of plan.md.
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
import { COMPACT_PENDING, WORKER_FILES, WORKER_STALE_MS, hhmm } from './stage.mjs';

const USAGE = 'usage: node sessions.mjs';
export const GIT_TIMEOUT_MS = 5000;
export const NEWS_MAX = 120;
const STAGES = ['plan', 'do', 'check', 'commit'];
const ROLE_NAMES = { plan: '계획', do: '구현', check: '점검', commit: '커밋', fix: '수정', compact: '압축', handover: '인계' };
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
  return { slug, role, waiting, startedAt, done, news: newsOf(lastEvent(events)) };
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
 * The snapshot of this PC: { trees: [{ path, current, tasks: [{ slug, role, waiting, startedAt, done, news }] }] },
 * this working tree first. Never throws on a read error.
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
      const tree = { path: p, current, tasks: [] };
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
    tree.tasks.push({ slug, role: m[1], waiting: false, startedAt: Date.parse(r.data.startedAt), done: doneOf(tree.path, slug, m[1]), news: newsOf(lastEvent(events)) });
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

/** The Korean report of a snapshot. */
export function render(snapshot, { now = Date.now } = {}) {
  const trees = (snapshot?.trees || []).filter((t) => t.tasks.length);
  if (!trees.length) return '지금 돌고 있는 am 세션이 없습니다.\n';
  const t = now();
  const lines = [`세션 보고 (${hhmm(t)})`];
  for (const tree of trees) {
    lines.push(`${tree.path}${tree.current ? ' (현재 작업 트리)' : ''}`);
    for (const task of tree.tasks) {
      const role = ROLE_NAMES[task.role] || task.role;
      let line = `  am:auto 작업 ${task.slug} — ${role} ${task.waiting ? '단계 대기 중' : '단계 세션'}, ${minutes(task.startedAt, t)}분째`;
      if (task.role === 'do' && Number.isInteger(task.done)) line += ` · ${task.done}단계 완료`;
      if (task.news) {
        line += ` · 마지막 소식: ${shortNews(task.news.text)}`;
        if (Number.isFinite(task.news.t)) line += ` (${minutes(task.news.t, t)}분 전)`;
      }
      lines.push(line);
    }
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
