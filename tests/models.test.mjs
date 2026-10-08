// Run: node --test tests/models.test.mjs
// models.json is the one source of every model and effort; scripts/models.mjs bakes the values into the files that carry them.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { REPO, STAGE_SKILLS, apply, check, load, targets, validate } from '../scripts/models.mjs';

const bases = [];
after(() => {
  for (const base of bases) rmSync(base, { recursive: true, force: true });
});

/** A copy of every file the script writes, so a test can change values without touching the repository. */
function copy() {
  const base = mkdtempSync(path.join(tmpdir(), 'am-models-'));
  bases.push(base);
  for (const file of new Set(['models.json', ...targets().map((t) => t.file)])) cpSync(path.join(REPO, file), path.join(base, file));
  return base;
}
const read = (base, file) => readFileSync(path.join(base, file), 'utf8');
const snapshot = (base) => Object.fromEntries(targets().map((t) => [t.file, read(base, t.file)]));
const edit = (fn) => {
  const m = structuredClone(load());
  fn(m);
  return m;
};

test('every file carries the values of models.json', () => {
  assert.deepEqual(validate(load()), []);
  assert.deepEqual(check(), []);
});

test('the orchestrator stage-to-skill mapping is complete', () => {
  // The one literal of this map in the tests.
  assert.deepEqual(STAGE_SKILLS, { plan: 'plan', implement: 'do', check: 'check', commit: 'commit' });
});

test('values that would be silently ignored or unsafe are refused', () => {
  const problems = (fn) => validate(edit(fn)).join('\n');
  assert.match(problems((m) => { m.am.plan = { model: 'opus', efort: 'high' }; }), /am\.plan: 빠진 키 effort, 모르는 키 efort/);
  assert.match(problems((m) => { m.am.plan.model = 'claude-opus-5-5'; }), /am\.plan\.model: 별칭/); // a skill takes an alias
  assert.match(problems((m) => { m.am['second-opinion'].model = 'claude-opus-5-5'; }), /am\.second-opinion\.model: 별칭/); // follows the main session's Opus
  assert.match(problems((m) => { m.orchestrator.split.effort = 'huge'; }), /orchestrator\.split\.effort/);
  assert.match(problems((m) => { m.am['codex-opinion'].effort = 'max'; }), /am\.codex-opinion\.effort/); // Codex has no max
  assert.match(problems((m) => { m.am['codex-opinion'].model = 'gpt 5" & calc'; }), /am\.codex-opinion\.model/); // goes through cmd /C on Windows
  assert.match(problems((m) => { m.am.review = { model: 'opus', effort: 'high' }; }), /am: 모르는 키 review/);
  assert.match(problems((m) => { delete m.orchestrator.run; }), /orchestrator: 빠진 키 run/);
  assert.match(problems((m) => { m.orchestrator = null; }), /orchestrator: 항목을 담은 객체여야 합니다/); // not a crash in check()
  assert.deepEqual(validate(edit((m) => { m._note = 'x'; m.am.plan._why = 'y'; })), [], '`_` keys are notes');
});

test('apply writes a changed value into every place that carries it, and check is clean afterwards', () => {
  const base = copy();
  // New values are picked to differ from whatever models.json holds now, so the test survives a change of defaults.
  const other = (now, pool) => pool.find((v) => v !== now);
  const models = edit((m) => {
    m.am.commit.effort = other(m.am.commit.effort, ['low', 'medium']);
    m.orchestrator.split.model = other(m.orchestrator.split.model, ['sonnet', 'haiku']);
    m.orchestrator.run.effort = other(m.orchestrator.run.effort, ['max', 'low']);
    m.am['second-opinion'].model = other(m.am['second-opinion'].model, ['sonnet', 'haiku']);
    const codex = m.am['codex-opinion'];
    m.am['codex-opinion'] = { model: other(codex.model, ['gpt-5.1-codex', 'o4-mini']), effort: other(codex.effort, ['medium', 'low']) };
  });
  const { commit, 'second-opinion': agent, 'codex-opinion': codex } = models.am;
  const { run, split } = models.orchestrator;
  assert.equal(check(base, models).length > 0, true, 'drift is reported before apply');
  const { problems, changed } = apply(base, models);
  assert.deepEqual(problems, []);
  assert.deepEqual(check(base, models), []);
  assert.ok(changed.includes('plugin/skills/commit/SKILL.md') && !changed.includes('plugin/skills/plan/SKILL.md'), changed.join(', '));
  const fm = (v) => `\nmodel: ${v.model}\neffort: ${v.effort}\n---\n`;
  assert.ok(read(base, 'plugin/skills/commit/SKILL.md').includes(fm(commit)));
  assert.ok(read(base, 'plugin/agents/second-opinion.md').includes(fm(agent)));
  assert.ok(read(base, 'orchestrator/skills/run/SKILL.md').includes(fm(run)));
  const script = read(base, 'orchestrator/scripts/orchestrator.mjs');
  assert.ok(script.includes(`\n  split: { model: '${split.model}', effort: '${split.effort}' },`));
  assert.ok(script.includes(`\n  commit: { model: '${commit.model}', effort: '${commit.effort}' },`), 'the commit stage follows am:commit');
  assert.ok(read(base, 'plugin/scripts/codex-opinion.mjs').includes(`\n  '-c', 'model=${codex.model}',\n  '-c', 'model_reasoning_effort=${codex.effort}',\n`));
  const row = (label, v) => `| ${label} | \`${v.model}\` | \`${v.effort}\` |\n`;
  assert.ok(read(base, 'README.md').includes(row('`am:commit`', commit)) && read(base, 'README.md').includes(row('Codex 2차 의견', codex)));
  assert.ok(read(base, 'orchestrator/README.md').includes(row('커밋(`commit`)', commit)));

  // An empty Codex model takes the flag out again, and the original values restore every file.
  apply(base, edit((m) => { m.am['codex-opinion'] = { model: '', effort: codex.effort }; }));
  assert.ok(!read(base, 'plugin/scripts/codex-opinion.mjs').includes("'model="));
  assert.deepEqual(apply(base, load()).problems, []);
  assert.deepEqual(snapshot(base), snapshot(REPO));
});

test('a target whose format changed stops the script, and nothing is written', () => {
  const base = copy();
  const readme = path.join(base, 'orchestrator', 'README.md');
  writeFileSync(readme, read(base, 'orchestrator/README.md').replace('<!-- am:models:end -->', ''));
  const before = snapshot(base);
  const { problems, changed } = apply(base, edit((m) => { m.am.commit.effort = 'low'; }));
  assert.match(problems.join('\n'), /orchestrator\/README\.md: 표.*정확히 한 번 찾지 못했습니다 \(0번\)/);
  assert.deepEqual(changed, []);
  assert.deepEqual(snapshot(base), before);
  // Two matches are refused as well: the script never guesses which one is meant.
  const skill = path.join(base, 'plugin', 'skills', 'plan', 'SKILL.md');
  writeFileSync(skill, `${read(base, 'plugin/skills/plan/SKILL.md')}\nmodel: opus\neffort: high\n---\n`);
  assert.match(check(base, load()).join('\n'), /plugin\/skills\/plan\/SKILL\.md: frontmatter.*\(2번\)/);
});
