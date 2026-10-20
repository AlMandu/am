// am-auto:agent stage guard (Claude Code only).
// stage-hook.mjs sends here only the hook input of the five stage agents (`agent_type` am-auto:stage-*): PreToolUse of the
// shell tools and the file tools (the Bash|PowerShell and Write|Edit|MultiEdit|NotebookEdit groups of hooks.json) and
// SubagentStop. A stage agent runs inside the user's session, so what this module allows runs without a question: each
// stage gets its own allow list and everything else is denied. On every tool call it also binds the task's open stage
// record .am/<slug>/stage.json (written by scripts/agent-stage.mjs) to the agent that first used it and touches the record
// as a heartbeat. The plan stage may run codex-opinion.mjs of this plugin, of the record's `core` am (outside the repository)
// or of the development sibling ../plugin, and claude-opinion.mjs of this plugin only. SubagentStop blocks once when the final answer is not the one status line `AM_STAGE: <status> <runId>`.
// Node only, no dependencies.

import { lstatSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { denyOutput, findRepoRoot, gitSubcommand, programName, shellCommands } from './gate.mjs';
import { AGENT_RECORD, AGENT_STALE_MS, MARKS } from '../scripts/stage.mjs';
import { isCore } from './handover.mjs';
import { pidAlive } from '../scripts/progress.mjs';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The five stage agents: the stage each runs, and whether it may push.
export const STAGE_AGENTS = {
  'am-auto:stage-plan': { stage: 'plan', push: false },
  'am-auto:stage-do': { stage: 'do', push: false },
  'am-auto:stage-check': { stage: 'check', push: false },
  'am-auto:stage-commit': { stage: 'commit', push: false },
  'am-auto:stage-commit-push': { stage: 'commit', push: true },
};
export const STAGE_PREFIX = 'am-auto:stage-';
// The agent a stage record is bound to: written once per runId by the first tool call that finds the record.
export const CLAIM_FILE = 'stage-claim.json';
export const COMMIT_MESSAGE = 'commit-message.txt';
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const RUN_ID = /^[a-z0-9]+-[a-f0-9]{6}$/;

// plan and commit: a raw command holding one of these is refused before it is read (no expansion, redirection or chain).
const SPECIAL = /[$`<>|;&(){}\\\n\r]/;
const GLOB = /[*?[\]~!]/;
const GIT_READ = ['status', 'diff', 'log', 'ls-files', 'check-ignore', 'rev-parse'];
// git options that write a file, run a program or point git elsewhere; long ones also in git's shortened form.
const BAD_LONG = ['--output', '--ext-diff', '--textconv', '--exec-path', '--git-dir', '--work-tree'];
const BAD_SHORT = /^-[ocC]/;
// do and check: git subcommands that change history or the checked-out branch.
const HISTORY = new Set(['commit', 'push', 'reset', 'switch', 'checkout']);
const SESSION_BINS = new Set(['claude', 'codex']);
// Files of .am/<slug>/ the plan stage may not write: the stage record, its claim, the event file and the files agent-stage writes.
const RECORD_FILES = [/^stage\.json$/i, /^stage-claim\.json$/i, /^progress\.jsonl$/i, /^rules-.*\.md$/i, /^skill-.*\.md$/i];
const COMMIT_FILES = ['commits.md', 'handoff.md', 'reply-commit.md', COMMIT_MESSAGE];

const slash = (p) => p.split(path.sep).join('/');

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function allowOutput(reason) {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: reason } }) + '\n';
}

const deny = (reason) => ({ allow: false, reason });
const allow = (reason) => ({ allow: true, reason });

// ------------------------------------------------------------------ record

/**
 * The open stage record of this stage in the repository: {file, dir, slug, rec} or {error}. Open: no `ended`, the same stage
 * and push, a live pid (and the hook's CLAUDE_PID when it is a positive integer). User decision C1: the one started last,
 * unless two or more were touched within `staleMs`.
 */
// push is a mode of the whole run (agent-stage.mjs takes --push on every stage) but picks an agent only for commit.
export function findRecord(root, stage, push, { now = Date.now, alive = pidAlive, staleMs = AGENT_STALE_MS, pid = null } = {}) {
  let names = [];
  try {
    names = readdirSync(path.join(root, '.am'));
  } catch {
    /* no .am folder */
  }
  const open = [];
  for (const name of names) {
    if (!SLUG.test(name)) continue;
    const file = path.join(root, '.am', name, AGENT_RECORD);
    const rec = readJson(file);
    if (!rec || typeof rec !== 'object' || rec.ended || rec.stage !== stage || (stage === 'commit' && Boolean(rec.push) !== push)) continue;
    if (!Number.isInteger(rec.pid) || rec.pid <= 0 || !alive(rec.pid)) continue;
    if (pid !== null && rec.pid !== pid) continue;
    let mtime = 0;
    try {
      mtime = statSync(file).mtimeMs;
    } catch {
      continue;
    }
    open.push({ file, dir: path.dirname(file), slug: name, rec, mtime });
  }
  if (open.length === 0) return { error: `no open ${stage} stage record (.am/<slug>/${AGENT_RECORD}) was found in this repository; start the stage with agent-stage.mjs first` };
  const recent = open.filter((o) => now() - o.mtime <= staleMs);
  if (recent.length > 1) return { error: `${recent.length} open ${stage} stage records are active (${recent.map((o) => o.slug).join(', ')}); this hook cannot tell which one this agent runs` };
  return open.reduce((a, b) => (Number(b.rec.t) > Number(a.rec.t) ? b : a));
}

/** Touches the record as the stage's heartbeat; a failure is swallowed. */
export function heartbeat(file, now = Date.now) {
  try {
    const t = now() / 1000;
    utimesSync(file, t, t);
  } catch {
    /* the heartbeat never changes a decision */
  }
}

/** Binds the record's runId to the first agent that uses it: null when this agent may go on, else the reason. */
export function claim(dir, runId, agentId, now = Date.now) {
  if (typeof agentId !== 'string' || agentId === '') return 'the hook input has no agent_id, so this call cannot be tied to the stage';
  const file = path.join(dir, CLAIM_FILE);
  const text = `${JSON.stringify({ runId, agentId, t: now() })}\n`;
  try {
    writeFileSync(file, text, { flag: 'wx' });
    return null;
  } catch (err) {
    if (err?.code !== 'EEXIST') return `could not write ${CLAIM_FILE}: ${err?.message || err}`;
  }
  const held = readJson(file);
  if (held && held.runId === runId) return held.agentId === agentId ? null : `this stage (runId ${runId}) belongs to another agent (${held.agentId})`;
  // A claim of an earlier stage: bind this one anew.
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, file);
    return null;
  } catch (err) {
    rmSync(tmp, { force: true });
    return `could not write ${CLAIM_FILE}: ${err?.message || err}`;
  }
}

// ------------------------------------------------------------------ shell

/** Words of a plain command line with quotes removed, or {error}: an unclosed quote, or a glob or history character outside quotes. */
export function plainWords(command) {
  const words = [];
  let buf = '';
  let has = false;
  let quote = null;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else buf += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (ch === ' ' || ch === '\t') {
      if (has) words.push(buf);
      buf = '';
      has = false;
    } else if (GLOB.test(ch)) {
      return { error: `the character ${ch} outside quotes` };
    } else {
      buf += ch;
      has = true;
    }
  }
  if (quote) return { error: 'a quote that is not closed' };
  if (has) words.push(buf);
  return { words };
}

/** The first git option of `words` this guard refuses, or null. */
function badOption(words) {
  for (const w of words) {
    if (w.startsWith('--')) {
      const flag = w.split('=')[0];
      if (BAD_LONG.some((b) => b === flag || (flag.length >= 5 && b.startsWith(flag)))) return w;
    } else if (BAD_SHORT.test(w)) return w;
  }
  return null;
}

const PLAIN_HINT = 'Run one plain command with no shell characters.';

/** The plan and commit stages: one plain command from the stage's list. */
function strictShell(command, { stage, push, slug, root, pluginRoots, coreRoots: cores }) {
  if (SPECIAL.test(command)) {
    const hint = stage === 'commit' ? ` For a commit message, write it to .am/${slug}/${COMMIT_MESSAGE} with the Write tool and run git commit -F .am/${slug}/${COMMIT_MESSAGE}.` : '';
    return deny(`am stage hook: the ${stage} stage runs only plain commands, and this one holds a shell character ($ \` < > | ; & ( ) { } \\ or a line break).${hint || ` ${PLAIN_HINT}`}`);
  }
  const parsed = plainWords(command);
  if (parsed.error) return deny(`am stage hook: the ${stage} stage refused this command (${parsed.error}). Quote the word or ${PLAIN_HINT.toLowerCase()}`);
  const words = parsed.words;
  if (words[0] === 'git') return stageGit(words.slice(1), { stage, push, slug, root });
  if (words[0] === 'node' && stage === 'plan') return opinionScript(words.slice(1), { slug, pluginRoots, coreRoots: cores });
  return deny(`am stage hook: the ${stage} stage may not run ${JSON.stringify(words[0] ?? '')}. ${stage === 'plan' ? 'It runs read-only git commands and the second-opinion scripts of the skill only.' : 'It runs git status, diff, log, ls-files, check-ignore, rev-parse, add, commit and restore --staged only.'}`);
}

