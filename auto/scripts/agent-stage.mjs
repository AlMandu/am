// am-auto:agent stage starter and ender (Claude Code only).
// The am-auto:agent driver runs each stage as a subagent of the user's session and calls this script around it, so that it
// starts, ends and relays nothing by its own judgment:
//   start <plan|do|check|commit> <slug> [--push] [--fix] [--part] [--dispatch <id>]
//     Under the start lock .am/.admission.lock, waits while another unattended run of this working tree goes on
//     (otherRuns of stage.mjs) or an open stage of this task does (any pid: the subagents share CLAUDE_PID), up to
//     WAIT_MS; then writes .am/<slug>/stage.json (this stage's record; its pid is CLAUDE_PID), skill-<stage>.md (the
//     skill with its arguments filled in), rules-<stage>.md (agentRules of stage.mjs) and a `start` event. Prints one
//     JSON line {agent, rules, skill, runId, model, effort, wait, note, error}: the Agent call to make, or why to wait or
//     what failed (the other keys null). --part: the slug is <owner>-p<k>, a part of <owner> (as in am-auto:one).
//     A task another session claimed and still runs (liveClaim of stage.mjs) is refused at once; with --dispatch <id> the
//     task's dispatch.json must be that dispatch, claimed by CLAUDE_PID.
//   end <slug> <runId> <status>
//     Under the start lock, ends the stage stage.json names when the runId matches and it is still open: an `end`
//     event and stage.json's status and ended. A status the stage cannot give becomes `failed`. Prints {ended, status, reason}.
//   dispatch <part> [--push]
//     Hands a part to another open session: reads `claude agents --json` outside the lock and picks an idle interactive
//     session of this folder (not the driver, not another dispatch's target, not a pid with an open stage.json; latest
//     startedAt first, a session no other part of the owner was given first, a name no other row has). Under the lock it
//     writes .am/<part>/dispatch.json, unless the part's last dispatch already ended with a commit (`done`) or is claimed
//     and live (`resume`). Prints {dispatchId, target, message, resume, done, none, error}.
//   claim <part> <id>          marks the open dispatch claimed by CLAUDE_PID ({claimed, reason}).
//   outcome <part> <id> <status> <stage|->   records the end of a dispatch CLAUDE_PID claimed, once ({recorded, reason}).
//   wait <part> <id>
//     Looks at the dispatch until it ends, is closed, its session is gone, it stays unclaimed or goes stale (the last
//     three close it under the lock), or about 9 minutes pass. Prints {state, status, stage, reason}; state is ended,
//     closed, gone, unclaimed, stale or running.
//   close <part> <id> <reason>   closes the dispatch while it is still open ({closed, reason}).
//   card <slug>
//     Prints every open decision card of plan.md (between `<!-- am:card OPEN -->` and `<!-- am:card end -->`), as written.
//   answer <slug> <file>
//     Writes the file's text under every open card of plan.md, as written, and marks the cards answered.
// The stage agents and claude-opinion are this plugin's (OWN_ROOT); the skills come from the core am (findCore), whose
// folder stage.json keeps as `core` for the stage hook. The model and effort are the stage agent's frontmatter, or the user models file's stage (else default) values; a model
// that is not an alias keeps the frontmatter's, with a note.
// Exit codes: 0 result printed (the failures of start, end and the dispatch commands are in their JSON line), 1 bad
// arguments or a file that cannot be read or used (card, answer), 2 no open card (card, answer).
// Node only, no dependencies.

import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { appendEvent, pidAlive, readFrom } from './progress.mjs';
import { AGENT_RECORD, AGENT_STAGES, AGENT_STALE_MS, DISPATCH_FILE, GRACE_MS, MARKS, POLL_MS, RECORD_SETTLE_MS, WAIT_MS, WORKER_STALE_MS, agentRules, claimedText, dispatchActivity, ensureIgnored, exec, inlineSkill, leaseOf, liveClaim, otherRuns, ownerState, readDispatch, skillCall, takeLock, taskState } from './stage.mjs';
import { OPINION_MODELS, frontmatterModels, readUserModels, resolveUser, userModelsFile } from './user-models.mjs';
import { findCore } from '../hooks/handover.mjs';

const OWN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = `usage: node agent-stage.mjs start <plan|do|check|commit> <slug> [--push] [--fix] [--part] [--dispatch <id>]
       node agent-stage.mjs end <slug> <runId> <status>
       node agent-stage.mjs dispatch <part> [--push]
       node agent-stage.mjs claim <part> <id>
       node agent-stage.mjs outcome <part> <id> <status> <plan|do|check|commit|->
       node agent-stage.mjs wait <part> <id>
       node agent-stage.mjs close <part> <id> <reason>
       node agent-stage.mjs card <slug>
       node agent-stage.mjs answer <slug> <file>
`;
const SLUG = /^[a-z0-9][a-z0-9-]*$/;
// A run ID or dispatch ID (newRunId).
const ID = /^[a-z0-9]+-[a-f0-9]{6}$/;
// How long `claude agents --json` may run.
export const LIST_MS = 2 * 60000;
// How long one `wait` looks before it prints `running`, and how long an open dispatch may stay unclaimed.
export const RELAY_WAIT_MS = 9 * 60000;
export const CLAIM_MS = 15 * 60000;
const DISPATCH_KEYS = ['dispatchId', 'target', 'message', 'resume', 'done', 'none', 'error'];
const WAIT_KEYS = ['state', 'status', 'stage', 'reason'];
// Commit-stage ends after which a part is done.
const COMMIT_DONE = ['COMMITTED', 'NOTHING'];
// A tracker that stops nothing: listing sessions leaves nothing to clean up.
const NO_TRACK = () => ({ start() {}, finish: async () => ({ count: 0, workingSetMB: 0 }) });
// How long `end` tries to take the start lock before it gives up and writes nothing.
export const LOCK_WAIT_MS = 30000;
const LOCK_POLL_MS = 200;
// The card marks of plan.md (agentRules tells the stage to write them); an answered card keeps its text.
export const CARD_OPEN = '<!-- am:card OPEN -->';
export const CARD_ANSWERED = '<!-- am:card answered -->';
export const CARD_END = '<!-- am:card end -->';
export const ANSWER_LINE = "User decision (the user's answer to this card, final):";
const CARD_PREFIX = '<!-- am:card';
export const MAX_ANSWER_BYTES = 64 * 1024;
const START_KEYS = ['agent', 'rules', 'skill', 'runId', 'model', 'effort', 'wait', 'note', 'error'];

