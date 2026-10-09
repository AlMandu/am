// Run: node --test tests/progress.test.mjs
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, appendEvent, formatEvent, main, readFrom, stateLine, wait } from '../plugin/scripts/progress.mjs';

const SCRIPT = fileURLToPath(new URL('../plugin/scripts/progress.mjs', import.meta.url));
const T0 = Date.parse('2026-10-08T00:00:00.000Z');
const SLUG = 'task-1';
const LIVE = 4242;
const alive = (pid) => pid === LIVE;

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

// A task folder with a virtual clock: sleep moves the clock and runs the appends scheduled up to the new time, in time order.
function setup({ folder = true } = {}) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'am-progress-'));
  bases.push(cwd);
  const dir = path.join(cwd, '.am', SLUG);
  if (folder) mkdirSync(dir, { recursive: true });
  let t = T0;
  const jobs = [];
  const env = {
    cwd,
    dir,
    paths: (consumer = 'terminal') => ({ events: path.join(dir, 'progress.jsonl'), cursor: path.join(dir, `progress.${consumer}.cursor`), plan: path.join(dir, 'plan.md') }),
    now: () => t,
    elapsed: () => t - T0,
    sleep: async (ms) => {
      const until = t + ms;
      jobs.sort((a, b) => a.at - b.at);
      while (jobs.length && jobs[0].at <= until) {
        const job = jobs.shift();
        t = Math.max(t, job.at);
        job.fn();
      }
      t = until;
    },
    at: (ms, fn) => jobs.push({ at: T0 + ms, fn }),
    add: (fields) => appendEvent(cwd, SLUG, fields, { now: env.now }),
    addAt: (ms, fields) => env.at(ms, () => env.add(fields)),
    cursor: (consumer = 'terminal') => (existsSync(env.paths(consumer).cursor) ? readFileSync(env.paths(consumer).cursor, 'utf8') : null),
    size: () => readFileSync(env.paths().events).length,
  };
  return env;
}

// Runs one wait on the virtual clock. Returns what it printed, in how many writes, and when (ms from the start of the test).
async function run(env, { consumer = 'terminal', onWrite, ...opts } = {}) {
  const writes = [];
  let at = null;
  const out = {
    write(s) {
      if (onWrite) onWrite();
      writes.push(s);
      at = env.elapsed();
    },
  };
  const code = await wait(env.paths(consumer), { now: env.now, sleep: env.sleep, alive, out, ...opts });
  assert.equal(code, 0);
  assert.equal(writes.length, 1, 'one write per wait');
  assert.ok(writes[0].endsWith('\n'));
  return { lines: writes[0].trimEnd().split('\n'), at };
}

const START = { ev: 'start', text: 'plan stage started', pid: LIVE, stage: 'plan' };

test('DEFAULTS keep the start wait inside the quiet time and the whole life under 8 minutes 30 seconds', () => {
  assert.deepEqual(Object.keys(DEFAULTS).sort(), ['batchMs', 'maxLifeMs', 'pollMs', 'quietMs', 'startWaitMs']);
  assert.equal(DEFAULTS.batchMs, 30000);
  assert.equal(DEFAULTS.quietMs, 480000);
  assert.equal(DEFAULTS.startWaitMs, 60000);
  assert.ok(DEFAULTS.startWaitMs <= DEFAULTS.quietMs && DEFAULTS.quietMs < DEFAULTS.maxLifeMs && DEFAULTS.maxLifeMs <= 510000);
  assert.ok(!readFileSync(SCRIPT, 'utf8').includes('process.env'));
});

test('appendEvent writes one line with the time first and never throws without the folder', () => {
  const env = setup({ folder: false });
  assert.doesNotThrow(() => appendEvent(env.cwd, SLUG, { ev: 'step', text: 'x' }));
  assert.ok(!existsSync(env.dir));
  mkdirSync(env.dir, { recursive: true });
  env.add({ ev: 'step', text: 'one' });
  env.add({ ev: 'end', text: 'two', status: 'READY' });
  const text = readFileSync(env.paths().events, 'utf8');
  assert.equal(text, '{"t":"2026-10-08T00:00:00.000Z","ev":"step","text":"one"}\n{"t":"2026-10-08T00:00:00.000Z","ev":"end","text":"two","status":"READY"}\n');
});

