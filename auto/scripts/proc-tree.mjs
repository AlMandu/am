// am process tree: finds the processes a `claude -p` session left behind and stops them, never an unrelated one.
// Called around every session's child process by exec() of stage.mjs.
// Windows: a tracker lists every process (PowerShell, Win32_Process) once after FIRST_LIST_MS, then every LIST_EVERY_MS,
// and keeps the session's descendants as (pid, creation time) records, so an orphan whose parent (cmd.exe and the like)
// already ended is still known. finish() lists once more and stops the recorded descendants still alive with taskkill
// (/T only where the whole parent-pid subtree is a target, because /T does not look at creation times).
// macOS and Linux: finish() sends SIGTERM to the session's process group, then SIGKILL to what is left after TERM_WAIT_MS,
// and nothing when an excluded process or its descendant is in that group.
// The caller measures `startedAt` right before the spawn; nothing created before it is ever linked.
// Lists, kills, signals, timers and the clock are injectable for tests. Reads no environment variable. Node 18+, no dependencies.

import { execFile } from 'node:child_process';

export const LIST_TIMEOUT_MS = 20000;
// Same value as STOP_RUN_MS of stage.mjs
export const KILL_TIMEOUT_MS = 10000;
export const FIRST_LIST_MS = 30000;
export const LIST_EVERY_MS = 60000;
export const TERM_WAIT_MS = 2000;
const MAX_BUFFER = 64 * 1024 * 1024;
// Windows file time (100 ns since 1601) of the Unix epoch
const FILETIME_EPOCH = 116444736000000000;

// One JSON array (also for a single process). No double quote or percent sign: neither may reach a command line.
const WIN_SCRIPT = 'ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | Where-Object { $_.CreationDate } | '
  + 'ForEach-Object { [pscustomobject]@{ pid = [int64]$_.ProcessId; ppid = [int64]$_.ParentProcessId; '
  + 'created = $_.CreationDate.ToFileTimeUtc(); ws = [int64]$_.WorkingSetSize } })';
export const WIN_LIST_ARGS = ['-NoProfile', '-NonInteractive', '-Command', WIN_SCRIPT];

/** The PowerShell list as [{ pid, ppid, created (ms), ws (bytes) }]; entries with a non-integer field are dropped; null when unreadable. */
export function parseWinList(text) {
  let data;
  try {
    data = JSON.parse(String(text));
  } catch {
    return null;
  }
  if (data && typeof data === 'object' && !Array.isArray(data)) data = [data];
  if (!Array.isArray(data)) return null;
  const out = [];
  for (const p of data) {
    if (!p || typeof p !== 'object') continue;
    const { pid, ppid, created, ws } = p;
    if (![pid, ppid, created, ws].every(Number.isInteger)) continue;
    out.push({ pid, ppid, created: (created - FILETIME_EPOCH) / 10000, ws });
  }
  return out;
}

/** `ps -o pid=,ppid=,pgid=,rss=` lines as [{ pid, ppid, pgid, ws (bytes) }]; null when no line is readable. */
export function parsePsList(text) {
  if (typeof text !== 'string') return null;
  const out = [];
  for (const line of text.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length !== 4 || !f.every((v) => /^\d+$/.test(v))) continue;
    const [pid, ppid, pgid, rss] = f.map(Number);
    out.push({ pid, ppid, pgid, ws: rss * 1024 });
  }
  return out.length ? out : null;
}

const run = (file, args, timeout) => new Promise((resolve) => {
  try {
    execFile(file, args, { timeout, windowsHide: true, maxBuffer: MAX_BUFFER }, (err, stdout) => resolve(err ? null : stdout));
  } catch {
    resolve(null);
  }
});

