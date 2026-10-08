// am:auto stage runner (Claude Code only).
// Runs one phase of am:auto in a fresh `claude -p` session, so every phase starts with a
// clean conversation: no conversation carries over, only the working tree and the files in
// .am/<slug>/. request.md (the user's request, written by am:auto) goes to the plan stage;
// plan.md goes to every stage after it and brings the user's answers back; check.md goes to
// the --fix run of do, to compactmem and to commit; compactmem.md (the memory proposal) is
// for the user and a later am:compactmem run. This script adds stage-<kind>.system.md (the
// session's instructions) and stage-<kind>.reply.md (its last reply, which am:auto reads
// for its final reply). Each stage gets its allowed tools up front (a stage session cannot
// show a permission prompt), calls its am skill by slash command (so the skill's own model
// and effort apply), and ends with one marker line that this script reads. Called by am:auto:
//   node stage.mjs <plan|do|check|compactmem|commit> <slug> [--push] [--fix]
// The do stage becomes a hand-over to the am-orchestrator run skill when the plan says so.
// Before the stage, task files that hold more than about 13,000 tokens are shortened in a short session of their own
// (originals kept as <name>.orig-<n>.md); `compacted` reports it. The request (request.md) is the user's own words: never
// counted, never shortened. Nothing is shortened before the plan stage or a hand-over.
// Each stage appends to .am/<slug>/progress.jsonl: `start` (pid, stage), a `note` for a compaction, a second ask or a
// hand-over, and one `end` (status, min) on every way out; write errors are dropped (see progress.mjs). During a hand-over
// the news of the orchestrator run (.orchestrator/runs/<run>/progress.jsonl) is copied in as lines with `src: "run"`.
// Prints one JSON line: {stage, slug, status, reason, costUsd, sessionId, reply, denied, compacted}.
// status `unavailable`: no session could be started (no claude command); `failed`: one
// started but did not finish with a marker. Exit codes: 0 result printed, 1 bad input.
// Node only, no dependencies.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findOnPath, killTree } from '../hooks/gate.mjs';
import { findOrchestrator, readPlan, withinOneRun } from '../hooks/handover.mjs';
import { appendEvent, readFrom } from './progress.mjs';

const WIN = process.platform === 'win32';
const AM_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = 'usage: node stage.mjs <plan|do|check|compactmem|commit> <slug> [--push] [--fix]';
export const STAGES = ['plan', 'do', 'check', 'compactmem', 'commit'];
// Minutes per session. The hand-over drives a whole orchestrator run, which takes hours.
// A caller of main that gives only some of them gets the rest from here.
export const TIMEOUT_MIN = { plan: 75, do: 90, handover: 1440, check: 45, compactmem: 20, commit: 25, compact: 15 };
// How often a hand-over copies the run's new event lines into the task's event file.
export const RELAY_MS = 5000;
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
// The compaction session runs no skill, so it gets its model and effort as arguments (written by scripts/models.mjs).
export const COMPACT_MODEL = { model: 'opus', effort: 'medium' };

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

/** An Edit rule for everything under an absolute folder: `//` starts a path from the file system root, a Windows drive as `/c` (measured on Windows). */
export const absEdit = (dir) => `Edit(/${path.resolve(dir).split(path.sep).join('/').replace(/^([A-Za-z]):/, (m, d) => `/${d.toLowerCase()}`)}/**)`;

