// Run: node --test tests/skills.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { USER_EFFORTS } from '../plugin/scripts/user-models.mjs';
import { common, withoutCommon, SLASH_NAME } from './helpers.mjs';
import { BLOCKS, REPO as SKILLS_REPO, apply as skillsApply, check as skillsCheck, inputs as skillsInputs } from '../scripts/skills.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugin', 'skills');
const AGENT = path.resolve(ROOT, '..', 'agents', 'second-opinion.md');
const LIMITS = { plan: 120, check: 120, commit: 80, do: 80, auto: 80, solo: 80, lean: 80, land: 80, sessions: 80 };
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

// Shared blocks are written from shared/ by scripts/skills.mjs; a block edited in a SKILL.md alone fails here.
test('every shared block matches its source under shared/', () => {
  assert.deepEqual(skillsCheck(), []);
});

test('scripts/skills.mjs writes a changed block back, stops on a broken marker pair and keeps CRLF', () => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'am-skills-'));
  try {
    for (const file of skillsInputs()) cpSync(path.join(SKILLS_REPO, file), path.join(base, file), { recursive: true });
    const at = (file) => path.join(base, file);
    const get = (file) => readFileSync(at(file), 'utf8');
    const all = () => Object.fromEntries(skillsInputs(base).map((f) => [f, get(f)]));
    assert.deepEqual(skillsApply(base), { problems: [], changed: [] });
    const target = BLOCKS['sibling-parts'].targets[0];
    const original = get(target);
    // One character changed inside a block: only that file differs, and apply puts it back.
    writeFileSync(at(target), original.replace('never implemented whole', 'never implemented Whole'));
    assert.deepEqual(skillsCheck(base), [`${target}: sibling-parts 블록이 shared/sibling-parts.md 와 다릅니다`]);
    assert.deepEqual(skillsApply(base), { problems: [], changed: [target] });
    assert.equal(get(target), original);
    // An end marker twice is a problem, and nothing is written, not even another file's drift.
    const other = BLOCKS.common.targets[0];
    writeFileSync(at(other), get(other).replace('Ask at most 3 questions', 'Ask at most 4 questions'));
    writeFileSync(at(target), `${original}${BLOCKS['sibling-parts'].end}\n`);
    let before = all();
    let r = skillsApply(base);
    assert.equal(r.problems.length, 1);
    assert.match(r.problems[0], new RegExp(`^${target}: sibling-parts .*\\(시작 표시 1번, 끝 표시 2번\\)$`));
    assert.deepEqual(r.changed, []);
    assert.deepEqual(all(), before);
    writeFileSync(at(target), original);
    assert.deepEqual(skillsApply(base), { problems: [], changed: [other] });
    // A CRLF target keeps CRLF in the rewritten block.
    const crlf = original.replace(/\n/g, '\r\n');
    writeFileSync(at(target), crlf.replace('never implemented whole', 'never implemented Whole'));
    assert.deepEqual(skillsApply(base), { problems: [], changed: [target] });
    assert.equal(get(target), crlf);
    writeFileSync(at(target), original);
    // A source saved without its last newline still leaves the end marker on a line of its own.
    const source = BLOCKS['sibling-parts'].source;
    const sourceText = get(source);
    writeFileSync(at(source), sourceText.replace(/\n$/, ''));
    assert.deepEqual(skillsApply(base), { problems: [], changed: [] });
    writeFileSync(at(source), sourceText);
    // A block whose markers enclose another block's markers is a problem, not overwritten.
    const runs = BLOCKS['sibling-runs'];
    const nested = original.replace(`${runs.start}\n`, '').replace(BLOCKS.common.start, `${runs.start}\n${BLOCKS.common.start}`);
    writeFileSync(at(target), nested);
    r = skillsApply(base);
    assert.deepEqual(r, { problems: [`${target}: sibling-runs 블록 안에 다른 블록의 표시가 있습니다`], changed: [] });
    assert.equal(get(target), nested);
    writeFileSync(at(target), original);
    // A marker in a SKILL.md that is not on the block's target list, or an unknown block name, stops the script.
    mkdirSync(at('plugin/skills/x'));
    writeFileSync(at('plugin/skills/x/SKILL.md'), `# x\n${BLOCKS.common.start}\n${BLOCKS.common.end}\n<!-- am:shared:nope:start -->\n`);
    before = all();
    r = skillsApply(base);
    assert.equal(r.problems.length, 2);
    assert.match(r.problems[0], /^plugin\/skills\/x\/SKILL\.md: common 블록의 표시가 있지만 그 대상 목록에 없습니다/);
    assert.match(r.problems[1], /^plugin\/skills\/x\/SKILL\.md: 모르는 블록 이름 "nope"/);
    assert.deepEqual(all(), before);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
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

test('am:plan, am:do, am:auto, am:solo, am:lean and am:land are user-invoked only in both tools', () => {
  for (const name of ['plan', 'do', 'auto', 'solo', 'lean', 'land']) {
    assert.match(read(name), /\ndisable-model-invocation: true\n/, name);
    const yaml = readFileSync(path.join(ROOT, name, 'agents', 'openai.yaml'), 'utf8');
    assert.match(yaml, /allow_implicit_invocation: false/, name);
  }
});

test('every skill sets the model and effort its turn runs with', () => {
  for (const name of Object.keys(LIMITS)) {
    const fm = frontmatter(read(name));
    // Claude Code ignores a misspelled key without an error, which would silently drop the default.
    const userOnly = ['plan', 'do', 'auto', 'solo', 'lean', 'land'].includes(name) ? ['disable-model-invocation'] : [];
    const hooks = name === 'auto' ? ['hooks'] : [];
    assert.deepEqual(Object.keys(fm).sort(), ['argument-hint', 'description', 'effort', 'model', 'name', ...userOnly, ...hooks].sort(), name);
    assert.match(fm.model, ALIAS, name); // an alias, not a full ID: a skill whose model cannot be resolved has no fallback
    assert.ok(USER_EFFORTS.includes(fm.effort), `${name}: ${fm.effort}`);
  }
});

test('am:land lands from a temporary worktree, never force pushes and never touches the working tree', () => {
  const skill = withoutCommon(read('land'));
  for (const s of ['git worktree add --detach', 'git merge --no-ff', 'merge --continue', 'merge --abort', 'git worktree remove', 'git fetch . ', 'git ls-remote --symref origin HEAD', 'git branch -f <target> origin/<target>', '--set-upstream-to=origin/<target>', 'Never force push', "Never touch this folder's working tree"]) assert.ok(skill.includes(s), s);
  // Nothing that moves this folder's checkout, a commit the gate would check in the bare temp folder, or a ref move that skips the worktree check.
  assert.doesNotMatch(skill, /git (switch|checkout|stash|reset|restore|rebase|pull)\b/);
  for (const s of ['git commit', 'git update-ref', 'merge.md', 'commits.md', 'feature/<slug>']) assert.ok(!skill.includes(s), s);
  for (const line of skill.split('\n').filter((l) => l.includes('git push'))) assert.doesNotMatch(line, /--force|-f |\+/, line);
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

test('am:do writes a do result that am:check reads for aim only and am:commit uses for its file list', () => {
  const doSkill = read('do');
  assert.ok(doSkill.includes('Do result: rewrite `.am/<slug>/do-result.md` whole'));
  // The first line stays English in a plan of any language, so every reader parses it the same way.
  assert.ok(doSkill.includes('`Status: done` or `Status: stopped - <reason>`'));
  const check = read('check');
  for (const s of ['`.am/<slug>/do-result.md`', 'never as evidence']) assert.ok(check.includes(s), s);
  assert.ok(read('commit').includes('do-result.md'));
});

test('am:auto declares the hand-over hook, and only am:auto', () => {
  // Claude Code only (measured on 2.1: a plugin skill's frontmatter hook registers when the skill is invoked and
  // stays for the session, with CLAUDE_PLUGIN_ROOT set). One line, so the frontmatter stays one key per line.
  // am:lean has no hook: a skill's frontmatter hook does not run in its subagents (.am/subagent-stages/facts.md (a)).
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

test('am:lean follows am:auto\'s file and replaces its stage sessions with stage agents', async () => {
  const lean = withoutCommon(read('lean'));
  const { MARKS, PART_LINE } = await import('../plugin/scripts/stage.mjs');
  const cmd = 'node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-stage.mjs"';
  for (const s of ['${CLAUDE_PLUGIN_ROOT}/skills/auto/SKILL.md', '`## Stage sessions (Claude Code)`', '\n## Stage agents (Claude Code)\n', '`HANDED`', 'step 2', 'step 4', 'step 7']) assert.ok(lean.includes(s), s);
  // The four commands of agent-stage.mjs, the keys of start's JSON line and the fixed prompt of the stage agent.
  for (const s of [`${cmd} start <stage> <slug>`, `${cmd} end <slug> <runId> failed`, `${cmd} end <slug> <runId> <status>`, `${cmd} card <slug>`, `${cmd} answer <slug> <that file>`]) assert.ok(lean.includes(`\`${s}\``), s);
  for (const k of ['agent', 'rules', 'skill', 'runId', 'model', 'effort', 'wait', 'note', 'error']) assert.ok(lean.includes(`\`${k}\``), k);
  assert.ok(lean.includes('exactly this prompt: `slug <slug>; stage <stage>; runId <runId>; rules file <rules>; SKILL.md <skill>`'));
  assert.ok(lean.includes('`AM_STAGE: <status> <runId>`'));
  for (const status of [...new Set([...Object.values(MARKS).flat(), 'BLOCKED', 'failed'])]) assert.ok(lean.includes(`\`${status}\``), `status ${status}`);
  for (const f of ['--push', '--fix', '--part']) assert.ok(lean.includes(`\`${f}\``), f);
  // The driver stays independent of the stages' files; the user decisions allow only these Grep patterns and writes.
  assert.ok(lean.includes('until the last stage ends or you stop, never read the reply files, check.md, do-result.md, opinion or codex files or plan.md; only the commands and Grep patterns below touch them, and you write no brief.'));
  for (const s of ['`^(- )?(Scale: [0-9]+ implementation run|규모: 구현 [0-9]+회)`', '`^- Part [0-9]+: Steps`', '`^- Part [0-9]+ done: `', '`.am/<slug>.answer-<n>.md`', 'Continue the existing plan in .am/<slug>/plan.md.']) assert.ok(lean.includes(s), s);
  for (const s of ['`"ev":"end"`', 'stage: "handover"']) assert.ok(lean.includes(s), s);
  assert.ok(lean.includes(PART_LINE), 'PART_LINE');
  for (const s of ['- Part <k> done:', '`Part <k> of <N> of .am/<slug>/plan.md:`', '`Part <k> of <N> of .am/<parent>/plan.md:`']) assert.ok(lean.includes(s), s);
  // It copies the Parts rules instead of reading am:solo, and runs neither the orchestrator nor stage sessions.
  for (const s of ['skills/solo/SKILL.md', 'skills/run/SKILL.md', 'scripts/stage.mjs', 'progress.mjs', '--solo']) assert.ok(!lean.includes(s), s);
  // The fixed command that logs a part as done, run as written on copies of a parent plan.
  const m = /`node -e '([^']*)' \.am\/<slug>\/plan\.md '- Part <k> done: <slug>-p<k>'`/.exec(lean);
  assert.ok(m, 'the Part done command');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'am-lean-'));
  try {
    const line = '- Part 2 done: big-p2';
    const run = (text) => {
      const f = path.join(dir, 'plan.md');
      writeFileSync(f, text);
      const r = spawnSync('bash', ['-c', `node -e '${m[1]}' "$1" "$2"`, '_', f, line], { encoding: 'utf8' });
      return { code: r.status, out: r.stdout + r.stderr, text: readFileSync(f, 'utf8') };
    };
    const cases = [
      ['# P\n\n## Change log\n- a\n\n## 다음\nx\n', 0, `# P\n\n## Change log\n- a\n${line}\n\n## 다음\nx\n`],
      ['# P\n\n## Change log\n- a\n', 0, `# P\n\n## Change log\n- a\n${line}\n`],
      ['# P\r\n\r\n## Change log\r\n- a\r\n\r\n## 다음\r\n', 0, `# P\r\n\r\n## Change log\r\n- a\r\n${line}\r\n\r\n## 다음\r\n`],
      [`## Change log\n${line}\n\n## 다음\n`, 0, `## Change log\n${line}\n\n## 다음\n`],
      ['# P\n\n## 다음\n', 1, '# P\n\n## 다음\n'],
    ];
    for (const [text, code, want] of cases) assert.deepEqual(run(text), { code, out: '', text: want }, JSON.stringify(text));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('am:auto keeps the anchors am:solo and am:lean refer to', () => {
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

// am:lean stage agents; their values are models.json's through STAGE_AGENTS of scripts/models.mjs (tests/models.test.mjs).
const STAGE_AGENT_NAMES = ['stage-plan', 'stage-do', 'stage-check', 'stage-commit', 'stage-commit-push'];
const AGENTS_DIR = path.dirname(AGENT);

test('am:lean stage agents stay pinned', () => {
  const rest = [];
  for (const name of STAGE_AGENT_NAMES) {
    const text = readFileSync(path.join(AGENTS_DIR, `${name}.md`), 'utf8');
    const fm = frontmatter(text);
    // Claude Code ignores a misspelled key without an error, and plugin agents ignore hooks and permissionMode.
    assert.deepEqual(Object.keys(fm).sort(), ['description', 'effort', 'model', 'name', 'tools'], name);
    assert.equal(fm.name, name);
    assert.match(fm.model, ALIAS, name);
    assert.ok(USER_EFFORTS.includes(fm.effort), `${name}: ${fm.effort}`);
    assert.equal(fm.tools, name === 'stage-check' ? 'Read, Grep, Glob, Write, Edit, Bash, Agent' : 'Read, Grep, Glob, Write, Edit, Bash', name);
    assert.match(fm.description, /^"[^"]{40,}"$/, name);
    assert.ok(fm.description.includes('am 스킬이 부를 때만'), name);
    const body = text.replace(/^---\n[\s\S]*?\n---\n/, '');
    assert.doesNotMatch(body, /[가-힣]/, `${name}: English body`);
    for (const s of ['rules file', 'SKILL.md', '`.am/<slug>/reply-<stage>.md`', '`AM_STAGE: <status> <runId>`', '`AM_STAGE: BLOCKED <runId>`', 'MISSING_RUN_ID']) assert.ok(body.includes(s), `${name}: ${s}`);
    const lines = body.split('\n');
    assert.ok(lines.includes(`# am:${name}`), `${name}: title`);
    const stageLine = lines.find((l) => l.startsWith('You run the '));
    assert.ok(stageLine?.includes(name === 'stage-commit-push' ? 'push' : name.slice('stage-'.length)), `${name}: ${stageLine}`);
    rest.push(lines.filter((l) => l !== `# am:${name}` && l !== stageLine).join('\n'));
  }
  // One shared body: what differs per stage lives in the rules file, the SKILL.md, tools and the hooks.
  for (const r of rest.slice(1)) assert.equal(r, rest[0]);
});

test('plugin/agents holds only the reviewer and the stage agents', () => {
  assert.deepEqual(readdirSync(AGENTS_DIR).sort(), ['second-opinion.md', ...STAGE_AGENT_NAMES.map((n) => `${n}.md`)].sort());
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