test('readFrom reads complete lines only, counts bytes and starts over on a shorter file', () => {
  const env = setup();
  const file = env.paths().events;
  assert.deepEqual(readFrom(file, 0), { events: [], next: 0 });
  assert.deepEqual(readFrom(file, 50), { events: [], next: 0 });
  const first = '{"t":"x","ev":"step","text":"첫 소식 é"}\n';
  writeFileSync(file, `${first}{"t":"x","ev":"note","te`);
  let r = readFrom(file, 0);
  assert.deepEqual(r.events.map((e) => e.text), ['첫 소식 é']);
  assert.equal(r.next, Buffer.byteLength(first));
  assert.ok(r.next > first.length); // bytes, not characters
  // The unfinished last line belongs to the next read.
  appendFileSync(file, 'xt":"second"}\r\n');
  r = readFrom(file, r.next);
  assert.deepEqual(r.events.map((e) => [e.ev, e.text]), [['note', 'second']]);
  assert.equal(r.next, readFileSync(file).length);
  assert.deepEqual(readFrom(file, r.next), { events: [], next: r.next });
  // Lines that are not events are skipped, and the position passes them.
  const before = r.next;
  appendFileSync(file, 'not json\n[1]\nnull\n{"ev":"other","text":"x"}\n{"ev":"step","text":5}\n{"ev":"alert","text":"kept"}\n');
  r = readFrom(file, before);
  assert.deepEqual(r.events.map((e) => e.text), ['kept']);
  assert.equal(r.next, readFileSync(file).length);
  // A file shorter than the cursor is read from the start.
  writeFileSync(file, '{"ev":"step","text":"new file"}\n');
  r = readFrom(file, before);
  assert.deepEqual(r.events.map((e) => e.text), ['new file']);
  assert.equal(r.next, readFileSync(file).length);
  // A read error other than a missing file is no change, not an empty file.
  assert.deepEqual(readFrom(env.dir, 7), { events: [], next: 7, failed: true });
});

test('formatEvent prints one line with the fields in a fixed order and no pid', () => {
  assert.equal(formatEvent({ t: 'x', ev: 'step', text: 'T01 committed' }), 'step: T01 committed');
  assert.equal(formatEvent({ ev: 'start', text: 'do stage\n started', src: 'orch', min: 0, pid: 77, status: 'ok', task: 'T01', stage: 'do', extra: 'no' }), 'start: do stage started [stage=do task=T01 status=ok min=0 src=orch]');
  assert.equal(formatEvent({ ev: 'end', text: '  done ', status: 'NEEDS  DECISION', min: 12, stage: '', task: null }), 'end: done [status=NEEDS DECISION min=12]');
});

