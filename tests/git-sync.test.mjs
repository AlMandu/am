// Run: node --test tests/git-sync.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { autoAdd, gitSyncSettingsFile, main, matchPattern, readGitSyncSettings } from '../util/scripts/git-sync-settings.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO, 'util', 'scripts', 'git-sync-settings.mjs');

// A temporary config folder (CLAUDE_CONFIG_DIR) plus an existing folder whose name has Korean and a space.
function config() {
  const base = mkdtempSync(path.join(os.tmpdir(), 'am-git-sync-'));
  const dir = path.join(base, 'config');
  mkdirSync(dir);
  const place = path.join(base, '아트 작업', '무기 폴더');
  mkdirSync(place, { recursive: true });
  const env = { CLAUDE_CONFIG_DIR: dir };
  const file = gitSyncSettingsFile(env);
  return { base, dir, place, env, file, art: path.join(dir, 'am', 'art.json'), done: () => rmSync(base, { recursive: true, force: true }) };
}

// A fake repository (a folder with `.git`) under a Korean folder with a space.
function repoFixture(c) {
  const repo = path.join(c.base, '게임 저장소');
  mkdirSync(path.join(repo, '.git'), { recursive: true });
  return repo;
}

function run(c, args, extra = {}) {
  const out = [];
  const err = [];
  const code = main(args, { env: c.env, out: (s) => out.push(s), err: (s) => err.push(s), ...extra });
  return { code, out: out.join(''), err: err.join('') };
}
const auto = (c, ...args) => run(c, ['auto', ...args]);
const matchRun = (c, repo, text) => run(c, ['auto', 'match', repo], { input: () => text });
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

// Writes am-art's art.json with other keys around autoChanged; returns its text.
function writeArt(c, autoChanged, extra = { spineRoot: c.place, _note: '메모' }) {
  mkdirSync(path.dirname(c.art), { recursive: true });
  const text = JSON.stringify({ ...extra, autoChanged }, null, 2);
  writeFileSync(c.art, text);
  return text;
}

test('git-sync settings: the file sits under am/, a missing file reads as empty, and bad commands print the usage with exit 2', () => {
  const c = config();
  try {
    assert.equal(c.file, path.join(c.dir, 'am', 'git-sync.json'));
    assert.deepEqual(readGitSyncSettings(c.file), { data: {} });
    for (const args of [[], ['auto'], ['auto', 'nope', c.place], ['auto', 'add', c.place], ['list', c.place], ['auto', 'list', c.place, 'x']]) {
      const r = run(c, args);
      assert.equal(r.code, 2, JSON.stringify(args));
      assert.match(r.err, /^usage: node git-sync-settings\.mjs auto list/);
    }
    const r = spawnSync(process.execPath, [CLI], { env: { ...process.env, CLAUDE_CONFIG_DIR: c.dir } });
    assert.equal(r.status, 2);
    assert.match(r.stderr.toString(), /^usage: /);
  } finally {
    c.done();
  }
});

