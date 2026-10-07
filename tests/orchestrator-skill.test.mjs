// Run: node --test tests/orchestrator-skill.test.mjs
// The am-orchestrator plugin (orchestrator/): its manifest, its one skill, and the parts of the am plugin its script relies on.
// Also the other direction: what am:auto relies on when it hands a large task to the run skill.
// And where the am stage runner and the orchestrator must agree: end markers, check.md verdicts, push denial.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load, STAGE_SKILLS } from '../scripts/models.mjs';
import { common, withoutCommon, SLASH_NAME } from './helpers.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => readFileSync(path.join(REPO, ...parts), 'utf8');
const SKILL = read('orchestrator', 'skills', 'run', 'SKILL.md');
const SCRIPT = read('orchestrator', 'scripts', 'orchestrator.mjs');
const amSkill = (name) => read('plugin', 'skills', name, 'SKILL.md');
// Model and effort of the run skill and the split stage, from models.json at the repository root.
const MODELS = load().orchestrator;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// The object status --json prints as run; am:auto and the stage runner read its fields.
const RUN = /data\.run = \{([\s\S]*?)\n    \};/.exec(SCRIPT);

/** What a hand-over reads from status --json and the commands and next values it names exist in the script and the skill. */
function readsStatusLikeAuto(text) {
  assert.ok(RUN, 'status --json builds run');
  const fields = [...new Set([...text.matchAll(/\brun\.([a-z]+)\b/g)].map((m) => m[1]))].sort();
  assert.deepEqual(fields, ['branch', 'id', 'report']);
  for (const f of fields) assert.match(RUN[1], new RegExp(`\\b${f}:`), `run.${f}`);
  for (const field of ['costUsd', 'autoDecided']) assert.ok(text.includes(`\`${field}\``) && new RegExp(`\\b${field}: `).test(SCRIPT), field);
  for (const c of ['split', 'decide']) assert.ok(text.includes(`\`${c}\``) && new RegExp(`^\\| \`${c}[ \`]`, 'm').test(SKILL), c);
  for (const v of ['done', 'decide', 'answer', 'blocked']) assert.ok(text.includes(`\`${v}\``) && SKILL.includes(`\`${v}\``) && SCRIPT.includes(`'${v}'`), v);
}

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
  // Claude Code ignores a misspelled key without an error.
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(SKILL);
  assert.ok(fm, 'run skill frontmatter');
  const keys = fm[1].split('\n').map((line) => line.slice(0, line.indexOf(':')));
  assert.deepEqual(keys.sort(), ['name', 'description', 'argument-hint', 'disable-model-invocation', 'model', 'effort'].sort(), 'run skill frontmatter keys');
  assert.match(SKILL, /^---\nname: run\n/);
  assert.match(SKILL, /\ndescription: "[^"]{40,}"\n/);
  assert.match(SKILL, /\ndisable-model-invocation: true\n/);
  // The model and effort of the session that drives the run. A misspelled key is ignored without an error.
  assert.match(SKILL, new RegExp(`\\nmodel: ${esc(MODELS.run.model)}\\neffort: ${esc(MODELS.run.effort)}\\n---\\n`));
  assert.match(read('orchestrator', 'skills', 'run', 'agents', 'openai.yaml'), /allow_implicit_invocation: false/);
  assert.ok(!SLASH_NAME.test(withoutCommon(SKILL)), 'refer to skills by name, not with a slash prefix');
});

test('the skill and the script agree on commands and on every "next" value', () => {
  const commands = [...SKILL.matchAll(/^\| `([a-z]+)[ `]/gm)].map((m) => m[1]);
  assert.deepEqual(commands, ['doctor', 'split', 'status', 'decide', 'answer', 'run', 'retry', 'done', 'sessions']);
  for (const c of commands) assert.ok(SCRIPT.includes(`case '${c}':`), `script has no "${c}" command`);
  const doc = / \* next: ([a-z| -]+)\n/.exec(SCRIPT);
  assert.ok(doc, 'the script documents its next values');
  const values = doc[1].split('|').map((v) => v.trim());
  // The values the code sets: the initial `next: '…'` and every `data.next = …`, which must be one string or a ternary of two.
  const assigned = [...SCRIPT.matchAll(/\bdata\.next = ('[a-z-]+'|[\w.]+ \? '[a-z-]+' : '[a-z-]+');/g)];
  assert.equal(assigned.length, SCRIPT.match(/\bdata\.next\s*=/g)?.length, 'a new form of data.next assignment: collect its values here');
  const code = [...SCRIPT.matchAll(/\bnext: '([a-z-]+)'/g)].map((m) => m[1]).concat(assigned.flatMap((m) => [...m[1].matchAll(/'([a-z-]+)'/g)].map((s) => s[1])));
  assert.ok(code.length, 'the script sets next values');
  assert.deepEqual([...new Set(code)].sort(), [...values].sort(), 'the documented next values and the ones the script sets');
  for (const v of values) assert.ok(SKILL.includes(`\`${v}\``), `skill does not say what to do on "${v}"`);
  // The fields the skill tells the session to read exist in the status output.
  for (const field of ['next', 'decisions', 'needsDecision', 'blocked', 'errors', 'running', 'autoDecided', 'costUsd']) {
    assert.ok(SKILL.includes(`\`${field}`) && new RegExp(`\\b${field}\\b`).test(SCRIPT), field);
  }
  for (const field of ['run.tasks', 'run.report', 'blocked[].reason', 'blocked[].logs', 'blocked[].hint', 'needsDecision[].file']) assert.ok(SKILL.includes(`\`${field}\``), field);
  assert.match(SKILL, /node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/orchestrator\.mjs" <command>/);
});

