// am:auto stage runner (Claude Code only).
// Runs one phase of am:auto in a fresh `claude -p` session, so every phase starts with a
// clean conversation: no conversation carries over, only the working tree and the files in
// .am/<slug>/. request.md (the user's request, written by am:auto) goes to the plan stage;
// plan.md goes to every stage after it and brings the user's answers back; check.md goes to
// the --fix run of do, to compactmem and to commit; compactmem.md (the memory proposal) is
// for the user and a later am:compactmem run. This script adds stage-<kind>.system.md (the
// session's instructions) and stage-<kind>.reply.md (its last reply, which am:auto reads
// for its final reply). Each stage gets its allowed tools up front (a stage session cannot
// show a permission prompt), calls its am skill (the run skill for a hand-over) by slash command (the skill's own model
// and effort apply), or inline from .am/<slug>/skill-<kind>.md with --model/--effort when the user models
// file gives the stage other values, and ends with one marker line that this script reads. Called by am:auto:
//   node stage.mjs <plan|do|check|compactmem|commit> <slug> [--push] [--fix]
// The do stage becomes a hand-over to the am-orchestrator run skill when the plan says so.
// Before the stage, task files that hold more than about 13,000 tokens are shortened in a short session of their own
// (originals kept as <name>.orig-<n>.md); `compacted` reports it. The request (request.md) is the user's own words: never
// counted, never shortened. Nothing is shortened before the plan stage or a hand-over.
// Each stage appends to .am/<slug>/progress.jsonl: `start` (pid, stage), a `note` for a compaction, a second ask or a
// hand-over, and one `end` (status, min) on every way out; write errors are dropped (see progress.mjs). During a hand-over
// the news of the orchestrator run (.orchestrator/runs/<run>/progress.jsonl) is copied in as lines with `src: "run"`.
// The hand-over session gets this process's pid as AM_HANDOVER_OWNER, which an orchestrator worker writes as its `owner`;
// however the hand-over ends (a pushed-out worker too), that worker gets SIGTERM, only while it is alive and holds the
// orchestrator lock.
// The do, compactmem and commit sessions and the compaction session write the prompt cache for 5 minutes, not 1 hour
// (FORCE_PROMPT_CACHING_5M): they rarely wait that long, and the 5-minute write costs less.
// The memory stage starts no session when the project's memory folder holds no .md file and no settings file moves it.
// After the arguments the user models file (user-models.mjs) is read: broken, the stage ends `failed` with no session and
// no start line; its compact (else default) values replace COMPACT_MODEL for the compaction session, noted when different,
// its stage-key (else default) values the skill's frontmatter for the plan, do, check, compactmem and commit sessions, and
// its run (else default) values the run skill's frontmatter for the hand-over.
// Then the per-PC user settings file (user-settings.mjs) is read: broken, the stage ends `failed` the same way.
// A stage that starts a session of its own (not a hand-over) first writes a `.gate` record in the orchestrator's record folder
// (memory-guard.mjs) and checks the free memory while other sessions of this PC run; short, it waits. The record is held to the end.
// Prints one JSON line: {stage, slug, status, reason, costUsd, sessionId, reply, denied, compacted}.
// status `unavailable`: no session could be started (no claude command); `failed`: one
// started but did not finish with a marker, or the user models or settings file is broken; `WAIT`: another run of this working tree kept going for
// the whole wait, or this PC stayed short of free memory while other sessions ran (no session, no start or end line; am:auto starts the
// stage again). Exit codes: 0 result printed, 1 bad input or stopped by a signal.
// The command does not run the stage itself: it starts the worker below detached and follows it, writing the heartbeat,
// and prints the worker's result line. A live worker of this task for the same stage and flags is followed instead; one of
// another stage is waited for up to 8 minutes, then the call ends WAIT naming that stage. A stop signal goes to the worker.
// A result of the same stage and flags that ended with nobody following is taken once by the next call instead of a new
// start while plan.md and check.md are unchanged (stage-delivered-<pid> mark); a changed or other stage's result is dropped.
// Hidden worker mode, not in the usage line: `node stage.mjs --worker <stage> <slug> [--push] [--fix]` runs the same stage
// while holding .am/<slug>/stage-worker.json (one worker per task), logs to stage-worker.log, leaves the result line in
// stage-result.json (its delivered mark: stage-delivered-<pid>) and stops (`failed`) when the follower's stage-heartbeat
// file stays the same for 30 minutes.
// Node only, no dependencies.

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findOnPath, killTree } from '../hooks/gate.mjs';
import { findAm, findOrchestrator, handedRun, readPlan, withinOneRun } from '../hooks/handover.mjs';
import { HEARTBEAT_MS, holdRecord, liveRecords, memoryShortMB, sessionsDirOf } from './memory-guard.mjs';
import { appendEvent, pidAlive, readFrom, runningStart } from './progress.mjs';
import { FRONTMATTER, frontmatterModels, readUserModels, resolveUser, userModelsFile } from './user-models.mjs';
import { readUserSettings, userSettingsFile } from './user-settings.mjs';

const WIN = process.platform === 'win32';
const AM_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = 'usage: node stage.mjs <plan|do|check|compactmem|commit> <slug> [--push] [--fix]';
export const STAGES = ['plan', 'do', 'check', 'compactmem', 'commit'];
// Minutes per session. The hand-over drives a whole orchestrator run, which takes hours.
// A caller of main that gives only some of them gets the rest from here.
export const TIMEOUT_MIN = { plan: 75, do: 90, handover: 1440, check: 45, compactmem: 20, commit: 25, compact: 15 };
// How often a hand-over copies the run's new event lines into the task's event file.
export const RELAY_MS = 5000;
// How often a plan or do session's plan.md is read for new second-opinion lines.
export const OPINION_MS = 5000;
// Worker mode: how often a worker touches its record and reads the heartbeat.
export const WORKER_TICK_MS = 30000;
// A worker record untouched this long, with a live pid, is only suspect: looked at again before it is taken.
export const WORKER_STALE_MS = 5 * 60000;
// How long a new worker waits before the second look at a suspect record.
export const WORKER_CONFIRM_MS = 45000;
// How long a new worker tries again while a live worker holds the record (the last one may be releasing it).
export const WORKER_BUSY_MS = 5000;
// How often it tries in that time.
export const WORKER_BUSY_POLL_MS = 200;
// A worker whose heartbeat file keeps the same content this long stops: nobody follows it any more.
export const WORKER_IDLE_MS = 30 * 60000;
// Follow mode: how often the follower reads the worker's files and writes the heartbeat.
export const FOLLOW_MS = 1000;
// How long the follower keeps following after it passed a stop signal on to the worker.
export const FOLLOW_STOP_MS = 10000;
// The worker's files under .am/<slug>/: its record, its result, its output log, and the heartbeat its follower writes.
export const WORKER_FILES = { record: 'stage-worker.json', result: 'stage-result.json', log: 'stage-worker.log', heartbeat: 'stage-heartbeat' };
// The delivered mark of a result: one per result, named by its worker's pid, claimed by creating it (`wx`).
export const DELIVERED_PREFIX = 'stage-delivered-';
// End markers each session may give; anything else is `failed`.
export const MARKS = {
  plan: ['READY', 'NEEDS_DECISION'],
  do: ['DONE', 'BLOCKED', 'NEEDS_DECISION'],
  handover: ['HANDED', 'BLOCKED', 'NEEDS_DECISION'],
  check: ['NOTE', 'BLOCK', 'NEEDS_DECISION'],
  compactmem: ['PROPOSED', 'NOTHING', 'BLOCKED'],
  commit: ['COMMITTED', 'NOTHING', 'BLOCKED', 'NEEDS_DECISION'],
};
// End markers of the compaction session. Kept apart from MARKS: they never reach am:auto as a stage status.
export const COMPACT_MARKS = ['COMPACTED', 'BLOCKED'];
const TAIL_CHARS = 600;
// The compaction session runs no skill, so it gets its model and effort as arguments (written by scripts/models.mjs);
// the user models file's compact/default value replaces it.
export const COMPACT_MODEL = { model: 'opus', effort: 'medium' };
// Session kinds whose prompt cache is written for 5 minutes. Plan and check wait on reviewers and gates for longer, so they keep 1 hour.
export const CACHE_5M_KINDS = ['do', 'compactmem', 'commit', 'compact'];
// The variable a hand-over session gets with this process's pid; an orchestrator worker it starts writes it to worker.json as `owner`.
export const HANDOVER_OWNER = 'AM_HANDOVER_OWNER';
/**
 * The environment of a session of this kind. A hand-over gets env plus HANDOVER_OWNER (owner, this process's pid); any
 * other kind gets env without an inherited HANDOVER_OWNER, plus the 5-minute cache setting where it applies; with
 * neither change, env as given.
 */
export function sessionEnv(kind, env, owner = process.pid) {
  if (kind === 'handover') return { ...env, [HANDOVER_OWNER]: String(owner) };
  let out = env;
  if (Object.hasOwn(env, HANDOVER_OWNER)) {
    out = { ...env };
    delete out[HANDOVER_OWNER];
  }
  return CACHE_5M_KINDS.includes(kind) ? { ...out, FORCE_PROMPT_CACHING_5M: '1' } : out;
}

// ------------------------------------------------------------------ context size

// Estimated tokens of the task files a stage reads. Above the limit they are shortened before the stage, to about the target.
export const CONTEXT_LIMIT = 13000;
export const CONTEXT_TARGET = 8500;

/** A conservative token estimate: 4 ASCII characters per token, every other character one token (so Korean is not undercounted). */
export function estimateTokens(text) {
  let ascii = 0;
  let other = 0;
  for (const ch of String(text || '')) {
    if (ch.codePointAt(0) < 128) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 4) + other;
}

/** The task files under .am/<slug>/ a session of this kind reads. Common text (system prompt, skill body) is not counted. */
export function contextFiles(kind, { fix = false } = {}) {
  // Nothing is shortened before the plan stage. request.md is the user's own words, and a plan.md shortened here
  // would stay short for a later hand-over, which gets no notice of the original.
  if (kind === 'plan') return [];
  if (kind === 'do') return fix ? ['plan.md', 'check.md'] : ['plan.md'];
  // The orchestrator copies the handed plan.md as its design document, so a hand-over passes it on whole.
  if (kind === 'handover') return [];
  if (kind === 'check') return ['plan.md'];
  return ['plan.md', 'check.md'];
}

/**
 * Which files to shorten, from {name: tokens}: none while the sum is within the limit; otherwise the largest first, until
 * the files left as they are hold at most half the target. `budget` is what the picked files may hold together afterwards.
 */
export function pickCompaction(sizes, { limit = CONTEXT_LIMIT, target = CONTEXT_TARGET } = {}) {
  const total = Object.values(sizes).reduce((a, b) => a + b, 0);
  if (total <= limit) return { files: [], budget: 0 };
  const files = [];
  let rest = total;
  for (const [name, size] of Object.entries(sizes).sort((a, b) => b[1] - a[1])) {
    if (rest <= target / 2) break;
    files.push(name);
    rest -= size;
  }
  return { files, budget: target - rest };
}

// ------------------------------------------------------------------ permissions

/** Windows' Claude Code also has a PowerShell tool, so every Bash rule gets a twin. */
const sh = (rules) => (WIN ? rules.flatMap((r) => (r.startsWith('Bash') ? [r, r.replace(/^Bash/, 'PowerShell')] : [r])) : rules);
/** One script by every path shape a session may write: the native path, mixed slashes, forward slashes only. */
const nodeScript = (file) => [...new Set([file, file.replace(/[\\/]scripts[\\/]/, '/scripts/'), file.split(path.sep).join('/')])].flatMap((f) => [`Bash(node "${f}" *)`, `Bash(node ${f} *)`]);

