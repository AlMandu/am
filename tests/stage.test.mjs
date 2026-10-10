// Run: node --test tests/stage.test.mjs
// The am:auto stage runner (what each stage session may do, what it is told, how its end is read)
// and the user models module it will use.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MARKS, STAGES, claudeArgs, doKind, instructions, lastMark, main, parseResult, permissions, pluginDirFor, memoryDir, absEdit, estimateTokens, contextFiles, pickCompaction, CONTEXT_LIMIT, CONTEXT_TARGET, COMPACT_MARKS, COMPACT_MODEL, TIMEOUT_MIN, compactInstructions, compactionProblem, cmdExeArgs, interrupt, runRelay, RELAY_MS, CACHE_5M_KINDS, memorySkip, mainCheckout, otherRuns, takeLock, ownerState, GRACE_MS, POLL_MS, WAIT_MS, skillDefaults, inlineSkill, inlinePrompt, skillCall, CODEX_STAGES, SECOND_MARK, secondOpinionLines, opinionWatch, OPINION_MS, worker, WORKER_FILES, HANDOVER_OWNER, follow, stageLine, sessionEnv, stopHandedRun, DELIVERED_PREFIX, claimResult, fileState, FOLLOW_LIMIT_MS, hhmm, stillRunning } from '../plugin/scripts/stage.mjs';
import { DEFAULTS, formatEvent, pidAlive, stateLine } from '../plugin/scripts/progress.mjs';
import { readPlan } from '../plugin/hooks/handover.mjs';
import { CODEX_EFFORTS, OPINION_MODELS, USER_EFFORTS, USER_MODEL_KEYS, readUserModels, resolveOwn, resolveUser, userModelsFile } from '../plugin/scripts/user-models.mjs';
import { readUserSettings, userSettingsFile } from '../plugin/scripts/user-settings.mjs';
import { BUILTIN_MODELS, ensureUserFiles, modelsTemplate, settingsTemplate } from '../plugin/scripts/user-files.mjs';
import { RECORD_NAME, holdRecord, hostName, liveRecords, memoryShortMB, recordHeld, sessionsDirOf } from '../plugin/scripts/memory-guard.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AUTO = readFileSync(path.join(REPO, 'plugin', 'skills', 'auto', 'SKILL.md'), 'utf8');

// A fake claude: records its arguments in calls.jsonl (its FORCE_PROMPT_CACHING_5M in env.jsonl, its AM_HANDOVER_OWNER in owner.jsonl) and answers as fake.json in the working folder says.
// fake.json: { "replies": ["text of the 1st call", "text of the 2nd call"], "crash": true (writes "stderr" or boom to stderr and exits 3), "write": { "path": "content" },
//   "writes": [{ "path": "content written by the 1st call only" }, ...], "removes": [["path deleted by the 1st call only"], ...], "hang": [1] (calls that never end),
//   "delay": ms (every call answers after that long) }
const FAKE = `import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const argv = process.argv.slice(2);
appendFileSync('calls.jsonl', JSON.stringify(argv) + '\\n');
appendFileSync('env.jsonl', JSON.stringify(process.env.FORCE_PROMPT_CACHING_5M ?? null) + '\\n');
appendFileSync('owner.jsonl', JSON.stringify(process.env.AM_HANDOVER_OWNER ?? null) + '\\n');
const s = existsSync('fake.json') ? JSON.parse(readFileSync('fake.json', 'utf8')) : {};
const n = readFileSync('calls.jsonl', 'utf8').trim().split('\\n').length;
if (s.delay) await new Promise((r) => setTimeout(r, s.delay));
if ((s.hang || []).includes(n)) setTimeout(() => {}, 60000);
else {
for (const [f, t] of Object.entries({ ...s.write, ...(s.writes || [])[n - 1] })) { mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, t); }
for (const f of (s.removes || [])[n - 1] || []) rmSync(f, { force: true });
if (s.crash) { process.stderr.write(s.stderr || 'boom'); process.exit(3); }
const replies = s.replies || ['done\\nAM_STAGE: READY'];
const text = replies[Math.min(n, replies.length) - 1];
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: 'sess-1', total_cost_usd: 0.25 * n, permission_denials: n === 1 ? [{ tool_name: 'Bash', tool_input: { command: 'git push' } }] : [] }));
}
`;

function makeRepo(t, { plan, request = 'Fix the typo', fake } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'am-stage-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, '.am', 'demo'), { recursive: true });
  if (request) writeFileSync(path.join(dir, '.am', 'demo', 'request.md'), request);
  if (plan) writeFileSync(path.join(dir, '.am', 'demo', 'plan.md'), plan);
  if (fake) writeFileSync(path.join(dir, 'fake.json'), JSON.stringify(fake));
  writeFileSync(path.join(dir, 'fake-claude.mjs'), FAKE);
  return dir;
}

// An empty Claude config folder, so no test reads the user models file of this PC.
const NO_USER_CFG = mkdtempSync(path.join(os.tmpdir(), 'am-stage-nocfg-'));
after(() => rmSync(NO_USER_CFG, { recursive: true, force: true }));
const isolatedEnv = { ...process.env, CLAUDE_CONFIG_DIR: NO_USER_CFG };

