// am-auto:multi hand-over guard.
// PreToolUse hook declared in the am-auto:multi skill's frontmatter (Claude Code only), so
// it runs only in sessions that invoked am-auto:multi, for the rest of the session. It
// blocks a file edit while this session's plan says the task is large (Scale above
// 1 implementation run), the am-orchestrator run skill is installed,
// and the plan was neither handed over (a hand-over line in its Change log) nor started. Shell commands are not checked.
// Entry: node -e "import(...handover.mjs).then((m) => m.main())". Node only.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { denyOutput, findRepoRoot, readStdin } from './gate.mjs';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const STATE_DIR = path.join(tmpdir(), 'am-handover');
const PLAN = /^\.am\/[^/]+\/plan\.md$/;
const SCALE = /(?:Scale:\s*(\d+)\s+implementation runs?,\s*(\d+)\s+commits?|규모:\s*구현\s*(\d+)\s*회,\s*커밋\s*(\d+)\s*개)/i;
const DONE = /^\s*\d+\.\s.*\((?:done|완료)\)/im; // the am:do skill's mark on a step's first line
const DONE_ALL = new RegExp(DONE.source, DONE.flags + 'g'); // a copy for counting: DONE itself stays without `g`, so its test() keeps no position
const LOG_HEAD = /^(#{2,3})\s+(?:change\s?log|변경\s(?:기록|로그|이력))\s*$/i; // the plan's Change log section, older translated headings too
const HANDED = /^\s*[-*]\s+(?:\d{4}-\d{2}-\d{2}:?\s+)?Hand-over: am-orchestrator run skill, run (\S+), start branch (\S+)/; // the line am-auto:multi logs
// Older hand-over lines: plugin, verb, start branch and run ID on one line, and no word of a stop.
const OLD_HANDED = [/orchestrator|오케스트레이터/i, /넘김|넘겼|넘긴|went to|handed/i, /시작 브랜치|start branch/i, /\b\d{8}-\d{4}\b|(?:run\.id|run id|실행 ID):?\s+\S/i];
const STOPPED = /BLOCKED|stopped|failed|멈춤|멈췄|막힘|막혀|실패/i;

const ALLOW = { stdout: '' };
const slash = (p) => p.split(path.sep).join('/');

function deny(reason) {
  return { stdout: denyOutput(reason) };
}

/** What the plan says: {scale: [runs, commits] | null, started, handedOver}. */
export function readPlan(text) {
  const m = SCALE.exec(text);
  const scale = m ? [Number(m[1] ?? m[3]), Number(m[2] ?? m[4])] : null;
  return { scale, started: DONE.test(text), handedOver: changeLog(text).some(handedLine) };
}

/** The lines under the plan's Change log headings, each section ending at the next heading of the same or a higher level. */
function changeLog(text) {
  const lines = [];
  let level = 0;
  for (const line of String(text).split(/\r?\n/)) {
    const head = /^(#{1,6})\s/.exec(line);
    if (head && head[1].length <= level) level = 0;
    const log = LOG_HEAD.exec(line);
    if (log) level = log[1].length;
    else if (level) lines.push(line);
  }
  return lines;
}

const handedLine = (line) => HANDED.test(line) || (OLD_HANDED.every((re) => re.test(line)) && !STOPPED.test(line));

/** The run ID of the last fixed hand-over line in the plan's Change log, or null (none, or only an older line). */
export function handedRun(text) {
  return changeLog(text).map((line) => HANDED.exec(line)?.[1]).filter(Boolean).pop() ?? null;
}

/** The start branch of the last fixed hand-over line in the plan's Change log, or null. */
export function handedStartBranch(text) {
  return changeLog(text).map((line) => HANDED.exec(line)?.[2]).filter(Boolean).pop() ?? null;
}

/** How many steps of the plan carry the am:do done mark. */
export function countDone(text) {
  return (String(text).match(DONE_ALL) || []).length;
}

/** True when the plan's Scale is at most 1 implementation run (the commit count plays no part). */
export function withinOneRun(scale) {
  return scale && scale[0] <= 1;
}

/** The entries of `claude plugin list --json`, or null on any failure. */
export function pluginList() {
  try {
    // One command string through the shell, so Windows finds claude.cmd as well as claude.exe.
    const r = spawnSync('claude plugin list --json', { encoding: 'utf8', timeout: 30000, shell: true, windowsHide: true });
    if (r.status !== 0) return null;
    const list = JSON.parse(r.stdout);
    return Array.isArray(list) ? list : null;
  } catch {
    return null;
  }
}

/** The install paths of the listed plugins that match, in list order; none when the list cannot be read. */
export function installedPaths(match, list = pluginList) {
  const entries = list();
  if (!Array.isArray(entries)) return [];
  return entries.filter((p) => p && typeof p === 'object' && match(p)).map((p) => p.installPath);
}

/** The install path of an enabled am-orchestrator with its run skill, or null. Any failure counts as not installed. */
export function findOrchestrator(list = pluginList) {
  return installedPaths((p) => String(p.id).startsWith('am-orchestrator@') && p.enabled === true && typeof p.installPath === 'string' && existsSync(path.join(p.installPath, 'skills', 'run', 'SKILL.md')), list)[0] ?? null;
}

/** The install paths of every enabled am with the Codex second-opinion script and the plan skill: what a new stage session loads. */
export function findAm(list = pluginList) {
  return installedPaths((p) => String(p.id).startsWith('am@') && p.enabled === true && typeof p.installPath === 'string' && existsSync(path.join(p.installPath, 'scripts', 'codex-opinion.mjs')) && existsSync(path.join(p.installPath, 'skills', 'plan', 'SKILL.md')), list);
}

// The lowest am version am-auto relies on. Raise it in the am commit that changes a shared contract; never above am's plugin.json version.
export const AM_MIN_VERSION = '0.1.70';
const OWN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = /^\d+(\.\d+)*$/;
const UPDATE = 'run `claude plugin marketplace update am-workflow`, then `claude plugin update am@am-workflow`, and start a new session';

const readManifest = (dir) => {
  try {
    return JSON.parse(readFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), 'utf8'));
  } catch {
    return null;
  }
};