test('git-sync settings: add and list go round, a second add leaves the file as it is, the last remove leaves an empty list', () => {
  const c = config();
  try {
    const repo = repoFixture(c);
    const key = path.resolve(repo);
    assert.deepEqual(auto(c, 'list', repo), { code: 0, out: '', err: '' });
    assert.deepEqual(auto(c, 'add', repo, 'Packages/'), { code: 0, out: 'Packages/ added\n', err: '' });
    assert.equal(auto(c, 'add', repo, '**/*.spriteatlas').code, 0);
    const before = readFileSync(c.file, 'utf8');
    assert.deepEqual(auto(c, 'add', repo, 'Packages/'), { code: 0, out: 'Packages/ already listed\n', err: '' });
    assert.equal(readFileSync(c.file, 'utf8'), before);
    assert.equal(auto(c, 'list', repo).out, 'Packages/\n**/*.spriteatlas\n');
    assert.deepEqual(JSON.parse(before), { autoChanged: { [key]: ['Packages/', '**/*.spriteatlas'] }, importedFromArt: { [key]: [] } });
    const missing = auto(c, 'remove', repo, 'Library/');
    assert.equal(missing.code, 3);
    assert.match(missing.err, /Library\/ is not listed/);
    assert.equal(readFileSync(c.file, 'utf8'), before);
    assert.equal(auto(c, 'remove', repo, 'Packages/').out, 'Packages/ removed\n');
    assert.equal(auto(c, 'remove', repo, '**/*.spriteatlas').code, 0);
    assert.deepEqual(readJson(c.file), { autoChanged: { [key]: [] }, importedFromArt: { [key]: ['Packages/', '**/*.spriteatlas'] } });
    assert.deepEqual(auto(c, 'list', repo), { code: 0, out: '', err: '' });
    // list, match and remove check only the form of the repository path, so a moved repository can still be cleaned up.
    assert.deepEqual(auto(c, 'list', path.join(c.base, 'gone')), { code: 0, out: '', err: '' });
    assert.equal(auto(c, 'list', 'relative/repo').code, 1);
    assert.equal(auto(c, 'remove', path.join(c.base, 'gone'), 'x').code, 3);
  } finally {
    c.done();
  }
});

test('git-sync settings: add refuses bad patterns and folders that are not a repository top, writing nothing', () => {
  const c = config();
  try {
    const repo = repoFixture(c);
    const drive = `C${':'}`;
    for (const p of ['/Packages/', 'Assets\\UI', `${drive}/x`, `${drive}x`, 'Assets/../x', './Assets', 'a//b', 'a.png/.', 'a'.repeat(201), '', 'a\tb']) {
      assert.match(autoAdd(c.file, repo, p).error, /the pattern /, JSON.stringify(p));
    }
    assert.equal(existsSync(c.file), false);
    assert.equal(autoAdd(c.file, repo, 'a'.repeat(200)).status, 'added');
    rmSync(c.file);
    assert.match(autoAdd(c.file, path.join(c.base, 'gone'), 'x').error, /does not exist/);
    const file = path.join(c.base, 'note.txt');
    writeFileSync(file, '');
    assert.match(autoAdd(c.file, file, 'x').error, /must be a folder/);
    assert.match(autoAdd(c.file, c.place, 'x').error, /no \.git/);
    assert.match(autoAdd(c.file, 'relative/repo', 'x').error, /absolute path/);
    assert.equal(existsSync(c.file), false);
    // A config folder that does not exist is never created.
    const gone = gitSyncSettingsFile({ CLAUDE_CONFIG_DIR: path.join(c.base, 'none') });
    assert.match(autoAdd(gone, repo, 'x').error, /config folder does not exist/);
    assert.equal(existsSync(path.join(c.base, 'none')), false);
    // A worktree has a .git file instead of a folder.
    const worktree = path.join(c.base, 'worktree');
    mkdirSync(worktree);
    writeFileSync(path.join(worktree, '.git'), 'gitdir: elsewhere\n');
    assert.equal(autoAdd(c.file, worktree, 'Packages/').status, 'added');
  } finally {
    c.done();
  }
});

test('git-sync settings: on Windows the same repository written with / or a lower-case drive is one key', { skip: process.platform !== 'win32' && 'Windows paths only' }, () => {
  const c = config();
  try {
    const repo = repoFixture(c);
    assert.equal(auto(c, 'add', repo, 'Packages/').code, 0);
    const slashes = repo.split('\\').join('/');
    const lower = repo[0].toLowerCase() + repo.slice(1);
    assert.equal(auto(c, 'add', slashes, '.omc/').code, 0);
    assert.equal(auto(c, 'add', lower, 'Packages/').out, 'Packages/ already listed\n');
    const data = readJson(c.file);
    assert.deepEqual(data, { autoChanged: { [repo]: ['Packages/', '.omc/'] }, importedFromArt: { [repo]: [] } });
    assert.equal(auto(c, 'list', `${lower}\\`).out, 'Packages/\n.omc/\n');
    assert.equal(matchRun(c, slashes, 'Packages/manifest.json\n').out, 'Packages/manifest.json\tPackages/\n');
  } finally {
    c.done();
  }
});