async function run(dir, argv, opts = {}) {
  let text = '';
  const out = { write: (s) => (text += s) };
  const code = await main(argv, { cwd: dir, env: isolatedEnv, claude: [process.execPath, path.join(dir, 'fake-claude.mjs')], orchestrator: () => null, am: () => [], out, freeMem: () => 2 ** 50, ...opts });
  const calls = existsSync(path.join(dir, 'calls.jsonl')) ? readFileSync(path.join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  return { code, text, result: code === 0 ? JSON.parse(text) : null, calls };
}
const flag = (args, name) => args[args.indexOf(name) + 1];
/** An env with its own Claude config folder (no 5-minute cache setting from outside), holding the memory folder of dir with the given files. */
function memEnv(t, dir, files = { 'MEMORY.md': '- [a](a.md)\n' }) {
  const cfg = mkdtempSync(path.join(os.tmpdir(), 'am-stage-cfg-'));
  t.after(() => rmSync(cfg, { recursive: true, force: true }));
  const env = { ...process.env, CLAUDE_CONFIG_DIR: cfg };
  delete env.FORCE_PROMPT_CACHING_5M;
  if (files) {
    const mem = memoryDir(dir, env);
    mkdirSync(mem, { recursive: true });
    for (const [name, text] of Object.entries(files)) writeFileSync(path.join(mem, name), text);
  }
  return env;
}
const cacheEnv = (dir) => readFileSync(path.join(dir, 'env.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const ownerEnv = (dir) => readFileSync(path.join(dir, 'owner.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const SMALL = '# p\n## Summary\n- Scale: 1 implementation runs, 1 commits\n## Steps\n1. a. Check: x\n';
const LARGE = '# p\n## Summary\n- 규모: 구현 2회, 커밋 2개\n## Steps\n1. a. Check: x\n';

test('permissions: each stage gets only what it needs, push only in push mode', () => {
  const plan = permissions('plan', { amRoot: '/am' });
  assert.equal(plan.mode, 'dontAsk');
  assert.ok(plan.allow.includes('Edit(/.am/**)') && plan.allow.includes('Bash(node "/am/scripts/codex-opinion.mjs" *)'));
  assert.ok(!plan.allow.includes('Bash') && !plan.allow.includes('Edit'));
  for (const s of ['do', 'check']) {
    const p = permissions(s);
    assert.equal(p.mode, 'acceptEdits');
    for (const r of ['Bash(git commit *)', 'Bash(git push *)', 'Bash(git checkout *)', 'Bash(git reset *)', 'Bash(git stash push)', 'AskUserQuestion']) assert.ok(p.deny.includes(r), `${s}: ${r}`);
  }
  // The memory stage reads anything (the memory folder is outside the repository) and writes only under .am/.
  const mem = permissions('compactmem');
  assert.equal(mem.mode, 'dontAsk');
  assert.ok(mem.allow.includes('Read') && mem.allow.includes('Edit(/.am/**)') && mem.allow.includes('Bash(git show *)'));
  assert.ok(!mem.allow.includes('Bash') && !mem.allow.includes('Edit') && !mem.allow.some((r) => r.includes('git commit')));
  // The memory folder itself is denied, which wins over any allowance (rule form measured on Windows with claude -p).
  const cfg = path.join(os.tmpdir(), 'cfg');
  const dirOf = memoryDir(path.join(os.tmpdir(), 'My Repo'), { CLAUDE_CONFIG_DIR: cfg });
  assert.equal(dirOf, path.join(cfg, 'projects', path.resolve(os.tmpdir(), 'My Repo').replace(/[^A-Za-z0-9]/g, '-'), 'memory'));
  assert.ok(permissions('compactmem', { memDir: dirOf }).deny.includes(absEdit(dirOf)));
  if (process.platform === 'win32') assert.match(absEdit('C:\\Users\\me\\.claude\\projects\\C--x\\memory'), /^Edit\(\/\/c\/Users\/me\/\.claude\/projects\/C--x\/memory\/\*\*\)$/, 'on Windows');
  else assert.equal(absEdit('/home/me/m'), 'Edit(//home/me/m/**)');
  assert.deepEqual(MARKS.compactmem, ['PROPOSED', 'NOTHING', 'BLOCKED'], 'never stops am:auto for a question');
  const commit = permissions('commit');
  assert.ok(commit.allow.includes('Bash(git commit *)') && commit.deny.includes('Bash(git push *)') && !commit.allow.includes('Bash(git push *)'));
  const pushed = permissions('commit', { push: true });
  assert.ok(pushed.allow.includes('Bash(git push *)') && !pushed.deny.includes('Bash(git push *)'));
  // With the slug, the commit stage may also write that task's commit record, and no other file.
  assert.ok(!commit.allow.some((r) => r.startsWith('Edit')));
  const recorded = permissions('commit', { slug: 'demo' });
  assert.deepEqual(recorded.allow.filter((r) => r.startsWith('Edit')), ['Edit(/.am/demo/commits.md)', 'Edit(.am/demo/commits.md)']);
  assert.deepEqual(recorded.allow.filter((r) => !r.startsWith('Edit')), commit.allow);
  assert.deepEqual(recorded.deny, commit.deny);
  assert.match(instructions('commit', 'demo').system, /record it in \.am\/demo\/commits\.md as the skill says; that is the only file this session can write/);
  const hand = permissions('handover', { orchRoot: '/orch' });
  assert.ok(hand.allow.includes('Bash(node "/orch/scripts/orchestrator.mjs" *)') && hand.allow.includes('Bash(git merge --ff-only *)') && hand.allow.includes('Edit(/.orchestrator/**)'));
  assert.ok(!hand.allow.includes('Bash') && hand.deny.includes('Bash(git push *)'));
  // The user's answers to the run skill's Prepare questions: write the gate file and commit it, or commit or set changes aside.
  for (const r of ['Edit(/am-gate.json)', 'Bash(git add *)', 'Bash(git commit *)', 'Bash(git stash push *)']) assert.ok(hand.allow.includes(r), r);
  assert.ok(permissions('handover', { orchRoot: '/orch', push: true }).allow.includes('Bash(git push *)'));
  for (const s of [...STAGES, 'handover']) assert.ok(permissions(s).deny.includes('AskUserQuestion'), s);
  // The compaction session reads and writes only under .am/: no shell at all.
  const compact = permissions('compact');
  assert.equal(compact.mode, 'dontAsk');
  // Only the plan and memory stages may run the Codex script: of the runner's am and of every installed am, in both quote forms.
  assert.deepEqual(CODEX_STAGES, ['plan', 'compactmem']);
  for (const s of CODEX_STAGES) {
    const p = permissions(s, { amRoot: '/am', installedAm: ['/inst/a', '/inst/b', '/am'] });
    for (const root of ['/am', '/inst/a', '/inst/b']) {
      assert.ok(p.allow.includes(`Bash(node "${root}/scripts/codex-opinion.mjs" *)`) && p.allow.includes(`Bash(node ${root}/scripts/codex-opinion.mjs *)`), `${s}: ${root}`);
    }
    assert.equal(p.allow.length, new Set(p.allow).size, `${s}: no duplicate rule`);
    assert.ok(!p.allow.includes('Bash') && !p.allow.includes('Edit') && !p.allow.includes('PowerShell'), s);
  }
  for (const s of ['do', 'check', 'commit', 'handover', 'compact']) {
    const p = permissions(s, { amRoot: '/am', installedAm: ['/inst/a'], orchRoot: '/orch', slug: 'demo' });
    assert.ok(!p.allow.some((r) => r.includes('codex-opinion')), s);
  }
  assert.ok(!permissions('commit', { amRoot: '/am', installedAm: ['/inst/a'] }).allow.some((r) => r.includes('node')), 'commit runs no node script');
  assert.deepEqual(compact.allow, ['Read', 'Glob', 'Grep', 'Edit(/.am/**)', 'Edit(.am/**)']);
  assert.deepEqual(compact.deny, ['AskUserQuestion']);
  // With the slug, the request is denied in both path forms: a deny rule wins over the .am/ allowance.
  const guarded = permissions('compact', { slug: 'demo' });
  assert.deepEqual(guarded.allow, compact.allow);
  assert.deepEqual(guarded.deny, ['AskUserQuestion', 'Edit(/.am/demo/request.md)', 'Edit(.am/demo/request.md)']);
});

test('the compaction session: its own model and markers, a prompt cmd.exe can pass', () => {
  const args = claudeArgs(permissions('compact'), { prompt: 'x', systemFile: 's.md', model: COMPACT_MODEL });
  assert.equal(flag(args, '--model'), COMPACT_MODEL.model);
  assert.equal(flag(args, '--effort'), COMPACT_MODEL.effort);
  assert.equal(TIMEOUT_MIN.compact, 15);
  assert.deepEqual(COMPACT_MARKS, ['COMPACTED', 'BLOCKED']);
  // Its markers never reach am:auto as a stage status.
  assert.ok(!Object.keys(MARKS).includes('compact') && !Object.values(MARKS).flat().includes('COMPACTED'));
  const { prompt, system } = compactInstructions('demo', [{ file: '.am/demo/plan.md', size: 14000, goal: 7000 }]);
  assert.ok(!/["%]/.test(prompt), prompt);
  assert.match(system, /- \.am\/demo\/plan\.md: about 14000 tokens now; bring it to about 7000 tokens\./);
  for (const keep of ['규모: 구현 N회, 커밋 M개', '(done) or (완료)', '(auto-decided), (자동 결정)', '(자동 결정), (second opinion…), or the user\'s answer', '(자동 결정), (second opinion, and the word OPEN', 'marked OPEN, in full', 'AM_STAGE: COMPACTED', 'AM_STAGE: BLOCKED', 'never use a question tool', 'Never change .am/demo/request.md: it is the user\'s request in their own words', 'if the runner finds it changed it puts everything back']) assert.ok(system.includes(keep), keep);
});

test('instructions: slash call of the stage skill, unattended rules written out in every stage', () => {
  // Also when plan.md exists: a plan session that stopped with a question may have left only the card.
  assert.equal(instructions('plan', 'demo').prompt, '/am:plan Read the request in .am/demo/request.md (slug demo)');
  assert.match(instructions('plan', 'demo').system, /If \.am\/demo\/plan\.md already exists[^\n]*continue that plan/);
  assert.equal(instructions('do', 'demo').prompt, '/am:do demo');
  assert.equal(instructions('check', 'demo').prompt, '/am:check demo');
  assert.equal(instructions('compactmem', 'demo').prompt, '/am:compactmem demo');
  assert.match(instructions('compactmem', 'demo').system, /write the proposal to \.am\/demo\/compactmem\.md and stop there\. Never change, create or delete a file in the memory folder/);
  assert.match(instructions('compactmem', 'demo', { memDir: '/m' }).system, /The memory folder of this project is \/m, unless your system prompt names another one/);
  assert.match(instructions('compactmem', 'demo').system, /never end with AM_STAGE: NEEDS_DECISION here/);
  assert.equal(instructions('commit', 'demo').prompt, '/am:commit');
  assert.equal(instructions('commit', 'demo', { push: true }).prompt, '/am:commit push');
  assert.equal(instructions('handover', 'demo').prompt, '/am-orchestrator:run .am/demo/plan.md');
  assert.equal(instructions('handover', 'demo', { resume: true }).prompt, '/am-orchestrator:run');
  const oneCommand = '- Run each shell command as its own call: one command per call, no echo, no pipes.';
  for (const s of [...STAGES, 'handover']) {
    const { system } = instructions(s, 'demo');
    // The same rules as am:auto's "Running without stops" (user decision: a copy written for stage sessions, kept in step by this test).
    assert.match(system, /the mark \(auto-decided\), translated into the plan's language \(\(자동 결정\) in a Korean plan\)/, s);
    for (const stop of ['delete user data or files that existed before this run, change a saved-data format, or migrate data', 'change anything outside this repository (other folders, external services, installed packages)', "the user's or the project's instructions say it needs confirmation", 'the two reviewers of a technical choice still split on it after their rounds']) assert.ok(system.includes(stop), `${s}: ${stop}`);
    assert.match(system, /marked OPEN[\s\S]*AM_STAGE: NEEDS_DECISION/, s);
    for (const m of MARKS[s]) assert.ok(system.includes(`AM_STAGE: ${m}`), `${s}: ${m}`);
    // Every stage kind gets the one-command line, once: the permission rules of most stages match one plain command only.
    assert.ok(system.includes(`\n${oneCommand}\n`), `${s}: one command per call`);
    assert.equal(system.split(oneCommand).length, 2, `${s}: one command per call, once`);
  }
  // The compaction session has no shell tool, so it does not get that line.
  assert.ok(!compactInstructions('demo', [{ file: '.am/demo/plan.md', size: 14000, goal: 7000 }]).system.includes(oneCommand));
  // The same mark rule in am:auto (with code marks there).
  assert.match(AUTO, /the mark `\(auto-decided\)` translated into the plan's language \(`\(자동 결정\)` in a Korean plan\)/);
  // The same stop list in am:auto. Two of its stops are left out on purpose: the run skill's Prepare questions
  // only reach the handover stage, whose rules name them on their own ("any question of its Prepare step, are stops");
  // an empty request, an unclear push keyword, an unreadable skill file and BLOCK after the retry belong to the
  // session running am:auto, so a stage session has them as "this stage cannot finish" or "the request cannot be planned".
  for (const stop of ['delete user data or files that existed before this run, change a saved-data format, or migrate data', 'change anything outside this repository (other folders, external services, installed packages)', "The user's or project's instructions say the next action needs confirmation", 'The two reviewers of a technical choice still split on it after their rounds']) assert.ok(AUTO.includes(stop), stop);
  // Through cmd.exe (claude.cmd) only the unquoted rules for node scripts survive; those sessions are told the form.
  assert.match(instructions('handover', 'demo', { unquoted: true }).system, /Run node scripts with the path unquoted/);
  assert.doesNotMatch(instructions('handover', 'demo').system, /path unquoted/);
  for (const s of ['plan', 'compactmem']) assert.match(instructions(s, 'demo', { unquoted: true }).system, /Run node scripts with the path unquoted/, s);
  for (const s of ['check', 'commit', 'do']) assert.doesNotMatch(instructions(s, 'demo', { unquoted: true }).system, /path unquoted/, s);
  // The memory stage may run the Codex second opinion of the am:compactmem skill's rules.
  assert.match(instructions('compactmem', 'demo').system, /run read-only git commands \(including git show\) and the Codex second-opinion command of the skill's rules\./);
  assert.match(instructions('plan', 'demo').system, /`Scale: N implementation runs, M commits` \(`규모: 구현 N회, 커밋 M개` in a Korean plan\)/);
  // The size of one implementation run, word for word as in am:auto.
  const oneRun = AUTO.match(/One implementation run is [^\n]*? separately\./);
  assert.ok(oneRun, 'am:auto defines one implementation run');
  assert.ok(instructions('plan', 'demo').system.includes(oneRun[0]), oneRun[0]);
  assert.match(instructions('do', 'demo').system, /do not use the am:check skill/);
  assert.match(instructions('do', 'demo', { fix: true }).system, /Read \.am\/demo\/check\.md first and fix only the causes it reports/);
  assert.match(instructions('handover', 'demo', { push: true }).system, /`git merge --ff-only <run\.branch>` and `git branch -d <run\.branch>`[\s\S]*push the start branch/);
  assert.match(instructions('handover', 'demo').system, /Do not push\./);
  // The same run fields as the hand-over items of am:auto's step 7.
  for (const resume of [true, false]) assert.ok(instructions('handover', 'demo', { resume }).system.includes('every line of `autoDecided` and `secondOpinions`'), `resume ${resume}`);
});

test('doKind: hand over a large new plan only when the run skill is installed', () => {
  const orch = () => '/orch';
  assert.deepEqual(doKind(SMALL, { orchestrator: orch }), { kind: 'do' });
  assert.deepEqual(doKind(LARGE, { orchestrator: () => null }), { kind: 'do' });
  assert.deepEqual(doKind(LARGE, { orchestrator: orch }), { kind: 'handover', resume: false, orchRoot: '/orch' });
  assert.deepEqual(doKind(LARGE.replace('1. a.', '1. a. (완료)'), { orchestrator: orch }), { kind: 'do' });
  const handed = `${LARGE}## 변경 기록\n- am-orchestrator run 스킬로 넘김, run.id 20261007-1200, 시작 브랜치 main\n`;
  assert.deepEqual(doKind(handed, { orchestrator: orch }), { kind: 'handover', resume: true, orchRoot: '/orch' });
  // A plan implemented here that only mentions the orchestrator and a run ID, and a fix after am:check, stay with am:do.
  assert.deepEqual(doKind(handed.replace('1. a.', '1. a. (done)'), { orchestrator: orch }), { kind: 'do' });
  assert.deepEqual(doKind(handed, { orchestrator: orch, fix: true }), { kind: 'do' });
  assert.match(doKind('# p\n## Steps\n1. a\n', { orchestrator: orch }).error, /no Scale line/);
  // A step that names the hand-over test file and run ID field is not a hand-over: a small plan stays with am:do.
  const mention = SMALL.replace('1. a. Check: x\n', '1. a. Check: x\n2. `tests/orchestrator-skill.test.mjs`: pin that the am:auto hand-over line carries `run.id`. Check: y\n');
  assert.deepEqual(doKind(`${mention}## Change log\n`, { orchestrator: orch }), { kind: 'do' });
});

test('am:auto and the hand-over stage log the same fixed hand-over line, and readPlan reads it', () => {
  const LINE = /`(- Hand-over: [^`\n]+)`/;
  const fromAuto = LINE.exec(AUTO);
  const fromStage = LINE.exec(instructions('handover', 'demo').system);
  assert.ok(fromAuto && fromStage, 'both name the hand-over line');
  assert.equal(fromStage[1], fromAuto[1]);
  const filled = fromAuto[1].replace('<run.id>', '20261008-0900').replace('<branch>', 'main');
  assert.doesNotMatch(filled, /[<>]/);
  assert.equal(readPlan(`${LARGE}## Change log\n${filled}\n`).handedOver, true);
  assert.equal(readPlan(`${LARGE}## 변경 기록\n${filled} (5 tasks)\n`).handedOver, true);
  for (const text of [AUTO, instructions('handover', 'demo').system]) {
    assert.match(text, /in English whatever the plan's language/);
    assert.match(text, /\(a stop reason[^)]*\) starts with `Hand-over:`/);
    // The orchestrator's split ends with exit code 4 while it still runs: called again before the run ID is read.
    const still = /`split` ends with exit code 4, it is still running: run `split` again with no argument until it ends with another code, before you read `run\.id`/i.exec(text);
    assert.ok(still, 'split exit code 4 is followed on');
    assert.ok(still.index < text.indexOf('has made the run'), 'before the run ID is read');
  }
});

test('context size: estimate, files per stage, and which files to shorten', () => {
  assert.equal(estimateTokens('abcdefgh'), 2);
  assert.equal(estimateTokens('abcde'), 2, 'rounded up');
  assert.equal(estimateTokens('한국어 계획'), 6, 'one token per non-ASCII character, plus the space');
  assert.equal(estimateTokens(''), 0);
  assert.deepEqual(contextFiles('plan'), [], 'nothing is shortened before the plan stage: not the request, not a plan a hand-over may pass on');
  assert.deepEqual(contextFiles('do'), ['plan.md']);
  assert.deepEqual(contextFiles('do', { fix: true }), ['plan.md', 'check.md']);
  assert.deepEqual(contextFiles('handover'), [], 'the orchestrator copies the handed plan.md whole');
  assert.deepEqual(contextFiles('check'), ['plan.md']);
  for (const k of ['compactmem', 'commit']) assert.deepEqual(contextFiles(k), ['plan.md', 'check.md']);
  assert.equal(CONTEXT_LIMIT, 13000);
  assert.equal(CONTEXT_TARGET, 8500);
  assert.deepEqual(pickCompaction({ 'plan.md': 13000 }), { files: [], budget: 0 }, 'at the limit nothing is shortened');
  assert.deepEqual(pickCompaction({ 'plan.md': 12000, 'check.md': 1001 }), { files: ['plan.md'], budget: 7499 });
  // The largest first, until what is left as it is holds at most half the target (4,250).
  assert.deepEqual(pickCompaction({ 'check.md': 6000, 'plan.md': 9000 }), { files: ['plan.md', 'check.md'], budget: 8500 });
  assert.deepEqual(pickCompaction({ 'check.md': 3000, 'plan.md': 11000 }), { files: ['plan.md'], budget: 5500 });
});

test('reading the end: result object, marker line, claude arguments', () => {
  assert.equal(parseResult('[{"type":"system"},{"type":"result","result":"x"}]').result, 'x');
  assert.equal(parseResult('noise\n{"type":"result","result":"y"}').result, 'y');
  assert.equal(parseResult(''), null);
  assert.equal(lastMark('AM_STAGE: DONE\nlater **AM_STAGE: BLOCKED**', MARKS.do), 'BLOCKED');
  assert.equal(lastMark('AM_STAGE: COMMITTED', MARKS.do), null);
  const args = claudeArgs(permissions('check'), { prompt: '/am:check demo', systemFile: '.am/demo/stage-check.system.md' });
  assert.deepEqual(args.slice(0, 6), ['-p', '/am:check demo', '--output-format', 'json', '--permission-mode', 'acceptEdits']);
  assert.equal(flag(args, '--append-system-prompt-file'), '.am/demo/stage-check.system.md');
  // The slash call carries the skill's own model and effort; a flag could fight it.
  assert.ok(!args.includes('--model') && !args.includes('--effort'));
  const again = claudeArgs(permissions('check'), { prompt: 'x', resume: 'sess-1', pluginDir: '/dev/am' });
  assert.equal(flag(again, '--resume'), 'sess-1');
  assert.equal(flag(again, '--plugin-dir'), '/dev/am');
  assert.ok(!again.includes('--append-system-prompt-file'));
  assert.ok(!args.includes('--plugin-dir'));
  // An installed copy lives in the plugin cache; any other copy was loaded with --plugin-dir and is passed on.
  const env = { CLAUDE_CONFIG_DIR: path.join(os.tmpdir(), 'cfg') };
  assert.equal(pluginDirFor(path.join(env.CLAUDE_CONFIG_DIR, 'plugins', 'cache', 'am-workflow', 'am', '0.1.14'), env), '');
  assert.equal(pluginDirFor(path.join(REPO, 'plugin'), env), path.join(REPO, 'plugin'));
});

test('a plan stage runs one session and reports its marker, cost, reply and refusals', async (t) => {
  const dir = makeRepo(t, { fake: { replies: ['Planned.\nAM_STAGE: READY'], write: { '.am/demo/plan.md': SMALL } } });
  const { code, result, calls } = await run(dir, ['plan', 'demo']);
  assert.equal(code, 0);
  assert.deepEqual({ ...result, reply: !!result.reply }, { stage: 'plan', slug: 'demo', status: 'READY', reason: '', costUsd: 0.25, sessionId: 'sess-1', reply: true, denied: ['Bash: git push'], compacted: null });
  assert.equal(calls.length, 1);
  assert.equal(flag(calls[0], '-p'), '/am:plan Read the request in .am/demo/request.md (slug demo)');
  assert.match(readFileSync(path.join(dir, flag(calls[0], '--append-system-prompt-file')), 'utf8'), /This is the plan stage/);
  assert.match(readFileSync(path.join(dir, result.reply), 'utf8'), /Planned\./);
  // The session runs the same am copy as this script (here a development copy outside the plugin cache).
  assert.equal(flag(calls[0], '--plugin-dir'), path.join(REPO, 'plugin'));
  // am:plan adds .am/.gitignore only when it creates .am/, which the am:auto session already did.
  assert.equal(readFileSync(path.join(dir, '.am', '.gitignore'), 'utf8'), '*\n');
});

test('a plan stage that says READY without saving plan.md is asked once to save it', async (t) => {
  // The first call writes nothing, the second saves the plan.
  const saved = makeRepo(t, { fake: { replies: ['Planned.\nAM_STAGE: READY', 'Saved.\nAM_STAGE: READY'], writes: [{}, { '.am/demo/plan.md': 'x' }] } });
  const r1 = await run(saved, ['plan', 'demo']);
  assert.equal(r1.result.status, 'READY');
  assert.match(flag(r1.calls[1], '-p'), /^The plan was not saved: \.am\/demo\/plan\.md does not exist/);
  assert.equal(flag(r1.calls[1], '--resume'), 'sess-1');
  const lost = makeRepo(t, { fake: { replies: ['Planned.\nAM_STAGE: READY'] } });
  const r2 = await run(lost, ['plan', 'demo']);
  assert.equal(r2.result.status, 'failed');
  assert.match(r2.result.reason, /plan\.md was not saved/);
});

test('a missing marker is asked for once in the same session', async (t) => {
  const dir = makeRepo(t, { plan: SMALL, fake: { replies: ['Implemented.', 'AM_STAGE: DONE'] } });
  const { result, calls } = await run(dir, ['do', 'demo']);
  assert.equal(result.status, 'DONE');
  assert.equal(result.costUsd, 0.5);
  assert.equal(calls.length, 2);
  assert.equal(flag(calls[1], '--resume'), 'sess-1');
  const none = makeRepo(t, { plan: SMALL, fake: { replies: ['Implemented.', 'still no marker'] } });
  const r2 = await run(none, ['do', 'demo']);
  assert.equal(r2.result.status, 'failed');
  assert.match(r2.result.reason, /without an AM_STAGE line/);
});

test('the memory stage runs between check and commit and reports PROPOSED or NOTHING', async (t) => {
  assert.deepEqual(STAGES, ['plan', 'do', 'check', 'compactmem', 'commit']);
  const dir = makeRepo(t, { plan: SMALL, fake: { replies: ['Proposal saved.\nAM_STAGE: PROPOSED'] } });
  const { result, calls } = await run(dir, ['compactmem', 'demo'], { env: memEnv(t, dir) });
  assert.equal(result.stage, 'compactmem');
  assert.equal(result.status, 'PROPOSED');
  assert.equal(flag(calls[0], '-p'), '/am:compactmem demo');
  assert.equal(flag(calls[0], '--permission-mode'), 'dontAsk');
  const none = makeRepo(t, { plan: SMALL, fake: { replies: ['No memory.\nAM_STAGE: NOTHING'] } });
  const r2 = await run(none, ['compactmem', 'demo'], { env: memEnv(t, none) });
  assert.equal(r2.result.status, 'NOTHING');
  assert.equal(r2.calls.length, 1);
});

test('the memory stage starts no session when the memory folder has no memory file', async (t) => {
  const lines = (dir) => readFileSync(path.join(dir, '.am', 'demo', 'progress.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  // No memory folder, and an empty one (a non-.md file does not count).
  for (const files of [null, {}, { 'notes.txt': 'x' }]) {
    const dir = makeRepo(t, { plan: SMALL, fake: { replies: ['AM_STAGE: PROPOSED'] } });
    const env = memEnv(t, dir, files);
    const { result, calls } = await run(dir, ['compactmem', 'demo'], { env });
    assert.equal(calls.length, 0, JSON.stringify(files));
    assert.equal(result.status, 'NOTHING');
    assert.equal(result.costUsd, 0);
    assert.equal(result.reason, `no memory file in ${memoryDir(dir, env)}: the memory stage was skipped without a session`);
    assert.equal(memorySkip(dir, env), result.reason);
    assert.equal(readFileSync(path.join(dir, '.am', 'demo', 'compactmem.md'), 'utf8'), `${result.reason}\n`);
    const end = lines(dir).at(-1);
    assert.deepEqual([end.ev, end.status, end.text], ['end', 'NOTHING', result.reason.slice(0, 200)]);
  }
  // An earlier proposal stays in front of the new line.
  const kept = makeRepo(t, { plan: SMALL });
  writeFileSync(path.join(kept, '.am', 'demo', 'compactmem.md'), '# Earlier proposal');
  const { result } = await run(kept, ['compactmem', 'demo'], { env: memEnv(t, kept, null) });
  assert.equal(readFileSync(path.join(kept, '.am', 'demo', 'compactmem.md'), 'utf8'), `# Earlier proposal\n${result.reason}\n`);
});

test('the memory stage still runs when a settings file may move the memory folder', async (t) => {
  for (const where of ['user', 'project', 'local']) {
    const dir = makeRepo(t, { plan: SMALL, fake: { replies: ['AM_STAGE: NOTHING'] } });
    const env = memEnv(t, dir, {});
    const file = { user: path.join(env.CLAUDE_CONFIG_DIR, 'settings.json'), project: path.join(dir, '.claude', 'settings.json'), local: path.join(dir, '.claude', 'settings.local.json') }[where];
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '{ "autoMemoryDirectory": "D:/mem" }');
    const { result, calls } = await run(dir, ['compactmem', 'demo'], { env });
    assert.equal(calls.length, 1, where);
    assert.equal(result.status, 'NOTHING');
    assert.ok(!existsSync(path.join(dir, '.am', 'demo', 'compactmem.md')), where);
  }
  // A settings file without that key changes nothing.
  const dir = makeRepo(t, { plan: SMALL });
  const env = memEnv(t, dir, null);
  writeFileSync(path.join(env.CLAUDE_CONFIG_DIR, 'settings.json'), '{ "model": "opus" }');
  assert.match(memorySkip(dir, env), /^no memory file in /);
});

test('in a git worktree the memory stage also looks at the main checkout, which shares its memory folder', (t) => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'am-stage-git-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const main = realpathSync.native(base);
  const wt = path.join(main, 'wt');
  const git = (...args) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: main, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  };
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  git('worktree', 'add', '-q', wt);
  assert.equal(mainCheckout(wt, process.env), main);
  assert.equal(mainCheckout(main, process.env), main);
  assert.equal(mainCheckout(os.tmpdir(), process.env), '', 'outside a repository');
  // Memory only in the main checkout's folder: the worktree runs the session.
  const env = memEnv(t, main);
  assert.equal(memorySkip(wt, env), null);
  // The main checkout's untracked local settings may move the folder.
  const empty = memEnv(t, main, null);
  assert.equal(memorySkip(wt, empty), `no memory file in ${memoryDir(wt, empty)} or ${memoryDir(main, empty)}: the memory stage was skipped without a session`);
  mkdirSync(path.join(main, '.claude'), { recursive: true });
  writeFileSync(path.join(main, '.claude', 'settings.local.json'), '{ "autoMemoryDirectory": "D:/mem" }');
  assert.equal(memorySkip(wt, empty), null);
});

test('mainCheckout: when git cannot tell, the memory stage runs its session', () => {
  const fake = (r) => () => ({ status: 0, stdout: '', stderr: '', ...r });
  const abs = path.resolve('/repo/.git');
  assert.equal(mainCheckout('.', process.env, fake({ stdout: `${abs}\n` })), path.resolve('/repo'));
  // A git before 2.31 echoes the unknown --path-format back and prints a relative path.
  assert.equal(mainCheckout('.', process.env, fake({ stdout: '--path-format=absolute\n../.git\n' })), null);
  assert.equal(mainCheckout('.', process.env, fake({ stdout: '../.git\n' })), null);
  assert.equal(mainCheckout('.', process.env, fake({ status: 1, stdout: `${abs}\n` })), null);
  assert.equal(mainCheckout('.', process.env, fake({ error: new Error('ENOENT') })), null);
  assert.equal(mainCheckout('.', process.env, fake({ stdout: path.resolve('/repo/.git/modules/sub') })), null, 'a submodule');
  assert.equal(mainCheckout('.', process.env, fake({ status: 128, stderr: 'fatal: not a git repository' })), '');
});

test('the do stage becomes a hand-over for a large plan, with push only in push mode', async (t) => {
  const dir = makeRepo(t, { plan: LARGE, fake: { replies: ['Run done.\nAM_STAGE: HANDED'] } });
  const { result, calls } = await run(dir, ['do', 'demo', '--push'], { orchestrator: () => '/orch' });
  assert.equal(result.stage, 'handover');
  assert.equal(result.status, 'HANDED');
  assert.equal(flag(calls[0], '-p'), '/am-orchestrator:run .am/demo/plan.md');
  assert.equal(flag(calls[0], '--permission-mode'), 'dontAsk');
  assert.ok(flag(calls[0], '--allowedTools').includes('Bash(git push *)'));
  // A plan that records a hand-over, but no run skill: nothing is started.
  const lost = makeRepo(t, { plan: `${LARGE}## Change log\n- Hand-over: am-orchestrator run skill, run 20261007-1200, start branch main\n` });
  const r2 = await run(lost, ['do', 'demo']);
  assert.equal(r2.result.status, 'failed');
  assert.match(r2.result.reason, /not installed/);
  assert.equal(r2.calls.length, 0);
});

test('failures: no claude command is `unavailable`, a crash is `failed`, bad input exits 1', async (t) => {
  const dir = makeRepo(t, { plan: SMALL });
  const gone = await run(dir, ['check', 'demo'], { claude: [path.join(dir, 'no-such-claude-binary')] });
  assert.equal(gone.result.status, 'unavailable');
  const crash = makeRepo(t, { plan: SMALL, fake: { crash: true } });
  const r = await run(crash, ['check', 'demo']);
  assert.equal(r.result.status, 'failed');
  assert.match(r.result.reason, /unreadable output \(exit 3\): boom/);
  assert.equal((await run(dir, ['ship', 'demo'])).code, 1);
  assert.equal((await run(dir, ['do', '../x'])).code, 1);
  assert.equal((await run(dir, ['do', 'demo', '--force'])).code, 1);
  // A missing plan or request is a result am:auto acts on, not a usage error.
  const noPlan = await run(dir, ['do', 'other']);
  assert.equal(noPlan.code, 0);
  assert.match(noPlan.result.reason, /no \.am\/other\/plan\.md/);
  const noRequest = await run(makeRepo(t, { request: null }), ['plan', 'demo']);
  assert.equal(noRequest.result.status, 'failed');
  assert.match(noRequest.result.reason, /no \.am\/demo\/request\.md/);
  assert.equal(noRequest.calls.length, 0);
});

test('a session over its time limit is stopped and reported', async (t) => {
  const dir = makeRepo(t, { plan: SMALL, fake: { hang: [1] } });
  const { result } = await run(dir, ['check', 'demo'], { timeoutMin: { check: 0.005 } });
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /no end within/);
});

test('limits given in part are filled from the defaults', async (t) => {
  for (const timeoutMin of [{}, { compact: 1 }, { check: undefined }, { check: null }]) {
    const dir = makeRepo(t, { plan: SMALL, fake: { replies: ['AM_STAGE: NOTE'] } });
    const { result } = await run(dir, ['check', 'demo'], { timeoutMin });
    assert.equal(result.status, 'NOTE', JSON.stringify(timeoutMin));
  }
  // The compaction session gets the filled limits too, not the caller's object.
  const dir = makeRepo(t, { plan: BIG, fake: { replies: ['AM_STAGE: COMPACTED', 'AM_STAGE: DONE'], writes: [{ '.am/demo/plan.md': SHORT }] } });
  const { result } = await run(dir, ['do', 'demo'], { timeoutMin: { do: 1 } });
  assert.equal(result.status, 'DONE');
  assert.deepEqual(result.compacted.originals, ['.am/demo/plan.orig-1.md']);
});

// A Korean plan of about 15,700 estimated tokens, and the same plan shortened.
const FILLER = '설명 문장입니다. '.repeat(2000);
const SHORT = '# p\n## 요약\n- 규모: 구현 1회, 커밋 1개\n## 결정\n- 범위 (자동 결정)\n## 단계\n1. a. Check: x (완료)\n2. b. Check: y\n## 변경 기록\n';
const BIG = SHORT.replace('## 결정', `- ${FILLER}\n## 결정`);
const plan = (dir) => readFileSync(path.join(dir, '.am', 'demo', 'plan.md'), 'utf8');
const request = (dir) => readFileSync(path.join(dir, '.am', 'demo', 'request.md'), 'utf8');

test('task files above the limit are shortened in a session of their own before the stage, with the original kept', async (t) => {
  const dir = makeRepo(t, { plan: BIG, fake: { replies: ['Shortened.\nAM_STAGE: COMPACTED', 'Implemented.\nAM_STAGE: DONE'], writes: [{ '.am/demo/plan.md': SHORT }] } });
  const { result, calls } = await run(dir, ['do', 'demo']);
  assert.equal(result.status, 'DONE');
  assert.equal(calls.length, 2);
  // The compaction session: its own prompt, system file, model and permissions.
  assert.match(flag(calls[0], '-p'), /^Shorten the task files of \.am\/demo\//);
  assert.equal(flag(calls[0], '--append-system-prompt-file'), '.am/demo/stage-compact.system.md');
  assert.equal(flag(calls[0], '--model'), 'opus');
  assert.equal(flag(calls[0], '--allowedTools'), 'Read,Glob,Grep,Edit(/.am/**),Edit(.am/**)');
  assert.equal(flag(calls[1], '-p'), '/am:do demo');
  assert.ok(!calls[1].includes('--model'));
  assert.equal(plan(dir), SHORT);
  assert.equal(readFileSync(path.join(dir, '.am', 'demo', 'plan.orig-1.md'), 'utf8'), BIG);
  assert.deepEqual(result.compacted, { files: ['.am/demo/plan.md'], before: estimateTokens(BIG), after: estimateTokens(SHORT), originals: ['.am/demo/plan.orig-1.md'] });
  assert.ok(result.compacted.before > CONTEXT_LIMIT);
  assert.match(readFileSync(path.join(dir, '.am', 'demo', 'stage-do.system.md'), 'utf8'), /shortened \.am\/demo\/plan\.md to keep this context small; the originals are \.am\/demo\/plan\.orig-1\.md\. Open an original only when/);
  assert.equal(result.costUsd, 0.75, 'the compaction session (0.25) and the stage session (0.5)');
});

test('a second compaction keeps the first original and writes the next number', async (t) => {
  const dir = makeRepo(t, { plan: BIG, fake: { replies: ['AM_STAGE: COMPACTED', 'AM_STAGE: NOTE'], writes: [{ '.am/demo/plan.md': SHORT }] } });
  writeFileSync(path.join(dir, '.am', 'demo', 'plan.orig-1.md'), 'first original');
  const { result } = await run(dir, ['check', 'demo']);
  assert.deepEqual(result.compacted.originals, ['.am/demo/plan.orig-2.md']);
  assert.equal(readFileSync(path.join(dir, '.am', 'demo', 'plan.orig-1.md'), 'utf8'), 'first original');
  assert.equal(readFileSync(path.join(dir, '.am', 'demo', 'plan.orig-2.md'), 'utf8'), BIG);
});

test('a compaction that breaks the plan, ends without its marker or runs over time is undone and the stage goes on', async (t) => {
  const cases = [
    [{ replies: ['AM_STAGE: COMPACTED', 'AM_STAGE: DONE'], writes: [{ '.am/demo/plan.md': SHORT.replace('구현 1회', '구현 2회') }] }, /Scale line/],
    [{ replies: ['AM_STAGE: COMPACTED', 'AM_STAGE: DONE'], writes: [{ '.am/demo/plan.md': SHORT.replace(' (완료)', '') }] }, /Scale line, done marks/],
    [{ replies: ['AM_STAGE: COMPACTED', 'AM_STAGE: DONE'], writes: [{ '.am/demo/plan.md': SHORT.replace(' (자동 결정)', '') }] }, /auto-decided marks 1 -> 0/],
    [{ replies: ['AM_STAGE: COMPACTED', 'AM_STAGE: DONE'], writes: [{ '.am/demo/plan.md': SHORT.replace('## 변경 기록\n', '') }] }, /heading lost: ## 변경 기록/],
    [{ replies: ['AM_STAGE: COMPACTED', 'AM_STAGE: DONE'], writes: [{ '.am/demo/plan.md': `${SHORT}${FILLER}` }] }, /still about \d+ tokens, above 13000/],
    [{ replies: ['Shortened.', 'AM_STAGE: DONE'], writes: [{ '.am/demo/plan.md': SHORT }] }, /without an AM_STAGE line/],
    [{ replies: ['AM_STAGE: BLOCKED', 'AM_STAGE: DONE'] }, /said BLOCKED/],
    // A well shortened plan, but the request was touched too: the whole compaction is undone.
    [{ replies: ['AM_STAGE: COMPACTED', 'AM_STAGE: DONE'], writes: [{ '.am/demo/plan.md': SHORT, '.am/demo/request.md': 'Fix it' }] }, /request\.md was changed/],
    [{ replies: ['AM_STAGE: COMPACTED', 'AM_STAGE: DONE'], writes: [{ '.am/demo/plan.md': SHORT, '.am/demo/request.md': '' }] }, /request\.md was changed/],
    [{ replies: ['AM_STAGE: COMPACTED', 'AM_STAGE: DONE'], writes: [{ '.am/demo/plan.md': SHORT }], removes: [['.am/demo/request.md']] }, /request\.md was changed/],
    // Whatever the failure was, a touched request is put back.
    [{ replies: ['AM_STAGE: BLOCKED', 'AM_STAGE: DONE'], writes: [{ '.am/demo/request.md': 'Fix it' }] }, /said BLOCKED/],
  ];
  for (const [fake, why] of cases) {
    const dir = makeRepo(t, { plan: BIG, fake });
    const { result, calls } = await run(dir, ['do', 'demo']);
    assert.equal(result.status, 'DONE', String(why));
    assert.deepEqual(Object.keys(result.compacted), ['files', 'failed']);
    assert.match(result.compacted.failed, why);
    assert.equal(plan(dir), BIG, `original back: ${why}`);
    assert.equal(request(dir), 'Fix the typo', `request as it was: ${why}`);
    assert.ok(!existsSync(path.join(dir, '.am', 'demo', 'plan.orig-1.md')), `copy removed: ${why}`);
    assert.doesNotMatch(readFileSync(path.join(dir, '.am', 'demo', 'stage-do.system.md'), 'utf8'), /shortened/);
    assert.equal(calls.length, 2);
  }
  const slow = makeRepo(t, { plan: BIG, fake: { hang: [1], replies: ['', 'AM_STAGE: DONE'] } });
  const { result } = await run(slow, ['do', 'demo'], { timeoutMin: { compact: 0.005 } });
  assert.equal(result.status, 'DONE');
  assert.match(result.compacted.failed, /no end within/);
  assert.equal(plan(slow), BIG);
});

test('the plan stage starts no compaction session: neither a long request nor a large plan is shortened', async (t) => {
  // A large plan.md is there when the plan stage runs again, after a question was answered.
  for (const planText of [undefined, SMALL, BIG]) {
    const dir = makeRepo(t, { plan: planText, request: FILLER, fake: { replies: ['Planned.\nAM_STAGE: READY'], write: planText ? {} : { '.am/demo/plan.md': SMALL } } });
    assert.ok(estimateTokens(FILLER) > CONTEXT_LIMIT);
    const { result, calls } = await run(dir, ['plan', 'demo']);
    assert.equal(result.status, 'READY');
    assert.equal(calls.length, 1);
    assert.equal(flag(calls[0], '-p'), '/am:plan Read the request in .am/demo/request.md (slug demo)');
    assert.equal(result.compacted, null);
    assert.equal(request(dir), FILLER);
    assert.equal(plan(dir), planText || SMALL, 'the plan is as the plan session left it');
    for (const name of ['request.orig-1.md', 'plan.orig-1.md', 'stage-compact.system.md']) assert.ok(!existsSync(path.join(dir, '.am', 'demo', name)), name);
  }
});

test('before a later stage a large plan is shortened with the request denied to the compaction session', async (t) => {
  const dir = makeRepo(t, { plan: BIG, request: FILLER, fake: { replies: ['AM_STAGE: COMPACTED', 'Implemented.\nAM_STAGE: DONE'], writes: [{ '.am/demo/plan.md': SHORT }] } });
  const { result, calls } = await run(dir, ['do', 'demo']);
  assert.equal(result.status, 'DONE');
  assert.equal(calls.length, 2);
  assert.equal(flag(calls[0], '--disallowedTools'), 'AskUserQuestion,Edit(/.am/demo/request.md),Edit(.am/demo/request.md)');
  assert.deepEqual(result.compacted, { files: ['.am/demo/plan.md'], before: estimateTokens(BIG), after: estimateTokens(SHORT), originals: ['.am/demo/plan.orig-1.md'] });
  assert.equal(plan(dir), SHORT);
  assert.equal(request(dir), FILLER);
  assert.ok(!existsSync(path.join(dir, '.am', 'demo', 'request.orig-1.md')));
  // The system prompt of the compaction session names plan.md only as a file to shorten.
  assert.doesNotMatch(readFileSync(path.join(dir, '.am', 'demo', 'stage-compact.system.md'), 'utf8'), /^- \.am\/demo\/request\.md: about/m);
});

test('a request file the compaction session created is removed again', async (t) => {
  const dir = makeRepo(t, { plan: BIG, request: null, fake: { replies: ['AM_STAGE: COMPACTED', 'AM_STAGE: DONE'], writes: [{ '.am/demo/plan.md': SHORT, '.am/demo/request.md': 'new' }] } });
  const { result } = await run(dir, ['do', 'demo']);
  assert.equal(result.status, 'DONE');
  assert.match(result.compacted.failed, /request\.md was changed/);
  assert.equal(plan(dir), BIG);
  assert.ok(!existsSync(path.join(dir, '.am', 'demo', 'request.md')));
});

test('within the limit no compaction session runs', async (t) => {
  const dir = makeRepo(t, { plan: SMALL, fake: { replies: ['AM_STAGE: DONE'] } });
  const { result, calls } = await run(dir, ['do', 'demo']);
  assert.equal(calls.length, 1);
  assert.equal(result.compacted, null);
  assert.ok(!existsSync(path.join(dir, '.am', 'demo', 'stage-compact.system.md')));
});

test('do, compactmem, commit and the compaction session write the cache for 5 minutes; plan, check and a hand-over do not', async (t) => {
  assert.deepEqual(CACHE_5M_KINDS, ['do', 'compactmem', 'commit', 'compact']);
  const cases = [
    [['plan', 'demo'], { replies: ['AM_STAGE: READY'], write: { '.am/demo/plan.md': SMALL } }, undefined, [null]],
    // The second call asks the same session again for its end line.
    [['do', 'demo'], { replies: ['Implemented.', 'AM_STAGE: DONE'] }, SMALL, ['1', '1']],
    [['check', 'demo'], { replies: ['AM_STAGE: NOTE'] }, SMALL, [null]],
    [['compactmem', 'demo'], { replies: ['AM_STAGE: PROPOSED'] }, SMALL, ['1']],
    [['commit', 'demo'], { replies: ['AM_STAGE: COMMITTED'] }, SMALL, ['1']],
    [['do', 'demo'], { replies: ['AM_STAGE: HANDED'] }, LARGE, [null], { orchestrator: () => '/orch' }],
    // The compaction session before a check: 5 minutes for it, 1 hour for the check.
    [['check', 'demo'], { replies: ['AM_STAGE: COMPACTED', 'AM_STAGE: NOTE'], writes: [{ '.am/demo/plan.md': SHORT }] }, BIG, ['1', null]],
  ];
  for (const [argv, fake, planText, want, opts = {}] of cases) {
    const dir = makeRepo(t, { plan: planText, fake });
    await run(dir, argv, { env: memEnv(t, dir), ...opts });
    assert.deepEqual(cacheEnv(dir), want, `${argv[0]} ${planText === LARGE ? 'hand-over' : ''}`);
  }
});

test('sessionEnv: a hand-over gets the owner pid; every other kind loses an inherited one and keeps its cache setting', () => {
  assert.equal(HANDOVER_OWNER, 'AM_HANDOVER_OWNER');
  assert.deepEqual(sessionEnv('handover', { A: '1' }, 4321), { A: '1', AM_HANDOVER_OWNER: '4321' });
  assert.deepEqual(sessionEnv('handover', { AM_HANDOVER_OWNER: '999' }, 7), { AM_HANDOVER_OWNER: '7' });
  // A small env of the test's own: inside a real hand-over isolatedEnv would carry the variable.
  for (const kind of ['plan', 'do', 'check', 'compactmem', 'commit', 'compact']) {
    const env = { A: '1', AM_HANDOVER_OWNER: '999' };
    const got = sessionEnv(kind, env, 7);
    assert.ok(!(HANDOVER_OWNER in got), kind);
    assert.equal(got.A, '1', kind);
    assert.equal(got.FORCE_PROMPT_CACHING_5M, CACHE_5M_KINDS.includes(kind) ? '1' : undefined, kind);
    assert.equal(env.AM_HANDOVER_OWNER, '999', `${kind}: the given env is not changed`);
  }
  const plain = { A: '1' };
  for (const kind of ['plan', 'check']) assert.equal(sessionEnv(kind, plain, 7), plain, kind);
});

test('only the hand-over session gets AM_HANDOVER_OWNER (this process), even when the caller had one', async (t) => {
  const handover = [String(process.pid)];
  const cases = [
    [['plan', 'demo'], { replies: ['AM_STAGE: READY'], write: { '.am/demo/plan.md': SMALL } }, undefined, [null]],
    [['do', 'demo'], { replies: ['Implemented.', 'AM_STAGE: DONE'] }, SMALL, [null, null]],
    [['check', 'demo'], { replies: ['AM_STAGE: NOTE'] }, SMALL, [null]],
    [['compactmem', 'demo'], { replies: ['AM_STAGE: PROPOSED'] }, SMALL, [null]],
    [['commit', 'demo'], { replies: ['AM_STAGE: COMMITTED'] }, SMALL, [null]],
    [['do', 'demo'], { replies: ['AM_STAGE: HANDED'] }, LARGE, handover, { orchestrator: () => '/orch' }],
    [['check', 'demo'], { replies: ['AM_STAGE: COMPACTED', 'AM_STAGE: NOTE'], writes: [{ '.am/demo/plan.md': SHORT }] }, BIG, [null, null]],
  ];
  for (const [argv, fake, planText, want, opts = {}] of cases) {
    const dir = makeRepo(t, { plan: planText, fake });
    await run(dir, argv, { env: { ...memEnv(t, dir), AM_HANDOVER_OWNER: '999' }, ...opts });
    assert.deepEqual(ownerEnv(dir), want, `${argv[0]} ${planText === LARGE ? 'hand-over' : ''}`);
  }
});

test('compactionProblem: check.md keeps its verdict', () => {
  assert.equal(compactionProblem('check.md', 'Verdict: NOTE\n## a\n', 'NOTE\n## a\n'), null);
  assert.match(compactionProblem('check.md', 'Verdict: BLOCK\n', 'Verdict: NOTE\n'), /verdict BLOCK -> NOTE/);
  assert.match(compactionProblem('plan.md', 'x', ''), /deleted or emptied/);
  assert.match(compactionProblem('plan.md', '- OPEN card\n', '- card\n'), /OPEN marks 1 -> 0/);
});

test('compactionProblem: a heading of any level must stay', () => {
  const before = '# p\n## 결정\n### 기본값 적용\n- a\n#### 세부\n- b\n';
  assert.equal(compactionProblem('plan.md', before, before.replace('- a\n', '')), null);
  assert.match(compactionProblem('plan.md', before, before.replace('# p\n', '')), /heading lost: # p/);
  assert.match(compactionProblem('plan.md', before, before.replace('### 기본값 적용\n', '')), /heading lost: ### 기본값 적용/);
  assert.match(compactionProblem('plan.md', before, before.replace('#### 세부\n', '')), /heading lost: #### 세부/);
  // A changed level is a lost heading too.
  assert.match(compactionProblem('plan.md', before, before.replace('### 기본값 적용', '## 기본값 적용')), /heading lost: ### 기본값 적용/);
});

test('compactionProblem: a verdict label wins over an earlier opposite word', () => {
  assert.equal(compactionProblem('check.md', 'No BLOCK finding.\nVerdict: NOTE\n', 'Verdict: NOTE\n'), null);
  assert.match(compactionProblem('check.md', 'No BLOCK finding.\n## 판정\n- 판정: NOTE\n', 'No BLOCK finding.\n## 판정\n- 판정: BLOCK\n'), /verdict NOTE -> BLOCK/);
});

test('compactionProblem: without a label the first BLOCK/NOTE counts', () => {
  assert.equal(compactionProblem('check.md', 'NOTE\nA BLOCK would need a failing gate.\n', 'NOTE\n'), null);
  assert.match(compactionProblem('check.md', 'NOTE\nA BLOCK would need a failing gate.\n', 'BLOCK\n'), /verdict NOTE -> BLOCK/);
});

test('cmdExeArgs: only the --allowedTools value is filtered', () => {
  assert.deepEqual(cmdExeArgs(['-p', 'x', '--allowedTools', 'Read,Bash(node "C:/a.mjs" *),Bash(node C:/a.mjs *)']), ['-p', 'x', '--allowedTools', 'Read,Bash(node C:/a.mjs *)']);
  assert.throws(() => cmdExeArgs(['-p', 'say "hi", ok']), /cannot go through cmd\.exe/);
  assert.throws(() => cmdExeArgs(['--disallowedTools', 'Read,Bash(node "C:/a.mjs" *)']), /cannot go through cmd\.exe/);
  assert.throws(() => cmdExeArgs(['-p', '100%']), /cannot go through cmd\.exe/);
});

// ------------------------------------------------------------------ progress events

/** The events of .am/<slug>/progress.jsonl, one per line; [] without the file. */
function events(dir, slug = 'demo') {
  const file = path.join(dir, '.am', slug, 'progress.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
}
const evs = (list) => list.map((e) => e.ev);
const ends = (list) => list.filter((e) => e.ev === 'end');
const PLANNED = { replies: ['Planned.\nAM_STAGE: READY'], write: { '.am/demo/plan.md': SMALL } };
const PLAN_RESULT = { stage: 'plan', slug: 'demo', status: 'READY', reason: '', costUsd: 0.25, sessionId: 'sess-1', reply: true, denied: ['Bash: git push'], compacted: null };

test('events: a stage writes start with its pid and one end with status and minutes', async (t) => {
  const dir = makeRepo(t, { fake: PLANNED });
  const { result } = await run(dir, ['plan', 'demo']);
  assert.deepEqual({ ...result, reply: !!result.reply }, PLAN_RESULT);
  const list = events(dir);
  assert.deepEqual(evs(list), ['start', 'end']);
  assert.ok(Number.isInteger(list[0].pid) && list[0].pid > 0);
  assert.equal(list[0].pid, process.pid);
  assert.equal(list[0].stage, 'plan');
  const { t: _t, min, ...end } = list[1];
  assert.deepEqual(end, { ev: 'end', text: 'plan stage ended', stage: 'plan', status: 'READY' });
  assert.ok(Number.isInteger(min) && min >= 0);
  assert.equal(formatEvent({ ...list[1], min: 0 }), 'end: plan stage ended [stage=plan status=READY min=0]');
});

test('events: the orchestrator lookup runs once, before the start line; minutes follow the given clock', async (t) => {
  const dir = makeRepo(t, { plan: LARGE, fake: { replies: ['AM_STAGE: DONE'] } });
  const clock = Date.parse('2026-10-08T00:00:00Z');
  let sawStart = false;
  let lookups = 0;
  const orchestrator = () => {
    sawStart = events(dir).some((e) => e.ev === 'start');
    lookups += 1;
    return null;
  };
  // The session moves the clock on by 2.5 minutes.
  const { result } = await run(dir, ['do', 'demo'], { orchestrator, now: () => clock + (existsSync(path.join(dir, 'calls.jsonl')) ? 150000 : 0) });
  assert.equal(result.status, 'DONE');
  assert.ok(!sawStart);
  assert.equal(lookups, 1);
  const end = ends(events(dir));
  assert.equal(end.length, 1);
  assert.equal(end[0].min, 2);
  assert.equal(end[0].stage, 'do');
});

test('events: a compaction leaves a note before and after it', async (t) => {
  const dir = makeRepo(t, { plan: BIG, fake: { replies: ['Shortened.\nAM_STAGE: COMPACTED', 'Implemented.\nAM_STAGE: DONE'], writes: [{ '.am/demo/plan.md': SHORT }] } });
  await run(dir, ['do', 'demo']);
  const list = events(dir);
  assert.deepEqual(evs(list), ['start', 'note', 'note', 'end']);
  assert.equal(list[1].text, 'shortening .am/demo/plan.md before the stage');
  assert.equal(list[2].text, `shortened .am/demo/plan.md: about ${estimateTokens(BIG)} -> ${estimateTokens(SHORT)} tokens`);
  const undone = makeRepo(t, { plan: BIG, fake: { replies: ['Shortened.', 'AM_STAGE: DONE'], writes: [{ '.am/demo/plan.md': SHORT }] } });
  await run(undone, ['do', 'demo']);
  const u = events(undone);
  assert.deepEqual(evs(u), ['start', 'note', 'note', 'end']);
  assert.match(u[2].text, /^shortening undone, files kept: the session ended without an AM_STAGE line$/);
  assert.equal(plan(undone), BIG);
});

test('events: asking the session again leaves a note', async (t) => {
  const dir = makeRepo(t, { plan: SMALL, fake: { replies: ['Implemented.', 'AM_STAGE: DONE'] } });
  await run(dir, ['do', 'demo']);
  const list = events(dir);
  assert.deepEqual(evs(list), ['start', 'note', 'end']);
  assert.equal(list[1].text, 'asking the session again for its end line');
  assert.equal(list[2].status, 'DONE');
  const unsaved = makeRepo(t, { fake: { replies: ['Planned.\nAM_STAGE: READY', 'Saved.\nAM_STAGE: READY'], writes: [{}, { '.am/demo/plan.md': 'x' }] } });
  await run(unsaved, ['plan', 'demo']);
  assert.equal(events(unsaved)[1].text, 'asking the session again to save plan.md');
});

test('events: a hand-over is marked for the state line', async (t) => {
  const dir = makeRepo(t, { plan: LARGE, fake: { replies: ['Run done.\nAM_STAGE: HANDED'] } });
  await run(dir, ['do', 'demo'], { orchestrator: () => '/orch' });
  const list = events(dir);
  assert.deepEqual(evs(list), ['start', 'note', 'end']);
  assert.equal(list.filter((e) => e.stage === 'handover' && e.ev === 'note').length, 1);
  assert.equal(list[2].stage, 'handover');
  const live = { alive: () => true, planText: '1. a (done)\n' };
  const handed = stateLine(list.slice(0, -1), live);
  assert.ok(handed.includes('(handover,'), handed);
  assert.ok(!handed.includes('steps done'), handed);
  const small = makeRepo(t, { plan: SMALL, fake: { replies: ['AM_STAGE: DONE'] } });
  await run(small, ['do', 'demo']);
  assert.match(stateLine(events(small).slice(0, -1), live), /, 1 steps done\)$/);
  const planned = makeRepo(t, { fake: PLANNED });
  await run(planned, ['plan', 'demo']);
  assert.match(stateLine(events(planned).slice(0, -1), live), /^state: running \(plan, \d+ min\)$/);
  // A recorded hand-over without the run skill starts nothing and leaves no note.
  const lost = makeRepo(t, { plan: `${LARGE}## Change log\n- Hand-over: am-orchestrator run skill, run 20261007-1200, start branch main\n` });
  await run(lost, ['do', 'demo']);
  assert.deepEqual(evs(events(lost)), ['start', 'end']);
  assert.equal(events(lost)[1].status, 'failed');
});

test('events: every way out after start writes exactly one end', async (t) => {
  const cases = [
    [makeRepo(t, { plan: SMALL }), ['check', 'demo'], (dir) => ({ claude: [path.join(dir, 'no-such-claude-binary')] }), (e) => assert.equal(e.status, 'unavailable')],
    [makeRepo(t, { plan: SMALL, fake: { crash: true } }), ['check', 'demo'], () => ({}), (e) => assert.deepEqual([e.status, e.text], ['failed', 'unreadable output (exit 3): boom'])],
    [makeRepo(t, { plan: SMALL, fake: { crash: true, stderr: 'y'.repeat(300) } }), ['check', 'demo'], () => ({}), (e) => assert.ok(e.status === 'failed' && e.text.length <= 200, e.text)],
    [makeRepo(t, { plan: SMALL, fake: { hang: [1] } }), ['check', 'demo'], () => ({ timeoutMin: { check: 0.005 } }), (e) => assert.ok(e.status === 'failed' && e.text.startsWith('no end within'), e.text)],
    [makeRepo(t, { plan: '# p\n## Steps\n1. a\n' }), ['do', 'demo'], () => ({ orchestrator: () => '/orch' }), (e) => assert.ok(e.status === 'failed' && e.text.includes('Scale line'), e.text)],
  ];
  for (const [dir, argv, opts, check] of cases) {
    await run(dir, argv, opts(dir));
    const list = events(dir);
    assert.equal(list[0].ev, 'start', argv.join(' '));
    assert.equal(ends(list).length, 1, argv.join(' '));
    assert.equal(list.at(-1).ev, 'end');
    check(list.at(-1));
  }
});

test('events: nothing is written before start', async (t) => {
  const dir = makeRepo(t);
  await run(dir, ['do', 'demo']);
  assert.ok(!existsSync(path.join(dir, '.am', 'demo', 'progress.jsonl')), 'no plan');
  await run(dir, ['ship', 'demo']);
  assert.ok(!existsSync(path.join(dir, '.am', 'demo', 'progress.jsonl')), 'bad arguments');
  const noRequest = makeRepo(t, { request: null });
  await run(noRequest, ['plan', 'demo']);
  assert.ok(!existsSync(path.join(noRequest, '.am', 'demo', 'progress.jsonl')), 'no request');
});

test('events: a stop signal writes the end once, stops the session and exits 1', async (t) => {
  const dir = makeRepo(t, { plan: SMALL, fake: { hang: [1] } });
  const began = Date.now();
  const running = run(dir, ['check', 'demo']);
  while (!existsSync(path.join(dir, 'calls.jsonl')) && Date.now() - began < 10000) await new Promise((r) => setTimeout(r, 50));
  let code = null;
  interrupt('SIGTERM', { exit: (c) => (code = c) });
  await running;
  assert.equal(code, 1);
  const end = ends(events(dir));
  assert.equal(end.length, 1);
  assert.equal(end[0].status, 'failed');
  assert.equal(end[0].text, 'stopped by SIGTERM');
  assert.ok(Date.now() - began < 30000, 'the hanging session was stopped');
});

test('events: a write error changes nothing for the stage', async (t) => {
  const dir = makeRepo(t, { fake: PLANNED });
  mkdirSync(path.join(dir, '.am', 'demo', 'progress.jsonl'));
  const { code, result } = await run(dir, ['plan', 'demo']);
  assert.equal(code, 0);
  assert.deepEqual({ ...result, reply: !!result.reply }, PLAN_RESULT);
});

// ------------------------------------------------------------------ hand-over: the run's events are copied

const RUN_T = '2026-10-08T01:02:03.000Z';
/** One event line as the orchestrator writes it into its run folder. */
const runLine = (fields) => `${JSON.stringify({ t: RUN_T, ...fields })}\n`;
const runFile = (dir, name) => path.join(dir, '.orchestrator', 'runs', name, 'progress.jsonl');
const currentFile = (dir) => path.join(dir, '.orchestrator', 'current');
/** Writes the event file of a run (null: only its folder) and, when given, .orchestrator/current. */
function orchRun(dir, name, text, { current } = {}) {
  mkdirSync(path.dirname(runFile(dir, name)), { recursive: true });
  if (text !== null) writeFileSync(runFile(dir, name), text);
  if (current !== undefined) writeFileSync(currentFile(dir), current);
}
const append = (dir, name, text) => writeFileSync(runFile(dir, name), text, { flag: 'a' });
const relayed = (list) => list.filter((e) => e.src === 'run');
const texts = (list) => list.map((e) => e.text);
const slugBytes = (dir) => readFileSync(path.join(dir, '.am', 'demo', 'progress.jsonl'), 'utf8');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, ms = 10000) => {
  const began = Date.now();
  while (!cond() && Date.now() - began < ms) await pause(20);
};
const ORCH = { orchestrator: () => '/orch' };
const OLD_LINES = runLine({ ev: 'start', text: 'old run started', pid: 1, stage: 'run' }) + runLine({ ev: 'step', text: 'old step' });
const NEW_TEXTS = ['split started', 'T01 plan started', 'plan session ended', 'T01 blocked', 'done 1 of 1'];
const NEW_LINES = `not an event\n${runLine({ ev: 'start', text: NEW_TEXTS[0], pid: 4242, stage: 'split' })}${runLine({ ev: 'step', text: NEW_TEXTS[1], task: 'T01', stage: 'plan' })}${runLine({ ev: 'note', text: NEW_TEXTS[2] })}${runLine({ ev: 'alert', text: NEW_TEXTS[3], task: 'T01', status: 'blocked' })}${runLine({ ev: 'end', text: NEW_TEXTS[4], status: 'done', min: 3 })}{"t":"x","ev":"alert","te`;
// The session makes the run: it writes the new run's events and points .orchestrator/current at it.
const NEW_RUN = { '.orchestrator/runs/new/progress.jsonl': NEW_LINES, '.orchestrator/current': 'new\n' };
const HANDED_PLAN = `${LARGE}## 변경 기록\n- am-orchestrator run 스킬로 넘김, run.id 20261007-1200, 시작 브랜치 main\n`;

/** A large plan, an earlier run `old` with a cursor of its own, and a session that makes the run `new`. */
function newHandover(t, fake = {}) {
  const dir = makeRepo(t, { plan: LARGE, fake: { replies: ['Run done.\nAM_STAGE: HANDED'], write: NEW_RUN, ...fake } });
  orchRun(dir, 'old', OLD_LINES, { current: 'old\n' });
  writeFileSync(path.join(dir, '.orchestrator', 'runs', 'old', 'progress.main.cursor'), '7');
  return dir;
}
const oneEndLast = (list) => {
  assert.equal(ends(list).length, 1);
  assert.equal(list.at(-1).ev, 'end');
};

test('relay: a new hand-over copies the events of the run it made, before its own end', async (t) => {
  const dir = newHandover(t);
  const { result } = await run(dir, ['do', 'demo'], { ...ORCH, relayMs: 60000 });
  assert.equal(result.status, 'HANDED');
  assert.equal(result.stage, 'handover');
  const list = events(dir);
  assert.deepEqual(evs(list), ['start', 'note', 'step', 'step', 'note', 'alert', 'step', 'end']);
  oneEndLast(list);
  const moved = relayed(list);
  assert.equal(moved.length, 5);
  assert.deepEqual(texts(moved), NEW_TEXTS);
  for (const e of moved) {
    assert.ok(!('pid' in e), e.text);
    assert.equal(e.t, RUN_T, e.text);
  }
  assert.ok(!texts(list).some((x) => x.startsWith('old ')), 'nothing of the earlier run');
  assert.equal(formatEvent(moved[0]), 'step: split started [stage=split src=run]');
  // The run's own end came over as a step: it does not end the stage.
  const state = stateLine(list.slice(0, -1), { alive: () => true });
  assert.ok(state.includes('(handover,'), state);
  // No cursor of the stage runner in the run folders.
  assert.deepEqual(readdirSync(path.dirname(runFile(dir, 'new'))).filter((f) => f.endsWith('.cursor')), []);
  assert.deepEqual(readdirSync(path.dirname(runFile(dir, 'old'))).filter((f) => f.endsWith('.cursor')), ['progress.main.cursor']);
  assert.equal(readFileSync(path.join(dir, '.orchestrator', 'runs', 'old', 'progress.main.cursor'), 'utf8'), '7');
});

test('relay: lines are copied while the session runs, and a stop signal copies the rest before the end', async (t) => {
  const dir = makeRepo(t, { plan: LARGE, fake: { hang: [1] } });
  orchRun(dir, 'old', OLD_LINES, { current: 'old\n' });
  const running = run(dir, ['do', 'demo'], { ...ORCH, relayMs: 20 });
  let code = null;
  try {
    await until(() => existsSync(path.join(dir, 'calls.jsonl')));
    orchRun(dir, 'new', runLine({ ev: 'start', text: 'split started', pid: 4242, stage: 'split' }) + runLine({ ev: 'step', text: 'T01 plan started', task: 'T01' }));
    writeFileSync(currentFile(dir), 'new\n');
    await until(() => relayed(events(dir)).length >= 2);
    const live = events(dir);
    assert.deepEqual(texts(relayed(live)), ['split started', 'T01 plan started']);
    assert.equal(ends(live).length, 0, 'the session is still running');
    assert.ok(!texts(live).some((x) => x.startsWith('old ')));
    append(dir, 'new', runLine({ ev: 'alert', text: 'T01 blocked', task: 'T01' }));
  } finally {
    interrupt('SIGTERM', { exit: (c) => (code = c) });
    await running;
  }
  assert.equal(code, 1);
  const list = events(dir);
  oneEndLast(list);
  assert.equal(list.at(-1).text, 'stopped by SIGTERM');
  assert.deepEqual([list.at(-2).ev, list.at(-2).text, list.at(-2).src], ['alert', 'T01 blocked', 'run']);
  // The timer is gone: a later line of the run stays where it is.
  const before = slugBytes(dir);
  append(dir, 'new', runLine({ ev: 'step', text: 'too late' }));
  await pause(100);
  assert.equal(slugBytes(dir), before);
});

test('relay: a resumed hand-over starts after the last complete line that was there', async (t) => {
  const first = runLine({ ev: 'start', text: 'r1 started', pid: 1, stage: 'run' }) + runLine({ ev: 'step', text: 'r1 before' });
  const half = runLine({ ev: 'step', text: 'half written' });
  const rest = runLine({ ev: 'step', text: 'after 1' }) + runLine({ ev: 'alert', text: 'after 2' });
  const dir = makeRepo(t, { plan: HANDED_PLAN, fake: { replies: ['Run done.\nAM_STAGE: HANDED'], write: { '.orchestrator/runs/r1/progress.jsonl': first + half + rest } } });
  orchRun(dir, 'r1', first + half.slice(0, 20), { current: 'r1\n' });
  const { result, calls } = await run(dir, ['do', 'demo'], { ...ORCH, relayMs: 60000 });
  assert.equal(result.status, 'HANDED');
  assert.equal(flag(calls[0], '-p'), '/am-orchestrator:run');
  const list = events(dir);
  assert.deepEqual(texts(relayed(list)), ['half written', 'after 1', 'after 2']);
  oneEndLast(list);
});

test('relay: the timer stops at a normal end too', async (t) => {
  const dir = newHandover(t);
  const { result } = await run(dir, ['do', 'demo'], { ...ORCH, relayMs: 20 });
  assert.equal(result.status, 'HANDED');
  oneEndLast(events(dir));
  const before = slugBytes(dir);
  append(dir, 'new', `${NEW_LINES.slice(NEW_LINES.lastIndexOf('{'))}\n${runLine({ ev: 'step', text: 'too late' })}`);
  await pause(100);
  assert.equal(slugBytes(dir), before);
});

test('relay: a run without a readable event file changes nothing for the stage', async (t) => {
  const plain = makeRepo(t, { plan: LARGE, fake: { replies: ['Run done.\nAM_STAGE: HANDED'] } });
  const expected = (await run(plain, ['do', 'demo'], ORCH)).result;
  assert.equal(expected.status, 'HANDED');
  assert.equal(expected.reason, '');
  const handed = (write) => ({ replies: ['Run done.\nAM_STAGE: HANDED'], write });
  const cases = {
    'the run has no event file': () => {
      const dir = makeRepo(t, { plan: LARGE, fake: handed({ '.orchestrator/current': 'new\n' }) });
      orchRun(dir, 'old', OLD_LINES, { current: 'old\n' });
      return dir;
    },
    'a folder in place of the run event file': () => {
      const dir = makeRepo(t, { plan: LARGE, fake: handed({ '.orchestrator/current': 'new\n' }) });
      orchRun(dir, 'old', OLD_LINES, { current: 'old\n' });
      mkdirSync(runFile(dir, 'new'), { recursive: true });
      return dir;
    },
    'a folder in place of current': () => {
      const dir = makeRepo(t, { plan: LARGE, fake: handed({ '.orchestrator/runs/new/progress.jsonl': NEW_LINES }) });
      mkdirSync(currentFile(dir), { recursive: true });
      return dir;
    },
    'a folder in place of the task event file': () => {
      const dir = newHandover(t);
      mkdirSync(path.join(dir, '.am', 'demo', 'progress.jsonl'));
      return dir;
    },
  };
  for (const [name, make] of Object.entries(cases)) {
    const dir = make();
    const { code, result } = await run(dir, ['do', 'demo'], { ...ORCH, relayMs: 60000 });
    assert.equal(code, 0, name);
    assert.deepEqual(result, expected, name);
    if (!name.includes('task event file')) assert.deepEqual(evs(events(dir)), ['start', 'note', 'end'], name);
  }
});

test('relay: only a hand-over copies run events', async (t) => {
  for (const [stage, mark] of [['do', 'DONE'], ['check', 'NOTE']]) {
    const dir = makeRepo(t, { plan: SMALL, fake: { replies: [`AM_STAGE: ${mark}`], write: NEW_RUN } });
    orchRun(dir, 'old', OLD_LINES, { current: 'old\n' });
    const { result } = await run(dir, [stage, 'demo'], { ...ORCH, relayMs: 20 });
    assert.equal(result.status, mark);
    const list = events(dir);
    assert.deepEqual(evs(list), ['start', 'end'], stage);
    assert.ok(!list.some((e) => 'src' in e), stage);
  }
});

test('runRelay: which run is followed and from where', (t) => {
  assert.equal(RELAY_MS, 5000);
  // A new hand-over: nothing while current is the noted run or empty, then the new run from its start, and only that run.
  const dir = makeRepo(t, { plan: LARGE });
  orchRun(dir, 'old', OLD_LINES, { current: 'old\n' });
  const relay = runRelay(dir, 'demo');
  relay();
  writeFileSync(currentFile(dir), '\n');
  relay();
  assert.deepEqual(events(dir), []);
  orchRun(dir, 'new', runLine({ ev: 'start', text: 'new 1', pid: 7 }) + runLine({ ev: 'step', text: 'new 2' }), { current: 'new\n' });
  relay();
  assert.deepEqual(texts(events(dir)), ['new 1', 'new 2']);
  orchRun(dir, 'other', runLine({ ev: 'step', text: 'other 1' }), { current: 'other\n' });
  append(dir, 'new', runLine({ ev: 'step', text: 'new 3' }));
  relay();
  assert.deepEqual(texts(events(dir)), ['new 1', 'new 2', 'new 3']);
  assert.ok(events(dir).every((e) => e.src === 'run' && !('pid' in e) && e.ev === 'step'));

  // A resumed hand-over whose event file could not be read: the first good read only sets where to start.
  const resumed = makeRepo(t, { plan: HANDED_PLAN });
  orchRun(resumed, 'r1', null, { current: 'r1\n' });
  mkdirSync(runFile(resumed, 'r1'));
  const again = runRelay(resumed, 'demo', { resume: true });
  again();
  rmSync(runFile(resumed, 'r1'), { recursive: true });
  orchRun(resumed, 'r1', runLine({ ev: 'step', text: 'r1 before 1' }) + runLine({ ev: 'step', text: 'r1 before 2' }));
  again();
  assert.deepEqual(events(resumed), []);
  append(resumed, 'r1', runLine({ ev: 'step', text: 'r1 after' }));
  again();
  assert.deepEqual(texts(events(resumed)), ['r1 after']);

  // A new hand-over that could not read current: the run found there later was not made by this session.
  const unread = makeRepo(t, { plan: LARGE });
  mkdirSync(currentFile(unread), { recursive: true });
  const late = runRelay(unread, 'demo');
  late();
  rmSync(currentFile(unread), { recursive: true });
  orchRun(unread, 'old', OLD_LINES, { current: 'old\n' });
  late();
  late();
  assert.deepEqual(events(unread), []);
  orchRun(unread, 'new', runLine({ ev: 'step', text: 'new 1' }), { current: 'new\n' });
  late();
  assert.deepEqual(texts(events(unread)), ['new 1']);
});

test('relay: the real command ends by itself and prints the same result line', (t) => {
  const dir = newHandover(t);
  const stage = pathToFileURL(path.join(REPO, 'plugin', 'scripts', 'stage.mjs')).href;
  writeFileSync(path.join(dir, 'wrapper.mjs'), `import { main } from ${JSON.stringify(stage)};\nprocess.exitCode = await main(['do', 'demo'], { claude: [process.execPath, 'fake-claude.mjs'], orchestrator: () => '/orch', relayMs: 60000, freeMem: () => 2 ** 50 });\n`);
  // A timer that is neither unref'd nor cleared would keep the process alive past the limit.
  const r = spawnSync(process.execPath, ['wrapper.mjs'], { cwd: dir, env: isolatedEnv, encoding: 'utf8', timeout: 20000 });
  assert.equal(r.error, undefined);
  assert.equal(r.signal, null);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 1, r.stdout);
  assert.equal(JSON.parse(lines[0]).status, 'HANDED');
  const list = events(dir);
  oneEndLast(list);
  assert.equal(relayed(list).length, 5);
  assert.ok(list.findLastIndex((e) => e.src === 'run') < list.length - 1);
});

test('instructions: only a hand-over is told not to run the progress command, once', () => {
  const line = "- Do not run the `progress` command of the run skill's script, even where the skill says to start it: nobody reads this session, and the am stage runner copies the run's news into this task's event file itself.";
  for (const resume of [true, false]) {
    for (const push of [true, false]) assert.equal(instructions('handover', 'demo', { resume, push }).system.split(`\n${line}\n`).length, 2, `resume ${resume}, push ${push}`);
  }
  for (const s of STAGES) assert.ok(!instructions(s, 'demo').system.includes('`progress` command'), s);
});

// ------------------------------------------------------------------ waiting for other runs of the working tree

const T0 = Date.parse('2026-10-09T10:00:00.000Z');
/** One event line at T0 plus min minutes. */
const evAt = (min, fields) => `${JSON.stringify({ t: new Date(T0 + min * 60000).toISOString(), ...fields })}\n`;
const LIVE = 101;
const DEAD = 102;
const aliveOnly = (pid) => pid === LIVE;
/** Writes the event file of another task (or this one) under .am/. */
function taskEvents(dir, slug, lines) {
  mkdirSync(path.join(dir, '.am', slug), { recursive: true });
  writeFileSync(path.join(dir, '.am', slug, 'progress.jsonl'), lines.join(''));
}
const others = (dir, min, slug = 'demo') => otherRuns(dir, slug, { now: () => T0 + min * 60000, alive: aliveOnly });
const stageLines = (stage, status, { pid = DEAD, from = 0, to = 5 } = {}) => [evAt(from, { ev: 'start', text: 's', pid, stage }), evAt(to, { ev: 'end', text: 'e', stage, status })];
const LOCK = (dir) => path.join(dir, '.am', '.admission.lock');

test('otherRuns: a live stage of another task blocks; a dead one without an end does not', (t) => {
  assert.deepEqual([GRACE_MS, POLL_MS, WAIT_MS], [600000, 5000, 480000]);
  const dir = makeRepo(t);
  assert.deepEqual(others(dir, 0), { runs: [], text: '' });
  taskEvents(dir, 'a', [evAt(0, { ev: 'start', text: 's', pid: LIVE, stage: 'do' })]);
  assert.deepEqual(others(dir, 100), { runs: ['a'], text: 'a (do stage running)' });
  taskEvents(dir, 'a', [evAt(0, { ev: 'start', text: 's', pid: DEAD, stage: 'do' })]);
  assert.deepEqual(others(dir, 1).runs, []);
  // Copied run lines are not the task's own: neither a live start nor an end that leads on.
  taskEvents(dir, 'a', [evAt(0, { ev: 'step', text: 's', stage: 'split', src: 'run' }), evAt(0, { ev: 'step', text: 'x', src: 'run' }), `${JSON.stringify({ t: new Date(T0).toISOString(), ev: 'start', text: 'r', pid: LIVE, src: 'run' })}\n`, evAt(1, { ev: 'end', text: 'e', stage: 'do', status: 'DONE', src: 'run' })]);
  assert.deepEqual(others(dir, 2).runs, []);
});

test('otherRuns: the gap after an end that leads on holds for the grace time; final ends hold nothing', (t) => {
  const dir = makeRepo(t);
  for (const [stage, status] of [['plan', 'READY'], ['do', 'DONE'], ['check', 'NOTE'], ['check', 'BLOCK'], ['compactmem', 'PROPOSED'], ['compactmem', 'NOTHING'], ['compactmem', 'BLOCKED'], ['compactmem', 'failed']]) {
    taskEvents(dir, 'a', stageLines(stage, status));
    assert.deepEqual(others(dir, 15), { runs: ['a'], text: 'a (between stages)' }, `${stage} ${status}`);
    assert.deepEqual(others(dir, 15.01).runs, [], `${stage} ${status} after the grace time`);
  }
  for (const [stage, status] of [['plan', 'NEEDS_DECISION'], ['do', 'BLOCKED'], ['handover', 'HANDED'], ['check', 'failed'], ['commit', 'COMMITTED'], ['commit', 'NOTHING'], ['plan', 'failed']]) {
    taskEvents(dir, 'a', stageLines(stage, status));
    assert.deepEqual(others(dir, 6).runs, [], `${stage} ${status}`);
  }
});

test('otherRuns: in a gap the earlier seat goes first, slug order on a tie; a wait note keeps or makes a seat', (t) => {
  const dir = makeRepo(t);
  taskEvents(dir, 'a', [...stageLines('commit', 'COMMITTED', { from: -30, to: -20 }), ...stageLines('plan', 'READY', { from: 0, to: 5 })]);
  // We have no seat yet: the gap blocks.
  assert.deepEqual(others(dir, 6).runs, ['a']);
  // Our seat (first start or wait note after our last final end) is later: still blocked; earlier: we go.
  taskEvents(dir, 'demo', [evAt(3, { ev: 'note', text: 'w', stage: 'wait' })]);
  assert.deepEqual(others(dir, 6).runs, ['a']);
  taskEvents(dir, 'demo', [...stageLines('commit', 'COMMITTED', { from: -40, to: -35 }), ...stageLines('plan', 'READY', { from: -1, to: -0.5 })]);
  assert.deepEqual(others(dir, 6).runs, []);
  // A tie: the lower slug goes first.
  taskEvents(dir, 'demo', stageLines('plan', 'READY', { from: 0, to: 4 }));
  assert.deepEqual(others(dir, 6).runs, ['a']);
  assert.deepEqual(others(dir, 6, 'a').runs, []);
  // A task that only waits holds its seat while its last wait note is within the grace time.
  taskEvents(dir, 'a', [evAt(-30, { ev: 'end', text: 'e', stage: 'commit', status: 'COMMITTED' }), evAt(2, { ev: 'note', text: 'w', stage: 'wait' }), evAt(9, { ev: 'note', text: 'w', stage: 'wait' })]);
  taskEvents(dir, 'demo', []);
  assert.deepEqual(others(dir, 18).runs, ['a']);
  assert.deepEqual(others(dir, 19.5).runs, []);
  taskEvents(dir, 'demo', [evAt(1, { ev: 'note', text: 'w', stage: 'wait' })]);
  assert.deepEqual(others(dir, 10).runs, [], 'our earlier wait note is the earlier seat');
  // A live stage blocks whatever the seats say.
  taskEvents(dir, 'a', [evAt(20, { ev: 'start', text: 's', pid: LIVE, stage: 'check' })]);
  taskEvents(dir, 'demo', stageLines('plan', 'READY', { from: -50, to: -49 }));
  assert.deepEqual(others(dir, 21).runs, ['a']);
});

test('otherRuns: the orchestrator blocks by its live lock and in the gap after split or answer, not for the run this task handed over', (t) => {
  const dir = makeRepo(t, { plan: SMALL });
  const orch = path.join(dir, '.orchestrator');
  mkdirSync(orch, { recursive: true });
  writeFileSync(path.join(orch, 'lock.json'), JSON.stringify({ pid: LIVE, command: 'run', startedAt: 'x', run: 'r1' }));
  assert.deepEqual(others(dir, 0), { runs: ['am-orchestrator'], text: 'am-orchestrator run (pid 101)' });
  writeFileSync(path.join(orch, 'lock.json'), JSON.stringify({ pid: DEAD, command: 'run' }));
  assert.deepEqual(others(dir, 0).runs, []);
  orchRun(dir, 'r1', null, { current: 'r1\n' });
  for (const [stage, status, blocks] of [['split', 'done', true], ['answer', 'planned', true], ['answer', 'split', true], ['answer', 'blocked', false], ['answer', 'needs-decision', false], ['run', 'done', false], ['split', 'failed', false]]) {
    writeFileSync(runFile(dir, 'r1'), evAt(0, { ev: 'start', text: 's', pid: DEAD, stage }) + evAt(5, { ev: 'end', text: 'e', stage, status }));
    assert.deepEqual(others(dir, 15).runs, blocks ? ['am-orchestrator run r1'] : [], `${stage} ${status}`);
    assert.deepEqual(others(dir, 15.01).runs, [], `${stage} ${status} after the grace time`);
  }
  writeFileSync(runFile(dir, 'r1'), evAt(5, { ev: 'end', text: 'e', stage: 'split', status: 'done' }));
  assert.equal(others(dir, 6).text, 'am-orchestrator run r1 (between commands)');
  // The run this task handed over leaves the gap to this task; its live lock still blocks.
  writeFileSync(path.join(dir, '.am', 'demo', 'plan.md'), `${SMALL}## Change log\n- Hand-over: am-orchestrator run skill, run r1, start branch main\n`);
  assert.deepEqual(others(dir, 6).runs, []);
  writeFileSync(path.join(orch, 'lock.json'), JSON.stringify({ pid: LIVE, command: 'run' }));
  assert.deepEqual(others(dir, 6).runs, ['am-orchestrator']);
});

test('takeLock: one owner at a time; a dead or long unreadable owner is replaced, a live one is not', (t) => {
  const dir = makeRepo(t);
  const file = LOCK(dir);
  const first = takeLock(file, { alive: () => true });
  assert.equal(typeof first.release, 'function');
  assert.deepEqual(takeLock(file, { alive: () => true }), { busy: process.pid });
  first.release();
  assert.ok(!existsSync(file));
  writeFileSync(file, JSON.stringify({ pid: LIVE, t: 1 }));
  assert.deepEqual(takeLock(file, { alive: aliveOnly }), { busy: LIVE });
  assert.equal(readFileSync(file, 'utf8'), JSON.stringify({ pid: LIVE, t: 1 }));
  writeFileSync(file, JSON.stringify({ pid: DEAD, t: 1 }));
  const taken = takeLock(file, { alive: aliveOnly });
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).pid, process.pid);
  // Release removes only its own lock.
  writeFileSync(file, JSON.stringify({ pid: LIVE, t: 2 }));
  taken.release();
  assert.ok(existsSync(file));
  writeFileSync(file, '');
  assert.deepEqual(takeLock(file, { alive: aliveOnly }), { busy: null });
  utimesSync(file, new Date(Date.now() - 120000), new Date(Date.now() - 120000));
  assert.equal(typeof takeLock(file, { alive: aliveOnly }).release, 'function');
  assert.deepEqual(readdirSync(path.join(dir, '.am')).filter((f) => f.includes('.stale')), []);
  // A lock that cannot be made at all: null, and the stage goes on unchecked.
  assert.equal(takeLock(path.join(dir, 'no-such-folder', 'x.lock')), null);
});

test('takeLock: extra fields; a live owner untouched past staleMs is taken only on a second look that finds it unchanged', (t) => {
  const dir = makeRepo(t);
  const file = path.join(dir, '.am', 'demo', 'stage-worker.json');
  const mine = takeLock(file, { fields: { stage: 'do', push: true } });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { pid: process.pid, t: JSON.parse(readFileSync(file, 'utf8')).t, stage: 'do', push: true });
  assert.equal(mine.owns(), 'yes');
  writeFileSync(file, JSON.stringify({ pid: LIVE, t: 1 }));
  assert.equal(mine.owns(), 'other');
  rmSync(file);
  assert.equal(mine.owns(), 'missing');
  const old = () => {
    writeFileSync(file, JSON.stringify({ pid: LIVE, t: 1 }));
    const then = new Date(Date.now() - 6 * 60000);
    utimesSync(file, then, then);
  };
  old();
  assert.deepEqual(takeLock(file, { alive: aliveOnly }), { busy: LIVE }, 'without staleMs the age does not count');
  assert.equal(ownerState(file, { alive: aliveOnly }), 'live');
  const first = takeLock(file, { alive: aliveOnly, staleMs: 5 * 60000 });
  assert.equal(first.busy, LIVE);
  assert.deepEqual(first.suspect, { text: readFileSync(file, 'utf8'), mtimeMs: statSync(file).mtimeMs });
  assert.equal(ownerState(file, { alive: aliveOnly, staleMs: 5 * 60000 }), 'suspect');
  assert.equal(ownerState(file, { alive: aliveOnly, staleMs: 5 * 60000, suspect: first.suspect }), 'dead');
  const second = takeLock(file, { alive: aliveOnly, staleMs: 5 * 60000, suspect: first.suspect });
  assert.equal(typeof second.release, 'function');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).pid, process.pid);
  second.release();
  // Touched between the two looks: still busy.
  old();
  const look = takeLock(file, { alive: aliveOnly, staleMs: 5 * 60000 });
  const later = new Date(Date.now() - 5.5 * 60000);
  utimesSync(file, later, later);
  const again = takeLock(file, { alive: aliveOnly, staleMs: 5 * 60000, suspect: look.suspect });
  assert.equal(again.busy, LIVE);
  assert.equal(readFileSync(file, 'utf8'), JSON.stringify({ pid: LIVE, t: 1 }));
  assert.deepEqual(readdirSync(path.join(dir, '.am', 'demo')).filter((f) => f.includes('.stale')), []);
});

test('wait: a blocked stage starts no session and ends with WAIT after the wait time; one note, no start or end', async (t) => {
  const dir = makeRepo(t, { fake: PLANNED });
  taskEvents(dir, 'a', [evAt(0, { ev: 'start', text: 's', pid: LIVE, stage: 'do' })]);
  const { code, result, calls } = await run(dir, ['plan', 'demo'], { alive: aliveOnly, waitMs: 150, pollMs: 20 });
  assert.equal(code, 0);
  assert.equal(result.status, 'WAIT');
  assert.equal(result.stage, 'plan');
  assert.equal(result.reason, 'waiting for another run of this repository: a (do stage running)');
  assert.deepEqual(calls, []);
  const list = events(dir);
  assert.deepEqual(list.map((e) => [e.ev, e.stage]), [['note', 'wait']]);
  assert.match(list[0].text, /a \(do stage running\)/);
  assert.ok(!existsSync(LOCK(dir)));
});

test('wait: a stage goes on once the other run ends within the wait time', async (t) => {
  const dir = makeRepo(t, { fake: PLANNED });
  taskEvents(dir, 'a', [evAt(0, { ev: 'start', text: 's', pid: LIVE, stage: 'commit' })]);
  setTimeout(() => appendFileSync(path.join(dir, '.am', 'a', 'progress.jsonl'), `${JSON.stringify({ t: new Date().toISOString(), ev: 'end', text: 'e', stage: 'commit', status: 'COMMITTED' })}\n`), 100);
  const { result, calls } = await run(dir, ['plan', 'demo'], { alive: aliveOnly, waitMs: 10000, pollMs: 20 });
  assert.equal(result.status, 'READY');
  assert.equal(calls.length, 1);
  assert.deepEqual(evs(events(dir)), ['note', 'start', 'end']);
  assert.ok(!existsSync(LOCK(dir)));
});

test('wait: of two stages started together only one starts; a live owner of the lock makes a stage wait', async (t) => {
  const dir = makeRepo(t, { fake: { hang: [1] } });
  mkdirSync(path.join(dir, '.am', 'other'), { recursive: true });
  writeFileSync(path.join(dir, '.am', 'other', 'request.md'), 'Another request');
  const first = run(dir, ['plan', 'demo'], { waitMs: 300, pollMs: 20 });
  const second = run(dir, ['plan', 'other'], { waitMs: 300, pollMs: 20 });
  let code = null;
  try {
    const b = await second;
    assert.equal(b.result.status, 'WAIT');
    assert.equal(b.result.reason, 'waiting for another run of this repository: demo (plan stage running)');
    await until(() => existsSync(path.join(dir, 'calls.jsonl')));
    await pause(100);
    assert.equal(readFileSync(path.join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').length, 1, 'only the first stage started a session');
  } finally {
    interrupt('SIGTERM', { exit: (c) => (code = c) });
    await first;
  }
  assert.equal(code, 1);
  assert.deepEqual(evs(events(dir, 'other')), ['note']);

  const held = makeRepo(t, { fake: PLANNED });
  writeFileSync(LOCK(held), JSON.stringify({ pid: LIVE, t: 1 }));
  const { result, calls } = await run(held, ['plan', 'demo'], { alive: aliveOnly, waitMs: 100, pollMs: 20 });
  assert.equal(result.status, 'WAIT');
  assert.equal(result.reason, 'waiting for another run of this repository: another stage of this repository is starting (pid 101)');
  assert.deepEqual(calls, []);
  assert.equal(readFileSync(LOCK(held), 'utf8'), JSON.stringify({ pid: LIVE, t: 1 }));
  // A dead owner's lock is taken over and released after the start line.
  writeFileSync(LOCK(held), JSON.stringify({ pid: DEAD, t: 1 }));
  const after = await run(held, ['plan', 'demo'], { alive: aliveOnly, waitMs: 100, pollMs: 20 });
  assert.equal(after.result.status, 'READY');
  assert.ok(!existsSync(LOCK(held)));
});

test('wait: when the start line cannot be written the lock is kept until the stage ends', async (t) => {
  const dir = makeRepo(t, { fake: { hang: [1] } });
  mkdirSync(path.join(dir, '.am', 'demo', 'progress.jsonl'));
  const running = run(dir, ['plan', 'demo']);
  let code = null;
  try {
    await until(() => existsSync(path.join(dir, 'calls.jsonl')));
    assert.ok(existsSync(LOCK(dir)), 'held during the session');
  } finally {
    interrupt('SIGTERM', { exit: (c) => (code = c) });
    await running;
  }
  assert.equal(code, 1);
  assert.ok(!existsSync(LOCK(dir)), 'released at the end');
});

// A temporary config folder holding am/models.json with text (or nothing when text is null); returns the file's path.
function userModels(t, text) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'am-user-models-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = userModelsFile({ CLAUDE_CONFIG_DIR: dir });
  mkdirSync(path.dirname(file), { recursive: true });
  if (text !== null) writeFileSync(file, text);
  return file;
}

test('user models: the file lives under the config folder, else under ~/.claude', () => {
  const dir = path.join(os.tmpdir(), 'cfg');
  assert.equal(userModelsFile({ CLAUDE_CONFIG_DIR: dir }), path.join(dir, 'am', 'models.json'));
  assert.equal(userModelsFile({}), path.join(os.homedir(), '.claude', 'am', 'models.json'));
});

test('user models: the module reads no environment variable and imports only node built-ins', () => {
  const src = readFileSync(path.join(REPO, 'plugin', 'scripts', 'user-models.mjs'), 'utf8');
  assert.ok(!src.includes('process.env'));
  const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
  assert.ok(imports.length > 0);
  for (const name of imports) assert.ok(name.startsWith('node:'), name);
});

test('user models: a missing file is empty; notes are dropped and a BOM is allowed', (t) => {
  assert.deepEqual(readUserModels(userModels(t, null)), { model: {}, effort: {} });
  const efforts = Object.fromEntries(USER_EFFORTS.map((e, i) => [['plan', 'do', 'check', 'commit', 'split'][i], e]));
  const file = userModels(t, '﻿' + JSON.stringify({ _note: 'mine', model: { _why: 'cheap', default: 'sonnet', do: 'opus' }, effort: { _x: 1, ...efforts } }));
  assert.deepEqual(readUserModels(file), { model: { default: 'sonnet', do: 'opus' }, effort: efforts });
  assert.deepEqual(readUserModels(userModels(t, '{"model":{"run":"haiku"}}')), { model: { run: 'haiku' }, effort: {} });
  const opinion = { model: { 'second-opinion': 'sonnet', 'codex-opinion': 'gpt-5.1-codex' }, effort: { 'second-opinion': 'max', 'codex-opinion': 'minimal' } };
  assert.deepEqual(readUserModels(userModels(t, JSON.stringify(opinion))), opinion);
  for (const m of OPINION_MODELS) assert.deepEqual(readUserModels(userModels(t, JSON.stringify({ model: { 'second-opinion': m } }))), { model: { 'second-opinion': m }, effort: {} });
  for (const e of CODEX_EFFORTS) assert.deepEqual(readUserModels(userModels(t, JSON.stringify({ effort: { 'codex-opinion': e } }))), { model: {}, effort: { 'codex-opinion': e } });
});

test('user models: every broken file is one error line naming the file and the problem', (t) => {
  const cases = [
    ['{"model":', 'JSON'],
    ['{"models":{}}', '"models"'],
    ['{"model":["opus"]}', '"model"'],
    ['{"effort":"high"}', '"effort"'],
    ['{"model":"opus"}', '"model"'],
    ['{"effort":["high"]}', '"effort"'],
    ['{"model":null}', '"model"'],
    ['[]', 'object'],
    ['{"model":{"implement":"opus"}}', '"do"'],
    ['{"effort":{"review":"high"}}', 'effort.review'],
    ['{"model":{"plan":""}}', 'model.plan'],
    ['{"model":{"plan":"  "}}', 'non-empty'],
    ['{"model":{"plan":4}}', 'model.plan'],
    ['{"effort":{"check":"huge"}}', 'huge'],
    ['{"model":{"second-opinion":"sonet"}}', 'opus, sonnet, haiku, fable'],
    ['{"model":{"second-opinion":"Opus"}}', 'opus, sonnet, haiku, fable'],
    ['{"model":{"second-opinion":""}}', 'non-empty'],
    ['{"model":{"codex-opinion":"gpt 5"}}', 'start with a letter'],
    [JSON.stringify({ model: { 'codex-opinion': 'gpt"5' } }), 'start with a letter'],
    ['{"model":{"codex-opinion":"a&calc"}}', 'start with a letter'],
    ['{"model":{"codex-opinion":"5-codex"}}', 'start with a letter'],
    ['{"model":{"codex-opinion":""}}', 'non-empty'],
    ['{"effort":{"codex-opinion":"max"}}', 'minimal, low, medium, high, xhigh'],
  ];
  for (const [text, word] of cases) {
    const file = userModels(t, text);
    const r = readUserModels(file);
    assert.equal(typeof r.error, 'string', text);
    assert.ok(!r.error.includes('\n'), text);
    assert.ok(r.error.startsWith(`${file}: `), text);
    assert.ok(r.error.includes(word), `${text}: ${r.error}`);
    assert.ok(!('model' in r) && !('effort' in r), text);
  }
  const folder = userModels(t, null);
  mkdirSync(folder);
  const r = readUserModels(folder);
  assert.ok(r.error.startsWith(`${folder}: `) && r.error.includes('read') && !r.error.includes('\n'), r.error);
  assert.ok(!('model' in r));
});

test('user models: the stage key beats default, default beats the built-in, model and effort apart', () => {
  const builtin = { model: 'opus', effort: 'high' };
  assert.deepEqual(resolveUser({ model: {}, effort: {} }, 'do', builtin), builtin);
  const cfg = { model: { default: 'sonnet', do: 'haiku' }, effort: { default: 'low', check: 'max' } };
  assert.deepEqual(resolveUser(cfg, 'do', builtin), { model: 'haiku', effort: 'low' });
  assert.deepEqual(resolveUser(cfg, 'check', builtin), { model: 'sonnet', effort: 'max' });
  assert.deepEqual(resolveUser({ model: { plan: 'opus' }, effort: {} }, 'plan', { model: 'x', effort: 'medium' }), { model: 'opus', effort: 'medium' });
});

test('user models: an opinion key takes its own value, else the built-in, never default', () => {
  const builtin = { model: 'opus', effort: 'high' };
  assert.deepEqual(resolveOwn({ model: { default: 'sonnet' }, effort: { default: 'low' } }, 'second-opinion', builtin), builtin);
  const cfg = { model: { default: 'sonnet', 'second-opinion': 'haiku' }, effort: { default: 'low', 'codex-opinion': 'minimal' } };
  assert.deepEqual(resolveOwn(cfg, 'second-opinion', builtin), { model: 'haiku', effort: 'high' });
  assert.deepEqual(resolveOwn(cfg, 'codex-opinion', { model: '', effort: 'xhigh' }), { model: '', effort: 'minimal' });
});

// A temporary config folder holding am/settings.json with text (or nothing when text is null); returns the file's path.
function userSettings(t, text) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'am-user-settings-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = userSettingsFile({ CLAUDE_CONFIG_DIR: dir });
  mkdirSync(path.dirname(file), { recursive: true });
  if (text !== null) writeFileSync(file, text);
  return file;
}

test('user settings: the file lives under the config folder, else under ~/.claude', () => {
  const dir = path.join(os.tmpdir(), 'cfg');
  assert.equal(userSettingsFile({ CLAUDE_CONFIG_DIR: dir }), path.join(dir, 'am', 'settings.json'));
  assert.equal(userSettingsFile({}), path.join(os.homedir(), '.claude', 'am', 'settings.json'));
});

test('user settings: the module reads no environment variable and imports only node built-ins', () => {
  const src = readFileSync(path.join(REPO, 'plugin', 'scripts', 'user-settings.mjs'), 'utf8');
  assert.ok(!src.includes('process.env'));
  const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
  assert.ok(imports.length > 0);
  for (const name of imports) assert.ok(name.startsWith('node:'), name);
});

test('user settings: a missing file or key is null; a number of 0 or more is kept, notes are dropped and a BOM is allowed', (t) => {
  assert.deepEqual(readUserSettings(userSettings(t, null)), { minFreeMemoryMB: null });
  assert.deepEqual(readUserSettings(userSettings(t, '{}')), { minFreeMemoryMB: null });
  assert.deepEqual(readUserSettings(userSettings(t, '{"minFreeMemoryMB":null}')), { minFreeMemoryMB: null });
  assert.deepEqual(readUserSettings(userSettings(t, '﻿' + JSON.stringify({ _note: 'mine', minFreeMemoryMB: 6144 }))), { minFreeMemoryMB: 6144 });
  assert.deepEqual(readUserSettings(userSettings(t, '{"minFreeMemoryMB":0}')), { minFreeMemoryMB: 0 });
  assert.deepEqual(readUserSettings(userSettings(t, '{"minFreeMemoryMB":6144.5}')), { minFreeMemoryMB: 6144.5 });
});

test('user settings: every broken file is one error line naming the file and the problem', (t) => {
  const cases = [
    ['{"minFreeMemoryMB":', 'JSON'],
    ['', 'JSON'],
    ['[]', 'object'],
    ['6144', 'object'],
    ['{"minFreeMemoryMB":-1}', '-1'],
    ['{"minFreeMemoryMB":"6GB"}', '"6GB"'],
    ['{"minFreeMemoryMB":true}', 'minFreeMemoryMB'],
    ['{"minFreeMemoryMB":1e400}', 'finite'],
    ['{"minFreeMemoryMb":6144}', '"minFreeMemoryMb"'],
    ['{"model":{}}', '"model"'],
  ];
  for (const [text, word] of cases) {
    const file = userSettings(t, text);
    const r = readUserSettings(file);
    assert.equal(typeof r.error, 'string', text);
    assert.ok(!r.error.includes('\n'), text);
    assert.ok(r.error.startsWith(`${file}: `), text);
    assert.ok(r.error.includes(word), `${text}: ${r.error}`);
    assert.ok(!('minFreeMemoryMB' in r), text);
  }
  const folder = userSettings(t, null);
  mkdirSync(folder);
  const r = readUserSettings(folder);
  assert.ok(r.error.startsWith(`${folder}: `) && r.error.includes('read') && !r.error.includes('\n'), r.error);
  assert.ok(!('minFreeMemoryMB' in r));
});

// A temporary config folder (nothing in it); removed after the test.
function configDir(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'am-user-files-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// The template with the `_` removed from every stage key inside model and effort.
const enableNotes = (text) => {
  const data = JSON.parse(text);
  for (const part of ['model', 'effort']) data[part] = Object.fromEntries(Object.entries(data[part]).map(([k, v]) => [k.replace(/^_/, ''), v]));
  return JSON.stringify(data);
};

test('user files: the module reads no environment variable and imports only node built-ins and its sibling modules', () => {
  const src = readFileSync(path.join(REPO, 'plugin', 'scripts', 'user-files.mjs'), 'utf8');
  assert.ok(!src.includes('process.env'));
  const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
  assert.ok(imports.length > 0);
  for (const name of imports) assert.ok(name.startsWith('node:') || ['./user-models.mjs', './user-settings.mjs', './memory-guard.mjs'].includes(name), name);
});

test('user files: the templates read as no setting, carry every built-in value as a note and follow the user models keys', (t) => {
  const models = modelsTemplate();
  const settings = settingsTemplate();
  assert.ok(models.endsWith('}\n') && settings.endsWith('}\n'));
  assert.deepEqual(readUserModels(userModels(t, models)), { model: {}, effort: {} });
  assert.deepEqual(readUserSettings(userSettings(t, settings)), { minFreeMemoryMB: null });
  const data = JSON.parse(models);
  assert.ok(Array.isArray(data._about) && data._about.length > 0);
  for (const [key, v] of Object.entries(BUILTIN_MODELS)) {
    assert.equal(data.model[`_${key}`], v.model, key);
    assert.equal(data.effort[`_${key}`], v.effort, key);
  }
  assert.ok(Object.hasOwn(JSON.parse(settings), 'minFreeMemoryMB'));
  assert.deepEqual(Object.keys(BUILTIN_MODELS), USER_MODEL_KEYS.filter((k) => k !== 'default'));
  assert.deepEqual(readUserModels(userModels(t, enableNotes(models))), {
    model: Object.fromEntries(Object.entries(BUILTIN_MODELS).map(([k, v]) => [k, v.model])),
    effort: Object.fromEntries(Object.entries(BUILTIN_MODELS).map(([k, v]) => [k, v.effort])),
  });
  const noCodex = modelsTemplate({ ...BUILTIN_MODELS, 'codex-opinion': { model: '', effort: 'high' } });
  assert.ok(!Object.hasOwn(JSON.parse(noCodex).model, '_codex-opinion'));
  assert.ok(JSON.parse(noCodex)._about.some((line) => line.includes('codex config')));
  const r = readUserModels(userModels(t, enableNotes(noCodex)));
  assert.ok(!r.error && !('codex-opinion' in r.model) && r.effort['codex-opinion'] === 'high', JSON.stringify(r));
});

test('user files: missing files are created once with the templates; an existing file is kept byte for byte', (t) => {
  const dir = configDir(t);
  const env = { CLAUDE_CONFIG_DIR: dir };
  const [modelsFile, settingsFile] = [userModelsFile(env), userSettingsFile(env)];
  assert.deepEqual(ensureUserFiles(env), [modelsFile, settingsFile]);
  assert.equal(readFileSync(modelsFile, 'utf8'), modelsTemplate());
  assert.equal(readFileSync(settingsFile, 'utf8'), settingsTemplate());
  assert.deepEqual(ensureUserFiles(env), []);
  assert.deepEqual(readdirSync(path.join(dir, 'am')).sort(), ['models.json', 'settings.json']);

  const dir2 = configDir(t);
  const env2 = { CLAUDE_CONFIG_DIR: dir2 };
  mkdirSync(path.join(dir2, 'am'));
  writeFileSync(userModelsFile(env2), '{"model":');
  assert.deepEqual(ensureUserFiles(env2), [userSettingsFile(env2)]);
  assert.equal(readFileSync(userModelsFile(env2), 'utf8'), '{"model":');
  assert.equal(readFileSync(userSettingsFile(env2), 'utf8'), settingsTemplate());
  assert.deepEqual(readdirSync(path.join(dir2, 'am')).sort(), ['models.json', 'settings.json']);
});

test('user files: nothing is made when the config folder is missing or am is a file', (t) => {
  const missing = path.join(configDir(t), 'none');
  assert.deepEqual(ensureUserFiles({ CLAUDE_CONFIG_DIR: missing }), []);
  assert.ok(!existsSync(missing));
  assert.deepEqual(ensureUserFiles(), []);
  const dir = configDir(t);
  writeFileSync(path.join(dir, 'am'), 'mine');
  assert.deepEqual(ensureUserFiles({ CLAUDE_CONFIG_DIR: dir }), []);
  assert.equal(readFileSync(path.join(dir, 'am'), 'utf8'), 'mine');
});

test('user files: without hard links the files are written directly; other link errors make nothing; no temp file is left', (t) => {
  const fail = (code) => () => {
    throw Object.assign(new Error(code), { code });
  };
  const dir = configDir(t);
  const env = { CLAUDE_CONFIG_DIR: dir };
  assert.deepEqual(ensureUserFiles(env, { link: fail('ENOTSUP') }), [userModelsFile(env), userSettingsFile(env)]);
  assert.equal(readFileSync(userModelsFile(env), 'utf8'), modelsTemplate());
  assert.equal(readFileSync(userSettingsFile(env), 'utf8'), settingsTemplate());
  assert.deepEqual(readdirSync(path.join(dir, 'am')).sort(), ['models.json', 'settings.json']);

  const dir2 = configDir(t);
  assert.deepEqual(ensureUserFiles({ CLAUDE_CONFIG_DIR: dir2 }, { link: fail('EACCES') }), []);
  assert.deepEqual(readdirSync(path.join(dir2, 'am')), []);

  // Another session writes the file between the failed link and the direct write: its file stays.
  const dir3 = configDir(t);
  const env3 = { CLAUDE_CONFIG_DIR: dir3 };
  const race = (tmp, file) => {
    writeFileSync(file, 'other');
    fail('ENOTSUP')();
  };
  assert.deepEqual(ensureUserFiles(env3, { link: race }), []);
  assert.equal(readFileSync(userModelsFile(env3), 'utf8'), 'other');
  assert.equal(readFileSync(userSettingsFile(env3), 'utf8'), 'other');
  assert.deepEqual(readdirSync(path.join(dir3, 'am')).sort(), ['models.json', 'settings.json']);
});

test('user files: a temp file that cannot be removed does not throw', (t) => {
  const env = { CLAUDE_CONFIG_DIR: configDir(t) };
  const rm = () => {
    throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
  };
  assert.deepEqual(ensureUserFiles(env, { rm }), [userModelsFile(env), userSettingsFile(env)]);
  assert.equal(readFileSync(userModelsFile(env), 'utf8'), modelsTemplate());
});

// A temporary record folder; the records pushed to the returned list are released before the folder is removed.
function recordDir(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'am-memory-guard-'));
  const held = [];
  t.after(() => {
    for (const r of held) r.release();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, held };
}
// Waits until check() is true, at most 2 seconds, and tells whether it is.
const within2s = async (check) => {
  await until(check, 2000);
  return check();
};
const MB = 1048576;

test('memory guard: the module reads no environment variable and imports only node built-ins', () => {
  const src = readFileSync(path.join(REPO, 'plugin', 'scripts', 'memory-guard.mjs'), 'utf8');
  assert.ok(!src.includes('process.env'));
  const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
  assert.ok(imports.length > 0);
  for (const name of imports) assert.ok(name.startsWith('node:'), name);
});

test('memory guard: the built-in 6144 MB holds on win32 only, a set value on every OS, 0 is off and nothing waits alone', () => {
  const short = (setting, platform, freeMB, busy = 1) => memoryShortMB({ busy, freeBytes: freeMB * MB, setting, platform });
  assert.deepEqual(short(undefined, 'win32', 1000), { freeMB: 1000, needMB: 6144 });
  assert.deepEqual(short(null, 'win32', 6143), { freeMB: 6143, needMB: 6144 });
  assert.equal(short(null, 'win32', 6144), null);
  for (const platform of ['darwin', 'linux']) assert.equal(short(undefined, platform, 1000), null, platform);
  for (const platform of ['win32', 'darwin', 'linux']) {
    assert.deepEqual(short(500, platform, 400), { freeMB: 400, needMB: 500 }, platform);
    assert.deepEqual(short('500', platform, 400), { freeMB: 400, needMB: 500 }, platform);
    assert.equal(short(500, platform, 500), null, platform);
    assert.equal(short(0, platform, 0), null, platform);
  }
  for (const busy of [0, -1]) assert.equal(short(500, 'darwin', 0, busy), null, String(busy));
  for (const bad of ['6GB', -1, '', ' ']) {
    assert.deepEqual(short(bad, 'win32', 1000), { freeMB: 1000, needMB: 6144 }, String(bad));
    assert.equal(short(bad, 'darwin', 1000), null, String(bad));
  }
});

test('memory guard: recordHeld frees a dead same-host pid and a record untouched past staleMs, and waits after a wake', () => {
  const now = 10 * 60000;
  const alive = (pid) => pid === 1;
  const o = { now, myHost: 'me', alive };
  assert.equal(recordHeld({ host: 'me', pid: 1, mtimeMs: now - 1000 }, o), true);
  assert.equal(recordHeld({ host: 'me', pid: 2, mtimeMs: now - 1000 }, o), false);
  assert.equal(recordHeld({ host: 'other', pid: 2, mtimeMs: now - 1000 }, o), true);
  assert.equal(recordHeld({ host: 'other', pid: 2, mtimeMs: now - 6 * 60000 }, o), false);
  assert.equal(recordHeld({ host: 'me', pid: 1, mtimeMs: now - 6 * 60000 }, o), false);
  assert.equal(recordHeld({ host: 'other', pid: 2, mtimeMs: now - 6 * 60000 }, { ...o, woke: true }), true);
  assert.equal(recordHeld({ host: 'me', pid: 2, mtimeMs: now }, { ...o, woke: true }), false);
  assert.equal(recordHeld({ host: 'me', pid: 1, mtimeMs: now - 6 * 60000 }, { ...o, young: true }), true);
  assert.equal(recordHeld({ host: 'other', pid: 1, mtimeMs: now - 6 * 60000 }, { ...o, young: true }), false);
  assert.equal(recordHeld({ host: 'other', pid: 2, mtimeMs: now - 2000 }, { ...o, staleMs: 1000 }), false);
  assert.equal(recordHeld({ host: 'other', pid: 2, mtimeMs: now - 4 * 60000 }, { ...o, staleMs: 4 * 60000 }), true);
});

test('memory guard: the record folder lives under the config folder, else under ~/.claude', () => {
  const dir = path.join(os.tmpdir(), 'cfg');
  assert.equal(sessionsDirOf({ CLAUDE_CONFIG_DIR: dir }), path.join(dir, 'am-orchestrator', 'sessions'));
  assert.equal(sessionsDirOf({}), path.join(os.homedir(), '.claude', 'am-orchestrator', 'sessions'));
});

test('memory guard: liveRecords returns only live records with a matching name and removes nothing', (t) => {
  const { dir } = recordDir(t);
  const names = ['me~1~1.gate.json', 'other~2~3.json', 'h~1.json', 'h~x~1.json', 'h~1~doctor.tmp', 'me~2~1.json', 'other~5~1.gate.json', 'me~1~2.json'];
  for (const n of names) writeFileSync(path.join(dir, n), '{}\n');
  const now = Date.now();
  const old = (now - 6 * 60000) / 1000;
  for (const n of ['other~5~1.gate.json', 'me~1~2.json']) utimesSync(path.join(dir, n), old, old);
  const o = { now, alive: (pid) => pid === 1, myHost: 'me', young: false, staleMs: 5 * 60000 };
  const found = (opts) => liveRecords(dir, opts).sort((a, b) => a.file.localeCompare(b.file));
  assert.deepEqual(found(o), [
    { file: path.join(dir, 'me~1~1.gate.json'), host: 'me', pid: 1, gate: true },
    { file: path.join(dir, 'other~2~3.json'), host: 'other', pid: 2, gate: false },
  ]);
  assert.deepEqual(found({ ...o, young: true }).map((r) => path.basename(r.file)), ['me~1~1.gate.json', 'me~1~2.json', 'other~2~3.json']);
  assert.deepEqual(readdirSync(dir).sort(), [...names].sort());
  assert.deepEqual(liveRecords(path.join(dir, 'missing')), []);
});

test('memory guard: holdRecord writes a .gate record, keeps it fresh, writes it again when removed and stops after release', async (t) => {
  const { dir: root, held } = recordDir(t);
  const dir = path.join(root, 'sessions');
  const rec = holdRecord({ kind: 'x' }, { dir, heartbeatMs: 20 });
  held.push(rec);
  assert.equal(rec.written, true);
  assert.equal(path.dirname(rec.file), dir);
  const m = RECORD_NAME.exec(path.basename(rec.file));
  assert.ok(m, rec.file);
  assert.equal(m[1], hostName());
  assert.equal(m[2], String(process.pid));
  assert.equal(m[3], '.gate');
  const content = JSON.parse(readFileSync(rec.file, 'utf8'));
  assert.equal(content.pid, process.pid);
  assert.equal(content.host, os.hostname());
  assert.equal(content.kind, 'x');
  assert.ok(!Number.isNaN(Date.parse(content.startedAt)), content.startedAt);
  const hourAgo = (Date.now() - 3600000) / 1000;
  utimesSync(rec.file, hourAgo, hourAgo);
  assert.ok(await within2s(() => statSync(rec.file).mtimeMs > hourAgo * 1000 + 60000), 'touched again');
  rmSync(rec.file);
  assert.ok(await within2s(() => existsSync(rec.file)), 'written again');
  rec.release();
  assert.equal(existsSync(rec.file), false);
  await new Promise((res) => setTimeout(res, 200));
  assert.equal(existsSync(rec.file), false, 'not written again after release');
  rec.release();
});

test('memory guard: a released record that could not be removed is not counted', (t) => {
  const { dir, held } = recordDir(t);
  const other = holdRecord({}, { dir });
  held.push(other);
  const rec = holdRecord({}, { dir });
  rmSync(rec.file);
  mkdirSync(rec.file); // a folder of the same name: removing it fails
  rec.release();
  assert.ok(existsSync(rec.file));
  const o = { now: Date.now(), alive: () => true, myHost: hostName(), young: false, staleMs: 5 * 60000 };
  assert.deepEqual(liveRecords(dir, o).map((r) => r.file), [other.file]);
});

test('memory guard: a folder that cannot be written does not throw, and the record appears once it can', async (t) => {
  const { dir: root, held } = recordDir(t);
  const dir = path.join(root, 'blocked');
  writeFileSync(dir, 'a file where the folder should be');
  const rec = holdRecord({}, { dir, heartbeatMs: 20 });
  held.push(rec);
  assert.equal(rec.written, false);
  rmSync(dir);
  assert.ok(await within2s(() => existsSync(rec.file)), 'written by the timer');
});

test('memory guard: holdRecord and liveRecords need a folder', () => {
  assert.throws(() => holdRecord({}), /dir/);
  assert.throws(() => liveRecords(), /dir/);
});

test('memory guard: records still held when the process exits are removed, with one exit handler', (t) => {
  const { dir: root } = recordDir(t);
  const dir = path.join(root, 'sessions');
  const script = path.join(root, 'child.mjs');
  writeFileSync(
    script,
    `import { readdirSync } from 'node:fs';
import { holdRecord } from ${JSON.stringify(pathToFileURL(path.join(REPO, 'plugin', 'scripts', 'memory-guard.mjs')).href)};
const dir = process.argv[2];
const before = process.listenerCount('exit');
holdRecord({ kind: 'a' }, { dir });
holdRecord({ kind: 'b' }, { dir });
console.log(JSON.stringify({ added: process.listenerCount('exit') - before, files: readdirSync(dir).length }));
`,
  );
  const r = spawnSync(process.execPath, [script, dir], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { added: 1, files: 2 });
  assert.deepEqual(readdirSync(dir), []);
});

const cfgEnv = (file) => ({ ...process.env, CLAUDE_CONFIG_DIR: path.dirname(path.dirname(file)) });
const COMPACTING = { replies: ['Shortened.\nAM_STAGE: COMPACTED', 'Implemented.\nAM_STAGE: DONE'], writes: [{ '.am/demo/plan.md': SHORT }] };

test('a broken user models file ends every stage before any session or start line', async (t) => {
  const cases = [
    ['{"model":', 'JSON'],
    ['{"model":{"implement":"opus"}}', '"do"'],
    ['{"effort":{"check":"huge"}}', 'huge'],
  ];
  for (const [text, word] of cases) {
    for (const [stage, opts] of [['check', { plan: SMALL }], ['plan', { fake: PLANNED }]]) {
      const file = userModels(t, text);
      const dir = makeRepo(t, opts);
      const { code, result, calls } = await run(dir, [stage, 'demo'], { env: cfgEnv(file) });
      assert.equal(code, 0);
      assert.equal(calls.length, 0, `${stage} ${text}`);
      assert.equal(result.status, 'failed');
      assert.ok(result.reason.startsWith('the user model settings cannot be used (fix or remove the file): '), result.reason);
      assert.ok(result.reason.includes(file) && result.reason.includes(word), result.reason);
      assert.ok(!existsSync(path.join(dir, '.am', 'demo', 'progress.jsonl')), 'no start line');
    }
  }
});

test('without a user models file the compaction session keeps COMPACT_MODEL and leaves no setting note', async (t) => {
  const file = userModels(t, null);
  const dir = makeRepo(t, { plan: BIG, fake: COMPACTING });
  const { result, calls } = await run(dir, ['do', 'demo'], { env: cfgEnv(file) });
  assert.equal(result.status, 'DONE');
  assert.equal(flag(calls[0], '--model'), COMPACT_MODEL.model);
  assert.equal(flag(calls[0], '--effort'), COMPACT_MODEL.effort);
  assert.ok(!calls[1].includes('--model') && !calls[1].includes('--effort'));
  assert.ok(!events(dir).some((e) => e.text.includes("from the user's setting")));
});

test("the compaction session runs on the user file's compact value, else its default, and notes it", async (t) => {
  const file = userModels(t, '{"model":{"compact":"sonnet"}}');
  const dir = makeRepo(t, { plan: BIG, fake: COMPACTING });
  const { result, calls } = await run(dir, ['do', 'demo'], { env: cfgEnv(file) });
  assert.equal(result.status, 'DONE');
  assert.equal(flag(calls[0], '--model'), 'sonnet');
  assert.equal(flag(calls[0], '--effort'), COMPACT_MODEL.effort);
  assert.ok(!calls[1].includes('--model') && !calls[1].includes('--effort'));
  const list = events(dir);
  assert.deepEqual(evs(list), ['start', 'note', 'note', 'note', 'end']);
  assert.equal(list[1].text, 'shortening .am/demo/plan.md before the stage');
  assert.equal(list[2].text, `model sonnet, effort ${COMPACT_MODEL.effort} from the user's setting ${file}`);
  assert.match(list[3].text, /^shortened /);

  const def = userModels(t, '{"model":{"default":"haiku"},"effort":{"default":"low"}}');
  const d = makeRepo(t, { plan: BIG, fake: COMPACTING });
  const r = await run(d, ['do', 'demo'], { env: cfgEnv(def) });
  assert.equal(flag(r.calls[0], '--model'), 'haiku');
  assert.equal(flag(r.calls[0], '--effort'), 'low');
  assert.ok(events(d).some((e) => e.text === `model haiku, effort low from the user's setting ${def}`));
});

test('a user value equal to COMPACT_MODEL leaves no note; without a compaction there is no session and no note', async (t) => {
  const same = userModels(t, JSON.stringify({ model: { compact: COMPACT_MODEL.model }, effort: { compact: COMPACT_MODEL.effort } }));
  const dir = makeRepo(t, { plan: BIG, fake: COMPACTING });
  const { calls } = await run(dir, ['do', 'demo'], { env: cfgEnv(same) });
  assert.equal(flag(calls[0], '--model'), COMPACT_MODEL.model);
  assert.deepEqual(evs(events(dir)), ['start', 'note', 'note', 'end']);

  const file = userModels(t, '{"model":{"compact":"sonnet"}}');
  const small = makeRepo(t, { plan: SMALL, fake: { replies: ['AM_STAGE: DONE'] } });
  const r = await run(small, ['do', 'demo'], { env: cfgEnv(file) });
  assert.equal(r.result.status, 'DONE');
  assert.equal(r.calls.length, 1);
  assert.ok(!r.calls[0].includes('--model'));
  assert.deepEqual(evs(events(small)), ['start', 'end']);
});

// ------------------------------------------------------------------ stage sessions on the user's values (inline call)

const AM = path.join(REPO, 'plugin');
const skillText = (skill) => readFileSync(path.join(AM, 'skills', skill, 'SKILL.md'), 'utf8');
const skillFile = (dir, kind) => path.join(dir, '.am', 'demo', `skill-${kind}.md`);
/** A temporary am folder holding skills/<skill>/SKILL.md with text. */
function fakeAm(t, skill, text) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'am-root-$x-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, 'skills', skill), { recursive: true });
  writeFileSync(path.join(dir, 'skills', skill, 'SKILL.md'), text);
  return dir;
}
const assertInline = (body) => {
  assert.ok(!body.startsWith('---') && !body.includes('$ARGUMENTS') && !body.includes('${CLAUDE_'), body.slice(0, 200));
};

test('skillDefaults reads the frontmatter exactly; inlineSkill drops it and fills the placeholders', (t) => {
  const check = /^model: (.+)$/m.exec(skillText('check'))[1];
  assert.deepEqual(skillDefaults(AM, 'check'), { model: check, effort: /^effort: (.+)$/m.exec(skillText('check'))[1] });
  const crlf = fakeAm(t, 'check', '---\r\nname: check\r\nmodel: "opus"  \r\neffort: \'high\'\r\n---\r\nTarget: $ARGUMENTS\r\nRun ${CLAUDE_PLUGIN_ROOT}/hooks/gate.mjs\r\n');
  assert.deepEqual(skillDefaults(crlf, 'check'), { model: 'opus', effort: 'high' });
  const body = inlineSkill(readFileSync(path.join(crlf, 'skills', 'check', 'SKILL.md'), 'utf8'), 'demo', crlf);
  assertInline(body);
  assert.ok(body.includes('Target: demo'));
  assert.ok(body.includes(`Run ${crlf.split(path.sep).join('/')}/hooks/gate.mjs`), 'a $ in the am folder stays as it is');
  const missing = skillDefaults(path.join(crlf, 'nowhere'), 'check');
  assert.ok(missing.error.startsWith(path.join(crlf, 'nowhere', 'skills', 'check', 'SKILL.md')) && !missing.error.includes('\n'), missing.error);
  const noEffort = fakeAm(t, 'check', '---\nmodel: sonnet\n---\nbody\n');
  const r = skillDefaults(noEffort, 'check');
  assert.ok(r.error.includes(path.join(noEffort, 'skills', 'check', 'SKILL.md')) && r.error.includes('effort') && !r.error.includes('\n'), r.error);
  assert.ok(skillDefaults(fakeAm(t, 'check', 'no frontmatter\n'), 'check').error.includes('frontmatter'));
  const plan = inlineSkill(skillText('plan'), 'Read the request in .am/demo/request.md (slug demo)', AM);
  assertInline(plan);
  assert.ok(plan.includes('Request: Read the request in .am/demo/request.md (slug demo)'));
  assert.equal(inlinePrompt('demo', 'check', 'am:check'), 'Follow the instructions in .am/demo/skill-check.md exactly. They are the am:check skill, invoked by the user with the arguments already filled in.');
});

test('the plan and memory stages allow the Codex command exactly as an inline skill body writes it', () => {
  const roots = [AM, ...(process.platform === 'win32' ? ['C:\\Users\\me\\.claude\\plugins\\cache\\am-workflow\\am\\0.1.28'] : [])];
  for (const stage of ['plan', 'compactmem']) {
    for (const root of roots) {
      const body = inlineSkill(skillText(stage), 'x', root);
      const file = /node "([^"]+codex-opinion\.mjs)"/.exec(body)[1];
      assert.equal(file, `${root.split(path.sep).join('/')}/scripts/codex-opinion.mjs`);
      for (const opts of [{ amRoot: root }, { amRoot: path.join(os.tmpdir(), 'other-am'), installedAm: [root] }]) {
        const { allow } = permissions(stage, opts);
        assert.ok(allow.includes(`Bash(node "${file}" *)`) && allow.includes(`Bash(node ${file} *)`), `${stage}: ${root}`);
      }
    }
  }
});

