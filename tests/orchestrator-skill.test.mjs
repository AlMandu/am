// Run: node --test tests/orchestrator-skill.test.mjs
// The am-orchestrator plugin (orchestrator/): its manifest, its one skill, and the parts of the am plugin its script relies on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => readFileSync(path.join(REPO, ...parts), 'utf8');
const SKILL = read('orchestrator', 'skills', 'run', 'SKILL.md');
const SCRIPT = read('orchestrator', 'scripts', 'orchestrator.mjs');
const amSkill = (name) => read('plugin', 'skills', name, 'SKILL.md');
const common = (text) => {
  const m = /<!-- am:common:start -->([\s\S]*?)<!-- am:common:end -->/.exec(text);
  assert.ok(m, 'common block markers');
  return m[1];
};

test('the marketplace lists both plugins and each source holds a manifest with that name', () => {
  const market = JSON.parse(read('.claude-plugin', 'marketplace.json'));
  assert.deepEqual(market.plugins.map((p) => p.name), ['am', 'am-orchestrator']);
  for (const p of market.plugins) {
    const manifest = JSON.parse(read(p.source, '.claude-plugin', 'plugin.json'));
    assert.equal(manifest.name, p.name);
    assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
    // Default folders are scanned; listing them registers twice in Claude Code.
    for (const key of ['hooks', 'skills', 'agents']) assert.ok(!(key in manifest), `${p.name}: plugin.json must not list ${key}`);
  }
});

test('the run skill follows the am skill rules: same common block, size limit, user-invoked only', () => {
  assert.equal(common(SKILL), common(amSkill('plan')));
  const lines = SKILL.split('\n').length;
  assert.ok(lines <= 120, `${lines} lines > 120`);
  assert.match(SKILL, /^---\nname: run\n/);
  assert.match(SKILL, /\ndescription: "[^"]{40,}"\n/);
  assert.match(SKILL, /\ndisable-model-invocation: true\n/);
  assert.match(read('orchestrator', 'skills', 'run', 'agents', 'openai.yaml'), /allow_implicit_invocation: false/);
  assert.ok(!/(^|[^\w.])\/am[:-]/m.test(SKILL.replace(/<!-- am:common:start -->[\s\S]*?<!-- am:common:end -->/, '')), 'refer to skills by name, not with a slash prefix');
});

test('the skill and the script agree on commands and on every "next" value', () => {
  const commands = [...SKILL.matchAll(/^\| `([a-z]+)[ `]/gm)].map((m) => m[1]);
  assert.deepEqual(commands, ['doctor', 'split', 'status', 'decide', 'answer', 'run', 'retry', 'done']);
  for (const c of commands) assert.ok(SCRIPT.includes(`case '${c}':`), `script has no "${c}" command`);
  const doc = / \* next: ([a-z| -]+)\n/.exec(SCRIPT);
  assert.ok(doc, 'the script documents its next values');
  const values = doc[1].split('|').map((v) => v.trim());
  assert.deepEqual(values, ['doctor', 'split', 'wait', 'fix-tasks', 'decide', 'answer', 'blocked', 'run', 'done', 'stuck']);
  for (const v of values) {
    assert.ok(SCRIPT.includes(`'${v}'`), `script never returns "${v}"`);
    assert.ok(SKILL.includes(`\`${v}\``), `skill does not say what to do on "${v}"`);
  }
  // The fields the skill tells the session to read exist in the status output.
  for (const field of ['next', 'decisions', 'needsDecision', 'blocked', 'errors', 'running', 'autoDecided', 'costUsd']) {
    assert.ok(SKILL.includes(`\`${field}`) && new RegExp(`\\b${field}\\b`).test(SCRIPT), field);
  }
  for (const field of ['run.tasks', 'run.report', 'blocked[].reason', 'blocked[].logs', 'blocked[].hint', 'needsDecision[].file']) assert.ok(SKILL.includes(`\`${field}\``), field);
  assert.match(SKILL, /node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/orchestrator\.mjs" <command>/);
  assert.ok(existsSync(path.join(REPO, 'orchestrator', 'scripts', 'orchestrator.mjs')));
});

test('the am plugin still offers what the orchestrator script relies on', () => {
  // Skills it starts, by name and with the slug or request as the argument.
  for (const name of ['plan', 'do', 'check', 'commit']) assert.match(amSkill(name), /\$ARGUMENTS/, name);
  assert.ok(SCRIPT.includes("skillPrompt(ctx, 'plan',") && SCRIPT.includes("skillPrompt(ctx, 'check',") && SCRIPT.includes("skillPrompt(ctx, 'commit',") && SCRIPT.includes('hasSkill(ctx.pluginRoot, \'do\')'));
  // Files the skills write and the script reads.
  assert.match(amSkill('plan'), /`\.am\/<slug>\/plan\.md`/);
  assert.match(amSkill('check'), /`\.am\/<slug>\/check\.md`/);
  // am:do ends by handing over to am:check; the script tells its sessions to skip exactly that hand-over.
  assert.match(amSkill('do').trim().split('\n').at(-1), /use the am:check skill/);
  assert.match(SCRIPT, /do not use the am:check skill/);
  // The mark for choices made on the user's behalf, which the report collects.
  assert.match(amSkill('auto'), /`\(auto-decided\)`[\s\S]*`\(자동 결정\)`/);
  assert.match(SCRIPT, /auto-decided\|자동 결정/);
  // The gate's command line and the fields of its report.
  const gate = read('plugin', 'hooks', 'gate.mjs');
  assert.match(gate, /node gate\.mjs --run \[--json\] \[--cwd <dir>\]/);
  for (const field of ['status', 'reason', 'commands', 'durationMs', 'blocking', 'exit', 'timedOut']) assert.match(gate, new RegExp(`\\b${field}\\b`), field);
  assert.match(SCRIPT, /'--run', '--json', '--cwd'/);
});