test('the am plugin still offers what the orchestrator script relies on', () => {
  // Skills it starts, by name and with the slug or request as the argument.
  for (const name of ['plan', 'do', 'check', 'commit']) assert.match(amSkill(name), /\$ARGUMENTS/, name);
  assert.ok(SCRIPT.includes("skillPrompt(ctx, 'plan',") && SCRIPT.includes("skillPrompt(ctx, 'check',") && SCRIPT.includes("skillPrompt(ctx, 'commit',") && SCRIPT.includes("skillPrompt(ctx, 'do',"));
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
  for (const [stage, skill] of Object.entries(STAGE_SKILLS)) {
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
  // What am:auto and the stage runner read from `status --json` and the commands and next values they name: one helper for both.
  readsStatusLikeAuto(auto);
  assert.match(auto, /`git merge --ff-only <run\.branch>` and `git branch -d <run\.branch>`/);
  // The scale line and the size of one implementation run, which matches the script's task size.
  assert.match(auto, /`Scale: N implementation runs, M commits` \(`규모: 구현 N회, 커밋 M개` in a Korean plan\)/);
  const limits = /taskLimits: \{ maxFiles: (\d+), maxPlanLines: (\d+) \}/.exec(SCRIPT);
  assert.ok(limits, 'default task size');
  assert.match(auto, new RegExp(`about ${limits[1]} files and work that a faithful plan of at most ${limits[2]} lines can cover`));
});

test('the am stage runner hands a large plan to the run skill only through what is pinned here', async () => {
  const { instructions, permissions } = await import('../plugin/scripts/stage.mjs');
  const hook = read('plugin', 'hooks', 'handover.mjs');
  // Finding the run skill: the same plugin id and skill path as am:auto.
  assert.match(hook, /startsWith\('am-orchestrator@'\) && p\.enabled === true/);
  assert.match(hook, /path\.join\(p\.installPath, 'skills', 'run', 'SKILL\.md'\)/);
  // The skill is called by slash: the plugin and skill names, a new run with the plan's path, an empty request to continue.
  assert.equal(JSON.parse(read('orchestrator', '.claude-plugin', 'plugin.json')).name, 'am-orchestrator');
  assert.match(SKILL, /^name: run$/m);
  assert.equal(instructions('handover', 'x').prompt, '/am-orchestrator:run .am/x/plan.md');
  assert.equal(instructions('handover', 'x', { resume: true }).prompt, '/am-orchestrator:run');
  assert.match(SKILL, /^1\. Request\. Empty: continue the run in progress from step 4;[^\n]*A path to an existing file: a new run with that document\./m);
  assert.ok(permissions('handover', { orchRoot: '/o' }).allow.includes('Bash(node "/o/scripts/orchestrator.mjs" *)'));
  // What the session reads and the questions it decides or stops on.
  const system = instructions('handover', 'x').system;
  readsStatusLikeAuto(system);
  assert.match(system, /Its rule never to merge or push covers its own flow only/);
});

test('the am stage runner and the orchestrator read end markers and check.md verdicts alike', async () => {
  const { MARKS, lastMark, checkVerdict } = await import('../plugin/scripts/stage.mjs');
  const { lastMarker, verdictFromFile } = await import('../orchestrator/scripts/orchestrator.mjs');
  const values = MARKS.do;
  const marks = [
    ['AM_STAGE: DONE', 'DONE'],
    ['AM_STAGE: DONE\nlater **AM_STAGE: BLOCKED**', 'BLOCKED'],
    ['am_stage: **done**', 'DONE'],
    ['AM_STAGE: COMMITTED', null],
    ['AM_STAGE: DONEX', null],
    ['no marker', null],
  ];
  for (const [text, expected] of marks) {
    assert.equal(lastMark(text, values), expected, `stage runner: ${text}`);
    assert.equal(lastMarker(text, 'AM_STAGE', values), expected, `orchestrator: ${text}`);
  }
  // Only cases both answer alike. An unlabelled check.md with an upper-case BLOCK or NOTE differs on purpose: the orchestrator
  // gives null and reads the session's ORCH_VERDICT mark first, the stage runner only compares a file before and after
  // compaction and takes the first word. tests/stage.test.mjs covers that.
  const verdicts = [
    ['Verdict: NOTE\n', 'NOTE'],
    ['No BLOCK finding.\nVerdict: NOTE\n', 'NOTE'],
    ['# 점검\n- 판정: **BLOCK** (게이트 실패)\n', 'BLOCK'],
    ['## 결론\n> 결론: note\n', 'NOTE'],
    ['게이트 통과\n', null],
    ['a block would need a failing gate\n', null],
  ];
  for (const [text, expected] of verdicts) {
    assert.equal(checkVerdict(text), expected, `stage runner: ${text}`);
    assert.equal(verdictFromFile(text), expected, `orchestrator: ${text}`);
  }
});

test('stages that never push deny both git push rules in both runners', async () => {
  const { permissions } = await import('../plugin/scripts/stage.mjs');
  const { defaults } = await import('../orchestrator/scripts/orchestrator.mjs');
  const denies = (p, where) => {
    for (const rule of ['Bash(git push)', 'Bash(git push *)']) {
      assert.ok(p.deny.includes(rule), `${where} does not deny ${rule}`);
      assert.ok(!p.allow.includes(rule), `${where} allows ${rule}`);
    }
  };
  for (const stage of ['do', 'check', 'commit']) denies(permissions(stage), `stage runner ${stage}`);
  // The fix stage uses the implement set.
  const orch = defaults().permissions;
  for (const stage of ['implement', 'check', 'commit']) denies(orch[stage], `orchestrator ${stage}`);
});
