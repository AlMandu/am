// Run: node --test tests/sessions.test.mjs
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NEWS_MAX, collect, gitWorktrees, main, render, shortNews } from '../plugin/scripts/sessions.mjs';
import { hhmm } from '../plugin/scripts/stage.mjs';

const T0 = Date.parse('2026-10-08T00:00:00.000Z');
const LIVE = 4242;
const DEAD = 999;
const alive = (pid) => pid === LIVE;
const host = () => 'testhost';
const iso = (min) => new Date(T0 - min * 60000).toISOString();
const NONE = '지금 돌고 있는 am 세션이 없습니다.\n';

const bases = [];
after(() => {
  let first;
  for (const base of bases) {
    try {
      rmSync(base, { recursive: true, force: true, maxRetries: 5 });
    } catch (err) {
      first ??= err;
    }
  }
  if (first) throw first;
});

// A temporary PC: a working tree `repo`, a record folder `sessions`, and the options collect takes.
function makePc() {
  const base = mkdtempSync(path.join(tmpdir(), 'am-sessions-'));
  bases.push(base);
  const repo = path.join(base, 'repo');
  const sessions = path.join(base, 'sessions');
  mkdirSync(path.join(repo, '.am'), { recursive: true });
  mkdirSync(sessions, { recursive: true });
  const opts = { cwd: repo, now: () => T0, alive, host, worktrees: () => ({ root: repo, list: [] }), dir: sessions };
  return { base, repo, sessions, opts };
}

// A task folder: worker record (with its mtime minutes before T0), events, plan.md, compaction record.
function task(repo, slug, { worker = null, workerAgeMin = 0, events = [], plan = null, compact = false } = {}) {
  const dir = path.join(repo, '.am', slug);
  mkdirSync(dir, { recursive: true });
  if (worker) {
    const file = path.join(dir, 'stage-worker.json');
    writeFileSync(file, JSON.stringify({ push: false, fix: false, ...worker }));
    const at = new Date(T0 - workerAgeMin * 60000);
    utimesSync(file, at, at);
  }
  if (events.length) writeFileSync(path.join(dir, 'progress.jsonl'), events.map((e) => `${JSON.stringify(e)}\n`).join(''));
  if (plan !== null) writeFileSync(path.join(dir, 'plan.md'), plan);
  if (compact) writeFileSync(path.join(dir, 'compact-pending.json'), '{}');
  return dir;
}

// A record in the record folder, touched minutes before T0.
function record(sessions, name, data, ageMin = 0) {
  const file = path.join(sessions, name);
  writeFileSync(file, `${JSON.stringify(data)}\n`);
  const at = new Date(T0 - ageMin * 60000);
  utimesSync(file, at, at);
}

const report = (opts) => render(collect(opts), opts);

test('(a) a do stage: elapsed from its start, done steps, latest news; its .gate record adds no second line', () => {
  const { repo, sessions, opts } = makePc();
  const dir = task(repo, 't1', {
    worker: { pid: LIVE, t: T0 - 4 * 60000, stage: 'do' },
    events: [
      { t: iso(3), ev: 'start', text: 'stage do started', pid: LIVE, stage: 'do' },
      { t: iso(1), ev: 'step', text: 'tests running' },
    ],
    plan: '# p\n## Steps\n1. one (done)\n2. two (완료)\n3. three\n',
  });
  record(sessions, `testhost~${LIVE}~1.gate.json`, { pid: LIVE, host: 'test host', repo, phase: 'am:auto do', where: dir, startedAt: iso(4) });
  assert.equal(
    report(opts),
    `세션 보고 (${hhmm(T0)})\n${repo} (현재 작업 트리)\n  am:auto 작업 t1 — 구현 단계 세션, 3분째 · 2단계 완료 · 마지막 소식: tests running (1분 전)\n`,
  );
});