function stageGit(args, { stage, push, slug, root }) {
  const [sub, ...rest] = args;
  if (sub === undefined || sub.startsWith('-')) return deny('am stage hook: run git in its plain form `git <subcommand> …`, with no option before the subcommand (no -C, -c, --no-pager).');
  const bad = badOption(rest);
  if (bad) return deny(`am stage hook: the git option ${bad} is refused in a stage (it writes a file, runs a program or points git elsewhere).`);
  if (GIT_READ.includes(sub)) return allow(`am stage hook: git ${sub} is allowed in the ${stage} stage`);
  if (stage === 'commit') {
    if (sub === 'add') return allow('am stage hook: git add is allowed in the commit stage');
    if (sub === 'commit') return commitArgs(rest, { slug, root });
    if (sub === 'restore') {
      if (rest[0] === '--staged' && rest[1] === '--' && rest.length > 2) return allow('am stage hook: git restore --staged is allowed in the commit stage');
      return deny('am stage hook: the only restore form allowed is git restore --staged -- <paths>.');
    }
    if (sub === 'push') {
      if (!push) return deny('am stage hook: this commit stage does not push.');
      return pushArgs(rest);
    }
  }
  return deny(`am stage hook: git ${sub} is not allowed in the ${stage} stage.`);
}

function commitArgs(rest, { slug, root }) {
  const file = `.am/${slug}/${COMMIT_MESSAGE}`;
  const hint = `write the message to ${file} with the Write tool and run git commit -F ${file}, or use -m with a message of plain words.`;
  if (rest.length === 2 && rest[0] === '-F' && rest[1] === file) {
    try {
      if (lstatSync(path.join(root, file)).isSymbolicLink()) return deny(`am stage hook: ${file} is a symbolic link; write it as a plain file.`);
    } catch {
      /* missing: git reports it */
    }
    return allow('am stage hook: git commit with the message file is allowed in the commit stage');
  }
  const pairs = rest.length > 0 && rest.length % 2 === 0 && rest.every((w, i) => (i % 2 === 0 ? w === '-m' : true));
  if (pairs) return allow('am stage hook: git commit -m is allowed in the commit stage');
  return deny(`am stage hook: git commit takes only -m <message> or -F ${file} here; ${hint}`);
}

