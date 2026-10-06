// Run: node --test tests/orchestrator-skill.test.mjs
// The am-orchestrator plugin (orchestrator/): its manifest, its one skill, and the parts of the am plugin its script relies on.
// Also the other direction: what am:auto relies on when it hands a large task to the run skill.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from '../scripts/models.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => readFileSync(path.join(REPO, ...parts), 'utf8');
const SKILL = read('orchestrator', 'skills', 'run', 'SKILL.md');
const SCRIPT = read('orchestrator', 'scripts', 'orchestrator.mjs');
const amSkill = (name) => read('plugin', 'skills', name, 'SKILL.md');
// Model and effort of the run skill and the split stage, from models.json at the repository root.
const MODELS = load().orchestrator;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
  // The model and effort of the session that drives the run. A misspelled key is ignored without an error.
  assert.match(SKILL, new RegExp(`\\nmodel: ${esc(MODELS.run.model)}\\neffort: ${esc(MODELS.run.effort)}\\n---\\n`));
  assert.match(read('orchestrator', 'skills', 'run', 'agents', 'openai.yaml'), /allow_implicit_invocation: false/);
  assert.ok(!/(^|[^\w.])\/am[:-]/m.test(SKILL.replace(/<!-- am:common:start -->[\s\S]*?<!-- am:common:end -->/, '')), 'refer to skills by name, not with a slash prefix');
});