test('a stage the user file gives another value runs inline with --model and --effort, and notes it', async (t) => {
  // default only: the effort stays the frontmatter's.
  const def = userModels(t, '{"model":{"default":"sonnet"}}');
  const dir = makeRepo(t, { plan: SMALL, fake: { replies: ['AM_STAGE: NOTE'] } });
  const { result, calls } = await run(dir, ['check', 'demo'], { env: cfgEnv(def) });
  assert.equal(result.status, 'NOTE');
  assert.equal(calls[0][1], inlinePrompt('demo', 'check', 'am:check'));
  assert.equal(flag(calls[0], '--model'), 'sonnet');
  assert.equal(flag(calls[0], '--effort'), skillDefaults(AM, 'check').effort);
  assert.ok(readFileSync(skillFile(dir, 'check'), 'utf8').includes('Target: demo'));
  assert.deepEqual(evs(events(dir)), ['start', 'note', 'end']);
  assert.equal(events(dir)[1].text, `model sonnet, effort ${skillDefaults(AM, 'check').effort} from the user's setting ${def}`);

  // A stage key: only that stage changes.
  const key = userModels(t, '{"effort":{"plan":"max"}}');
  const planned = makeRepo(t, { fake: PLANNED });
  const p = await run(planned, ['plan', 'demo'], { env: cfgEnv(key) });
  assert.equal(p.result.status, 'READY');
  assert.equal(flag(p.calls[0], '--model'), skillDefaults(AM, 'plan').model);
  assert.equal(flag(p.calls[0], '--effort'), 'max');
  assert.ok(readFileSync(skillFile(planned, 'plan'), 'utf8').includes('Request: Read the request in .am/demo/request.md (slug demo)'));
  const other = makeRepo(t, { plan: SMALL, fake: { replies: ['AM_STAGE: NOTE'] } });
  const o = await run(other, ['check', 'demo'], { env: cfgEnv(key) });
  assert.equal(o.calls[0][1], '/am:check demo');
  assert.ok(!o.calls[0].includes('--model') && !o.calls[0].includes('--effort'));
  assert.ok(!existsSync(skillFile(other, 'check')));
});

