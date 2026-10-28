#!/usr/bin/env node
// Run from anywhere: node scripts/skills.mjs [--check]
// The files under shared/ at the repository root are the one source of the text several SKILL.md files share: the
// common rules block of every am skill and the owner rules of the am-art skills (the am-auto skills' shared flow is read at run time from auto/flow/ instead).
// No plugin reads shared/ at runtime (it is not shipped): this script writes each source between its markers in every SKILL.md that carries it.
// Without arguments it rewrites those files; with --check it only lists what differs and exits 1.
// Every target must hold its marker pair exactly once, and a marker in a file that is not a target of its block stops
// the script, so a copied block that nobody listed is caught instead of drifting. With any problem nothing is written.
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skill = (dir) => (name) => `${dir}/skills/${name}/SKILL.md`;
const am = skill('plugin');
const auto = skill('auto');
const art = (name) => `art/claude-skills/${name}/SKILL.md`;
// Block name -> its source, its marker lines (each on a line of its own) and the SKILL.md files that carry it.
export const BLOCKS = {
  common: {
    source: 'shared/common.md',
    start: '<!-- am:common:start -->',
    end: '<!-- am:common:end -->',
    targets: [...['plan', 'do', 'check', 'commit'].map(am), ...['multi', 'one', 'agent', 'sessions'].map(auto), ...['land', 'update-branch'].map(skill('util')), 'orchestrator/skills/run/SKILL.md'],
  },
  // am-art's skills carry their own owner rules instead of the common block (its chat rules conflict with theirs).
  art: {
    source: 'shared/art.md',
    start: '<!-- am:shared:art:start -->',
    end: '<!-- am:shared:art:end -->',
    targets: ['ad-review', 'pipe-apply', 'log-compare', 'log-resume', 'git-sync'].map(art),
  },
};
// Every SKILL.md under these folders is scanned for markers, targets or not (a missing folder is skipped).
const SKILL_DIRS = ['plugin/skills', 'util/skills', 'auto/skills', 'orchestrator/skills', 'art/claude-skills', 'art/codex-skills'];
const MARKER = /<!-- am:(?:common|shared:([^\s>]*?)):(?:start|end) -->/g;

const readText = (file) => readFileSync(file, 'utf8').replace(/^﻿/, '');

/** The SKILL.md files of the skill folders, as repository paths with forward slashes. */
function skillFiles(repo) {
  const files = [];
  for (const dir of SKILL_DIRS) {
    const abs = path.join(repo, dir);
    if (!existsSync(abs)) continue;
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(path.join(abs, entry.name, 'SKILL.md'))) files.push(`${dir}/${entry.name}/SKILL.md`);
    }
  }
  return files.sort();
}

/** Every file the script reads: the sources and the scanned SKILL.md files (a test copies these). */
export function inputs(repo = REPO) {
  return [...new Set([...Object.values(BLOCKS).map((b) => b.source), ...skillFiles(repo), ...Object.values(BLOCKS).flatMap((b) => b.targets)])];
}

/** Where the text between a block's markers starts and ends, or why it cannot be found exactly once. */
function locate(text, { start, end }) {
  const count = (s) => text.split(s).length - 1;
  const starts = count(start);
  const ends = count(end);
  if (starts !== 1 || ends !== 1) return { error: `시작 표시 ${starts}번, 끝 표시 ${ends}번` };
  const s = text.indexOf(start);
  const e = text.indexOf(end);
  const after = s + start.length;
  const nl = text.startsWith('\r\n', after) ? 2 : text.startsWith('\n', after) ? 1 : 0;
  const ownLine = (i, len) => (i === 0 || text[i - 1] === '\n') && (i + len === text.length || /^\r?\n/.test(text.slice(i + len)));
  if (!nl || e < after + nl || !ownLine(s, start.length) || !ownLine(e, end.length)) return { error: '표시가 각자 한 줄이 아니거나 끝 표시가 시작 표시보다 앞에 있습니다' };
  return { from: after + nl, to: e };
}

