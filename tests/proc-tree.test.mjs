// Run: node --test tests/proc-tree.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FIRST_LIST_MS, LIST_EVERY_MS, WIN_LIST_ARGS, collect, createTracker, parsePsList, parseWinList, pickTargets,
} from '../auto/scripts/proc-tree.mjs';

const MB = 1048576;
const START = 1000;
const ROOT = 100;
// A Windows list entry (created in ms, ws in MB)
const W = (pid, ppid, created, mb = 1) => ({ pid, ppid, created, ws: mb * MB });
// A POSIX list entry
const P = (pid, ppid, pgid, mb = 1) => ({ pid, ppid, pgid, ws: mb * MB });
const flush = () => new Promise((r) => setImmediate(r));

function fakeTimers() {
  const t = { timeouts: [], intervals: [], cleared: [] };
  const handle = (kind, fn, ms) => {
    const h = { kind, fn, ms, unrefs: 0, unref() { this.unrefs += 1; return this; } };
    t[kind].push(h);
    return h;
  };
  t.api = {
    setTimeout: (fn, ms) => handle('timeouts', fn, ms),
    setInterval: (fn, ms) => handle('intervals', fn, ms),
    clearTimeout: (h) => t.cleared.push(h),
    clearInterval: (h) => t.cleared.push(h),
  };
  return t;
}

/** A Windows tracker fed by `lists` in turn (an entry may be null or a function); `step(at)` fires the next list. */
function winTracker(lists, { kill, startedAt = START } = {}) {
  const clock = { t: startedAt };
  const kills = [];
  const queue = [...lists];
  const timers = fakeTimers();
  const tracker = createTracker({
    pid: ROOT, startedAt, platform: 'win32', now: () => clock.t, timers: timers.api,
    list: async () => {
      const next = queue.shift();
      return typeof next === 'function' ? next() : next;
    },
    kill: kill || (async (pid, opts) => {
      kills.push({ pid, tree: opts.tree });
      return true;
    }),
  });
  tracker.start();
  let fired = 0;
  const step = async (at) => {
    clock.t = at;
    if (fired++ === 0) timers.timeouts[0].fn();
    else timers.intervals[0].fn();
    await flush();
  };
  const finish = async (at, opts) => {
    clock.t = at;
    return tracker.finish(opts);
  };
  return { tracker, kills, step, finish, timers, clock };
}

test('an orphan beyond an ended middle parent is found and stopped', async () => {
  const r = winTracker([
    [W(ROOT, 1, 1001), W(200, ROOT, 1002), W(300, 200, 1003, 50), W(50, 1, 10)],
    [W(300, 200, 1003, 50), W(50, 1, 10)],
  ]);
  await r.step(2000);
  const res = await r.finish(5000);
  assert.deepEqual(r.kills, [{ pid: 300, tree: true }]);
  assert.deepEqual(res, { count: 1, workingSetMB: 50 });
});

test('a reused pid is not stopped and not linked through', async () => {
  // N's pid now belongs to a process with another creation time
  let r = winTracker([[W(ROOT, 1, 1001), W(200, ROOT, 1002), W(300, 200, 1003)], [W(300, 1, 4000)]]);
  await r.step(2000);
  assert.deepEqual(await r.finish(5000), { count: 0, workingSetMB: 0 });
  assert.deepEqual(r.kills, []);
  // The recorded parent C's pid is alive with another creation time, and X sits under it
  r = winTracker([[W(ROOT, 1, 1001), W(200, ROOT, 1002)], [W(200, 1, 3000), W(400, 200, 3500)]]);
  await r.step(2000);
  await r.finish(5000);
  assert.deepEqual(r.kills, []);
  // A child created before its parent
  r = winTracker([[W(ROOT, 1, 1001), W(200, ROOT, 1500), W(500, 200, 1200)], [W(500, 200, 1200)]]);
  await r.step(2000);
  await r.finish(5000);
  assert.deepEqual(r.kills, []);
});