/** Claude Code's auto memory folder of the project at root: what the am:compactmem skill falls back to when no folder is named. */
export const memoryDir = (root, env) => path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects', path.resolve(root).replace(/[^A-Za-z0-9]/g, '-'), 'memory');

/**
 * The main checkout of the git repository at cwd: Claude Code shares one memory folder across a repository's worktrees.
 * '' outside any repository, null when git cannot tell (missing, failing, bare, or before 2.31: echoes --path-format back).
 */
export function mainCheckout(cwd, env, git = (args) => spawnSync('git', args, { encoding: 'utf8', env, windowsHide: true, timeout: 30000 })) {
  const r = git(['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (r.error) return null;
  if (r.status === 128 && /not a git repository/i.test(r.stderr || '')) return '';
  const common = String(r.stdout || '').trim();
  if (r.status !== 0 || /[\r\n]/.test(common) || !path.isAbsolute(common) || !/[\\/]\.git$/.test(common)) return null;
  return path.resolve(path.dirname(common));
}

/**
 * Why the memory stage needs no session, or null: the memory folder (of cwd and of the main checkout) has no .md file
 * and none of the settings files names autoMemoryDirectory. Any doubt (a read error other than a missing file, git
 * unable to tell) means null, so the session runs as before.
 */
export function memorySkip(cwd, env) {
  const main = mainCheckout(cwd, env);
  if (main === null) return null;
  const roots = [...new Set([path.resolve(cwd), ...(main ? [main] : [])])];
  const dirs = [...new Set(roots.map((r) => memoryDir(r, env)))];
  const settings = [path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json'), ...roots.flatMap((r) => [path.join(r, '.claude', 'settings.json'), path.join(r, '.claude', 'settings.local.json')])];
  try {
    for (const d of dirs) {
      let names;
      try {
        names = readdirSync(d);
      } catch (err) {
        if (err && err.code === 'ENOENT') continue;
        throw err;
      }
      if (names.some((f) => /\.md$/i.test(f))) return null;
    }
    for (const file of settings) {
      let text;
      try {
        text = readFileSync(file, 'utf8');
      } catch (err) {
        if (err && err.code === 'ENOENT') continue;
        throw err;
      }
      if (text.includes('autoMemoryDirectory')) return null;
    }
  } catch {
    return null;
  }
  return `no memory file in ${dirs.join(' or ')}: the memory stage was skipped without a session`;
}

/** An Edit rule for everything under an absolute folder: `//` starts a path from the file system root, a Windows drive as `/c` (measured on Windows). */
export const absEdit = (dir) => `Edit(/${path.resolve(dir).split(path.sep).join('/').replace(/^([A-Za-z]):/, (m, d) => `/${d.toLowerCase()}`)}/**)`;

/** The stages whose skill runs the Codex second opinion and whose session may write its brief under .am/. */
export const CODEX_STAGES = ['plan', 'compactmem'];

/**
 * Allowed and denied tools of one stage, after the orchestrator's stage profiles. `/x` is from the repository root.
 * `installedAm`: the installed am folders a new session loads, which may differ from the runner's own amRoot.
 */
export function permissions(stage, { push = false, amRoot = AM_ROOT, orchRoot = '', memDir = '', slug = '', installedAm = [] } = {}) {
  const read = ['Read', 'Glob', 'Grep'];
  const codex = CODEX_STAGES.includes(stage) ? [...new Set([amRoot, ...installedAm].flatMap((root) => nodeScript(path.join(root, 'scripts', 'codex-opinion.mjs'))))] : [];
  const gitRead = ['Bash(git status *)', 'Bash(git diff *)', 'Bash(git log *)', 'Bash(git ls-files *)', 'Bash(git check-ignore *)', 'Bash(git rev-parse *)'];
  const edit = (dir) => [`Edit(/${dir}/**)`, `Edit(${dir}/**)`];
  const pushRules = ['Bash(git push)', 'Bash(git push *)'];
  const noHuman = ['AskUserQuestion'];
  const stashWrites = ['push', 'save', 'pop', 'apply', 'drop', 'clear', 'create', 'store', 'branch'].flatMap((c) => [`Bash(git stash ${c})`, `Bash(git stash ${c} *)`]);
  const noHistory = ['Bash(git commit *)', ...pushRules, 'Bash(git reset *)', 'Bash(git checkout *)', 'Bash(git switch *)', 'Bash(git stash)', 'Bash(git stash -*)', ...stashWrites];
  switch (stage) {
    case 'plan':
      return { mode: 'dontAsk', allow: sh([...read, ...edit('.am'), ...gitRead, ...codex]), deny: noHuman };
    case 'do':
    case 'check':
      return { mode: 'acceptEdits', allow: sh([...read, 'Edit', 'Bash']), deny: sh([...noHuman, ...noHistory]) };
    case 'compactmem':
      // Reads the memory folder outside the repository; writes only the proposal under .am/. A deny rule wins over any allowance, so memory is never changed here.
      return { mode: 'dontAsk', allow: sh([...read, ...edit('.am'), ...gitRead, 'Bash(git show *)', ...codex]), deny: [...noHuman, ...(memDir ? [absEdit(memDir)] : [])] };
    case 'commit':
      // The only file it may write is the task's commit record, which the am:merge skill reads.
      return { mode: 'dontAsk', allow: sh([...read, ...gitRead, ...(slug ? [`Edit(/.am/${slug}/commits.md)`, `Edit(.am/${slug}/commits.md)`] : []), 'Bash(git add *)', 'Bash(git commit *)', 'Bash(git restore *)', ...(push ? pushRules : [])]), deny: sh([...noHuman, ...(push ? [] : pushRules)]) };
    case 'compact':
      // Shortens task files under .am/ before a stage; nothing else. The request is denied, which wins over the allowance.
      return { mode: 'dontAsk', allow: [...read, ...edit('.am')], deny: [...noHuman, ...(slug ? [`Edit(/.am/${slug}/request.md)`, `Edit(.am/${slug}/request.md)`] : [])] };
    case 'handover': {
      const orch = orchRoot ? nodeScript(path.join(orchRoot, 'scripts', 'orchestrator.mjs')) : [];
      const merge = ['Bash(git checkout *)', 'Bash(git merge --ff-only *)', 'Bash(git branch -d *)', 'Bash(git branch --show-current)'];
      // What the run skill's Prepare questions may need once the user has answered: the gate file, committing or setting changes aside.
      const prepare = ['Edit(/am-gate.json)', 'Edit(am-gate.json)', 'Bash(git add *)', 'Bash(git commit *)', 'Bash(git stash push *)'];
      return { mode: 'dontAsk', allow: sh([...read, ...edit('.am'), ...edit('.orchestrator'), ...gitRead, ...orch, ...merge, ...prepare, ...(push ? pushRules : [])]), deny: sh([...noHuman, ...(push ? [] : pushRules)]) };
    }
    default:
      throw new Error(`unknown stage: ${stage}`);
  }
}

// ------------------------------------------------------------------ instructions (English)

const MARK = (stage) => `End your final reply with exactly one line: ${MARKS[stage].map((m) => `AM_STAGE: ${m}`).join(' or ')}`;

// The permission rules of most stages match one plain command only, so a chained command is refused whole.
// Kept outside unattended(): that text is a copy of am:auto's rules and changes only together with them.
const ONE_COMMAND = '- Run each shell command as its own call: one command per call, no echo, no pipes.';

/** The unattended rules of am:auto's "Running without stops" section, written for one stage session. */
const unattended = (slug, stage, push) => `You are one stage of the am:auto skill, started in a fresh session by the am stage runner. No human is present in this session and nobody can answer a question, so never wait for input and never use a question tool. The plan is .am/${slug}/plan.md; only the files in .am/${slug}/ carry information between the stages, so write down there whatever a later stage needs. Follow the skill you are given; where it says to ask the user, or to stop and offer something, do what the rules below say instead.
- Running am:auto is the user's request for every stage, including the commits${push ? ' and the push' : ''}.
- A question about what the user sees or what is in scope: take your recommendation, record it under Decisions in plan.md with a one-line reason and the mark (auto-decided), translated into the plan's language ((자동 결정) in a Korean plan), and go on. Technical choices are settled the way the skill says, through its second opinion; never wait for the user on them, except a choice its two reviewers still split on after their rounds.
- A decision under Decisions that is marked as the user's answer is final; apply it.
- Stop only when the next action would delete user data or files that existed before this run, change a saved-data format, or migrate data; when it would change anything outside this repository (other folders, external services, installed packages)${push ? ', other than the push asked for' : ''}; when the user's or the project's instructions say it needs confirmation; when the two reviewers of a technical choice still split on it after their rounds; or when ${stage === 'plan' ? 'the request cannot be planned' : 'this stage cannot finish (below)'}.
- To stop for a question: leave the files as they are, write the decision card (as the skill's rules describe it, for someone who has seen neither this session nor the code) under Decisions in plan.md marked OPEN, record the reason there, repeat the card in your final reply, and end with AM_STAGE: NEEDS_DECISION. The user's answer comes back in plan.md and this stage starts again in a new session.
- Keep the final reply short: what this stage did, what it decided for the user, and any deviation from the plan.`;

const STAGE_RULES = {
  plan: (slug) => `This is the plan stage. Use exactly the slug ${slug}; its folder already exists. If .am/${slug}/plan.md already exists, an earlier plan session stopped with a question: continue that plan with the answers recorded under its Decisions and finish it, rather than starting over.
- Always write .am/${slug}/plan.md, even when the change looks small: skip the step that offers to do a small change directly.
- Add one line to the plan's Summary in its language: \`Scale: N implementation runs, M commits\` (\`규모: 구현 N회, 커밋 M개\` in a Korean plan). One implementation run is one am:do run that a fresh session can finish and verify: about 8 files and work that a faithful plan of at most 150 lines can cover. M is the number of logical units the am:commit skill would commit separately.
- Do not implement, even where the skill would go on after the plan; the next stage does that.
- What this session can do: read anything; create or change files only under .am/${slug}/ with the Write or Edit tool; run read-only git commands and the Codex second-opinion command of the skill's rules. Everything else is refused, including writing files through Bash. Work from the repository root.
- ${MARK('plan')}`,
  do: (slug, { fix }) => `This is the implementation stage for .am/${slug}/plan.md, with the steps of the am:do skill.${fix ? `\n- The am:check skill blocked this task. Read .am/${slug}/check.md first and fix only the causes it reports that lie inside this task; log each fix under Change log in the plan.` : ''}
- Another session runs the am:check skill after you finish. So run the agent runtime checks you can do here (the last step of the am:do skill), but do not use the am:check skill.
- Do not commit, push, stash, reset or switch branches; those commands are refused.
- Done marks that do not match the files: redo a done step whose change is missing; run the Check of an unmarked step that already looks done and mark it if it passes. Log either under Change log.
- If the plan turns out wrong in a way that changes what the user sees or the scope, decide it as above. Otherwise make the smallest fix and log it under Change log.
- This stage cannot finish when a step's Check fails and you cannot fix it: leave the files as they are, record what failed in plan.md, and end with AM_STAGE: BLOCKED.
- ${MARK('do')}`,
  handover: (slug, { push, resume }) => `This is the implementation stage for .am/${slug}/plan.md, handed to the am-orchestrator run skill because the plan is larger than one implementation run or one commit. You were started with the run skill. Drive it to the end by its Steps, with these additions from am:auto:
- ${resume ? 'The Change log of the plan already records the hand-over with a run ID. Check that `status --json` shows the same `run.id` (if not, end with AM_STAGE: BLOCKED and say why). If the log also records the merge, only the push below is left.' : 'Before `split`, note `run.id` from `status --json` (none if `run` is null). Once `split` has made the run (`run.id` present and not the noted one; otherwise end with AM_STAGE: BLOCKED and say why), log exactly this one line in the Change log of the plan, in English whatever the plan\'s language, with `<branch>` the current branch: `- Hand-over: am-orchestrator run skill, run <run.id>, start branch <branch>`.'} No other line you log (a stop reason before AM_STAGE: BLOCKED, for example) starts with \`Hand-over:\`.
- Its \`decide\` questions are scope or screen questions: decide them as above and pass each answer with \`decide\`. Its \`answer\` and \`blocked\` questions, and any question of its Prepare step, are stops: write the card into plan.md as above. When plan.md holds the user's answer to such a card, pass it to the run skill (\`answer\`, \`decide\`), or carry out exactly the action the answer names (for example write am-gate.json and commit it, or commit or stash the changes it names) and nothing more.
- Its rule never to merge or push covers its own flow only. When \`next\` is \`done\`: unless \`run.branch\` is the start branch, check out the start branch and run \`git merge --ff-only <run.branch>\` and \`git branch -d <run.branch>\`, and log the merge under Change log. ${push ? 'Then push the start branch by the push rules of the am:commit skill (its step 6): never force, never skip hooks, and if the push is rejected report it.' : 'Do not push.'} A fast-forward that fails is a stop (end with AM_STAGE: BLOCKED and say which branch holds which commits).
- Do not run the \`progress\` command of the run skill's script, even where the skill says to start it: nobody reads this session, and the am stage runner copies the run's news into this task's event file itself.
- In your final reply give: tasks done of all and the branch, the human checklist of the report at \`run.report\` (shortened, with its path), and every line of \`autoDecided\` and \`secondOpinions\`.
- ${MARK('handover')}  HANDED means the run is done and merged${push ? ' and pushed' : ''}.`,
  check: (slug) => `This is the check stage for .am/${slug}/plan.md, with the am:check skill.
- Do not ask anything. Whatever only a person can verify goes into the human checklist in check.md and in your reply.
- Verify by running, not by reading: run the gate and the project's runtime checks yourself. What the implementing session recorded is not evidence that something passes.
- Do not settle or reopen technical choices here; report one that needs it as a BLOCK finding. Do not commit, push, stash, reset or switch branches.
- Always write .am/${slug}/check.md.
- ${MARK('check')}`,
  compactmem: (slug, { memDir }) => `This is the memory stage for .am/${slug}/, with the am:compactmem skill, between the check and the commit.${memDir ? `
- The memory folder of this project is ${memDir}, unless your system prompt names another one; this session cannot read environment variables, so use this path for the skill's fallback.` : ''}
- This run is unattended: write the proposal to .am/${slug}/compactmem.md and stop there. Never change, create or delete a file in the memory folder; the user applies the proposal later.
- Do not settle open items by asking, and never end with AM_STAGE: NEEDS_DECISION here, even when the two reviewers of a choice stay split: keep that memory in the proposal, with both picks and reasons, for the user to decide when applying it.
- What this session can do: read anything, including the memory folder outside the repository; create or change files only under .am/${slug}/ with the Write or Edit tool; run read-only git commands (including git show) and the Codex second-opinion command of the skill's rules. Everything else is refused.
- This stage cannot finish when the proposal cannot be written: end with AM_STAGE: BLOCKED and say why. NOTHING means no memory folder, no memory file, or no memory about this task.
- ${MARK('compactmem')}`,
  commit: (slug, { push }) => `This is the commit stage for .am/${slug}/, with the am:commit skill. The am:auto run asks for this commit on the user's behalf; that counts as the user asking.${push ? ' Push mode is on: push after committing by the skill\'s rules.' : ' Do not push.'}
- A file you cannot tell belongs to this task: leave it out of the commit and name it in your reply.
- After each commit, record it in .am/${slug}/commits.md as the skill says; that is the only file this session can write.
- If the gate could not run (status \`error\`, or \`node\` missing), commit but do not push, and say why.
- If a hook rejects the commit, do not bypass it and do not retry another way; copy what it printed into your reply.
- Run each git command on its own from the repository root: no cd, no pipes, no chains, no heredoc; use several -m flags for several paragraphs.
- ${MARK('commit')}`,
};

/** The skill one session calls: {plugin, skill, args}, or null for an unknown stage. The hand-over calls the am-orchestrator run skill. */
export function skillCall(stage, slug, { push = false, resume = false } = {}) {
  const calls = {
    plan: { plugin: 'am', skill: 'plan', args: `Read the request in .am/${slug}/request.md (slug ${slug})` },
    do: { plugin: 'am', skill: 'do', args: slug },
    check: { plugin: 'am', skill: 'check', args: slug },
    compactmem: { plugin: 'am', skill: 'compactmem', args: slug },
    commit: { plugin: 'am', skill: 'commit', args: push ? 'push' : '' },
    handover: { plugin: 'am-orchestrator', skill: 'run', args: resume ? '' : `.am/${slug}/plan.md` },
  };
  return calls[stage] ?? null;
}

/** The prompt and appended system prompt of one session, with the plugin and skill it calls and that skill's arguments. */
export function instructions(stage, slug, { push = false, fix = false, resume = false, unquoted = false, memDir = '', compacted = null } = {}) {
  const { plugin, skill, args } = skillCall(stage, slug, { push, resume });
  const prompt = `/${plugin}:${skill}${args ? ` ${args}` : ''}`;
  // cmd.exe cannot pass a quoted allow rule (see exec), so such a session must run node scripts with the path unquoted.
  const note = unquoted && [...CODEX_STAGES, 'handover'].includes(stage) ? '\n- Run node scripts with the path unquoted (node C:/path/to/script.mjs ...): the permission rules of this session allow only that form.' : '';
  const shortened = compacted?.originals ? `\n- Before this session the am stage runner shortened ${compacted.files.join(', ')} to keep this context small; the originals are ${compacted.originals.join(', ')}. Open an original only when a detail you need is missing from the shortened file.` : '';
  return { prompt, plugin, skill, args, system:`${unattended(slug, stage, push)}\n\n${STAGE_RULES[stage](slug, { push, fix, resume, memDir })}\n${ONE_COMMAND}${note}${shortened}\n` };
}

/**
 * The prompt and system prompt of the compaction session. `files`: [{file, size, goal}], paths from the repository root.
 * The prompt holds no quotes or `%`: through cmd.exe it could not be passed.
 */
export function compactInstructions(slug, files) {
  const list = files.map((f) => `- ${f.file}: about ${f.size} tokens now; bring it to about ${f.goal} tokens.`).join('\n');
  const system = `You shorten the task files of an am:auto run before its next stage starts in a fresh session; that session reads these files instead of any conversation. No human is present in this session and nobody can answer a question, so never wait for input and never use a question tool.
Files to shorten (token counts are this runner's estimate: 4 ASCII characters, or 1 other character, per token):
${list}
- Change only these files, in place, with the Edit or Write tool. Change nothing else. The runner keeps a copy of each original and tells the next session where it is.
- Never change .am/${slug}/request.md: it is the user's request in their own words. This session cannot edit that file, and if the runner finds it changed it puts everything back.
- Keep the file's language and its Markdown structure. Keep exactly: every heading line; the Scale line (\`Scale: N implementation runs, M commits\` or \`규모: 구현 N회, 커밋 M개\`); every line that starts with a number and a period, with its Check and its done mark ((done) or (완료)); every decision line with its mark ((auto-decided), (자동 결정), (second opinion…), or the user's answer); every decision card marked OPEN, in full; Change log lines that record a hand-over with a run ID, or a merge; in check.md the verdict, the gate result and the human checklist; file paths, commands, names and numbers a later step needs.
- Keep every occurrence of these marks, also inside prose, as many times as now: (done), (완료), (auto-decided), (자동 결정), (second opinion, and the word OPEN.
- Shorten: explanations and background, long reasons (one line each), examples, Change log lines that repeat or were superseded.
- Do not add anything, and do not change what a kept line says.
- The runner checks the result mechanically (the marks, numbered lines and headings above, and the total size) and puts the originals back if a check fails.
- End your final reply with exactly one line: AM_STAGE: COMPACTED, or AM_STAGE: BLOCKED when the files cannot be shortened without losing what must be kept.
`;
  return { prompt: `Shorten the task files of .am/${slug}/ as your system prompt says`, system };
}

/** What the do stage becomes: `do`, `handover`, or {error} when the plan cannot tell. */
export function doKind(planText, { orchestrator = findOrchestrator, fix = false } = {}) {
  const info = readPlan(planText);
  // A done mark, or a fix after am:check, means this plan is implemented here, whatever else its Change log mentions.
  if (fix || info.started) return { kind: 'do' };
  if (info.handedOver) return { kind: 'handover', resume: true, orchRoot: orchestrator() || '' };
  if (withinOneRun(info.scale)) return { kind: 'do' };
  const orchRoot = orchestrator();
  if (!orchRoot) return { kind: 'do' };
  if (!info.scale) return { error: 'the plan has no Scale line (`Scale: N implementation runs, M commits` / `규모: 구현 N회, 커밋 M개`); add it to the Summary and run this stage again' };
  return { kind: 'handover', resume: false, orchRoot };
}

/**
 * Returns a function that copies the new complete event lines of the orchestrator run a hand-over drives into the slug's
 * event file, marked `src: 'run'`. A new hand-over follows the run that appears in .orchestrator/current, a resumed one the
 * run named there from the end of its file. The position lives in memory only; the function never throws.
 */
export function runRelay(cwd, slug, { resume = false, now = Date.now } = {}) {
  const fileOf = (run) => path.join(cwd, '.orchestrator', 'runs', run, 'progress.jsonl');
  // '' without the file; undefined when it could not be read, which says nothing about the run.
  const readCurrent = () => {
    try {
      return readFileSync(path.join(cwd, '.orchestrator', 'current'), 'utf8').trim();
    } catch (err) {
      return err && err.code === 'ENOENT' ? '' : undefined;
    }
  };
  let noted = readCurrent();
  let run = null;
  let pos; // undefined: the end of the lines that were there is not known yet
  const baseline = () => {
    const r = readFrom(fileOf(run), 0);
    if (!r.failed) pos = r.next;
  };
  if (resume && noted) {
    run = noted;
    baseline();
  }
  return () => {
    try {
      if (noted === undefined) {
        noted = readCurrent();
        if (noted === undefined) return;
        if (resume && noted) run = noted;
      }
      if (!run) {
        const current = readCurrent();
        if (!current || current === noted) return;
        run = current;
        pos = 0;
      }
      if (pos === undefined) {
        baseline();
        return;
      }
      const r = readFrom(fileOf(run), pos);
      if (r.failed) return;
      for (const { pid, ...line } of r.events) appendEvent(cwd, slug, { ...line, ev: line.ev === 'start' || line.ev === 'end' ? 'step' : line.ev, src: 'run' }, { now });
      pos = r.next;
    } catch {
      // Dropped on purpose, like a failed event write.
    }
  };
}

// A choice the second opinion settled. `(no second opinion)` does not match: the open paren must come right before "second".
export const SECOND_MARK = /\(second opinion/i;

/** The lines of `text` that carry a second-opinion mark, without list markers, trimmed. */
export function secondOpinionLines(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .filter((l) => SECOND_MARK.test(l))
    .map((l) => l.replace(/^[\s\-*>]+/, '').trim());
}

/**
 * Takes the second-opinion lines of .am/<slug>/plan.md as they are now and returns `scan(whole)`, which writes a `step`
 * event for each new one. Without `whole` a last line with no newline yet is left for later. `scan` never throws.
 */
export function opinionWatch(cwd, slug, kind, { now = Date.now } = {}) {
  const file = path.join(cwd, '.am', slug, 'plan.md');
  // null: the lines that were there are not known yet (a read error other than a missing file).
  const read = () => {
    try {
      return readFileSync(file, 'utf8');
    } catch (err) {
      return err && err.code === 'ENOENT' ? '' : null;
    }
  };
  const first = read();
  let seen = first === null ? null : new Set(secondOpinionLines(first));
  return (whole) => {
    try {
      const text = read();
      if (text === null) return;
      if (!seen) {
        seen = new Set(secondOpinionLines(text));
        return;
      }
      const complete = whole ? text : text.slice(0, text.lastIndexOf('\n') + 1);
      for (const line of secondOpinionLines(complete)) {
        if (seen.has(line)) continue;
        seen.add(line);
        appendEvent(cwd, slug, { ev: 'step', stage: kind, text: `second opinion: ${line}` }, { now });
      }
    } catch {
      // Dropped on purpose, like a failed event write.
    }
  };
}

// ------------------------------------------------------------------ other runs in this repository

// A stage starts only when no other unattended run of this working tree is going: another task's stage session, the gap
// between two of its stages, or an am-orchestrator command. The check and the start line happen under a short lock.
// How long a stage end that leads to the next stage (or a wait note) keeps that run going.
export const GRACE_MS = 10 * 60000;
// How often a blocked stage looks again, and how long it waits before it ends with WAIT and am:auto starts it again.
export const POLL_MS = 5000;
export const WAIT_MS = 8 * 60000;
// End statuses after which am:auto starts another stage of the same task (null: every end).
const GOES_ON = { plan: ['READY'], do: ['DONE'], check: ['NOTE', 'BLOCK'], compactmem: null };
// Ends of an orchestrator command after which the run skill starts the next command.
const ORCH_GOES_ON = { split: ['done'], answer: ['planned', 'split'] };
const goesOn = (table, e) => Object.hasOwn(table, e.stage) && (table[e.stage] === null || table[e.stage].includes(e.status));
const isWait = (e) => e.ev === 'note' && e.stage === 'wait';
const timeOf = (e) => (e ? Date.parse(e.t) : NaN);

/**
 * Where one task stands, from its own event lines (copied run lines left out): `live` (a stage session runs), `gap`
 * (its last end leads on, or it waits, within graceMs) and `seat` (ms of the first start or wait note after its last
 * end that leads nowhere; NaN without one).
 */
export function taskState(events, { now = Date.now, alive = pidAlive, graceMs = GRACE_MS } = {}) {
  const own = events.filter((e) => e.src !== 'run');
  const live = runningStart(own, alive);
  const lastEnd = own.findLastIndex((e) => e.ev === 'end');
  const lastFinal = own.findLastIndex((e) => e.ev === 'end' && !goesOn(GOES_ON, e));
  const seat = timeOf(own.slice(lastFinal + 1).find((e) => e.ev === 'start' || isWait(e)));
  const recent = (e) => Boolean(e) && now() - timeOf(e) <= graceMs;
  const gap = (lastEnd >= 0 && goesOn(GOES_ON, own[lastEnd]) && recent(own[lastEnd])) || recent(own.slice(lastEnd + 1).findLast(isWait));
  return { live: Boolean(live), stage: live ? live.start.stage : null, gap, seat };
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The other unattended runs of this working tree that keep slug's stage from starting: {runs: [names], text: one line}.
 * Another task blocks while a stage session of it runs, and in a gap when its seat comes before ours (slug order on a
 * tie) or we have none. The orchestrator blocks while a live pid holds its lock, and for graceMs after a split or answer
 * end that leads to its next command, unless that run is the one this task handed over.
 */
export function otherRuns(cwd, slug, { now = Date.now, alive = pidAlive, graceMs = GRACE_MS } = {}) {
  const o = { now, alive, graceMs };
  const am = path.join(cwd, '.am');
  const eventsOf = (name) => readFrom(path.join(am, name, 'progress.jsonl'), 0).events;
  const mine = taskState(eventsOf(slug), o);
  const found = [];
  let names = [];
  try {
    names = readdirSync(am, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== slug).map((d) => d.name).sort();
  } catch {
    // No .am folder: no other task.
  }
  for (const name of names) {
    const s = taskState(eventsOf(name), o);
    if (s.live) found.push({ name, text: `${name} (${s.stage || 'a'} stage running)` });
    else if (s.gap && (Number.isNaN(mine.seat) || s.seat < mine.seat || (s.seat === mine.seat && name < slug))) found.push({ name, text: `${name} (between stages)` });
  }
  const orch = path.join(cwd, '.orchestrator');
  const lock = readJson(path.join(orch, 'lock.json'));
  if (lock && Number.isInteger(lock.pid) && lock.pid > 0 && alive(lock.pid)) found.push({ name: 'am-orchestrator', text: `am-orchestrator ${lock.command || 'command'} (pid ${lock.pid})` });
  else {
    let run = '';
    try {
      run = readFileSync(path.join(orch, 'current'), 'utf8').trim();
    } catch {
      // No orchestrator run.
    }
    let plan = '';
    try {
      plan = readFileSync(path.join(am, slug, 'plan.md'), 'utf8');
    } catch {
      // No plan yet: nothing was handed over.
    }
    if (run && run !== handedRun(plan)) {
      const last = readFrom(path.join(orch, 'runs', run, 'progress.jsonl'), 0).events.findLast((e) => e.ev === 'end');
      if (last && goesOn(ORCH_GOES_ON, last) && now() - timeOf(last) <= graceMs) found.push({ name: `am-orchestrator run ${run}`, text: `am-orchestrator run ${run} (between commands)` });
    }
  }
  return { runs: found.map((f) => f.name), text: found.map((f) => f.text).join(', ') };
}

// Stops an orchestrator worker the way the orchestrator's `forward` does: a signal, or the whole tree on Windows.
const signalRun = (pid, sig) => (WIN ? killTree({ pid }) : process.kill(pid, sig));

/**
 * Sends SIGTERM to the orchestrator worker a hand-over of this process started, and returns its pid; null when there is
 * none. The orchestrator's `liveWorker` rule (worker.json's pid is alive and holds the lock) plus worker.json's `owner`
 * being owner, so a command a person started is never touched. Never throws.
 */
export function stopHandedRun(cwd, owner, { alive = pidAlive, kill = signalRun } = {}) {
  try {
    const orch = path.join(cwd, '.orchestrator');
    const w = readJson(path.join(orch, 'worker', 'worker.json'));
    if (!w || typeof w !== 'object' || !Number.isInteger(w.pid) || w.pid <= 0 || w.owner !== Number(owner) || !alive(w.pid)) return null;
    if (readJson(path.join(orch, 'lock.json'))?.pid !== w.pid) return null;
    kill(w.pid, 'SIGTERM');
    return w.pid;
  } catch {
    return null;
  }
}

/** The text and modification time of a lock file, or null when it cannot be read. */
function lockSnapshot(file) {
  try {
    return { text: readFileSync(file, 'utf8'), mtimeMs: statSync(file).mtimeMs };
  } catch {
    return null;
  }
}

/**
 * Whether the owner of a lock file is `dead`, `live` or `suspect`. Missing is dead; unreadable is dead after a minute; a
 * dead pid is dead. With staleMs, a live pid whose file was not touched for longer is only `suspect` (after a sleep the
 * owner's timer has not run yet): it is dead when the earlier look `suspect` ({mtimeMs, text}) still matches the file.
 */
export function ownerState(file, { now = Date.now, alive = pidAlive, staleMs = 0, suspect = null } = {}) {
  const seen = lockSnapshot(file);
  if (!seen) return 'dead';
  let owner = null;
  try {
    owner = JSON.parse(seen.text);
  } catch {
    // Unreadable: judged by its age.
  }
  if (!owner) return now() - seen.mtimeMs > 60000 ? 'dead' : 'live';
  if (!(Number.isInteger(owner.pid) && owner.pid > 0 && alive(owner.pid))) return 'dead';
  if (!staleMs || now() - seen.mtimeMs <= staleMs) return 'live';
  return suspect && suspect.mtimeMs === seen.mtimeMs && suspect.text === seen.text ? 'dead' : 'suspect';
}

/**
 * Takes a lock file (exclusive create of {pid, t, ...fields}). Returns {release, owns} when taken (owns(): 'yes' while
 * the file still holds this owner's text, 'missing' or 'other'), {busy: pid} while a live owner holds it (with
 * `suspect`, the look to pass back after a while, when it is only suspect: see ownerState), or null when it cannot be
 * made (then the start lock lets the stage go on unchecked). A dead owner's lock is moved aside first and dropped only
 * when the moved file still names a dead owner.
 */
export function takeLock(file, { now = Date.now, alive = pidAlive, fields = {}, staleMs = 0, suspect = null } = {}) {
  const mine = JSON.stringify({ pid: process.pid, t: now(), ...fields });
  const dead = (f) => ownerState(f, { now, alive, staleMs, suspect }) === 'dead';
  for (let i = 0; i < 3; i++) {
    try {
      writeFileSync(file, mine, { flag: 'wx' });
      const release = () => {
        try {
          if (readFileSync(file, 'utf8') === mine) rmSync(file, { force: true });
        } catch {
          // Already gone.
        }
      };
      const owns = () => {
        try {
          return readFileSync(file, 'utf8') === mine ? 'yes' : 'other';
        } catch {
          return 'missing';
        }
      };
      return { release, owns };
    } catch (err) {
      if (!err || err.code !== 'EEXIST') return null;
    }
    const state = ownerState(file, { now, alive, staleMs, suspect });
    if (state === 'suspect') {
      const look = lockSnapshot(file);
      if (look) return { busy: readJson(file)?.pid ?? null, suspect: look };
    }
    if (state === 'live') return { busy: readJson(file)?.pid ?? null };
    const aside = `${file}.${process.pid}.stale`;
    try {
      renameSync(file, aside);
    } catch {
      continue; // someone else moved or released it
    }
    if (!dead(aside)) {
      // A live owner took the lock in between: put it back unless another one is there by now.
      try {
        writeFileSync(file, readFileSync(aside), { flag: 'wx' });
      } catch {
        // Kept by the newer owner.
      }
      rmSync(aside, { force: true });
      return { busy: readJson(file)?.pid ?? null };
    }
    rmSync(aside, { force: true });
  }
  return { busy: readJson(file)?.pid ?? null };
}

// ------------------------------------------------------------------ running claude

/** Windows: the real file on PATH. A .cmd or .bat has to go through cmd.exe. */
function resolveCommand(cmd, env) {
  if (!WIN) return { file: cmd, shell: false };
  const exts = path.extname(cmd) ? [''] : String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  return findOnPath(cmd, env, exts) ?? { file: cmd, shell: false };
}

const quote = (arg) => (/^[A-Za-z0-9_\-./:=\\]+$/.test(arg) ? arg : `"${arg}"`);

/**
 * cmd.exe cannot pass `"` or `%` inside an argument: from the --allowedTools value drop the allow rules that quote a path
 * (their unquoted twins stay); any other argument that still holds one throws.
 */
export function cmdExeArgs(args) {
  const safe = args.map((a, i) => (args[i - 1] === '--allowedTools' && a.includes('"') ? a.split(',').filter((r) => !r.includes('"')).join(',') : a));
  if (safe.some((a) => a.includes('%') || a.includes('"'))) throw new Error('an argument holds " or % and cannot go through cmd.exe');
  return safe;
}

const active = new Set(); // running sessions, ended when this script is stopped
// The end-event writers of running stages, called when this script is stopped. Each writes once and leaves the set.
const finishers = new Set();

/** Runs one command and collects its output. Never rejects. */
function exec(cmd, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    let child;
    try {
      const target = resolveCommand(cmd, env);
      const opts = { cwd, env, windowsHide: true, detached: !WIN, stdio: ['ignore', 'pipe', 'pipe'] };
      const safe = target.shell ? cmdExeArgs(args) : args;
      child = target.shell ? spawn([target.file, ...safe].map(quote).join(' '), { ...opts, shell: true }) : spawn(target.file, safe, opts);
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: '', timedOut: false, spawnError: err.message });
      return;
    }
    active.add(child);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (stderr = (stderr + d).slice(-TAIL_CHARS * 4)));
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, Math.max(1, timeoutMs));
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      active.delete(child);
      resolve({ stdout, stderr, timedOut, spawnError: null, ...r });
    };
    child.on('error', (err) => finish({ code: null, spawnError: err.message }));
    child.on('close', (code) => finish({ code }));
  });
}

