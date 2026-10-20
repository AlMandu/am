#!/usr/bin/env node
// Run from anywhere: node scripts/models.mjs [--check]
// models.json at the repository root is the one source of the model and effort of every skill and every session the
// plugins of this marketplace create. No plugin reads it at runtime: this script bakes the values into the files that carry them.
// Without arguments it rewrites those files, then the shared copies (scripts/sync-shared.mjs); with --check it only lists
// what differs in its own targets and exits 1. Every target must match exactly once, so a file whose format changed stops the script instead of being skipped.
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply as applyShared } from './sync-shared.mjs';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EFFORT = ['low', 'medium', 'high', 'xhigh', 'max'];
const CODEX_EFFORT = ['minimal', 'low', 'medium', 'high', 'xhigh'];
// Skills and the subagent take an alias: a skill whose model cannot be resolved has no fallback, and the subagent's
// `opus` follows the main session's Opus version, so a new Opus is picked up without an edit. The Codex model goes
// through `cmd /C` on Windows, so only a token that needs no quotes is allowed; empty means the user's own codex config.
const MODEL = {
  alias: [/^[a-z]+(\[1m\])?$/, '별칭(예: opus)'],
  codex: [/^([A-Za-z0-9._:-]+)?$/, '빈 문자열(사용자의 codex 설정) 또는 따옴표 없이 쓰는 모델 이름'],
};
const ENTRIES = {
  am: { plan: 'alias', do: 'alias', check: 'alias', commit: 'alias', 'second-opinion': 'alias', 'codex-opinion': 'codex' },
  'am-auto': { multi: 'alias', one: 'alias', agent: 'alias', sessions: 'alias', compact: 'alias' },
  'am-util': { land: 'alias' },
  orchestrator: { run: 'alias', split: 'alias' },
};
// Skills per models.json group and the plugin folder that holds them (<folder>/skills/<name>/SKILL.md).
export const SKILLS = { am: ['plan', 'do', 'check', 'commit'], 'am-auto': ['multi', 'one', 'agent', 'sessions'], 'am-util': ['land'] };
export const PLUGIN_DIRS = { am: 'plugin', 'am-auto': 'auto', 'am-util': 'util' };
// Orchestrator stages that run an am skill take that skill's values (tests/orchestrator-skill.test.mjs keeps a copy).
export const STAGE_SKILLS = { plan: 'plan', implement: 'do', check: 'check', commit: 'commit' };
// am-auto:agent stage agents (auto/agents/<agent>.md) take the values of the am skill they run.
export const STAGE_AGENTS = { 'stage-plan': 'plan', 'stage-do': 'do', 'stage-check': 'check', 'stage-commit': 'commit', 'stage-commit-push': 'commit' };
// BUILTIN_MODELS of plugin/scripts/user-files.mjs: the user models file's keys (without default) in its order, with their group.
const USER_FILE_KEYS = [['plan', 'am'], ['do', 'am'], ['check', 'am'], ['commit', 'am'], ['compact', 'am-auto'], ['run', 'orchestrator'], ['split', 'orchestrator'], ['second-opinion', 'am'], ['codex-opinion', 'am']];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const keys = (o) => Object.keys(o).filter((k) => !k.startsWith('_')); // `_` keys are notes
const readText = (file) => readFileSync(file, 'utf8').replace(/^﻿/, '');

export const load = (repo = REPO) => JSON.parse(readText(path.join(repo, 'models.json')));