test('a reused root pid is a stranger at finish; an orphan of the ended root is stopped', async () => {
  let r = winTracker([[W(ROOT, 1, 4000), W(400, ROOT, 4500)]]);
  await r.finish(5000);
  assert.deepEqual(r.kills, []);
  r = winTracker([[W(600, ROOT, 2000, 3)]]);
  assert.deepEqual(await r.finish(5000), { count: 1, workingSetMB: 3 });
  assert.deepEqual(r.kills, [{ pid: 600, tree: true }]);
  // Created after finish was called: not the session's
  r = winTracker([[W(600, ROOT, 6000)]]);
  await r.finish(5000);
  assert.deepEqual(r.kills, []);
});

test('a gone record links only children created before it went', async () => {
  let r = winTracker([[W(ROOT, 1, 1001), W(200, ROOT, 1500)], [W(ROOT, 1, 1001)], [W(400, 200, 3500)]]);
  await r.step(2000);
  await r.step(3000);
  await r.finish(5000);
  assert.deepEqual(r.kills, []);
  r = winTracker([[W(ROOT, 1, 1001), W(200, ROOT, 1500)], [W(ROOT, 1, 1001), W(400, 200, 2500)], [W(400, 200, 2500)]]);
  await r.step(2000);
  await r.step(3000);
  await r.finish(5000);
  assert.deepEqual(r.kills, [{ pid: 400, tree: true }]);
});

test('a process older than the session is ignored even under the root', async () => {
  const r = winTracker([[W(ROOT, 1, 1001), W(600, ROOT, 900)], [W(600, ROOT, 900)]]);
  await r.step(2000);
  await r.finish(5000);
  assert.deepEqual(r.kills, []);
});

test('a rejecting kill or a throwing list never rejects finish and counts nothing', async () => {
  let r = winTracker([[W(600, ROOT, 2000)]], { kill: async () => { throw new Error('boom'); } });
  assert.deepEqual(await r.finish(5000), { count: 0, workingSetMB: 0 });
  r = winTracker([() => { throw new Error('boom'); }]);
  assert.deepEqual(await r.finish(5000), { count: 0, workingSetMB: 0 });
  r = winTracker([[W(600, ROOT, 2000), W(700, ROOT, 2000)]], { kill: async (pid) => pid === 700 });
  assert.deepEqual(await r.finish(5000), { count: 1, workingSetMB: 1 });
});

test('timers: 30 s first, then every 60 s, unref, one start only, cleared by finish', async () => {
  let r = winTracker([[], []]);
  assert.equal(r.timers.timeouts.length, 1);
  assert.equal(r.timers.timeouts[0].ms, FIRST_LIST_MS);
  assert.equal(FIRST_LIST_MS, 30000);
  assert.equal(r.timers.timeouts[0].unrefs, 1);
  r.tracker.start();
  assert.equal(r.timers.timeouts.length, 1);
  await r.step(2000);
  assert.equal(r.timers.intervals.length, 1);
  assert.equal(r.timers.intervals[0].ms, LIST_EVERY_MS);
  assert.equal(LIST_EVERY_MS, 60000);
  assert.equal(r.timers.intervals[0].unrefs, 1);
  await r.finish(5000);
  assert.ok(r.timers.cleared.includes(r.timers.intervals[0]));
  r.tracker.start();
  assert.equal(r.timers.timeouts.length, 1);
  // Finish before the first list clears the first timer
  r = winTracker([[]]);
  await r.finish(5000);
  assert.ok(r.timers.cleared.includes(r.timers.timeouts[0]));
  r.tracker.start();
  assert.equal(r.timers.timeouts.length, 1);
  assert.equal(r.timers.intervals.length, 0);
  // Not on POSIX
  const t = fakeTimers();
  createTracker({ pid: ROOT, platform: 'darwin', timers: t.api, list: async () => null }).start();
  assert.equal(t.timeouts.length + t.intervals.length, 0);
});

