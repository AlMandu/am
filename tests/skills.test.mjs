// Run: node --test tests/skills.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { USER_EFFORTS } from '../plugin/scripts/user-models.mjs';
import { common, flowNames, withoutCommon, withFlow, SLASH_NAME } from './helpers.mjs';
import { BLOCKS, REPO as SKILLS_REPO, apply as skillsApply, check as skillsCheck, inputs as skillsInputs } from '../scripts/skills.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.join(REPO_ROOT, 'plugin', 'skills');
const AGENT = path.resolve(ROOT, '..', 'agents', 'second-opinion.md');
// am-auto's folder: its skills, scripts, hooks and stage agents.
const AUTO = path.join(REPO_ROOT, 'auto');
const LIMITS = { plan: 120, check: 120, commit: 80, do: 80, multi: 80, one: 80, agent: 80, relay: 80, land: 80, 'update-branch': 80, sessions: 80, 'ad-review': 150, 'ad-auto': 40, 'pipe-apply': 120, 'log-compare': 100, 'log-resume': 120, 'git-sync': 100, 'ad-execute': 120 };
// am-art's Claude Code skills carry the art owner rules block instead of the common block (scripts/skills.mjs BLOCKS.art).
const ART = ['ad-review', 'pipe-apply', 'log-compare', 'log-resume'];
// Every am-art skill: ad-execute is the Codex worker's and ad-auto only runs ad-review in a forked subagent; both carry neither block.
const ART_PLUGIN = [...ART, 'ad-auto', 'ad-execute'];
const skillPath = (name) => `${SKILL_HOME[name] ?? 'plugin'}/${SKILL_SUB[name] ?? 'skills'}/${name}/SKILL.md`;
// Plugin folder of each skill that is not in plugin/ (am); the folders scanned for skill folders.
const SKILL_HOME = { land: 'util', 'update-branch': 'util', 'git-sync': 'util', multi: 'auto', one: 'auto', agent: 'auto', relay: 'auto', sessions: 'auto', ...Object.fromEntries(ART_PLUGIN.map((n) => [n, 'art'])) };
const PLUGIN_FOLDERS = ['plugin', 'util', 'auto', 'art'];
// am-art has no default skills/ (both tools add a manifest's skills path to it): art/claude-skills/ for Claude Code, art/codex-skills/ for Codex (user decision).
const SKILL_SUB = { ...Object.fromEntries(ART.map((n) => [n, 'claude-skills'])), 'ad-auto': 'claude-skills', 'ad-execute': 'codex-skills' };
const SKILL_ROOTS = [...PLUGIN_FOLDERS.map((f) => [f, 'skills']), ['art', 'claude-skills'], ['art', 'codex-skills']];
// Skills with neither the common nor the art block: am-util:git-sync keeps three artist rules in its body, because the
// common block's decision cards and "never revert others' changes" clash with what it does, and the art block names art.json.
const NO_BLOCK = ['git-sync'];
const skillDir = (name) => path.join(REPO_ROOT, SKILL_HOME[name] ?? 'plugin', SKILL_SUB[name] ?? 'skills', name);
// The values themselves are models.json's (tests/models.test.mjs checks them where that file exists); here only their form.
const ALIAS = /^[a-z]+(\[1m\])?$/;
const read = (name) => readFileSync(path.join(skillDir(name), 'SKILL.md'), 'utf8');
// A skill as it runs: its SKILL.md and the flow files it reads (auto/flow/, not a skill).
const readFlow = (name) => withFlow(path.join(skillDir(name), 'SKILL.md'));
const FLOW = path.join(AUTO, 'flow');
const flowFile = (name) => readFileSync(path.join(FLOW, name), 'utf8');
const frontmatter = (text) => {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(m, 'frontmatter');
  return Object.fromEntries(m[1].split('\n').map((line) => {
    const i = line.indexOf(':');
    return [line.slice(0, i), line.slice(i + 1).trim()];
  }));
};

