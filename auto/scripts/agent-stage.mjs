// am:lean stage starter and ender (Claude Code only).
// The am:lean driver runs each stage as a subagent of the user's session and calls this script around it, so that it
// starts, ends and relays nothing by its own judgment:
//   start <plan|do|check|commit> <slug> [--push] [--fix] [--part]
//     Under the start lock .am/.admission.lock, waits while another unattended run of this working tree goes on
//     (otherRuns of stage.mjs) or an open stage of this task does (any pid: the subagents share CLAUDE_PID), up to
//     WAIT_MS; then writes .am/<slug>/stage.json (this stage's record; its pid is CLAUDE_PID), skill-<stage>.md (the
//     skill with its arguments filled in), rules-<stage>.md (agentRules of stage.mjs) and a `start` event. Prints one
//     JSON line {agent, rules, skill, runId, model, effort, wait, note, error}: the Agent call to make, or why to wait or
//     what failed (the other keys null). --part: the slug is <owner>-p<k>, a part of <owner> (as in am:solo).
//   end <slug> <runId> <status>
//     Under the start lock, ends the stage stage.json names when the runId matches and it is still open: an `end`
//     event and stage.json's status and ended. A status the stage cannot give becomes `failed`. Prints {ended, status, reason}.
//   card <slug>
//     Prints every open decision card of plan.md (between `<!-- am:card OPEN -->` and `<!-- am:card end -->`), as written.
//   answer <slug> <file>
//     Writes the file's text under every open card of plan.md, as written, and marks the cards answered.
// The stage agents and claude-opinion are this plugin's (OWN_ROOT); the skills come from the core am (findCore), whose
// folder stage.json keeps as `core` for the stage hook. The model and effort are the stage agent's frontmatter, or the user models file's stage (else default) values; a model
// that is not an alias keeps the frontmatter's, with a note.
// Exit codes: 0 result printed (start's and end's failures are in their JSON line), 1 bad arguments or a file that cannot
// be read or used (card, answer), 2 no open card (card, answer).
// Node only, no dependencies.

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { appendEvent, pidAlive, readFrom } from './progress.mjs';
import { AGENT_RECORD, AGENT_STAGES, AGENT_STALE_MS, GRACE_MS, MARKS, POLL_MS, RECORD_SETTLE_MS, WAIT_MS, WORKER_STALE_MS, agentRules, ensureIgnored, inlineSkill, leaseOf, otherRuns, ownerState, skillCall, takeLock, taskState } from './stage.mjs';
import { OPINION_MODELS, frontmatterModels, readUserModels, resolveUser, userModelsFile } from './user-models.mjs';
import { findCore } from '../hooks/handover.mjs';

const OWN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = `usage: node agent-stage.mjs start <plan|do|check|commit> <slug> [--push] [--fix] [--part]
       node agent-stage.mjs end <slug> <runId> <status>
       node agent-stage.mjs card <slug>
       node agent-stage.mjs answer <slug> <file>
`;
const SLUG = /^[a-z0-9][a-z0-9-]*$/;
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
  const [stage, slug, ...flags] = argv;
  if (!AGENT_STAGES.includes(stage) || !SLUG.test(slug || '')) return null;
  if (flags.some((f) => !['--push', '--fix', '--part'].includes(f)) || new Set(flags).size !== flags.length) return null;
  return { stage, slug, push: flags.includes('--push'), fix: flags.includes('--fix'), part: flags.includes('--part') };
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
  const pidText = String(env.CLAUDE_PID ?? '');
  const pid = /^[1-9]\d*$/.test(pidText) ? Number(pidText) : null;
  if (!pid) return fail(`CLAUDE_PID is not a process ID (${pidText ? JSON.stringify(pidText) : 'not set'}): run this script from the Bash tool of a Claude Code session`);
  if (pid === o.ppid) return fail(`CLAUDE_PID ${pid} is the shell that runs this script, not the Claude Code session`);
  if (!alive(pid)) return fail(`CLAUDE_PID ${pid} is not a running process`);
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
  const { cwd, now, alive } = o;
  const lockFile = path.join(cwd, '.am', '.admission.lock');
  const began = Date.now();
  let lock = takeLock(lockFile, { now, alive });
  while (lock && lock.busy !== undefined && Date.now() - began < o.lockWaitMs) {
    await sleep(Math.min(LOCK_POLL_MS, o.lockWaitMs));
    lock = takeLock(lockFile, { now, alive });
  }
  if (!lock || lock.busy !== undefined) return result(o.out, { ended: false, status: null, reason: lock ? `busy: the start lock is held (pid ${lock.busy ?? '?'}); nothing was written` : 'busy: the start lock cannot be made; nothing was written' });
  try {
    const record = path.join(cwd, '.am', slug, AGENT_RECORD);
    const rec = readJson(record);
    if (!rec || typeof rec !== 'object') return result(o.out, { ended: false, status: null, reason: `no readable .am/${slug}/${AGENT_RECORD}` });
    if (rec.runId !== runId) return result(o.out, { ended: false, status: null, reason: `runId ${runId} is not the stage's runId ${rec.runId}` });
    if (rec.ended) return result(o.out, { ended: false, status: rec.status ?? null, reason: `the stage of runId ${runId} has already ended` });
    const known = [...(MARKS[rec.stage] || []), 'BLOCKED', 'failed'];
    const final = known.includes(status) ? status : 'failed';
    const reason = final === status ? '' : `the stage gave an unknown status: ${status}`;
    const t = Number(rec.t);
    appendEvent(cwd, slug, { ev: 'end', text: reason || `${rec.stage} stage ended`, stage: rec.stage, status: final, min: Number.isFinite(t) ? Math.max(0, Math.floor((now() - t) / 60000)) : 0 }, { now });
    const recErr = writeAtomic(record, `${JSON.stringify({ ...rec, status: final, ended: now() })}\n`);
    return result(o.out, { ended: true, status: final, reason: recErr ? `${reason ? `${reason}; ` : ''}could not mark ${AGENT_RECORD} ended: ${recErr}` : reason });
  } finally {
    lock.release();
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
export async function main(argv, { cwd = process.cwd(), env = process.env, ownRoot = OWN_ROOT, core = () => findCore(), out = process.stdout, err = process.stderr, now = Date.now, alive = pidAlive, ppid = process.ppid, pollMs = POLL_MS, waitMs = WAIT_MS, graceMs = GRACE_MS, settleMs = RECORD_SETTLE_MS, agentStaleMs = AGENT_STALE_MS, lockWaitMs = LOCK_WAIT_MS, newRunId: makeRunId = newRunId } = {}) {
  const o = { cwd, env, ownRoot, core, out, err, now, alive, ppid, pollMs, waitMs, graceMs, settleMs, agentStaleMs, lockWaitMs, newRunId: makeRunId };
  const [command, ...rest] = argv;
  if (command === 'start') return start(rest, o);
  if (command === 'end') return end(rest, o);
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