test('an excluded pid and its descendants live; its ancestors are stopped without /T', async () => {
  const snap = [W(200, ROOT, 1100), W(300, 200, 1200), W(400, 300, 1300), W(500, 400, 1400), W(50, 1, 10)];
  const r = winTracker([[W(ROOT, 1, 1001), ...snap], snap]);
  await r.step(2000);
  const res = await r.finish(5000, { exclude: [400] });
  assert.deepEqual(r.kills, [{ pid: 200, tree: false }, { pid: 300, tree: false }]);
  assert.equal(res.count, 2);
});

test('an excluded pid\'s orphan beyond an ended middle parent lives', async () => {
  const r = winTracker([
    [W(ROOT, 1, 1001), W(400, ROOT, 1100), W(500, 400, 1200), W(600, 500, 1300), W(700, ROOT, 1400)],
    [W(400, 1, 1100), W(600, 500, 1300), W(700, 1, 1400)],
  ]);
  await r.step(31000);
  assert.deepEqual(await r.finish(90000, { exclude: [400] }), { count: 1, workingSetMB: 1 });
  assert.deepEqual(r.kills, [{ pid: 700, tree: true }]);
});

test('an excluded pid\'s orphan lives when its ended middle parent\'s pid went to a new session child', async () => {
  const r = winTracker([
    [W(ROOT, 1, 1001), W(400, ROOT, 1100), W(500, 400, 1200), W(600, 500, 1300)],
    [W(ROOT, 1, 1001), W(400, ROOT, 1100), W(500, ROOT, 50000), W(600, 500, 1300)],
    [W(400, 1, 1100), W(500, 1, 50000), W(600, 500, 1300)],
  ]);
  await r.step(31000);
  await r.step(91000);
  assert.deepEqual(await r.finish(120000, { exclude: [400] }), { count: 1, workingSetMB: 1 });
  assert.deepEqual(r.kills, [{ pid: 500, tree: false }]);
});

test('the orphans of an excluded pid no longer listed live', async () => {
  const r = winTracker([[W(600, 400, 1300), W(700, ROOT, 1400)]]);
  await r.finish(5000, { exclude: [400] });
  assert.deepEqual(r.kills, [{ pid: 700, tree: true }]);
});

test('a root never seen and missing from a list is gone from that list on', async () => {
  let r = winTracker([[W(50, 1, 10)], [W(700, ROOT, 60000)]]);
  await r.step(31000);
  await r.finish(100000);
  assert.deepEqual(r.kills, []);
  // Its orphan created before that list is still stopped
  r = winTracker([[W(50, 1, 10), W(700, ROOT, 20000)], [W(700, ROOT, 20000)]]);
  await r.step(31000);
  await r.finish(100000);
  assert.deepEqual(r.kills, [{ pid: 700, tree: true }]);
});

test('/T only where the whole parent-pid subtree is targets', async () => {
  // An old process whose parent pid matches a target
  let r = winTracker([[W(200, ROOT, 1100), W(300, 200, 1200), W(700, 200, 900)]]);
  await r.finish(5000);
  assert.deepEqual(r.kills, [{ pid: 200, tree: false }, { pid: 300, tree: true }]);
  r = winTracker([[W(200, ROOT, 1100, 2), W(300, 200, 1200, 3)]]);
  assert.deepEqual(await r.finish(5000), { count: 2, workingSetMB: 5 });
  assert.deepEqual(r.kills, [{ pid: 200, tree: true }]);
});

test('a failed last list stops nothing; a failed middle list is skipped', async () => {
  let r = winTracker([[W(ROOT, 1, 1001), W(200, ROOT, 1100)], null]);
  await r.step(2000);
  assert.deepEqual(await r.finish(5000), { count: 0, workingSetMB: 0 });
  assert.deepEqual(r.kills, []);
  r = winTracker([null, [W(ROOT, 1, 1001), W(200, ROOT, 1002), W(300, 200, 1003)], [W(300, 200, 1003)]]);
  await r.step(2000);
  await r.step(3000);
  await r.finish(5000);
  assert.deepEqual(r.kills, [{ pid: 300, tree: true }]);
});