/** Every process on Windows, or null on failure or timeout. */
export const listWindows = async () => parseWinList(await run('powershell.exe', WIN_LIST_ARGS, LIST_TIMEOUT_MS));
/** Every process on macOS and Linux, or null on failure or timeout. */
export const listPosix = async () => parsePsList(await run('ps', ['-A', '-o', 'pid=,ppid=,pgid=,rss='], LIST_TIMEOUT_MS));
/** taskkill of one process (with its parent-pid subtree when tree); true when it succeeded. */
export const killWindows = async (pid, { tree = false } = {}) =>
  (await run('taskkill', ['/pid', String(pid), ...(tree ? ['/T'] : []), '/F'], KILL_TIMEOUT_MS)) !== null;
/** A signal to a pid (a negative pid is a process group); true when it was sent. */
export const signalPosix = (pid, sig) => {
  try {
    return process.kill(pid, sig);
  } catch {
    return false;
  }
};

const byPid = (snapshot) => new Map(snapshot.map((p) => [p.pid, p]));

/**
 * Adds the session's descendants in snapshot (listed at `at`) to records (pid -> { created, ppid, ws, goneAt }; the root's
 * record has `root: true`) and returns records. A process is linked when it was created at or after startedAt, its parent pid
 * is the root or a record, it was created at or after that parent (startedAt for a root never seen), the parent pid is not
 * alive now with another creation time, and, for a parent already gone, it was created before goneAt. rootGone is the time
 * finish() was called: from then on the root is gone (at the latest then) and any live process with its pid is a stranger.
 */
export function collect(records, snapshot, { rootPid, startedAt, at, rootGone = null }) {
  const live = byPid(snapshot);
  for (const [pid, r] of records) {
    const p = live.get(pid);
    if (p && p.created === r.created && !(r.root && rootGone != null)) {
      r.ppid = p.ppid;
      r.ws = p.ws;
    } else if (r.goneAt == null) r.goneAt = at;
    if (r.root && rootGone != null) r.goneAt = Math.min(r.goneAt, rootGone);
  }
  const rootLive = live.get(rootPid);
  if (rootGone == null && !records.has(rootPid)) {
    if (rootLive && rootLive.created >= startedAt) {
      records.set(rootPid, { created: rootLive.created, ppid: rootLive.ppid, ws: rootLive.ws, goneAt: null, root: true });
    } else {
      // A root never seen and missing from this list (or its pid held by an older process) went before `at`
      records.set(rootPid, { created: null, ppid: null, ws: 0, goneAt: at, root: true });
    }
  }
  // The parent a child may be linked through: { created, goneAt }, or null
  const parentOf = (ppid) => {
    const r = records.get(ppid);
    const p = live.get(ppid);
    if (ppid === rootPid) {
      if (p && (rootGone != null || !r || p.created !== r.created)) return null;
      const goneAt = Math.min(r?.goneAt ?? Infinity, rootGone ?? Infinity);
      return { created: r?.created ?? startedAt, goneAt: goneAt === Infinity ? null : goneAt };
    }
    if (!r || r.root || (p && p.created !== r.created)) return null;
    return r;
  };
  for (let grown = true; grown;) {
    grown = false;
    for (const p of snapshot) {
      if (p.pid === rootPid || p.created < startedAt) continue;
      const known = records.get(p.pid);
      if (known && (known.created === p.created || known.goneAt == null || known.root)) continue;
      const parent = parentOf(p.ppid);
      if (!parent || p.created < parent.created || (parent.goneAt != null && p.created >= parent.goneAt)) continue;
      // A replaced record stays in `prev` for the exclusion lineage
      const prev = known ? [...(known.prev || []), { created: known.created, ppid: known.ppid }] : undefined;
      records.set(p.pid, { created: p.created, ppid: p.ppid, ws: p.ws, goneAt: null, ...(prev && { prev }) });
      grown = true;
    }
  }
  return records;
}

/**
 * The pids in exclude and their live descendants, followed by (pid, creation time): through the live list, the records and
 * the records they replaced, so a descendant whose middle parent already ended (even one whose pid was reused) is one.
 * A process's parent is the latest process with its parent pid created at or before it; a child created before every
 * process with that pid is no one's. Without creation times (POSIX) each pid is one process.
 */