test('every am, am-auto and am-util skill carries the same common rules block, and the am-art skills the art block instead', () => {
  const commonSkills = Object.keys(LIMITS).filter((n) => !ART_PLUGIN.includes(n) && !NO_BLOCK.includes(n));
  for (const n of commonSkills) assert.ok(BLOCKS.common.targets.includes(skillPath(n)), n);
  assert.ok(BLOCKS.common.targets.includes('orchestrator/skills/run/SKILL.md'));
  const blocks = commonSkills.map((n) => common(read(n)));
  for (const b of blocks.slice(1)) assert.equal(b, blocks[0]);
  assert.deepEqual(BLOCKS.art.targets, ART.map(skillPath));
  for (const n of ART) {
    assert.ok(!read(n).includes(BLOCKS.common.start), n);
    assert.ok(read(n).includes(BLOCKS.art.start), n);
  }
  for (const n of NO_BLOCK) {
    assert.ok(!read(n).includes('<!-- am:'), n);
    assert.ok(!BLOCKS.common.targets.includes(skillPath(n)) && !BLOCKS.art.targets.includes(skillPath(n)), n);
  }
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
    const target = BLOCKS.common.targets[0];
    const original = get(target);
    // One character changed inside a block: only that file differs, and apply puts it back.
    writeFileSync(at(target), original.replace('Ask at most 3 questions', 'Ask at most 3 Questions'));
    assert.deepEqual(skillsCheck(base), [`${target}: common 블록이 shared/common.md 와 다릅니다`]);
    assert.deepEqual(skillsApply(base), { problems: [], changed: [target] });
    assert.equal(get(target), original);
    // An end marker twice is a problem, and nothing is written, not even another file's drift.
    const other = BLOCKS.common.targets[1];
    writeFileSync(at(other), get(other).replace('Ask at most 3 questions', 'Ask at most 4 questions'));
    writeFileSync(at(target), `${original}${BLOCKS.common.end}\n`);
    let before = all();
    let r = skillsApply(base);
    assert.equal(r.problems.length, 1);
    assert.match(r.problems[0], new RegExp(`^${target}: common .*\\(시작 표시 1번, 끝 표시 2번\\)$`));
    assert.deepEqual(r.changed, []);
    assert.deepEqual(all(), before);
    writeFileSync(at(target), original);
    assert.deepEqual(skillsApply(base), { problems: [], changed: [other] });
    // A CRLF target keeps CRLF in the rewritten block.
    const crlf = original.replace(/\n/g, '\r\n');
    writeFileSync(at(target), crlf.replace('Ask at most 3 questions', 'Ask at most 3 Questions'));
    assert.deepEqual(skillsApply(base), { problems: [], changed: [target] });
    assert.equal(get(target), crlf);
    writeFileSync(at(target), original);
    // A source saved without its last newline still leaves the end marker on a line of its own.
    const source = BLOCKS.common.source;
    const sourceText = get(source);
    writeFileSync(at(source), sourceText.replace(/\n$/, ''));
    assert.deepEqual(skillsApply(base), { problems: [], changed: [] });
    writeFileSync(at(source), sourceText);
    // A marker inside a block (here of an unknown name) is a problem, not overwritten.
    const nested = original.replace(`${BLOCKS.common.start}\n`, `${BLOCKS.common.start}\n<!-- am:shared:nope:start -->\n`);
    writeFileSync(at(target), nested);
    r = skillsApply(base);
    assert.equal(r.problems.length, 2);
    assert.match(r.problems[0], new RegExp(`^${target}: 모르는 블록 이름 "nope"`));
    assert.equal(r.problems[1], `${target}: common 블록 안에 다른 블록의 표시가 있습니다`);
    assert.deepEqual(r.changed, []);
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

// The one slash name kept: ad-review's /loop command line, which the owner types as it is.
const LOOP_LINE = '`/loop 5m /am-art:ad-auto`';
test('am skills refer to other skills by name, not with a slash prefix', () => {
  for (const name of Object.keys(LIMITS)) {
    let text = withoutCommon(read(name));
    if (name === 'ad-review') {
      assert.equal(text.split(LOOP_LINE).length, 2, LOOP_LINE);
      text = text.replace(LOOP_LINE, '');
    }
    assert.doesNotMatch(text, SLASH_NAME, name);
  }
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

test('am:plan, am:do, am-auto:multi, am-auto:one, am-auto:agent, am-auto:relay, am-util:land, am-util:update-branch and am-util:git-sync are user-invoked only in both tools', () => {
  for (const name of ['plan', 'do', 'multi', 'one', 'agent', 'relay', 'land', 'update-branch', 'git-sync']) {
    assert.match(read(name), /\ndisable-model-invocation: true\n/, name);
    const yaml = readFileSync(path.join(skillDir(name), 'agents', 'openai.yaml'), 'utf8');
    assert.match(yaml, /allow_implicit_invocation: false/, name);
  }
});

// am-art serves both tools: ad-execute is the Codex worker's, ad-review the Claude Code AD's (user decision); the stop lines stay as a last guard.
const AD_EXECUTE_TRIGGERS = ['피드백 채널 최신 지시서대로 작업', '지시서 ㄱㄱ', '지시서 읽어', '지시서 다시 읽어', '지시서 확인', '‘실무자’', '‘실무’', '실무자1', '실무자 2', '실무자 대기', '실무자2번. 대기.', '너는 실무자 2번이야', '이어서 작업', '계속 진행해', '013 지시서를 실행', '피드백/.../NNN_..._지시.md', 'FB §5 → 011 지시 실행'];
test('am-art: ad-execute stops in Claude Code, ad-review stops in Codex, and Codex picks none of the other three on its own', () => {
  const text = read('ad-execute');
  for (const s of [BLOCKS.common.start, BLOCKS.art.start, '${CLAUDE_PLUGIN_ROOT}', 'AskUserQuestion']) assert.ok(!text.includes(s), `ad-execute: ${s}`);
  assert.ok(!existsSync(path.join(skillDir('ad-execute'), 'agents', 'openai.yaml')), 'Codex may pick ad-execute on its own');
  const fm = frontmatter(text);
  assert.equal(fm['disable-model-invocation'], 'true');
  const desc = fm.description.slice(1, -1);
  assert.ok(desc.length <= 1024, `description: ${desc.length} characters`);
  for (const s of [...AD_EXECUTE_TRIGGERS, 'Codex 전용']) assert.ok(desc.includes(s), s);
  // Each stop line comes right after the argument line, before anything else is read.
  const after = (t) => t.split('\n')[t.split('\n').indexOf('Argument: $ARGUMENTS') + 1];
  assert.match(after(text), /^If you are Claude Code, not Codex: .*, and stop;/);
  // The shared contract files are named once, in their one section.
  const contract = text.split('\n## Shared contract')[1].split('\n## ')[0];
  for (const f of ['`AGENTS.md`', '`02_Codex_실무자_수칙.md`', '`01_역할정의_워크플로우.md`', '`03_문서_템플릿.md`', '`프로젝트/<프로젝트>_<타입>_설정.md`']) {
    assert.ok(contract.includes(f), f);
    assert.equal(text.split(f).length, 2, `${f} once`);
  }
  const review = read('ad-review');
  assert.match(after(review), /^If you are not Claude Code \(for example Codex\): .*am-art:ad-execute.*, and stop;/);
  assert.ok(review.indexOf(after(review)) < review.indexOf(BLOCKS.art.start));
  assert.match(frontmatter(review).description, /Claude Code 전용/);
  for (const n of ART) assert.match(readFileSync(path.join(skillDir(n), 'agents', 'openai.yaml'), 'utf8'), /allow_implicit_invocation: false/, n);
});

test('am-util:git-sync is Claude Code only and keeps its pattern list in am-util', () => {
  const text = read('git-sync');
  const lines = text.split('\n');
  assert.match(lines[lines.indexOf('Argument: $ARGUMENTS') + 1], /^If you are not Claude Code \(for example Codex\): .*, and stop;/);
  assert.match(frontmatter(text).description, /Claude Code 전용/);
  assert.ok(text.includes('node "${CLAUDE_PLUGIN_ROOT}/scripts/git-sync-settings.mjs"'));
  assert.ok(!text.includes('art-settings'));
  for (const s of ['(추천)', 'file:///']) assert.ok(text.includes(s), s);
  assert.ok(existsSync(path.join(REPO_ROOT, 'util', 'scripts', 'git-sync-settings.mjs')));
});

// The loop runs each unattended AD round in a forked subagent, so the owner's conversation keeps only the reports (user decision).
test('am-art:ad-auto runs one ad-review 자동 round in a forked subagent, and idle rounds read little', () => {
  const text = read('ad-auto');
  const fm = frontmatter(text);
  assert.equal(fm.context, 'fork');
  // A forked skill runs from /loop only when the model may invoke it.
  assert.ok(!('disable-model-invocation' in fm), 'model-invocable');
  assert.match(fm.description, /Claude Code 전용/);
  for (const s of ['am-art:ad-review', '`자동`', 'Skill tool', '검수할 문서 없음', '오너 대기 목록']) assert.ok(text.includes(s), s);
  for (const s of [BLOCKS.common.start, BLOCKS.art.start, 'AskUserQuestion']) assert.ok(!text.includes(s), s);
  const lines = text.split('\n');
  assert.match(lines[lines.indexOf('Argument: $ARGUMENTS') + 1], /^If you are not Claude Code \(for example Codex\): .*, and stop;/);
  assert.match(readFileSync(path.join(skillDir('ad-auto'), 'agents', 'openai.yaml'), 'utf8'), /allow_implicit_invocation: false/);
  // Idle rounds: ad-review's 자동 mode and ad-execute's wait mode look before reading the whole package again.
  assert.ok(read('ad-review').includes("in `자동` mode, first do Step 1's search"), 'ad-review idle check');
  assert.ok(read('ad-execute').includes('- Idle check, every round after the first:'), 'ad-execute idle check');
});

// The one exception to "no Codex-only copies": each tool's manifest names its own skill folder, and art/ has no default skills/ that both would add (user decision).
test('am-art: Claude Code sees only art/claude-skills, Codex only art/codex-skills with ad-execute alone', () => {
  assert.ok(!existsSync(path.join(REPO_ROOT, 'art', 'skills')), 'art/skills would be added to both tools');
  assert.deepEqual(readdirSync(path.join(REPO_ROOT, 'art', 'claude-skills')).sort(), [...ART, 'ad-auto'].sort());
  assert.deepEqual(readdirSync(path.join(REPO_ROOT, 'art', 'codex-skills')), ['ad-execute']);
  const manifest = (tool) => JSON.parse(readFileSync(path.join(REPO_ROOT, 'art', tool, 'plugin.json'), 'utf8'));
  const claude = manifest('.claude-plugin');
  const codex = manifest('.codex-plugin');
  for (const key of ['name', 'version', 'description']) assert.equal(codex[key], claude[key], key);
  assert.equal(codex.skills, './codex-skills/');
  assert.equal(claude.skills, './claude-skills/');
  // No other folder of the repository carries a Codex-only manifest.
  const others = readdirSync(REPO_ROOT, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== 'art' && existsSync(path.join(REPO_ROOT, e.name, '.codex-plugin')));
  assert.deepEqual(others.map((e) => e.name), []);
  assert.ok(!existsSync(path.join(REPO_ROOT, '.codex-plugin')), 'root .codex-plugin');
});

test('every skill folder of every plugin folder is a skill with limits, in its own plugin folder', () => {
  const found = [];
  for (const [folder, sub] of SKILL_ROOTS) {
    const dir = path.join(REPO_ROOT, folder, sub);
    if (!existsSync(dir)) continue;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      found.push(e.name);
      assert.equal(`${folder}/${sub}`, `${SKILL_HOME[e.name] ?? 'plugin'}/${SKILL_SUB[e.name] ?? 'skills'}`, `${folder}/${sub}/${e.name}`);
    }
  }
  assert.deepEqual(found.sort(), Object.keys(LIMITS).sort());
});

// Each plugin is installed on its own; only am-auto depends on am (it runs am's skills).
test('am, am-util and am-art declare no dependencies, and am-auto depends on am alone', () => {
  const market = JSON.parse(readFileSync(path.join(REPO_ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'));
  assert.equal(market.plugins.find((p) => p.name === 'am-art')?.source, './art');
  for (const name of ['am', 'am-util', 'am-art']) {
    const entry = market.plugins.find((p) => p.name === name);
    assert.ok(entry, name);
    const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, entry.source, '.claude-plugin', 'plugin.json'), 'utf8'));
    assert.ok(!('dependencies' in manifest), name);
  }
  const auto = market.plugins.find((p) => p.name === 'am-auto');
  assert.equal(auto?.source, './auto');
  assert.deepEqual(JSON.parse(readFileSync(path.join(REPO_ROOT, 'auto', '.claude-plugin', 'plugin.json'), 'utf8')).dependencies, ['am']);
});

test('the skills checked here and the common and art block targets are every SKILL.md of the plugin folders', () => {
  const actual = [];
  for (const [folder, sub] of SKILL_ROOTS) {
    const dir = path.join(REPO_ROOT, folder, sub);
    if (!existsSync(dir)) continue;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && existsSync(path.join(dir, e.name, 'SKILL.md'))) actual.push(`${folder}/${sub}/${e.name}/SKILL.md`);
    }
  }
  actual.sort();
  assert.deepEqual(Object.keys(LIMITS).map(skillPath).sort(), actual);
  const artPlugin = [...ART_PLUGIN, ...NO_BLOCK].map(skillPath);
  assert.deepEqual([...BLOCKS.common.targets].sort(), [...actual.filter((f) => !artPlugin.includes(f)), 'orchestrator/skills/run/SKILL.md'].sort());
  assert.deepEqual([...BLOCKS.art.targets].sort(), ART.map(skillPath).sort());
});

// A copy moved to another plugin folder must still find what it imports; a static check would miss a lost export name.
test('every .mjs of the plugin folders loads in a child process', () => {
  const config = mkdtempSync(path.join(os.tmpdir(), 'am-import-'));
  try {
    const files = [];
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(dir, e.name));
        else if (e.name.endsWith('.mjs')) files.push(path.join(dir, e.name));
      }
    };
    for (const folder of PLUGIN_FOLDERS) if (existsSync(path.join(REPO_ROOT, folder))) walk(path.join(REPO_ROOT, folder));
    assert.ok(files.some((f) => f.includes(`${path.sep}util${path.sep}`)), 'util copies found');
    assert.ok(files.some((f) => f.endsWith(path.join('auto', 'hooks', 'stage-hook.mjs'))), 'auto files found');
    for (const file of files) {
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', 'await import(process.argv[1])', pathToFileURL(file).href], { cwd: config, input: '', encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: config }, timeout: 30000 });
      const where = path.relative(REPO_ROOT, file);
      assert.equal(r.status, 0, `${where}: ${r.stderr}`);
      // hook.mjs catches a failed import and still exits 0, with a crash notice.
      assert.ok(!`${r.stdout}${r.stderr}`.includes('crashed'), `${where}: ${r.stdout}${r.stderr}`);
    }
  } finally {
    rmSync(config, { recursive: true, force: true });
  }
});