test('one list at a time; finish lists again after the running one', async () => {
  let release;
  let running = 0;
  let most = 0;
  let calls = 0;
  const slow = () => {
    calls += 1;
    running += 1;
    most = Math.max(most, running);
    return new Promise((res) => { release = () => { running -= 1; res([W(ROOT, 1, 1001), W(200, ROOT, 1002)]); }; });
  };
  const r = winTracker([slow, () => { calls += 1; return [W(200, ROOT, 1002)]; }]);
  await r.step(2000);
  await r.step(3000);
  assert.equal(calls, 1);
  const done = r.tracker.finish();
  assert.equal(r.tracker.finish(), done);
  await flush();
  assert.equal(calls, 1);
  release();
  await done;
  assert.equal(most, 1);
  assert.equal(calls, 2);
  assert.deepEqual(r.kills, [{ pid: 200, tree: true }]);
});

test('the root is gone when finish is called, not when the running list ends', async () => {
  let release;
  const slow = () => new Promise((res) => { release = () => res([W(ROOT, 1, 1001)]); });
  const r = winTracker([slow, [W(700, ROOT, 104000)]]);
  await r.step(90000);
  const done = r.finish(100000);
  await flush();
  r.clock.t = 110000;
  release();
  await done;
  assert.deepEqual(r.kills, []);
});

/** A POSIX tracker fed by two lists. */
function posixTracker(lists, { signal } = {}) {
  const sent = [];
  const sleeps = [];
  const queue = [...lists];
  const tracker = createTracker({
    pid: ROOT, platform: 'linux', list: async () => queue.shift(), sleep: async (ms) => { sleeps.push(ms); },
    signal: (pid, sig) => {
      sent.push([pid, sig]);
      return signal ? signal(pid, sig) : true;
    },
  });
  return { tracker, sent, sleeps };
}

test('POSIX: SIGTERM to the group, SIGKILL to what is left', async () => {
  const group = [P(200, ROOT, ROOT, 10), P(300, 200, ROOT, 20), P(50, 1, 50)];
  let r = posixTracker([group, [P(300, 1, ROOT, 20), P(50, 1, 50)]]);
  assert.deepEqual(await r.tracker.finish(), { count: 2, workingSetMB: 30 });
  assert.deepEqual(r.sent, [[-ROOT, 'SIGTERM'], [-ROOT, 'SIGKILL']]);
  assert.equal(r.sleeps.length, 1);
  r = posixTracker([group, [P(50, 1, 50)]]);
  assert.deepEqual(await r.tracker.finish(), { count: 2, workingSetMB: 30 });
  assert.deepEqual(r.sent, [[-ROOT, 'SIGTERM']]);
});

test('POSIX: no signal when an excluded process or its descendant is in the group', async () => {
  // 301 is an excluded process's descendant; its orphan 302 (middle parent ended) looks like any other leftover
  const group = [P(200, 1, ROOT), P(301, 1, ROOT), P(302, 1, ROOT), P(400, 200, ROOT)];
  for (const exclude of [[301], [999]]) {
    const r = posixTracker([[...group, P(999, 1, 999)].map((p) => (p.pid === 301 ? { ...p, ppid: 999 } : p)), group]);
    assert.deepEqual(await r.tracker.finish({ exclude }), { count: 0, workingSetMB: 0 });
    assert.deepEqual(r.sent, []);
  }
  // An excluded process outside the group leaves the group signal as it is
  const r = posixTracker([[P(200, 1, ROOT), P(999, 1, 999)], []]);
  assert.deepEqual(await r.tracker.finish({ exclude: [999] }), { count: 1, workingSetMB: 1 });
  assert.deepEqual(r.sent, [[-ROOT, 'SIGTERM']]);
});