/** True when dir is the am plugin: its manifest names am and it has the plan skill. */
export function isCore(dir) {
  return readManifest(dir)?.name === 'am' && existsSync(path.join(dir, 'skills', 'plan', 'SKILL.md'));
}

/** The version in dir's manifest when it is dotted numbers, else null. */
export function coreVersion(dir) {
  const v = readManifest(dir)?.version;
  return typeof v === 'string' && VERSION.test(v) ? v : null;
}

/** Sort key of a dotted version (same as the orchestrator's): compare the keys as strings. */
export const versionKey = (v) => String(v).split('.').map((n) => String(parseInt(n, 10) || 0).padStart(6, '0')).join('.');

const sameDir = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);

/** The core am beside autoRoot or installed: { root, version, source: 'dev' | 'list' | 'cache' }, or { error } (one English line). */
export function findCore(autoRoot = OWN_ROOT, { list = pluginList, minVersion = AM_MIN_VERSION } = {}) {
  const found = locateCore(autoRoot, list);
  if (found.error) return found;
  const version = coreVersion(found.root);
  if (!version || versionKey(version) < versionKey(minVersion)) {
    const how = found.source === 'dev' ? 'update this repository to its latest commit' : UPDATE;
    return { error: `am ${version ?? '(version unreadable)'} at ${found.root} is older than ${minVersion}, the lowest version am-auto needs: ${how}.` };
  }
  return { ...found, version };
}

function locateCore(autoRoot, list) {
  const dev = path.resolve(autoRoot, '..', 'plugin');
  if (isCore(dev)) return { root: dev, source: 'dev' };
  const entries = list();
  if (Array.isArray(entries)) {
    const ams = entries.filter((p) => p && typeof p === 'object' && String(p.id).startsWith('am@'));
    const roots = new Map();
    for (const p of ams) {
      if (p.enabled !== true || typeof p.installPath !== 'string' || !path.isAbsolute(p.installPath) || !isCore(p.installPath)) continue;
      const root = path.resolve(p.installPath);
      if (!roots.has(sameDir(root))) roots.set(sameDir(root), root);
    }
    if (roots.size === 1) return { root: [...roots.values()][0], source: 'list' };
    if (roots.size > 1) return { error: `Several enabled am plugins are installed in different folders: ${[...roots.values()].join(', ')}. Keep one enabled (\`claude plugin disable <id>\` for the others) and start a new session.` };
    if (ams.some((p) => p.enabled !== true)) return { error: 'The am plugin is installed but disabled: run `claude plugin enable am@am-workflow` and start a new session.' };
    return { error: 'The am plugin is not installed: run `claude plugin install am@am-workflow` and start a new session.' };
  }
  const cache = path.resolve(autoRoot, '..', '..', 'am');
  let names = [];
  try {
    names = readdirSync(cache, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {}
  const best = names
    .filter((n) => !existsSync(path.join(cache, n, '.orphaned_at')) && isCore(path.join(cache, n)))
    .sort((a, b) => versionKey(b).localeCompare(versionKey(a)))[0];
  if (best) return { root: path.join(cache, best), source: 'cache' };
  return { error: 'The plugin list could not be read and no am plugin was found beside am-auto: run `claude plugin install am@am-workflow` and start a new session.' };
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
    const tmp = `${stateFile}.${process.pid}.tmp`; // hooks of parallel tool calls run at once: never leave a half-written file
    // A failed save must not turn a deny into an allow: swallow it and remove the leftover tmp.
    try {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(tmp, JSON.stringify(state));
      renameSync(tmp, stateFile);
    } catch {
      try { rmSync(tmp, { force: true }); } catch {}
    }
  };

  if (PLAN.test(rel)) {
    // The first plan the session reads is bound until it creates or edits one. A plan written or edited with a
    // Scale line always takes over (a later am-auto:multi in the same session); one without it (a task plan fixed by
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
    return deny(`am-auto:multi hand-over check: ${which} has no Scale line. Add it to the plan's Summary as am-auto:multi step 3 says (\`Scale: N implementation runs, M commits\`, \`규모: 구현 N회, 커밋 M개\` in a Korean plan), then apply am-auto:multi step 4: above 1 implementation run, hand the plan to the am-orchestrator run skill instead of editing files here.`);
  }
  return deny(`am-auto:multi hand-over check: ${which} says ${info.scale[0]} implementation runs and ${info.scale[1]} commits, the am-orchestrator run skill is installed, and no step is marked done or hand-over logged. Follow am-auto:multi step 4: hand this plan over to the run skill instead of implementing it in this session. Do not lower the Scale line to get past this check; change it only if it is wrong, and say so in the final reply.`);
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