test('user values equal to the frontmatter keep the slash call; an unreadable frontmatter fails before any session', async (t) => {
  const same = userModels(t, JSON.stringify({ model: { check: skillDefaults(AM, 'check').model }, effort: { check: skillDefaults(AM, 'check').effort } }));
  const dir = makeRepo(t, { plan: SMALL, fake: { replies: ['AM_STAGE: NOTE'] } });
  const { calls } = await run(dir, ['check', 'demo'], { env: cfgEnv(same) });
  assert.equal(calls[0][1], '/am:check demo');
  assert.ok(!calls[0].includes('--model'));
  assert.ok(!existsSync(skillFile(dir, 'check')));
  assert.deepEqual(evs(events(dir)), ['start', 'end']);

  // The opinion keys never change a stage session.
  const opinion = userModels(t, '{"model":{"second-opinion":"sonnet","codex-opinion":"gpt-5"},"effort":{"second-opinion":"max","codex-opinion":"minimal"}}');
  const op = makeRepo(t, { plan: SMALL, fake: { replies: ['AM_STAGE: NOTE'] } });
  const o = await run(op, ['check', 'demo'], { env: cfgEnv(opinion) });
  assert.equal(o.result.status, 'NOTE');
  assert.equal(o.calls[0][1], '/am:check demo');
  assert.ok(!o.calls[0].includes('--model') && !o.calls[0].includes('--effort'));
  assert.deepEqual(evs(events(op)), ['start', 'end']);

  // The values compared are read from the frontmatter, not from a table.
  const def = userModels(t, '{"model":{"default":"sonnet"}}');
  const sonnet = fakeAm(t, 'check', '---\nmodel: sonnet\neffort: high\n---\nTarget: $ARGUMENTS\n');
  const s = makeRepo(t, { plan: SMALL, fake: { replies: ['AM_STAGE: NOTE'] } });
  const r = await run(s, ['check', 'demo'], { env: cfgEnv(def), amRoot: sonnet });
  assert.equal(r.calls[0][1], '/am:check demo');
  assert.ok(!r.calls[0].includes('--model'));
  const broken = fakeAm(t, 'check', '---\nmodel: sonnet\n---\nTarget: $ARGUMENTS\n');
  const b = makeRepo(t, { plan: SMALL, fake: { replies: ['AM_STAGE: NOTE'] } });
  const f = await run(b, ['check', 'demo'], { env: cfgEnv(def), amRoot: broken });
  assert.equal(f.calls.length, 0);
  assert.equal(f.result.status, 'failed');
  assert.ok(f.result.reason.startsWith("the skill's model and effort cannot be read: ") && f.result.reason.includes(path.join(broken, 'skills', 'check', 'SKILL.md')) && f.result.reason.includes('effort'), f.result.reason);
  assert.deepEqual(evs(events(b)), ['start', 'end']);
});