test('stateLine says what runs for how long, and counts done steps only for a do stage that was not handed over', () => {
  const now = () => T0 + 3 * 60000 + 59000;
  const at = new Date(T0).toISOString();
  const plan = '## 단계\n1. 하나 (완료)\n2. Two (done)\n3. 셋\n';
  const opt = { now, alive, planText: plan };
  assert.equal(stateLine([], opt), 'state: ended');
  assert.equal(stateLine([{ t: at, ev: 'step', text: 'x' }], opt), 'state: ended');
  assert.equal(stateLine([{ t: at, ...START }], opt), 'state: running (plan, 3 min)');
  assert.equal(stateLine([{ t: at, ev: 'start', text: 'do stage', pid: LIVE, stage: 'do' }], opt), 'state: running (do, 3 min, 2 steps done)');
  assert.equal(stateLine([{ t: at, ev: 'start', text: 'do stage', pid: LIVE, stage: 'do' }], { now, alive }), 'state: running (do, 3 min)');
  assert.equal(stateLine([{ t: at, ev: 'start', text: 'do stage', pid: LIVE, stage: 'do' }, { t: at, ev: 'note', text: 'handed over', stage: 'handover' }], opt), 'state: running (handover, 3 min)');
  assert.equal(stateLine([{ t: at, ev: 'start', text: 'split  started', pid: LIVE }], opt), 'state: running (split started, 3 min)');
  // A start in the future never gives a negative time.
  assert.equal(stateLine([{ t: new Date(T0 + 3600000).toISOString(), ...START }], opt), 'state: running (plan, 0 min)');
  // Ended: an end after the last start, a dead pid; a later start runs again.
  assert.equal(stateLine([{ t: at, ...START }, { t: at, ev: 'end', text: 'done' }], opt), 'state: ended');
  assert.equal(stateLine([{ t: at, ...START, pid: 1 }], opt), 'state: ended');
  assert.equal(stateLine([{ t: at, ...START }, { t: at, ev: 'end', text: 'done' }, { t: at, ...START, stage: 'check' }], opt), 'state: running (check, 3 min)');
  // A start without a positive integer pid is ended, and nobody is asked about it.
  for (const pid of [undefined, null, 0, -5, '4242', 1.5]) {
    const calls = [];
    const line = stateLine([{ t: at, ev: 'start', text: 'x', stage: 'plan', pid }], { now, alive: (p) => (calls.push(p), true) });
    assert.equal(line, 'state: ended', String(pid));
    assert.deepEqual(calls, [], String(pid));
  }
});

test('a step waits exactly the batch time and takes later lines along; a start does the same', async () => {
  const env = setup();
  env.add(START);
  env.add({ ev: 'step', text: 'first' });
  env.addAt(10000, { ev: 'note', text: 'a note' });
  env.addAt(29000, { ev: 'step', text: 'late one' });
  let r = await run(env);
  assert.equal(r.at, 30000);
  assert.deepEqual(r.lines, ['start: plan stage started [stage=plan]', 'step: first', 'note: a note', 'step: late one', 'state: running (plan, 0 min)']);
  assert.equal(env.cursor(), String(env.size()));
  // Run again: nothing is printed twice. A lone start is batched too.
  env.addAt(40000, { ev: 'start', text: 'check stage started', pid: LIVE, stage: 'check' });
  r = await run(env);
  assert.equal(r.at, 70000);
  assert.deepEqual(r.lines, ['start: check stage started [stage=check]', 'state: running (check, 0 min)']);
});

test('alert and end are printed at the next check', async () => {
  const env = setup();
  env.add(START);
  env.add({ ev: 'step', text: 'first' });
  env.addAt(4500, { ev: 'alert', text: 'needs a decision', task: 'T02' });
  let r = await run(env);
  assert.equal(r.at, 5000);
  assert.deepEqual(r.lines, ['start: plan stage started [stage=plan]', 'step: first', 'alert: needs a decision [task=T02]', 'state: running (plan, 0 min)']);
  env.addAt(7200, { ev: 'end', text: 'plan stage ended', status: 'READY', min: 1 });
  r = await run(env);
  assert.equal(r.at, 8000);
  assert.deepEqual(r.lines, ['end: plan stage ended [status=READY min=1]', 'state: ended']);
});

test('a note alone wakes nobody: after the quiet time only the state line, and the note comes with the next step', async () => {
  const env = setup();
  env.add(START);
  await run(env); // reads the start
  const cursor = env.cursor();
  env.addAt(60000, { ev: 'note', text: 'compacted' });
  let r = await run(env);
  assert.equal(r.at, 30000 + DEFAULTS.quietMs);
  assert.deepEqual(r.lines, ['state: running (plan, 8 min)']);
  assert.equal(env.cursor(), cursor);
  env.addAt(520000, { ev: 'step', text: 'news' });
  r = await run(env);
  assert.equal(r.at, 520000 + DEFAULTS.batchMs);
  assert.deepEqual(r.lines, ['note: compacted', 'step: news', 'state: running (plan, 9 min)']);
  assert.equal(env.cursor(), String(env.size()));
});