/** What is wrong with the values, one line each (empty when they are usable). */
export function validate(models) {
  const problems = [];
  const sameKeys = (where, actual, expected) => {
    const extra = actual.filter((k) => !expected.includes(k));
    const missing = expected.filter((k) => !actual.includes(k));
    if (extra.length || missing.length) problems.push(`${where}: ${[missing.length && `빠진 키 ${missing.join(', ')}`, extra.length && `모르는 키 ${extra.join(', ')}`].filter(Boolean).join(', ')}`);
  };
  if (!isObj(models)) return ['models.json: 객체여야 합니다'];
  sameKeys('models.json', keys(models), Object.keys(ENTRIES));
  for (const [group, entries] of Object.entries(ENTRIES)) {
    if (!isObj(models[group])) {
      if (models[group] !== undefined) problems.push(`${group}: 항목을 담은 객체여야 합니다`); // a missing group is reported above
      continue;
    }
    sameKeys(group, keys(models[group]), Object.keys(entries));
    for (const [name, kind] of Object.entries(entries)) {
      const entry = models[group][name];
      const where = `${group}.${name}`;
      if (!isObj(entry)) {
        if (entry !== undefined) problems.push(`${where}: { "model": ..., "effort": ... } 객체여야 합니다`);
        continue;
      }
      sameKeys(where, keys(entry), ['model', 'effort']);
      const [rule, hint] = MODEL[kind];
      if (typeof entry.model !== 'string' || !rule.test(entry.model)) problems.push(`${where}.model: ${hint}이어야 합니다 (지금 ${JSON.stringify(entry.model)})`);
      const efforts = kind === 'codex' ? CODEX_EFFORT : EFFORT;
      if (!efforts.includes(entry.effort)) problems.push(`${where}.effort: ${efforts.join(', ')} 중 하나여야 합니다 (지금 ${JSON.stringify(entry.effort)})`);
    }
  }
  return problems;
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const code = (s) => `\`${s}\``;

function frontmatter(file, pick) {
  return { file, what: 'frontmatter 의 model·effort', pattern: /\nmodel: [^\n]*\neffort: [^\n]*\n---\n/g, text: (m) => `\nmodel: ${pick(m).model}\neffort: ${pick(m).effort}\n---\n` };
}

const stageValues = (m, stage) => (stage === 'split' ? m.orchestrator.split : m.am[STAGE_SKILLS[stage]]);

function table(header, rows) {
  return [`| ${header} | 모델 | effort |`, '|---|---|---|', ...rows.map(([label, v, model]) => `| ${label} | ${model ?? code(v.model)} | ${code(v.effort)} |`)].join('\n');
}

function generated(file, render) {
  // Blank lines around the table keep it a table after the HTML comment that opens the block.
  return { file, what: '표(<!-- am:models:start --> … <!-- am:models:end -->)', pattern: /<!-- am:models:start -->\n[\s\S]*?<!-- am:models:end -->/g, text: (m) => `<!-- am:models:start -->\n\n${render(m)}\n\n<!-- am:models:end -->` };
}

/** Every place that carries a value, in the order it is written. */
export function targets() {
  return [
    ...Object.entries(SKILLS).flatMap(([group, names]) => names.map((name) => frontmatter(`${PLUGIN_DIRS[group]}/skills/${name}/SKILL.md`, (m) => m[group][name]))),
    frontmatter('plugin/agents/second-opinion.md', (m) => m.am['second-opinion']),
    ...Object.entries(STAGE_AGENTS).map(([agent, skill]) => frontmatter(`auto/agents/${agent}.md`, (m) => m.am[skill])),
    frontmatter('orchestrator/skills/run/SKILL.md', (m) => m.orchestrator.run),
    ...['split', ...Object.keys(STAGE_SKILLS)].map((stage) => ({
      file: 'orchestrator/scripts/orchestrator.mjs',
      what: `STAGE_DEFAULTS.${stage}`,
      pattern: new RegExp(`\\n  ${esc(stage)}: \\{ model: '[^'\\n]*', effort: '[^'\\n]*' \\},`, 'g'),
      text: (m) => `\n  ${stage}: { model: '${stageValues(m, stage).model}', effort: '${stageValues(m, stage).effort}' },`,
    })),
    {
      file: 'plugin/scripts/codex-opinion.mjs',
      what: "CODEX_ARGS 의 '-c', 'model=...' 과 'model_reasoning_effort=...'",
      pattern: /\n {2}(?:'-c', 'model=[^'\n]*',\n {2})?'-c', 'model_reasoning_effort=[^'\n]*',/g,
      text: (m) => {
        const { model, effort } = m.am['codex-opinion'];
        return `\n  ${model ? `'-c', 'model=${model}',\n  ` : ''}'-c', 'model_reasoning_effort=${effort}',`;
      },
    },
    {
      file: 'auto/scripts/stage.mjs',
      what: 'COMPACT_MODEL',
      pattern: /\nexport const COMPACT_MODEL = \{ model: '[^'\n]*', effort: '[^'\n]*' \};/g,
      text: (m) => `\nexport const COMPACT_MODEL = { model: '${m['am-auto'].compact.model}', effort: '${m['am-auto'].compact.effort}' };`,
    },
    {
      file: 'plugin/scripts/user-files.mjs',
      what: 'BUILTIN_MODELS',
      pattern: /\nexport const BUILTIN_MODELS = \{\n[\s\S]*?\n\};/g,
      text: (m) => {
        const lines = USER_FILE_KEYS.map(([key, group]) => `  ${key.includes('-') ? `'${key}'` : key}: { model: '${m[group][key].model}', effort: '${m[group][key].effort}' },`);
        return `\nexport const BUILTIN_MODELS = {\n${lines.join('\n')}\n};`;
      },
    },
    generated('README.md', (m) =>
      table('대상', [
        ...Object.entries(SKILLS).flatMap(([group, names]) => names.map((n) => [code(`${group}:${n}`), m[group][n]])),
        ['단계 사이 맥락 압축 세션(`am-auto:multi`·`am-auto:one`, Claude Code)', m['am-auto'].compact],
        ['2차 의견 서브에이전트(`am:second-opinion`)', m.am['second-opinion']],
        ['`am-auto:agent` 계획 단계 에이전트(`am-auto:stage-plan`)', m.am.plan],
        ['`am-auto:agent` 구현 단계 에이전트(`am-auto:stage-do`)', m.am.do],
        ['`am-auto:agent` 점검 단계 에이전트(`am-auto:stage-check`)', m.am.check],
        ['`am-auto:agent` 커밋 단계 에이전트(`am-auto:stage-commit`·`am-auto:stage-commit-push`)', m.am.commit],
        ['Codex 2차 의견', m.am['codex-opinion'], m.am['codex-opinion'].model ? undefined : '사용자의 codex 설정'],
      ]),
    ),
    generated('orchestrator/README.md', (m) =>
      table('세션', [
        ['분할(`split`)', stageValues(m, 'split')],
        ['계획(`plan`), 결정 답변(`answer`), `doctor` 의 시험 호출', stageValues(m, 'plan')],
        ['구현(`implement`), 수정(`fix`)', stageValues(m, 'implement')],
        ['점검(`check`)', stageValues(m, 'check')],
        ['커밋(`commit`)', stageValues(m, 'commit')],
        ['이 스킬을 실행한 세션(`am-orchestrator:run`, 그 차례에만)', m.orchestrator.run],
      ]),
    ),
  ];
}

/** Works out every file's new text without writing. `problems` lists bad values and targets not found exactly once. */
function render(repo, models) {
  const problems = validate(models);
  if (problems.length) return { problems, drift: [], files: new Map() };
  const files = new Map();
  const drift = [];
  for (const t of targets()) {
    if (!files.has(t.file)) files.set(t.file, { before: readText(path.join(repo, t.file)) });
    const f = files.get(t.file);
    const text = f.after ?? f.before;
    const found = text.match(t.pattern) || [];
    if (found.length !== 1) {
      problems.push(`${t.file}: ${t.what} 을(를) 정확히 한 번 찾지 못했습니다 (${found.length}번). 형식이 바뀌었으면 scripts/models.mjs 의 대상을 고치세요`);
      continue;
    }
    const want = t.text(models);
    if (found[0] !== want) drift.push(`${t.file}: ${t.what} 이(가) models.json 과 다릅니다`);
    f.after = text.replace(t.pattern, () => want);
  }
  return { problems, drift, files };
}

/** Lines that say what does not match models.json (empty when everything matches). */
export function check(repo = REPO, models = load(repo)) {
  const { problems, drift } = render(repo, models);
  return [...problems, ...drift];
}

/** Writes the values into every target. With any problem nothing is written. */
export function apply(repo = REPO, models = load(repo)) {
  const { problems, files } = render(repo, models);
  if (problems.length) return { problems, changed: [] };
  const changed = [];
  for (const [file, { before, after }] of files) {
    if (after === before) continue;
    writeFileSync(path.join(repo, file), after);
    changed.push(file);
  }
  return { problems, changed };
}

function main(args) {
  if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
    console.error('usage: node scripts/models.mjs [--check]');
    return 2;
  }
  let models;
  try {
    models = load();
  } catch (e) {
    console.error(`models.json 을 읽지 못했습니다: ${e.message}`);
    return 1;
  }
  if (args[0] === '--check') {
    const lines = check(REPO, models);
    for (const line of lines) console.log(line);
    if (!lines.length) console.log('모든 파일이 models.json 과 같습니다.');
    return lines.length ? 1 : 0;
  }
  const { problems, changed } = apply(REPO, models);
  if (problems.length) {
    for (const line of problems) console.log(line);
    console.log('아무 파일도 고치지 않았습니다.');
    return 1;
  }
  console.log(changed.length ? `고친 파일:\n${changed.map((f) => `  ${f}`).join('\n')}` : '바꿀 것이 없습니다.');
  // The copies in other plugin folders carry some of these values (codex-opinion.mjs), so refresh them from plugin/.
  const sync = applyShared(REPO);
  if (sync.problems.length) {
    for (const line of sync.problems) console.log(line);
    console.log('공유 파일 사본을 고치지 못했습니다. models.json 값은 이미 썼을 수 있습니다.');
    return 1;
  }
  if (sync.changed.length) console.log(`고친 사본:\n${sync.changed.map((f) => `  ${f}`).join('\n')}`);
  return 0;
}

// Node runs the real path of the entry file while argv[1] keeps the path as typed (a junction or symlink), so compare real paths.
const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return '';
  }
};
const self = real(fileURLToPath(import.meta.url));
const invoked = process.argv[1] ? real(path.resolve(process.argv[1])) : '';
if (invoked && (process.platform === 'win32' ? invoked.toLowerCase() === self.toLowerCase() : invoked === self)) process.exitCode = main(process.argv.slice(2));