/** The result object in `claude -p --output-format json` output (one object, an array, or JSON lines). */
export function parseResult(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v.findLast((e) => e && e.type === 'result') ?? null : isObj(v) ? v : null;
  } catch {
    for (const line of text.split('\n').reverse()) {
      try {
        const v = JSON.parse(line);
        if (isObj(v) && v.type === 'result') return v;
      } catch {
        /* not a JSON line */
      }
    }
    return null;
  }
}

/** The last `AM_STAGE: <value>` line among the allowed values, or null. */
export function lastMark(text, values) {
  const re = new RegExp(`AM_STAGE:\\s*\\**\\s*(${values.join('|')})\\b`, 'gi');
  let found = null;
  for (const m of String(text || '').matchAll(re)) found = m[1].toUpperCase();
  return found;
}

/** The `model` and `effort` of an am skill's frontmatter, or {error} (one line naming the file) when they cannot be read. */
export const skillDefaults = (amRoot, skill) => frontmatterModels(path.join(amRoot, 'skills', skill, 'SKILL.md'));

/** A skill body for an inline call: frontmatter dropped, $ARGUMENTS and ${CLAUDE_PLUGIN_ROOT} filled (split/join, so a `$` in a path stays). */
export const inlineSkill = (text, args, amRoot) => String(text).replace(FRONTMATTER, '').split('$ARGUMENTS').join(args || '').split('${CLAUDE_PLUGIN_ROOT}').join(amRoot.split(path.sep).join('/'));