function excludedSet(live, exclude, records = new Map()) {
  const nodes = new Map(); // `${pid}:${created}` -> { pid, ppid, created }
  const add = (pid, ppid, created) => {
    const key = `${pid}:${created}`;
    if (!nodes.has(key)) nodes.set(key, { key, pid, ppid, created });
  };
  for (const p of live.values()) add(p.pid, p.ppid, p.created);
  for (const [pid, r] of records) {
    if (r.root) continue;
    for (const x of [r, ...(r.prev || [])]) add(pid, x.ppid, x.created);
  }
  const withPid = new Map();
  for (const n of nodes.values()) withPid.set(n.pid, [...(withPid.get(n.pid) || []), n]);
  const parentOf = (n) => {
    let best = null;
    for (const c of withPid.get(n.ppid) || []) {
      if (c.created != null && n.created != null && c.created > n.created) continue;
      if (!best || (c.created ?? -Infinity) > (best.created ?? -Infinity)) best = c;
    }
    return best;
  };
  const ex = new Set([...nodes.values()].filter((n) => exclude.includes(n.pid)).map((n) => n.key));
  for (let grown = true; grown;) {
    grown = false;
    for (const n of nodes.values()) {
      if (ex.has(n.key)) continue;
      const parent = parentOf(n);
      // An excluded pid never listed still owns its orphans
      if (parent ? !ex.has(parent.key) : !(exclude.includes(n.ppid) && !withPid.has(n.ppid))) continue;
      ex.add(n.key);
      grown = true;
    }
  }
  const out = new Set(exclude);
  for (const p of live.values()) if (ex.has(`${p.pid}:${p.created}`)) out.add(p.pid);
  return out;
}

/**
 * The kills for the last snapshot: the recorded descendants alive with their recorded creation time, minus exclude and its
 * descendants. A top target whose whole parent-pid subtree is targets is one { pid, tree: true, covers }, otherwise each
 * target in it is its own { pid, tree: false }.
 */
export function pickTargets(records, snapshot, { rootPid, startedAt, exclude = [] }) {
  const live = byPid(snapshot);
  const skip = excludedSet(live, exclude, records);
  const targets = new Set();
  for (const p of snapshot) {
    const r = records.get(p.pid);
    if (p.pid !== rootPid && r && !r.root && r.created === p.created && p.created >= startedAt && !skip.has(p.pid)) targets.add(p.pid);
  }
  const children = new Map();
  for (const p of snapshot) children.set(p.ppid, [...(children.get(p.ppid) || []), p.pid]);
  const subtree = (pid) => {
    const seen = new Set([pid]);
    for (const q of seen) for (const c of children.get(q) || []) seen.add(c);
    return [...seen];
  };
  const out = [];
  const done = new Set();
  const handle = (pid) => {
    const all = subtree(pid);
    if (all.every((q) => targets.has(q) && !done.has(q))) {
      all.forEach((q) => done.add(q));
      out.push({ pid, tree: true, covers: all });
      return;
    }
    done.add(pid);
    out.push({ pid, tree: false });
    // The nearest targets below, through non-targets
    const queue = [...(children.get(pid) || [])];
    const seen = new Set([pid]);
    while (queue.length) {
      const q = queue.shift();
      if (seen.has(q)) continue;
      seen.add(q);
      if (targets.has(q)) {
        if (!done.has(q)) handle(q);
      } else queue.push(...(children.get(q) || []));
    }
  };
  for (const pid of targets) if (!done.has(pid) && !targets.has(live.get(pid).ppid)) handle(pid);
  for (const pid of targets) if (!done.has(pid)) handle(pid);
  return out;
}

const settle = async (fn, ...args) => {
  try {
    return await fn(...args);
  } catch {
    return null;
  }
};
const toMB = (bytes) => Math.round(bytes / 1048576);
const EMPTY = Object.freeze({ count: 0, workingSetMB: 0 });

/**
 * A tracker for the session process `pid`. start() begins the Windows lists (nothing elsewhere); finish({ exclude }) stops
 * what the session left, except the pids in exclude and their descendants, and resolves { count, workingSetMB } of what it
 * stopped. Never rejects; finish() called again returns the same promise. `startedAt` is measured right before the spawn.
 */
