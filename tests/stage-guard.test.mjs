// Tests for plugin/hooks/stage-guard.mjs: the allow lists of the am:lean stage agents, the stage record lookup and
// binding, the heartbeat and the final-answer check. decide is called directly; time, pids and the plugin root are arguments.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { decide, findRecord, CLAIM_FILE } from '../plugin/hooks/stage-guard.mjs';

const PID = 4242;
const NOW = 1_800_000_000_000;
const PLUGIN = '/opt/plugins/am';
const RUN = 'abc123-0a1b2c';
const now = () => NOW;
const alive = (pid) => pid === PID || pid === PID + 1;

// A file symbolic link needs Developer Mode or an elevated account on Windows; directory links below are junctions, which do not.
const FILE_LINKS = (() => {
  const dir = mkdtempSync(path.join(tmpdir(), 'am-stage-guard-probe-'));
  try {
    writeFileSync(path.join(dir, 'f'), 'x');
    symlinkSync(path.join(dir, 'f'), path.join(dir, 'l'));
    return true;
  } catch (err) {
    if (err.code !== 'EPERM') throw err;
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

function makeRepo() {
  const root = mkdtempSync(path.join(tmpdir(), 'am-stage-guard-'));
  mkdirSync(path.join(root, '.git'));
  return root;
}

function writeRecord(root, slug, fields = {}, mtime = NOW) {
  const dir = path.join(root, '.am', slug);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'stage.json');
  writeFileSync(file, JSON.stringify({ pid: PID, runId: RUN, stage: 'plan', slug, push: false, fix: false, part: false, t: NOW - 1000, ...fields }));
  utimesSync(file, mtime / 1000, mtime / 1000);
  return file;
}

// One repository with one open record of the given stage, and a function that runs a payload through decide.
function setup(stage, { push = false, slug = 'task' } = {}) {
  const root = makeRepo();
  const record = writeRecord(root, slug, { stage, push });
  const agent = stage === 'commit' && push ? 'am:stage-commit-push' : `am:stage-${stage}`;
  const run = (fields, opts = {}) => decide({ hook_event_name: 'PreToolUse', agent_type: agent, agent_id: 'agent-1', cwd: root, ...fields }, { pluginRoot: PLUGIN, now, alive, env: {}, ...opts });
  const bash = (command, extra = {}) => verdict(run({ tool_name: 'Bash', tool_input: { command }, ...extra }));
  const write = (file, tool = 'Write') => verdict(run({ tool_name: tool, tool_input: { file_path: path.isAbsolute(file) ? file : path.join(root, file) } }));
  const done = () => rmSync(root, { recursive: true, force: true });
  return { root, record, run, bash, write, done, slug };
}

function verdict(r) {
  assert.ok(r.stdout.endsWith('\n'));
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, 'PreToolUse');
  assert.ok(out.permissionDecisionReason.length > 0);
  return out.permissionDecision;
}

// ------------------------------------------------------------- plan and commit shell

test('plan: shell characters, line breaks and globs outside quotes are refused', () => {
  const s = setup('plan');
  for (const ch of ['$', '`', '<', '>', '|', ';', '&', '(', ')', '{', '}', '\\']) assert.equal(s.bash(`git log ${ch}x`), 'deny', ch);
  assert.equal(s.bash('git status\ngit log'), 'deny');
  assert.equal(s.bash('git status\rgit log'), 'deny');
  for (const ch of ['*', '?', '[', ']', '~', '!']) assert.equal(s.bash(`git diff a${ch}`), 'deny', ch);
  assert.equal(s.bash('git log -- "a*b"'), 'allow');
  assert.equal(s.bash('git log > x'), 'deny');
  assert.equal(s.bash('git log "x'), 'deny');
  assert.equal(s.bash('git status'), 'allow');
  for (const sub of ['diff', 'log', 'ls-files', 'check-ignore x', 'rev-parse HEAD']) assert.equal(s.bash(`git ${sub}`), 'allow', sub);
  assert.equal(s.bash('git add x'), 'deny');
  assert.equal(s.bash('git commit -m x'), 'deny');
  assert.equal(s.bash('ls'), 'deny');
  s.done();
});

test('plan and commit: refused git options in every form', () => {
  const s = setup('plan');
  for (const opt of ['--output', '--ext-diff', '--textconv', '--exec-path', '--git-dir', '--work-tree']) {
    assert.equal(s.bash(`git diff ${opt}`), 'deny', opt);
    assert.equal(s.bash(`git diff ${opt}=x`), 'deny', `${opt}=`);
  }
  for (const opt of ['-o', '-c', '-C']) {
    assert.equal(s.bash(`git log ${opt} x`), 'deny', opt);
    assert.equal(s.bash(`git log ${opt}x`), 'deny', `${opt} attached`);
  }
  assert.equal(s.bash('git diff --outp=x'), 'deny');
  assert.equal(s.bash('git diff --tex'), 'deny');
  assert.equal(s.bash('git diff --no-ext-diff'), 'allow');
  assert.equal(s.bash('git -C x log'), 'deny');
  assert.equal(s.bash('git -c x log'), 'deny');
  assert.equal(s.bash('git --no-pager log'), 'deny');
  s.done();
});

test('plan: only the second-opinion scripts of this plugin, with a brief of this task', () => {
  const s = setup('plan');
  assert.equal(s.bash(`node "${PLUGIN}/scripts/codex-opinion.mjs" .am/task/opinion-1.md`), 'allow');
  assert.equal(s.bash(`node ${PLUGIN}/scripts/claude-opinion.mjs .am/task/opinion-1.md`), 'allow');
  assert.equal(s.bash(`node ${PLUGIN}/scripts/claude-opinion.mjs .am/task/opinion-1.md --as 1`), 'allow');
  assert.equal(s.bash(`node ${PLUGIN}/scripts/claude-opinion.mjs .am/task/opinion-1.md --as 2`), 'allow');
  assert.equal(s.bash(`node ${PLUGIN}/scripts/claude-opinion.mjs .am/task/opinion-1.md --as 3`), 'deny');
  assert.equal(s.bash(`node ${PLUGIN}/scripts/codex-opinion.mjs .am/task/opinion-1.md --as 1`), 'deny');
  assert.equal(s.bash(`node ${PLUGIN}/scripts/stage.mjs .am/task/opinion-1.md`), 'deny');
  assert.equal(s.bash('node /elsewhere/scripts/codex-opinion.mjs .am/task/opinion-1.md'), 'deny');
  assert.equal(s.bash('node -e "1"'), 'deny');
  assert.equal(s.bash(`node ${PLUGIN}/scripts/codex-opinion.mjs .am/other/opinion-1.md`), 'deny');
  assert.equal(s.bash(`node ${PLUGIN}/scripts/codex-opinion.mjs .am/task/../x.md`), 'deny');
  assert.equal(s.bash(`node ${PLUGIN}/scripts/codex-opinion.mjs notes.md`), 'deny');
  s.done();
});

/** A folder made to look like the am plugin (manifest name, plan skill); `name` changes the manifest's name. */
function fakeCore(dir, name = 'am') {
  mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  mkdirSync(path.join(dir, 'skills', 'plan'), { recursive: true });
  writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, version: '0.1.66' }));
  writeFileSync(path.join(dir, 'skills', 'plan', 'SKILL.md'), 'plan');
  return dir;
}
const slashed = (p) => p.split(path.sep).join('/');

