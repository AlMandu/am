// Run: node --test tests/stage.test.mjs
// The am:auto stage runner: what each stage session may do, what it is told, and how its end is read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MARKS, STAGES, claudeArgs, doKind, instructions, lastMark, main, parseResult, permissions, pluginDirFor, memoryDir, absEdit } from '../plugin/scripts/stage.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AUTO = readFileSync(path.join(REPO, 'plugin', 'skills', 'auto', 'SKILL.md'), 'utf8');

// A fake claude: records its arguments in calls.jsonl and answers as fake.json in the working folder says.
// fake.json: { "replies": ["text of the 1st call", "text of the 2nd call"], "exit": 0, "write": { "path": "content" } }
const FAKE = `import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const argv = process.argv.slice(2);
appendFileSync('calls.jsonl', JSON.stringify(argv) + '\\n');
const s = existsSync('fake.json') ? JSON.parse(readFileSync('fake.json', 'utf8')) : {};
const n = readFileSync('calls.jsonl', 'utf8').trim().split('\\n').length;
for (const [f, t] of Object.entries(s.write || {})) { mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, t); }
if (s.crash) { process.stderr.write('boom'); process.exit(3); }
const replies = s.replies || ['done\\nAM_STAGE: READY'];
const text = replies[Math.min(n, replies.length) - 1];
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: 'sess-1', total_cost_usd: 0.25 * n, permission_denials: n === 1 ? [{ tool_name: 'Bash', tool_input: { command: 'git push' } }] : [] }));
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
  // The same stop list in am:auto.
  for (const stop of ['delete user data or files that existed before this run, change a saved-data format, or migrate data', 'change anything outside this repository (other folders, external services, installed packages)', "The user's or project's instructions say the next action needs confirmation", 'The two reviewers of a technical choice still split on it after their rounds']) assert.ok(AUTO.includes(stop), stop);
  // Through cmd.exe (claude.cmd) only the unquoted rules for node scripts survive; those sessions are told the form.
  assert.match(instructions('handover', 'demo', { unquoted: true }).system, /Run node scripts with the path unquoted/);
  assert.doesNotMatch(instructions('handover', 'demo').system, /path unquoted/);
  assert.doesNotMatch(instructions('check', 'demo', { unquoted: true }).system, /path unquoted/);
  assert.match(instructions('plan', 'demo').system, /`Scale: N implementation runs, M commits` \(`규모: 구현 N회, 커밋 M개` in a Korean plan\)/);
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
  assert.deepEqual({ ...result, reply: !!result.reply }, { stage: 'plan', slug: 'demo', status: 'READY', reason: '', costUsd: 0.25, sessionId: 'sess-1', reply: true, denied: ['Bash: git push'] });
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
  const saved = makeRepo(t, { fake: { replies: ['Planned.\nAM_STAGE: READY', 'Saved.\nAM_STAGE: READY'] } });
  // The fake writes on every call; the first call writes nowhere useful, the second saves the plan.
  writeFileSync(path.join(saved, 'fake-claude.mjs'), FAKE.replace("for (const [f, t] of Object.entries(s.write || {}))", "if (n === 2) writeFileSync('.am/demo/plan.md', 'x');\nfor (const [f, t] of Object.entries(s.write || {}))"));
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
  const dir = makeRepo(t, { plan: SMALL });
  writeFileSync(path.join(dir, 'fake-claude.mjs'), 'setTimeout(() => {}, 60000);\n');
  const { result } = await run(dir, ['check', 'demo'], { timeoutMin: { check: 0.005 } });
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /no end within/);
});
