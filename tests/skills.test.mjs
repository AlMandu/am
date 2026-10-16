// Run: node --test tests/skills.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { USER_EFFORTS } from '../plugin/scripts/user-models.mjs';
import { common, withoutCommon, SLASH_NAME } from './helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugin', 'skills');
const AGENT = path.resolve(ROOT, '..', 'agents', 'second-opinion.md');
const LIMITS = { plan: 120, check: 120, commit: 80, do: 80, auto: 80, solo: 80, sessions: 80 };
// The values themselves are models.json's (tests/models.test.mjs checks them where that file exists); here only their form.
const ALIAS = /^[a-z]+(\[1m\])?$/;
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

test('am:plan, am:do, am:auto and am:solo are user-invoked only in both tools', () => {
  for (const name of ['plan', 'do', 'auto', 'solo']) {
    assert.match(read(name), /\ndisable-model-invocation: true\n/, name);
    const yaml = readFileSync(path.join(ROOT, name, 'agents', 'openai.yaml'), 'utf8');
    assert.match(yaml, /allow_implicit_invocation: false/, name);
  }
});

test('every skill sets the model and effort its turn runs with', () => {
  for (const name of Object.keys(LIMITS)) {
    const fm = frontmatter(read(name));
    // Claude Code ignores a misspelled key without an error, which would silently drop the default.
    const userOnly = ['plan', 'do', 'auto', 'solo'].includes(name) ? ['disable-model-invocation'] : [];
    const hooks = name === 'auto' ? ['hooks'] : [];
    assert.deepEqual(Object.keys(fm).sort(), ['argument-hint', 'description', 'effort', 'model', 'name', ...userOnly, ...hooks].sort(), name);
    assert.match(fm.model, ALIAS, name); // an alias, not a full ID: a skill whose model cannot be resolved has no fallback
    assert.ok(USER_EFFORTS.includes(fm.effort), `${name}: ${fm.effort}`);
  }
});

test('am:commit records its commits outside am-orchestrator', () => {
  // am:commit writes the record, except in a session am-orchestrator started (the words every orchestrator session gets).
  assert.match(read('commit'), /your instructions do not say you are running inside am-orchestrator, append `<full hash> <subject>` as one line to `\.am\/<slug>\/commits\.md`/);
  const orch = readFileSync(path.resolve(ROOT, '..', '..', 'orchestrator', 'scripts', 'orchestrator.mjs'), 'utf8');
  assert.ok(orch.includes("'You are running inside am-orchestrator, an unattended batch run."));
});

test('the workflow skills keep a handoff document, also in am-orchestrator, and mark the current task outside it', () => {
  // One sentence, word for word in each skill that rewrites the whole document.
  const handoff = 'Handoff: rewrite `.am/<slug>/handoff.md` whole, in the language of plan.md and in about 40 lines or fewer: the goal; status (done, in progress, left); files changed and the gist of each; settled decisions not to reopen; open issues and suspect spots; the next concrete action. Point to plan.md for details instead of copying it.';
  for (const name of ['plan', 'do', 'check', 'commit']) {
    assert.ok(read(name).includes(handoff), name);
    // Sessions am-orchestrator started keep the document too.
    assert.ok(!read(name).includes('Handoff: unless'), name);
  }
  // The mark is written by plan and do, and only listed first as current, never followed on its own.
  for (const name of ['plan', 'do']) assert.match(read(name), /unless your instructions say you are running inside am-orchestrator, write the slug as one line to `\.am\/\.active`/i, name);
  for (const name of ['do', 'commit']) assert.ok(read(name).includes('the one named on the first line of `.am/.active` first and marked as current (only when that folder exists)'), name);
  // am:do still ends by handing over to am:check (the orchestrator relies on it).
  assert.match(read('do').trim().split('\n').at(-1), /use the am:check skill/);
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
  // A follow call that reached its limit ends WAIT while the stage still runs.
  assert.match(auto, /`WAIT` \(any stage\):[^\n]*, or the stage is still running;/);
  // After the check comes the commit, with no memory stage between them.
  assert.ok(auto.includes('`NOTE` (check): commit.'));
  assert.ok(auto.includes('skip check and commit'));
  assert.ok(read('check').includes('the next step (the am:commit skill, or what to fix)'));
});