test('the second ask of an inline stage carries the same flags', async (t) => {
  const file = userModels(t, '{"model":{"check":"sonnet"}}');
  const dir = makeRepo(t, { plan: SMALL, fake: { replies: ['Checked.', 'AM_STAGE: NOTE'] } });
  const { result, calls } = await run(dir, ['check', 'demo'], { env: cfgEnv(file) });
  assert.equal(result.status, 'NOTE');
  assert.equal(calls.length, 2);
  for (const c of calls) assert.deepEqual([flag(c, '--model'), flag(c, '--effort')], ['sonnet', 'high']);
  assert.equal(flag(calls[1], '--resume'), 'sess-1');
});

test('the inline file is written after a compaction; --fix and commit run inline too; a hand-over without its run skill fails', async (t) => {
  const file = userModels(t, '{"model":{"do":"sonnet","commit":"sonnet"}}');
  const dir = makeRepo(t, { plan: BIG, fake: { ...COMPACTING, writes: [{ '.am/demo/plan.md': SHORT, '.am/demo/skill-do.md': 'stale' }] } });
  const { result, calls } = await run(dir, ['do', 'demo'], { env: cfgEnv(file) });
  assert.equal(result.status, 'DONE');
  assert.equal(flag(calls[0], '--model'), COMPACT_MODEL.model, 'the compaction keeps its own value');
  assert.equal(flag(calls[1], '--model'), 'sonnet');
  assert.ok(readFileSync(skillFile(dir, 'do'), 'utf8').includes('Plan: demo'));
  const list = events(dir);
  assert.deepEqual(evs(list), ['start', 'note', 'note', 'note', 'end']);
  assert.match(list[1].text, /^shortening /);
  assert.match(list[2].text, /^shortened /);
  assert.equal(list[3].text, `model sonnet, effort ${skillDefaults(AM, 'do').effort} from the user's setting ${file}`);

  const fixed = makeRepo(t, { plan: SMALL, fake: { replies: ['AM_STAGE: DONE'] } });
  writeFileSync(path.join(fixed, '.am', 'demo', 'check.md'), 'Verdict: BLOCK\n');
  const fx = await run(fixed, ['do', 'demo', '--fix'], { env: cfgEnv(file) });
  assert.equal(fx.calls[0][1], inlinePrompt('demo', 'do', 'am:do'));
  assert.equal(flag(fx.calls[0], '--model'), 'sonnet');

  for (const [flags, notes] of [[[], /^Notes: \r?$/m], [['--push'], /^Notes: push\r?$/m]]) {
    const c = makeRepo(t, { plan: SMALL, fake: { replies: ['AM_STAGE: COMMITTED'] } });
    const r = await run(c, ['commit', 'demo', ...flags], { env: cfgEnv(file) });
    assert.equal(r.calls[0][1], inlinePrompt('demo', 'commit', 'am:commit'));
    assert.match(readFileSync(skillFile(c, 'commit'), 'utf8'), notes);
  }

  const def = userModels(t, '{"model":{"default":"sonnet"}}');
  const hand = makeRepo(t, { plan: LARGE, fake: { replies: ['Run done.\nAM_STAGE: HANDED'] } });
  const h = await run(hand, ['do', 'demo'], { env: cfgEnv(def), orchestrator: () => '/orch' });
  assert.equal(h.result.stage, 'handover');
  assert.equal(h.calls.length, 0);
  assert.equal(h.result.status, 'failed');
  assert.ok(h.result.reason.startsWith("the skill's model and effort cannot be read: ") && h.result.reason.includes(path.join(path.resolve('/orch'), 'skills', 'run', 'SKILL.md')), h.result.reason);
});