test('every skill sets the model and effort its turn runs with', () => {
  for (const name of Object.keys(LIMITS)) {
    const fm = frontmatter(read(name));
    // Claude Code ignores a misspelled key without an error, which would silently drop the default.
    const userOnly = ['plan', 'do', 'multi', 'one', 'agent', 'relay', 'land', 'update-branch', 'git-sync', 'ad-execute'].includes(name) ? ['disable-model-invocation'] : [];
    const hooks = name === 'multi' ? ['hooks'] : [];
    // ad-auto runs in a forked subagent; its model value is that subagent's.
    const fork = name === 'ad-auto' ? ['context'] : [];
    assert.deepEqual(Object.keys(fm).sort(), ['argument-hint', 'description', 'effort', 'model', 'name', ...userOnly, ...hooks, ...fork].sort(), name);
    assert.match(fm.model, ALIAS, name); // an alias, not a full ID: a skill whose model cannot be resolved has no fallback
    assert.ok(USER_EFFORTS.includes(fm.effort), `${name}: ${fm.effort}`);
  }
});

test('am-util:land lands from a temporary worktree, never force pushes and only fast-forwards this folder at the end', () => {
  const skill = withoutCommon(read('land'));
  for (const s of ['git worktree add --detach', 'merge --no-ff --no-edit', 'merge --continue', 'merge --abort', 'git worktree remove', 'git fetch . ', 'git ls-remote --symref origin HEAD', 'git branch -f <target> origin/<target>', '--set-upstream-to=origin/<target>', 'Never force push', "Until step 8, never touch this folder's working tree", 'git merge --ff-only --no-autostash --no-overwrite-ignore', 'even if the local target update or upstream setup failed', 'ProjectSettings/ProjectVersion.txt', 'git -C <temp> checkout --ours -- <path>', 'without waiting for an answer', 'is in use or access is denied', 'choose reload']) assert.ok(skill.includes(s), s);
  // The Unity editor may stay open: no question that waits for it to be closed.
  assert.ok(!skill.includes('confirm the Unity editor is closed'));
  // No destructive checkout change, commit that runs the gate in the temp folder, or unchecked ref move.
  assert.doesNotMatch(skill, /git (switch|checkout|stash|reset|restore|rebase|pull)\b/);
  // Even in the temp worktree a checkout only takes one side of a conflicted file.
  assert.doesNotMatch(skill, /checkout (?!--(ours|theirs) -- <path>)/);
  for (const s of ['git commit', 'git update-ref', 'merge.md', 'commits.md', 'feature/<slug>']) assert.ok(!skill.includes(s), s);
  for (const line of skill.split('\n').filter((l) => l.includes('git push'))) assert.doesNotMatch(line, /--force|-f |\+/, line);
  for (const line of skill.split('\n').filter((l) => l.includes('git merge ') && !l.includes('-C <temp>'))) assert.ok(line.includes('--ff-only'), line);
});