function pushArgs(rest) {
  const args = rest[0] === '-u' || rest[0] === '--set-upstream' ? rest.slice(1) : rest;
  const [remote, branch, ...more] = args;
  const ok = more.length === 0 &&
    (remote === undefined || /^[A-Za-z0-9_][\w.-]*$/.test(remote)) &&
    (branch === undefined || (/^[\w.-][\w./-]*$/.test(branch) && !branch.startsWith('-')));
  if (ok) return allow('am stage hook: git push is allowed in this commit stage');
  return deny('am stage hook: git push takes only [-u] [<remote name> [<branch>]] here: no URL, refspec (+ or :) or other option.');
}

function opinionScript(args, { slug, pluginRoots, coreRoots = [] }) {
  const [script, brief, ...more] = args;
  const is = (roots, name) => roots.some((r) => script === `${r}/scripts/${name}`);
  const which = is([...pluginRoots, ...coreRoots], 'codex-opinion.mjs') ? 'codex-opinion.mjs' : is(pluginRoots, 'claude-opinion.mjs') ? 'claude-opinion.mjs' : null;
  const briefOk = typeof brief === 'string' && new RegExp(`^\\.am/${slug}/[\\w.-]+\\.md$`).test(brief) && !brief.includes('..');
  const moreOk = more.length === 0 || (which === 'claude-opinion.mjs' && more.length === 2 && more[0] === '--as' && ['1', '2'].includes(more[1]));
  if (which && briefOk && moreOk) return allow(`am stage hook: the ${which} second opinion is allowed in the plan stage`);
  return deny(`am stage hook: the plan stage runs node only for this plugin's or the am plugin's scripts/codex-opinion.mjs, or this plugin's scripts/claude-opinion.mjs (path with /), with a brief .am/${slug}/<name>.md (and --as 1 or 2 for claude-opinion.mjs).`);
}

/**
 * The am folders whose codex-opinion.mjs the plan stage may run besides this plugin's, each as given and real, with `/`:
 * the record's `core` when it is an absolute am folder outside the repository (real paths), and the development sibling
 * `<pluginRoot>/../plugin` when it is am. A candidate whose real path cannot be read is dropped.
 */
