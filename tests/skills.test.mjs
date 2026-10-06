// Run: node --test tests/skills.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from '../scripts/models.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugin', 'skills');
const AGENT = path.resolve(ROOT, '..', 'agents', 'second-opinion.md');
const LIMITS = { plan: 120, check: 120, commit: 80, do: 80, auto: 80 };
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

test('am:plan, am:do and am:auto are user-invoked only in both tools', () => {
  for (const name of ['plan', 'do', 'auto']) {
    assert.match(read(name), /\ndisable-model-invocation: true\n/, name);
    const yaml = readFileSync(path.join(ROOT, name, 'agents', 'openai.yaml'), 'utf8');
    assert.match(yaml, /allow_implicit_invocation: false/, name);
  }
});

test('every skill sets the model and effort its turn runs with', () => {
  for (const [name, [model, effort]] of Object.entries(RUNS_WITH)) {
    const fm = frontmatter(read(name));
    // Claude Code ignores a misspelled key without an error, which would silently drop the default.
    const userOnly = ['plan', 'do', 'auto'].includes(name) ? ['disable-model-invocation'] : [];
    assert.deepEqual(Object.keys(fm).sort(), ['argument-hint', 'description', 'effort', 'model', 'name', ...userOnly].sort(), name);
    assert.equal(fm.model, model, name); // an alias, not a full ID: a skill whose model cannot be resolved has no fallback
    assert.equal(fm.effort, effort, name);
  }
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
