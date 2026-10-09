// Run: node --test tests/skills.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from '../scripts/models.mjs';
import { common, withoutCommon, SLASH_NAME } from './helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugin', 'skills');
const AGENT = path.resolve(ROOT, '..', 'agents', 'second-opinion.md');
const LIMITS = { plan: 120, check: 120, commit: 80, do: 80, auto: 80, compactmem: 80, merge: 80 };
// Model and effort a skill's turn runs with in Claude Code (Codex ignores both keys), from models.json at the repository root.
const MODELS = load().am;
const RUNS_WITH = Object.fromEntries(Object.keys(LIMITS).map((name) => [name, [MODELS[name].model, MODELS[name].effort]]));
const read = (name) => readFileSync(path.join(ROOT, name, 'SKILL.md'), 'utf8');
const frontmatter = (text) => {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(m, 'frontmatter');
  return Object.fromEntries(m[1].split('\n').map((line) => {
    const i = line.indexOf(':');
    return [line.slice(0, i), line.slice(i + 1).trim()];
  }));
};

test('every skill carries the same common rules block', () => {
  const blocks = Object.keys(LIMITS).map((n) => common(read(n)));
  for (const b of blocks.slice(1)) assert.equal(b, blocks[0]);
});

test('am skills refer to other skills by name, not with a slash prefix', () => {
  for (const name of Object.keys(LIMITS)) assert.doesNotMatch(withoutCommon(read(name)), SLASH_NAME, name);
});

test('skills stay within their line limits and name themselves after their folder', () => {
  for (const [name, limit] of Object.entries(LIMITS)) {
    const text = read(name);
    const lines = text.split('\n').length;
    assert.ok(lines <= limit, `${name}: ${lines} lines > ${limit}`);
    assert.match(text, new RegExp(`^---\\nname: ${name}\\n`), name);
    assert.match(text, /\ndescription: "[^"]{40,}"\n/, `${name} description`);
  }
});

test('am:plan, am:do, am:auto, am:compactmem and am:merge are user-invoked only in both tools', () => {
  for (const name of ['plan', 'do', 'auto', 'compactmem', 'merge']) {
    assert.match(read(name), /\ndisable-model-invocation: true\n/, name);
    const yaml = readFileSync(path.join(ROOT, name, 'agents', 'openai.yaml'), 'utf8');
    assert.match(yaml, /allow_implicit_invocation: false/, name);
  }
});

test('every skill sets the model and effort its turn runs with', () => {
  for (const [name, [model, effort]] of Object.entries(RUNS_WITH)) {
    const fm = frontmatter(read(name));
    // Claude Code ignores a misspelled key without an error, which would silently drop the default.
    const userOnly = ['plan', 'do', 'auto', 'compactmem', 'merge'].includes(name) ? ['disable-model-invocation'] : [];
    const hooks = name === 'auto' ? ['hooks'] : [];
    assert.deepEqual(Object.keys(fm).sort(), ['argument-hint', 'description', 'effort', 'model', 'name', ...userOnly, ...hooks].sort(), name);
    assert.equal(fm.model, model, name); // an alias, not a full ID: a skill whose model cannot be resolved has no fallback
    assert.equal(fm.effort, effort, name);
  }
});

test('am:compactmem never runs inside an am-orchestrator session (user decision)', () => {
  const skill = read('compactmem');
  assert.match(skill, /never inside an am-orchestrator run[^\n]*its instructions say you are running inside am-orchestrator[^\n]*say so in one line and stop without reading or writing anything/);
  // The words the skill looks for are the ones every orchestrator session gets.
  const orch = readFileSync(path.resolve(ROOT, '..', '..', 'orchestrator', 'scripts', 'orchestrator.mjs'), 'utf8');
  assert.ok(orch.includes("'You are running inside am-orchestrator, an unattended batch run."));
  // Its copy of the user models key list may name the key; nothing else may.
  assert.doesNotMatch(orch.replace(/^export const USER_MODEL_KEYS = \[.*\];$/m, ''), /compactmem/, 'the orchestrator never calls it');
  assert.match(read('check'), /in Claude Code outside an am-orchestrator run the am:compactmem skill/);
  assert.match(read('auto'), /skip check, compactmem and commit/);
});