test('a pid that dies during the wait ends it with the lines left', async () => {
  const env = setup();
  env.add(START);
  await run(env);
  env.addAt(40000, { ev: 'note', text: 'asked again' });
  let dead = false;
  env.at(45500, () => {
    dead = true;
  });
  const r = await run(env, { alive: (pid) => !dead && pid === LIVE });
  assert.equal(r.at, 46000);
  assert.deepEqual(r.lines, ['note: asked again', 'state: ended']);
  assert.equal(env.cursor(), String(env.size()));
});

test('beginning in an ended state it waits for a new start: goes on when one comes, ends after the start wait when none does', async () => {
  const env = setup();
  env.add(START);
  env.add({ ev: 'end', text: 'plan stage ended', status: 'READY' });
  env.addAt(20000, { ev: 'start', text: 'do stage started', pid: LIVE, stage: 'do' });
  writeFileSync(env.paths().plan, '1. 하나 (완료)\n2. 둘\n');
  let r = await run(env);
  assert.equal(r.at, 20000); // the unread end of the command before is printed with the new start
  assert.deepEqual(r.lines, ['start: plan stage started [stage=plan]', 'end: plan stage ended [status=READY]', 'start: do stage started [stage=do]', 'state: running (do, 0 min, 1 steps done)']);

  const idle = setup();
  idle.add(START);
  idle.add({ ev: 'end', text: 'plan stage ended', status: 'READY' });
  r = await run(idle);
  assert.equal(r.at, DEFAULTS.startWaitMs);
  assert.deepEqual(r.lines, ['start: plan stage started [stage=plan]', 'end: plan stage ended [status=READY]', 'state: ended']);
  // Nothing unread and nothing new: the state line alone, and the cursor stays.
  const cursor = idle.cursor();
  r = await run(idle);
  assert.equal(r.at, 2 * DEFAULTS.startWaitMs);
  assert.deepEqual(r.lines, ['state: ended']);
  assert.equal(idle.cursor(), cursor);
});

test('a stage that waits for another run keeps the wait for its start going past the start wait, up to maxLifeMs', async () => {
  const WAIT_NOTE = { ev: 'note', text: 'waiting for another run of this repository to end: other (do stage running)', stage: 'wait' };
  const env = setup();
  env.add(START);
  env.add({ ev: 'end', text: 'plan stage ended', status: 'READY' });
  env.addAt(1000, WAIT_NOTE);
  env.addAt(DEFAULTS.quietMs - 5000, { ev: 'start', text: 'do stage started', pid: LIVE, stage: 'do' });
  let r = await run(env);
  assert.equal(r.at, DEFAULTS.quietMs - 5000); // the unread end before is printed with the new start
  assert.deepEqual(r.lines.slice(-3), [`note: ${WAIT_NOTE.text} [stage=wait]`, 'start: do stage started [stage=do]', 'state: running (do, 0 min)']);

  // No start comes (the stage ends with WAIT): the note is printed at maxLifeMs with state: ended.
  const idle = setup();
  idle.add({ ...START, pid: 1 });
  idle.add(WAIT_NOTE);
  r = await run(idle);
  assert.equal(r.at, DEFAULTS.maxLifeMs);
  assert.deepEqual(r.lines, ['start: plan stage started [stage=plan]', `note: ${WAIT_NOTE.text} [stage=wait]`, 'state: ended']);

  // An old wait note (an interrupted wait) does not stretch it.
  const old = setup();
  old.add(WAIT_NOTE);
  await old.sleep(DEFAULTS.quietMs + 1000);
  r = await run(old);
  assert.equal(r.at, DEFAULTS.quietMs + 1000 + DEFAULTS.startWaitMs);
});

test('a start without a live pid is ended: the start wait, then the lines and state: ended', async () => {
  const env = setup();
  env.add({ ev: 'start', text: 'plan stage started', stage: 'plan', pid: 1 });
  const r = await run(env);
  assert.equal(r.at, DEFAULTS.startWaitMs);
  assert.deepEqual(r.lines, ['start: plan stage started [stage=plan]', 'state: ended']);
});

