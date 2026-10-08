// Run: node --test tests/stage.test.mjs
// The am:auto stage runner: what each stage session may do, what it is told, and how its end is read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MARKS, STAGES, claudeArgs, doKind, instructions, lastMark, main, parseResult, permissions, pluginDirFor, memoryDir, absEdit, estimateTokens, contextFiles, pickCompaction, CONTEXT_LIMIT, CONTEXT_TARGET, COMPACT_MARKS, COMPACT_MODEL, TIMEOUT_MIN, compactInstructions, compactionProblem, cmdExeArgs } from '../plugin/scripts/stage.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AUTO = readFileSync(path.join(REPO, 'plugin', 'skills', 'auto', 'SKILL.md'), 'utf8');

// A fake claude: records its arguments in calls.jsonl and answers as fake.json in the working folder says.
// fake.json: { "replies": ["text of the 1st call", "text of the 2nd call"], "crash": true (writes boom to stderr and exits 3), "write": { "path": "content" },
//   "writes": [{ "path": "content written by the 1st call only" }, ...], "removes": [["path deleted by the 1st call only"], ...], "hang": [1] (calls that never end) }
const FAKE = `import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const argv = process.argv.slice(2);
appendFileSync('calls.jsonl', JSON.stringify(argv) + '\\n');
const s = existsSync('fake.json') ? JSON.parse(readFileSync('fake.json', 'utf8')) : {};
const n = readFileSync('calls.jsonl', 'utf8').trim().split('\\n').length;
if ((s.hang || []).includes(n)) setTimeout(() => {}, 60000);
else {
for (const [f, t] of Object.entries({ ...s.write, ...(s.writes || [])[n - 1] })) { mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, t); }
for (const f of (s.removes || [])[n - 1] || []) rmSync(f, { force: true });
if (s.crash) { process.stderr.write('boom'); process.exit(3); }
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

async function run(dir, argv, opts = {}) {
  let text = '';
  const out = { write: (s) => (text += s) };
  const code = await main(argv, { cwd: dir, claude: [process.execPath, path.join(dir, 'fake-claude.mjs')], orchestrator: () => null, out, ...opts });
  const calls = existsSync(path.join(dir, 'calls.jsonl')) ? readFileSync(path.join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  return { code, text, result: code === 0 ? JSON.parse(text) : null, calls };
}
const flag = (args, name) => args[args.indexOf(name) + 1];
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
  assert.match(absEdit('C:\\Users\\me\\.claude\\projects\\C--x\\memory'), /^Edit\(\/\/c\/Users\/me\/\.claude\/projects\/C--x\/memory\/\*\*\)$/, 'on Windows');
  if (process.platform !== 'win32') assert.equal(absEdit('/home/me/m'), 'Edit(//home/me/m/**)');
  assert.deepEqual(MARKS.compactmem, ['PROPOSED', 'NOTHING', 'BLOCKED'], 'never stops am:auto for a question');
  const commit = permissions('commit');
  assert.ok(commit.allow.includes('Bash(git commit *)') && commit.deny.includes('Bash(git push *)') && !commit.allow.includes('Bash(git push *)'));
  const pushed = permissions('commit', { push: true });
  assert.ok(pushed.allow.includes('Bash(git push *)') && !pushed.deny.includes('Bash(git push *)'));
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
  for (const keep of ['규모: 구현 N회, 커밋 M개', '(done) or (완료)', '(auto-decided), (자동 결정)', 'marked OPEN, in full', 'AM_STAGE: COMPACTED', 'AM_STAGE: BLOCKED', 'never use a question tool', 'Never change .am/demo/request.md: it is the user\'s request in their own words', 'if the runner finds it changed it puts everything back']) assert.ok(system.includes(keep), keep);
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
  for (const s of [...STAGES, 'handover']) {
    const { system } = instructions(s, 'demo');
    // The same rules as am:auto's "Running without stops" (user decision: a copy written for stage sessions, kept in step by this test).
    assert.match(system, /the mark \(auto-decided\), translated into the plan's language \(\(자동 결정\) in a Korean plan\)/, s);
    for (const stop of ['delete user data or files that existed before this run, change a saved-data format, or migrate data', 'change anything outside this repository (other folders, external services, installed packages)', "the user's or the project's instructions say it needs confirmation", 'the two reviewers of a technical choice still split on it after their rounds']) assert.ok(system.includes(stop), `${s}: ${stop}`);
    assert.match(system, /marked OPEN[\s\S]*AM_STAGE: NEEDS_DECISION/, s);
    for (const m of MARKS[s]) assert.ok(system.includes(`AM_STAGE: ${m}`), `${s}: ${m}`);
  }
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
  assert.doesNotMatch(instructions('check', 'demo', { unquoted: true }).system, /path unquoted/);
  assert.match(instructions('plan', 'demo').system, /`Scale: N implementation runs, M commits` \(`규모: 구현 N회, 커밋 M개` in a Korean plan\)/);
  // The size of one implementation run, word for word as in am:auto.
  const oneRun = AUTO.match(/One implementation run is [^\n]*? separately\./);
  assert.ok(oneRun, 'am:auto defines one implementation run');
  assert.ok(instructions('plan', 'demo').system.includes(oneRun[0]), oneRun[0]);
  assert.match(instructions('do', 'demo').system, /do not use the am:check skill/);
  assert.match(instructions('do', 'demo', { fix: true }).system, /Read \.am\/demo\/check\.md first and fix only the causes it reports/);
  assert.match(instructions('handover', 'demo', { push: true }).system, /`git merge --ff-only <run\.branch>` and `git branch -d <run\.branch>`[\s\S]*push the start branch/);
  assert.match(instructions('handover', 'demo').system, /Do not push\./);
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
  const { result, calls } = await run(dir, ['compactmem', 'demo']);
  assert.equal(result.stage, 'compactmem');
  assert.equal(result.status, 'PROPOSED');
  assert.equal(flag(calls[0], '-p'), '/am:compactmem demo');
  assert.equal(flag(calls[0], '--permission-mode'), 'dontAsk');
  const none = makeRepo(t, { plan: SMALL, fake: { replies: ['No memory.\nAM_STAGE: NOTHING'] } });
  assert.equal((await run(none, ['compactmem', 'demo'])).result.status, 'NOTHING');
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
  const lost = makeRepo(t, { plan: `${LARGE}- am-orchestrator 로 넘김, run.id 20261007-1200\n` });
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
