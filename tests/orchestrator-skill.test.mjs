// Run: node --test tests/orchestrator-skill.test.mjs
// The am-orchestrator plugin (orchestrator/): its manifest, its one skill, and the parts of the am plugin its script relies on.
// Also the other direction: what am:auto relies on when it hands a large task to the run skill.
// And where the am stage runner and the orchestrator must agree: end markers, check.md verdicts, push denial, the path of the run events it follows, the user models file reader.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { common, withoutCommon, SLASH_NAME } from './helpers.mjs';
import { makeRepo, planOf, prepared, task } from './orchestrator-helpers.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => readFileSync(path.join(REPO, ...parts), 'utf8');
const SKILL = read('orchestrator', 'skills', 'run', 'SKILL.md');
const SCRIPT = read('orchestrator', 'scripts', 'orchestrator.mjs');
const amSkill = (name) => read('plugin', 'skills', name, 'SKILL.md');
// am-auto's skills (multi, one, agent, sessions).
const autoSkill = (name) => read('auto', 'skills', name, 'SKILL.md');
// Orchestrator stages that run an am skill: a copy of STAGE_SKILLS of scripts/models.mjs, so this file needs no models.mjs.
const STAGE_SKILLS = { plan: 'plan', implement: 'do', check: 'check', commit: 'commit' };
// A model alias and an effort, the form models.json's values take (tests/models.test.mjs checks the values where that file exists).
const MODEL_EFFORT = "model: [a-z]+(?:\\[1m\\])?\\neffort: (?:low|medium|high|xhigh|max)";
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// The object status --json prints as run; am:auto and the stage runner read its fields.
const RUN = /data\.run = \{([\s\S]*?)\n    \};/.exec(SCRIPT);

/** What a hand-over reads from status --json and the commands and next values it names exist in the script and the skill. */
function readsStatusLikeAuto(text) {
  assert.ok(RUN, 'status --json builds run');
  const fields = [...new Set([...text.matchAll(/\brun\.([a-z]+)\b/g)].map((m) => m[1]))].sort();
  assert.deepEqual(fields, ['branch', 'id', 'report']);
  for (const f of fields) assert.match(RUN[1], new RegExp(`\\b${f}:`), `run.${f}`);
  for (const field of ['autoDecided', 'secondOpinions']) assert.ok(text.includes(`\`${field}\``) && new RegExp(`\\b${field}: `).test(SCRIPT), field);
  for (const c of ['split', 'decide']) assert.ok(text.includes(`\`${c}\``) && new RegExp(`^\\| \`${c}[ \`]`, 'm').test(SKILL), c);
  for (const v of ['done', 'decide', 'answer', 'blocked']) assert.ok(text.includes(`\`${v}\``) && SKILL.includes(`\`${v}\``) && SCRIPT.includes(`'${v}'`), v);
}

test('the marketplace lists every plugin and each source holds a manifest with that name', () => {
  const market = JSON.parse(read('.claude-plugin', 'marketplace.json'));
  assert.deepEqual(market.plugins.map((p) => p.name), ['am', 'am-auto', 'am-util', 'am-orchestrator']);
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
  assert.match(SKILL, new RegExp(`\\n${MODEL_EFFORT}\\n---\\n`));
  assert.match(read('orchestrator', 'skills', 'run', 'agents', 'openai.yaml'), /allow_implicit_invocation: false/);
  assert.ok(!SLASH_NAME.test(withoutCommon(SKILL)), 'refer to skills by name, not with a slash prefix');
});

test('the skill and the script agree on commands and on every "next" value', () => {
  const commands = [...SKILL.matchAll(/^\| `([a-z]+)[ `]/gm)].map((m) => m[1]);
  assert.deepEqual(commands, ['doctor', 'split', 'status', 'progress', 'decide', 'answer', 'run', 'retry', 'done', 'sessions']);
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
  for (const field of ['next', 'decisions', 'needsDecision', 'blocked', 'errors', 'running', 'autoDecided', 'secondOpinions']) {
    assert.ok(SKILL.includes(`\`${field}`) && new RegExp(`\\b${field}\\b`).test(SCRIPT), field);
  }
  for (const field of ['run.tasks', 'run.report', 'blocked[].reason', 'blocked[].logs', 'blocked[].hint', 'needsDecision[].file']) assert.ok(SKILL.includes(`\`${field}\``), field);
  // The run skill relays the script's second-opinion news line by its prefix.
  assert.ok(SKILL.includes('`second opinion:`') && SCRIPT.includes('text: `second opinion: ${line}`'), 'second opinion news prefix');
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
  assert.match(autoSkill('multi'), /`\(auto-decided\)`[\s\S]*`\(자동 결정\)`/);
  assert.match(SCRIPT, /auto-decided\|자동 결정/);
  // The second-opinion marks of the common rules, which progress news reads.
  for (const mark of ['(second opinion)', '(second opinion, Codex agreed)', '(second opinion, Claude reviewers agreed)', '(no second opinion)']) assert.ok(amSkill('plan').includes(mark), mark);
  assert.match(SCRIPT, /\\\(\(\?:second opinion\|2차 의견\(\?! 없음\)\)/);
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
  assert.match(SCRIPT, /\n  split: \{ model: '[a-z]+(?:\[1m\])?', effort: '(?:low|medium|high|xhigh|max)' \},/, 'STAGE_DEFAULTS.split');
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
  const auto = autoSkill('multi');
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
  // The orchestrator's split ends with exit code 4 while it still runs (process.exitCode = 4, pinned by its own tests).
  assert.match(auto, /if `split` ends with exit code 4, it is still running: run `split` again with no argument/);
  assert.match(auto, /once `split` has made the run \(`run\.id` present and not the noted one; otherwise stop and report\), log exactly this one line in the Change log, [^\n]*with `<branch>` the current branch: `- Hand-over: am-orchestrator run skill, run <run\.id>, start branch <branch>`/);
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
  const { instructions, permissions } = await import('../auto/scripts/stage.mjs');
  const hook = read('auto', 'hooks', 'handover.mjs');
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

test('an inline hand-over reads the run skill frontmatter and fills a command path its permissions allow', async () => {
  const { skillDefaults, inlineSkill, permissions } = await import('../auto/scripts/stage.mjs');
  const root = path.join(REPO, 'orchestrator');
  const line = (key) => new RegExp(`^${key}: (.+)$`, 'm').exec(SKILL)[1].trim();
  assert.deepEqual(skillDefaults(root, 'run'), { model: line('model'), effort: line('effort') });
  assert.ok(SKILL.includes('Request: $ARGUMENTS'));
  assert.ok(SKILL.includes('node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.mjs"'));
  const roots = [root, ...(process.platform === 'win32' ? ['C:\\Users\\me\\.claude\\plugins\\cache\\am-workflow\\am-orchestrator\\0.8.0'] : [])];
  for (const r of roots) {
    const file = /node "([^"]+orchestrator\.mjs)"/.exec(inlineSkill(SKILL, '.am/x/plan.md', r))[1];
    assert.equal(file, `${r.split(path.sep).join('/')}/scripts/orchestrator.mjs`);
    const { allow } = permissions('handover', { orchRoot: r });
    assert.ok(allow.includes(`Bash(node "${file}" *)`) && allow.includes(`Bash(node ${file} *)`), r);
  }
});