test('POSIX: no signal on a failed list, an empty group or a live session pid', async () => {
  for (const first of [null, [P(50, 1, 50)], [P(ROOT, 1, ROOT), P(200, ROOT, ROOT)]]) {
    const r = posixTracker([first, []]);
    assert.deepEqual(await r.tracker.finish(), { count: 0, workingSetMB: 0 });
    assert.deepEqual(r.sent, []);
  }
});

test('POSIX: only what went away after a signal or got SIGKILL counts', async () => {
  const group = [P(200, ROOT, ROOT, 10), P(300, 200, ROOT, 20)];
  // SIGTERM failed: 200 went away on its own and is not counted; SIGKILL to 300 failed too
  let r = posixTracker([group, [P(300, 200, ROOT, 20)]], { signal: () => false });
  assert.deepEqual(await r.tracker.finish(), { count: 0, workingSetMB: 0 });
  // The second list failed: count what got SIGTERM, no SIGKILL
  r = posixTracker([group, null]);
  assert.deepEqual(await r.tracker.finish(), { count: 2, workingSetMB: 30 });
  assert.deepEqual(r.sent, [[-ROOT, 'SIGTERM']]);
  // A throwing signal is a failure
  r = posixTracker([group, group], { signal: () => { throw new Error('boom'); } });
  assert.deepEqual(await r.tracker.finish(), { count: 0, workingSetMB: 0 });
});

test('parseWinList and parsePsList', () => {
  const ft = 116444736000000000 + 1234 * 10000;
  assert.deepEqual(parseWinList(JSON.stringify([{ pid: 1, ppid: 0, created: ft, ws: 4096 }, { pid: 'x', ppid: 0, created: ft, ws: 1 }])),
    [{ pid: 1, ppid: 0, created: 1234, ws: 4096 }]);
  assert.deepEqual(parseWinList(JSON.stringify({ pid: 2, ppid: 1, created: ft, ws: 8 })), [{ pid: 2, ppid: 1, created: 1234, ws: 8 }]);
  assert.deepEqual(parseWinList('[]'), []);
  assert.equal(parseWinList('{broken'), null);
  assert.equal(parseWinList(''), null);
  assert.equal(parseWinList('42'), null);
  assert.deepEqual(parsePsList('  12   1  12  100\n\n 345 12 12 4\n'),
    [{ pid: 12, ppid: 1, pgid: 12, ws: 102400 }, { pid: 345, ppid: 12, pgid: 12, ws: 4096 }]);
  assert.equal(parsePsList(''), null);
  assert.equal(parsePsList(null), null);
});

test('the Windows list command', () => {
  assert.deepEqual(WIN_LIST_ARGS.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
  assert.equal(WIN_LIST_ARGS.length, 4);
  const script = WIN_LIST_ARGS[3];
  assert.ok(!/["%]/.test(script));
  assert.ok(script.includes('Get-CimInstance Win32_Process'));
  assert.ok(script.includes('ToFileTimeUtc'));
});

test('collect and pickTargets on their own', () => {
  const records = new Map();
  collect(records, [W(ROOT, 1, 1001), W(200, ROOT, 1100), W(300, 200, 1200)], { rootPid: ROOT, startedAt: START, at: 2000 });
  assert.deepEqual([...records.keys()].sort(), [ROOT, 200, 300]);
  assert.equal(records.get(ROOT).root, true);
  // A gone record's pid reused by a new child of a record replaces it
  collect(records, [W(ROOT, 1, 1001), W(200, ROOT, 1100), W(300, 200, 2500)], { rootPid: ROOT, startedAt: START, at: 3000 });
  assert.equal(records.get(300).created, 2500);
  assert.deepEqual(pickTargets(records, [W(200, ROOT, 1100), W(300, 200, 2500)], { rootPid: ROOT, startedAt: START }),
    [{ pid: 200, tree: true, covers: [200, 300] }]);
});
