// am:auto hand-over guard.
// PreToolUse hook declared in the am:auto skill's frontmatter (Claude Code only), so
// it runs only in sessions that invoked am:auto, for the rest of the session. It
// blocks a file edit while this session's plan says the task is large (Scale above
// 1 implementation run or 1 commit), the am-orchestrator run skill is installed,
// and the plan was neither handed over nor started. Shell commands are not checked.
// Entry: node -e "import(...handover.mjs).then((m) => m.main())". Node only.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { denyOutput, findRepoRoot, readStdin } from './gate.mjs';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const STATE_DIR = path.join(tmpdir(), 'am-handover');
const PLAN = /^\.am\/[^/]+\/plan\.md$/;
const SCALE = /(?:Scale:\s*(\d+)\s+implementation runs?,\s*(\d+)\s+commits?|규모:\s*구현\s*(\d+)\s*회,\s*커밋\s*(\d+)\s*개)/i;
const DONE = /^\s*\d+\.\s.*\((?:done|완료)\)/im; // the am:do skill's mark on a step's first line
const DONE_ALL = new RegExp(DONE.source, DONE.flags + 'g'); // a copy for counting: DONE itself stays without `g`, so its test() keeps no position
const HANDED = /^(?=.*(?:orchestrator|오케스트레이터)).*(?:\b\d{8}-\d{4}\b|\brun\.?\s?id\b)/im; // am:auto logs the hand-over with the run ID (default YYYYMMDD-HHMM)

const ALLOW = { stdout: '' };
const slash = (p) => p.split(path.sep).join('/');

function deny(reason) {
  return { stdout: denyOutput(reason) };
}

/** What the plan says: {scale: [runs, commits] | null, started, handedOver}. */
export function readPlan(text) {
  const m = SCALE.exec(text);
  const scale = m ? [Number(m[1] ?? m[3]), Number(m[2] ?? m[4])] : null;
  return { scale, started: DONE.test(text), handedOver: HANDED.test(text) };
}

/** How many steps of the plan carry the am:do done mark. */
export function countDone(text) {
  return (String(text).match(DONE_ALL) || []).length;
}

/** True when the plan's Scale is at most 1 implementation run and 1 commit. */
export function withinOneRun(scale) {
  return scale && scale[0] <= 1 && scale[1] <= 1;
}

/** The install path of an enabled am-orchestrator with its run skill, from `claude plugin list --json`, or null. Any failure counts as not installed. */
export function findOrchestrator() {
  try {
    // One command string through the shell, so Windows finds claude.cmd as well as claude.exe.
    const r = spawnSync('claude plugin list --json', { encoding: 'utf8', timeout: 30000, shell: true, windowsHide: true });
    if (r.status !== 0) return null;
    const list = JSON.parse(r.stdout);
    const hit = Array.isArray(list) && list.find((p) => String(p.id).startsWith('am-orchestrator@') && p.enabled === true && typeof p.installPath === 'string' && existsSync(path.join(p.installPath, 'skills', 'run', 'SKILL.md')));
    return hit ? hit.installPath : null;
  } catch {
    return null;
  }
}

/** True when an enabled am-orchestrator with its run skill is installed. */
const orchestratorInstalled = () => Boolean(findOrchestrator());