/** Works out every target's new text without writing. `problems` lists what stops the script. */
function render(repo) {
  const problems = [];
  const drift = [];
  const files = new Map();
  const load = (file) => {
    if (!files.has(file)) files.set(file, existsSync(path.join(repo, file)) ? { before: readText(path.join(repo, file)) } : null);
    return files.get(file);
  };
  for (const file of skillFiles(repo)) {
    const f = load(file);
    const names = new Set([...f.before.matchAll(MARKER)].map((m) => (m[1] === undefined ? 'common' : m[1])));
    for (const name of names) {
      if (!BLOCKS[name]) problems.push(`${file}: 모르는 블록 이름 ${JSON.stringify(name)} 의 표시가 있습니다. scripts/skills.mjs 의 BLOCKS 에 넣거나 표시를 지우세요`);
      else if (!BLOCKS[name].targets.includes(file)) problems.push(`${file}: ${name} 블록의 표시가 있지만 그 대상 목록에 없습니다. scripts/skills.mjs 의 BLOCKS 에 넣거나 표시를 지우세요`);
    }
  }
  for (const [name, block] of Object.entries(BLOCKS)) {
    const sourceFile = path.join(repo, block.source);
    if (!existsSync(sourceFile)) {
      problems.push(`${block.source}: ${name} 블록의 원본이 없습니다`);
      continue;
    }
    // A source saved without its last newline would put the end marker on the block's last line.
    const raw = readText(sourceFile).replace(/\r\n/g, '\n');
    const source = raw && !raw.endsWith('\n') ? `${raw}\n` : raw;
    for (const file of block.targets) {
      const f = load(file);
      if (!f) {
        problems.push(`${file}: ${name} 블록의 대상 파일이 없습니다`);
        continue;
      }
      const text = f.after ?? f.before;
      const at = locate(text, block);
      if (at.error) {
        problems.push(`${file}: ${name} 블록의 표시 쌍을 정확히 한 번 찾지 못했습니다 (${at.error})`);
        continue;
      }
      const inner = text.slice(at.from, at.to);
      // Another block's marker inside this one would be overwritten with it.
      if ([...inner.matchAll(MARKER)].length) {
        problems.push(`${file}: ${name} 블록 안에 다른 블록의 표시가 있습니다`);
        continue;
      }
      const want = text.includes('\r\n') ? source.replace(/\n/g, '\r\n') : source;
      if (inner === want) continue;
      drift.push(`${file}: ${name} 블록이 ${block.source} 와 다릅니다`);
      f.after = text.slice(0, at.from) + want + text.slice(at.to);
    }
  }
  return { problems, drift, files };
}

/** Lines that say what stops the script or differs from shared/ (empty when every block matches). */
export function check(repo = REPO) {
  const { problems, drift } = render(repo);
  return [...problems, ...drift];
}

/** Writes every source into its targets. With any problem nothing is written. */
export function apply(repo = REPO) {
  const { problems, files } = render(repo);
  if (problems.length) return { problems, changed: [] };
  const changed = [];
  for (const [file, f] of files) {
    if (!f || f.after === undefined || f.after === f.before) continue;
    writeFileSync(path.join(repo, file), f.after);
    changed.push(file);
  }
  return { problems, changed };
}

function main(args) {
  if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
    console.error('usage: node scripts/skills.mjs [--check]');
    return 2;
  }
  if (args[0] === '--check') {
    const lines = check();
    for (const line of lines) console.log(line);
    if (!lines.length) console.log('모든 SKILL.md 가 shared/ 와 같습니다.');
    return lines.length ? 1 : 0;
  }
  const { problems, changed } = apply();
  if (problems.length) {
    for (const line of problems) console.log(line);
    console.log('아무 파일도 고치지 않았습니다.');
    return 1;
  }
  console.log(changed.length ? `고친 파일:\n${changed.map((f) => `  ${f}`).join('\n')}` : '바꿀 것이 없습니다.');
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
