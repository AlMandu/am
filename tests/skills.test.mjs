// Run: node --test tests/skills.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from '../scripts/models.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugin', 'skills');
const AGENT = path.resolve(ROOT, '..', 'agents', 'second-opinion.md');
const LIMITS = { plan: 120, check: 120, commit: 80, do: 80, auto: 80, compactmem: 80 };
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
const common = (text) => {
  const m = /<!-- am:common:start -->([\s\S]*?)<!-- am:common:end -->/.exec(text);
  assert.ok(m, 'common block markers');
  return m[1];
};

test('every skill carries the same common rules block', () => {
  const blocks = Object.keys(LIMITS).map((n) => common(read(n)));
  for (const b of blocks.slice(1)) assert.equal(b, blocks[0]);
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

test('am:plan, am:do, am:auto and am:compactmem are user-invoked only in both tools', () => {
  for (const name of ['plan', 'do', 'auto', 'compactmem']) {
    assert.match(read(name), /\ndisable-model-invocation: true\n/, name);
    const yaml = readFileSync(path.join(ROOT, name, 'agents', 'openai.yaml'), 'utf8');
    assert.match(yaml, /allow_implicit_invocation: false/, name);
  }
});

test('every skill sets the model and effort its turn runs with', () => {
  for (const [name, [model, effort]] of Object.entries(RUNS_WITH)) {
    const fm = frontmatter(read(name));
    // Claude Code ignores a misspelled key without an error, which would silently drop the default.
    const userOnly = ['plan', 'do', 'auto', 'compactmem'].includes(name) ? ['disable-model-invocation'] : [];
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
  assert.doesNotMatch(orch, /compactmem/, 'the orchestrator never calls it');
  assert.match(read('check'), /in Claude Code outside an am-orchestrator run the am:compactmem skill/);
  assert.match(read('auto'), /skip check, compactmem and commit/);
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
  for (const status of [...new Set(Object.values(MARKS).flat()), 'failed', 'unavailable']) assert.ok(auto.includes(`\`${status}\``), `status ${status}`);
  for (const field of ['status', 'reason', 'reply', 'costUsd']) assert.ok(auto.includes(`\`${field}\``), field);
});

test('the second-opinion agent stays pinned and read-only, and the common rules send choices to it', () => {
  const fm = frontmatter(readFileSync(AGENT, 'utf8'));
  // Claude Code ignores a misspelled key without an error, which would silently unpin the agent.
  assert.deepEqual(Object.keys(fm).sort(), ['description', 'effort', 'model', 'name', 'tools']);
  assert.equal(fm.name, 'second-opinion');
  assert.equal(fm.model, MODELS['second-opinion'].model);
  assert.match(fm.model, /^claude-/); // full ID: the `opus` alias follows the main session's Opus version
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