test('git-sync settings: match follows the small glob over whole paths and prints the first matching pattern', () => {
  const yes = [
    ['Packages/', 'Packages/manifest.json'], ['Packages/', 'Packages/a/b/c.json'], ['**/*.spriteatlas', 'a.spriteatlas'],
    ['**/*.spriteatlas', 'Assets/UI/아트 폴더/b.spriteatlas'], ['Assets/*.meta', 'Assets/x.meta'], ['Assets/**/x.png', 'Assets/x.png'],
    ['Assets/**/x.png', 'Assets/a/b/x.png'], ['ProjectSettings/*Settings.asset', 'ProjectSettings/QualitySettings.asset'],
    ['a/***/b', 'a/c/b'], ['x+(y).txt', 'x+(y).txt'], ['Packages/', '.\\Packages\\m.json\r'], ['*_BACKUP_*', 'a_BACKUP_1.png'],
  ];
  const no = [
    ['Packages/', 'PackagesX/a'], ['Packages/', 'Packages'], ['Packages/', 'Assets/Packages/a'], ['Assets/*.meta', 'Assets/a/x.meta'],
    ['*.meta', 'Assets/x.meta'], ['x.png', 'Assets/x.png'], ['packages/', 'Packages/a'], ['x+(y).txt', 'xx+(y).txt'], ['a.b', 'axb'],
  ];
  for (const [p, rel] of yes) assert.equal(matchPattern(p, rel), true, `${p} ~ ${rel}`);
  for (const [p, rel] of no) assert.equal(matchPattern(p, rel), false, `${p} !~ ${rel}`);
  // Long runs of * and ** stay fast.
  const t = Date.now();
  assert.equal(matchPattern(`${'**/'.repeat(60)}${'*'.repeat(50)}x`, `${'a/'.repeat(40)}${'a'.repeat(60)}`), false);
  assert.ok(Date.now() - t < 2000);
  const c = config();
  try {
    const repo = repoFixture(c);
    for (const p of ['Packages/', '**/*.meta', 'Assets/UI/a.meta']) assert.equal(auto(c, 'add', repo, p).code, 0);
    const r = matchRun(c, repo, 'Packages/manifest.json\r\nAssets/UI/a.meta\r\nAssets/UI/a.prefab\r\n\r\nRecordings/v.mp4\n');
    assert.deepEqual(r, { code: 0, out: 'Packages/manifest.json\tPackages/\nAssets/UI/a.meta\t**/*.meta\n', err: '' });
    assert.deepEqual(matchRun(c, path.join(c.base, 'other'), 'Packages/manifest.json\n'), { code: 0, out: '', err: '' });
  } finally {
    c.done();
  }
});