/** The prompt of an inline stage call, as the orchestrator words it. */
export const inlinePrompt = (slug, kind, name) => `Follow the instructions in .am/${slug}/skill-${kind}.md exactly. They are the ${name} skill, invoked by the user with the arguments already filled in.`;

/** The claude arguments of one session. No --model or --effort for a slash call: it carries the skill's own. `model` for the compaction session and an inline stage call. */
export function claudeArgs(perm, { prompt, systemFile, resume, pluginDir = '', model = null }) {
  const args = ['-p', prompt, '--output-format', 'json', '--permission-mode', perm.mode];
  if (model) args.push('--model', model.model, '--effort', model.effort);
  if (perm.allow.length) args.push('--allowedTools', perm.allow.join(','));
  if (perm.deny.length) args.push('--disallowedTools', perm.deny.join(','));
  if (pluginDir) args.push('--plugin-dir', pluginDir);
  if (resume) args.push('--resume', resume);
  else args.push('--append-system-prompt-file', systemFile);
  return args;
}

/**
 * The am folder to load with --plugin-dir, or '' for an installed copy. A copy outside Claude Code's plugin cache was
 * loaded with --plugin-dir itself (development), and a stage session must run these same skills, not an installed version.
 */
export function pluginDirFor(amRoot, env) {
  const cache = path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'plugins', 'cache');
  const rel = path.relative(path.resolve(cache), path.resolve(amRoot));
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? '' : amRoot;
}