export function createTracker({
  pid, startedAt, platform = process.platform, list, kill, signal, now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  timers = { setTimeout, setInterval, clearTimeout, clearInterval },
  firstMs = FIRST_LIST_MS, everyMs = LIST_EVERY_MS, termWaitMs = TERM_WAIT_MS,
}) {
  const win = platform === 'win32';
  const since = startedAt ?? now();
  const listFn = list || (win ? listWindows : listPosix);
  const killFn = kill || killWindows;
  const signalFn = signal || signalPosix;
  const records = new Map();
  let started = false;
  let finishing = null;
  let first = null;
  let every = null;
  let inFlight = null;

  const take = async () => {
    const snap = await settle(listFn);
    return Array.isArray(snap) ? snap : null;
  };
  const tick = () => {
    if (inFlight || finishing) return;
    const at = now();
    inFlight = take()
      .then((snap) => {
        if (snap) collect(records, snap, { rootPid: pid, startedAt: since, at });
      })
      .catch(() => {})
      .finally(() => { inFlight = null; });
  };

  // gone: the time finish() was called, measured before waiting for a running list
  const finishWindows = async (exclude, gone) => {
    const snap = await take();
    if (!snap) return EMPTY;
    collect(records, snap, { rootPid: pid, startedAt: since, at: gone, rootGone: gone });
    const picks = pickTargets(records, snap, { rootPid: pid, startedAt: since, exclude });
    const live = byPid(snap);
    const results = await Promise.allSettled(picks.map((t) => settle(killFn, t.pid, { tree: t.tree })));
    let count = 0;
    let bytes = 0;
    picks.forEach((t, i) => {
      if (results[i].status !== 'fulfilled' || results[i].value !== true) return;
      for (const q of t.tree ? t.covers : [t.pid]) {
        count += 1;
        bytes += live.get(q)?.ws || 0;
      }
    });
    return { count, workingSetMB: toMB(bytes) };
  };

  const finishPosix = async (exclude) => {
    const snap = await take();
    if (!snap) return EMPTY;
    // A live process with the session's pid leads another group now: never signal it
    if (snap.some((p) => p.pid === pid)) return EMPTY;
    const members = snap.filter((p) => p.pgid === pid);
    if (!members.length) return EMPTY;
    // With an excluded process in the group nothing is signalled: every top member is an orphan of pid 1 by now, so the
    // session's leftovers cannot be told from the excluded process's descendants
    const skip = excludedSet(byPid(snap), exclude);
    if (members.some((p) => skip.has(p.pid))) return EMPTY;
    const send = async (sig) => (await settle(signalFn, -pid, sig)) === true;
    const termed = await send('SIGTERM');
    await settle(sleep, termWaitMs);
    const after = await take();
    let stopped;
    if (!after) stopped = termed ? members : [];
    else {
      const still = new Set(after.filter((p) => p.pgid === pid).map((p) => p.pid));
      const left = members.filter((p) => still.has(p.pid));
      stopped = termed ? members.filter((p) => !still.has(p.pid)) : [];
      if (left.length && await send('SIGKILL')) stopped.push(...left);
    }
    return { count: stopped.length, workingSetMB: toMB(stopped.reduce((s, p) => s + p.ws, 0)) };
  };

  return {
    start() {
      if (!win || started || finishing) return;
      started = true;
      first = timers.setTimeout(() => {
        first = null;
        if (finishing) return;
        every = timers.setInterval(tick, everyMs);
        every?.unref?.();
        tick();
      }, firstMs);
      first?.unref?.();
    },
    finish({ exclude = [] } = {}) {
      if (finishing) return finishing;
      if (first) timers.clearTimeout(first);
      if (every) timers.clearInterval(every);
      first = every = null;
      const gone = now();
      finishing = (async () => {
        try {
          if (inFlight) await inFlight;
          return await (win ? finishWindows(exclude, gone) : finishPosix(exclude));
        } catch {
          return EMPTY;
        }
      })();
      return finishing;
    },
  };
}