export function coreRoots(rec, root, pluginRoot) {
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return null;
    }
  };
  const roots = [];
  const core = rec?.core;
  if (typeof core === 'string' && path.isAbsolute(core) && isCore(core)) {
    const [r, realRoot] = [real(core), real(root)];
    const rel = r && realRoot ? path.relative(realRoot, r) : '';
    if (r && realRoot && (rel.startsWith('..') || path.isAbsolute(rel))) roots.push(core, r);
  }
  const dev = path.resolve(pluginRoot, '..', 'plugin');
  if (isCore(dev)) {
    const r = real(dev);
    if (r) roots.push(dev, r);
  }
  return [...new Set(roots.map(slash))];
}

/** The do and check stages: any command but a session, a history change or a shell nested too deep. */
function looseShell(command, { stage }) {
  for (const shell of [undefined, 'bash']) {
    const { commands, tooDeep } = shellCommands(command, shell);
    if (tooDeep) return deny('am stage hook: this command nests shells too deep to be checked; run it without the extra shells.');
    for (const words of commands) {
      const bin = programName(words[0]);
      if (SESSION_BINS.has(bin)) return deny(`am stage hook: the ${stage} stage may not start ${bin}; it runs inside the user's session already.`);
      if (bin !== 'git') continue;
      const { sub, rest, dynamic } = gitSubcommand(words.slice(1));
      if (dynamic) return deny('am stage hook: a git subcommand that is a variable or expansion cannot be checked; write it out.');
      if (HISTORY.has(sub) || (sub === 'stash' && !['list', 'show'].includes(rest[0]))) {
        return deny(`am stage hook: the ${stage} stage does not commit, push, stash, reset or switch branches (git ${sub}).`);
      }
    }
  }
  return allow(`am stage hook: allowed in the ${stage} stage`);
}

// ------------------------------------------------------------------ files

/** The path from the repository root of a file to write, symbolic links of its existing part resolved; null when it cannot be told. */
export function repoPath(root, file, cwd = root) {
  const abs = path.resolve(cwd, file);
  const rest = [];
  let cur = abs;
  for (;;) {
    try {
      lstatSync(cur);
      break;
    } catch {
      const up = path.dirname(cur);
      if (up === cur) return null;
      rest.unshift(path.basename(cur));
      cur = up;
    }
  }
  if (rest.includes('..')) return null;
  let real;
  let realRoot;
  try {
    real = realpathSync(cur);
    realRoot = realpathSync(root);
  } catch {
    return null;
  }
  const rel = path.relative(realRoot, path.join(real, ...rest));
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return { outside: true, rel: slash(rel) };
  return { outside: false, rel: slash(rel) };
}

function fileDecision(input, { stage, slug, root, cwd }) {
  const file = input?.file_path ?? input?.notebook_path;
  if (typeof file !== 'string' || file === '') return deny('am stage hook: the file to write is not named.');
  const where = repoPath(root, file, cwd);
  if (!where) return deny(`am stage hook: the path ${file} cannot be resolved.`);
  if (where.outside) return deny(`am stage hook: ${file} is outside the repository; a stage writes only inside it.`);
  const parts = where.rel.split('/');
  if (stage === 'plan') {
    if (where.rel === '.am/.active') return allow('am stage hook: the current-task mark is allowed in the plan stage');
    if (parts.length > 2 && parts[0] === '.am' && parts[1] === slug && !(parts.length === 3 && RECORD_FILES.some((re) => re.test(parts[2])))) return allow(`am stage hook: .am/${slug}/ is writable in the plan stage`);
    return deny(`am stage hook: the plan stage writes only under .am/${slug}/ (not its stage record files) and .am/.active.`);
  }
  if (stage === 'commit') {
    if (parts.length === 3 && parts[0] === '.am' && parts[1] === slug && COMMIT_FILES.includes(parts[2])) return allow(`am stage hook: ${where.rel} is writable in the commit stage`);
    return deny(`am stage hook: the commit stage writes only ${COMMIT_FILES.map((f) => `.am/${slug}/${f}`).join(', ')}.`);
  }
  if (parts.some((p) => p.toLowerCase() === '.git' || p.toLowerCase() === '.claude')) return deny(`am stage hook: the ${stage} stage does not write under .git or .claude.`);
  return allow(`am stage hook: inside the repository, writable in the ${stage} stage`);
}

// ------------------------------------------------------------------ SubagentStop

