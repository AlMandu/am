// am progress news: the event file of one task and the command that waits on it.
// A long am command (a stage session of am:auto) appends one JSON line per piece of news to
// .am/<slug>/progress.jsonl with appendEvent. The wait command prints the lines its consumer
// has not seen yet, then one state line computed from the whole file, and ends by itself, so
// a session can run it in the background next to the long command and report what it printed:
//   node progress.mjs <slug> [--consumer <name>]
// Each consumer (default `terminal`) has its own cursor, a byte position in
// .am/<slug>/progress.<name>.cursor, moved only after the lines were printed.
// Lines: {t, ev, text} plus optional pid (on start), stage, task, status, min, src. ev is one of
// start, step (news), note (never wakes the wait by itself), alert (printed at once), end.
// Output (English): `<ev>: <text> [stage=.. task=.. status=.. min=.. src=..]` per line read, then
// `state: running (<what>, <N> min)` or `state: ended`.
// Exit codes: 0 every accepted wait, whatever happened; 1 bad arguments (the last line is still
// `state: ended`). Every time value is a function parameter. Node only, no dependencies.

import { appendFileSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { countDone } from '../hooks/handover.mjs';

const USAGE = 'usage: node progress.mjs <slug> [--consumer <name>]';
// Unread step and start lines are collected for batchMs; a quiet wait ends after quietMs with the state line only;
// a wait that begins in an ended state gives a new start startWaitMs to appear. maxLifeMs stays under the
// 10-minute default limit of a background command.
export const DEFAULTS = { batchMs: 30000, quietMs: 480000, startWaitMs: 60000, pollMs: 1000, maxLifeMs: 510000 };
const EVENTS = ['start', 'step', 'note', 'alert', 'end'];
const SHOWN = ['stage', 'task', 'status', 'min', 'src'];
const ENDED = 'state: ended';

const oneLine = (v) => String(v).replace(/\s+/g, ' ').trim();
const eventFile = (cwd, slug) => path.join(cwd, '.am', slug, 'progress.jsonl');

/** Appends one event line to the slug's event file. Never creates the folder and never throws: progress news must not stop the work. */
export function appendEvent(cwd, slug, fields, { now = Date.now } = {}) {
  try {
    appendFileSync(eventFile(cwd, slug), `${JSON.stringify({ t: new Date(now()).toISOString(), ...fields })}\n`);
  } catch {
    // Dropped on purpose.
  }
}

function parseLine(line) {
  try {
    const event = JSON.parse(line);
    const ok = event && typeof event === 'object' && !Array.isArray(event) && EVENTS.includes(event.ev) && typeof event.text === 'string';
    return ok ? event : null;
  } catch {
    return null;
  }
}

// One read of the whole file: its complete lines with their byte positions. A missing file is an empty one;
// null is any other read error, which says nothing about the file.
function scan(file) {
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
    const event = parseLine(line);
    if (event) items.push({ event, pos, line });
    pos = nl + 1;
  }
  return { items, next: pos, size: buf.length };
}

// The lines at or after the cursor. A file shorter than the cursor was rewritten: read it from the start.
function unreadOf(snap, offset) {
  const from = offset > snap.size ? 0 : offset;
  return { items: snap.items.filter((i) => i.pos >= from), next: Math.max(from, snap.next) };
}

/**
 * The events in the complete lines from a byte position on, and the position after the last line break.
 * Lines that are not events are skipped but passed. `failed` marks a read error other than a missing file.
 */
export function readFrom(file, offset) {
  const snap = scan(file);
  if (!snap) return { events: [], next: offset, failed: true };
  const { items, next } = unreadOf(snap, offset);
  return { events: items.map((i) => i.event), next };
}

/** One output line for an event. pid and unknown fields are not printed. */
export function formatEvent(event) {
  const fields = SHOWN.filter((k) => event[k] !== undefined && event[k] !== null && oneLine(event[k]) !== '').map((k) => `${k}=${oneLine(event[k])}`);
  return `${event.ev}: ${oneLine(event.text)}${fields.length ? ` [${fields.join(' ')}]` : ''}`;
}

/** True while a process with this pid exists. */
export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err) && err.code === 'EPERM';
  }
}

// The last start when its command is still running, or null: an end after it, no positive integer pid or a dead pid is ended.
function runningStart(events, alive) {
  const at = events.map((e) => e.ev).lastIndexOf('start');
  if (at < 0) return null;
  const start = events[at];
  const after = events.slice(at + 1);
  if (after.some((e) => e.ev === 'end')) return null;
  if (!Number.isInteger(start.pid) || start.pid <= 0 || !alive(start.pid)) return null;
  return { start, handover: after.some((e) => e.ev === 'note' && e.stage === 'handover') };
}

function formatState(run, { now, planText }) {
  if (!run) return ENDED;
  const { start, handover } = run;
  const what = handover ? 'handover' : oneLine(typeof start.stage === 'string' && start.stage ? start.stage : start.text);
  const min = Math.max(0, Math.floor((now() - Date.parse(start.t)) / 60000)) || 0;
  const steps = start.stage === 'do' && !handover && typeof planText === 'string' ? `, ${countDone(planText)} steps done` : '';
  return `state: running (${what}, ${min} min${steps})`;
}