// ------------------------------------------------------------------ the hand-over on the user's run value

const ORCH_ROOT = path.join(REPO, 'orchestrator');

test('skillCall names the plugin, skill and arguments of every stage', () => {
  assert.deepEqual(skillCall('handover', 'demo'), { plugin: 'am-orchestrator', skill: 'run', args: '.am/demo/plan.md' });
  assert.deepEqual(skillCall('handover', 'demo', { resume: true }), { plugin: 'am-orchestrator', skill: 'run', args: '' });
  assert.equal(skillCall('commit', 'demo', { push: true }).args, 'push');
  assert.equal(skillCall('nope', 'demo'), null);
});

test('a hand-over the user file gives another run value runs the run skill inline with both flags', async (t) => {
  const file = userModels(t, '{"model":{"run":"sonnet"}}');
  const effort = skillDefaults(ORCH_ROOT, 'run').effort;
  const dir = makeRepo(t, { plan: LARGE, fake: { replies: ['Run done.\nAM_STAGE: HANDED'] } });
  const { result, calls } = await run(dir, ['do', 'demo'], { env: cfgEnv(file), orchestrator: () => ORCH_ROOT + path.sep });
  assert.equal(result.stage, 'handover');
  assert.equal(calls[0][1], inlinePrompt('demo', 'handover', 'am-orchestrator:run'));
  assert.equal(flag(calls[0], '--model'), 'sonnet');
  assert.equal(flag(calls[0], '--effort'), effort);
  const body = readFileSync(skillFile(dir, 'handover'), 'utf8');
  assertInline(body);
  assert.match(body, /^Request: \.am\/demo\/plan\.md\r?$/m);
  const script = `${ORCH_ROOT.split(path.sep).join('/')}/scripts/orchestrator.mjs`;
  assert.ok(body.includes(`node "${script}"`), 'the filled command path');
  assert.ok(flag(calls[0], '--allowedTools').split(',').includes(`Bash(node ${script} *)`));
  const list = events(dir);
  assert.deepEqual(evs(list), ['start', 'note', 'note', 'end']);
  assert.equal(list[1].text, 'handed to the am-orchestrator run skill');
  assert.equal(list[2].text, `model sonnet, effort ${effort} from the user's setting ${file}`);

  // A hand-over that goes on calls the run skill with no arguments.
  const resumed = makeRepo(t, { plan: HANDED_PLAN, fake: { replies: ['Run done.\nAM_STAGE: HANDED'] } });
  const r = await run(resumed, ['do', 'demo'], { env: cfgEnv(file), orchestrator: () => ORCH_ROOT });
  assert.equal(r.calls[0][1], inlinePrompt('demo', 'handover', 'am-orchestrator:run'));
  assert.match(readFileSync(skillFile(resumed, 'handover'), 'utf8'), /^Request: \r?$/m);

  // The second ask carries the same flags.
  const again = makeRepo(t, { plan: LARGE, fake: { replies: ['Run done.', 'AM_STAGE: HANDED'] } });
  const a = await run(again, ['do', 'demo'], { env: cfgEnv(file), orchestrator: () => ORCH_ROOT });
  assert.equal(a.calls.length, 2);
  for (const c of a.calls) assert.equal(flag(c, '--model'), 'sonnet');
  assert.equal(flag(a.calls[1], '--resume'), 'sess-1');
});

test('run values equal to the run skill, or values for other stages only, keep the slash hand-over', async (t) => {
  const own = skillDefaults(ORCH_ROOT, 'run');
  const same = userModels(t, JSON.stringify({ model: { run: own.model }, effort: { run: own.effort } }));
  const dir = makeRepo(t, { plan: LARGE, fake: { replies: ['Run done.\nAM_STAGE: HANDED'] } });
  const { calls } = await run(dir, ['do', 'demo'], { env: cfgEnv(same), orchestrator: () => ORCH_ROOT });
  assert.equal(calls[0][1], '/am-orchestrator:run .am/demo/plan.md');
  assert.ok(!calls[0].includes('--model'));
  assert.ok(!existsSync(skillFile(dir, 'handover')));

  // The run skill's frontmatter is not read when no run or default value is given.
  const other = userModels(t, '{"model":{"check":"sonnet"}}');
  const o = makeRepo(t, { plan: LARGE, fake: { replies: ['Run done.\nAM_STAGE: HANDED'] } });
  const r = await run(o, ['do', 'demo'], { env: cfgEnv(other), orchestrator: () => '/orch' });
  assert.equal(r.calls[0][1], '/am-orchestrator:run .am/demo/plan.md');
  assert.ok(!r.calls[0].includes('--model'));
});

// ------------------------------------------------------------------ the installed am of a new session

test('the plan and memory stages also allow the Codex script of the installed am, and note a different folder', async (t) => {
  const cfg = mkdtempSync(path.join(os.tmpdir(), 'am-stage-inst-'));
  t.after(() => rmSync(cfg, { recursive: true, force: true }));
  const env = { ...isolatedEnv, CLAUDE_CONFIG_DIR: cfg };
  const amRoot = path.join(cfg, 'plugins', 'cache', 'am-workflow', 'am', '0.1.26');
  const installed = path.join(cfg, 'plugins', 'cache', 'am-workflow', 'am', '0.1.30');
  const script = (root) => `${root.split(path.sep).join('/')}/scripts/codex-opinion.mjs`;
  const notes = (dir) => events(dir).filter((e) => e.ev === 'note');

  const dir = makeRepo(t, { fake: PLANNED });
  const { result, calls } = await run(dir, ['plan', 'demo'], { env, amRoot, am: () => [installed] });
  assert.equal(result.status, 'READY');
  const allow = flag(calls[0], '--allowedTools').split(',');
  for (const root of [amRoot, installed]) assert.ok(allow.includes(`Bash(node "${script(root)}" *)`) && allow.includes(`Bash(node ${script(root)} *)`), root);
  assert.ok(!calls[0].includes('--plugin-dir'), 'an installed copy');
  assert.deepEqual(notes(dir).map((e) => e.text), [`this am:auto session runs am from ${amRoot}, but stage sessions load the installed am from ${installed}; the Codex second opinion is allowed for both. Restart the session that runs am:auto to use one version.`]);

  // The same folder (on Windows also in other letter case) gives no note.
  for (const same of [amRoot, ...(process.platform === 'win32' ? [amRoot.toUpperCase()] : [])]) {
    const d = makeRepo(t, { fake: PLANNED });
    await run(d, ['plan', 'demo'], { env, amRoot, am: () => [same] });
    assert.deepEqual(notes(d), [], same);
  }

  // The memory stage gets the same rules.
  const m = makeRepo(t, { plan: SMALL, fake: { replies: ['Proposal saved.\nAM_STAGE: PROPOSED'] } });
  const memCfg = { ...memEnv(t, m), CLAUDE_CONFIG_DIR: cfg };
  mkdirSync(memoryDir(m, memCfg), { recursive: true });
  writeFileSync(path.join(memoryDir(m, memCfg), 'MEMORY.md'), '- [a](a.md)\n');
  const mr = await run(m, ['compactmem', 'demo'], { env: memCfg, amRoot, am: () => [installed] });
  assert.equal(mr.result.status, 'PROPOSED');
  assert.ok(flag(mr.calls[0], '--allowedTools').split(',').includes(`Bash(node ${script(installed)} *)`));
  assert.equal(notes(m).length, 1);

  // No lookup for other stages, for a development copy, or when the memory stage ends without a session; none found keeps the runner's rule only.
  const looked = [];
  const spy = () => (looked.push(1), [installed]);
  await run(makeRepo(t, { plan: SMALL, fake: { replies: ['AM_STAGE: DONE'] } }), ['do', 'demo'], { env, amRoot, am: spy });
  await run(makeRepo(t, { plan: SMALL, fake: { replies: ['AM_STAGE: PASS'] } }), ['check', 'demo'], { env, amRoot, am: spy });
  const devDir = makeRepo(t, { fake: PLANNED });
  const dev = await run(devDir, ['plan', 'demo'], { env, am: spy });
  assert.ok(!flag(dev.calls[0], '--allowedTools').includes(script(installed)));
  const empty = makeRepo(t, { plan: SMALL });
  assert.equal((await run(empty, ['compactmem', 'demo'], { env, amRoot, am: spy })).result.status, 'NOTHING');
  assert.deepEqual(looked, []);
  const noneDir = makeRepo(t, { fake: PLANNED });
  const none = await run(noneDir, ['plan', 'demo'], { env, amRoot, am: () => [] });
  assert.deepEqual(flag(none.calls[0], '--allowedTools').split(',').filter((r) => r.includes('codex-opinion')), permissions('plan', { amRoot }).allow.filter((r) => r.includes('codex-opinion')));
  assert.deepEqual(notes(noneDir), []);
});

// ------------------------------------------------------------------ second-opinion news

const OPINION_LINE = 'C1 저장 방식: 파일 - 이유 (second opinion, Codex agreed)';
const DECISIONS = `## Decisions\n- ${OPINION_LINE}\n- C2 로그 위치: 실행 폴더 - 이유 (no second opinion)\n`;
const opinionSteps = (list) => list.filter((e) => e.ev === 'step');
const planFile = (dir) => path.join(dir, '.am', 'demo', 'plan.md');

test('secondOpinionLines: marked lines without list markers; (no second opinion) is not one', () => {
  assert.ok(SECOND_MARK.test('(Second Opinion)') && !SECOND_MARK.test('(no second opinion)'));
  const text = `# p\n- C1 저장 (second opinion)\n  * C2 형식 (Second Opinion, Codex agreed)\r\n> - C3 위치 (no second opinion)\nplain\n`;
  assert.deepEqual(secondOpinionLines(text), ['C1 저장 (second opinion)', 'C2 형식 (Second Opinion, Codex agreed)']);
  assert.deepEqual(secondOpinionLines(undefined), []);
  assert.equal(OPINION_MS, 5000);
});

test('opinionWatch: lines already there stay quiet, a half line waits for the last read, each line once', (t) => {
  const dir = makeRepo(t, { plan: `# p\n- C0 old (second opinion)\n` });
  const scan = opinionWatch(dir, 'demo', 'do');
  scan(false);
  assert.deepEqual(events(dir), []);
  appendFileSync(planFile(dir), '- C1 new (second opinion)\n- C2 half (second opin');
  scan(false);
  scan(false);
  assert.deepEqual(texts(events(dir)), ['second opinion: C1 new (second opinion)']);
  appendFileSync(planFile(dir), 'ion)');
  scan(false);
  assert.equal(events(dir).length, 1, 'still no newline after the half line');
  scan(true);
  scan(true);
  const list = events(dir);
  assert.deepEqual(texts(list), ['second opinion: C1 new (second opinion)', 'second opinion: C2 half (second opinion)']);
  assert.deepEqual(list.map((e) => [e.ev, e.stage]), [['step', 'do'], ['step', 'do']]);
});

test('opinionWatch: a failed first read only takes the lines at the next read; a missing plan is an empty start', (t) => {
  const dir = makeRepo(t);
  mkdirSync(planFile(dir));
  const scan = opinionWatch(dir, 'demo', 'plan');
  scan(false);
  rmSync(planFile(dir), { recursive: true });
  writeFileSync(planFile(dir), '- C1 before (second opinion)\n');
  scan(false);
  assert.deepEqual(events(dir), [], 'the first good read only takes the lines');
  appendFileSync(planFile(dir), '- C2 after (second opinion)\n');
  scan(false);
  assert.deepEqual(texts(events(dir)), ['second opinion: C2 after (second opinion)']);
  const fresh = makeRepo(t);
  const scanFresh = opinionWatch(fresh, 'demo', 'plan');
  writeFileSync(planFile(fresh), '- C1 (second opinion)\n');
  scanFresh(true);
  assert.deepEqual(texts(events(fresh)), ['second opinion: C1 (second opinion)']);
});

test('a plan stage writes one step per second-opinion line of its plan, before its end', async (t) => {
  const dir = makeRepo(t, { fake: { replies: ['Planned.\nAM_STAGE: READY'], write: { '.am/demo/plan.md': `${SMALL}${DECISIONS}` } } });
  const { result } = await run(dir, ['plan', 'demo']);
  assert.equal(result.status, 'READY');
  const list = events(dir);
  assert.deepEqual(evs(list), ['start', 'step', 'end']);
  const [step] = opinionSteps(list);
  assert.equal(step.text, `second opinion: ${OPINION_LINE}`);
  assert.equal(step.stage, 'plan');
  assert.equal(formatEvent(step), `step: second opinion: ${OPINION_LINE} [stage=plan]`);
});

test('a do stage does not repeat the lines its plan already had', async (t) => {
  const dir = makeRepo(t, { plan: `${SMALL}${DECISIONS}`, fake: { replies: ['AM_STAGE: DONE'] } });
  const { result } = await run(dir, ['do', 'demo']);
  assert.equal(result.status, 'DONE');
  assert.deepEqual(evs(events(dir)), ['start', 'end']);
});

test('a compaction that drops a second-opinion mark is undone; one that keeps it stands', async (t) => {
  const short = SHORT.replace('## 결정\n', `## 결정\n- ${OPINION_LINE}\n`);
  const big = short.replace('## 결정', `- ${FILLER}\n## 결정`);
  const dropped = makeRepo(t, { plan: big, fake: { replies: ['AM_STAGE: COMPACTED', 'AM_STAGE: DONE'], writes: [{ '.am/demo/plan.md': SHORT }] } });
  const r1 = (await run(dropped, ['do', 'demo'])).result;
  assert.match(r1.compacted.failed, /second opinion marks 1 -> 0/);
  assert.equal(plan(dropped), big);
  const kept = makeRepo(t, { plan: big, fake: { replies: ['AM_STAGE: COMPACTED', 'AM_STAGE: DONE'], writes: [{ '.am/demo/plan.md': short }] } });
  const r2 = (await run(kept, ['do', 'demo'])).result;
  assert.ok(r2.compacted.originals, JSON.stringify(r2.compacted));
  assert.equal(plan(kept), short);
  // The line was there before the compaction: no news for it.
  assert.deepEqual(opinionSteps(events(kept)), []);
});

test('second-opinion lines are told while the session runs; a stop signal ends the reading without a half line', async (t) => {
  const dir = makeRepo(t, { plan: SMALL, fake: { hang: [1] } });
  const running = run(dir, ['do', 'demo'], { opinionMs: 20 });
  let code = null;
  try {
    await until(() => existsSync(path.join(dir, 'calls.jsonl')));
    appendFileSync(planFile(dir), `${DECISIONS}`);
    await until(() => opinionSteps(events(dir)).length >= 1);
    const live = events(dir);
    assert.deepEqual(texts(opinionSteps(live)), [`second opinion: ${OPINION_LINE}`]);
    assert.equal(ends(live).length, 0, 'the session is still running');
    appendFileSync(planFile(dir), '- C3 half (second opinion');
  } finally {
    interrupt('SIGTERM', { exit: (c) => (code = c) });
    await running;
  }
  assert.equal(code, 1);
  const list = events(dir);
  oneEndLast(list);
  assert.equal(opinionSteps(list).length, 1, 'the half line is not told');
  // The timer is gone: a later line stays untold.
  const before = slugBytes(dir);
  appendFileSync(planFile(dir), ')\n- C4 late (second opinion)\n');
  await pause(100);
  assert.equal(slugBytes(dir), before);
});

// ------------------------------------------------------------------ memory wait

/** A config folder for the memory check: am/settings.json holding text (none when null) and, unless other is false, a live record of another PC's session. */
function memoryCfg(t, text = null, { other = true } = {}) {
  const file = userSettings(t, text);
  const env = cfgEnv(file);
  const records = sessionsDirOf(env);
  if (other) {
    mkdirSync(records, { recursive: true });
    writeFileSync(path.join(records, 'otherhost~4242~1.gate.json'), '{}\n');
  }
  return { env, file, records };
}
const SHORT_MEM = { platform: 'win32', freeMem: () => 1024 * MB };
const MEMORY_NOTE = 'waiting for free memory (1024 MB free, needs 6144 MB, 1 other sessions on this PC)';

test('memory wait: a broken user settings file ends every stage before any session or start line; a missing one changes nothing', async (t) => {
  for (const text of ['{"minFreeMemoryMB":"6GB"}', '{"minFreeMemoryMB":']) {
    const file = userSettings(t, text);
    for (const stage of ['plan', 'check']) {
      const dir = makeRepo(t, { plan: SMALL, fake: PLANNED });
      const { result, calls } = await run(dir, [stage, 'demo'], { env: cfgEnv(file) });
      assert.equal(result.status, 'failed', `${stage} ${text}`);
      assert.ok(result.reason.startsWith('the user settings cannot be used (fix or remove the file): '), result.reason);
      assert.ok(result.reason.includes(file), result.reason);
      assert.deepEqual(calls, []);
      assert.ok(!existsSync(path.join(dir, '.am', 'demo', 'progress.jsonl')));
    }
  }
  const dir = makeRepo(t, { fake: PLANNED });
  assert.equal((await run(dir, ['plan', 'demo'], { env: cfgEnv(userSettings(t, null)) })).result.status, 'READY');
});