test('git-sync settings: a broken file is a read error that add refuses too, unknown keys are errors and notes are kept', () => {
  const c = config();
  try {
    const repo = repoFixture(c);
    mkdirSync(path.dirname(c.file));
    const broken = ['{ broken', JSON.stringify({ autoChange: {} }), JSON.stringify({ autoChanged: [] }), JSON.stringify({ autoChanged: { x: 'Packages/' } }),
      JSON.stringify({ autoChanged: { x: ['../a'] } }), JSON.stringify({ importedFromArt: { x: [3] } }), JSON.stringify([])];
    for (const text of broken) {
      writeFileSync(c.file, text);
      assert.ok(readGitSyncSettings(c.file).error, text);
      assert.equal(auto(c, 'list', repo).code, 1, text);
      const r = auto(c, 'add', repo, 'Packages/');
      assert.equal(r.code, 1, text);
      assert.match(r.err, /fix or remove/);
      assert.equal(auto(c, 'remove', repo, 'Packages/').code, 1, text);
      assert.equal(readFileSync(c.file, 'utf8'), text);
    }
    assert.match(readGitSyncSettings(c.file).error, /top level/);
    writeFileSync(c.file, JSON.stringify({ autoChange: {} }));
    assert.match(readGitSyncSettings(c.file).error, /unknown key "autoChange"/);
    writeFileSync(c.file, `\uFEFF${JSON.stringify({ _: '메모', _old: { a: 1 } })}`);
    assert.equal(auto(c, 'add', repo, 'Packages/').code, 0);
    const key = path.resolve(repo);
    assert.deepEqual(readJson(c.file), { _: '메모', _old: { a: 1 }, autoChanged: { [key]: ['Packages/'] }, importedFromArt: { [key]: [] } });
  } finally {
    c.done();
  }
});

test('git-sync settings: three auto add commands at once all land, and match reads the paths from standard input', async () => {
  const c = config();
  try {
    const repo = repoFixture(c);
    const one = (pattern) => new Promise((resolve) => {
      const p = spawn(process.execPath, [CLI, 'auto', 'add', repo, pattern], { env: { ...process.env, CLAUDE_CONFIG_DIR: c.dir } });
      p.on('close', resolve);
    });
    assert.deepEqual(await Promise.all([one('Packages/'), one('.omc/'), one('**/*.orig')]), [0, 0, 0]);
    const list = readJson(c.file).autoChanged[path.resolve(repo)];
    assert.deepEqual([...list].sort(), ['**/*.orig', '.omc/', 'Packages/']);
    const r = spawnSync(process.execPath, [CLI, 'auto', 'match', repo], { env: { ...process.env, CLAUDE_CONFIG_DIR: c.dir }, input: 'Packages/a.json\nAssets/b.prefab\nx.orig\n' });
    assert.equal(r.status, 0, r.stderr.toString());
    assert.equal(r.stdout.toString('utf8'), 'Packages/a.json\tPackages/\nx.orig\t**/*.orig\n');
  } finally {
    c.done();
  }
});

test('git-sync import: the art.json list shows in list and match without writing, the first add copies it, and removals stick', () => {
  const c = config();
  try {
    const repo = repoFixture(c);
    const key = path.resolve(repo);
    const art = writeArt(c, { [repo]: ['Packages/', '**/*.meta'], [path.join(c.base, 'other')]: ['Library/'] });
    assert.deepEqual(auto(c, 'list', repo), { code: 0, out: 'Packages/\n**/*.meta\n', err: '' });
    assert.equal(matchRun(c, repo, 'Packages/a.json\nAssets/b.prefab\n').out, 'Packages/a.json\tPackages/\n');
    assert.equal(existsSync(c.file), false);
    assert.deepEqual(auto(c, 'add', repo, '.omc/'), { code: 0, out: '.omc/ added\n', err: '' });
    assert.deepEqual(readJson(c.file), { autoChanged: { [key]: ['Packages/', '**/*.meta', '.omc/'] }, importedFromArt: { [key]: ['Packages/', '**/*.meta'] } });
    assert.deepEqual(auto(c, 'list', repo), { code: 0, out: 'Packages/\n**/*.meta\n.omc/\n', err: '' });
    for (const p of ['Packages/', '**/*.meta', '.omc/']) assert.equal(auto(c, 'remove', repo, p).code, 0);
    assert.deepEqual(auto(c, 'list', repo), { code: 0, out: '', err: '' });
    assert.deepEqual(readJson(c.file).autoChanged, { [key]: [] });
    // Another repository still imports its own list on its first change.
    const other = path.join(c.base, 'other');
    mkdirSync(path.join(other, '.git'), { recursive: true });
    assert.equal(auto(c, 'add', other, 'Packages/').code, 0);
    assert.deepEqual(readJson(c.file).autoChanged[path.resolve(other)], ['Library/', 'Packages/']);
    assert.equal(readFileSync(c.art, 'utf8'), art);
  } finally {
    c.done();
  }
});