test('am-util:update-branch forces the base like reset --hard without checkout, never commits, pushes or stashes, and restores the WIP only by its message', () => {
  const skill = withoutCommon(read('update-branch'));
  for (const s of ['git branch -f <base> origin/<base>', 'git commit-tree', 'git update-ref', 'git reset --mixed HEAD~1', '-c rebase.updateRefs=false rebase <onto>', 'git rebase --abort', 'git check-ref-format --branch', 'git switch -c', 'git worktree list', 'backup/', '## Back to the backup', 'git switch --no-overwrite-ignore -C <branch> <backup>', 'without waiting for an answer', 'is in use or access is denied', 'choose reload']) assert.ok(skill.includes(s), s);
  // The Unity editor may stay open: no question that waits for it to be closed.
  assert.ok(!skill.includes('confirm the Unity editor is closed'));
  // Going back runs the Back to the backup section, not the old promise that left the branch moved.
  assert.ok(!skill.includes('moving to the backup and then undoing'));
  // The WIP commit is plumbing (a commit command would run the gate), and the restore checks the commit's message first.
  assert.ok(skill.includes('if `git log -1 --format=%s HEAD` equals `<wip-msg>`, run `git reset --mixed HEAD~1`'));
  assert.doesNotMatch(skill, /git commit(?!-tree)/);
  for (const s of ['git push', '--force', 'git stash', 'reset --hard']) assert.ok(!skill.includes(s), s);
  // A checkout only takes one side of a conflicted file, never the base branch.
  assert.doesNotMatch(skill, /git checkout (?!--(ours|theirs) -- <path>)/);
});

test('am:commit records its commits outside am-orchestrator', () => {
  // am:commit writes the record, except in a session am-orchestrator started (the words every orchestrator session gets).
  assert.match(read('commit'), /your instructions do not say you are running inside am-orchestrator, append `<full hash> <subject>` as one line to `\.am\/<slug>\/commits\.md`/);
  const orch = readFileSync(path.resolve(ROOT, '..', '..', 'orchestrator', 'scripts', 'orchestrator.mjs'), 'utf8');
  assert.ok(orch.includes("'You are running inside am-orchestrator, an unattended batch run."));
});