test('memory wait: short of memory while another session of this PC runs, a stage waits, notes it once and ends WAIT', async (t) => {
  const { env, records } = memoryCfg(t);
  const dir = makeRepo(t, { fake: PLANNED });
  const { result, calls } = await run(dir, ['plan', 'demo'], { env, ...SHORT_MEM, waitMs: 150, pollMs: 20 });
  assert.equal(result.status, 'WAIT');
  assert.equal(result.stage, 'plan');
  assert.equal(result.reason, 'waiting for free memory on this PC: 1024 MB free, needs 6144 MB (built-in default), 1 other sessions on this PC');
  assert.deepEqual(calls, []);
  const list = events(dir);
  assert.deepEqual(list.map((e) => [e.ev, e.stage]), [['note', 'wait']]);
  assert.equal(list[0].text, MEMORY_NOTE);
  assert.ok(!existsSync(LOCK(dir)));
  assert.deepEqual(liveRecords(records).map((r) => path.basename(r.file)), ['otherhost~4242~1.gate.json']);
  // A value in the settings file holds on every OS, and the reason names the file.
  const custom = memoryCfg(t, '{"minFreeMemoryMB":1e9}');
  const mac = makeRepo(t, { fake: PLANNED });
  const r = await run(mac, ['plan', 'demo'], { env: custom.env, platform: 'darwin', freeMem: () => 1024 * MB, waitMs: 100, pollMs: 20 });
  assert.equal(r.result.status, 'WAIT');
  assert.equal(r.result.reason, `waiting for free memory on this PC: 1024 MB free, needs 1000000000 MB (minFreeMemoryMB in ${custom.file}), 1 other sessions on this PC`);
  assert.deepEqual(r.calls, []);
});

test('memory wait: with no other session, or with enough free memory, a stage starts at once', async (t) => {
  const alone = memoryCfg(t, null, { other: false });
  const dir = makeRepo(t, { fake: PLANNED });
  assert.equal((await run(dir, ['plan', 'demo'], { env: alone.env, ...SHORT_MEM, waitMs: 5000, pollMs: 20 })).result.status, 'READY');
  assert.deepEqual(evs(events(dir)), ['start', 'end']);
  const busy = memoryCfg(t);
  const roomy = makeRepo(t, { fake: PLANNED });
  assert.equal((await run(roomy, ['plan', 'demo'], { env: busy.env, platform: 'win32', waitMs: 5000, pollMs: 20 })).result.status, 'READY');
  assert.deepEqual(evs(events(roomy)), ['start', 'end']);
});

test('memory wait: a wait for another run and then for memory notes each once, then the stage starts', async (t) => {
  const { env } = memoryCfg(t);
  const dir = makeRepo(t, { fake: PLANNED });
  taskEvents(dir, 'a', [evAt(0, { ev: 'start', text: 's', pid: LIVE, stage: 'commit' })]);
  setTimeout(() => appendFileSync(path.join(dir, '.am', 'a', 'progress.jsonl'), `${JSON.stringify({ t: new Date().toISOString(), ev: 'end', text: 'e', stage: 'commit', status: 'COMMITTED' })}\n`), 100);
  // Memory is short for the first two checks, then enough: decided by the calls, not the clock.
  let checks = 0;
  const freeMem = () => (++checks <= 2 ? 1024 * MB : 2 ** 50);
  const { result, calls } = await run(dir, ['plan', 'demo'], { env, platform: 'win32', freeMem, alive: aliveOnly, waitMs: 10000, pollMs: 20 });
  assert.equal(result.status, 'READY');
  assert.equal(calls.length, 1);
  assert.equal(checks, 3);
  const list = events(dir);
  assert.deepEqual(evs(list), ['note', 'note', 'start', 'end']);
  assert.equal(list[0].text, 'waiting for another run of this repository to end: a (commit stage running)');
  assert.equal(list[1].text, MEMORY_NOTE);
});

test('memory wait: a running stage holds one record of this process, removed by a stop signal and by a normal end', async (t) => {
  const { env, records } = memoryCfg(t, null, { other: false });
  const dir = makeRepo(t, { plan: SMALL, fake: { hang: [1] } });
  const running = run(dir, ['do', 'demo'], { env });
  let code = null;
  try {
    await until(() => existsSync(path.join(dir, 'calls.jsonl')));
    const held = liveRecords(records);
    assert.equal(held.length, 1);
    assert.equal(held[0].pid, process.pid);
    assert.ok(held[0].gate);
    assert.match(path.basename(held[0].file), RECORD_NAME);
    const info = JSON.parse(readFileSync(held[0].file, 'utf8'));
    assert.deepEqual([info.repo, info.phase, info.where], [dir, 'am:auto do', path.join(dir, '.am', 'demo')]);
  } finally {
    interrupt('SIGTERM', { exit: (c) => (code = c) });
    await running;
  }
  assert.equal(code, 1);
  assert.deepEqual(liveRecords(records), []);
  const plain = makeRepo(t, { plan: SMALL, fake: { replies: ['AM_STAGE: DONE'] } });
  assert.equal((await run(plain, ['do', 'demo'], { env })).result.status, 'DONE');
  assert.deepEqual(liveRecords(records), []);
});

test('memory wait: one orchestrator lookup decides whether the do stage holds a record; a hand-over holds none', async (t) => {
  const { env, records } = memoryCfg(t, null, { other: false });
  const lookups = (...answers) => {
    const fn = () => answers[fn.calls++] ?? null;
    fn.calls = 0;
    return fn;
  };
  const during = async (dir, orchestrator) => {
    const running = run(dir, ['do', 'demo'], { env, orchestrator, relayMs: 60000 });
    let held = null;
    let code = null;
    try {
      await until(() => existsSync(path.join(dir, 'calls.jsonl')));
      held = liveRecords(records).length;
    } finally {
      interrupt('SIGTERM', { exit: (c) => (code = c) });
    }
    const { result } = await running;
    assert.equal(code, 1);
    return { held, result };
  };
  const handed = lookups('/orch', null);
  const h = await during(newHandover(t, { hang: [1] }), handed);
  assert.equal(handed.calls, 1);
  assert.equal(h.result.stage, 'handover');
  assert.equal(h.held, 0);
  const local = lookups(null, '/orch');
  const d = await during(makeRepo(t, { plan: LARGE, fake: { hang: [1] } }), local);
  assert.equal(local.calls, 1);
  assert.equal(d.result.stage, 'do');
  assert.equal(d.held, 1);
  assert.deepEqual(liveRecords(records), []);
  // A recorded hand-over without the run skill fails at once, short of memory or not.
  const busy = memoryCfg(t);
  const lost = makeRepo(t, { plan: HANDED_PLAN });
  const { result, calls } = await run(lost, ['do', 'demo'], { env: busy.env, ...SHORT_MEM, waitMs: 5000, pollMs: 20 });
  assert.equal(result.status, 'failed');
  assert.equal(result.stage, 'handover');
  assert.match(result.reason, /run skill is not installed/);
  assert.deepEqual(calls, []);
  assert.ok(!events(lost).some((e) => e.stage === 'wait'));
});

// ------------------------------------------------------------------ worker mode

const WF = (dir, name) => path.join(dir, '.am', 'demo', WORKER_FILES[name]);
const readOr = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : null);
/** What the worker's files and events hold right now. */
const workerState = (dir) => {
  const result = readOr(WF(dir, 'result'));
  return { result: result && JSON.parse(result), record: readOr(WF(dir, 'record')), log: readOr(WF(dir, 'log')), events: events(dir) };
};
/** Starts a worker with a fake claude, a fake exit (which records the state the real exit would leave) and fake signal handlers. */
function startWorker(dir, argv, opts = {}) {
  const w = { text: '', handlers: {}, exits: [] };
  w.done = worker(argv, {
    cwd: dir,
    env: isolatedEnv,
    claude: [process.execPath, path.join(dir, 'fake-claude.mjs')],
    orchestrator: () => null,
    am: () => [],
    freeMem: () => 2 ** 50,
    out: { write: (s) => (w.text += s) },
    on: (sig, f) => (w.handlers[sig] = f),
    exit: (code) => w.exits.push({ code, at: Date.now(), state: workerState(dir) }),
    ...opts,
  });
  return w;
}
const callsOf = (dir) => readOr(path.join(dir, 'calls.jsonl'));
const noTemp = (dir) => assert.deepEqual(readdirSync(path.join(dir, '.am', 'demo')).filter((f) => f.endsWith('.tmp') || f.includes('.stale')), []);

test('worker: no worker file is ever a task file a session reads', () => {
  for (const kind of ['plan', 'do', 'handover', 'check', 'compactmem', 'commit']) {
    for (const fix of [false, true]) for (const name of Object.values(WORKER_FILES)) assert.ok(!contextFiles(kind, { fix }).includes(name), `${kind} ${fix}: ${name}`);
  }
});

test('worker: a normal stage leaves its result line, the plan file state and the log, and releases the record', async (t) => {
  const dir = makeRepo(t, { plan: SMALL });
  const w = startWorker(dir, ['plan', 'demo']);
  assert.equal(await w.done, 0);
  assert.deepEqual(w.exits, []);
  const { result, record, log } = workerState(dir);
  const plan = statSync(path.join(dir, '.am', 'demo', 'plan.md'));
  assert.equal(result.pid, process.pid);
  assert.deepEqual([result.stage, result.push, result.fix, result.delivered, result.check], ['plan', false, false, false, null]);
  assert.deepEqual(result.plan, { size: plan.size, mtimeMs: plan.mtimeMs });
  assert.ok(!Number.isNaN(Date.parse(result.t)));
  assert.equal(JSON.parse(result.line).status, 'READY');
  assert.ok(log.includes(result.line));
  assert.equal(record, null);
  noTemp(dir);
  assert.equal(w.text, '');
  const flagged = makeRepo(t, { plan: SMALL, fake: { replies: ['AM_STAGE: DONE'] } });
  assert.equal(await startWorker(flagged, ['do', 'demo', '--push', '--fix']).done, 0);
  const r = workerState(flagged).result;
  assert.deepEqual([r.stage, r.push, r.fix, JSON.parse(r.line).status], ['do', true, true, 'DONE']);
});

test('worker: a live worker of the task keeps a new one out; a dead or unchanged stale one does not', async (t) => {
  const held = makeRepo(t, { plan: SMALL });
  const owner = JSON.stringify({ pid: LIVE, t: 1, stage: 'do' });
  writeFileSync(WF(held, 'record'), owner);
  assert.equal(await startWorker(held, ['check', 'demo'], { alive: aliveOnly, busyMs: 100, busyPollMs: 20 }).done, 1);
  assert.equal(callsOf(held), null);
  assert.deepEqual([workerState(held).result, workerState(held).record], [null, owner]);
  assert.match(workerState(held).log, /another stage worker of this task is running \(pid 101\)/);

  const dead = makeRepo(t, { plan: SMALL });
  writeFileSync(WF(dead, 'record'), JSON.stringify({ pid: DEAD, t: 1 }));
  assert.equal(await startWorker(dead, ['check', 'demo'], { alive: aliveOnly }).done, 0);
  assert.ok(workerState(dead).result);
  noTemp(dead);

  const old = new Date(Date.now() - 6 * 60000);
  const stale = makeRepo(t, { plan: SMALL });
  writeFileSync(WF(stale, 'record'), owner);
  utimesSync(WF(stale, 'record'), old, old);
  assert.equal(await startWorker(stale, ['check', 'demo'], { alive: aliveOnly, confirmMs: 50 }).done, 0);
  assert.ok(workerState(stale).result);
  assert.equal(workerState(stale).record, null);
  noTemp(stale);

  // Touched between the two looks: the owner lives.
  const touched = makeRepo(t, { plan: SMALL });
  writeFileSync(WF(touched, 'record'), owner);
  utimesSync(WF(touched, 'record'), old, old);
  setTimeout(() => utimesSync(WF(touched, 'record'), new Date(), new Date()), 100);
  assert.equal(await startWorker(touched, ['check', 'demo'], { alive: aliveOnly, confirmMs: 300, busyMs: 100, busyPollMs: 20 }).done, 1);
  assert.equal(callsOf(touched), null);
  assert.equal(workerState(touched).record, owner);
  noTemp(touched);
});

test('worker: a record released while the new worker tries again is taken', async (t) => {
  const dir = makeRepo(t, { plan: SMALL });
  writeFileSync(WF(dir, 'record'), JSON.stringify({ pid: LIVE, t: 1 }));
  setTimeout(() => rmSync(WF(dir, 'record')), 300);
  assert.equal(await startWorker(dir, ['check', 'demo'], { alive: aliveOnly, busyMs: 3000, busyPollMs: 20 }).done, 0);
  assert.ok(workerState(dir).result);
});

test('worker: a live worker of the same stage and flags already runs it: no second try, no session', async (t) => {
  const dir = makeRepo(t, { plan: SMALL });
  const owner = JSON.stringify({ pid: LIVE, t: 1, stage: 'check', push: false, fix: true });
  writeFileSync(WF(dir, 'record'), owner);
  const began = Date.now();
  assert.equal(await startWorker(dir, ['check', 'demo', '--fix'], { alive: aliveOnly, busyMs: 3000, busyPollMs: 20 }).done, 1);
  assert.ok(Date.now() - began < 1000);
  assert.equal(callsOf(dir), null);
  assert.deepEqual([workerState(dir).result, workerState(dir).record], [null, owner]);
  assert.match(workerState(dir).log, /another stage worker of this task is running \(pid 101\)/);
});

test('worker: an unchanged heartbeat stops the stage by the stop path, delivered, with the end event reason', async (t) => {
  const dir = makeRepo(t, { plan: SMALL, fake: { hang: [1] } });
  const began = Date.now();
  const w = startWorker(dir, ['check', 'demo'], { tickMs: 30, idleMs: 150 });
  assert.equal(await w.done, 1);
  assert.equal(w.exits.length, 1);
  const { code, state } = w.exits[0];
  assert.equal(code, 1);
  assert.ok(Date.now() - began < 30000, 'the hanging session was stopped');
  const line = JSON.parse(state.result.line);
  assert.equal(line.status, 'failed');
  assert.equal(state.result.delivered, true);
  const end = ends(state.events);
  assert.equal(end.length, 1);
  assert.equal(line.reason, end[0].text);
  assert.match(line.reason, /^stopped: nobody followed this stage for \d+ minutes$/);
  assert.equal(state.record, null);
  // Once stopped, main's late end changes no result.
  assert.deepEqual(workerState(dir).result, state.result);
});

test('worker: a heartbeat that changes keeps the stage going; once it stops changing the stage stops', async (t) => {
  const dir = makeRepo(t, { plan: SMALL, fake: { hang: [1] } });
  let n = 0;
  const beat = setInterval(() => writeFileSync(WF(dir, 'heartbeat'), String(++n)), 20);
  const w = startWorker(dir, ['check', 'demo'], { tickMs: 30, idleMs: 200 });
  await pause(700);
  clearInterval(beat);
  const quiet = Date.now();
  assert.deepEqual(w.exits, []);
  assert.equal(await w.done, 1);
  assert.equal(w.exits.length, 1);
  assert.ok(w.exits[0].at >= quiet);
  assert.equal(w.exits[0].state.result.delivered, true);
});

test('worker: a stop signal leaves a failed result, not delivered', async (t) => {
  const dir = makeRepo(t, { plan: SMALL, fake: { hang: [1] } });
  const w = startWorker(dir, ['check', 'demo']);
  await until(() => existsSync(path.join(dir, 'calls.jsonl')));
  assert.deepEqual(Object.keys(w.handlers).sort(), ['SIGHUP', 'SIGINT', 'SIGTERM']);
  w.handlers.SIGTERM();
  assert.equal(await w.done, 1);
  const { state } = w.exits[0];
  assert.equal(JSON.parse(state.result.line).reason, 'stopped by SIGTERM');
  assert.equal(state.result.delivered, false);
  assert.equal(ends(state.events)[0].text, 'stopped by SIGTERM');
  assert.equal(state.record, null);
});

test('worker: a record another worker took stops it quietly; a record gone for one tick does not', async (t) => {
  const dir = makeRepo(t, { plan: SMALL, fake: { hang: [1] } });
  const w = startWorker(dir, ['check', 'demo'], { tickMs: 30 });
  await until(() => existsSync(path.join(dir, 'calls.jsonl')));
  const other = JSON.stringify({ pid: LIVE, t: 9 });
  writeFileSync(WF(dir, 'record'), other);
  assert.equal(await w.done, 1);
  assert.equal(w.exits.length, 1);
  const { state } = w.exits[0];
  assert.equal(state.result, null);
  assert.equal(state.record, other);
  assert.deepEqual(ends(state.events), []);
  assert.equal(readOr(WF(dir, 'result')), null, 'not written later either');
  assert.equal(readOr(WF(dir, 'record')), other);

  const back = makeRepo(t, { plan: SMALL, fake: { hang: [1] } });
  const v = startWorker(back, ['check', 'demo'], { tickMs: 200 });
  await until(() => existsSync(path.join(back, 'calls.jsonl')));
  const text = readFileSync(WF(back, 'record'), 'utf8');
  rmSync(WF(back, 'record'));
  await pause(100);
  writeFileSync(WF(back, 'record'), text);
  await pause(600);
  assert.deepEqual(v.exits, []);
  v.handlers.SIGTERM();
  assert.equal(await v.done, 1);
  assert.equal(JSON.parse(v.exits[0].state.result.line).reason, 'stopped by SIGTERM');
});

test('worker: bad arguments print the usage and make no file', async (t) => {
  const dir = makeRepo(t, { plan: SMALL });
  for (const argv of [['ship', 'demo'], ['do', '../x'], ['do', 'demo', '--force']]) {
    const w = startWorker(dir, argv);
    assert.equal(await w.done, 1);
    assert.match(w.text, /^bad arguments[^]*usage: node stage\.mjs/);
  }
  assert.deepEqual([readOr(WF(dir, 'record')), readOr(WF(dir, 'log'))], [null, null]);
});

const TASK = (dir) => path.join(dir, '.am', 'demo');
const markerOf = (dir, pid) => existsSync(path.join(TASK(dir), `${DELIVERED_PREFIX}${pid}`));
const markers = (dir) => readdirSync(TASK(dir)).filter((f) => f.startsWith(DELIVERED_PREFIX)).sort();

test('claimResult: the first claim wins, the next finds it taken, a missing folder is an error', (t) => {
  const dir = makeRepo(t, { plan: SMALL });
  assert.equal(claimResult(TASK(dir), 4242), 'won');
  assert.equal(claimResult(TASK(dir), 4242), 'taken');
  assert.ok(markerOf(dir, 4242));
  assert.equal(claimResult(path.join(dir, 'missing'), 4242), 'error');
  assert.deepEqual(fileState(TASK(dir), 'nothing.md'), null);
});

test('worker: once it holds the record it removes older delivered marks, and a result under its own pid; a blocked worker removes none', async (t) => {
  const kept = makeRepo(t, { plan: SMALL, fake: { hang: [1] } });
  writeFileSync(WF(kept, 'result'), resultOf({ stage: 'check', line: stageLine('check', 'demo', 'NOTE', '') }));
  for (const pid of [LIVE, 777]) claimResult(TASK(kept), pid);
  const w = startWorker(kept, ['check', 'demo']);
  await until(() => existsSync(path.join(kept, 'calls.jsonl')));
  assert.deepEqual(markers(kept), [`${DELIVERED_PREFIX}${LIVE}`]);
  w.handlers.SIGTERM();
  assert.equal(await w.done, 1);

  const reused = makeRepo(t, { plan: SMALL, fake: { hang: [1] } });
  writeFileSync(WF(reused, 'result'), resultOf({ pid: process.pid, stage: 'check', line: stageLine('check', 'demo', 'NOTE', '') }));
  claimResult(TASK(reused), process.pid);
  const v = startWorker(reused, ['check', 'demo']);
  await until(() => existsSync(path.join(reused, 'calls.jsonl')));
  assert.deepEqual([readOr(WF(reused, 'result')), markers(reused)], [null, []]);
  v.handlers.SIGTERM();
  assert.equal(await v.done, 1);

  const blocked = makeRepo(t, { plan: SMALL });
  writeFileSync(WF(blocked, 'record'), JSON.stringify({ pid: LIVE, t: 1, stage: 'do' }));
  writeFileSync(WF(blocked, 'result'), resultOf({ pid: process.pid, stage: 'do', line: stageLine('do', 'demo', 'DONE', '') }));
  for (const pid of [process.pid, 777]) claimResult(TASK(blocked), pid);
  assert.equal(await startWorker(blocked, ['check', 'demo'], { alive: aliveOnly, busyMs: 100, busyPollMs: 20 }).done, 1);
  assert.deepEqual(markers(blocked), [`${DELIVERED_PREFIX}${process.pid}`, `${DELIVERED_PREFIX}777`].sort());
  assert.ok(readOr(WF(blocked, 'result')));
});

test('worker: reads no environment variable; its times are parameters', () => {
  assert.ok(!String(worker).includes('process.env'));
});

// ------------------------------------------------------------------ follow mode

const STAGE_URL = pathToFileURL(path.join(REPO, 'plugin', 'scripts', 'stage.mjs')).href;
// The worker the follower starts: stage.mjs's worker with the fake claude and test times.
const WRAPPER = `import { worker } from ${JSON.stringify(STAGE_URL)};\nprocess.exitCode = await worker(process.argv.slice(2), { claude: [process.execPath, 'fake-claude.mjs'], orchestrator: () => null, am: () => [], freeMem: () => 2 ** 50, confirmMs: 50, busyMs: 300 });\n`;
// A worker command that must not run: it leaves spawned.txt.
const NO_SPAWN = [process.execPath, '-e', "require('fs').writeFileSync('spawned.txt', 'x')"];
const spawned = (dir) => existsSync(path.join(dir, 'spawned.txt'));
const heartbeatOf = (dir) => readOr(WF(dir, 'heartbeat'));
/** Starts a follower with the wrapper worker, short polls and fake signal handlers. */
function startFollow(dir, argv, opts = {}) {
  const wrapper = path.join(dir, 'wrapper.mjs');
  if (!existsSync(wrapper)) writeFileSync(wrapper, WRAPPER);
  const f = { text: '', handlers: {} };
  f.done = follow(argv, { cwd: dir, env: isolatedEnv, workerCmd: [process.execPath, wrapper], followMs: 50, out: { write: (s) => (f.text += s) }, on: (sig, fn) => (f.handlers[sig] = fn), ...opts });
  return f;
}
const record = (fields) => JSON.stringify({ pid: LIVE, t: 1, push: false, fix: false, ...fields });
const resultOf = (fields, at = Date.now()) => `${JSON.stringify({ pid: LIVE, push: false, fix: false, delivered: false, plan: null, check: null, t: new Date(at).toISOString(), ...fields })}\n`;
const NOTED = { replies: ['Checked.\nAM_STAGE: NOTE'] };

test('follow: a stage runs in a worker of its own and prints the same line main prints', async (t) => {
  const dir = makeRepo(t, { fake: PLANNED });
  const f = startFollow(dir, ['plan', 'demo']);
  assert.equal(await f.done, 0);
  const lines = f.text.trim().split('\n');
  assert.equal(lines.length, 1, f.text);
  const same = makeRepo(t, { fake: PLANNED });
  assert.deepEqual(JSON.parse(lines[0]), (await run(same, ['plan', 'demo'])).result);
  const list = events(dir);
  assert.deepEqual(evs(list), ['start', 'end']);
  assert.notEqual(list[0].pid, process.pid);
  assert.equal(readOr(WF(dir, 'record')), null);
  assert.ok(heartbeatOf(dir));
});

test('follow: a live worker of the same stage and flags is followed, and only its new result is printed', async (t) => {
  const dir = makeRepo(t, { plan: SMALL });
  writeFileSync(WF(dir, 'record'), record({ stage: 'check' }));
  writeFileSync(WF(dir, 'result'), resultOf({ stage: 'check', line: stageLine('check', 'demo', 'NOTE', 'old') }, Date.now() - 60000));
  const f = startFollow(dir, ['check', 'demo'], { workerCmd: NO_SPAWN, alive: aliveOnly });
  await until(() => heartbeatOf(dir));
  const first = heartbeatOf(dir);
  await until(() => heartbeatOf(dir) !== first);
  writeFileSync(WF(dir, 'result'), resultOf({ stage: 'check', fix: true, line: stageLine('check', 'demo', 'NOTE', 'other flags') }));
  await pause(200);
  assert.equal(f.text, '');
  const line = stageLine('check', 'demo', 'BLOCK', 'new');
  writeFileSync(WF(dir, 'result'), resultOf({ stage: 'check', line }));
  rmSync(WF(dir, 'record'));
  assert.equal(await f.done, 0);
  assert.equal(f.text, `${line}\n`);
  assert.ok(!spawned(dir));
});

test('follow: another stage, or the same stage with other flags, is waited for and then WAIT; once it ends this stage runs', async (t) => {
  for (const [held, name] of [[{ stage: 'do', fix: true }, 'do --fix'], [{ stage: 'check', fix: true }, 'check --fix']]) {
    const dir = makeRepo(t, { plan: SMALL });
    writeFileSync(WF(dir, 'record'), record(held));
    const f = startFollow(dir, ['check', 'demo'], { workerCmd: NO_SPAWN, alive: aliveOnly, waitMs: 200 });
    assert.equal(await f.done, 0);
    const line = JSON.parse(f.text);
    assert.equal(line.status, 'WAIT');
    assert.equal(line.reason, `waiting for another stage of this task: the ${name} stage is still running (pid ${LIVE})`);
    assert.deepEqual([heartbeatOf(dir), spawned(dir), existsSync(path.join(dir, '.am', 'demo', 'progress.jsonl'))], [null, false, false]);
  }
  const dir = makeRepo(t, { plan: SMALL, fake: NOTED });
  writeFileSync(WF(dir, 'record'), record({ stage: 'do' }));
  setTimeout(() => rmSync(WF(dir, 'record')), 200);
  const f = startFollow(dir, ['check', 'demo'], { alive: aliveOnly, waitMs: 20000 });
  assert.equal(await f.done, 0);
  assert.equal(JSON.parse(f.text).status, 'NOTE');
});