test('without an event file it waits the start wait and says state: ended', async () => {
  const env = setup({ folder: false });
  const r = await run(env);
  assert.equal(r.at, DEFAULTS.startWaitMs);
  assert.deepEqual(r.lines, ['state: ended']);
  assert.ok(!existsSync(env.dir));
});

test('the whole life never passes maxLifeMs, even with a batch time longer than what is left', async () => {
  const env = setup();
  env.add(START);
  let r = await run(env, { batchMs: 3600000 });
  assert.equal(r.at, DEFAULTS.maxLifeMs);
  assert.deepEqual(r.lines, ['start: plan stage started [stage=plan]', 'state: running (plan, 8 min)']);
  assert.equal(env.cursor(), String(env.size()));
  // No batch: the state line only.
  r = await run(env, { quietMs: 3600000 });
  assert.equal(r.at, 2 * DEFAULTS.maxLifeMs);
  assert.deepEqual(r.lines, ['state: running (plan, 17 min)']);
});

test('the cursor is replaced after the output, through a temporary file that does not stay', async () => {
  const env = setup();
  env.add(START);
  await run(env);
  const old = env.cursor();
  env.add({ ev: 'alert', text: 'blocked' });
  let seen;
  const r = await run(env, { onWrite: () => (seen = env.cursor()) });
  assert.deepEqual(r.lines, ['alert: blocked', 'state: running (plan, 0 min)']);
  assert.equal(seen, old);
  assert.equal(env.cursor(), String(env.size()));
  assert.ok(Number(env.cursor()) > Number(old));
  assert.deepEqual(readdirSync(env.dir).sort(), ['progress.jsonl', 'progress.terminal.cursor']);
});

test('a cursor that cannot be replaced costs nothing but a repeat: the output comes and the cursor stays', async () => {
  const env = setup();
  env.add(START);
  await run(env);
  const old = env.cursor();
  const tmp = `${env.paths().cursor}.${process.pid}.tmp`;
  mkdirSync(tmp);
  env.add({ ev: 'alert', text: 'blocked' });
  const r = await run(env);
  assert.deepEqual(r.lines, ['alert: blocked', 'state: running (plan, 0 min)']);
  assert.equal(env.cursor(), old);
  assert.ok(existsSync(tmp));
});

test('another wait that moves the cursor during the wait: no line twice, and the cursor never goes back', async () => {
  const env = setup();
  env.add(START);
  await run(env);
  env.addAt(31000, { ev: 'step', text: 'taken by the other wait' });
  env.at(40000, () => writeFileSync(env.paths().cursor, String(env.size())));
  env.addAt(50000, { ev: 'step', text: 'mine' });
  let r = await run(env);
  assert.equal(r.at, 50000 + DEFAULTS.batchMs); // the batch of 31 s was dropped; a new one began with the line seen at 50 s
  assert.deepEqual(r.lines, ['step: mine', 'state: running (plan, 1 min)']);
  assert.equal(env.cursor(), String(env.size()));

  // The other wait moves the cursor past this wait's read while it prints: the cursor stays ahead.
  env.add({ ev: 'alert', text: 'both saw this' });
  let ahead;
  r = await run(env, {
    onWrite: () => {
      env.add({ ev: 'note', text: 'later' });
      ahead = String(env.size());
      writeFileSync(env.paths().cursor, ahead);
    },
  });
  assert.deepEqual(r.lines, ['alert: both saw this', 'state: running (plan, 1 min)']);
  assert.equal(env.cursor(), ahead);

  // A cursor beyond a file that became shorter is replaced.
  writeFileSync(env.paths().events, '');
  env.add(START);
  env.add({ ev: 'alert', text: 'new file' });
  r = await run(env);
  assert.deepEqual(r.lines, ['start: plan stage started [stage=plan]', 'alert: new file', 'state: running (plan, 0 min)']);
  assert.equal(env.cursor(), String(env.size()));
});