test('(b) a hand-over shows no done count and the run news; a fix run shows its role', () => {
  const { repo, opts } = makePc();
  task(repo, 'h1', {
    worker: { pid: LIVE, t: T0 - 10 * 60000, stage: 'do' },
    events: [
      { t: iso(9), ev: 'start', text: 'stage do started', pid: LIVE, stage: 'do' },
      { t: iso(9), ev: 'note', text: 'handed to the am-orchestrator run skill', stage: 'handover' },
      { t: iso(2), ev: 'step', text: 'implement started', src: 'run' },
    ],
    plan: '1. one (done)\n',
  });
  task(repo, 'f1', {
    worker: { pid: LIVE, t: T0 - 5 * 60000, stage: 'do', fix: true },
    events: [{ t: iso(5), ev: 'start', text: 'stage do started', pid: LIVE, stage: 'do' }],
  });
  const lines = report(opts).split('\n');
  assert.ok(lines.includes('  am:auto 작업 h1 — 인계 단계 세션, 9분째 · 마지막 소식: implement started (2분 전)'), lines.join('\n'));
  assert.ok(lines.includes('  am:auto 작업 f1 — 수정 단계 세션, 5분째 · 마지막 소식: stage do started (5분 전)'), lines.join('\n'));
});

test('(c) a worker with no start since its record waits; an am:auto .gate record with no worker has its own line', () => {
  const { repo, sessions, opts } = makePc();
  task(repo, 'w1', {
    worker: { pid: LIVE, t: T0 - 2 * 60000, stage: 'plan' },
    events: [{ t: iso(30), ev: 'start', text: 'stage plan started', pid: 7, stage: 'plan' }],
  });
  task(repo, 'w2', { worker: { pid: LIVE, t: T0 - 4 * 60000, stage: 'check' } });
  record(sessions, `testhost~${LIVE}~2.gate.json`, { pid: LIVE, repo, phase: 'am:auto check', where: path.join(repo, '.am', 'g1'), startedAt: iso(7) });
  const lines = report(opts).split('\n');
  assert.ok(lines.includes('  am:auto 작업 w1 — 계획 단계 대기 중, 2분째 · 마지막 소식: stage plan started (30분 전)'), lines.join('\n'));
  assert.ok(lines.includes('  am:auto 작업 w2 — 점검 단계 대기 중, 4분째'), lines.join('\n'));
  assert.ok(lines.includes('  am:auto 작업 g1 — 점검 단계 세션, 7분째'), lines.join('\n'));
});

test('(d) dead or stale workers and .gate records are left out', () => {
  const { repo, sessions, opts } = makePc();
  const start = (pid) => [{ t: iso(3), ev: 'start', text: 'stage do started', pid, stage: 'do' }];
  task(repo, 'dead', { worker: { pid: DEAD, t: T0 - 3 * 60000, stage: 'do' }, events: start(DEAD) });
  task(repo, 'stale', { worker: { pid: LIVE, t: T0 - 9 * 60000, stage: 'do' }, workerAgeMin: 6, events: start(LIVE) });
  record(sessions, `testhost~${DEAD}~1.gate.json`, { pid: DEAD, repo, phase: 'am:auto do', where: path.join(repo, '.am', 'g-dead'), startedAt: iso(3) });
  record(sessions, `testhost~${LIVE}~3.gate.json`, { pid: LIVE, repo, phase: 'am:auto do', where: path.join(repo, '.am', 'g-stale'), startedAt: iso(9) }, 6);
  assert.equal(report(opts), NONE);
});

test('(e) a compaction in progress shows the compaction role', () => {
  const { repo, opts } = makePc();
  task(repo, 'c1', {
    worker: { pid: LIVE, t: T0 - 1 * 60000, stage: 'do' },
    events: [{ t: iso(1), ev: 'start', text: 'stage do started', pid: LIVE, stage: 'do' }],
    plan: '1. one (done)\n',
    compact: true,
  });
  assert.match(report(opts), /^ {2}am:auto 작업 c1 — 압축 단계 세션, 1분째 · 마지막 소식: stage do started \(1분 전\)$/m);
});

test('(f) nothing running: exactly one line, also with no record folder', () => {
  const { base, opts } = makePc();
  assert.equal(report(opts), NONE);
  assert.equal(report({ ...opts, dir: path.join(base, 'missing') }), NONE);
});