test('the workflow skills keep no handoff document and mark the current task outside am-orchestrator', () => {
  // Progress lives in plan.md and do-result.md; no skill writes or reads handoff.md any more.
  for (const name of ['plan', 'do', 'check', 'commit']) assert.ok(!/handoff/i.test(read(name)), name);
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

test('am-auto:multi declares the hand-over hook, and only am-auto:multi', () => {
  // Claude Code only (measured on 2.1: a plugin skill's frontmatter hook registers when the skill is invoked and
  // stays for the session, with CLAUDE_PLUGIN_ROOT set). One line, so the frontmatter stays one key per line.
  // am-auto:agent has no hook: a skill's frontmatter hook does not run in its subagents (.am/subagent-stages/facts.md (a)).
  const line = `hooks: { PreToolUse: [ { matcher: "Read|Edit|Write|MultiEdit|NotebookEdit", hooks: [ { type: command, command: "node -e \\"import(require('url').pathToFileURL(process.env.CLAUDE_PLUGIN_ROOT+'/hooks/handover.mjs')).then((m) => m.main()).catch(() => {})\\"", timeout: 60 } ] } ] }`;
  assert.ok(read('multi').includes(`\n${line}\nmodel: `));
  assert.ok(existsSync(path.join(AUTO, 'hooks', 'handover.mjs')));
  for (const name of Object.keys(LIMITS).filter((n) => n !== 'multi')) assert.doesNotMatch(read(name), /\nhooks:/, name);
  assert.match(read('multi'), /this skill's hook denies file edits outside `\.am\/`/);
});

test('am-auto:multi drives the stage runner and handles every status it prints', async () => {
  const auto = readFlow('multi');
  const { MARKS, STAGES } = await import('../auto/scripts/stage.mjs');
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

test('am-auto:one follows the flow files with its own additions', async () => {
  const solo = withoutCommon(read('one'));
  const flow = withoutCommon(readFlow('one'));
  const { PART_LINE } = await import('../auto/scripts/stage.mjs');
  for (const s of ['${CLAUDE_PLUGIN_ROOT}/flow/run.md', '${CLAUDE_PLUGIN_ROOT}/flow/parts.md', '${CLAUDE_PLUGIN_ROOT}/flow/stage-sessions.md', '`--solo`', '--solo=', '`solo`', '`context`', 'step 7']) assert.ok(solo.includes(s), s);
  for (const s of ['## Parts', '- Part <k> done:', 'consecutive Steps', 'done mark']) assert.ok(flow.includes(s), s);
  for (const s of ['skills/multi/SKILL.md', '`HANDED`']) assert.ok(!solo.includes(s), s);
  // A part request's first line: a later run reads part folders written earlier and stops when it does not match.
  for (const s of ['`Part <k> of <N> of .am/<slug>/plan.md:`', '`Part <k> of <N> of .am/<parent>/plan.md:`']) assert.ok(flow.includes(s), s);
  // The plan stage writes the Parts lines in this form; in a session with no stage sessions am-auto:one writes them itself.
  assert.ok(flow.includes(PART_LINE), 'PART_LINE');
  assert.ok(!solo.includes('skills/run/SKILL.md'));
  // Push mode belongs to the stage flow of each part (loop step 3 of parts.md), not only to the Codex loop.
  const push = "In push mode each part's commit stage pushes.";
  const loop = flowFile('parts.md').split('\n## Parts\n')[1].split('\n');
  assert.ok(loop.find((l) => l.startsWith('  3. ')).includes(push), 'push on loop step 3');
  const parts = solo.split('\n## Parts\n')[1].split('\n## ')[0].split('\n');
  assert.ok(!parts.find((l) => l.includes('In Codex, or after')).includes(push), 'push not on the Codex line');
});

test('am-auto:agent follows the shared flow and runs its stages as stage agents instead of stage sessions', async () => {
  const lean = withoutCommon(read('agent'));
  // The stage agents' flow lives in flow/stage-agents.md, which am-auto:relay and a receiving session read too.
  const shared = withoutCommon(readFlow('agent'));
  const stageAgents = flowFile('stage-agents.md');
  const { MARKS, PART_LINE } = await import('../auto/scripts/stage.mjs');
  const cmd = 'node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-stage.mjs"';
  for (const s of ['${CLAUDE_PLUGIN_ROOT}/flow/run.md', '${CLAUDE_PLUGIN_ROOT}/flow/stage-agents.md', 'step 7']) assert.ok(lean.includes(s), s);
  assert.ok(stageAgents.includes('\n## Stage agents (Claude Code)\n'), 'the Stage agents section');
  for (const text of [lean, stageAgents]) for (const s of ['skills/multi/SKILL.md', 'stage-sessions.md', '`## Stage sessions (Claude Code)`', '`HANDED`']) assert.ok(!text.includes(s), s);
  // The four commands of agent-stage.mjs, the keys of start's JSON line and the fixed prompt of the stage agent.
  for (const s of [`${cmd} start <stage> <slug>`, `${cmd} end <slug> <runId> failed`, `${cmd} end <slug> <runId> <status>`, `${cmd} card <slug>`, `${cmd} answer <slug> <that file>`]) assert.ok(shared.includes(`\`${s}\``), s);
  for (const k of ['agent', 'rules', 'skill', 'runId', 'model', 'effort', 'wait', 'note', 'error']) assert.ok(shared.includes(`\`${k}\``), k);
  assert.ok(shared.includes('exactly this prompt: `slug <slug>; stage <stage>; runId <runId>; rules file <rules>; SKILL.md <skill>`'));
  assert.ok(shared.includes('`AM_STAGE: <status> <runId>`'));
  // Every status but the hand-over's: am-auto:agent never hands over.
  for (const status of [...new Set([...Object.values(MARKS).flat(), 'BLOCKED', 'failed'])].filter((s) => s !== 'HANDED')) assert.ok(shared.includes(`\`${status}\``), `status ${status}`);
  for (const f of ['--push', '--fix', '--part']) assert.ok(shared.includes(`\`${f}\``), f);
  // The driver stays independent of the stages' files; the user decisions allow only these Grep patterns and writes.
  assert.ok(shared.includes('until the last stage ends or you stop, never read the reply files, check.md, do-result.md, opinion or codex files or plan.md; only the commands and Grep patterns below touch them, and you write no brief.'));
  for (const s of ['`^(- )?(Scale: [0-9]+ implementation run|규모: 구현 [0-9]+회)`', '`^- Part [0-9]+: Steps`', '`^- Part [0-9]+ done: `', '`.am/<slug>.answer-<n>.md`', 'Continue the existing plan in .am/<slug>/plan.md.']) assert.ok(shared.includes(s), s);
  for (const s of ['`"ev":"end"`', 'stage: "handover"']) assert.ok(shared.includes(s), s);
  const flow = readFlow('agent');
  assert.ok(flow.includes(PART_LINE), 'PART_LINE');
  for (const s of ['## Parts', '- Part <k> done:', '`Part <k> of <N> of .am/<slug>/plan.md:`', '`Part <k> of <N> of .am/<parent>/plan.md:`']) assert.ok(flow.includes(s), s);
  assert.ok(lean.includes('${CLAUDE_PLUGIN_ROOT}/flow/parts.md'), 'reads flow/parts.md');
  // It copies the Parts rules instead of reading am-auto:one, and runs neither the orchestrator nor stage sessions.
  for (const text of [lean, stageAgents]) for (const s of ['skills/one/SKILL.md', 'skills/run/SKILL.md', 'scripts/stage.mjs', 'progress.mjs', '--solo']) assert.ok(!text.includes(s), s);
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

// The Part done command of am-auto:agent and am-auto:relay (a copy each; the test above runs am-auto:agent's).
const PART_DONE = /`node -e '([^']*)' \.am\/<slug>\/plan\.md '- Part <k> done: <slug>-p<k>'`/;

test('am-auto:relay hands each part to the relay agent and acts on every state it ends with', () => {
  const relay = withoutCommon(read('relay'));
  const shared = withoutCommon(readFlow('relay'));
  const cmd = 'node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-stage.mjs"';
  for (const s of ['${CLAUDE_PLUGIN_ROOT}/flow/run.md', '${CLAUDE_PLUGIN_ROOT}/flow/parts.md', '${CLAUDE_PLUGIN_ROOT}/flow/stage-agents.md', 'step 7', 'the am-auto:relay skill']) assert.ok(relay.includes(s), s);
  assert.ok(shared.includes('\n## Stage agents (Claude Code)\n'), 'reads the stage agents flow');
  for (const s of ['skills/multi/SKILL.md', 'skills/one/SKILL.md', 'skills/agent/SKILL.md', 'stage-sessions.md', 'scripts/stage.mjs', 'progress.mjs', '--solo', '`HANDED`']) assert.ok(!relay.includes(s), s);
  const parts = relay.split('\n## Parts\n')[1];
  assert.ok(parts.includes('`subagent_type` `am-auto:relay-part` and exactly this prompt: `part <slug>-p<k>; push <yes|no>; script ${CLAUDE_PLUGIN_ROOT}/scripts/agent-stage.mjs`'), 'the relay agent call');
  // The prompt and the result line are the relay agent's (auto/agents/relay-part.md).
  const agent = readFileSync(path.join(AGENTS_DIR, 'relay-part.md'), 'utf8');
  for (const s of ['`part <slug>; push <yes|no>; script <path>`', '`AM_RELAY: <state> <status|-> <stage|-> <dispatchId|->`']) assert.ok(agent.includes(s), s);
  assert.ok(parts.includes('`AM_RELAY: <state> <status|-> <stage|-> <dispatchId|->`'), 'the result line');
  for (const s of ['ended', 'COMMITTED', 'NOTHING', 'NEEDS_DECISION', 'unable', 'none', 'running', 'closed', 'gone', 'unclaimed', 'stale', 'error', '--part']) assert.ok(parts.includes(`\`${s}\``), s);
  for (const s of [`${cmd} card <slug>-p<k>`, `${cmd} answer <slug>-p<k> <that file>`]) assert.ok(parts.includes(`\`${s}\``), s);
  for (const s of ['same permission mode', 'could not run stage agents', 'a stage agent may still be running in the receiving session', 'this skill with the parent slug', 'is not that result, so ignore it', '`card` ending with exit code 2 (no open card) goes to loop step 3 again, once; a second time stops', 'the stage from the line, or that it is unknown when `-`']) assert.ok(parts.includes(s), s);
  // Every state the relay agent and wait can end with is one this skill names.
  const script = readFileSync(path.join(AUTO, 'scripts', 'agent-stage.mjs'), 'utf8');
  const waitStates = [...script.matchAll(/(?:waitLine\(\{ state: |closeAs\(d, )'([a-z]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(waitStates)].sort(), ['closed', 'ended', 'gone', 'running', 'stale', 'unclaimed']);
  // The Part done command is the same in both skills.
  const a = PART_DONE.exec(withoutCommon(read('agent')));
  const r = PART_DONE.exec(relay);
  assert.ok(a && r, 'the Part done command');
  assert.equal(r[0], a[0]);
});

test('the flow files keep the anchors the skills refer to, and am-auto:multi adds its hand-over to steps 2, 4 and 7', () => {
  const run = flowFile('run.md');
  assert.ok(run.includes('\n## Running without stops\n'));
  assert.ok(flowFile('stage-sessions.md').includes('\n## Stage sessions (Claude Code)\n'));
  const steps = run.split('\n## Steps\n')[1];
  assert.ok(steps, 'the Steps section');
  const step = Object.fromEntries(('\n' + steps).split(/\n(?=\d+\. )/).filter((s) => /^\d+\. /.test(s)).map((s) => [Number(s.split('.')[0]), s]));
  for (const n of [2, 4, 7]) assert.ok(step[n], `step ${n}`);
  // Step 2 reads the four skills from the core am folder that this command prints.
  assert.ok(step[2].includes('`node "${CLAUDE_PLUGIN_ROOT}/scripts/stage.mjs" core`'), 'step 2: the core command');
  assert.match(readFileSync(path.join(AUTO, 'scripts', 'stage.mjs'), 'utf8'), /\nexport function coreCommand\(/);
  // A hand-over at step 4 comes before the am:do skill.
  assert.ok(step[4].startsWith('4. Do: if the skill that sent you here hands the task over at this step, its rule comes first.'), 'step 4');
  assert.ok(step[7], 'step 7');
  const hand = read('multi').split('\n## Hand-over (am-orchestrator)\n')[1];
  assert.ok(hand, 'the Hand-over section of am-auto:multi');
  const add = Object.fromEntries(('\n' + hand).split(/\n(?=- Step \d+: )/).filter((s) => /^- Step \d+: /.test(s)).map((s) => [Number(s.slice(7).split(':')[0]), s]));
  assert.ok(add[2]?.includes('claude plugin list --json'), 'step 2');
  assert.ok(add[4]?.startsWith('- Step 4: before the am:do skill, hand over (below) if'), 'step 4: first');
  assert.ok(add[4].includes('Hand-over:'), 'step 4');
  assert.ok(add[7]?.includes('After a hand-over'), 'step 7');
  assert.ok(hand.includes('`HANDED`'));
});

test('auto/flow holds only flow files, no skill, and the skills name only flow files that exist', () => {
  assert.ok(path.relative(path.join(AUTO, 'skills'), FLOW).startsWith('..'), 'auto/flow is outside auto/skills');
  // Plain files only: no SKILL.md and no folder that could be read as a skill.
  const names = readdirSync(FLOW);
  assert.deepEqual(names.sort(), ['parts.md', 'relay-part.md', 'run.md', 'stage-agents.md', 'stage-sessions.md']);
  for (const name of names) {
    const text = flowFile(name);
    assert.ok(!text.startsWith('---'), `${name}: no frontmatter`);
    assert.ok(text.split('\n').length <= 80, `${name}: 80 lines`);
    assert.doesNotMatch(text, SLASH_NAME, name);
    assert.match(text.split('\n')[0], /^This file is not a skill: /, name);
  }
  const named = { multi: ['run.md', 'stage-sessions.md'], one: ['run.md', 'parts.md', 'stage-sessions.md'], agent: ['run.md', 'parts.md', 'stage-agents.md'], relay: ['run.md', 'parts.md', 'stage-agents.md'] };
  for (const [skill, want] of Object.entries(named)) {
    assert.deepEqual(flowNames(read(skill)), want, skill);
    readFlow(skill);
  }
});

// A session that got an am-auto:relay message runs the part with the shared stage agents' flow and answers only through
// the dispatch record; the message names this file (relayMessage of agent-stage.mjs).
test('a receiving session claims the dispatch, runs one part with stage agents and records its outcome once', async () => {
  const text = flowFile('relay-part.md');
  const { relayMessage } = await import('../auto/scripts/agent-stage.mjs');
  const message = relayMessage({ cwd: 'C:/repo', ownRoot: AUTO, part: 'big-p1', id: 'abc1-123456', push: false });
  assert.ok(message.includes(`${AUTO.split(path.sep).join('/')}/flow/relay-part.md`), 'the message names this file');
  assert.ok(text.includes(`\`${message.split('\n')[0].split(':')[0]}:\``), 'the message prefix');
  for (const key of ['Part', 'Dispatch', 'Push']) assert.ok(message.includes(`\n${key}: `) && text.includes(`\`${key}\``), key);
  const cmd = 'node "<plugin root>/scripts/agent-stage.mjs"';
  for (const s of [`${cmd} claim <part> <id>`, `${cmd} outcome <part> <id> unable -`, `${cmd} outcome <part> <id> <status> <stage>`, '--part --dispatch <id>', '--push', '--fix']) assert.ok(text.includes(`\`${s}\``), s);
  for (const s of ['`flow/stage-agents.md`', '`## Stage agents (Claude Code)`', '`am-auto:stage-plan`', '`claimed`', '`recorded`', '`reason`', 'in the foreground, never in the background']) assert.ok(text.includes(s), s);
  assert.ok(flowFile('stage-agents.md').includes('\n## Stage agents (Claude Code)\n'));
  for (const s of ['Do not reply to the sender', 'Never ask the user', 'Change no file yourself', 'Never switch to the parent slug', 'Do not read `flow/run.md`']) assert.ok(text.includes(s), s);
  for (const status of ['COMMITTED', 'NOTHING', 'NEEDS_DECISION', 'BLOCKED', 'failed', 'BLOCK', 'error']) assert.ok(text.includes(`\`${status}\``), status);
  // Every command named here is one agent-stage.mjs takes.
  const usage = readFileSync(path.join(AUTO, 'scripts', 'agent-stage.mjs'), 'utf8').split('const USAGE = `')[1].split('`;')[0];
  for (const name of ['claim', 'outcome', 'start']) assert.ok(usage.includes(`node agent-stage.mjs ${name} `), name);
  for (const flag of ['--part', '--dispatch <id>', '--push', '--fix']) assert.ok(usage.includes(flag), flag);
  assert.ok(!text.includes('${CLAUDE_PLUGIN_ROOT}/'), 'no plugin root placeholder path: the session was not started as a skill');
});

test('the Loop step lines of am-auto:one, am-auto:agent and am-auto:relay name steps of the parts.md loop', () => {
  const loop = flowFile('parts.md').split('\n## Parts\n')[1];
  const numbers = [...loop.matchAll(/\n {2}(\d+)\. /g)].map((m) => Number(m[1]));
  assert.deepEqual(numbers, [1, 2, 3, 4]);
  for (const name of ['one', 'agent', 'relay']) {
    const parts = read(name).split('\n## Parts\n')[1];
    assert.ok(parts, `${name}: the Parts section`);
    const steps = [...parts.matchAll(/\n- Loop step (\d+): /g)].map((m) => Number(m[1]));
    for (const n of steps) assert.ok(numbers.includes(n), `${name}: loop step ${n}`);
    assert.ok(steps.includes(3), `${name}: loop step 3`);
  }
});

test('only am-auto:multi hands over: one, agent and relay read no hand-over rule, multi reads every stage status', async () => {
  for (const name of ['one', 'agent', 'relay']) {
    const text = readFlow(name);
    for (const s of ['- Hand-over: am-orchestrator run skill', '`HANDED`', 'claude plugin list --json']) assert.ok(!text.includes(s), `${name}: ${s}`);
  }
  const { MARKS } = await import('../auto/scripts/stage.mjs');
  const multi = readFlow('multi');
  for (const status of [...new Set(Object.values(MARKS).flat()), 'failed', 'unavailable', 'WAIT']) assert.ok(multi.includes(`\`${status}\``), status);
});

test('am-auto:sessions runs the read-only report script once and the model may invoke it', () => {
  const skill = read('sessions');
  assert.ok(skill.includes('`node "${CLAUDE_PLUGIN_ROOT}/scripts/sessions.mjs"`'));
  assert.ok(existsSync(path.join(AUTO, 'scripts', 'sessions.mjs')), 'auto/scripts/sessions.mjs');
  // No Codex manifest: the model may pick this skill on its own in both tools.
  assert.ok(!existsSync(path.join(skillDir('sessions'), 'agents', 'openai.yaml')));
  assert.match(skill, /Change, remove or stop nothing/);
  // The report names the skill of each task, so both ways to resume are named.
  assert.ok(skill.includes('`am-auto:multi <slug>`') && skill.includes('`am-auto:one <slug>`'));
});

test('am-auto:multi starts the progress command next to every stage command', async () => {
  const m = /\n## Stage sessions \(Claude Code\)\n([\s\S]*)$/.exec(flowFile('stage-sessions.md'));
  assert.ok(m, 'the Stage sessions section');
  const section = m[1];
  assert.ok(section.includes('`node "${CLAUDE_PLUGIN_ROOT}/scripts/progress.mjs" <slug> --consumer main`'));
  assert.ok(existsSync(path.join(AUTO, 'scripts', 'progress.mjs')), 'auto/scripts/progress.mjs');
  // The skill stops restarting the progress command when its last line is the one the script prints for an ended task.
  const { stateLine } = await import('../auto/scripts/progress.mjs');
  assert.equal(stateLine([]), 'state: ended');
  assert.ok(section.includes(`\`${stateLine([])}\``), 'state: ended');
  assert.ok(section.includes('each `second opinion:` line gets its own plain line: what had to be decided and which option was chosen, and which reviewers agreed, if both did'));
  assert.ok(section.includes('other than its `second opinion:` lines'));
  // After a WAIT at the follow limit the same stage runs on: one progress command, kept going while a stage command runs.
  assert.ok(section.includes('--consumer main` from the repository root in the background unless one is still running'));
  assert.ok(section.includes('has already ended and no stage command of this task is running now'));
  // The skill relays news by this prefix; a changed prefix would silently drop the plain line.
  assert.ok(readFileSync(path.join(AUTO, 'scripts', 'stage.mjs'), 'utf8').includes('text: `second opinion: ${line}`'));
});

test('am-auto:multi gathers the choices the second opinion settled in its final reply', () => {
  const auto = readFlow('multi');
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

// am-auto:agent stage agents; their values are models.json's through STAGE_AGENTS of scripts/models.mjs (tests/models.test.mjs).
const STAGE_AGENT_NAMES = ['stage-plan', 'stage-do', 'stage-check', 'stage-commit', 'stage-commit-push'];
const AGENTS_DIR = path.join(AUTO, 'agents');

test('am-auto:agent stage agents stay pinned', () => {
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
    assert.ok(fm.description.includes('am-auto:agent 의 '), name);
    assert.ok(!text.includes('am:lean'), name);
    const body = text.replace(/^---\n[\s\S]*?\n---\n/, '');
    assert.doesNotMatch(body, /[가-힣]/, `${name}: English body`);
    for (const s of ['rules file', 'SKILL.md', '`.am/<slug>/reply-<stage>.md`', '`AM_STAGE: <status> <runId>`', '`AM_STAGE: BLOCKED <runId>`', 'MISSING_RUN_ID']) assert.ok(body.includes(s), `${name}: ${s}`);
    const lines = body.split('\n');
    assert.ok(lines.includes(`# am-auto:${name}`), `${name}: title`);
    const stageLine = lines.find((l) => l.startsWith('You run the '));
    assert.ok(stageLine?.includes(name === 'stage-commit-push' ? 'push' : name.slice('stage-'.length)), `${name}: ${stageLine}`);
    assert.ok(stageLine.includes('of an am-auto:agent task'), `${name}: ${stageLine}`);
    rest.push(lines.filter((l) => l !== `# am-auto:${name}` && l !== stageLine).join('\n'));
  }
  // One shared body: what differs per stage lives in the rules file, the SKILL.md, tools and the hooks.
  for (const r of rest.slice(1)) assert.equal(r, rest[0]);
});

test('plugin/agents holds only the reviewer, and auto/agents only the stage agents', () => {
  assert.deepEqual(readdirSync(path.dirname(AGENT)), ['second-opinion.md']);
  assert.deepEqual(readdirSync(AGENTS_DIR).sort(), [...STAGE_AGENT_NAMES, 'relay-part'].map((n) => `${n}.md`).sort());
});

// The am-auto:relay hand-over agent: no tools key, so it keeps the driver's tools (SendMessage is loaded through
// ToolSearch), and disallowedTools takes away writes and subagents; its value is models.json's am-auto.relay-part.
test('the am-auto:relay hand-over agent stays pinned and drives only the dispatch commands', async () => {
  const text = readFileSync(path.join(AGENTS_DIR, 'relay-part.md'), 'utf8');
  const fm = frontmatter(text);
  assert.deepEqual(Object.keys(fm), ['name', 'description', 'disallowedTools', 'model', 'effort']);
  assert.equal(fm.name, 'relay-part');
  assert.equal(fm.disallowedTools, 'Write, Edit, NotebookEdit, Agent');
  assert.match(fm.model, ALIAS);
  assert.ok(USER_EFFORTS.includes(fm.effort), fm.effort);
  assert.match(fm.description, /^"[^"]{40,}"$/);
  for (const s of ['am-auto:relay 의 ', 'am 스킬이 부를 때만']) assert.ok(fm.description.includes(s), s);
  const body = text.replace(/^---\n[\s\S]*?\n---\n/, '');
  assert.doesNotMatch(body, /[가-힣]/, 'English body');
  assert.ok(body.split('\n').includes('# am-auto:relay-part'), 'title');
  assert.ok(!body.includes('${CLAUDE_PLUGIN_ROOT}'), 'the script path comes in the prompt');
  for (const s of ['Bash, Read and SendMessage', 'ToolSearch', 'Never ask the user', '`part <slug>; push <yes|no>; script <path>`']) assert.ok(body.includes(s), s);
  for (const s of ['node "<script>" dispatch <part>', 'node "<script>" wait <part> <id>', 'node "<script>" close <part> <id> <reason>', '--push']) assert.ok(body.includes(`\`${s}\``), s);
  const { relayMessage } = await import('../auto/scripts/agent-stage.mjs');
  assert.equal(typeof relayMessage, 'function');
  for (const k of ['dispatchId', 'message','resume', 'done', 'none', 'error', 'state', 'status', 'reason', 'running', 'ended', 'target.name']) assert.ok(body.includes(`\`${k}\``), k);
  for (const s of ['AM_RELAY: error - - -', 'AM_RELAY: none - - -', 'AM_RELAY: ended <done.status> <done.stage|-> <dispatchId>', 'AM_RELAY: closed - - <id>', 'AM_RELAY: running - - <id>', 'AM_RELAY: <state> <status|-> <stage|-> <id>', 'AM_RELAY: <state> <status|-> <stage|-> <dispatchId|->']) assert.ok(body.includes(`\`${s}\``), s);
  const usage = readFileSync(path.join(AUTO, 'scripts', 'agent-stage.mjs'), 'utf8').split('const USAGE = `')[1].split('`;')[0];
  for (const s of ['dispatch <part> [--push]', 'wait <part> <id>', 'close <part> <id> <reason>']) assert.ok(usage.includes(`node agent-stage.mjs ${s}`), s);
});

// Skill names before 0.1.67, the git-sync name that moved from am-art to am-util in am-art 0.1.4, and the plugin/ paths
// of what moved to auto/ and util/. CHANGELOG.md and tests/ keep them on purpose (history, inputs), and
// plugin/hooks/hooks.json is frozen byte for byte (tests/gate.test.mjs).
const OLD_NAME = /am:(?:auto\b|sessions\b|land\b|stage-|solo\b|lean\b)|am-art:git-sync\b/;
const OLD_PATH = /plugin\/(?:scripts\/(?:stage|agent-stage|progress|sessions|claude-opinion|memory-guard|proc-tree)\.mjs|hooks\/(?:handover|stage-guard|stage-hook)\.mjs|agents\/stage-|skills\/(?:multi|one|agent|sessions|land|auto|solo|lean)\b)|skills\/auto-(?:multi|one|agent)\b/;
const OLD_SCOPE = ['plugin/', 'auto/', 'util/', 'art/', 'shared/', 'scripts/', 'orchestrator/skills/', 'orchestrator/scripts/', 'README.md', 'README-ART.md', 'orchestrator/README.md', 'CLAUDE.md', 'CLAUDE.full.md'];
const OLD_SKIP = ['plugin/hooks/hooks.json'];
// The only places an old name stays: the stored .gate phase (written and read), the README's notice of the rename and the
// git-sync line below.
const OLD_KEPT = {
  'auto/scripts/stage.mjs': ['phase: `am:auto ${stage}`'],
  'auto/scripts/sessions.mjs': ['/^am:auto (\\S+)$/'],
  'README.md': ['옛 이름 `am:auto-multi`·`am:auto-one`·`am:auto-agent`·`am:sessions`·`am:land` 는 없어졌습니다'],
  // The util skill tells users of am-art 0.1.3 or earlier to update.
  'util/skills/git-sync/SKILL.md': ['When the skill list also shows am-art:git-sync (am-art 0.1.3 or earlier)'],
};

test('no old skill name or moved plugin/ path is left outside the history and the test inputs', () => {
  const r = spawnSync('git', ['ls-files', '-z', '--', ...OLD_SCOPE], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const files = r.stdout.split('\0').filter((f) => f && !OLD_SKIP.includes(f) && existsSync(path.join(REPO_ROOT, f)));
  assert.ok(files.includes('CLAUDE.md') && files.includes('auto/scripts/stage.mjs'), 'the scope is read');
  const found = [];
  for (const file of files) {
    let text = readFileSync(path.join(REPO_ROOT, file), 'utf8');
    for (const kept of OLD_KEPT[file] ?? []) {
      // A kept string that is gone would hide nothing; drop it from the list instead.
      assert.ok(text.includes(kept), `${file}: kept string not found: ${kept}`);
      text = text.split(kept).join('');
    }
    text.split('\n').forEach((line, i) => {
      const m = OLD_NAME.exec(line) ?? OLD_PATH.exec(line);
      if (m) found.push(`${file}:${i + 1}: ${m[0]}`);
    });
  }
  for (const file of Object.keys(OLD_KEPT)) assert.ok(files.includes(file), `kept list names a file out of scope: ${file}`);
  assert.deepEqual(found, []);
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
  const auto = readFlow('multi');
  assert.match(auto, /\n- The two reviewers of a technical choice still split on it after their rounds \(rules above\)\.\n/);
  assert.match(auto, /In every case above but the last, ask with a decision card/);
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
  // The rule for Claude 2 is in the instructions, so the subagent and claude-opinion.mjs get the same one,
  // and it holds only when the prompt names the reader, not when a brief shows a pick labelled Claude 2.
  assert.match(agent, /Only when the prompt tells you that you are Claude 2 \(not when a brief merely shows a pick labelled Claude 2\)/);
  assert.match(agent, /first write the strongest argument against the option you lean toward and the best case for another option, then decide/);
  assert.match(agent, /in the Why line of that choice, in the first round and in every later round/);
  assert.match(agent, /This rule does not apply when you run as Claude 1 or through Codex\./);
});

test('with a person present, the common rules use the newest idle peer sessions as the Claude reviewers', () => {
  const block = common(read('plan'));
  // Unattended runs keep the subagent: a claude -p session ends before a reply, and a subagent's replies go to its parent.
  assert.match(block, /only when a person is in this session to answer \(not in a subagent, not while running without stops, not when your instructions say no human is present\), each Claude reviewer is another open session/);
  // ListAgents shows no folder, and a name only starts with the folder's name (a worktree's name matches too); its
  // `waiting` also covers a session held at a permission prompt. `claude agents --json` gives cwd and idle status.
  assert.ok(block.includes('Run `claude agents --json` (2-minute timeout; if it fails, use the subagent)'));
  assert.match(block, /rows with `kind` `interactive`, `status` `idle` \(not `waiting`, which can be a pending prompt\) and `cwd` equal to the repository root \(ignoring case on Windows\), newest `startedAt` first/);
  assert.match(block, /asking the user to open that many new Claude Code sessions in this repository and leave them idle, and wait for the answer; after a yes, list again and go on, after a no, use the subagent/);
  // auto/ and util/ ship the instructions as scripts/second-opinion.md; the orchestrator ships neither.
  assert.ok(block.includes('`${CLAUDE_PLUGIN_ROOT}/agents/second-opinion.md` (else `${CLAUDE_PLUGIN_ROOT}/scripts/second-opinion.md`; with neither, use the subagent)'));
  assert.match(block, /with `notify_when_idle`/);
  assert.match(block, /Later rounds go to the same sessions/);
  // The peer rule comes after the subagent rule it replaces, so the order pinned above still holds.
  assert.ok(block.indexOf('Then send the brief to the am:second-opinion subagent') < block.indexOf('Peer sessions instead of the subagent'));
  const agent = readFileSync(AGENT, 'utf8');
  assert.match(agent, /set aside what your own conversation said about this work and judge only from the brief and the code/);
  assert.match(agent, /reply only `wrong folder: <your folder>`/);
  assert.match(agent, /Send your reply with SendMessage to the session that sent the request/);
});

test('with a person present, the common rules ask an open Codex session with --peer, as the script reads it', async () => {
  const { EXIT_NO_SESSION } = await import('../plugin/scripts/codex-opinion.mjs');
  const block = common(read('plan'));
  // The script only reads the files and the Codex daemon, so the tool condition of the Claude sessions does not apply.
  assert.match(block, /Codex session instead of a new `codex exec`: under the same person condition \(the tools are not needed\), run the script with `--peer` after the brief file/);
  // The card says what the user gives up: the turn stays in that session's history and runs with its settings.
  assert.equal(EXIT_NO_SESSION, 3);
  assert.match(block, /Exit code 3 means there is none: give a decision card asking the user to open a Codex session in this repository and leave it idle, saying that the request and the answer stay in that session's history and run with its permissions/);
  // A first-time user gets one card, not one per reviewer kind.
  assert.match(block, /one card together with the Claude sessions when those are also too few/);
  // A no lasts for the task, so the summary of every round does not ask again.
  assert.match(block, /after a yes, run it again with `--peer`, after a no or a second exit code 3, leave `--peer` out until this task ends/);
  // A later round stays with the session that answered; without that line it never meets a new session mid-debate.
  assert.match(block, /Later rounds pass `--peer=<id>` with the id from the previous run's `Codex session: <id>` line, or no `--peer` when that line was missing/);
  // The full command is written once, so the order tests above still find the first run.
  assert.equal(block.split('codex-opinion.mjs" <brief file>`').length, 2);
  assert.ok(block.indexOf('Peer sessions instead of the subagent') < block.indexOf('Codex session instead of a new `codex exec`'));
  // The script side of the same words: change the rule, the script and this test together.
  const script = readFileSync(path.resolve(ROOT, '..', 'scripts', 'codex-opinion.mjs'), 'utf8');
  assert.ok(script.includes('`Codex session: ${'));
  assert.ok(script.includes("const USAGE = 'usage: node codex-opinion.mjs <brief .md file under .am/> [--peer | --peer=<Codex session id>]';"));
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