/** A run ID: the time in base 36 and 6 random hex digits. */
export const newRunId = () => `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Writes a file through a temp file in the same folder: null, or the error text. */
function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, file);
    return null;
  } catch (err) {
    rmSync(tmp, { force: true });
    return String(err?.message || err);
  }
}

/** The arguments of `start`, or null. */
export function startArgs(argv) {
  const [stage, slug, ...rest] = argv;
  if (!AGENT_STAGES.includes(stage) || !SLUG.test(slug || '')) return null;
  const flags = [];
  let dispatch = null;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] !== '--dispatch') flags.push(rest[i]);
    else if (dispatch !== null || !ID.test(rest[i + 1] || '')) return null;
    else dispatch = rest[++i];
  }
  if (flags.some((f) => !['--push', '--fix', '--part'].includes(f)) || new Set(flags).size !== flags.length) return null;
  return { stage, slug, push: flags.includes('--push'), fix: flags.includes('--fix'), part: flags.includes('--part'), dispatch };
}

/** The Claude Code session that runs this script, from CLAUDE_PID: {pid}, or {error}. */
export function sessionPid(env, ppid, alive) {
  const pidText = String(env.CLAUDE_PID ?? '');
  const pid = /^[1-9]\d*$/.test(pidText) ? Number(pidText) : null;
  if (!pid) return { error: `CLAUDE_PID is not a process ID (${pidText ? JSON.stringify(pidText) : 'not set'}): run this script from the Bash tool of a Claude Code session` };
  if (pid === ppid) return { error: `CLAUDE_PID ${pid} is the shell that runs this script, not the Claude Code session` };
  if (!alive(pid)) return { error: `CLAUDE_PID ${pid} is not a running process` };
  return { pid };
}

/**
 * Runs fn under the start lock, waiting up to o.lockWaitMs for it, and releases it: {value} (what fn returned), or
 * {busy: reason} when the lock could not be taken (nothing was run).
 */
async function withLock(o, fn) {
  const lockFile = path.join(o.cwd, '.am', '.admission.lock');
  const began = Date.now();
  let lock = takeLock(lockFile, { now: o.now, alive: o.alive });
  while (lock && lock.busy !== undefined && Date.now() - began < o.lockWaitMs) {
    await sleep(Math.min(LOCK_POLL_MS, o.lockWaitMs));
    lock = takeLock(lockFile, { now: o.now, alive: o.alive });
  }
  if (!lock || lock.busy !== undefined) return { busy: lock ? `busy: the start lock is held (pid ${lock.busy ?? '?'}); nothing was written` : 'busy: the start lock cannot be made; nothing was written' };
  try {
    return { value: await fn() };
  } finally {
    lock.release();
  }
}

/** Runs `claude agents --json` (the claude command array): exec's result {code, stdout, stderr, timedOut, spawnError}. */
export function listAgents({ claude, cwd, env }) {
  const [cmd, ...pre] = claude;
  return exec(cmd, [...pre, 'agents', '--json'], { cwd, env, timeoutMs: LIST_MS, track: NO_TRACK });
}

/** The session rows of `claude agents --json` output (an array, or an object with one array value): {rows} or {error}. */
export function parseAgents(stdout) {
  let v;
  try {
    v = JSON.parse(String(stdout ?? '').trim());
  } catch {
    return { error: 'the output is not JSON' };
  }
  if (Array.isArray(v)) return { rows: v };
  const arrays = v && typeof v === 'object' ? Object.values(v).filter(Array.isArray) : [];
  return arrays.length === 1 ? { rows: arrays[0] } : { error: 'the output is not a list of sessions' };
}

/** A folder as compared with another: real path (else resolved), no trailing separator, lower case on Windows. */
function folderKey(p, platform) {
  let real;
  try {
    real = realpathSync(String(p));
  } catch {
    real = path.resolve(String(p));
  }
  const bare = real.replace(/[\\/]+$/, '') || real;
  return platform === 'win32' ? bare.toLowerCase() : bare;
}

/**
 * The sessions a part may be handed to, latest startedAt first: rows of kind `interactive`, status `idle`, cwd this folder,
 * not the driver's pid, with a name no other row has; as {name, sessionId, pid}. {candidates, none}: none is why there
 * are no candidates.
 */
export function pickSessions(rows, { cwd, driverPid, platform = process.platform }) {
  const list = rows.filter((r) => r && typeof r === 'object');
  const count = new Map();
  for (const r of list) if (typeof r.name === 'string') count.set(r.name, (count.get(r.name) || 0) + 1);
  const here = folderKey(cwd, platform);
  const idle = list.filter((r) => r.kind === 'interactive' && r.status === 'idle' && typeof r.cwd === 'string' && folderKey(r.cwd, platform) === here && Number(r.pid) !== driverPid && typeof r.name === 'string' && r.name);
  const started = (r) => {
    const t = typeof r.startedAt === 'number' ? r.startedAt : Date.parse(r.startedAt);
    return Number.isFinite(t) ? t : -Infinity;
  };
  const candidates = idle
    .filter((r) => count.get(r.name) === 1)
    .sort((a, b) => started(b) - started(a))
    .map((r) => ({ name: r.name, sessionId: r.sessionId ?? null, pid: Number.isInteger(Number(r.pid)) && Number(r.pid) > 0 ? Number(r.pid) : null }));
  if (candidates.length) return { candidates, none: null };
  return { candidates, none: idle.length ? 'only sessions whose name another session shares are idle in this folder' : 'no idle interactive session is open in this folder' };
}

/** The last `end` event of a task at or after ms, or null. */
function lastEndSince(dir, ms) {
  return readFrom(path.join(dir, 'progress.jsonl'), 0).events.findLast((e) => e.ev === 'end' && Date.parse(e.t) >= ms) ?? null;
}

const commitDone = (e) => Boolean(e) && e.stage === 'commit' && COMMIT_DONE.includes(e.status);

/**
 * A dispatch whose part is done: its recorded outcome is a commit end, or it is claimed by no live session (live: the
 * liveClaim) and the part's last end since claimedAt is a commit end. {status, stage}, or null.
 */
function finishedDispatch(d, dir, live) {
  if (!d) return null;
  if (d.state === 'ended') return commitDone(d.outcome) ? { status: d.outcome.status, stage: d.outcome.stage } : null;
  if (d.state !== 'claimed' || live || !Number.isFinite(d.claimedAt)) return null;
  const e = lastEndSince(dir, d.claimedAt);
  return commitDone(e) ? { status: e.status, stage: e.stage } : null;
}

/** The pids other dispatches and open stages of this working tree hold, apart from part's own dispatch. */
function busyPids(cwd, part, { now, alive, agentStaleMs }) {
  const am = path.join(cwd, '.am');
  const pids = new Set();
  let names = [];
  try {
    names = readdirSync(am, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    // No .am folder.
  }
  for (const name of names) {
    const dir = path.join(am, name);
    if (name !== part) {
      const d = readDispatch(dir);
      const live = d ? liveClaim(dir, { now, alive, staleMs: agentStaleMs }) : null;
      if (d && (d.state === 'open' || live)) {
        if (Number.isInteger(d.target?.pid)) pids.add(d.target.pid);
        if (live) pids.add(live.pid);
      }
    }
    const rec = readJson(path.join(dir, AGENT_RECORD));
    if (rec && typeof rec === 'object' && !rec.ended && Number.isInteger(rec.pid) && rec.pid > 0 && alive(rec.pid)) pids.add(rec.pid);
  }
  return pids;
}

/** The sessionIds earlier dispatches of the owner's other parts (.am/<owner>-p<k>/) went to. */
function usedSessions(cwd, owner, part) {
  const am = path.join(cwd, '.am');
  const re = new RegExp(`^${owner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-p\\d+$`);
  const used = new Set();
  let names = [];
  try {
    names = readdirSync(am, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== part && re.test(d.name)).map((d) => d.name);
  } catch {
    // No .am folder.
  }
  for (const name of names) {
    const id = readDispatch(path.join(am, name))?.target?.sessionId;
    if (id) used.add(id);
  }
  return used;
}

/** The message that hands a part to the target session. */
export function relayMessage({ cwd, ownRoot, part, id, push }) {
  const flow = `${ownRoot.split(path.sep).join('/')}/flow/relay-part.md`;
  return [
    `am-auto relay request: run part ${part} of ${cwd} (dispatch ${id}).`,
    `Repository root: ${cwd}`,
    `Flow file: ${flow}`,
    `Part: ${part}`,
    `Dispatch: ${id}`,
    `Push: ${push ? 'yes' : 'no'}`,
    'Read the flow file and follow it for this part. Do not reply to the sender.',
  ].join('\n');
}

/** The owner of a part slug (`<owner>-p<k>` whose request.md starts with its part line and whose owner has a plan), or {error}. */
export function partOwner(cwd, slug) {
  const m = /^(.+)-p(\d+)$/.exec(slug);
  if (!m) return { error: `--part needs a part slug <owner>-p<k>, not ${slug}` };
  const [, owner, k] = m;
  let request = '';
  try {
    request = readFileSync(path.join(cwd, '.am', slug, 'request.md'), 'utf8');
  } catch {
    return { error: `--part: no .am/${slug}/request.md` };
  }
  if (!new RegExp(`^Part ${k} of \\d+ of \\.am/${owner}/plan\\.md:`).test(request.replace(/^\uFEFF/, ''))) return { error: `--part: .am/${slug}/request.md does not start with \`Part ${k} of <N> of .am/${owner}/plan.md:\`` };
  if (!existsSync(path.join(cwd, '.am', owner, 'plan.md'))) return { error: `--part: no .am/${owner}/plan.md` };
  return { owner };
}