/** Allowed and denied tools of one stage, after the orchestrator's stage profiles. `/x` is from the repository root. */
export function permissions(stage, { push = false, amRoot = AM_ROOT, orchRoot = '', memDir = '', slug = '' } = {}) {
  const read = ['Read', 'Glob', 'Grep'];
  const gitRead = ['Bash(git status *)', 'Bash(git diff *)', 'Bash(git log *)', 'Bash(git ls-files *)', 'Bash(git check-ignore *)', 'Bash(git rev-parse *)'];
  const edit = (dir) => [`Edit(/${dir}/**)`, `Edit(${dir}/**)`];
  const pushRules = ['Bash(git push)', 'Bash(git push *)'];
  const noHuman = ['AskUserQuestion'];
  const stashWrites = ['push', 'save', 'pop', 'apply', 'drop', 'clear', 'create', 'store', 'branch'].flatMap((c) => [`Bash(git stash ${c})`, `Bash(git stash ${c} *)`]);
  const noHistory = ['Bash(git commit *)', ...pushRules, 'Bash(git reset *)', 'Bash(git checkout *)', 'Bash(git switch *)', 'Bash(git stash)', 'Bash(git stash -*)', ...stashWrites];
  switch (stage) {
    case 'plan':
      return { mode: 'dontAsk', allow: sh([...read, ...edit('.am'), ...gitRead, ...nodeScript(path.join(amRoot, 'scripts', 'codex-opinion.mjs'))]), deny: noHuman };
    case 'do':
    case 'check':
      return { mode: 'acceptEdits', allow: sh([...read, 'Edit', 'Bash']), deny: sh([...noHuman, ...noHistory]) };
    case 'compactmem':
      // Reads the memory folder outside the repository; writes only the proposal under .am/. A deny rule wins over any allowance, so memory is never changed here.
      return { mode: 'dontAsk', allow: sh([...read, ...edit('.am'), ...gitRead, 'Bash(git show *)']), deny: [...noHuman, ...(memDir ? [absEdit(memDir)] : [])] };
    case 'commit':
      return { mode: 'dontAsk', allow: sh([...read, ...gitRead, 'Bash(git add *)', 'Bash(git commit *)', 'Bash(git restore *)', ...(push ? pushRules : [])]), deny: sh([...noHuman, ...(push ? [] : pushRules)]) };
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
- ${resume ? 'The Change log of the plan already records the hand-over with a run ID. Check that `status --json` shows the same `run.id` (if not, end with AM_STAGE: BLOCKED and say why). If the log also records the merge, only the push below is left.' : 'Before `split`, note `run.id` from `status --json` (none if `run` is null). Once `split` has made the run (`run.id` present and not the noted one; otherwise end with AM_STAGE: BLOCKED and say why), log in one Change log line of the plan that it went to the am-orchestrator run skill, with `run.id` and the current branch as the start branch.'}
- Its \`decide\` questions are scope or screen questions: decide them as above and pass each answer with \`decide\`. Its \`answer\` and \`blocked\` questions, and any question of its Prepare step, are stops: write the card into plan.md as above. When plan.md holds the user's answer to such a card, pass it to the run skill (\`answer\`, \`decide\`), or carry out exactly the action the answer names (for example write am-gate.json and commit it, or commit or stash the changes it names) and nothing more.
- Its rule never to merge or push covers its own flow only. When \`next\` is \`done\`: unless \`run.branch\` is the start branch, check out the start branch and run \`git merge --ff-only <run.branch>\` and \`git branch -d <run.branch>\`, and log the merge under Change log. ${push ? 'Then push the start branch by the push rules of the am:commit skill (its step 6): never force, never skip hooks, and if the push is rejected report it.' : 'Do not push.'} A fast-forward that fails is a stop (end with AM_STAGE: BLOCKED and say which branch holds which commits).
- Do not run the \`progress\` command of the run skill's script, even where the skill says to start it: nobody reads this session, and the am stage runner copies the run's news into this task's event file itself.
- In your final reply give: tasks done of all and the branch, \`costUsd\`, the human checklist of the report at \`run.report\` (shortened, with its path), and every line of \`autoDecided\`.
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
- What this session can do: read anything, including the memory folder outside the repository; create or change files only under .am/${slug}/ with the Write or Edit tool; run read-only git commands (including git show). Everything else is refused.
- This stage cannot finish when the proposal cannot be written: end with AM_STAGE: BLOCKED and say why. NOTHING means no memory folder, no memory file, or no memory about this task.
- ${MARK('compactmem')}`,
  commit: (slug, { push }) => `This is the commit stage for .am/${slug}/, with the am:commit skill. The am:auto run asks for this commit on the user's behalf; that counts as the user asking.${push ? ' Push mode is on: push after committing by the skill\'s rules.' : ' Do not push.'}
- A file you cannot tell belongs to this task: leave it out of the commit and name it in your reply.
- If the gate could not run (status \`error\`, or \`node\` missing), commit but do not push, and say why.
- If a hook rejects the commit, do not bypass it and do not retry another way; copy what it printed into your reply.
- Run each git command on its own from the repository root: no cd, no pipes, no chains, no heredoc; use several -m flags for several paragraphs.
- ${MARK('commit')}`,
};

/** The prompt and appended system prompt of one session. */
export function instructions(stage, slug, { push = false, fix = false, resume = false, unquoted = false, memDir = '', compacted = null } = {}) {
  const prompts = {
    plan: `/am:plan Read the request in .am/${slug}/request.md (slug ${slug})`,
    do: `/am:do ${slug}`,
    handover: resume ? '/am-orchestrator:run' : `/am-orchestrator:run .am/${slug}/plan.md`,
    check: `/am:check ${slug}`,
    compactmem: `/am:compactmem ${slug}`,
    commit: push ? '/am:commit push' : '/am:commit',
  };
  // cmd.exe cannot pass a quoted allow rule (see exec), so such a session must run node scripts with the path unquoted.
  const note = unquoted && (stage === 'plan' || stage === 'handover') ? '\n- Run node scripts with the path unquoted (node C:/path/to/script.mjs ...): the permission rules of this session allow only that form.' : '';
  const shortened = compacted?.originals ? `\n- Before this session the am stage runner shortened ${compacted.files.join(', ')} to keep this context small; the originals are ${compacted.originals.join(', ')}. Open an original only when a detail you need is missing from the shortened file.` : '';
  return { prompt: prompts[stage], system: `${unattended(slug, stage, push)}\n\n${STAGE_RULES[stage](slug, { push, fix, resume, memDir })}\n${ONE_COMMAND}${note}${shortened}\n` };
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
- Keep the file's language and its Markdown structure. Keep exactly: every heading line; the Scale line (\`Scale: N implementation runs, M commits\` or \`규모: 구현 N회, 커밋 M개\`); every line that starts with a number and a period, with its Check and its done mark ((done) or (완료)); every decision line with its mark ((auto-decided), (자동 결정), or the user's answer); every decision card marked OPEN, in full; Change log lines that record a hand-over with a run ID, or a merge; in check.md the verdict, the gate result and the human checklist; file paths, commands, names and numbers a later step needs.
- Keep every occurrence of these marks, also inside prose, as many times as now: (done), (완료), (auto-decided), (자동 결정), and the word OPEN.
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

/** The claude arguments of one session. No --model or --effort for a stage: the slash call carries the skill's own. Only the compaction session, which runs no skill, passes `model`. */
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
 * is put back as well. Returns {compacted, costUsd}; `compacted` is
 * null (nothing to do), {files, before, after, originals}, or {files, failed}.
 */
async function compactContext(cwd, slug, kind, { fix = false, env = process.env, claude = ['claude'], timeoutMin = TIMEOUT_MIN, limit = CONTEXT_LIMIT, target = CONTEXT_TARGET, note = () => {} } = {}) {
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
  const [bin, ...pre] = claude;
  const r = await exec(bin, [...pre, ...claudeArgs(permissions('compact', { slug }), { prompt, systemFile: systemRel, model: COMPACT_MODEL })], { cwd, env, timeoutMs: timeoutMin.compact * 60000 });
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

/** Runs one stage and writes its JSON result line. Returns the exit code. */
export async function main(argv, { cwd = process.cwd(), env = process.env, claude = ['claude'], timeoutMin = TIMEOUT_MIN, orchestrator = findOrchestrator, amRoot = AM_ROOT, out = process.stdout, now = Date.now, relayMs = RELAY_MS } = {}) {
  const [stage, slug, ...flags] = argv;
  if (!STAGES.includes(stage) || !/^[a-z0-9][a-z0-9-]*$/.test(slug || '') || flags.some((f) => f !== '--push' && f !== '--fix')) {
    out.write(`bad arguments (the slug is lowercase kebab-case)\n${USAGE}\n`);
    return 1;
  }
  // Limits the caller left out (undefined or null) are the defaults; any other value is used as given.
  const limits = Object.fromEntries(Object.keys(TIMEOUT_MIN).map((key) => [key, timeoutMin[key] ?? TIMEOUT_MIN[key]]));
  const push = flags.includes('--push');
  const fix = flags.includes('--fix');
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
  if (stage === 'plan' && !existsSync(path.join(dir, 'request.md'))) return done({ reason: `no .am/${slug}/request.md: write the request there first` });
  if (stage !== 'plan' && !existsSync(planFile)) return done({ reason: `no .am/${slug}/plan.md: run the plan stage first` });
  ensureIgnored(cwd);
  const startedAt = now();
  const event = (fields) => appendEvent(cwd, slug, fields, { now });
  event({ ev: 'start', text: `stage ${stage} started`, pid: process.pid, stage });
  let stopRelay = null; // set while a hand-over copies the run's events
  finish = ({ status, reason }) => {
    if (!finishers.has(finish)) return;
    finishers.delete(finish);
    stopRelay?.();
    const first = String(reason || '').split('\n')[0].replace(/\s+/g, ' ').trim().slice(0, 200);
    event({ ev: 'end', text: first || `${result.stage} stage ended`, stage: result.stage, status, min: Math.max(0, Math.floor((now() - startedAt) / 60000)) });
  };
  finishers.add(finish);

  let kind = stage;
  let opts = { push, fix };
  let orchRoot = '';
  if (stage === 'do') {
    const k = doKind(readFileSync(planFile, 'utf8'), { orchestrator, fix });
    if (k.error) return done({ reason: k.error });
    kind = k.kind;
    opts = { ...opts, resume: k.resume };
    orchRoot = k.orchRoot || '';
    if (kind === 'handover' && !orchRoot) return done({ stage: kind, reason: 'the plan records a hand-over, but the am-orchestrator run skill is not installed or not enabled' });
  }
  result.stage = kind;
  if (kind === 'handover') event({ ev: 'note', text: 'handed to the am-orchestrator run skill', stage: 'handover' });
  const [bin, ...pre] = claude;
  // Shorten the task files first when they are too large; a failure leaves them as they were and the stage goes on.
  const compaction = await compactContext(cwd, slug, kind, { fix, env, claude, timeoutMin: limits, note: (text) => event({ ev: 'note', text }) });
  result.compacted = compaction.compacted;
  const c = compaction.compacted;
  if (c) event({ ev: 'note', text: c.failed ? `shortening undone, files kept: ${c.failed.split('\n')[0]}` : `shortened ${c.files.join(', ')}: about ${c.before} -> ${c.after} tokens` });
  result.costUsd = compaction.costUsd;
  const memDir = kind === 'compactmem' ? memoryDir(cwd, env) : '';
  const perm = permissions(kind, { push, amRoot, orchRoot, memDir });
  const { prompt, system } = instructions(kind, slug, { ...opts, memDir, compacted: result.compacted, unquoted: resolveCommand(bin, env).shell });
  const pluginDir = pluginDirFor(amRoot, env);
  const systemRel = `.am/${slug}/stage-${kind}.system.md`;
  writeFileSync(path.join(cwd, systemRel), system);
  const timeoutMs = limits[kind] * 60000;

  const call = async (args) => {
    const r = await exec(bin, [...pre, ...args], { cwd, env, timeoutMs });
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
  const { r, parsed } = await call(claudeArgs(perm, { prompt, systemFile: systemRel, pluginDir }));
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
    const again = await call(claudeArgs(perm, { prompt: ask, resume: result.sessionId, pluginDir }));
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

// Compare real paths: import.meta.url has symlinks resolved, argv[1] does not.
const isMain = () => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
};

/** What a stop signal does: write the end event of every running stage, take the stage sessions down, exit 1. */
export function interrupt(sig, { exit = process.exit } = {}) {
  for (const finish of [...finishers]) finish({ status: 'failed', reason: `stopped by ${sig}` });
  for (const child of active) killTree(child);
  exit(1);
}

if (isMain()) {
  // A session that is stopped ends this script; take the stage session down with it.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => interrupt(sig));
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