test('follow: a stale record of the same stage is confirmed before this call starts its own worker; a touched one is followed', async (t) => {
  const old = new Date(Date.now() - 6 * 60000);
  const dir = makeRepo(t, { plan: SMALL, fake: NOTED });
  writeFileSync(WF(dir, 'record'), record({ stage: 'check' }));
  utimesSync(WF(dir, 'record'), old, old);
  const f = startFollow(dir, ['check', 'demo'], { alive: aliveOnly, confirmMs: 400 });
  await pause(200);
  assert.equal(heartbeatOf(dir), null);
  assert.equal(await f.done, 0);
  assert.equal(JSON.parse(f.text).status, 'NOTE');

  const touched = makeRepo(t, { plan: SMALL });
  writeFileSync(WF(touched, 'record'), record({ stage: 'check' }));
  utimesSync(WF(touched, 'record'), old, old);
  setTimeout(() => utimesSync(WF(touched, 'record'), new Date(), new Date()), 100);
  const g = startFollow(touched, ['check', 'demo'], { workerCmd: NO_SPAWN, alive: aliveOnly, confirmMs: 400 });
  await until(() => heartbeatOf(touched));
  await pause(500);
  const line = stageLine('check', 'demo', 'NOTE', '');
  writeFileSync(WF(touched, 'result'), resultOf({ stage: 'check', line }));
  rmSync(WF(touched, 'record'));
  assert.equal(await g.done, 0);
  assert.equal(g.text, `${line}\n`);
  assert.ok(!spawned(touched));
});

test('follow: a followed worker that dies without a result, or one that ends before its record, is `failed` with the log', async (t) => {
  const dir = makeRepo(t, { plan: SMALL });
  writeFileSync(WF(dir, 'record'), record({ stage: 'check' }));
  let up = true;
  const f = startFollow(dir, ['check', 'demo'], { workerCmd: NO_SPAWN, alive: (pid) => up && pid === LIVE });
  await until(() => heartbeatOf(dir));
  up = false;
  assert.equal(await f.done, 0);
  assert.equal(f.text, `${stageLine('check', 'demo', 'failed', 'the stage worker ended without a result; see .am/demo/stage-worker.log')}\n`);
  assert.ok(!spawned(dir));

  const early = makeRepo(t, { plan: SMALL });
  const g = startFollow(early, ['check', 'demo'], { workerCmd: [process.execPath, '-e', "process.stderr.write('boom'); process.exit(3)"] });
  assert.equal(await g.done, 0);
  assert.equal(JSON.parse(g.text).reason, 'the stage worker ended without a result; see .am/demo/stage-worker.log');
  assert.match(readOr(WF(early, 'log')), /boom/);
});

test('follow: two calls at once run the stage once and print the same line', async (t) => {
  for (const delay of [0, 500]) {
    const dir = makeRepo(t, { plan: SMALL, fake: { ...NOTED, delay } });
    const [a, b] = [startFollow(dir, ['check', 'demo']), startFollow(dir, ['check', 'demo'])];
    assert.deepEqual(await Promise.all([a.done, b.done]), [0, 0]);
    assert.equal(a.text, b.text);
    assert.equal(JSON.parse(a.text).status, 'NOTE');
    assert.equal(callsOf(dir).trim().split('\n').length, 1, `delay ${delay}`);
    assert.equal(events(dir).filter((e) => e.ev === 'start').length, 1);
  }
});

test('follow: a worker of this call that lost the record to another stage leads to the wait, not `failed`', async (t) => {
  const dir = makeRepo(t, { plan: SMALL });
  const lose = `require('fs').writeFileSync('.am/demo/stage-worker.json', ${JSON.stringify(record({ stage: 'do' }))})`;
  const f = startFollow(dir, ['check', 'demo'], { workerCmd: [process.execPath, '-e', lose], alive: aliveOnly, waitMs: 400 });
  assert.equal(await f.done, 0);
  assert.equal(JSON.parse(f.text).status, 'WAIT');

  // That stage ends just before this call's worker gives up: no look finds it, and this stage starts again.
  const late = makeRepo(t, { plan: SMALL, fake: NOTED });
  writeFileSync(path.join(late, 'lose.mjs'), `import { existsSync, rmSync, writeFileSync } from 'node:fs';
if (existsSync('lost.txt')) await import('./wrapper.mjs');
else {
  writeFileSync('lost.txt', 'x');
  writeFileSync('.am/demo/stage-worker.json', ${JSON.stringify(record({ stage: 'do' }))});
  await new Promise((r) => setTimeout(r, 300));
  rmSync('.am/demo/stage-worker.json');
  process.exit(1);
}
`);
  const g = startFollow(late, ['check', 'demo'], { workerCmd: [process.execPath, path.join(late, 'lose.mjs')], alive: aliveOnly, waitMs: 20000 });
  assert.equal(await g.done, 0);
  assert.equal(JSON.parse(g.text).status, 'NOTE');
  assert.equal(callsOf(late).trim().split('\n').length, 1);
});

test('follow: a stop signal goes to the worker and ends the call with exit 1; while waiting for another stage it ends at once', async (t) => {
  const dir = makeRepo(t, { plan: SMALL, fake: { hang: [1] } });
  const f = startFollow(dir, ['check', 'demo']);
  await until(() => existsSync(path.join(dir, 'calls.jsonl')));
  assert.deepEqual(Object.keys(f.handlers).sort(), ['SIGHUP', 'SIGINT', 'SIGTERM']);
  f.handlers.SIGTERM();
  assert.equal(await f.done, 1);
  const line = JSON.parse(f.text);
  assert.deepEqual([line.status, line.reason], ['failed', 'stopped by SIGTERM']);
  if (process.platform !== 'win32') {
    assert.equal(ends(events(dir)).length, 1);
    assert.equal(readOr(WF(dir, 'record')), null);
  }

  const waiting = makeRepo(t, { plan: SMALL });
  writeFileSync(WF(waiting, 'record'), record({ stage: 'do' }));
  const g = startFollow(waiting, ['check', 'demo'], { workerCmd: NO_SPAWN, alive: aliveOnly, waitMs: 60000 });
  await pause(200);
  const began = Date.now();
  g.handlers.SIGINT();
  assert.equal(await g.done, 1);
  assert.ok(Date.now() - began < 1000);
  assert.equal(g.text, '');
});

test('follow: the limit is the progress command\'s lifetime; the start time reads HH:MM', () => {
  assert.equal(FOLLOW_LIMIT_MS, DEFAULTS.maxLifeMs);
  assert.equal(hhmm(new Date(2026, 0, 1, 7, 5).getTime()), '07:05');
  assert.equal(hhmm(new Date(2026, 0, 1, 23, 59).getTime()), '23:59');
  assert.equal(hhmm('x'), '??:??');
  assert.equal(stillRunning('do', new Date(2026, 0, 1, 7, 5).getTime()), 'the do stage is still running (started 07:05)');
});

test('follow: at its limit the call ends WAIT with the worker\'s start time while the worker runs on; called again it follows on', async (t) => {
  const dir = makeRepo(t, { fake: { ...PLANNED, delay: 4000 } });
  const f = startFollow(dir, ['plan', 'demo'], { limitMs: 800 });
  assert.equal(await f.done, 0);
  assert.equal(f.text.trim().split('\n').length, 1, f.text);
  const line = JSON.parse(f.text);
  const rec = JSON.parse(readOr(WF(dir, 'record')));
  assert.deepEqual([line.status, line.reason], ['WAIT', stillRunning('plan', rec.t)]);
  assert.ok(pidAlive(rec.pid), 'the worker runs on');
  assert.deepEqual([readOr(WF(dir, 'result')), markers(dir), ends(events(dir))], [null, [], []]);
  // The same words through the whole run.
  const g = startFollow(dir, ['plan', 'demo'], { limitMs: 800 });
  assert.equal(await g.done, 0);
  assert.equal(JSON.parse(g.text).reason, line.reason);
  // Called again with another run holding the start lock: it follows the same worker before that lock and gets its line.
  writeFileSync(LOCK(dir), JSON.stringify({ pid: process.pid, t: Date.now() }));
  const h = startFollow(dir, ['plan', 'demo'], { workerCmd: NO_SPAWN });
  assert.equal(await h.done, 0);
  assert.equal(JSON.parse(h.text).status, 'READY');
  assert.ok(!spawned(dir));
  assert.equal(callsOf(dir).trim().split('\n').length, 1);
  assert.equal(events(dir).filter((e) => e.ev === 'start').length, 1);
});

test('follow: a limit before the worker\'s record names the call\'s start; while another stage runs it keeps that wait\'s reason', async (t) => {
  const dir = makeRepo(t, { plan: SMALL });
  const T = new Date(2026, 9, 11, 9, 30).getTime();
  const f = startFollow(dir, ['plan', 'demo'], { workerCmd: [process.execPath, '-e', 'setTimeout(() => {}, 2000)'], now: () => T, limitMs: 300 });
  assert.equal(await f.done, 0);
  assert.deepEqual([JSON.parse(f.text).status, JSON.parse(f.text).reason], ['WAIT', stillRunning('plan', T)]);

  const other = makeRepo(t, { plan: SMALL });
  writeFileSync(WF(other, 'record'), record({ stage: 'do', fix: true }));
  const began = Date.now();
  const g = startFollow(other, ['check', 'demo'], { workerCmd: NO_SPAWN, alive: aliveOnly, waitMs: 5000, limitMs: 300 });
  assert.equal(await g.done, 0);
  assert.ok(Date.now() - began < 1000);
  const line = JSON.parse(g.text);
  assert.deepEqual([line.status, line.reason], ['WAIT', `waiting for another stage of this task: the do --fix stage is still running (pid ${LIVE})`]);
  assert.ok(!spawned(other));
});

test('follow: after a stop signal the limit no longer counts: the call ends `failed` with exit 1, not WAIT', async (t) => {
  const dir = makeRepo(t, { plan: SMALL, fake: { hang: [1] } });
  const f = startFollow(dir, ['check', 'demo'], { kill: () => {}, stopMs: 3000, limitMs: 1500 });
  // The heartbeat starts before the worker writes its record: wait for the record itself.
  let pid = null;
  await until(() => {
    try {
      pid = JSON.parse(readOr(WF(dir, 'record'))).pid;
    } catch {
      // Not written yet.
    }
    return pid;
  });
  const began = Date.now();
  f.handlers.SIGTERM();
  assert.equal(await f.done, 1);
  assert.ok(Date.now() - began >= 1500, 'the limit passed while it stopped');
  const line = JSON.parse(f.text);
  assert.deepEqual([line.status, line.reason], ['failed', 'stopped by SIGTERM']);
  // The fake kill left the worker running: stop it here, before the folder goes.
  process.kill(pid, 'SIGTERM');
  await until(() => !pidAlive(pid));
});

test('follow: a task without its folder ends as main does, with no file', async (t) => {
  const dir = makeRepo(t, { plan: SMALL });
  const f = startFollow(dir, ['plan', 'ghost']);
  assert.equal(await f.done, 0);
  assert.equal(f.text, (await run(dir, ['plan', 'ghost'])).text);
  assert.ok(!existsSync(path.join(dir, '.am', 'ghost')));
  assert.ok(!existsSync(WF(dir, 'log')));
});

test('follow: the command with bad arguments prints the usage, exits 1 and starts nothing', (t) => {
  const dir = makeRepo(t, { plan: SMALL });
  const r = spawnSync(process.execPath, [path.join(REPO, 'plugin', 'scripts', 'stage.mjs'), 'ship', 'demo'], { cwd: dir, env: isolatedEnv, encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^bad arguments[^]*usage: node stage\.mjs/);
  assert.deepEqual(Object.values(WORKER_FILES).filter((name) => existsSync(path.join(dir, '.am', 'demo', name))), []);
});

const planState = (dir) => fileState(TASK(dir), 'plan.md');
const HOUR_AGO = Date.now() - 3600000;
// A result left before the call began (a result dated at the call's start is that call's own).
const earlier = (fields) => resultOf(fields, Date.now() - 1000);

test('follow: a result that ended with nobody following goes once to the next call of its stage, whatever its age', async (t) => {
  const dir = makeRepo(t, { plan: SMALL });
  assert.equal(await startWorker(dir, ['plan', 'demo']).done, 0);
  const { result } = workerState(dir);
  await pause(20); // calls after the result, not in its millisecond
  const f = startFollow(dir, ['plan', 'demo'], { workerCmd: NO_SPAWN });
  assert.equal(await f.done, 0);
  assert.equal(f.text, `${result.line}\n`);
  assert.ok(!spawned(dir));
  assert.ok(markerOf(dir, process.pid));
  await startFollow(dir, ['plan', 'demo'], { workerCmd: NO_SPAWN }).done;
  assert.ok(spawned(dir), 'a delivered result is not given again');

  const old = makeRepo(t, { plan: SMALL });
  const line = stageLine('plan', 'demo', 'READY', '');
  writeFileSync(WF(old, 'result'), resultOf({ stage: 'plan', line, plan: planState(old) }, HOUR_AGO));
  const g = startFollow(old, ['plan', 'demo'], { workerCmd: NO_SPAWN });
  assert.equal(await g.done, 0);
  assert.equal(g.text, `${line}\n`);
  assert.ok(!spawned(old));
  assert.ok(markerOf(old, LIVE));

  const handed = makeRepo(t, { plan: SMALL });
  writeFileSync(WF(handed, 'result'), earlier({ stage: 'plan', line, plan: planState(handed), delivered: true }));
  const h = startFollow(handed, ['plan', 'demo'], { workerCmd: NO_SPAWN });
  await h.done;
  assert.ok(spawned(handed));
  assert.notEqual(h.text, `${line}\n`);
});

test('follow: a pending result of another stage, other flags, a wait or a stop is dropped and this stage runs', async (t) => {
  const lines = [
    { stage: 'do', line: stageLine('do', 'demo', 'DONE', '') },
    { stage: 'check', fix: true, line: stageLine('check', 'demo', 'NOTE', 'fixed') },
    { stage: 'check', line: stageLine('check', 'demo', 'WAIT', 'waiting') },
    { stage: 'check', line: stageLine('check', 'demo', 'failed', 'stopped by SIGTERM') },
  ];
  for (const fields of lines) {
    const dir = makeRepo(t, { plan: SMALL, fake: NOTED });
    writeFileSync(WF(dir, 'result'), earlier({ ...fields, plan: planState(dir) }));
    const f = startFollow(dir, ['check', 'demo']);
    assert.equal(await f.done, 0);
    const out = JSON.parse(f.text);
    assert.deepEqual([out.stage, out.status], ['check', 'NOTE'], fields.line);
    assert.equal(callsOf(dir).trim().split('\n').length, 1);
    assert.ok(markerOf(dir, LIVE), fields.line);
  }
});

test('follow: a pending result is not delivered once plan.md or check.md changed', async (t) => {
  const dir = makeRepo(t, { plan: SMALL });
  writeFileSync(WF(dir, 'result'), earlier({ stage: 'plan', line: stageLine('plan', 'demo', 'NEEDS_DECISION', 'a question'), plan: planState(dir) }));
  appendFileSync(path.join(TASK(dir), 'plan.md'), '- Answer: the first option\n');
  const f = startFollow(dir, ['plan', 'demo']);
  assert.equal(await f.done, 0);
  assert.equal(JSON.parse(f.text).status, 'READY');
  assert.equal(callsOf(dir).trim().split('\n').length, 1);

  const checked = makeRepo(t, { plan: SMALL, fake: NOTED });
  writeFileSync(path.join(TASK(checked), 'check.md'), '# check\n');
  const before = fileState(TASK(checked), 'check.md');
  writeFileSync(WF(checked, 'result'), earlier({ stage: 'check', line: stageLine('check', 'demo', 'BLOCK', 'old'), plan: planState(checked), check: before }));
  utimesSync(path.join(TASK(checked), 'check.md'), new Date(HOUR_AGO), new Date(HOUR_AGO));
  const g = startFollow(checked, ['check', 'demo']);
  assert.equal(await g.done, 0);
  assert.equal(JSON.parse(g.text).status, 'NOTE');
});

test('follow: the result a follower printed is claimed, so the next call runs the stage again', async (t) => {
  const dir = makeRepo(t, { plan: SMALL });
  const f = startFollow(dir, ['plan', 'demo']);
  assert.equal(await f.done, 0);
  const { result } = workerState(dir);
  assert.equal(f.text, `${result.line}\n`);
  assert.ok(markerOf(dir, result.pid));
  const g = startFollow(dir, ['plan', 'demo']);
  assert.equal(await g.done, 0);
  assert.equal(JSON.parse(g.text).status, 'READY');
  assert.equal(callsOf(dir).trim().split('\n').length, 2);
});

test('follow: a stop signal claims the followed worker\'s result at once; its later result is not given to the next call', async (t) => {
  const dir = makeRepo(t, { plan: SMALL });
  writeFileSync(WF(dir, 'record'), record({ stage: 'check' }));
  const f = startFollow(dir, ['check', 'demo'], { workerCmd: NO_SPAWN, alive: aliveOnly, kill: () => {}, stopMs: 100 });
  await until(() => heartbeatOf(dir));
  f.handlers.SIGTERM();
  assert.ok(markerOf(dir, LIVE));
  assert.equal(await f.done, 1);
  assert.deepEqual(JSON.parse(f.text).reason, 'stopped by SIGTERM');
  const line = stageLine('check', 'demo', 'NOTE', 'late');
  writeFileSync(WF(dir, 'result'), earlier({ stage: 'check', line, plan: planState(dir) }));
  rmSync(WF(dir, 'record'));
  const g = startFollow(dir, ['check', 'demo'], { workerCmd: NO_SPAWN });
  await g.done;
  assert.ok(spawned(dir));
  assert.notEqual(g.text, `${line}\n`);
});

test('follow: a worker followed just as it ended leaves its earlier result to this call, not `failed`', async (t) => {
  const dir = makeRepo(t, { plan: SMALL });
  writeFileSync(WF(dir, 'record'), record({ stage: 'check' }));
  const line = stageLine('check', 'demo', 'NOTE', 'ended');
  writeFileSync(WF(dir, 'result'), resultOf({ stage: 'check', line, plan: planState(dir) }, Date.now() - 1000));
  const f = startFollow(dir, ['check', 'demo'], { workerCmd: NO_SPAWN, alive: aliveOnly });
  await until(() => heartbeatOf(dir));
  rmSync(WF(dir, 'record'));
  assert.equal(await f.done, 0);
  assert.equal(f.text, `${line}\n`);
  assert.ok(!spawned(dir));
  assert.ok(markerOf(dir, LIVE));
});

test('follow: reads no environment variable; its times are parameters', () => {
  assert.ok(!String(follow).includes('process.env'));
});

// ------------------------------------------------------------------ the orchestrator worker a hand-over started

// A pid no process has; the fake alive says it lives, the fake kill records the signal.
const P = 2 ** 22 + 4242;
const aliveP = (pid) => pid === P || pidAlive(pid);
const killer = () => {
  const sent = [];
  return { sent, kill: (pid, sig) => sent.push([pid, sig]) };
};
const ORCH_FILES = (owner = process.pid) => ({
  '.orchestrator/worker/worker.json': JSON.stringify({ pid: P, owner, command: 'run' }),
  '.orchestrator/lock.json': JSON.stringify({ pid: P, command: 'run' }),
});
// Written by the test once the session runs: a live lock before it would make the start lock wait.
const putOrch = (dir, files = ORCH_FILES()) => {
  mkdirSync(path.join(dir, '.orchestrator', 'worker'), { recursive: true });
  for (const [f, text] of Object.entries(files)) writeFileSync(path.join(dir, f), text);
};

test('stopHandedRun: SIGTERM only to a live worker of this owner that holds the orchestrator lock; never throws', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'am-stage-handed-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const put = (w, lock) => {
    rmSync(path.join(dir, '.orchestrator'), { recursive: true, force: true });
    mkdirSync(path.join(dir, '.orchestrator', 'worker'), { recursive: true });
    if (w !== null) writeFileSync(path.join(dir, '.orchestrator', 'worker', 'worker.json'), typeof w === 'string' ? w : JSON.stringify(w));
    if (lock !== null) writeFileSync(path.join(dir, '.orchestrator', 'lock.json'), JSON.stringify(lock));
  };
  const lock = { pid: P, command: 'run' };
  const k = killer();
  put({ pid: P, owner: 4321, command: 'run' }, lock);
  assert.equal(stopHandedRun(dir, 4321, { alive: aliveP, kill: k.kill }), P);
  assert.deepEqual(k.sent, [[P, 'SIGTERM']]);
  const cases = [
    ['another owner', { pid: P, owner: 4322 }, lock, aliveP],
    ['no owner (a command a person started)', { pid: P, command: 'run' }, lock, aliveP],
    ['not alive', { pid: P, owner: 4321 }, lock, () => false],
    ['another lock pid', { pid: P, owner: 4321 }, { pid: P + 1 }, aliveP],
    ['no lock', { pid: P, owner: 4321 }, null, aliveP],
    ['no worker.json', null, lock, aliveP],
    ['broken worker.json', '{"pid":', lock, aliveP],
    ['a pid that is no integer', { pid: String(P), owner: 4321 }, { pid: String(P) }, () => true],
    ['a fraction pid', { pid: 1.5, owner: 4321 }, { pid: 1.5 }, () => true],
  ];
  for (const [name, w, l, alive] of cases) {
    const n = killer();
    put(w, l);
    assert.equal(stopHandedRun(dir, 4321, { alive, kill: n.kill }), null, name);
    assert.deepEqual(n.sent, [], name);
  }
  put({ pid: P, owner: 4321 }, lock);
  assert.equal(stopHandedRun(dir, 4321, { alive: aliveP, kill: () => { throw new Error('ESRCH'); } }), null);
  assert.equal(stopHandedRun(dir, 4321, { alive: () => { throw new Error('boom'); } }), null);
});

test('hand-over end: a normal end stops the worker it started, only that one, and not from another stage', async (t) => {
  const k = killer();
  const dir = makeRepo(t, { plan: LARGE, fake: { replies: ['AM_STAGE: HANDED'], write: ORCH_FILES() } });
  const { result } = await run(dir, ['do', 'demo'], { ...ORCH, alive: aliveP, kill: k.kill });
  assert.equal(result.status, 'HANDED');
  assert.deepEqual(k.sent, [[P, 'SIGTERM']]);
  assert.equal(ends(events(dir)).length, 1);

  const other = killer();
  const foreign = makeRepo(t, { plan: LARGE, fake: { replies: ['AM_STAGE: HANDED'], write: ORCH_FILES(process.pid + 1) } });
  assert.equal((await run(foreign, ['do', 'demo'], { ...ORCH, alive: aliveP, kill: other.kill })).result.status, 'HANDED');
  assert.deepEqual(other.sent, []);

  const checked = killer();
  const check = makeRepo(t, { plan: SMALL, fake: { replies: ['AM_STAGE: NOTE'], write: ORCH_FILES() } });
  assert.equal((await run(check, ['check', 'demo'], { alive: aliveP, kill: checked.kill })).result.status, 'NOTE');
  assert.deepEqual(checked.sent, []);
});

test('hand-over end: a session time-out stops the worker it started', async (t) => {
  const k = killer();
  const dir = makeRepo(t, { plan: LARGE, fake: { hang: [1] } });
  const running = run(dir, ['do', 'demo'], { ...ORCH, alive: aliveP, kill: k.kill, timeoutMin: { handover: 0.02 } });
  await until(() => existsSync(path.join(dir, 'calls.jsonl')));
  putOrch(dir);
  const { result } = await running;
  assert.equal(result.status, 'failed');
  assert.deepEqual(k.sent, [[P, 'SIGTERM']]);
  assert.equal(ends(events(dir)).length, 1);
});

test('hand-over end: a stop signal stops the worker it started', async (t) => {
  const k = killer();
  const dir = makeRepo(t, { plan: LARGE, fake: { hang: [1] } });
  const running = run(dir, ['do', 'demo'], { ...ORCH, alive: aliveP, kill: k.kill });
  let code = null;
  try {
    await until(() => existsSync(path.join(dir, 'calls.jsonl')));
    putOrch(dir);
  } finally {
    interrupt('SIGTERM', { exit: (c) => (code = c) });
    await running;
  }
  assert.equal(code, 1);
  assert.deepEqual(k.sent, [[P, 'SIGTERM']]);
  assert.equal(ends(events(dir)).length, 1);
});

test('hand-over end: a stage worker stopped by its heartbeat stops the orchestrator worker it started', async (t) => {
  const k = killer();
  const dir = makeRepo(t, { plan: LARGE, fake: { hang: [1] } });
  // The heartbeat changes until the files are written, then stays: the stage worker stops after idleMs.
  let n = 0;
  const beat = setInterval(() => writeFileSync(WF(dir, 'heartbeat'), String(++n)), 15);
  const atExit = [];
  const w = startWorker(dir, ['do', 'demo'], { ...ORCH, tickMs: 30, idleMs: 250, alive: aliveP, kill: k.kill, exit: (code) => atExit.push({ code, sent: [...k.sent], ends: ends(events(dir)).length }) });
  try {
    await until(() => existsSync(path.join(dir, 'calls.jsonl')));
    putOrch(dir);
  } finally {
    clearInterval(beat);
  }
  assert.equal(await w.done, 1);
  assert.deepEqual(atExit, [{ code: 1, sent: [[P, 'SIGTERM']], ends: 1 }]);
  assert.deepEqual(k.sent, [[P, 'SIGTERM']]);
});

test('hand-over end: a pushed-out stage worker stops the orchestrator worker too, and still leaves no result or end', async (t) => {
  const k = killer();
  const dir = makeRepo(t, { plan: LARGE, fake: { hang: [1] } });
  const atExit = [];
  const w = startWorker(dir, ['do', 'demo'], { ...ORCH, tickMs: 30, alive: aliveP, kill: k.kill, exit: (code) => atExit.push({ code, sent: [...k.sent], state: workerState(dir) }) });
  await until(() => existsSync(path.join(dir, 'calls.jsonl')));
  putOrch(dir);
  const other = JSON.stringify({ pid: LIVE, t: 9 });
  writeFileSync(WF(dir, 'record'), other);
  assert.equal(await w.done, 1);
  assert.equal(atExit.length, 1);
  const { code, sent, state } = atExit[0];
  assert.equal(code, 1);
  assert.deepEqual(sent, [[P, 'SIGTERM']]);
  assert.equal(state.result, null);
  assert.equal(state.record, other);
  assert.deepEqual(ends(state.events), []);
  // The fake exit does not stop the process, so main's later end runs finish once more; the real process.exit stops first,
  // so nothing after the exit is checked.
});

// Last: by liveRecords, not the folder's file list (a record Windows could not remove at once is left out there, and the folder stays).
test('memory wait: the stage tests leave no live record behind', () => {
  assert.deepEqual(liveRecords(sessionsDirOf(isolatedEnv)), []);
});