test('the am stage runner copies the events a real split writes, from the path the orchestrator uses', async () => {
  const { runRelay, instructions } = await import('../auto/scripts/stage.mjs');
  const { readFrom } = await import('../auto/scripts/progress.mjs');
  const r = makeRepo();
  const doctor = r.orch('doctor');
  assert.equal(doctor.code, 0, doctor.out);
  mkdirSync(path.join(r.repo, '.am', 'x'), { recursive: true });
  writeFileSync(path.join(r.repo, '.am', '.gitignore'), '*\n');
  // Made before the split, as in a new hand-over: no current run yet.
  const relay = runRelay(r.repo, 'x');
  const split = r.orch('split', path.join(r.repo, 'docs', 'design.md'));
  assert.equal(split.code, 0, split.out);
  relay();
  const copied = () => readFrom(path.join(r.repo, '.am', 'x', 'progress.jsonl'), 0).events;
  const list = copied();
  assert.ok(list.length >= 1);
  assert.equal(list.length, readFrom(path.join(r.runDir(), 'progress.jsonl'), 0).events.length);
  for (const e of list) {
    assert.equal(e.src, 'run', e.text);
    assert.ok(e.ev !== 'start' && e.ev !== 'end' && !('pid' in e), e.text);
  }
  assert.deepEqual([list[0].ev, list[0].stage, list[0].text], ['step', 'split', 'split started']);
  assert.ok(list.at(-1).text.startsWith('split into 3 tasks'), list.at(-1).text);
  assert.equal(list.at(-1).status, 'done');
  // A resumed hand-over starts at the end of what the run already wrote.
  runRelay(r.repo, 'x', { resume: true })();
  assert.equal(copied().length, list.length);
  assert.deepEqual(readdirSync(r.runDir()).filter((f) => f.endsWith('.cursor')), []);
  // The command the hand-over session is told to leave alone exists in the script.
  for (const resume of [true, false]) assert.ok(instructions('handover', 'x', { resume }).system.includes("Do not run the `progress` command of the run skill's script"), `resume ${resume}`);
  assert.ok(SCRIPT.includes("case 'progress':"));
});