test('(g) a live record of another host adds neither a line nor a working tree', () => {
  const { base, sessions, opts } = makePc();
  const other = path.join(base, 'other');
  mkdirSync(path.join(other, '.am'), { recursive: true });
  task(other, 'o1', { worker: { pid: LIVE, t: T0 - 60000, stage: 'do' }, events: [{ t: iso(1), ev: 'start', text: 's', pid: LIVE, stage: 'do' }] });
  record(sessions, `otherhost~${LIVE}~1.gate.json`, { pid: LIVE, repo: other, phase: 'am:auto do', where: path.join(other, '.am', 'o1'), startedAt: iso(1) });
  record(sessions, `otherhost~${LIVE}~2.json`, { pid: LIVE, repo: other, phase: 'implement' });
  const snap = collect(opts);
  assert.equal(snap.trees.length, 1);
  assert.equal(render(snap, opts), NONE);
});

// Every file under a folder: path, content and mtime.
function listing(root) {
  const out = [];
  const walk = (dir) => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) walk(p);
      else out.push(`${p}\t${statSync(p).mtimeMs}\t${readFileSync(p, 'utf8')}`);
    }
  };
  walk(root);
  return out.sort();
}

test('(h) read-only: collect, render and main change no file', () => {
  const { base, repo, sessions, opts } = makePc();
  const dir = task(repo, 'r1', {
    worker: { pid: LIVE, t: T0 - 4 * 60000, stage: 'do' },
    events: [{ t: iso(3), ev: 'start', text: 'stage do started', pid: LIVE, stage: 'do' }],
    plan: '1. one (done)\n',
    compact: true,
  });
  record(sessions, `testhost~${LIVE}~1.gate.json`, { pid: LIVE, repo, phase: 'am:auto do', where: dir, startedAt: iso(4) });
  record(sessions, `testhost~${DEAD}~1.gate.json`, { pid: DEAD, repo, phase: 'am:auto do', where: dir, startedAt: iso(4) });
  const before = listing(base);
  render(collect(opts), opts);
  let text = '';
  assert.equal(main([], { ...opts, out: { write: (s) => (text += s) } }), 0);
  assert.match(text, /r1 — 압축 단계 세션/);
  assert.deepEqual(listing(base), before);
});

test('working trees: one entry per folder however it is named, this one first', () => {
  const { base, repo, sessions, opts } = makePc();
  const other = path.join(base, 'other');
  mkdirSync(other);
  record(sessions, `testhost~${LIVE}~1.json`, { pid: LIVE, repo: realpathSync(repo), phase: 'implement' });
  const snap = collect({ ...opts, worktrees: () => ({ root: repo, list: [other, repo, `${repo}${path.sep}`] }) });
  assert.deepEqual(
    snap.trees.map((t) => [t.path, t.current]),
    [
      [repo, true],
      [other, false],
    ],
  );
});

test('a failing worktree lookup still reports the current folder', () => {
  const { repo, opts } = makePc();
  task(repo, 'x1', { worker: { pid: LIVE, t: T0 - 60000, stage: 'commit' }, events: [{ t: iso(1), ev: 'start', text: 's', pid: LIVE, stage: 'commit' }] });
  const throwing = () => {
    throw new Error('no git');
  };
  for (const worktrees of [throwing, () => ({}), () => null]) {
    assert.match(report({ ...opts, worktrees }), /^ {2}am:auto 작업 x1 — 커밋 단계 세션, 1분째/m);
  }
  const { root, list } = gitWorktrees(path.join(repo, '.am'));
  assert.equal(typeof root, 'string');
  assert.ok(Array.isArray(list));
});

test('long news is put on one line and cut', () => {
  assert.equal(shortNews('a  b\n c'), 'a b c');
  assert.equal(shortNews('x'.repeat(NEWS_MAX)), 'x'.repeat(NEWS_MAX));
  assert.equal(shortNews('x'.repeat(NEWS_MAX + 5)), `${'x'.repeat(NEWS_MAX)}…`);
  assert.equal(NEWS_MAX, 120);
});

test('any argument prints the usage line and returns 1', () => {
  let text = '';
  assert.equal(main(['x'], { out: { write: (s) => (text += s) } }), 1);
  assert.equal(text, 'usage: node sessions.mjs\n');
});