function loadState(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function newestPlan(root) {
  let best = null;
  try {
    for (const slug of readdirSync(path.join(root, '.am'))) {
      const file = path.join(root, '.am', slug, 'plan.md');
      if (!existsSync(file)) continue;
      const t = statSync(file).mtimeMs;
      if (!best || t > best.t) best = { file, t };
    }
  } catch {
    return null;
  }
  return best && best.file;
}

/**
 * PreToolUse decision for one hook payload. Returns {stdout}; the caller always exits 0,
 * stdout empty or one JSON object (same contract as the commit gate).
 */
export function decide(raw, { stateDir = STATE_DIR, installed = orchestratorInstalled } = {}) {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return ALLOW;
  }
  const tool = payload && payload.tool_name;
  if (tool !== 'Read' && !EDIT_TOOLS.has(tool)) return ALLOW;
  const input = payload.tool_input || {};
  const target = input.file_path || input.notebook_path;
  if (typeof target !== 'string' || !target) return ALLOW;
  const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();
  const file = path.resolve(cwd, target);
  // The run's own files and its task worktrees (each has its own .git): the run skill and its tasks work there.
  if (slash(file).includes('/.orchestrator/')) return ALLOW;
  const root = findRepoRoot(path.dirname(file));
  if (!existsSync(path.join(root, '.git'))) return ALLOW;
  const rel = slash(path.relative(root, file));

  const id = typeof payload.session_id === 'string' && /^[\w-]+$/.test(payload.session_id) ? payload.session_id : null;
  const stateFile = id && path.join(stateDir, `${id}.json`);
  const state = stateFile ? loadState(stateFile) : {};
  const save = () => {
    if (!stateFile) return;
    mkdirSync(stateDir, { recursive: true });
    const tmp = `${stateFile}.${process.pid}.tmp`; // hooks of parallel tool calls run at once: never leave a half-written file
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, stateFile);
  };

  if (PLAN.test(rel)) {
    // The first plan the session reads is bound until it creates or edits one. A plan written or edited with a
    // Scale line always takes over (a later am:auto in the same session); one without it (a task plan fixed by
    // hand) only replaces a plan the session merely read.
    const rank = tool === 'Read' ? 'read' : tool === 'Write' && !existsSync(file) ? 'create' : 'edit';
    const written = [input.content, input.new_string, ...(Array.isArray(input.edits) ? input.edits.map((e) => e && e.new_string) : [])];
    const scaled = rank !== 'read' && [...written, rank === 'edit' ? readFileSync(file, 'utf8') : ''].some((s) => typeof s === 'string' && SCALE.test(s));
    if (!state.plan || (rank !== 'read' && (state.rank === 'read' || scaled))) {
      Object.assign(state, { plan: file, rank });
      save();
    }
    return ALLOW;
  }
  if (tool === 'Read') return ALLOW;
  // What a hand-over itself writes: plans and briefs, the run's files, the gate config.
  if (rel.startsWith('.am/') || rel.startsWith('.orchestrator/') || rel === 'am-gate.json') return ALLOW;

  const fromRoot = state.plan ? path.relative(root, state.plan) : '';
  // A plan on another drive gives an absolute path on Windows.
  const bound = Boolean(state.plan) && existsSync(state.plan) && !path.isAbsolute(fromRoot) && !fromRoot.startsWith('..');
  const plan = bound ? state.plan : newestPlan(root);
  if (!plan) return ALLOW;
  const info = readPlan(readFileSync(plan, 'utf8'));
  if (info.handedOver || info.started) return ALLOW;
  if (withinOneRun(info.scale)) return ALLOW;
  if (typeof state.installed !== 'boolean') {
    state.installed = installed();
    save();
  }
  if (!state.installed) return ALLOW;

  const planRel = slash(path.relative(root, plan));
  const which = bound
    ? `${planRel} (the plan this session ${state.rank === 'read' ? 'read' : state.rank === 'edit' ? 'edited' : 'created'})`
    : `${planRel} (the newest plan: this session has not read, edited or created one yet; if it is not yours, read or edit your own plan.md first and try again)`;
  if (!info.scale) {
    const warned = state.missingScale || [];
    if (warned.includes(plan)) return ALLOW;
    state.missingScale = [...warned, plan];
    save();
    return deny(`am:auto hand-over check: ${which} has no Scale line. Add it to the plan's Summary as am:auto step 3 says (\`Scale: N implementation runs, M commits\`, \`규모: 구현 N회, 커밋 M개\` in a Korean plan), then apply am:auto step 4: above 1 run or 1 commit, hand the plan to the am-orchestrator run skill instead of editing files here.`);
  }
  return deny(`am:auto hand-over check: ${which} says ${info.scale[0]} implementation runs and ${info.scale[1]} commits, the am-orchestrator run skill is installed, and no step is marked done or hand-over logged. Follow am:auto step 4: hand this plan over to the run skill instead of implementing it in this session. Do not lower the Scale line to get past this check; change it only if it is wrong, and say so in the final reply.`);
}

export async function main() {
  try {
    const result = decide(await readStdin());
    if (result.stdout) process.stdout.write(result.stdout);
  } catch {
    // A bug here must not stop the session's edits.
  }
  process.exitCode = 0;
}