test('the am stage runner waits on the orchestrator through what is pinned here: the lock pid and the ends of split and answer', async () => {
  const { otherRuns, GRACE_MS } = await import('../auto/scripts/stage.mjs');
  // The lock names the live command's pid; the ends after which the run skill starts its next command.
  assert.match(SCRIPT, /createLock\(lockFile\(repo\), \{ pid: process\.pid, command,/);
  assert.match(SCRIPT, /event\(\{ ev: 'end', stage: 'split', status: 'done',/);
  assert.match(SCRIPT, /event\(\{ ev: 'end', stage: 'answer', task: id, status: s\.status,[^\n]*\/\/ planned, split, blocked 또는 needs-decision/);
  for (const s of ["status: 'planned'", "status = 'split'"]) assert.ok(SCRIPT.includes(s), s);
  assert.match(SCRIPT, /const ORCH_DIR = '\.orchestrator';/);
  // A real split: the stage runner of another task waits in the gap after it, and not after the grace time.
  const r = makeRepo();
  assert.equal(r.orch('doctor').code, 0);
  mkdirSync(path.join(r.repo, '.am', 'x'), { recursive: true });
  const split = r.orch('split', path.join(r.repo, 'docs', 'design.md'));
  assert.equal(split.code, 0, split.out);
  const run = readFileSync(path.join(r.repo, '.orchestrator', 'current'), 'utf8').trim();
  assert.deepEqual(otherRuns(r.repo, 'x').runs, [`am-orchestrator run ${run}`]);
  assert.deepEqual(otherRuns(r.repo, 'x', { now: () => Date.now() + GRACE_MS + 60000 }).runs, []);
});

test('the hand-over owner the am stage runner gives its session is the worker.json owner it stops by', async () => {
  const { sessionEnv, stopHandedRun } = await import('../auto/scripts/stage.mjs');
  const N = 4321;
  const r = makeRepo();
  // The follower passes its environment to the detached worker, as a hand-over session's command does.
  r.orch.env = { AM_HANDOVER_OWNER: sessionEnv('handover', {}, N).AM_HANDOVER_OWNER };
  try {
    assert.equal(r.orch('doctor').code, 0);
  } finally {
    r.orch.env = {};
  }
  const worker = JSON.parse(readFileSync(path.join(r.repo, '.orchestrator', 'worker', 'worker.json'), 'utf8'));
  assert.equal(worker.owner, N);
  const W = worker.pid;
  assert.ok(Number.isInteger(W) && W > 0);
  writeFileSync(path.join(r.repo, '.orchestrator', 'lock.json'), JSON.stringify({ pid: W, command: 'doctor', startedAt: new Date().toISOString() }));
  const sent = [];
  const kill = (pid, sig) => sent.push([pid, sig]);
  assert.equal(stopHandedRun(r.repo, N + 1, { alive: (p) => p === W, kill }), null);
  assert.deepEqual(sent, []);
  assert.equal(stopHandedRun(r.repo, N, { alive: (p) => p === W, kill }), W);
  assert.deepEqual(sent, [[W, 'SIGTERM']]);
});

test('the second-opinion mark is the same regular expression in the orchestrator and the am stage runner', async () => {
  const orch = (await import('../orchestrator/scripts/orchestrator.mjs')).SECOND_MARK;
  const stage = (await import('../auto/scripts/stage.mjs')).SECOND_MARK;
  assert.deepEqual([orch.source, orch.flags], [stage.source, stage.flags]);
  for (const yes of ['(second opinion)', '(Second Opinion, Codex agreed)', '(second opinion, Claude reviewers agreed)', '(2차 의견)', '(2차 의견, Codex 동의)']) assert.ok(orch.test(yes), yes);
  for (const no of ['(no second opinion)', '(2차 의견 없음)', '2차 의견']) assert.ok(!orch.test(no), no);
});

// Windows cannot be sent SIGINT from here (the same reason as the lock test in orchestrator-drive.test.mjs).
test('the lock pid the am stage runner reads is the detached worker, not the command it follows', { skip: process.platform === 'win32' }, async () => {
  const { otherRuns } = await import('../auto/scripts/stage.mjs');
  const r = makeRepo({ scenario: { implement: { 't01-a': ['SLOW', 'DONE'] } } });
  assert.equal(r.orch('doctor').code, 0);
  assert.equal(r.orch('split', path.join(r.repo, 'docs', 'design.md')).code, 0);
  mkdirSync(path.join(r.repo, '.am', 'x'), { recursive: true });
  const proc = r.start('run', '--only', 'T01');
  const exited = new Promise((res) => proc.on('exit', (code) => res(code)));
  const pidFile = path.join(r.repo, '.orchestrator', 'fake-slow.pid');
  for (let i = 0; i < 200 && !existsSync(pidFile); i += 1) await new Promise((res) => setTimeout(res, 50));
  assert.ok(existsSync(pidFile), proc.out);
  const lock = JSON.parse(readFileSync(path.join(r.repo, '.orchestrator', 'lock.json'), 'utf8'));
  const worker = JSON.parse(readFileSync(path.join(r.repo, '.orchestrator', 'worker', 'worker.json'), 'utf8'));
  assert.equal(lock.pid, worker.pid);
  assert.notEqual(lock.pid, proc.pid);
  // The lease the stage runner applies to lock.json: only a lock that carries a numeric leaseMs goes stale, after that long without a touch.
  const { LOCK_LEASE_MS } = await import('../orchestrator/scripts/orchestrator.mjs');
  assert.equal(LOCK_LEASE_MS, 5 * 60000);
  assert.equal(lock.leaseMs, LOCK_LEASE_MS);
  process.kill(lock.pid, 0); // alive
  assert.deepEqual(otherRuns(r.repo, 'x').runs, ['am-orchestrator']);
  proc.kill('SIGINT');
  assert.equal(await exited, 130, proc.out);
});

// Skipped on Windows for the same reason: SIGINT.
test('the am sessions report puts a handed-over run and its implement session under the am:auto task that owns it', { skip: process.platform === 'win32' }, async () => {
  const { collect, render } = await import('../auto/scripts/sessions.mjs');
  const r = makeRepo({ scenario: { implement: { 't01-a': ['SLOW', 'DONE'] } } });
  assert.equal(r.orch('doctor').code, 0);
  assert.equal(r.orch('split', path.join(r.repo, 'docs', 'design.md')).code, 0);
  // The am:auto task whose stage worker (this test process) handed the run over.
  const am = path.join(r.repo, '.am', 'x');
  mkdirSync(am, { recursive: true });
  const t = Date.now();
  writeFileSync(path.join(am, 'stage-worker.json'), JSON.stringify({ pid: process.pid, t, stage: 'do', push: false, fix: false }));
  const at = new Date(t).toISOString();
  writeFileSync(
    path.join(am, 'progress.jsonl'),
    [
      { t: at, ev: 'start', text: 'stage do started', pid: process.pid, stage: 'do' },
      { t: at, ev: 'note', text: 'handed to the am-orchestrator run skill', stage: 'handover' },
    ]
      .map((e) => `${JSON.stringify(e)}\n`)
      .join(''),
  );
  r.orch.env = { AM_HANDOVER_OWNER: String(process.pid) };
  const proc = r.start('run', '--only', 'T01');
  r.orch.env = {};
  const exited = new Promise((res) => proc.on('exit', (code) => res(code)));
  const pidFile = path.join(r.repo, '.orchestrator', 'fake-slow.pid');
  for (let i = 0; i < 200 && !existsSync(pidFile); i += 1) await new Promise((res) => setTimeout(res, 50));
  assert.ok(existsSync(pidFile), proc.out);
  const run = readFileSync(path.join(r.repo, '.orchestrator', 'current'), 'utf8').trim();
  const title = JSON.parse(readFileSync(path.join(r.runDir(), 'tasks.json'), 'utf8')).tasks.find((x) => x.id === 'T01').title;
  const snap = collect({ cwd: r.repo, env: { CLAUDE_CONFIG_DIR: r.home } });
  const task = snap.trees[0].tasks.find((x) => x.slug === 'x');
  assert.ok(task?.run, JSON.stringify(snap));
  assert.equal(task.run.run, run);
  const child = task.run.children.find((c) => c.id === 'T01');
  assert.ok(child, JSON.stringify(task.run));
  assert.equal(child.title, title);
  assert.equal(child.role, 'implement');
  assert.equal(child.waiting, false);
  assert.ok(Number.isFinite(child.startedAt));
  assert.ok(render(snap).split('\n').includes(`    └ 인계: am-orchestrator 실행 ${run}`), render(snap));
  proc.kill('SIGINT');
  assert.equal(await exited, 130, proc.out);
});

test('the am stage runner and the orchestrator read end markers and check.md verdicts alike', async () => {
  const { MARKS, lastMark, checkVerdict } = await import('../auto/scripts/stage.mjs');
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
  const { permissions } = await import('../auto/scripts/stage.mjs');
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

test('the progress command takes no lock, is in the usage text, and its section imports nothing from am and reads no environment', () => {
  assert.ok(SCRIPT.includes("case 'progress':"));
  // The commands that take the lock: progress must run next to them.
  const locking = /\[([^\]]*)\]\.includes\(cmd\)/.exec(SCRIPT);
  assert.ok(locking, 'the list of locking commands');
  assert.deepEqual([...locking[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1]), ['doctor', 'split', 'decide', 'answer', 'run', 'retry', 'done']);
  const usage = /const USAGE = `([\s\S]*?)`;/.exec(SCRIPT);
  assert.ok(usage && usage[1].split('\n').some((line) => line.trim().startsWith('progress ')), 'usage has a progress line');
  // The orchestrator is installed without am: only Node's own modules, and no import at run time.
  const imports = [...SCRIPT.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
  assert.equal(imports.length, SCRIPT.match(/^import /gm).length, 'an import of another form: check its target here');
  for (const target of imports) assert.ok(target.startsWith('node:'), target);
  assert.ok(!/\bimport\(/.test(SCRIPT));
  const section = /\n\/\/ -+ 진행 소식 기다리기\n([\s\S]*?)\n\/\/ -+ 진입점\n/.exec(SCRIPT);
  assert.ok(section, 'the progress section');
  assert.ok(!section[1].includes('process.env'));
});

test('the run skill starts the progress command next to split, answer and run', async () => {
  const rules = /\nRules while driving:\n([\s\S]*?)\n## Steps\n/.exec(SKILL);
  assert.ok(rules, 'the Rules while driving block');
  const items = rules[1].split('\n').filter((l) => l.includes('`progress --consumer main`'));
  assert.equal(items.length, 1, 'one rule names the progress command');
  for (const name of ['split', 'answer', 'run', 'doctor', 'status --json']) assert.ok(items[0].includes(`\`${name}\``), name);
  // The skill reads this line and does not start the progress command again.
  const fs = await import('node:fs');
  const os = await import('node:os');
  const { waitProgress } = await import('../orchestrator/scripts/orchestrator.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-ended-'));
  try {
    let t = Date.parse('2026-10-08T00:00:00.000Z');
    const writes = [];
    const code = await waitProgress(dir, { consumer: 'main', now: () => t, sleep: async (ms) => void (t += ms), alive: () => false, out: { write: (s) => writes.push(s) } });
    assert.equal(code, 0);
    assert.equal(writes.join(''), 'state: ended\n');
    assert.ok(rules[1].includes('`state: ended`'), 'the rule names the state line');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('the run skill follows a long command that is still running: exit code 4 and wait', async () => {
  const table = /\n\| `sessions[^\n]*\n\n([^\n]+)\n/.exec(SKILL);
  assert.ok(table, 'a line right below the command table');
  for (const s of ['each end within about 9 minutes', 'exit code 4']) assert.ok(table[1].includes(s), s);
  const rules = /\nRules while driving:\n([\s\S]*?)\n## Steps\n/.exec(SKILL)[1];
  for (const s of ['run the same command again with no argument', 'this is not the polling forbidden here', 'The exception is running the command that is still running again with no argument, which follows it.', 'unless one is already running', 'a code other than 4']) assert.ok(rules.includes(s), s);
  const split = /^3\. Split\.[^\n]*/m.exec(SKILL);
  assert.ok(split && split[0].includes('if it ends with exit code 4, run `split` with no argument until it ends with another code'), 'step 3 follows split');
  const run = /^ {3}- `run`: [^\n]*/m.exec(SKILL);
  assert.ok(run && run[0].includes('4: it is still running'), 'step 4 run handles exit code 4');
  const wait = /^ {3}- `wait`: [^\n]*/m.exec(SKILL);
  for (const s of ['has not ended yet, wait for its completion notice', '`running.command`']) assert.ok(wait && wait[0].includes(s), s);
  // The script: the limit stays under the Bash time limit like the progress command, prints the line the skill relies on and ends with 4.
  const { FOLLOW_DEFAULTS, PROGRESS_DEFAULTS } = await import('../orchestrator/scripts/orchestrator.mjs');
  assert.equal(FOLLOW_DEFAULTS.followLimitMs, PROGRESS_DEFAULTS.maxLifeMs);
  assert.ok(SCRIPT.includes('아직 진행 중, 같은 명령을 인자 없이 다시 실행하면 이어서 따라갑니다'));
  assert.ok(SCRIPT.includes('process.exitCode = 4'));
  assert.match(SCRIPT, /data\.running = \{[^\n]*command: lock\.command/);
});

test('the same event lines give the same output from the am wait command and the orchestrator one', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const { DEFAULTS, wait } = await import('../auto/scripts/progress.mjs');
  const { PROGRESS_DEFAULTS, waitProgress } = await import('../orchestrator/scripts/orchestrator.mjs');
  assert.deepEqual(PROGRESS_DEFAULTS, DEFAULTS);
  const T0 = Date.parse('2026-10-08T00:00:00.000Z');
  const LIVE = 4242;
  const alive = (pid) => pid === LIVE;
  const line = (fields) => `${JSON.stringify({ t: new Date(T0).toISOString(), ...fields })}\n`;
  const start = line({ ev: 'start', text: 'run started', pid: LIVE, stage: 'run' });
  const cases = {
    'a live start, a step and a note': start + line({ ev: 'step', text: 'T01 plan started', task: 'T01', stage: 'plan' }) + line({ ev: 'note', text: 'plan session ended' }),
    'an alert': start + line({ ev: 'alert', text: 'T01 blocked', task: 'T01', status: 'blocked' }),
    'ends with an end': start + line({ ev: 'step', text: 'T01 done', status: 'done' }) + line({ ev: 'end', text: 'done 1 of 1', status: 'done', min: 3 }),
    'a start with a dead pid': line({ ev: 'start', text: 'run started', pid: 1, stage: 'run' }),
    'a start without a pid': line({ ev: 'start', text: 'run started', stage: 'run' }),
    'lines that are no events and an unfinished last line': `not json\n[1]\n${start}{"ev":"other","text":"x"}\r\n${line({ ev: 'alert', text: '막힘  é' })}{"t":"x","ev":"alert","te`,
    'a do stage that was handed over': line({ ev: 'start', text: 'do stage started', pid: LIVE, stage: 'do' }) + line({ ev: 'note', text: 'handed over', stage: 'handover' }),
    'no file': null,
  };
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-same-'));
  try {
    for (const [name, bytes] of Object.entries(cases)) {
      const dir = fs.mkdtempSync(path.join(base, 'c-'));
      const am = path.join(dir, '.am', 'x');
      const orch = path.join(dir, '.orchestrator', 'runs', 'x');
      if (bytes !== null) {
        for (const folder of [am, orch]) {
          fs.mkdirSync(folder, { recursive: true });
          fs.writeFileSync(path.join(folder, 'progress.jsonl'), bytes);
        }
      }
      const cursorOf = (folder) => (fs.existsSync(path.join(folder, 'progress.terminal.cursor')) ? fs.readFileSync(path.join(folder, 'progress.terminal.cursor'), 'utf8') : null);
      // One wait on a virtual clock that only sleep moves: what it printed, and how long it took.
      const one = async (fn) => {
        let t = T0;
        const writes = [];
        const code = await fn({ now: () => t, sleep: async (ms) => void (t += ms), alive, out: { write: (s) => writes.push(s) } });
        return { code, out: writes.join(''), took: t - T0 };
      };
      // The second round starts from the moved cursors.
      for (const round of [1, 2]) {
        const a = await one((o) => wait({ events: path.join(am, 'progress.jsonl'), cursor: path.join(am, 'progress.terminal.cursor'), plan: path.join(am, 'plan.md') }, o));
        const b = await one((o) => waitProgress(dir, { run: 'x', ...o }));
        assert.match(a.out, /(^|\n)state: (ended|running \(.+, \d+ min\))\n$/, `${name}, round ${round}`);
        assert.deepEqual(b, a, `${name}, round ${round}`);
        assert.equal(cursorOf(orch), cursorOf(am), `${name}, round ${round}: cursor`);
      }
      if (name.includes('handed over')) assert.equal(cursorOf(orch), String(Buffer.byteLength(bytes)));
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('the am user models module and the orchestrator copy read the same files alike', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const am = await import('../plugin/scripts/user-models.mjs');
  const orch = await import('../orchestrator/scripts/orchestrator.mjs');
  assert.deepEqual(orch.USER_MODEL_KEYS, am.USER_MODEL_KEYS);
  assert.deepEqual(orch.USER_EFFORTS, am.USER_EFFORTS);
  assert.deepEqual(orch.OPINION_MODELS, am.OPINION_MODELS);
  assert.deepEqual(orch.CODEX_EFFORTS, am.CODEX_EFFORTS);
  assert.equal(String(orch.CODEX_MODEL), String(am.CODEX_MODEL));
  // Name, file content (null: no file), whether an error is expected.
  const cases = [
    ['valid', '﻿{"model":{"default":"sonnet","plan":"opus"},"effort":{"do":"low","check":"xhigh","default":"max"}}', false],
    ['no file', null, false],
    ['broken JSON', '{"model":', true],
    ['unknown top key', '{"models":{}}', true],
    ['unknown stage key', '{"effort":{"review":"high"}}', true],
    ['implement key', '{"model":{"implement":"opus"}}', true],
    ['empty model', '{"model":{"plan":""}}', true],
    ['blank model', '{"model":{"plan":"  "}}', true],
    ['bad effort', '{"effort":{"check":"huge"}}', true],
    ['notes', '{"_note":"x","model":{"_why":1,"do":"haiku"},"effort":{"_why":[],"commit":"medium"}}', false],
    ['opinion keys', '{"model":{"second-opinion":"sonnet","codex-opinion":"gpt-5.1-codex"},"effort":{"second-opinion":"max","codex-opinion":"minimal"}}', false],
    ['opinion alias typo', '{"model":{"second-opinion":"sonet"}}', true],
    ['opinion alias case', '{"model":{"second-opinion":"Opus"}}', true],
    ['codex model space', '{"model":{"codex-opinion":"gpt 5"}}', true],
    ['codex model ampersand', '{"model":{"codex-opinion":"a&calc"}}', true],
    ['codex model digit first', '{"model":{"codex-opinion":"5-codex"}}', true],
    ['codex effort max', '{"effort":{"codex-opinion":"max"}}', true],
  ];
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-user-models-'));
  try {
    assert.equal(orch.userModelsFile({ CLAUDE_CONFIG_DIR: base }), am.userModelsFile({ CLAUDE_CONFIG_DIR: base }));
    assert.equal(orch.userModelsFile({}), am.userModelsFile({}));
    for (const [name, content, broken] of cases) {
      const file = am.userModelsFile({ CLAUDE_CONFIG_DIR: fs.mkdtempSync(path.join(base, 'c-')) });
      if (content !== null) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
      }
      const a = am.readUserModels(file);
      assert.deepEqual(orch.readUserModels(file), a, name);
      assert.equal('error' in a, broken, name);
      if (!broken) assert.ok(!JSON.stringify(a).includes('"_'), name);
    }
    const folder = am.userModelsFile({ CLAUDE_CONFIG_DIR: fs.mkdtempSync(path.join(base, 'c-')) });
    fs.mkdirSync(folder, { recursive: true });
    const a = am.readUserModels(folder);
    assert.deepEqual(orch.readUserModels(folder), a, 'a folder');
    assert.ok('error' in a, 'a folder');
  } finally {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('the am user settings module and the orchestrator copy read the same files alike', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const am = await import('../plugin/scripts/user-settings.mjs');
  const orch = await import('../orchestrator/scripts/orchestrator.mjs');
  // Name, file content (null: no file), whether an error is expected.
  const cases = [
    ['valid', '﻿{"_note":"x","minFreeMemoryMB":6144}', false],
    ['no file', null, false],
    ['empty object', '{}', false],
    ['null value', '{"minFreeMemoryMB":null}', false],
    ['zero', '{"minFreeMemoryMB":0}', false],
    ['fraction', '{"minFreeMemoryMB":6144.5}', false],
    ['broken JSON', '{"minFreeMemoryMB":', true],
    ['empty file', '', true],
    ['array', '[]', true],
    ['top-level number', '6144', true],
    ['negative', '{"minFreeMemoryMB":-1}', true],
    ['string', '{"minFreeMemoryMB":"6GB"}', true],
    ['boolean', '{"minFreeMemoryMB":true}', true],
    ['infinite', '{"minFreeMemoryMB":1e400}', true],
    ['key case', '{"minFreeMemoryMb":6144}', true],
    ['models key', '{"model":{}}', true],
    ['mcp on', '{"stageMcpServers":true}', false],
    ['mcp off', '{"stageMcpServers":false}', false],
    ['mcp null', '{"stageMcpServers":null}', false],
    ['both keys', '{"_stageMcpServers":["x"],"minFreeMemoryMB":0,"stageMcpServers":true}', false],
    ['mcp string', '{"stageMcpServers":"yes"}', true],
    ['mcp number', '{"stageMcpServers":1}', true],
  ];
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-user-settings-'));
  try {
    assert.equal(orch.userSettingsFile({ CLAUDE_CONFIG_DIR: base }), am.userSettingsFile({ CLAUDE_CONFIG_DIR: base }));
    assert.equal(orch.userSettingsFile({}), am.userSettingsFile({}));
    assert.equal(am.DEFAULT_MIN_FREE_MEMORY_MB, orch.DEFAULT_MIN_FREE_MEMORY_MB);
    for (const [name, content, broken] of cases) {
      const file = am.userSettingsFile({ CLAUDE_CONFIG_DIR: fs.mkdtempSync(path.join(base, 'c-')) });
      if (content !== null) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
      }
      const a = am.readUserSettings(file);
      assert.deepEqual(orch.readUserSettings(file), a, name);
      assert.equal('error' in a, broken, name);
      if (!broken) assert.ok(!JSON.stringify(a).includes('"_'), name);
    }
    const folder = am.userSettingsFile({ CLAUDE_CONFIG_DIR: fs.mkdtempSync(path.join(base, 'c-')) });
    fs.mkdirSync(folder, { recursive: true });
    const a = am.readUserSettings(folder);
    assert.deepEqual(orch.readUserSettings(folder), a, 'a folder');
    assert.ok('error' in a, 'a folder');
  } finally {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('am memory guard and the orchestrator: same free-memory rule, record rule, folder, name and host on the same inputs', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const am = await import('../auto/scripts/memory-guard.mjs');
  const orch = await import('../orchestrator/scripts/orchestrator.mjs');
  assert.equal(am.DEFAULT_MIN_FREE_MEMORY_MB, orch.DEFAULT_MIN_FREE_MEMORY_MB);
  assert.equal(am.HEARTBEAT_MS, orch.HEARTBEAT_MS);
  assert.equal(am.HEARTBEAT_MS, 30000);
  assert.equal(am.STALE_MS, orch.STALE_MS);
  assert.equal(am.STALE_MS, 300000);
  assert.equal(am.RECORD_NAME.source, orch.RECORD_NAME.source);
  assert.equal(am.RECORD_NAME.flags, orch.RECORD_NAME.flags);
  assert.equal(am.RECORD_NAME.flags, '');
  const MB = 1048576;
  for (const busy of [-1, 0, 1, 3])
    for (const freeBytes of [0, 500 * MB, (orch.DEFAULT_MIN_FREE_MEMORY_MB - 1) * MB, orch.DEFAULT_MIN_FREE_MEMORY_MB * MB, 6143 * MB, 6144 * MB, 7000 * MB])
      for (const setting of [undefined, null, '', ' ', '6GB', -1, 0, 500, '500', 6144])
        for (const platform of ['win32', 'darwin', 'linux']) {
          const input = { busy, freeBytes, setting, platform };
          assert.deepEqual(am.memoryShortMB(input), orch.memoryShortMB(input), JSON.stringify(input));
        }
  const now = 10 * 60000;
  const alive = (pid) => pid === 1;
  for (const host of ['me', 'other'])
    for (const pid of [1, 2])
      for (const mtimeMs of [now, now - 4 * 60000, now - 6 * 60000])
        for (const woke of [false, true])
          for (const young of [false, true]) {
            const opts = { now, myHost: 'me', alive, woke, young };
            assert.equal(am.recordHeld({ host, pid, mtimeMs }, opts), orch.recordHeld({ host, pid, mtimeMs }, opts), JSON.stringify({ host, pid, mtimeMs, woke, young }));
          }
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-memory-guard-'));
  try {
    assert.equal(orch.sessionsDir({ CLAUDE_CONFIG_DIR: base }), am.sessionsDirOf({ CLAUDE_CONFIG_DIR: base }));
    assert.equal(orch.sessionsDir({}), am.sessionsDirOf({}));
    assert.equal(orch.hostName(), am.hostName());
    const dir = am.sessionsDirOf({ CLAUDE_CONFIG_DIR: base });
    const rec = am.holdRecord({ kind: 'test' }, { dir });
    try {
      const m = orch.RECORD_NAME.exec(path.basename(rec.file));
      assert.ok(m, rec.file);
      assert.equal(m[1], orch.hostName());
      assert.equal(m[2], String(process.pid));
      assert.equal(m[3], '.gate');
    } finally {
      rec.release();
    }
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 });
  }
});

// The same scenes for am's proc-tree.mjs and its copy in orchestrator.mjs (see tests/proc-tree.test.mjs for what each means).
const PT_MB = 1048576;
const PT_ROOT = 100;
const PW = (pid, ppid, created, mb = 1) => ({ pid, ppid, created, ws: mb * PT_MB });
const PP = (pid, ppid, pgid, mb = 1) => ({ pid, ppid, pgid, ws: mb * PT_MB });
const WIN_SCENES = [
  { name: 'orphan beyond an ended middle parent', lists: [[PW(PT_ROOT, 1, 1001), PW(200, PT_ROOT, 1002), PW(300, 200, 1003, 50), PW(50, 1, 10)], [PW(300, 200, 1003, 50), PW(50, 1, 10)]], steps: [2000], at: 5000 },
  { name: 'reused pid', lists: [[PW(PT_ROOT, 1, 1001), PW(200, PT_ROOT, 1002), PW(300, 200, 1003)], [PW(300, 1, 4000)]], steps: [2000], at: 5000 },
  { name: 'reused parent pid', lists: [[PW(PT_ROOT, 1, 1001), PW(200, PT_ROOT, 1002)], [PW(200, 1, 3000), PW(400, 200, 3500)]], steps: [2000], at: 5000 },
  { name: 'child older than its parent', lists: [[PW(PT_ROOT, 1, 1001), PW(200, PT_ROOT, 1500), PW(500, 200, 1200)], [PW(500, 200, 1200)]], steps: [2000], at: 5000 },
  { name: 'reused root pid', lists: [[PW(PT_ROOT, 1, 4000), PW(400, PT_ROOT, 4500)]], at: 5000 },
  { name: 'orphan of the ended root', lists: [[PW(600, PT_ROOT, 2000, 3)]], at: 5000 },
  { name: 'created after finish', lists: [[PW(600, PT_ROOT, 6000)]], at: 5000 },
  { name: 'gone record links later child', lists: [[PW(PT_ROOT, 1, 1001), PW(200, PT_ROOT, 1500)], [PW(PT_ROOT, 1, 1001)], [PW(400, 200, 3500)]], steps: [2000, 3000], at: 5000 },
  { name: 'gone record links earlier child', lists: [[PW(PT_ROOT, 1, 1001), PW(200, PT_ROOT, 1500)], [PW(PT_ROOT, 1, 1001), PW(400, 200, 2500)], [PW(400, 200, 2500)]], steps: [2000, 3000], at: 5000 },
  { name: 'process older than the session', lists: [[PW(PT_ROOT, 1, 1001), PW(600, PT_ROOT, 900)], [PW(600, PT_ROOT, 900)]], steps: [2000], at: 5000 },
  { name: 'throwing kill', lists: [[PW(600, PT_ROOT, 2000)]], kill: () => { throw new Error('boom'); }, at: 5000 },
  { name: 'throwing list', lists: ['throw'], at: 5000 },
  { name: 'kill false', lists: [[PW(600, PT_ROOT, 2000), PW(700, PT_ROOT, 2000)]], kill: (pid) => pid === 700, at: 5000 },
  { name: 'excluded pid and descendants', lists: [[PW(PT_ROOT, 1, 1001), PW(200, PT_ROOT, 1100), PW(300, 200, 1200), PW(400, 300, 1300), PW(500, 400, 1400), PW(50, 1, 10)], [PW(200, PT_ROOT, 1100), PW(300, 200, 1200), PW(400, 300, 1300), PW(500, 400, 1400), PW(50, 1, 10)]], steps: [2000], at: 5000, exclude: [400] },
  { name: 'excluded orphan beyond ended parent', lists: [[PW(PT_ROOT, 1, 1001), PW(400, PT_ROOT, 1100), PW(500, 400, 1200), PW(600, 500, 1300), PW(700, PT_ROOT, 1400)], [PW(400, 1, 1100), PW(600, 500, 1300), PW(700, 1, 1400)]], steps: [31000], at: 90000, exclude: [400] },
  { name: 'excluded orphan, parent pid reused', lists: [[PW(PT_ROOT, 1, 1001), PW(400, PT_ROOT, 1100), PW(500, 400, 1200), PW(600, 500, 1300)], [PW(PT_ROOT, 1, 1001), PW(400, PT_ROOT, 1100), PW(500, PT_ROOT, 50000), PW(600, 500, 1300)], [PW(400, 1, 1100), PW(500, 1, 50000), PW(600, 500, 1300)]], steps: [31000, 91000], at: 120000, exclude: [400] },
  { name: 'excluded pid never listed', lists: [[PW(600, 400, 1300), PW(700, PT_ROOT, 1400)]], at: 5000, exclude: [400] },
  { name: 'root never seen', lists: [[PW(50, 1, 10)], [PW(700, PT_ROOT, 60000)]], steps: [31000], at: 100000 },
  { name: 'root never seen, earlier orphan', lists: [[PW(50, 1, 10), PW(700, PT_ROOT, 20000)], [PW(700, PT_ROOT, 20000)]], steps: [31000], at: 100000 },
  { name: '/T unsafe', lists: [[PW(200, PT_ROOT, 1100), PW(300, 200, 1200), PW(700, 200, 900)]], at: 5000 },
  { name: '/T safe', lists: [[PW(200, PT_ROOT, 1100, 2), PW(300, 200, 1200, 3)]], at: 5000 },
  { name: 'last list failed', lists: [[PW(PT_ROOT, 1, 1001), PW(200, PT_ROOT, 1100)], null], steps: [2000], at: 5000 },
  { name: 'middle list failed', lists: [null, [PW(PT_ROOT, 1, 1001), PW(200, PT_ROOT, 1002), PW(300, 200, 1003)], [PW(300, 200, 1003)]], steps: [2000, 3000], at: 5000 },
];
const POSIX_GROUP = () => [PP(200, PT_ROOT, PT_ROOT, 10), PP(300, 200, PT_ROOT, 20), PP(50, 1, 50)];
const EX_GROUP = () => [PP(200, 1, PT_ROOT), PP(301, 1, PT_ROOT), PP(302, 1, PT_ROOT), PP(400, 200, PT_ROOT)];
const POSIX_SCENES = [
  { name: 'something left after TERM', lists: [POSIX_GROUP(), [PP(300, 1, PT_ROOT, 20), PP(50, 1, 50)]] },
  { name: 'nothing left after TERM', lists: [POSIX_GROUP(), [PP(50, 1, 50)]] },
  { name: 'excluded descendant in the group', lists: [[...EX_GROUP(), PP(999, 1, 999)].map((p) => (p.pid === 301 ? { ...p, ppid: 999 } : p)), EX_GROUP()], exclude: [301] },
  { name: 'excluded pid in the group lineage', lists: [[...EX_GROUP(), PP(999, 1, 999)].map((p) => (p.pid === 301 ? { ...p, ppid: 999 } : p)), EX_GROUP()], exclude: [999] },
  { name: 'excluded pid outside the group', lists: [[PP(200, 1, PT_ROOT), PP(999, 1, 999)], []], exclude: [999] },
  { name: 'failed list', lists: [null, []] },
  { name: 'empty group', lists: [[PP(50, 1, 50)], []] },
  { name: 'live session pid', lists: [[PP(PT_ROOT, 1, PT_ROOT), PP(200, PT_ROOT, PT_ROOT)], []] },
  { name: 'signals fail', lists: [[PP(200, PT_ROOT, PT_ROOT, 10), PP(300, 200, PT_ROOT, 20)], [PP(300, 200, PT_ROOT, 20)]], signal: () => false },
  { name: 'second list failed', lists: [[PP(200, PT_ROOT, PT_ROOT, 10), PP(300, 200, PT_ROOT, 20)], null] },
  { name: 'throwing signal', lists: [[PP(200, PT_ROOT, PT_ROOT, 10)], [PP(200, PT_ROOT, PT_ROOT, 10)]], signal: () => { throw new Error('boom'); } },
];

/** Plays one scene on one module's createTracker with fresh fakes; returns every call it made and finish's result. */
async function playScene(mod, platform, scene) {
  const clock = { t: 1000 };
  const calls = [];
  const queue = structuredClone(scene.lists);
  const timers = { timeouts: [], intervals: [] };
  const tracker = mod.createTracker({
    pid: PT_ROOT, startedAt: 1000, platform, now: () => clock.t,
    timers: {
      setTimeout: (fn) => { timers.timeouts.push(fn); return { unref() {} }; },
      setInterval: (fn) => { timers.intervals.push(fn); return { unref() {} }; },
      clearTimeout: () => {}, clearInterval: () => {},
    },
    sleep: async (ms) => { calls.push(['sleep', ms]); },
    list: async () => {
      const next = queue.shift();
      if (next === 'throw') throw new Error('boom');
      return next;
    },
    kill: async (pid, opts) => {
      calls.push(['kill', pid, opts.tree]);
      return scene.kill ? scene.kill(pid) : true;
    },
    signal: (pid, sig) => {
      calls.push(['signal', pid, sig]);
      return scene.signal ? scene.signal(pid, sig) : true;
    },
  });
  tracker.start();
  for (const [i, at] of (scene.steps || []).entries()) {
    clock.t = at;
    (i === 0 ? timers.timeouts[0] : timers.intervals[0])();
    await new Promise((r) => setImmediate(r));
  }
  clock.t = scene.at ?? 5000;
  const result = await tracker.finish({ exclude: scene.exclude || [] });
  return { calls, result };
}

test('am proc-tree and the orchestrator: same targets, counts and working-set sums on the same fake lists', async () => {
  const am = await import('../auto/scripts/proc-tree.mjs');
  const orch = await import('../orchestrator/scripts/orchestrator.mjs');
  const stage = await import('../auto/scripts/stage.mjs');
  for (const k of ['LIST_TIMEOUT_MS', 'KILL_TIMEOUT_MS', 'FIRST_LIST_MS', 'LIST_EVERY_MS', 'TERM_WAIT_MS']) assert.equal(orch[k], am[k], k);
  assert.deepEqual(orch.WIN_LIST_ARGS, am.WIN_LIST_ARGS);
  assert.equal(orch.CLEANUP_MS, stage.CLEANUP_MS);
  const ft = 116444736000000000 + 1234 * 10000;
  for (const text of [JSON.stringify([{ pid: 1, ppid: 0, created: ft, ws: 4096 }, { pid: 'x', ppid: 0, created: ft, ws: 1 }]), JSON.stringify({ pid: 2, ppid: 1, created: ft, ws: 8 }), '[]', '{broken', '', '42', ' [ ] ']) {
    assert.deepEqual(orch.parseWinList(text), am.parseWinList(text), text);
  }
  for (const text of ['  12   1  12  100\n\n 345 12 12 4\n', '', null, 'a b c d\n1 2 3', '\n\n']) assert.deepEqual(orch.parsePsList(text), am.parsePsList(text), String(text));
  const snaps = [[PW(PT_ROOT, 1, 1001), PW(200, PT_ROOT, 1100), PW(300, 200, 1200)], [PW(PT_ROOT, 1, 1001), PW(200, PT_ROOT, 1100), PW(300, 200, 2500), PW(700, 200, 900)]];
  const run = (mod) => {
    const records = new Map();
    mod.collect(records, structuredClone(snaps[0]), { rootPid: PT_ROOT, startedAt: 1000, at: 2000 });
    mod.collect(records, structuredClone(snaps[1]), { rootPid: PT_ROOT, startedAt: 1000, at: 3000, rootGone: 3000 });
    return { records: [...records], picks: mod.pickTargets(records, structuredClone(snaps[1]), { rootPid: PT_ROOT, startedAt: 1000, exclude: [300] }) };
  };
  assert.deepEqual(run(orch), run(am));
  let stopped = 0;
  for (const [platform, scenes] of [['win32', WIN_SCENES], ['linux', POSIX_SCENES]]) {
    for (const scene of scenes) {
      const a = await playScene(am, platform, scene);
      const o = await playScene(orch, platform, scene);
      assert.deepEqual(o, a, `${platform}: ${scene.name}`);
      stopped += a.result.count;
    }
  }
  assert.ok(stopped > 0, 'some scenes stop something');
});

test('orchestrator exec: cleans up after close and after a timeout, never on a spawn error', async () => {
  const { exec, cleanedText } = await import('../orchestrator/scripts/orchestrator.mjs');
  const fakeTrack = (finish) => {
    const log = [];
    const track = ({ pid, startedAt }) => {
      log.push(['track', Number.isInteger(pid), Number.isFinite(startedAt)]);
      return { start: () => log.push(['start']), finish: (opts) => { log.push(['finish', opts]); return finish(); } };
    };
    return { track, log };
  };
  const node = (code, opts) => exec(process.execPath, ['-e', code], { cwd: REPO, timeoutMs: 20000, ...opts });
  let f = fakeTrack(async () => ({ count: 2, workingSetMB: 37 }));
  let r = await node('process.stdout.write("hi")', { track: f.track });
  assert.equal(r.stdout, 'hi');
  assert.equal(r.code, 0);
  assert.deepEqual(r.cleaned, { count: 2, workingSetMB: 37 });
  assert.deepEqual(f.log, [['track', true, true], ['start'], ['finish', {}]]);
  f = fakeTrack(async () => ({ count: 2, workingSetMB: 37 }));
  r = await node('setTimeout(() => {}, 20000)', { track: f.track, timeoutMs: 100 });
  assert.equal(r.timedOut, true);
  assert.deepEqual(r.cleaned, { count: 2, workingSetMB: 37 });
  assert.equal(f.log.filter((e) => e[0] === 'finish').length, 1);
  f = fakeTrack(async () => ({ count: 2, workingSetMB: 37 }));
  r = await exec('am-no-such-command-x', [], { cwd: REPO, timeoutMs: 20000, track: f.track });
  assert.ok(r.spawnError);
  assert.deepEqual(r.cleaned, { count: 0, workingSetMB: 0 });
  assert.ok(!f.log.some((e) => e[0] === 'finish'));
  for (const finish of [async () => { throw new Error('boom'); }, () => { throw new Error('sync'); }, async () => ({ count: 'x' }), async () => null, () => new Promise(() => {})]) {
    f = fakeTrack(finish);
    r = await node('', { track: f.track, cleanupMs: 50 });
    assert.deepEqual(r.cleaned, { count: 0, workingSetMB: 0 });
  }
  r = await exec(process.execPath, ['-e', ''], { cwd: REPO, timeoutMs: 20000, track: () => { throw new Error('no tracker'); } });
  assert.deepEqual(r.cleaned, { count: 0, workingSetMB: 0 });
  r = await node('');
  assert.deepEqual(r.cleaned, { count: 0, workingSetMB: 0 });
  for (const c of [{ count: 0 }, { count: -1 }, { count: 1.5 }, { count: '2' }, undefined, {}]) assert.equal(cleanedText(c), null, JSON.stringify(c));
  assert.equal(cleanedText({ count: 2, workingSetMB: 37 }), '남은 프로세스 2개 정리 (작업 집합 합계 약 37 MB)');
});

test('run: a session\'s leftover child is stopped and reported', { skip: process.platform === 'win32' }, () => {
  const r = prepared({ plan: planOf([task('T01', 't01-a')]), scenario: { leaveChild: ['implement'] } });
  const run = r.orch('run');
  assert.equal(run.code, 0, run.out);
  assert.match(run.out, /implement: 세션이 남긴 프로세스 1개 정리/);
  assert.equal((run.out.match(/세션이 남긴 프로세스/g) || []).length, 1, run.out);
  const notes = readFileSync(path.join(r.runDir(), 'progress.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    .filter((e) => e.ev === 'note' && String(e.text).startsWith('남은 프로세스'));
  assert.equal(notes.length, 1);
  assert.equal(notes[0].stage, 'implement');
  assert.match(notes[0].text, /^남은 프로세스 1개 정리/);
  const pid = Number(readFileSync(path.join(r.repo, '.orchestrator', 'fake-left-implement.pid'), 'utf8'));
  assert.ok(Number.isInteger(pid) && pid > 0);
  assert.equal(spawnSync('ps', ['-p', String(pid)]).status, 1, 'the leftover child is gone');
});