test('the skill and the script agree on commands and on every "next" value', () => {
  const commands = [...SKILL.matchAll(/^\| `([a-z]+)[ `]/gm)].map((m) => m[1]);
  assert.deepEqual(commands, ['doctor', 'split', 'status', 'decide', 'answer', 'run', 'retry', 'done', 'sessions']);
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
  // The model and effort of each stage: the script passes them as flags and the skill that stage runs names the same values,
  // so a slash call and an inline call (frontmatter stripped) run alike whichever of the two Claude Code prefers.
  for (const [stage, skill] of Object.entries({ plan: 'plan', implement: 'do', check: 'check', commit: 'commit' })) {
    const row = new RegExp(`\\n  ${stage}: \\{ model: '([^']+)', effort: '([^']+)' \\},`).exec(SCRIPT);
    assert.ok(row, `STAGE_DEFAULTS.${stage}`);
    assert.match(amSkill(skill), new RegExp(`\\nmodel: ${esc(row[1])}\\neffort: ${esc(row[2])}\\n---\\n`), `${stage} and am:${skill}`);
  }
  assert.ok(SCRIPT.includes(`\n  split: { model: '${MODELS.split.model}', effort: '${MODELS.split.effort}' },`), 'STAGE_DEFAULTS.split');
  // The second opinion through Codex: plan sessions may run exactly this am script, which the common rules call by this path.
  assert.ok(existsSync(path.join(REPO, 'plugin', 'scripts', 'codex-opinion.mjs')));
  assert.ok(amSkill('plan').includes('`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-opinion.mjs" <brief file>`'));
  assert.match(SCRIPT, /path\.join\(amRoot, 'scripts', 'codex-opinion\.mjs'\)/);
  assert.match(amSkill('plan'), /for at most 2 more rounds/);
  // Stage sessions have a time limit, so they take one round less; a choice still split goes to the user.
  assert.equal(SCRIPT.match(/with at most 1 more round after the reviewers' first answers in this session/g)?.length, 2, 'plan and implement');
  assert.match(SCRIPT, /or a technical choice its two reviewers still split on\. For an open decision write the decision card in plan\.md under Decisions, marked OPEN/);
  assert.match(SCRIPT, /still split on it after that round \(write its decision card under Decisions in plan\.md, marked OPEN\)/);
  assert.match(SKILL, /holds an OPEN card for a technical choice its two reviewers split on, ask that card, replace the card in place with the answer marked as the user's decision, and run `retry <task> --from implement`/);
  assert.match(SKILL, /edit nothing but `config\.json`, in step 3 `tasks\.json`, and in step 4 the plan\.md of a task blocked on a split choice/);
});

test('am:auto hands a large task to the run skill only through what is pinned here', () => {
  const auto = amSkill('auto');
  // Finding the run skill: the plugin id in `claude plugin list --json` and the skill's path under its installPath.
  const market = JSON.parse(read('.claude-plugin', 'marketplace.json'));
  assert.equal(market.plugins.find((p) => p.source === './orchestrator')?.name, 'am-orchestrator');
  assert.match(auto, /In Claude Code only, also run `claude plugin list --json`: if an `am-orchestrator@` entry has `enabled: true` and `<installPath>\/skills\/run\/SKILL\.md` exists/);
  assert.ok(existsSync(path.join(REPO, 'orchestrator', 'skills', 'run', 'SKILL.md')));
  // am:auto reads the file rather than invoking the skill, so neither the plugin root placeholder nor $ARGUMENTS is replaced.
  assert.match(SKILL, /If the placeholder was not replaced, the plugin root is the folder two levels above this SKILL\.md\./);
  assert.match(SKILL, /^1\. Request\. [^\n]*A path to an existing file: a new run with that document\./m);
  // A resumed hand-over enters the loop directly, which sends `doctor` back to the Prepare step.
  assert.match(SKILL, /^4\. Loop: read `status --json` and follow `next`[\s\S]*?- `doctor` or `split`: go back to step 2 or 3\./m);
  assert.match(auto, /with the path of this plan\.md as its request/);
  // A failed split leaves `status --json` on an earlier run; only a changed run.id proves this split made the run.
  assert.match(auto, /A new hand-over first notes `run\.id` from `status --json` \(none if `run` is null\)/);
  assert.match(auto, /once `split` has made the run \(`run\.id` present and not the noted one; otherwise stop and report\), log in one Change log line [^\n]*with `run\.id` and the current branch as the start branch\./);
  assert.match(auto, /check that `status --json` shows the same `run\.id` \(if not, stop and report\), then follow the run skill from its step 4\./);
  // The step and the rule of the run skill that am:auto names.
  const prepare = /^2\. Prepare\.[\s\S]*?(?=^3\. )/m.exec(SKILL);
  assert.ok(prepare, 'the run skill has a Prepare step 2');
  // Exactly these questions: a new one would be auto-decided by am:auto unless it joins its stop list too.
  const asks = /only about these:\n((?:[ \t]+- [^\n]*\n)+)/.exec(prepare[0]);
  assert.ok(asks, 'the Prepare step lists what it asks');
  const qs = ['there is no `am-gate.json`', 'uncommitted changes you did not make', 'the gate already fails before the run'];
  assert.deepEqual(asks[1].trimEnd().split('\n').map((l, i) => l.trim().startsWith(`- ${qs[i]}`)), qs.map(() => true));
  assert.match(auto, /The run skill asks in its Prepare step \(no `am-gate\.json`, uncommitted changes you did not make, a gate that fails before the run\)/);
  assert.match(SKILL, /Never push or merge\./);
  assert.match(auto, /Its rule never to merge or push covers its own flow only/);
  // What am:auto reads from `status --json` and the commands and next values it names.
  const run = /data\.run = \{([\s\S]*?)\n    \};/.exec(SCRIPT);
  assert.ok(run, 'status --json builds run');
  const runFields = [...auto.matchAll(/\brun\.([a-z]+)\b/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(runFields)].sort(), ['branch', 'id', 'report']);
  for (const f of runFields) assert.match(run[1], new RegExp(`\\b${f}:`), `run.${f}`);
  assert.match(auto, /`git merge --ff-only <run\.branch>` and `git branch -d <run\.branch>`/);
  for (const field of ['costUsd', 'autoDecided']) assert.ok(auto.includes(`\`${field}\``) && new RegExp(`\\b${field}: `).test(SCRIPT), field);
  for (const c of ['split', 'decide']) assert.ok(auto.includes(`\`${c}\``) && new RegExp(`^\\| \`${c}[ \`]`, 'm').test(SKILL), c);
  for (const v of ['done', 'decide', 'answer', 'blocked']) assert.ok(auto.includes(`\`${v}\``) && SKILL.includes(`\`${v}\``) && SCRIPT.includes(`'${v}'`), v);
  // The scale line and the size of one implementation run, which matches the script's task size.
  assert.match(auto, /`Scale: N implementation runs, M commits` \(`규모: 구현 N회, 커밋 M개` in a Korean plan\)/);
  const limits = /taskLimits: \{ maxFiles: (\d+), maxPlanLines: (\d+) \}/.exec(SCRIPT);
  assert.ok(limits, 'default task size');
  assert.match(auto, new RegExp(`about ${limits[1]} files and a plan of at most ${limits[2]} lines`));
});
