#!/usr/bin/env node
// Run from anywhere: node scripts/sync-shared.mjs [--check]
// Each plugin is installed into its own cache folder, so a file several plugins use is shipped as a copy in each.
// The sources live in plugin/ (am); the copies in util/ and auto/ are generated: never edit them by hand, edit the
// plugin/ source and run this script (node scripts/models.mjs runs it too). With --check it only lists what differs and
// exits 1. Every replacement must match its source exactly once, and with any problem nothing is written.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Source -> its copies, and the exact replacements made in every copy of it.
export const COPIES = [
  { source: 'plugin/hooks/gate.mjs', copies: ['util/hooks/gate.mjs', 'auto/hooks/gate.mjs'] },
  { source: 'plugin/scripts/user-models.mjs', copies: ['util/scripts/user-models.mjs', 'auto/scripts/user-models.mjs'] },
  { source: 'plugin/scripts/user-settings.mjs', copies: ['auto/scripts/user-settings.mjs'] },
  {
    source: 'plugin/scripts/codex-opinion.mjs',
    copies: ['util/scripts/codex-opinion.mjs', 'auto/scripts/codex-opinion.mjs'],
    // The copy reads the reviewer instructions from the copy beside it, not from an agents/ folder.
    replace: [["'..', 'agents', 'second-opinion.md')", "'second-opinion.md')"]],
  },
  { source: 'plugin/agents/second-opinion.md', copies: ['util/scripts/second-opinion.md', 'auto/scripts/second-opinion.md'] },
];

const readText = (file) => readFileSync(file, 'utf8');

/** Every file the script reads (a test copies these). */
export function inputs() {
  return COPIES.map((c) => c.source);
}

/** Works out every copy's text without writing. `problems` lists what stops the script. */
function render(repo) {
  const problems = [];
  const drift = [];
  const files = new Map();
  for (const { source, copies, replace = [] } of COPIES) {
    const sourceFile = path.join(repo, source);
    if (!existsSync(sourceFile)) {
      problems.push(`${source}: 원본이 없습니다`);
      continue;
    }
    let text = readText(sourceFile);
    let ok = true;
    for (const [from, to] of replace) {
      const found = text.split(from).length - 1;
      if (found !== 1) {
        problems.push(`${source}: 바꿀 곳 ${JSON.stringify(from)} 을(를) 정확히 한 번 찾지 못했습니다 (${found}번). scripts/sync-shared.mjs 의 바꿀 곳을 고치세요`);
        ok = false;
        continue;
      }
      text = text.replace(from, () => to);
    }
    if (!ok) continue;
    for (const copy of copies) {
      const target = path.join(repo, copy);
      const before = existsSync(target) ? readText(target) : null;
      if (before === text) continue;
      drift.push(before === null ? `${copy}: 사본이 없습니다 (원본 ${source})` : `${copy}: ${source} 와 다릅니다`);
      files.set(copy, text);
    }
  }
  return { problems, drift, files };
}

/** Lines that say what stops the script or which copy differs from its source (empty when every copy matches). */
export function check(repo = REPO) {
  const { problems, drift } = render(repo);
  return [...problems, ...drift];
}

/** Writes every copy that differs. With any problem nothing is written. */
export function apply(repo = REPO) {
  const { problems, files } = render(repo);
  if (problems.length) return { problems, changed: [] };
  const changed = [];
  for (const [file, text] of files) {
    mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    writeFileSync(path.join(repo, file), text);
    changed.push(file);
  }
  return { problems, changed };
}

function main(args) {
  if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
    console.error('usage: node scripts/sync-shared.mjs [--check]');
    return 2;
  }
  if (args[0] === '--check') {
    const lines = check();
    for (const line of lines) console.log(line);
    if (!lines.length) console.log('모든 사본이 plugin/ 원본과 같습니다.');
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