test('plan: the codex-opinion of the recorded core am outside the repository, or of the development sibling; claude-opinion of this plugin only', () => {
  const out = mkdtempSync(path.join(tmpdir(), 'am-stage-guard-core-'));
  try {
    const core = fakeCore(path.join(out, 'am'));
    const other = fakeCore(path.join(out, 'other'), 'am-auto');
    const brief = '.am/task/opinion-1.md';
    const codex = (root) => `node ${slashed(root)}/scripts/codex-opinion.mjs ${brief}`;
    const claude = (root) => `node ${slashed(root)}/scripts/claude-opinion.mjs ${brief}`;

    // A recorded am outside the repository: its Codex script only.
    const s = setup('plan');
    writeRecord(s.root, 'task', { core });
    assert.equal(s.bash(codex(core)), 'allow');
    assert.equal(s.bash(`node "${slashed(core)}/scripts/codex-opinion.mjs" ${brief}`), 'allow');
    assert.equal(s.bash(claude(core)), 'deny');
    assert.equal(s.bash(`node ${slashed(core)}/scripts/stage.mjs ${brief}`), 'deny');
    // Not an am (manifest name) or a relative path: refused.
    writeRecord(s.root, 'task', { core: other });
    assert.equal(s.bash(codex(other)), 'deny');
    writeRecord(s.root, 'task', { core: path.relative(process.cwd(), core) });
    assert.equal(s.bash(codex(core)), 'deny');
    // A record without core: as before, only this plugin's scripts.
    writeRecord(s.root, 'task');
    assert.equal(s.bash(codex(core)), 'deny');
    assert.equal(s.bash(`node ${PLUGIN}/scripts/codex-opinion.mjs ${brief}`), 'allow');
    // An am inside the repository is refused even when recorded.
    const inside = fakeCore(path.join(s.root, 'plugin'));
    writeRecord(s.root, 'task', { core: inside });
    assert.equal(s.bash(codex(inside)), 'deny');
    // The same folder as the development sibling of this plugin's root is allowed, record or not.
    const auto = path.join(s.root, 'auto');
    mkdirSync(auto);
    writeRecord(s.root, 'task');
    assert.equal(verdict(s.run({ tool_name: 'Bash', tool_input: { command: codex(inside) } }, { pluginRoot: auto })), 'allow');
    assert.equal(verdict(s.run({ tool_name: 'Bash', tool_input: { command: claude(inside) } }, { pluginRoot: auto })), 'deny');
    s.done();
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('commit: add, commit with a message file or plain -m, restore --staged only, no push', () => {
  const s = setup('commit');
  assert.equal(s.bash('git add plugin/x.mjs'), 'allow');
  assert.equal(s.bash('git status'), 'allow');
  assert.equal(s.bash('git commit -m "feat(x): y"'), 'deny');
  assert.equal(s.bash('git commit -m "plain words" -m "second paragraph"'), 'allow');
  assert.equal(s.bash('git commit -F .am/task/commit-message.txt'), 'allow');
  assert.equal(s.bash('git commit -F .am/other/commit-message.txt'), 'deny');
  assert.equal(s.bash('git commit --amend -m x'), 'deny');
  assert.equal(s.bash('git commit -m x --no-verify'), 'deny');
  assert.equal(s.bash('git restore --staged -- a.txt b.txt'), 'allow');
  assert.equal(s.bash('git restore a.txt'), 'deny');
  assert.equal(s.bash('git restore --staged a.txt'), 'deny');
  assert.equal(s.bash('git restore --worktree --staged -- a.txt'), 'deny');
  assert.equal(s.bash('git push'), 'deny');
  assert.equal(s.bash('git push origin main'), 'deny');
  s.done();
});

test('commit: a message file that is a symbolic link is refused', { skip: !FILE_LINKS && 'this account may not create file symbolic links' }, () => {
  const s = setup('commit');
  writeFileSync(path.join(s.root, 'elsewhere.txt'), 'x');
  symlinkSync(path.join(s.root, 'elsewhere.txt'), path.join(s.root, '.am', 'task', 'commit-message.txt'));
  assert.equal(s.bash('git commit -F .am/task/commit-message.txt'), 'deny');
  s.done();
});

test('commit-push: push takes only [-u] [remote [branch]]', () => {
  const s = setup('commit', { push: true });
  for (const c of ['git push', 'git push origin', 'git push origin main', 'git push -u origin feat/x', 'git push --set-upstream origin main']) assert.equal(s.bash(c), 'allow', c);
  for (const c of ['git push https://example.com/r.git main', 'git push origin +HEAD:main', 'git push origin :main', 'git push origin main:main', 'git push --force', 'git push origin -f', 'git push origin main extra', 'git push --tags']) assert.equal(s.bash(c), 'deny', c);
  // The commit-push agent does not take a plain commit record, nor the other the push one.
  const plain = setup('commit');
  assert.equal(plain.bash('git push origin main'), 'deny');
  plain.done();
  s.done();
});

// ------------------------------------------------------------- do and check shell

test('do and check: history changes and sessions are refused, the rest allowed', () => {
  for (const stage of ['do', 'check']) {
    const s = setup(stage);
    for (const c of ['git commit -m x', 'bash -c "git push"', 'env A=1 git reset --hard', 'git -C d checkout main', 'git switch main', 'git stash', 'git stash pop', 'g\\it push', 'claude -p x', 'codex.exe exec x', 'npm test && git commit -m x', 'git $SUB']) assert.equal(s.bash(c), 'deny', `${stage}: ${c}`);
    for (const c of ['git stash list', 'git stash show', 'npm test', 'git diff', 'node --test tests/x.test.mjs', 'ls | grep x']) assert.equal(s.bash(c), 'allow', `${stage}: ${c}`);
    const quote = (c) => `"${c.replace(/[\\"]/g, (m) => `\\${m}`)}"`;
    let nested = 'ls';
    for (let i = 0; i < 5; i++) nested = `bash -c ${quote(nested)}`;
    assert.equal(s.bash(nested), 'deny');
    s.done();
  }
});

test('PowerShell and unchecked tools are refused in every stage', () => {
  for (const stage of ['plan', 'do', 'check', 'commit']) {
    const s = setup(stage);
    assert.equal(verdict(s.run({ tool_name: 'PowerShell', tool_input: { command: 'git status' } })), 'deny');
    assert.equal(verdict(s.run({ tool_name: 'WebFetch', tool_input: {} })), 'deny');
    assert.equal(verdict(s.run({ tool_name: 'Bash', tool_input: { command: ['git', 'status'] } })), 'deny');
    s.done();
  }
});

// ------------------------------------------------------------- file writes

test('file writes by stage', () => {
  const plan = setup('plan');
  assert.equal(plan.write('.am/task/plan.md'), 'allow');
  assert.equal(plan.write('.am/task/scratch/a.mjs'), 'allow');
  assert.equal(plan.write('.am/.active'), 'allow');
  for (const f of ['stage.json', 'STAGE.JSON', CLAIM_FILE, 'progress.jsonl', 'rules-plan.md', 'skill-plan.md']) assert.equal(plan.write(`.am/task/${f}`), 'deny', f);
  assert.equal(plan.write('.am/other/plan.md'), 'deny');
  assert.equal(plan.write('src/x.js'), 'deny');
  assert.equal(plan.write('.am/task/plan.md', 'Edit'), 'allow');
  plan.done();

  const commit = setup('commit');
  for (const f of ['commits.md', 'handoff.md', 'reply-commit.md', 'commit-message.txt']) assert.equal(commit.write(`.am/task/${f}`), 'allow', f);
  assert.equal(commit.write('.am/task/plan.md'), 'deny');
  assert.equal(commit.write('src/x.js'), 'deny');
  commit.done();

  for (const stage of ['do', 'check']) {
    const s = setup(stage);
    assert.equal(s.write('src/new/x.js'), 'allow');
    assert.equal(verdict(s.run({ tool_name: 'NotebookEdit', tool_input: { notebook_path: path.join(s.root, 'n.ipynb') } })), 'allow');
    assert.equal(s.write('.git/config'), 'deny');
    assert.equal(s.write('.GIT/hooks/pre-commit'), 'deny');
    assert.equal(s.write('.claude/settings.json'), 'deny');
    assert.equal(s.write(path.join(path.dirname(s.root), 'outside.txt')), 'deny');
    assert.equal(s.write('../outside.txt'), 'deny');
    const out = mkdtempSync(path.join(tmpdir(), 'am-stage-guard-out-'));
    symlinkSync(out, path.join(s.root, 'link'), 'junction');
    assert.equal(s.write('link/x.txt'), 'deny');
    symlinkSync(path.join(out, 'missing'), path.join(s.root, 'dangling'), 'junction');
    assert.equal(s.write('dangling'), 'deny');
    rmSync(out, { recursive: true, force: true });
    s.done();
  }
});

// ------------------------------------------------------------- agents and records

test('an unknown am:stage- agent is refused', () => {
  const s = setup('plan');
  assert.equal(verdict(s.run({ agent_type: 'am:stage-x', tool_name: 'Bash', tool_input: { command: 'git status' } })), 'deny');
  s.done();
});

test('the record: none, the user decision C1, CLAUDE_PID, ended and dead pids', () => {
  const root = makeRepo();
  const run = (opts = {}) => verdict(decide({ hook_event_name: 'PreToolUse', agent_type: 'am:stage-plan', agent_id: 'a', cwd: root, tool_name: 'Bash', tool_input: { command: 'git status' } }, { pluginRoot: PLUGIN, now, alive, env: {}, ...opts }));
  assert.equal(run(), 'deny');
  writeRecord(root, 'ended', { ended: NOW - 10 });
  writeRecord(root, 'dead', { pid: 99999 });
  writeRecord(root, 'other-stage', { stage: 'do' });
  assert.equal(run(), 'deny');
  // One recent record and an older one started later: the one started last.
  writeRecord(root, 'old', { t: NOW - 100 }, NOW - 30 * 60000);
  writeRecord(root, 'recent', { t: NOW - 5000, runId: 'aaa111-111111' });
  assert.equal(findRecord(root, 'plan', false, { now, alive }).slug, 'old');
  // Two touched within the stale time: refused.
  writeRecord(root, 'recent2', { t: NOW - 4000 });
  assert.match(findRecord(root, 'plan', false, { now, alive }).error, /2 open plan stage records/);
  assert.equal(run(), 'deny');
  rmSync(path.join(root, '.am', 'recent2'), { recursive: true });
  // Only old records: the one started last.
  writeRecord(root, 'recent', { t: NOW - 5000 }, NOW - 40 * 60000);
  writeRecord(root, 'old2', { t: NOW - 50 }, NOW - 50 * 60000);
  assert.equal(findRecord(root, 'plan', false, { now, alive }).slug, 'old2');
  // CLAUDE_PID narrows the records to that session's.
  writeRecord(root, 'mine', { pid: PID + 1, t: NOW - 10000 }, NOW - 60 * 60000);
  assert.equal(findRecord(root, 'plan', false, { now, alive, pid: PID + 1 }).slug, 'mine');
  assert.equal(run({ env: { CLAUDE_PID: String(PID + 1) } }), 'allow');
  rmSync(root, { recursive: true, force: true });
});

test('the record: push is compared only for the commit stage', () => {
  const root = makeRepo();
  // In push mode am:lean passes --push to every start; am:stage-plan, -do and -check still find their record.
  for (const stage of ['plan', 'do', 'check']) {
    writeRecord(root, stage, { stage, push: true });
    assert.equal(findRecord(root, stage, false, { now, alive }).slug, stage, stage);
  }
  writeRecord(root, 'commit', { stage: 'commit', push: true });
  assert.match(findRecord(root, 'commit', false, { now, alive }).error, /no open commit stage record/);
  assert.equal(findRecord(root, 'commit', true, { now, alive }).slug, 'commit');
  writeRecord(root, 'commit', { stage: 'commit', push: false });
  assert.match(findRecord(root, 'commit', true, { now, alive }).error, /no open commit stage record/);
  assert.equal(findRecord(root, 'commit', false, { now, alive }).slug, 'commit');
  rmSync(root, { recursive: true, force: true });
});

test('the heartbeat touches the record, and the record is bound to the first agent', () => {
  const s = setup('plan');
  utimesSync(s.record, (NOW - 60000) / 1000, (NOW - 60000) / 1000);
  assert.equal(s.bash('git status'), 'allow');
  assert.equal(statSync(s.record).mtimeMs, NOW);
  const claim = JSON.parse(readFileSync(path.join(s.root, '.am', 'task', CLAIM_FILE), 'utf8'));
  assert.deepEqual([claim.runId, claim.agentId], [RUN, 'agent-1']);
  // Another agent, or none: refused, and no heartbeat.
  utimesSync(s.record, (NOW - 60000) / 1000, (NOW - 60000) / 1000);
  assert.equal(s.bash('git status', { agent_id: 'agent-2' }), 'deny');
  assert.equal(s.bash('git status', { agent_id: undefined }), 'deny');
  assert.equal(statSync(s.record).mtimeMs, NOW - 60000);
  // A new stage (another runId) binds anew.
  writeRecord(s.root, 'task', { stage: 'plan', runId: 'bbb222-222222' });
  assert.equal(s.bash('git status', { agent_id: 'agent-2' }), 'allow');
  assert.equal(JSON.parse(readFileSync(path.join(s.root, '.am', 'task', CLAIM_FILE), 'utf8')).agentId, 'agent-2');
  assert.equal(s.bash('git status'), 'deny');
  s.done();
});

// ------------------------------------------------------------- SubagentStop

test('SubagentStop: only the one status line of this stage passes, once', () => {
  const s = setup('do');
  const stop = (fields) => s.run({ hook_event_name: 'SubagentStop', stop_hook_active: false, ...fields }).stdout;
  const blocked = (out) => {
    const o = JSON.parse(out);
    assert.equal(o.decision, 'block');
    assert.ok(o.reason.includes('AM_STAGE: <status> <runId>'));
    return true;
  };
  for (const status of ['DONE', 'BLOCKED', 'NEEDS_DECISION']) assert.equal(stop({ last_assistant_message: `AM_STAGE: ${status} ${RUN}` }), '', status);
  assert.equal(stop({ last_assistant_message: `AM_STAGE: DONE ${RUN}\n` }), '');
  assert.equal(stop({ last_assistant_message: 'AM_STAGE: BLOCKED MISSING_RUN_ID' }), '');
  assert.ok(blocked(stop({ last_assistant_message: 'AM_STAGE: DONE MISSING_RUN_ID' })));
  assert.ok(blocked(stop({ last_assistant_message: `Done.\nAM_STAGE: DONE ${RUN}` })));
  assert.ok(blocked(stop({ last_assistant_message: `Done. AM_STAGE: DONE ${RUN}` })));
  assert.ok(blocked(stop({ last_assistant_message: `AM_STAGE: DONE ${RUN}\nAM_STAGE: DONE ${RUN}` })));
  assert.ok(blocked(stop({ last_assistant_message: `AM_STAGE: READY ${RUN}` })));
  assert.ok(blocked(stop({ last_assistant_message: 'AM_STAGE: DONE abc123-ffffff' })));
  assert.equal(stop({ stop_hook_active: true, last_assistant_message: 'anything' }), '');
  // No last_assistant_message: the transcript's last assistant text.
  const transcript = path.join(s.root, 't.jsonl');
  const line = (type, content) => JSON.stringify({ type, message: { role: type, content } });
  writeFileSync(transcript, [line('assistant', [{ type: 'text', text: 'working' }]), line('user', [{ type: 'text', text: 'x' }]), line('assistant', [{ type: 'text', text: `AM_STAGE: DONE ${RUN}` }]), line('assistant', [{ type: 'tool_use', name: 'x' }])].join('\n'));
  assert.equal(stop({ agent_transcript_path: transcript }), '');
  assert.equal(stop({ transcript_path: transcript }), '');
  writeFileSync(transcript, line('assistant', [{ type: 'text', text: 'Summary first' }, { type: 'text', text: `AM_STAGE: DONE ${RUN}` }]));
  assert.ok(blocked(stop({ transcript_path: transcript })));
  assert.ok(blocked(stop({})));
  // Without an open record the runId only has to look like one.
  rmSync(s.record);
  assert.equal(stop({ last_assistant_message: 'AM_STAGE: DONE abc123-ffffff' }), '');
  assert.ok(blocked(stop({ last_assistant_message: 'AM_STAGE: DONE nope' })));
  assert.equal(existsSync(path.join(s.root, '.am', 'task', CLAIM_FILE)), false);
  s.done();
});