test('am:solo follows am:auto\'s file with its own differences', async () => {
  const solo = withoutCommon(read('solo'));
  const { PART_LINE } = await import('../plugin/scripts/stage.mjs');
  for (const s of ['${CLAUDE_PLUGIN_ROOT}/skills/auto/SKILL.md', '`--solo`', '--solo=', '## Parts', '- Part <k> done:', '`solo`', '`context`', '`HANDED`', 'step 2', 'step 4', 'step 7', 'consecutive Steps', 'done mark']) assert.ok(solo.includes(s), s);
  // A part request's first line: a later run reads part folders written earlier and stops when it does not match.
  for (const s of ['`Part <k> of <N> of .am/<slug>/plan.md:`', '`Part <k> of <N> of .am/<parent>/plan.md:`']) assert.ok(solo.includes(s), s);
  // The plan stage writes the Parts lines in this form; in a session with no stage sessions am:solo writes them itself.
  assert.ok(solo.includes(PART_LINE), 'PART_LINE');
  assert.ok(!solo.includes('skills/run/SKILL.md'));
  // Push mode belongs to the stage flow of each part, not only to the Codex loop.
  const parts = solo.split('\n## Parts\n')[1].split('\n## ')[0].split('\n');
  const push = "In push mode each part's commit stage pushes.";
  assert.ok(parts.find((l) => l.startsWith('  3. ')).includes(push), 'push on part step 3');
  assert.ok(!parts.find((l) => l.includes('In Codex, or after')).includes(push), 'push not on the Codex line');
});

test('am:auto keeps the anchors am:solo refers to', () => {
  const auto = read('auto');
  for (const s of ['## Running without stops', '## Stage sessions (Claude Code)', '`HANDED`']) assert.ok(auto.includes(s), s);
  const steps = auto.split('\n## Steps\n')[1];
  assert.ok(steps, 'the Steps section');
  const step = Object.fromEntries(('\n' + steps).split(/\n(?=\d+\. )/).filter((s) => /^\d+\. /.test(s)).map((s) => [Number(s.split('.')[0]), s]));
  for (const n of [2, 4, 7]) assert.ok(step[n], `step ${n}`);
  assert.ok(step[2].includes('claude plugin list --json'), 'step 2');
  assert.ok(step[4].includes('Hand-over:'), 'step 4');
  assert.ok(step[7].includes('After a hand-over'), 'step 7');
});

test('am:sessions runs the read-only report script once and the model may invoke it', () => {
  const skill = read('sessions');
  assert.ok(skill.includes('`node "${CLAUDE_PLUGIN_ROOT}/scripts/sessions.mjs"`'));
  assert.ok(existsSync(path.join(ROOT, '..', 'scripts', 'sessions.mjs')), 'plugin/scripts/sessions.mjs');
  // No Codex manifest: the model may pick this skill on its own in both tools.
  assert.ok(!existsSync(path.join(ROOT, 'sessions', 'agents', 'openai.yaml')));
  assert.match(skill, /Change, remove or stop nothing/);
  // The report shows solo tasks as am:auto tasks, so both ways to resume are named.
  assert.ok(skill.includes('`am:solo <slug>`'));
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
  assert.ok(section.includes('each `second opinion:` line gets its own plain line: what had to be decided and which option was chosen, and which reviewers agreed, if both did'));
  assert.ok(section.includes('other than its `second opinion:` lines'));
  // After a WAIT at the follow limit the same stage runs on: one progress command, kept going while a stage command runs.
  assert.ok(section.includes('--consumer main` from the repository root in the background unless one is still running'));
  assert.ok(section.includes('has already ended and no stage command of this task is running now'));
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
  assert.match(fm.model, ALIAS); // alias: follows the main session's Opus version, so a new Opus is picked up
  assert.ok(USER_EFFORTS.includes(fm.effort), fm.effort);
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

test('without Codex, the common rules have two Claude reviewers debate the same way', () => {
  const block = common(read('plan'));
  assert.match(block, /when Codex is not installed \(exit code 2\), send it at once to two of them, Claude 1 and Claude 2, each Agent call's prompt adding one line that names which of the two it is/);
  assert.match(block, /labelled Claude and Codex \(Claude 1 and Claude 2 without Codex, each told again which one it is\)/);
  assert.ok(block.includes('(second opinion, Claude reviewers agreed) when Claude 1 and Claude 2 agreed'));
  // The second Claude is sent only once the script has said Codex is missing, and the reviewer line covers both calls.
  const run = block.indexOf('codex-opinion.mjs" <brief file>`');
  const send = block.indexOf('Then send the brief to the am:second-opinion subagent');
  const two = block.indexOf('Claude 1 and Claude 2');
  const pass = block.indexOf('Claude reviewer: model');
  assert.ok(run !== -1 && run < send && send < two && two < pass, 'script, then subagent, then two without Codex, then the reviewer line');
  assert.match(block, /otherwise do not override the ones pinned in its definition \(both calls when there are two\)/);
  const agent = readFileSync(AGENT, 'utf8');
  assert.ok(agent.includes('Claude 1') && agent.includes('Claude 2'));
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