test('git-sync import: bad patterns are dropped, relative keys skipped, and every key naming the repository merged without duplicates', () => {
  const c = config();
  try {
    const repo = repoFixture(c);
    const key = path.resolve(repo);
    const art = writeArt(c, { [repo]: ['Packages/', '../bad', '**/*.meta', 3], [`${repo}${path.sep}`]: ['**/*.meta', '.omc/'], 'relative/repo': ['Library/'] }, { unknownKey: { x: 1 }, gameRoot: 3 });
    assert.equal(auto(c, 'list', repo).out, 'Packages/\n**/*.meta\n.omc/\n');
    assert.equal(auto(c, 'list', path.resolve('relative/repo')).out, '');
    assert.equal(auto(c, 'add', repo, 'Packages/').out, 'Packages/ already listed\n');
    // The first add writes the imported list even when the pattern was already there.
    assert.deepEqual(readJson(c.file), { autoChanged: { [key]: ['Packages/', '**/*.meta', '.omc/'] }, importedFromArt: { [key]: ['Packages/', '**/*.meta', '.omc/'] } });
    assert.equal(readFileSync(c.art, 'utf8'), art);
  } finally {
    c.done();
  }
});

test('git-sync import: a first remove of a pattern that is not listed still copies the list in', () => {
  const c = config();
  try {
    const repo = repoFixture(c);
    const key = path.resolve(repo);
    writeArt(c, { [repo]: ['Packages/'] });
    assert.equal(auto(c, 'remove', repo, 'Library/').code, 3);
    assert.deepEqual(readJson(c.file), { autoChanged: { [key]: ['Packages/'] }, importedFromArt: { [key]: ['Packages/'] } });
  } finally {
    c.done();
  }
});

test('git-sync import: on Windows an art.json key written with / or a lower-case drive matches', { skip: process.platform !== 'win32' && 'Windows paths only' }, () => {
  const c = config();
  try {
    const repo = repoFixture(c);
    const lower = repo[0].toLowerCase() + repo.slice(1);
    writeArt(c, { [lower.split('\\').join('/')]: ['Packages/'], [lower]: ['.omc/', 'Packages/'] });
    assert.equal(auto(c, 'list', repo).out, 'Packages/\n.omc/\n');
    assert.equal(auto(c, 'add', repo, 'x/').code, 0);
    assert.deepEqual(readJson(c.file).autoChanged, { [repo]: ['Packages/', '.omc/', 'x/'] });
  } finally {
    c.done();
  }
});

test('git-sync import: an art.json that cannot be parsed makes add and remove fail without a key, and list warn', () => {
  const c = config();
  try {
    const repo = repoFixture(c);
    const cases = [
      () => writeArt(c, ['Packages/']),
      () => writeArt(c, { [repo]: 'Packages/' }),
      () => (mkdirSync(path.dirname(c.art), { recursive: true }), writeFileSync(c.art, '{ broken'), '{ broken'),
    ];
    for (const make of cases) {
      const art = make();
      const add = auto(c, 'add', repo, '.omc/');
      assert.equal(add.code, 1, art);
      assert.ok(add.err.includes(c.art), add.err);
      assert.equal(auto(c, 'remove', repo, 'Packages/').code, 1, art);
      assert.equal(existsSync(c.file), false);
      const list = auto(c, 'list', repo);
      assert.equal(list.code, 0);
      assert.equal(list.out, '');
      assert.match(list.err, /^warning: .*art\.json/);
      assert.equal(readFileSync(c.art, 'utf8'), art);
    }
    // With a git-sync.json entry, a broken art.json is passed over quietly.
    rmSync(c.art);
    assert.equal(auto(c, 'add', repo, '.omc/').code, 0);
    writeFileSync(c.art, '{ broken');
    assert.deepEqual(auto(c, 'list', repo), { code: 0, out: '.omc/\n', err: '' });
  } finally {
    c.done();
  }
});