/** am:plan only adds .am/.gitignore when it creates .am/, which the am:auto session has already done. */
function ensureIgnored(cwd) {
  if (existsSync(path.join(cwd, '.am', '.gitignore'))) return;
  const r = spawnSync('git', ['check-ignore', '-q', '.am'], { cwd, windowsHide: true });
  if (r.status !== 0) writeFileSync(path.join(cwd, '.am', '.gitignore'), '*\n');
}

// ------------------------------------------------------------------ compaction

const count = (text, re) => (String(text).match(re) || []).length;
const COUNTED = [
  [/\((?:done|완료)\)/gi, 'done marks'],
  [/\((?:auto-decided|자동 결정)\)/gi, 'auto-decided marks'],
  [/\(second opinion/gi, 'second opinion marks'],
  [/\bOPEN\b/g, 'OPEN marks'],
  [/^\d+\.\s/gm, 'numbered lines'],
];

/**
 * The verdict of a check.md, or null. Same expression as verdictFromFile in am-orchestrator: a labelled verdict first,
 * else the first BLOCK/NOTE. tests/orchestrator-skill.test.mjs checks both on the same cases.
 */
export function checkVerdict(text) {
  const t = String(text || '');
  const m = /^[\s#>*\-]*(?:verdict|판정|결론)[^\n]*?\b(BLOCK|NOTE)\b/im.exec(t);
  return m ? m[1].toUpperCase() : /\b(BLOCK|NOTE)\b/.exec(t)?.[1] ?? null;
}

/** Why a shortened file cannot stand in for its original, or null. */
export function compactionProblem(name, before, after) {
  if (!String(after ?? '').trim()) return `${name} was deleted or emptied`;
  if (name === 'plan.md' && JSON.stringify(readPlan(before)) !== JSON.stringify(readPlan(after))) return `${name}: the Scale line, done marks or hand-over line read differently`;
  for (const [re, what] of COUNTED) if (count(before, re) !== count(after, re)) return `${name}: ${what} ${count(before, re)} -> ${count(after, re)}`;
  const headings = new Set(String(after).match(/^#{1,6} .*$/gm)?.map((h) => h.trimEnd()) || []);
  const lost = (String(before).match(/^#{1,6} .*$/gm) || []).map((h) => h.trimEnd()).find((h) => !headings.has(h));
  if (lost) return `${name}: heading lost: ${lost}`;
  if (name === 'check.md' && checkVerdict(before) !== checkVerdict(after)) return `${name}: verdict ${checkVerdict(before)} -> ${checkVerdict(after)}`;
  return null;
}

/** `<name>.orig-<n>.md` with the first n not taken, from the repository root. */
function originalName(slug, name, taken) {
  const base = name.replace(/\.md$/, '');
  for (let n = 1; ; n++) {
    const rel = `.am/${slug}/${base}.orig-${n}.md`;
    if (!taken(rel)) return rel;
  }
}

/**
 * Shortens the task files a stage of this kind reads when they hold more than the limit, in a short claude session of
 * their own. Each shortened file keeps its original as `<name>.orig-<n>.md`. A failed check, a session without its marker
 * or over its time puts every original back and removes the new copies; so does a session that touched request.md, which
 * is put back as well. The session runs on `model` ({model, effort}); `modelNote`, when set, is noted as it starts. Returns {compacted, costUsd}; `compacted` is
 * null (nothing to do), {files, before, after, originals}, or {files, failed}.
 */
async function compactContext(cwd, slug, kind, { fix = false, env = process.env, claude = ['claude'], timeoutMin = TIMEOUT_MIN, limit = CONTEXT_LIMIT, target = CONTEXT_TARGET, model = COMPACT_MODEL, modelNote = '', note = () => {} } = {}) {
  const abs = (rel) => path.join(cwd, rel);
  const read = (rel) => (existsSync(abs(rel)) ? readFileSync(abs(rel), 'utf8') : null);
  const texts = {};
  for (const name of contextFiles(kind, { fix })) {
    const t = read(`.am/${slug}/${name}`);
    if (t !== null) texts[name] = t;
  }
  const sizes = Object.fromEntries(Object.entries(texts).map(([n, t]) => [n, estimateTokens(t)]));
  const { files: names, budget } = pickCompaction(sizes, { limit, target });
  if (!names.length) return { compacted: null, costUsd: 0 };
  const files = names.map((n) => `.am/${slug}/${n}`);
  const picked = names.reduce((a, n) => a + sizes[n], 0);
  // The request as it is now (null: no such file), to compare and put back after the session.
  const requestRel = `.am/${slug}/request.md`;
  const request = read(requestRel);
  const originals = [];
  for (const n of names) {
    const rel = originalName(slug, n, (p) => existsSync(abs(p)));
    writeFileSync(abs(rel), texts[n], { flag: 'wx' });
    originals.push(rel);
  }
  const { prompt, system } = compactInstructions(
    slug,
    names.map((n, i) => ({ file: files[i], size: sizes[n], goal: Math.floor((budget * sizes[n]) / picked) })),
  );
  const systemRel = `.am/${slug}/stage-compact.system.md`;
  writeFileSync(abs(systemRel), system);
  note(`shortening ${files.join(', ')} before the stage`);
  if (modelNote) note(modelNote);
  const [bin, ...pre] = claude;
  const r = await exec(bin, [...pre, ...claudeArgs(permissions('compact', { slug }), { prompt, systemFile: systemRel, model })], { cwd, env: sessionEnv('compact', env), timeoutMs: timeoutMin.compact * 60000 });
  const parsed = parseResult(r.stdout);
  const costUsd = parsed && Number.isFinite(parsed.total_cost_usd) ? parsed.total_cost_usd : 0;

  let failed = null;
  if (r.spawnError) failed = `could not start ${bin}: ${r.spawnError}`;
  else if (r.timedOut) failed = `no end within ${timeoutMin.compact} minutes`;
  else if (!parsed || r.code !== 0 || parsed.is_error) failed = `the session ended with an error or unreadable output (exit ${r.code})`;
  else {
    const mark = lastMark(parsed.result, COMPACT_MARKS);
    if (mark !== 'COMPACTED') failed = mark ? `the session said ${mark}` : 'the session ended without an AM_STAGE line';
  }
  const now = Object.fromEntries(Object.keys(texts).map((n) => [n, read(`.am/${slug}/${n}`)]));
  for (const n of Object.keys(texts)) {
    if (failed) break;
    failed = names.includes(n) ? compactionProblem(n, texts[n], now[n]) : now[n] === texts[n] ? null : `${n} was changed but not picked`;
  }
  const requestNow = read(requestRel);
  if (!failed && requestNow !== request) failed = 'request.md was changed';
  const after = Object.values(now).reduce((a, t) => a + estimateTokens(t ?? ''), 0);
  if (!failed && after > limit) failed = `still about ${after} tokens, above ${limit}`;
  if (failed) {
    for (const [n, t] of Object.entries(texts)) if (now[n] !== t) writeFileSync(abs(`.am/${slug}/${n}`), t);
    if (requestNow !== request) {
      if (request === null) rmSync(abs(requestRel), { force: true });
      else writeFileSync(abs(requestRel), request);
    }
    for (const rel of originals) rmSync(abs(rel), { force: true });
    return { compacted: { files, failed }, costUsd };
  }
  return { compacted: { files, before: Object.values(sizes).reduce((a, b) => a + b, 0), after, originals }, costUsd };
}

// ------------------------------------------------------------------ main

const BAD_ARGS = `bad arguments (the slug is lowercase kebab-case)\n${USAGE}\n`;

/** The stage, slug and flags of the command line, or null when they are not a valid call. */
export function stageArgs(argv) {
  const [stage, slug, ...flags] = argv;
  if (!STAGES.includes(stage) || !/^[a-z0-9][a-z0-9-]*$/.test(slug || '') || flags.some((f) => f !== '--push' && f !== '--fix')) return null;
  return { stage, slug, push: flags.includes('--push'), fix: flags.includes('--fix') };
}

/** A result line with no session behind it, in the key order of main's result. */
export function stageLine(stage, slug, status, reason) {
  return JSON.stringify({ stage, slug, status, reason, costUsd: 0, sessionId: null, reply: null, denied: [], compacted: null });
}

/** Runs one stage and writes its JSON result line. Returns the exit code. */
export async function main(argv, { cwd = process.cwd(), env = process.env, claude = ['claude'], timeoutMin = TIMEOUT_MIN, orchestrator = findOrchestrator, am = findAm, amRoot = AM_ROOT, out = process.stdout, now = Date.now, relayMs = RELAY_MS, opinionMs = OPINION_MS, pollMs = POLL_MS, waitMs = WAIT_MS, graceMs = GRACE_MS, alive = pidAlive, kill = signalRun, freeMem = os.freemem, platform = process.platform, heartbeatMs = HEARTBEAT_MS } = {}) {
  const args = stageArgs(argv);
  if (!args) {
    out.write(BAD_ARGS);
    return 1;
  }
  const { stage, slug, push, fix } = args;
  // Limits the caller left out (undefined or null) are the defaults; any other value is used as given.
  const limits = Object.fromEntries(Object.keys(TIMEOUT_MIN).map((key) => [key, timeoutMin[key] ?? TIMEOUT_MIN[key]]));
  const dir = path.join(cwd, '.am', slug);
  const planFile = path.join(dir, 'plan.md');
  const result = { stage, slug, status: 'failed', reason: '', costUsd: 0, sessionId: null, reply: null, denied: [], compacted: null };
  let finish = null; // set once the start event is written
  const done = (fields = {}) => {
    Object.assign(result, fields);
    finish?.(result);
    out.write(`${JSON.stringify(result)}\n`);
    return 0;
  };
  const userFile = userModelsFile(env);
  const user = readUserModels(userFile);
  if (user.error) return done({ reason: `the user model settings cannot be used (fix or remove the file): ${user.error}` });
  const settingsFile = userSettingsFile(env);
  const settings = readUserSettings(settingsFile);
  if (settings.error) return done({ reason: `the user settings cannot be used (fix or remove the file): ${settings.error}` });
  if (stage === 'plan' && !existsSync(path.join(dir, 'request.md'))) return done({ reason: `no .am/${slug}/request.md: write the request there first` });
  if (stage !== 'plan' && !existsSync(planFile)) return done({ reason: `no .am/${slug}/plan.md: run the plan stage first` });
  ensureIgnored(cwd);
  const event = (fields) => appendEvent(cwd, slug, fields, { now });
  // Admission: under the start lock, look for other runs and write the start line when there are none.
  const lockFile = path.join(cwd, '.am', '.admission.lock');
  const waitBegan = Date.now(); // the wait is timed by the clock that setTimeout uses
  let held = null; // the lock, kept to the end when the start line could not be written
  // The do stage's kind is read once, before the wait. A hand-over (its sessions are the orchestrator's) and a do stage that
  // cannot start a session take no part in the memory check.
  const k = stage === 'do' ? doKind(readFileSync(planFile, 'utf8'), { orchestrator, fix }) : null;
  const joins = !(k && (k.error || k.kind === 'handover'));
  const recordsDir = sessionsDirOf(env);
  let record = null; // this stage's `.gate` record, held to the end once the memory check passed
  // Writes the record first, so that a stage starting at the same moment counts this one; null when memory is enough, else what is short.
  const memoryCheck = () => {
    const rec = holdRecord({ repo: cwd, phase: `am:auto ${stage}`, where: dir }, { dir: recordsDir, heartbeatMs });
    const busy = liveRecords(recordsDir, { alive }).filter((r) => r.file !== rec.file).length;
    const short = memoryShortMB({ busy, freeBytes: freeMem(), setting: settings.minFreeMemoryMB, platform });
    if (!short) {
      record = rec;
      return null;
    }
    rec.release();
    return { ...short, busy };
  };
  const repoWait = (text) => ({ kind: 'repo', note: `waiting for another run of this repository to end: ${text}`, reason: `waiting for another run of this repository: ${text}` });
  const memoryWait = ({ freeMB, needMB, busy }) => ({
    kind: 'memory',
    note: `waiting for free memory (${freeMB} MB free, needs ${needMB} MB, ${busy} other sessions on this PC)`,
    reason: `waiting for free memory on this PC: ${freeMB} MB free, needs ${needMB} MB (${settings.minFreeMemoryMB === null ? 'built-in default' : `minFreeMemoryMB in ${settingsFile}`}), ${busy} other sessions on this PC`,
  });
  let noted = ''; // the kind of the last wait note
  for (;;) {
    const lock = takeLock(lockFile, { now, alive });
    let blocked;
    if (!lock) {
      const short = joins ? memoryCheck() : null;
      if (!short) {
        event({ ev: 'start', text: `stage ${stage} started`, pid: process.pid, stage });
        break;
      }
      blocked = memoryWait(short);
    } else if (lock.busy !== undefined) blocked = repoWait(`another stage of this repository is starting (pid ${lock.busy ?? '?'})`);
    else {
      const other = otherRuns(cwd, slug, { now, alive, graceMs });
      const short = !other.runs.length && joins ? memoryCheck() : null;
      if (!other.runs.length && !short) {
        if (event({ ev: 'start', text: `stage ${stage} started`, pid: process.pid, stage })) lock.release();
        else held = lock;
        break;
      }
      lock.release();
      blocked = short ? memoryWait(short) : repoWait(other.text);
    }
    if (noted !== blocked.kind) {
      noted = blocked.kind;
      event({ ev: 'note', text: blocked.note, stage: 'wait' });
    }
    const left = waitMs - (Date.now() - waitBegan);
    if (left <= 0) return done({ status: 'WAIT', reason: blocked.reason });
    await new Promise((r) => setTimeout(r, Math.min(pollMs * (1 + Math.random() * 0.5), left)));
  }
  const startedAt = now();
  let stopRelay = null; // set while a hand-over copies the run's events
  let stopOpinions = null; // set while a plan or do session's plan.md is watched
  finish = ({ status, reason, stopped = false }) => {
    if (!finishers.has(finish)) return;
    finishers.delete(finish);
    // First, so that nothing below can leave the record behind.
    record?.release();
    stopRelay?.();
    // The orchestrator worker this hand-over started stops with it, before the end line frees the task.
    if (result.stage === 'handover') stopHandedRun(cwd, process.pid, { alive, kill });
    // A stop signal comes while the session may still be writing a line.
    stopOpinions?.(!stopped);
    const first = String(reason || '').split('\n')[0].replace(/\s+/g, ' ').trim().slice(0, 200);
    event({ ev: 'end', text: first || `${result.stage} stage ended`, stage: result.stage, status, min: Math.max(0, Math.floor((now() - startedAt) / 60000)) });
    held?.release();
  };
  finishers.add(finish);

  let kind = stage;
  let opts = { push, fix };
  let orchRoot = '';
  if (stage === 'do') {
    if (k.error) return done({ reason: k.error });
    kind = k.kind;
    if (kind === 'handover') record?.release(); // never held for a hand-over; kept as a safety net
    opts = { ...opts, resume: k.resume };
    // Resolved like the allow rules (path.join), so the inline file names the same path.
    orchRoot = k.orchRoot ? path.resolve(k.orchRoot) : '';
    if (kind === 'handover' && !orchRoot) return done({ stage: kind, reason: 'the plan records a hand-over, but the am-orchestrator run skill is not installed or not enabled' });
  }
  result.stage = kind;
  if (kind === 'handover') event({ ev: 'note', text: 'handed to the am-orchestrator run skill', stage: 'handover' });
  if (kind === 'compactmem') {
    const skip = memorySkip(cwd, env);
    if (skip) {
      // Appended, like the skill's own record: an earlier proposal in the file stays.
      const file = path.join(dir, 'compactmem.md');
      const prev = existsSync(file) ? readFileSync(file, 'utf8') : '';
      appendFileSync(file, `${prev && !prev.endsWith('\n') ? '\n' : ''}${skip}\n`);
      return done({ status: 'NOTHING', reason: skip });
    }
  }
  // A stage the user models file gives other values than its skill's frontmatter runs inline with --model/--effort.
  let stageModel = null;
  const sc = skillCall(kind, slug, opts);
  const skillRoot = sc?.plugin === 'am' ? amRoot : orchRoot;
  if (sc && (user.model[sc.skill] ?? user.model.default ?? user.effort[sc.skill] ?? user.effort.default)) {
    const builtin = skillDefaults(skillRoot, sc.skill);
    if (builtin.error) return done({ reason: `the skill's model and effort cannot be read: ${builtin.error}` });
    const picked = resolveUser(user, sc.skill, builtin);
    if (picked.model !== builtin.model || picked.effort !== builtin.effort) stageModel = picked;
  }
  const [bin, ...pre] = claude;
  // Shorten the task files first when they are too large; a failure leaves them as they were and the stage goes on.
  const compactModel = resolveUser(user, 'compact', COMPACT_MODEL);
  const modelNote = compactModel.model !== COMPACT_MODEL.model || compactModel.effort !== COMPACT_MODEL.effort ? `model ${compactModel.model}, effort ${compactModel.effort} from the user's setting ${userFile}` : '';
  const compaction = await compactContext(cwd, slug, kind, { fix, env, claude, timeoutMin: limits, model: compactModel, modelNote, note: (text) => event({ ev: 'note', text }) });
  result.compacted = compaction.compacted;
  const c = compaction.compacted;
  if (c) event({ ev: 'note', text: c.failed ? `shortening undone, files kept: ${c.failed.split('\n')[0]}` : `shortened ${c.files.join(', ')}: about ${c.before} -> ${c.after} tokens` });
  result.costUsd = compaction.costUsd;
  const memDir = kind === 'compactmem' ? memoryDir(cwd, env) : '';
  // A new session loads the installed am, which may be newer than this runner's folder: allow its Codex script too.
  const installedAm = CODEX_STAGES.includes(kind) && !pluginDirFor(amRoot, env) ? am().map((p) => path.resolve(p)) : [];
  const same = (a, b) => (WIN ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (installedAm.length && !installedAm.some((p) => same(p, path.resolve(amRoot)))) {
    event({ ev: 'note', text: `this am:auto session runs am from ${amRoot}, but stage sessions load the installed am from ${installedAm.join(', ')}; the Codex second opinion is allowed for both. Restart the session that runs am:auto to use one version.` });
  }
  const perm = permissions(kind, { push, amRoot, orchRoot, memDir, slug, installedAm });
  const inst = instructions(kind, slug, { ...opts, memDir, compacted: result.compacted, unquoted: resolveCommand(bin, env).shell });
  let { prompt } = inst;
  if (stageModel) {
    const skillRel = `.am/${slug}/skill-${kind}.md`;
    writeFileSync(path.join(cwd, skillRel), inlineSkill(readFileSync(path.join(skillRoot, 'skills', inst.skill, 'SKILL.md'), 'utf8'), inst.args, skillRoot));
    prompt = inlinePrompt(slug, kind, `${inst.plugin}:${inst.skill}`);
  }
  const pluginDir = pluginDirFor(amRoot, env);
  const systemRel = `.am/${slug}/stage-${kind}.system.md`;
  writeFileSync(path.join(cwd, systemRel), inst.system);
  const timeoutMs = limits[kind] * 60000;

  const call = async (args) => {
    const r = await exec(bin, [...pre, ...args], { cwd, env: sessionEnv(kind, env, process.pid), timeoutMs });
    const parsed = parseResult(r.stdout);
    if (parsed && Number.isFinite(parsed.total_cost_usd)) result.costUsd = compaction.costUsd + parsed.total_cost_usd; // a resumed session reports the whole conversation
    if (parsed?.session_id) result.sessionId = parsed.session_id;
    for (const d of Array.isArray(parsed?.permission_denials) ? parsed.permission_denials : []) {
      const input = (d && d.tool_input) || {};
      const what = input.command || input.file_path || '';
      result.denied.push(`${(d && d.tool_name) || '?'}${what ? `: ${String(what).replace(/\s+/g, ' ').slice(0, 160)}` : ''}`);
    }
    return { r, parsed };
  };

  if (kind === 'handover') {
    // Stopped in finish, which copies once more so that every copied line comes before the end event.
    const relay = runRelay(cwd, slug, { resume: opts.resume, now });
    const timer = setInterval(relay, relayMs);
    timer.unref();
    stopRelay = () => {
      clearInterval(timer);
      relay();
    };
  }
  if (kind === 'plan' || kind === 'do') {
    // Stopped in finish, which reads once more so that every second-opinion line comes before the end event.
    const scan = opinionWatch(cwd, slug, kind, { now });
    const timer = setInterval(() => scan(false), opinionMs);
    timer.unref();
    stopOpinions = (whole) => {
      clearInterval(timer);
      scan(whole);
    };
  }
  if (stageModel) event({ ev: 'note', text: `model ${stageModel.model}, effort ${stageModel.effort} from the user's setting ${userFile}` });
  const { r, parsed } = await call(claudeArgs(perm, { prompt, systemFile: systemRel, pluginDir, model: stageModel }));
  if (r.spawnError) return done({ status: 'unavailable', reason: `could not start ${bin}: ${r.spawnError}` });
  const problem = (x) => {
    if (x.r.timedOut) return `no end within ${limits[kind]} minutes; the session was stopped`;
    if (!x.parsed) return `unreadable output (exit ${x.r.code}): ${(x.r.stderr || x.r.stdout).trim().slice(-TAIL_CHARS)}`;
    if (x.r.code !== 0 || x.parsed.is_error) return `claude ended with an error (${x.parsed.subtype || `exit ${x.r.code}`}): ${String(x.parsed.result || x.r.stderr).trim().slice(-TAIL_CHARS)}`;
    return null;
  };
  let why = problem({ r, parsed });
  const text = String(parsed?.result ?? '');
  let mark = why ? null : lastMark(text, MARKS[kind]);
  const marks = MARKS[kind].map((m) => `AM_STAGE: ${m}`).join(' or ');
  // Ask the same session once more: for the marker line only, or to save a plan that a refused write left unsaved.
  const unsaved = kind === 'plan' && mark === 'READY' && !existsSync(planFile);
  const ask = unsaved
    ? `The plan was not saved: .am/${slug}/plan.md does not exist. In this session only the Write and Edit tools can create files, and only under .am/${slug}/; Bash cannot write files here. Save the plan now with the Write tool at exactly .am/${slug}/plan.md. End with exactly one line: ${marks}`
    : !why && !mark ? `Reply with exactly one line and nothing else: ${marks}` : null;
  if (ask && result.sessionId) {
    event({ ev: 'note', text: unsaved ? 'asking the session again to save plan.md' : 'asking the session again for its end line' });
    const again = await call(claudeArgs(perm, { prompt: ask, resume: result.sessionId, pluginDir, model: stageModel }));
    why = problem(again);
    mark = why ? null : lastMark(again.parsed.result, MARKS[kind]);
  }
  if (!why && kind === 'plan' && mark === 'READY' && !existsSync(planFile)) why = `the session said READY but .am/${slug}/plan.md was not saved`;
  if (text) {
    result.reply = `.am/${slug}/stage-${kind}.reply.md`;
    writeFileSync(path.join(cwd, result.reply), `${text.trim()}\n`);
  }
  if (why) result.reason = why;
  else if (!mark) result.reason = 'the session ended without an AM_STAGE line';
  else result.status = mark;
  return done();
}

// ------------------------------------------------------------------ worker mode

/** Whether a line is one JSON object. */
const jsonLine = (line) => {
  try {
    const v = JSON.parse(line);
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  } catch {
    return false;
  }
};

/** A task file's size and change time, or null when it cannot be read: what a result is compared with before it is delivered. */
export function fileState(dir, name) {
  try {
    const s = statSync(path.join(dir, name));
    return { size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return null;
  }
}

/** Claims the result of the worker with this pid: `won` (this call made the mark), `taken` (it was there) or `error`. */
export function claimResult(dir, pid) {
  try {
    writeFileSync(path.join(dir, `${DELIVERED_PREFIX}${pid}`), new Date().toISOString(), { flag: 'wx' });
    return 'won';
  } catch (err) {
    return err?.code === 'EEXIST' ? 'taken' : 'error';
  }
}

/**
 * Worker mode (`--worker`): runs main for one stage of one task while holding .am/<slug>/stage-worker.json, logs main's
 * output to stage-worker.log and leaves the result in stage-result.json (atomic, written once). It stops by the stop
 * path (`failed`) on a signal, when main throws, or when the follower's heartbeat file stays the same for idleMs; it
 * stops quietly (no result, no end event, record untouched) when its record is taken by another worker. Once it holds
 * the record it removes the delivered marks of older results (and a result left under its own, reused pid). Returns the
 * exit code; every wait is a parameter, the rest goes to main.
 */
export async function worker(argv, { tickMs = WORKER_TICK_MS, staleMs = WORKER_STALE_MS, confirmMs = WORKER_CONFIRM_MS, busyMs = WORKER_BUSY_MS, busyPollMs = WORKER_BUSY_POLL_MS, idleMs = WORKER_IDLE_MS, exit = (c) => process.exit(c), on = (s, f) => process.on(s, f), out = process.stdout, ...rest } = {}) {
  const args = stageArgs(argv);
  if (!args) {
    out.write(BAD_ARGS);
    return 1;
  }
  const { stage, slug, push, fix } = args;
  const { cwd = process.cwd(), now = Date.now, alive = pidAlive, kill = signalRun } = rest;
  const dir = path.join(cwd, '.am', slug);
  const file = (name) => path.join(dir, WORKER_FILES[name]);
  const log = (text) => {
    try {
      appendFileSync(file('log'), text);
    } catch {
      // Dropped, like a failed event write.
    }
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const lockOpts = { now, alive, fields: { stage, push, fix }, staleMs };
  let lock = takeLock(file('record'), lockOpts);
  if (lock?.suspect) {
    await sleep(confirmMs);
    lock = takeLock(file('record'), { ...lockOpts, suspect: lock.suspect });
  }
  // The worker before this one releases its record only after main returned: try again for a moment. A worker of this
  // same stage already runs it: no second try.
  const sameStage = () => {
    const r = readJson(file('record'));
    return Boolean(r) && r.stage === stage && r.push === push && r.fix === fix;
  };
  const giveUp = Date.now() + busyMs;
  while (lock && lock.busy !== undefined && !sameStage() && Date.now() < giveUp) {
    await sleep(busyPollMs);
    lock = takeLock(file('record'), lockOpts);
  }
  if (!lock) {
    out.write(`the stage worker record .am/${slug}/${WORKER_FILES.record} cannot be made; the stage did not run\n`);
    return 1;
  }
  if (lock.busy !== undefined) {
    log(`another stage worker of this task is running (pid ${lock.busy ?? '?'})\n`);
    return 1;
  }
  // Marks of older results go; the mark of the result still on file stays, unless that result carries this pid (reused).
  try {
    let kept = readJson(file('result'))?.pid;
    if (kept === process.pid) {
      rmSync(file('result'), { force: true });
      kept = null;
    }
    for (const name of readdirSync(dir)) {
      if (name.startsWith(DELIVERED_PREFIX) && name !== `${DELIVERED_PREFIX}${kept}`) rmSync(path.join(dir, name), { force: true });
    }
  } catch {
    // A mark left behind names no result on file: it is never read.
  }
  try {
    writeFileSync(file('log'), '');
  } catch {
    // The log is for reading only.
  }
  let partial = '';
  let caught = null; // the last complete JSON line main wrote
  const sink = {
    write: (s) => {
      const text = String(s);
      log(text);
      const lines = (partial + text).split('\n');
      partial = lines.pop();
      for (const line of lines) if (jsonLine(line)) caught = line;
      return true;
    },
  };
  const failedLine = (reason) => stageLine(stage, slug, 'failed', reason);
  const writeResult = (line, delivered) => {
    const target = file('result');
    const tmp = `${target}.${process.pid}.tmp`;
    const res = { pid: process.pid, stage, push, fix, line, t: new Date(now()).toISOString(), delivered, plan: fileState(dir, 'plan.md'), check: fileState(dir, 'check.md') };
    try {
      writeFileSync(tmp, `${JSON.stringify(res)}\n`);
      renameSync(tmp, target);
    } catch (err) {
      log(`the stage result could not be written: ${err.message}\n`);
      try {
        rmSync(tmp, { force: true });
      } catch {
        // Left behind.
      }
    }
  };
  let ended = false;
  let stopped = false; // ended by a stop, not by main's own end
  let timer = null;
  // Once: the result while the record is still this worker's, then the record goes.
  const wrapUp = (line, delivered) => {
    if (ended) return false;
    ended = true;
    if (lock.owns() === 'yes') writeResult(line, delivered);
    lock.release();
    clearInterval(timer);
    return true;
  };
  const stopExit = (reason, delivered, { keepCaught = true } = {}) => () => {
    if (wrapUp((keepCaught && caught) || failedLine(reason), delivered)) stopped = true;
    exit(1);
  };
  // Pushed out by another worker: take the session down and leave everything else to the new owner.
  const pushedOut = () => {
    ended = true;
    stopped = true;
    clearInterval(timer);
    for (const child of active) killTree(child);
    // The new owner cannot use this worker's orchestrator run (the start lock waits on its lock): stop it too.
    stopHandedRun(cwd, process.pid, { alive, kill });
    exit(1);
  };
  let missing = 0;
  let idle = 0;
  const readBeat = () => {
    try {
      return readFileSync(file('heartbeat'), 'utf8');
    } catch {
      return null; // no file is a value too: a worker nobody ever followed stops as well
    }
  };
  let beat = readBeat();
  const tick = () => {
    if (ended) return;
    try {
      const own = lock.owns();
      if (own === 'other') return pushedOut();
      if (own === 'missing') {
        // Another worker may have moved it aside for a moment: only a second missing look counts.
        if (++missing >= 2) pushedOut();
        return;
      }
      missing = 0;
      try {
        const t = new Date(now());
        utimesSync(file('record'), t, t);
      } catch {
        // Looked at again at the next tick.
      }
      const next = readBeat();
      if (next === beat) idle += tickMs;
      else {
        idle = 0;
        beat = next;
      }
      if (idle >= idleMs) {
        const reason = `stopped: nobody followed this stage for ${Math.round(idleMs / 60000)} minutes`;
        interrupt('heartbeat', { exit: stopExit(reason, true, { keepCaught: false }), reason });
      }
    } catch {
      // A throw in a timer would end the process without a result.
    }
  };
  timer = setInterval(tick, tickMs);
  timer.unref();
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) on(sig, () => interrupt(sig, { exit: stopExit(`stopped by ${sig}`, false) }));
  let code;
  try {
    code = await main(argv, { ...rest, out: sink });
  } catch (err) {
    const reason = `the stage runner failed: ${err?.message ?? err}`;
    interrupt('error', { exit: stopExit(reason, false), reason });
  }
  if (stopped) return 1;
  wrapUp(caught || failedLine('the stage ended without a result line'), false);
  return code ?? 1;
}

// ------------------------------------------------------------------ follow mode

// Passes a stop signal on to a worker: the signal on POSIX, the whole tree on Windows (target: the ChildProcess, or an
// object with its pid and kill()).
const passStop = (target, sig) => {
  if (WIN) return killTree(target);
  try {
    process.kill(target.pid, sig);
  } catch {
    // Already gone.
  }
};

/**
 * The command without --worker: starts the stage as a detached worker and follows it, then prints the worker's result
 * line. A live worker of this task for the same stage and flags is followed instead; one of another stage is waited for
 * up to waitMs, then the call ends WAIT. A task without its folder runs main here (it ends at once with no file).
 * Every result it prints is claimed by its delivered mark; before a start, a pending result is delivered or dropped.
 * Returns the exit code; every wait is a parameter, the rest goes to main.
 */
export async function follow(argv, { followMs = FOLLOW_MS, waitMs = WAIT_MS, staleMs = WORKER_STALE_MS, confirmMs = WORKER_CONFIRM_MS, stopMs = FOLLOW_STOP_MS, workerCmd = [process.execPath, fileURLToPath(import.meta.url), '--worker'], kill = passStop, on = (s, f) => process.on(s, f), out = process.stdout, cwd = process.cwd(), env, now = Date.now, alive = pidAlive, ...rest } = {}) {
  const args = stageArgs(argv);
  if (!args) {
    out.write(BAD_ARGS);
    return 1;
  }
  const { stage, slug, push, fix } = args;
  const dir = path.join(cwd, '.am', slug);
  if (!existsSync(dir)) return main(argv, { ...rest, cwd, env, out, now, alive });
  const file = (name) => path.join(dir, WORKER_FILES[name]);
  const began = now();
  const waitBegan = Date.now(); // the waits are timed by the clock that setTimeout uses
  const print = (line, code) => {
    out.write(`${line}\n`);
    return code;
  };
  // Only a result of this stage and flags written after this call began: not an older one, not another stage's.
  const accepted = () => {
    const r = readJson(file('result'));
    if (!r || r.stage !== stage || r.push !== push || r.fix !== fix || typeof r.line !== 'string') return null;
    return Date.parse(r.t) >= began ? r : null;
  };
  const markable = (pid) => Number.isInteger(pid) && pid > 0;
  // A result this call takes: printed first, then claimed (a follower prints it even when the claim is lost).
  const take = (r, code) => {
    print(r.line, code);
    if (markable(r.pid)) claimResult(dir, r.pid);
    return code;
  };
  // The result on file when nobody took it yet: not handed out at its worker's end, and not claimed.
  const pending = () => {
    const r = readJson(file('result'));
    if (!r || !markable(r.pid) || typeof r.line !== 'string' || r.delivered === true) return null;
    return existsSync(path.join(dir, `${DELIVERED_PREFIX}${r.pid}`)) ? null : r;
  };
  const sameState = (a, b) => (a === null || b === null ? a === b : Boolean(a) && a.size === b.size && a.mtimeMs === b.mtimeMs);
  // Whether a pending result may stand for this call: same stage and flags, not a wait, not a stop, and plan.md and
  // check.md as it left them. Its age does not count.
  const deliverable = (r) => {
    if (r.stage !== stage || r.push !== push || r.fix !== fix) return false;
    let line = null;
    try {
      line = JSON.parse(r.line);
    } catch {
      return false;
    }
    if (!line || typeof line !== 'object' || line.status === 'WAIT') return false;
    if (line.status === 'failed' && String(line.reason ?? '').startsWith('stopped by ')) return false;
    return sameState(r.plan, fileState(dir, 'plan.md')) && sameState(r.check, fileState(dir, 'check.md'));
  };
  // Before a worker starts: the pending result's line when it may be delivered and this call claimed it or lost the
  // claim to another call; any other pending result is claimed only, so that it never comes back.
  const fromPending = () => {
    const r = pending();
    if (!r) return null;
    if (!deliverable(r)) {
      claimResult(dir, r.pid);
      return null;
    }
    return claimResult(dir, r.pid) === 'error' ? null : r.line;
  };
  let suspectSeen = null; // {snap, at}: the first look at a record that was only suspect
  // The record now: `same` (a live worker of this stage and flags), `other`, `suspect` (not yet confirmed) or `none`.
  const look = () => {
    const ready = Boolean(suspectSeen) && Date.now() - suspectSeen.at >= confirmMs;
    const state = ownerState(file('record'), { now, alive, staleMs, suspect: ready ? suspectSeen.snap : null });
    if (state === 'dead') {
      suspectSeen = null;
      return { kind: 'none' };
    }
    if (state === 'suspect') {
      if (!suspectSeen || ready) suspectSeen = { snap: lockSnapshot(file('record')), at: Date.now() };
      return { kind: 'suspect' };
    }
    suspectSeen = null;
    const r = readJson(file('record'));
    if (r && r.stage === stage && r.push === push && r.fix === fix) return { kind: 'same', pid: r.pid };
    const name = r && typeof r.stage === 'string' ? `${r.stage}${r.push ? ' --push' : ''}${r.fix ? ' --fix' : ''}` : 'other';
    return { kind: 'other', pid: r?.pid ?? '?', name };
  };
  let beats = 0;
  const heartbeat = () => {
    try {
      writeFileSync(file('heartbeat'), `${process.pid} ${++beats}`);
    } catch {
      // The worker reads it at its next tick.
    }
  };
  let child = null; // the worker this call started, while it counts
  let ownHeld = false; // that worker held the record: it ran this stage
  let spawnError = '';
  let attached = null; // pid of the live same-stage worker last followed
  let sawOther = false; // another stage held the record while this call's worker had not held it
  // This call's worker ended without running the stage because another stage held the record: it may start again.
  const lostToOther = () => Boolean(child?.done) && sawOther && !ownHeld && attached === null && !spawnError;
  const start = () => {
    let fd = 'ignore';
    try {
      fd = openSync(file('log'), 'a');
    } catch {
      // Its output is lost.
    }
    try {
      const c = spawn(workerCmd[0], [...workerCmd.slice(1), ...argv], { cwd, env, detached: true, stdio: ['ignore', fd, fd], windowsHide: true });
      c.done = false;
      c.on('exit', () => (c.done = true));
      c.on('error', (err) => {
        c.done = true;
        spawnError = `the stage worker could not start: ${err.message}`;
      });
      c.unref();
      child = c;
    } catch (err) {
      spawnError = `the stage worker could not start: ${err.message}`;
    } finally {
      if (typeof fd === 'number') closeSync(fd);
    }
  };
  let sig = null;
  let target = null;
  let stopAt = 0;
  let wake = null;
  const sleep = (ms) =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  // The followed worker, when the record still names it as a live worker of this stage.
  const liveAttached = () => attached !== null && ownerState(file('record'), { now, alive }) === 'live' && readJson(file('record'))?.pid === attached;
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    on(s, () => {
      if (sig) return;
      sig = s;
      if (child && !child.done) target = child;
      else if (liveAttached()) {
        const pid = attached;
        target = {
          pid,
          kill: (k) => {
            try {
              process.kill(pid, k);
            } catch {
              // Already gone.
            }
          },
        };
      }
      if (target) {
        kill(target, s);
        // Its stop is told here: the next call must not get that result again.
        if (markable(target.pid)) claimResult(dir, target.pid);
        stopAt = Date.now() + stopMs;
      }
      wake?.();
    });
  }
  for (;;) {
    const got = accepted();
    if (got) return take(got, sig ? 1 : 0);
    if (sig) {
      if (!target) return 1;
      const ended = target === child ? child.done : !liveAttached();
      if (ended || Date.now() >= stopAt) {
        const last = accepted();
        return last ? take(last, 1) : print(stageLine(stage, slug, 'failed', `stopped by ${sig}`), 1);
      }
    } else {
      const seen = look();
      if (seen.kind === 'same') {
        attached = seen.pid;
        if (child && seen.pid === child.pid) ownHeld = true;
        heartbeat();
      } else if (seen.kind === 'other') {
        if (child && !ownHeld && attached === null) sawOther = true;
        if (lostToOther()) {
          child = null;
          sawOther = false;
        }
        if (!(child && !child.done) && Date.now() - waitBegan >= waitMs) {
          return print(stageLine(stage, slug, 'WAIT', `waiting for another stage of this task: the ${seen.name} stage is still running (pid ${seen.pid})`), 0);
        }
      } else if (seen.kind === 'none') {
        if (child && !child.done) heartbeat();
        else if (lostToOther()) {
          // That stage ended before this look: start this one now.
          child = null;
          sawOther = false;
          const held = fromPending();
          if (held) return print(held, 0);
          start();
        } else if (child || attached !== null || spawnError) {
          // What was followed ended: its result or a new owner may have come just now.
          const again = accepted();
          if (again) return take(again, 0);
          // Attached just as it ended, after its result was written: that result, once.
          const left = pending();
          if (left && deliverable(left) && claimResult(dir, left.pid) !== 'error') return print(left.line, 0);
          if (look().kind === 'none') return print(stageLine(stage, slug, 'failed', spawnError || `the stage worker ended without a result; see .am/${slug}/${WORKER_FILES.log}`), 0);
        } else {
          const held = fromPending();
          if (held) return print(held, 0);
          start();
        }
      }
    }
    await sleep(followMs);
  }
}

// Compare real paths: import.meta.url has symlinks resolved, argv[1] does not.
const isMain = () => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
};

/** What a stop signal does: write the end event of every running stage, take the stage sessions down, exit 1. */
export function interrupt(sig, { exit = process.exit, reason = `stopped by ${sig}` } = {}) {
  for (const finish of [...finishers]) finish({ status: 'failed', reason, stopped: true });
  for (const child of active) killTree(child);
  exit(1);
}

if (isMain()) {
  if (process.argv[2] === '--worker') {
    // The worker sets up its own stop signals.
    worker(process.argv.slice(3)).then((code) => {
      process.exitCode = code;
    });
  } else {
    // The follower sets up its own stop signals and passes them on to the worker.
    follow(process.argv.slice(2)).then((code) => {
      process.exitCode = code;
    });
  }
}