/**
 * The cards of a plan text: {cards: [{open, end, answered}] (line indexes of the marks), error}. A mark is a line that is
 * exactly one of the marks once trimmed (a line end `\r` included); a card mark inside a card, or an end outside one, is an error.
 */
export function findCards(text) {
  const lines = String(text).split('\n');
  const cards = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (l === CARD_OPEN || l === CARD_ANSWERED) {
      if (cur) return { cards, error: `line ${i + 1}: a card mark inside the card that starts on line ${cur.open + 1}` };
      cur = { open: i, answered: l === CARD_ANSWERED };
    } else if (l === CARD_END) {
      if (!cur) return { cards, error: `line ${i + 1}: a card end with no card before it` };
      cards.push({ ...cur, end: i });
      cur = null;
    }
  }
  if (cur) return { cards, error: `line ${cur.open + 1}: a card with no end` };
  return { cards, error: null };
}

const result = (out, obj) => {
  out.write(`${JSON.stringify(obj)}\n`);
  return 0;
};
const startLine = (fields) => Object.fromEntries(START_KEYS.map((k) => [k, fields[k] ?? null]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function start(argv, o) {
  const args = startArgs(argv);
  if (!args) {
    o.err.write(USAGE);
    return 1;
  }
  const { stage, slug, push, fix, part } = args;
  const { cwd, env, ownRoot, now, alive } = o;
  const fail = (error) => result(o.out, startLine({ error }));
  const session = sessionPid(env, o.ppid, alive);
  if (session.error) return fail(session.error);
  const { pid } = session;
  const userFile = userModelsFile(env);
  const user = readUserModels(userFile);
  if (user.error) return fail(`the user model settings cannot be used (fix or remove the file): ${user.error}`);
  // The stage agents are this plugin's; the stage skills come from the core am, looked up once.
  const core = o.core();
  if (core.error) return fail(`the am plugin cannot be used: ${core.error}`);
  const coreRoot = core.root;
  const agentName = stage === 'commit' && push ? 'stage-commit-push' : `stage-${stage}`;
  const fm = frontmatterModels(path.join(ownRoot, 'agents', `${agentName}.md`));
  if (fm.error) return fail(`the stage agent's model and effort cannot be read: ${fm.error}`);
  const picked = resolveUser(user, stage, fm);
  let note = null;
  if (!OPINION_MODELS.includes(picked.model)) {
    note = `model ${JSON.stringify(picked.model)} in ${userFile} is not one of ${OPINION_MODELS.join(', ')}; the stage agent's ${fm.model} is used`;
    picked.model = fm.model;
  }
  const dir = path.join(cwd, '.am', slug);
  if (stage === 'plan' && !existsSync(path.join(dir, 'request.md'))) return fail(`no .am/${slug}/request.md: write the request there first`);
  if (stage !== 'plan' && !existsSync(path.join(dir, 'plan.md'))) return fail(`no .am/${slug}/plan.md: run the plan stage first`);
  let owner = null;
  if (part) {
    const p = partOwner(cwd, slug);
    if (p.error) return fail(p.error);
    owner = p.owner;
  }
  try {
    ensureIgnored(cwd);
  } catch {
    // As in stage.mjs: a missing .gitignore never stops the stage.
  }
  const event = (fields) => appendEvent(cwd, slug, fields, { now });
  // This task's own open stage: a live start whose record is missing or fresh (or trusted for now) holds a new one.
  const ownOpen = (trust) => {
    const s = taskState(readFrom(path.join(dir, 'progress.jsonl'), 0).events, { now, alive, graceMs: o.graceMs });
    if (!s.live) return null;
    const lease = leaseOf(dir, s.pid, { staleMs: WORKER_STALE_MS, agentStaleMs: o.agentStaleMs });
    if (lease && !trust && ownerState(lease.file, { now, alive, staleMs: lease.ms }) !== 'live') return null;
    return `the ${s.stage || 'open'} stage of this task (pid ${s.pid}) has not ended`;
  };
  // A dispatch of this task: with --dispatch it must be this one, claimed by this session; without, no live claim may hold it.
  const dispatchProblem = () => {
    if (!args.dispatch) {
      const claim = liveClaim(dir, { now, alive, staleMs: o.agentStaleMs });
      return claim ? claimedText(slug, claim) : null;
    }
    const d = readDispatch(dir);
    const id = args.dispatch;
    if (!d) return `--dispatch ${id}: no readable .am/${slug}/${DISPATCH_FILE}`;
    if (d.id !== id) return `--dispatch ${id}: the dispatch of ${slug} is ${d.id ?? 'unknown'} now`;
    if (d.state !== 'claimed') return `--dispatch ${id}: the dispatch is ${d.state ?? 'unknown'}, not claimed`;
    if (d.claimedBy !== pid) return `--dispatch ${id}: the dispatch is claimed by pid ${d.claimedBy}, not this session (pid ${pid})`;
    return null;
  };
  const write = (runId) => {
    const rel = (name) => `.am/${slug}/${name}`;
    const record = path.join(dir, AGENT_RECORD);
    const recErr = writeAtomic(record, `${JSON.stringify({ pid, runId, stage, slug, push, fix, part, core: coreRoot, t: now() })}\n`);
    if (recErr) return { error: `could not write ${rel(AGENT_RECORD)}: ${recErr}` };
    try {
      const sc = skillCall(stage, slug, { push });
      writeFileSync(path.join(dir, `skill-${stage}.md`), inlineSkill(readFileSync(path.join(coreRoot, 'skills', sc.skill, 'SKILL.md'), 'utf8'), sc.args, coreRoot));
      writeFileSync(path.join(dir, `rules-${stage}.md`), agentRules(stage, slug, { push, fix, part, owner: owner ?? '', runId, ownRoot }));
      if (!event({ ev: 'start', text: `stage ${stage} started`, pid, stage })) throw new Error(`could not write ${rel('progress.jsonl')}`);
    } catch (err) {
      rmSync(record, { force: true });
      return { error: String(err?.message || err) };
    }
    return { agent: `am-auto:${agentName}`, rules: rel(`rules-${stage}.md`), skill: rel(`skill-${stage}.md`), runId, model: picked.model, effort: picked.effort, note };
  };
  const lockFile = path.join(cwd, '.am', '.admission.lock');
  const waitBegan = Date.now();
  let settleUntil = Date.now() + o.settleMs;
  let looked = Date.now();
  let noted = '';
  for (;;) {
    if (Date.now() - looked > o.pollMs * 2 + o.settleMs) settleUntil = Date.now() + o.settleMs;
    looked = Date.now();
    const trust = Date.now() < settleUntil;
    const lock = takeLock(lockFile, { now, alive });
    let blocked;
    if (lock && lock.busy !== undefined) blocked = { kind: 'repo', text: `another stage of this repository is starting (pid ${lock.busy ?? '?'})` };
    else {
      // Checked even when no lock file could be made, and never waited for.
      const problem = dispatchProblem();
      if (problem) {
        lock?.release();
        return fail(problem);
      }
      // No lock file could be made: as stage.mjs, the stage goes on unchecked.
      const own = lock ? ownOpen(trust) : null;
      const other = lock && !own ? otherRuns(cwd, slug, { now, alive, graceMs: o.graceMs, agentStaleMs: o.agentStaleMs, trustStale: trust, owner }) : { runs: [] };
      if (!own && !other.runs.length) {
        const done = write(o.newRunId());
        lock?.release();
        return result(o.out, startLine(done));
      }
      lock.release();
      blocked = own ? { kind: 'task', text: own } : { kind: 'repo', text: other.text };
    }
    if (noted !== blocked.kind) {
      noted = blocked.kind;
      event({ ev: 'note', text: blocked.kind === 'task' ? `waiting for this task's open stage to end: ${blocked.text}` : `waiting for another run of this repository to end: ${blocked.text}`, stage: 'wait' });
    }
    const left = o.waitMs - (Date.now() - waitBegan);
    if (left <= 0) return result(o.out, startLine({ wait: blocked.kind === 'task' ? `waiting for this task's open stage: ${blocked.text}` : `waiting for another run of this repository: ${blocked.text}`, note }));
    await sleep(Math.min(o.pollMs * (1 + Math.random() * 0.5), left));
  }
}

async function end(argv, o) {
  const [slug, runId, status, ...rest] = argv;
  if (!SLUG.test(slug || '') || !runId || !status || rest.length) {
    o.err.write(USAGE);
    return 1;
  }
  const { cwd, now } = o;
  const got = await withLock(o, () => {
    const record = path.join(cwd, '.am', slug, AGENT_RECORD);
    const rec = readJson(record);
    if (!rec || typeof rec !== 'object') return { ended: false, status: null, reason: `no readable .am/${slug}/${AGENT_RECORD}` };
    if (rec.runId !== runId) return { ended: false, status: null, reason: `runId ${runId} is not the stage's runId ${rec.runId}` };
    if (rec.ended) return { ended: false, status: rec.status ?? null, reason: `the stage of runId ${runId} has already ended` };
    const known = [...(MARKS[rec.stage] || []), 'BLOCKED', 'failed'];
    const final = known.includes(status) ? status : 'failed';
    const reason = final === status ? '' : `the stage gave an unknown status: ${status}`;
    const t = Number(rec.t);
    appendEvent(cwd, slug, { ev: 'end', text: reason || `${rec.stage} stage ended`, stage: rec.stage, status: final, min: Number.isFinite(t) ? Math.max(0, Math.floor((now() - t) / 60000)) : 0 }, { now });
    const recErr = writeAtomic(record, `${JSON.stringify({ ...rec, status: final, ended: now() })}\n`);
    return { ended: true, status: final, reason: recErr ? `${reason ? `${reason}; ` : ''}could not mark ${AGENT_RECORD} ended: ${recErr}` : reason };
  });
  return result(o.out, got.busy ? { ended: false, status: null, reason: got.busy } : got.value);
}

const dispatchLine = (fields) => Object.fromEntries(DISPATCH_KEYS.map((k) => [k, fields[k] ?? null]));
const waitLine = (fields) => Object.fromEntries(WAIT_KEYS.map((k) => [k, fields[k] ?? null]));
const dispatchRel = (part) => `.am/${part}/${DISPATCH_FILE}`;

/** The part and id of `claim`, `wait` (and the first two of `outcome` and `close`), or null. */
const partAndId = (part, id) => SLUG.test(part || '') && ID.test(id || '');

async function dispatch(argv, o) {
  const [part, ...flags] = argv;
  if (!SLUG.test(part || '') || flags.some((f) => f !== '--push') || flags.length > 1) {
    o.err.write(USAGE);
    return 1;
  }
  const push = flags.includes('--push');
  const { cwd, env, now, alive } = o;
  const fail = (error) => result(o.out, dispatchLine({ error }));
  const session = sessionPid(env, o.ppid, alive);
  if (session.error) return fail(session.error);
  const p = partOwner(cwd, part);
  if (p.error) return fail(p.error);
  // The session list is read outside the lock: it may take a while.
  let listed;
  try {
    listed = await o.listAgents({ claude: o.claude, cwd, env });
  } catch (err) {
    listed = { code: null, stdout: '', spawnError: String(err?.message || err) };
  }
  let rows = null;
  let none = null;
  if (listed?.spawnError) none = `list failed: ${listed.spawnError}`;
  else if (listed?.timedOut) none = `list failed: claude agents --json did not end within ${Math.round(LIST_MS / 1000)} seconds`;
  else if (listed?.code !== 0) none = `list failed: claude agents --json ended with code ${listed?.code}${String(listed?.stderr || '').trim() ? `: ${String(listed.stderr).trim().split('\n')[0].slice(0, 200)}` : ''}`;
  else {
    const parsed = parseAgents(listed.stdout);
    if (parsed.error) none = `list failed: ${parsed.error}`;
    else rows = parsed.rows;
  }
  const picked = rows ? pickSessions(rows, { cwd, driverPid: session.pid, platform: o.platform }) : { candidates: [], none };
  const dir = path.join(cwd, '.am', part);
  const got = await withLock(o, () => {
    const d = readDispatch(dir);
    const live = d ? liveClaim(dir, { now, alive, staleMs: o.agentStaleMs }) : null;
    const done = finishedDispatch(d, dir, live);
    if (done) return { dispatchId: d.id ?? null, target: d.target ?? null, done };
    if (live) return { dispatchId: d.id ?? null, target: d.target ?? null, resume: true };
    if (!picked.candidates.length) return { none: picked.none };
    const busy = busyPids(cwd, part, { now, alive, agentStaleMs: o.agentStaleMs });
    const free = picked.candidates.filter((c) => !(c.pid !== null && busy.has(c.pid)));
    if (!free.length) return { none: 'every idle session of this folder is the target of another dispatch or runs a stage' };
    const used = usedSessions(cwd, p.owner, part);
    const target = free.find((c) => !c.sessionId || !used.has(c.sessionId)) ?? free[0];
    const id = o.newDispatchId();
    const record = { id, part, target, driver: { pid: session.pid, sessionId: env.CLAUDE_CODE_SESSION_ID || null }, push, t: now(), state: 'open', claimedBy: null, claimedAt: null, reason: null, outcome: null };
    const writeErr = writeAtomic(path.join(dir, DISPATCH_FILE), `${JSON.stringify(record)}\n`);
    if (writeErr) return { error: `could not write ${dispatchRel(part)}: ${writeErr}` };
    return { dispatchId: id, target, message: relayMessage({ cwd, ownRoot: o.ownRoot, part, id, push }), resume: false };
  });
  return result(o.out, dispatchLine(got.busy ? { error: got.busy } : got.value));
}

/** Rewrites dispatch.json with fields: null, or the error text. */
const rewrite = (dir, d, fields) => writeAtomic(path.join(dir, DISPATCH_FILE), `${JSON.stringify({ ...d, ...fields })}\n`);

/** Why dispatch d is not dispatch id of part, or null. */
const notThis = (d, part, id) => (!d ? `no readable ${dispatchRel(part)}` : d.id !== id ? `dispatch ${id} is not the dispatch of ${part} (${d.id ?? 'unknown'})` : null);

async function claim(argv, o) {
  const [part, id, ...rest] = argv;
  if (!partAndId(part, id) || rest.length) {
    o.err.write(USAGE);
    return 1;
  }
  const session = sessionPid(o.env, o.ppid, o.alive);
  if (session.error) return result(o.out, { claimed: false, reason: session.error });
  const dir = path.join(o.cwd, '.am', part);
  const got = await withLock(o, () => {
    const d = readDispatch(dir);
    const wrong = notThis(d, part, id);
    if (wrong) return { claimed: false, reason: wrong };
    if (d.state === 'claimed' && d.claimedBy === session.pid) return { claimed: true, reason: 'already claimed by this session' };
    if (d.state === 'claimed') return { claimed: false, reason: `dispatch ${id} is claimed by pid ${d.claimedBy}` };
    if (d.state !== 'open') return { claimed: false, reason: `dispatch ${id} is ${d.state ?? 'unknown'}${d.reason ? ` (${d.reason})` : ''}` };
    const writeErr = rewrite(dir, d, { state: 'claimed', claimedBy: session.pid, claimedAt: o.now() });
    return writeErr ? { claimed: false, reason: `could not write ${dispatchRel(part)}: ${writeErr}` } : { claimed: true, reason: '' };
  });
  return result(o.out, got.busy ? { claimed: false, reason: got.busy } : got.value);
}

async function outcome(argv, o) {
  const [part, id, status, stage, ...rest] = argv;
  const known = stage === '-' ? ['unable'] : AGENT_STAGES.includes(stage) ? [...MARKS[stage], 'BLOCKED', 'failed'] : [];
  if (!partAndId(part, id) || !known.includes(status) || rest.length) {
    o.err.write(USAGE);
    return 1;
  }
  const session = sessionPid(o.env, o.ppid, o.alive);
  if (session.error) return result(o.out, { recorded: false, reason: session.error });
  const dir = path.join(o.cwd, '.am', part);
  const got = await withLock(o, () => {
    const d = readDispatch(dir);
    const wrong = notThis(d, part, id);
    if (wrong) return { recorded: false, reason: wrong };
    if (d.state === 'ended') return { recorded: false, reason: `dispatch ${id} has already ended (${d.outcome?.status ?? '?'})` };
    if (d.state !== 'claimed') return { recorded: false, reason: `dispatch ${id} is ${d.state ?? 'unknown'}, not claimed` };
    if (d.claimedBy !== session.pid) return { recorded: false, reason: `dispatch ${id} is claimed by pid ${d.claimedBy}, not this session (pid ${session.pid})` };
    const writeErr = rewrite(dir, d, { state: 'ended', outcome: { status, stage: stage === '-' ? null : stage, t: o.now() } });
    return writeErr ? { recorded: false, reason: `could not write ${dispatchRel(part)}: ${writeErr}` } : { recorded: true, reason: '' };
  });
  return result(o.out, got.busy ? { recorded: false, reason: got.busy } : got.value);
}

async function close(argv, o) {
  const [part, id, reason, ...rest] = argv;
  if (!partAndId(part, id) || !String(reason || '').trim() || rest.length) {
    o.err.write(USAGE);
    return 1;
  }
  const dir = path.join(o.cwd, '.am', part);
  const got = await withLock(o, () => {
    const d = readDispatch(dir);
    const wrong = notThis(d, part, id);
    if (wrong) return { closed: false, reason: wrong };
    if (d.state !== 'open') return { closed: false, reason: `dispatch ${id} is ${d.state ?? 'unknown'}, not open` };
    const writeErr = rewrite(dir, d, { state: 'closed', reason });
    return writeErr ? { closed: false, reason: `could not write ${dispatchRel(part)}: ${writeErr}` } : { closed: true, reason };
  });
  return result(o.out, got.busy ? { closed: false, reason: got.busy } : got.value);
}

async function wait(argv, o) {
  const [part, id, ...rest] = argv;
  if (!partAndId(part, id) || rest.length) {
    o.err.write(USAGE);
    return 1;
  }
  const { now, alive } = o;
  const dir = path.join(o.cwd, '.am', part);
  const file = path.join(dir, DISPATCH_FILE);
  // Closes the dispatch as `state` when it is still as it was seen and `still()` still holds under the lock (a start may have
  // run while this waited for the lock): the result line, or null to look again.
  const closeAs = async (seen, state, text, still) => {
    const got = await withLock(o, () => {
      const d = readDispatch(dir);
      if (!d || d.id !== seen.id || d.state !== seen.state || d.claimedBy !== seen.claimedBy || !still()) return null;
      return rewrite(dir, d, { state: 'closed', reason: `${state}: ${text}` }) ? null : waitLine({ state, reason: text });
    });
    return got.busy ? null : got.value;
  };
  const look = async () => {
    const d = readDispatch(dir);
    // An unreadable record (it may be being replaced) is looked at again; a missing one or another id was superseded.
    if (!d) return existsSync(file) ? null : waitLine({ state: 'closed', reason: 'superseded' });
    if (d.id !== id) return waitLine({ state: 'closed', reason: 'superseded' });
    if (d.state === 'closed') return waitLine({ state: 'closed', reason: d.reason ?? null });
    if (d.state === 'ended') return waitLine({ state: 'ended', status: d.outcome?.status, stage: d.outcome?.stage });
    const claimed = d.state === 'claimed';
    const live = claimed ? liveClaim(dir, { now, alive, staleMs: o.agentStaleMs }) : null;
    const done = finishedDispatch(d, dir, live);
    if (done) return waitLine({ state: 'ended', status: done.status, stage: done.stage });
    const pid = claimed ? d.claimedBy : d.target?.pid;
    if (Number.isInteger(pid) && pid > 0 && !alive(pid)) return closeAs(d, 'gone', claimed ? `the session that claimed it (pid ${pid}) is not running` : `the target session (pid ${pid}) is not running`, () => !alive(pid));
    if (!claimed && now() - Number(d.t) > o.claimMs) return closeAs(d, 'unclaimed', `not claimed within ${Math.round(o.claimMs / 60000)} minutes`, () => true);
    const stale = () => now() - dispatchActivity(dir) > o.agentStaleMs;
    if (claimed && stale()) return closeAs(d, 'stale', `no activity for ${Math.round(o.agentStaleMs / 60000)} minutes`, stale);
    return null;
  };
  const began = Date.now();
  for (;;) {
    const r = await look();
    if (r) return result(o.out, r);
    const left = o.relayWaitMs - (Date.now() - began);
    if (left <= 0) return result(o.out, waitLine({ state: 'running' }));
    await sleep(Math.min(o.relayPollMs, left));
  }
}

function readPlanText(o, slug) {
  try {
    return readFileSync(path.join(o.cwd, '.am', slug, 'plan.md'), 'utf8');
  } catch (err) {
    o.err.write(`cannot read .am/${slug}/plan.md: ${err?.message || err}\n`);
    return null;
  }
}

function card(argv, o) {
  const [slug, ...rest] = argv;
  if (!SLUG.test(slug || '') || rest.length) {
    o.err.write(USAGE);
    return 1;
  }
  const text = readPlanText(o, slug);
  if (text === null) return 1;
  const { cards, error } = findCards(text);
  if (error) {
    o.err.write(`.am/${slug}/plan.md: ${error}\n`);
    return 1;
  }
  const lines = text.split('\n');
  const open = cards.filter((c) => !c.answered).map((c) => lines.slice(c.open + 1, c.end).map((l) => l.replace(/\r$/, '')).join('\n'));
  if (!open.length) {
    o.err.write(`.am/${slug}/plan.md has no open card\n`);
    return 2;
  }
  o.out.write(`${open.join('\n\n')}\n`);
  return 0;
}

function answer(argv, o) {
  const [slug, file, ...rest] = argv;
  if (!SLUG.test(slug || '') || !file || rest.length) {
    o.err.write(USAGE);
    return 1;
  }
  const { cwd, alive } = o;
  const rec = readJson(path.join(cwd, '.am', slug, AGENT_RECORD));
  if (rec && typeof rec === 'object' && !rec.ended && Number.isInteger(rec.pid) && rec.pid > 0 && alive(rec.pid)) {
    o.err.write(`the ${rec.stage} stage of .am/${slug} is still open (runId ${rec.runId}): end it first\n`);
    return 1;
  }
  const abs = path.resolve(cwd, file);
  let reply;
  try {
    if (statSync(abs).size > MAX_ANSWER_BYTES) {
      o.err.write(`${file} is larger than ${MAX_ANSWER_BYTES} bytes\n`);
      return 1;
    }
    reply = readFileSync(abs, 'utf8').replace(/^\uFEFF/, '');
  } catch (err) {
    o.err.write(`cannot read ${file}: ${err?.message || err}\n`);
    return 1;
  }
  if (!reply.trim()) {
    o.err.write(`${file} is empty\n`);
    return 1;
  }
  const answerLines = reply.replace(/(\r?\n)+$/, '').split(/\r?\n/);
  if (answerLines.some((l) => l.trimStart().startsWith(CARD_PREFIX))) {
    o.err.write(`${file} holds a line that starts with ${CARD_PREFIX}\n`);
    return 1;
  }
  const text = readPlanText(o, slug);
  if (text === null) return 1;
  const { cards, error } = findCards(text);
  if (error) {
    o.err.write(`.am/${slug}/plan.md: ${error}\n`);
    return 1;
  }
  const open = cards.filter((c) => !c.answered);
  if (!open.length) {
    o.err.write(`.am/${slug}/plan.md has no open card\n`);
    return 2;
  }
  const lines = text.split('\n');
  // From the last card back, so the line indexes of the earlier ones hold.
  for (const c of [...open].reverse()) {
    const cr = lines[c.end].endsWith('\r') ? '\r' : '';
    const indent = (l) => /^\s*/.exec(l)[0];
    lines.splice(c.end, 0, `${ANSWER_LINE}${cr}`, ...answerLines.map((l) => `${l}${cr}`));
    lines[c.open] = `${indent(lines[c.open])}${CARD_ANSWERED}${lines[c.open].endsWith('\r') ? '\r' : ''}`;
  }
  const writeErr = writeAtomic(path.join(cwd, '.am', slug, 'plan.md'), lines.join('\n'));
  if (writeErr) {
    o.err.write(`cannot write .am/${slug}/plan.md: ${writeErr}\n`);
    return 1;
  }
  return result(o.out, { answered: open.length });
}

/** Runs one subcommand. Returns the exit code. */
export async function main(argv, { cwd = process.cwd(), env = process.env, ownRoot = OWN_ROOT, core = () => findCore(), out = process.stdout, err = process.stderr, now = Date.now, alive = pidAlive, ppid = process.ppid, pollMs = POLL_MS, waitMs = WAIT_MS, graceMs = GRACE_MS, settleMs = RECORD_SETTLE_MS, agentStaleMs = AGENT_STALE_MS, lockWaitMs = LOCK_WAIT_MS, newRunId: makeRunId = newRunId, newDispatchId = newRunId, claude = ['claude'], listAgents: list = listAgents, platform = process.platform, relayWaitMs = RELAY_WAIT_MS, relayPollMs = POLL_MS, claimMs = CLAIM_MS } = {}) {
  const o = { cwd, env, ownRoot, core, out, err, now, alive, ppid, pollMs, waitMs, graceMs, settleMs, agentStaleMs, lockWaitMs, newRunId: makeRunId, newDispatchId, claude, listAgents: list, platform, relayWaitMs, relayPollMs, claimMs };
  const [command, ...rest] = argv;
  if (command === 'start') return start(rest, o);
  if (command === 'end') return end(rest, o);
  if (command === 'dispatch') return dispatch(rest, o);
  if (command === 'claim') return claim(rest, o);
  if (command === 'outcome') return outcome(rest, o);
  if (command === 'wait') return wait(rest, o);
  if (command === 'close') return close(rest, o);
  if (command === 'card') return card(rest, o);
  if (command === 'answer') return answer(rest, o);
  err.write(USAGE);
  return 1;
}

const isMain = () => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
};

if (isMain()) {
  main(process.argv.slice(2), { env: process.env }).then((code) => {
    process.exitCode = code;
  });
}