/** The text blocks of the last assistant message with text in a transcript (JSON lines), or null. */
function transcriptAnswer(file) {
  if (typeof file !== 'string' || file === '') return null;
  let lines;
  try {
    lines = readFileSync(file, 'utf8').split('\n');
  } catch {
    return null;
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (entry?.type !== 'assistant' || !Array.isArray(entry.message?.content)) continue;
    const texts = entry.message.content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text);
    if (texts.length) return texts.join('\n');
  }
  return null;
}

/** null when the final answer is the one status line, else why not. */
export function checkAnswer(text, stage, runId) {
  if (typeof text !== 'string') return 'the final answer could not be read';
  const line = text.trim();
  if (line.includes('\n')) return 'the final answer has more than one line';
  const m = /^AM_STAGE: (\S+) (\S+)$/.exec(line);
  if (!m) return 'the final answer is not `AM_STAGE: <status> <runId>` alone';
  const [, status, id] = m;
  const known = [...new Set([...MARKS[stage], 'BLOCKED'])];
  if (!known.includes(status)) return `${status} is not a status of the ${stage} stage (${known.join(', ')})`;
  if (id === 'MISSING_RUN_ID') return status === 'BLOCKED' ? null : 'MISSING_RUN_ID goes only with BLOCKED';
  if (runId ? id !== runId : !RUN_ID.test(id)) return runId ? `the runId is not this stage's runId ${runId}` : `${id} is not a runId`;
  return null;
}

// ------------------------------------------------------------------ decide

/**
 * The decision for one stage agent's hook input: {stdout}. PreToolUse: allow or deny (never empty); SubagentStop: empty,
 * or a block when the final answer is not the status line (once: never while stop_hook_active).
 */
export function decide(payload, { pluginRoot = PLUGIN_ROOT, now = Date.now, alive = pidAlive, staleMs = AGENT_STALE_MS, env = process.env } = {}) {
  const event = payload?.hook_event_name;
  const agent = STAGE_AGENTS[payload?.agent_type];
  const cwd = typeof payload?.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();
  const root = findRepoRoot(cwd);
  const pidText = String(env.CLAUDE_PID ?? '');
  const pid = /^[1-9]\d*$/.test(pidText) ? Number(pidText) : null;
  if (event === 'SubagentStop') {
    if (payload.stop_hook_active === true) return { stdout: '' };
    const block = (reason) => ({ stdout: `${JSON.stringify({ decision: 'block', reason: `am stage hook: ${reason}. End with exactly one line, AM_STAGE: <status> <runId>, and nothing else; put everything else in the reply file.` })}\n` });
    if (!agent) return block(`${payload?.agent_type} is not an am stage agent`);
    const found = findRecord(root, agent.stage, agent.push, { now, alive, staleMs, pid });
    const text = typeof payload.last_assistant_message === 'string' ? payload.last_assistant_message : transcriptAnswer(payload.agent_transcript_path) ?? transcriptAnswer(payload.transcript_path);
    const why = checkAnswer(text, agent.stage, found.error ? null : found.rec.runId);
    return { stdout: why ? block(why).stdout : '' };
  }
  const out = (d) => ({ stdout: d.allow ? allowOutput(d.reason) : denyOutput(d.reason) });
  if (!agent) return out(deny(`am stage hook: ${payload?.agent_type} is not one of the am stage agents.`));
  const found = findRecord(root, agent.stage, agent.push, { now, alive, staleMs, pid });
  if (found.error) return out(deny(`am stage hook: ${found.error}.`));
  const bound = claim(found.dir, found.rec.runId, payload.agent_id, now);
  if (bound) return out(deny(`am stage hook: ${bound}.`));
  heartbeat(found.file, now);
  const ctx = { stage: agent.stage, push: agent.push, slug: found.slug, root, cwd };
  const tool = payload.tool_name;
  const input = payload.tool_input || {};
  if (tool === 'Bash') {
    if (typeof input.command !== 'string') return out(deny('am stage hook: the command is not text.'));
    if (agent.stage === 'plan' || agent.stage === 'commit') {
      const roots = [...new Set([pluginRoot, (() => { try { return realpathSync(pluginRoot); } catch { return pluginRoot; } })()].map(slash))];
      return out(strictShell(input.command, { ...ctx, pluginRoots: roots, coreRoots: coreRoots(found.rec, root, pluginRoot) }));
    }
    return out(looseShell(input.command, ctx));
  }
  if (tool === 'PowerShell') return out(deny('am stage hook: stages run shell commands with the Bash tool only.'));
  if (EDIT_TOOLS.has(tool)) return out(fileDecision(input, ctx));
  return out(deny(`am stage hook: the tool ${tool} is not checked for stages, so it is refused.`));
}