/** The state line of a whole event file: what has been running for how long, or `state: ended`. */
export function stateLine(events, { now = Date.now, alive = pidAlive, planText } = {}) {
  return formatState(runningStart(events, alive), { now, planText });
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

// Replaces the cursor through a temporary file. Never moves it back, unless the event file is now shorter than it.
function saveCursor(file, next, events) {
  const now = readCursor(file);
  if (now > next && now <= sizeOf(events)) return;
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, String(next));
    renameSync(tmp, file);
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // The lines come once more next time.
    }
  }
}

function readText(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitLoop(paths, o) {
  const began = o.now();
  // One check: a single read of the event file gives both the unread lines and the state.
  const look = () => {
    const snap = scan(paths.events);
    if (!snap) return null;
    const { items, next } = unreadOf(snap, readCursor(paths.cursor));
    const last = snap.items.filter((i) => i.event.ev === 'start').pop();
    return { unread: items, next, run: runningStart(snap.items.map((i) => i.event), o.alive), lastStart: last ? `${last.pos}:${last.line}` : '' };
  };
  const emit = (snap, items) => {
    const state = snap ? formatState(snap.run, { now: o.now, planText: snap.run ? readText(paths.plan) : null }) : ENDED;
    o.out.write([...items.map((i) => formatEvent(i.event)), state].map((l) => `${l}\n`).join(''));
    if (items.length) saveCursor(paths.cursor, snap.next, paths.events);
    return 0;
  };
  const has = (snap, kinds) => snap.unread.some((i) => kinds.includes(i.event.ev));

  let good = null; // the last check that could read the file
  let startSeen; // the last start of a wait that began in an ended state; null once in the normal wait
  let batchAt = null;
  for (;;) {
    const t = o.now();
    const snap = look();
    if (snap) {
      good = snap;
      if (startSeen === undefined) startSeen = snap.run ? null : snap.lastStart;
      if (startSeen !== null && snap.lastStart !== startSeen) startSeen = null;
      if (startSeen !== null) {
        if (t - began >= o.startWaitMs) return emit(snap, snap.unread);
      } else {
        if (!snap.run || has(snap, ['alert', 'end'])) return emit(snap, snap.unread);
        if (has(snap, ['step', 'start'])) {
          batchAt ??= t;
          if (t - batchAt >= o.batchMs) return emit(snap, snap.unread);
        } else {
          batchAt = null; // another wait of this consumer took the batch
        }
      }
    }
    if (t - began >= o.maxLifeMs) return emit(good, good && batchAt !== null ? good.unread : []);
    if (batchAt === null && t - began >= o.quietMs) return emit(good, []);
    const deadlines = [began + o.maxLifeMs];
    if (typeof startSeen === 'string') deadlines.push(began + o.startWaitMs);
    if (batchAt !== null) deadlines.push(batchAt + o.batchMs);
    else deadlines.push(began + o.quietMs);
    const left = deadlines.map((d) => d - t).filter((ms) => ms > 0);
    await o.sleep(Math.min(o.pollMs, ...left));
  }
}

/**
 * Waits for news after the consumer's cursor, prints it with the state line and returns 0, always.
 * paths: {events, cursor, plan}. opts: the DEFAULTS values, now, sleep(ms), alive(pid), out.
 */
export async function wait(paths, opts = {}) {
  try {
    return await waitLoop(paths, { ...DEFAULTS, now: Date.now, sleep: realSleep, alive: pidAlive, out: process.stdout, ...opts });
  } catch {
    return 0;
  }
}

/** The command line. Returns the exit code: 1 for bad arguments, 0 for every accepted wait. */
export async function main(argv, { cwd = process.cwd(), out = process.stdout, ...waitOpts } = {}) {
  const bad = (why) => {
    out.write(`${why}\n${USAGE}\n${ENDED}\n`);
    return 1;
  };
  let slug;
  let consumer = 'terminal';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--consumer') {
      if (i + 1 >= argv.length) return bad('--consumer needs a name');
      consumer = argv[++i];
    } else if (arg.startsWith('-')) {
      return bad(`unknown option: ${oneLine(arg)}`);
    } else if (slug === undefined) {
      slug = arg;
    } else {
      return bad(`unexpected argument: ${oneLine(arg)}`);
    }
  }
  if (slug === undefined) return bad('no slug given');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) return bad(`invalid slug: ${oneLine(slug)}`);
  if (!/^[a-z0-9-]+$/.test(consumer)) return bad(`invalid consumer name: ${oneLine(consumer)}`);
  const dir = path.join(cwd, '.am', slug);
  return wait({ events: eventFile(cwd, slug), cursor: path.join(dir, `progress.${consumer}.cursor`), plan: path.join(dir, 'plan.md') }, { ...waitOpts, out });
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
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.exitCode = 0; // an accepted wait never fails its caller
    },
  );
}