test('am:merge moves the commits am:commit records and never pushes', () => {
  const skill = read('merge');
  for (const s of ['.am/<slug>/commits.md', '.orchestrator/runs/<run>/state.json', 'git merge --no-ff', '--include-untracked', 'git cherry-pick -x', '.am/<slug>/merge.md', 'node "${CLAUDE_PLUGIN_ROOT}/hooks/gate.mjs" --run --json', '.orchestrator/lock.json']) assert.ok(skill.includes(s), s);
  assert.match(skill, /Never push/);
  assert.match(skill, /that nothing was pushed/);
  // am:commit writes the record, except in a session am-orchestrator started (the words every orchestrator session gets).
  assert.match(read('commit'), /your instructions do not say you are running inside am-orchestrator, append `<full hash> <subject>` as one line to `\.am\/<slug>\/commits\.md`/);
  const orch = readFileSync(path.resolve(ROOT, '..', '..', 'orchestrator', 'scripts', 'orchestrator.mjs'), 'utf8');
  assert.ok(orch.includes("'You are running inside am-orchestrator, an unattended batch run."));
});

test('am:auto declares the hand-over hook, and only am:auto', () => {
  // Claude Code only (measured on 2.1: a plugin skill's frontmatter hook registers when the skill is invoked and
  // stays for the session, with CLAUDE_PLUGIN_ROOT set). One line, so the frontmatter stays one key per line.
  const line = `hooks: { PreToolUse: [ { matcher: "Read|Edit|Write|MultiEdit|NotebookEdit", hooks: [ { type: command, command: "node -e \\"import(require('url').pathToFileURL(process.env.CLAUDE_PLUGIN_ROOT+'/hooks/handover.mjs')).then((m) => m.main()).catch(() => {})\\"", timeout: 60 } ] } ] }`;
  assert.ok(read('auto').includes(`\n${line}\nmodel: `));
  assert.ok(existsSync(path.join(ROOT, '..', 'hooks', 'handover.mjs')));
  for (const name of Object.keys(LIMITS).filter((n) => n !== 'auto')) assert.doesNotMatch(read(name), /\nhooks:/, name);
  assert.match(read('auto'), /this skill's hook denies file edits outside `\.am\/`/);
});

test('am:auto drives the stage runner and handles every status it prints', async () => {
  const auto = read('auto');
  const { MARKS, STAGES } = await import('../plugin/scripts/stage.mjs');
  assert.ok(auto.includes('`node "${CLAUDE_PLUGIN_ROOT}/scripts/stage.mjs" <stage> <slug>`'));
  assert.match(auto, /## Stage sessions \(Claude Code\)\nIn Claude Code, when `\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/stage\.mjs` exists/);
  for (const s of STAGES) assert.ok(auto.includes(`\`${s}\``), `stage ${s}`);
  for (const f of ['--push', '--fix']) assert.ok(auto.includes(`\`${f}\``), f);
  // The plan stage reads the request from this file (cmd.exe cannot pass every request as an argument).
  assert.ok(auto.includes('`.am/<slug>/request.md`'));
  for (const status of [...new Set(Object.values(MARKS).flat()), 'failed', 'unavailable', 'WAIT']) assert.ok(auto.includes(`\`${status}\``), `status ${status}`);
  for (const field of ['status', 'reason', 'reply', 'compacted']) assert.ok(auto.includes(`\`${field}\``), field);
});

test('am:auto starts the progress command next to every stage command', async () => {
  const m = /## Stage sessions \(Claude Code\)\n([\s\S]*?)\n## Steps\n/.exec(read('auto'));
  assert.ok(m, 'the Stage sessions section');
  const section = m[1];
  assert.ok(section.includes('`node "${CLAUDE_PLUGIN_ROOT}/scripts/progress.mjs" <slug> --consumer main`'));
  assert.ok(existsSync(path.join(ROOT, '..', 'scripts', 'progress.mjs')), 'plugin/scripts/progress.mjs');
  // The skill stops restarting the progress command when its last line is the one the script prints for an ended task.
  const { stateLine } = await import('../plugin/scripts/progress.mjs');
  assert.equal(stateLine([]), 'state: ended');
  assert.ok(section.includes(`\`${stateLine([])}\``), 'state: ended');
  assert.ok(section.includes('each `second opinion:` line gets its own plain line: what had to be decided and which option was chosen, and whether Codex agreed'));
  assert.ok(section.includes('other than its `second opinion:` lines'));
  // The skill relays news by this prefix; a changed prefix would silently drop the plain line.
  assert.ok(readFileSync(path.join(ROOT, '..', 'scripts', 'stage.mjs'), 'utf8').includes('text: `second opinion: ${line}`'));
});

test('am:auto gathers the choices the second opinion settled in its final reply', () => {
  const auto = read('auto');
  assert.ok(auto.includes('each choice the second opinion settled (from Defaults applied in plan.md: what had to be decided and the agreed option, and whether it overruled your own pick)'));
  assert.ok(auto.includes('`autoDecided` and `secondOpinions` lines join what you decided'));
});

test('the second-opinion agent stays pinned and read-only, and the common rules send choices to it', () => {
  const fm = frontmatter(readFileSync(AGENT, 'utf8'));
  // Claude Code ignores a misspelled key without an error, which would silently unpin the agent.
  assert.deepEqual(Object.keys(fm).sort(), ['description', 'effort', 'model', 'name', 'tools']);
  assert.equal(fm.name, 'second-opinion');
  assert.equal(fm.model, MODELS['second-opinion'].model);
  assert.match(fm.model, /^[a-z]+(\[1m\])?$/); // alias: follows the main session's Opus version, so a new Opus is picked up
  assert.equal(fm.effort, MODELS['second-opinion'].effort);
  assert.equal(fm.tools, 'Read, Grep, Glob');
  assert.match(fm.description, /^"[^"]{40,}"$/);
  assert.match(common(read('plan')), /am:second-opinion subagent/);
});

test('with Codex installed, the common rules have Codex answer the same brief and send a lasting split to the user', () => {
  const block = common(read('plan'));
  const script = path.resolve(ROOT, '..', 'scripts', 'codex-opinion.mjs');
  assert.ok(existsSync(script), 'plugin/scripts/codex-opinion.mjs');
  // The orchestrator allows exactly this command in its plan sessions (tests/orchestrator.test.mjs).
  assert.ok(block.includes('`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-opinion.mjs" <brief file>`'));
  assert.match(block, /save the brief as a new file `opinion-<round>\.md` under `\.am\/`/, 'the script only sends a .md brief under .am/; brief.md is the orchestrator task brief');
  assert.match(block, /with a 10-minute timeout/, 'the Bash tool stops a command after 2 minutes by default');
  assert.match(block, /exit code 2 means Codex is not installed/);
  assert.match(block, /for at most 2 more rounds: a new brief with the original brief's content for those choices plus both picks and reasons from the last round, labelled Claude and Codex/, 'fresh reviewers see the whole case each round');
  assert.match(block, /still split after that goes to the user as a decision card/);
  assert.match(block, /If one reviewer fails, in any round, the other's answer stands/);
  assert.match(readFileSync(AGENT, 'utf8'), /another reviewer's pick and reasons/);
  const auto = read('auto');
  assert.match(auto, /\n- The two reviewers of a technical choice still split on it after their rounds \(rules above\)\.\n/);
  assert.match(auto, /In the first five cases, ask with a decision card/);
});

test("the common rules pass the script's Claude reviewer line to the subagent, only from the first line", async () => {
  const { reviewerLine } = await import('../plugin/scripts/codex-opinion.mjs');
  const block = common(read('plan'));
  const line = reviewerLine({ model: '<model>', effort: '<effort>' }, 'F');
  const head = line.slice(0, line.indexOf(' (from'));
  assert.ok(head.startsWith('Claude reviewer: model '));
  assert.ok(block.includes(`\`${head} …\``));
  // Only the first line counts: Codex's own text comes after `Codex's answer:` and could echo the pattern.
  assert.match(block, /If the first line of the script's output is `Claude reviewer: model/);
  assert.match(block, /pass that model and effort as the Agent call's `model` and `effort`; otherwise do not override the ones pinned in its definition/);
  // The line exists only once the script has run, so the rule must run it before the subagent.
  const run = block.indexOf('codex-opinion.mjs" <brief file>`');
  const send = block.indexOf('Then send the brief to the am:second-opinion subagent');
  const pass = block.indexOf('Claude reviewer: model');
  assert.ok(run !== -1 && run < send && send < pass, 'script, then subagent, then the reviewer line');
});