test('git-sync import: art.json reads try again while the file is held', () => {
  const c = config();
  try {
    const repo = repoFixture(c);
    const key = path.resolve(repo);
    writeArt(c, { [repo]: ['Packages/'] });
    const held = (times) => {
      let left = times;
      return (file, enc) => {
        if (path.basename(file) === 'art.json' && left-- > 0) throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
        return readFileSync(file, enc);
      };
    };
    const always = run(c, ['auto', 'add', repo, '.omc/'], { readFile: held(Infinity), retryMs: 100 });
    assert.equal(always.code, 1);
    assert.match(always.err, /EPERM|operation not permitted/);
    assert.equal(existsSync(c.file), false);
    const once = run(c, ['auto', 'add', repo, '.omc/'], { readFile: held(1), retryMs: 2000 });
    assert.equal(once.code, 0, once.err);
    assert.deepEqual(readJson(c.file).autoChanged, { [key]: ['Packages/', '.omc/'] });
  } finally {
    c.done();
  }
});

test('git-sync import: two first adds at once both land and the old list comes in once', async () => {
  const c = config();
  try {
    const repo = repoFixture(c);
    writeArt(c, { [repo]: ['Packages/', '**/*.meta'] });
    const one = (pattern) => new Promise((resolve) => {
      const p = spawn(process.execPath, [CLI, 'auto', 'add', repo, pattern], { env: { ...process.env, CLAUDE_CONFIG_DIR: c.dir } });
      p.on('close', resolve);
    });
    assert.deepEqual(await Promise.all([one('.omc/'), one('**/*.orig')]), [0, 0]);
    const data = readJson(c.file);
    const key = path.resolve(repo);
    assert.deepEqual([...data.autoChanged[key]].sort(), ['**/*.meta', '**/*.orig', '.omc/', 'Packages/']);
    assert.deepEqual(data.importedFromArt[key], ['Packages/', '**/*.meta']);
  } finally {
    c.done();
  }
});

test('git-sync import notice: only art.json patterns found neither in the list nor in the import record are named', () => {
  const c = config();
  try {
    const repo = repoFixture(c);
    writeArt(c, { [repo]: ['Packages/', '**/*.meta'] });
    assert.equal(auto(c, 'add', repo, '.omc/').code, 0);
    assert.equal(auto(c, 'list', repo).err, '');
    // An old am-art adds a pattern after the import: list and match name it alone.
    writeArt(c, { [repo]: ['Packages/', '**/*.meta', 'Library/', '../bad'] });
    const list = auto(c, 'list', repo);
    assert.equal(list.code, 0);
    assert.equal(list.out, 'Packages/\n**/*.meta\n.omc/\n');
    assert.match(list.err, /^notice: .*art\.json lists patterns for this repository that git-sync\.json does not: Library\/; add them again with auto add if still needed\n$/);
    assert.match(matchRun(c, repo, 'Library/a\n').err, /does not: Library\//);
    // A removed imported pattern is not named.
    assert.equal(auto(c, 'remove', repo, 'Packages/').code, 0);
    assert.doesNotMatch(auto(c, 'list', repo).err, /Packages/);
    // A named pattern added and then removed is not named again.
    assert.equal(auto(c, 'add', repo, 'Library/').code, 0);
    assert.equal(auto(c, 'list', repo).err, '');
    assert.equal(auto(c, 'remove', repo, 'Library/').code, 0);
    assert.deepEqual(auto(c, 'list', repo), { code: 0, out: '**/*.meta\n.omc/\n', err: '' });
  } finally {
    c.done();
  }
});