test('an event file that cannot be read still ends the wait with 0', async () => {
  const env = setup();
  mkdirSync(env.paths().events);
  const r = await run(env);
  assert.ok(r.at <= DEFAULTS.maxLifeMs);
  assert.deepEqual(r.lines, ['state: ended']);
  assert.equal(env.cursor(), null);
  // Even an output that throws does not make the wait throw.
  const code = await wait(env.paths(), { now: env.now, sleep: env.sleep, alive, out: { write: () => { throw new Error('closed'); } } });
  assert.equal(code, 0);
});

test('a read error in the middle of a wait is no change, not an ended state', async () => {
  const env = setup();
  env.add(START);
  await run(env);
  const file = env.paths().events;
  const kept = readFileSync(file);
  env.at(40000, () => {
    rmSync(file);
    mkdirSync(file);
  });
  env.at(50000, () => {
    rmSync(file, { recursive: true });
    writeFileSync(file, kept);
    env.add({ ev: 'step', text: 'after the error' });
  });
  const r = await run(env);
  assert.equal(r.at, 50000 + DEFAULTS.batchMs);
  assert.deepEqual(r.lines, ['step: after the error', 'state: running (plan, 1 min)']);
});

// main on the virtual clock, with the output collected.
async function call(env, argv, opts = {}) {
  const writes = [];
  const code = await main(argv, { cwd: env.cwd, out: { write: (s) => writes.push(s) }, now: env.now, sleep: env.sleep, alive, ...opts });
  return { code, lines: writes.join('').trimEnd().split('\n') };
}

test('main: the consumer is terminal by default, and each consumer keeps its own cursor', async () => {
  const env = setup();
  env.add(START);
  env.add({ ev: 'alert', text: 'blocked' });
  const lines = ['start: plan stage started [stage=plan]', 'alert: blocked', 'state: running (plan, 0 min)'];
  let r = await call(env, [SLUG, '--consumer', 'main']);
  assert.deepEqual(r, { code: 0, lines });
  const mainCursor = env.cursor('main');
  assert.equal(mainCursor, String(env.size()));
  assert.equal(env.cursor('terminal'), null);
  r = await call(env, [SLUG]);
  assert.deepEqual(r, { code: 0, lines });
  assert.equal(env.cursor('terminal'), String(env.size()));
  assert.equal(env.cursor('main'), mainCursor);
  assert.deepEqual(readdirSync(env.dir).sort(), ['progress.jsonl', 'progress.main.cursor', 'progress.terminal.cursor']);
  // The flag may come first.
  env.add({ ev: 'alert', text: 'again' });
  r = await call(env, ['--consumer', 'main', SLUG]);
  assert.deepEqual(r, { code: 0, lines: ['alert: again', 'state: running (plan, 0 min)'] });
});

test('main: bad arguments end with code 1, the usage and state: ended, and create no cursor', async () => {
  const env = setup();
  env.add(START);
  const bad = [[], ['Bad'], ['-x'], ['a/b'], [SLUG, '--consumer', 'Main'], [SLUG, '--consumer', 'a_b'], [SLUG, '--consumer', ''], [SLUG, '--consumer'], [SLUG, '--other'], [SLUG, 'extra']];
  for (const argv of bad) {
    const r = await call(env, argv);
    assert.equal(r.code, 1, argv.join(' '));
    assert.equal(r.lines.length, 3, argv.join(' '));
    assert.equal(r.lines[1], 'usage: node progress.mjs <slug> [--consumer <name>]');
    assert.equal(r.lines[2], 'state: ended');
  }
  assert.equal(env.elapsed(), 0);
  assert.deepEqual(readdirSync(env.dir), ['progress.jsonl']);
});

test('the real command: a bad slug exits 1 with the same output', async () => {
  const env = setup();
  const r = spawnSync(process.execPath, [SCRIPT, 'Bad'], { cwd: env.cwd, encoding: 'utf8', timeout: 30000 });
  const same = await call(env, ['Bad']);
  assert.equal(r.status, 1);
  assert.equal(r.stderr, '');
  assert.deepEqual(r.stdout.trimEnd().split('\n'), same.lines);
  assert.deepEqual(same.lines, ['invalid slug: Bad', 'usage: node progress.mjs <slug> [--consumer <name>]', 'state: ended']);
});
