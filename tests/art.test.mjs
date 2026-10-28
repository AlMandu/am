// Run: node --test tests/art.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { artSettingsFile, main, readArtSettings, setArtSetting } from '../art/scripts/art-settings.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO, 'art', 'scripts', 'art-settings.mjs');

// A temporary config folder (CLAUDE_CONFIG_DIR) plus an existing folder whose name has Korean and a space.
function config() {
  const base = mkdtempSync(path.join(os.tmpdir(), 'am-art-'));
  const dir = path.join(base, 'config');
  mkdirSync(dir);
  const place = path.join(base, '아트 작업', '무기 폴더');
  mkdirSync(place, { recursive: true });
  const env = { CLAUDE_CONFIG_DIR: dir };
  return { base, dir, place, env, file: artSettingsFile(env), done: () => rmSync(base, { recursive: true, force: true }) };
}

function run(env, ...args) {
  const out = [];
  const err = [];
  const code = main(args, { env, out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out: out.join(''), err: err.join('') };
}

test('art settings: a missing file reads as empty, get of an unset key exits 3, and the file sits under am/', () => {
  const c = config();
  try {
    assert.equal(c.file, path.join(c.dir, 'am', 'art.json'));
    assert.deepEqual(readArtSettings(c.file), { data: {} });
    const r = run(c.env, 'get', 'spineRoot');
    assert.equal(r.code, 3);
    assert.match(r.err, /spineRoot is not set/);
    assert.equal(run(c.env, 'get', 'nope').code, 1);
    assert.equal(run(c.env, 'set', 'spineRoot').code, 2);
    assert.equal(run(c.env).code, 2);
  } finally {
    c.done();
  }
});

test('art settings: broken JSON and unknown keys are errors, and set refuses instead of rewriting the file', () => {
  const c = config();
  try {
    mkdirSync(path.dirname(c.file));
    writeFileSync(c.file, '{ broken');
    assert.match(readArtSettings(c.file).error, /not valid JSON/);
    assert.equal(run(c.env, 'set', 'spineRoot', c.place).code, 1);
    assert.equal(readFileSync(c.file, 'utf8'), '{ broken');
    writeFileSync(c.file, JSON.stringify({ spine: 'x' }));
    assert.match(readArtSettings(c.file).error, /unknown key "spine"/);
    const r = run(c.env, 'set', 'python', c.place);
    assert.equal(r.code, 1);
    assert.match(r.err, /unknown key "spine".*fix or remove/);
    assert.equal(readFileSync(c.file, 'utf8'), JSON.stringify({ spine: 'x' }));
    writeFileSync(c.file, JSON.stringify({ deployTools: { wpn: 3 } }));
    assert.match(readArtSettings(c.file).error, /deployTools\.wpn must be/);
  } finally {
    c.done();
  }
});

test('art settings: a BOM is read, notes are kept, and backslash, Korean and space paths go round unchanged', () => {
  const c = config();
  try {
    mkdirSync(path.dirname(c.file));
    writeFileSync(c.file, `﻿${JSON.stringify({ _: '메모', _old: { a: 1 } })}`);
    assert.equal(run(c.env, 'set', 'adCodexRoot', c.place).code, 0);
    const tool = path.join(c.place, 'wpn deploy.py');
    writeFileSync(tool, '');
    assert.equal(run(c.env, 'set', 'deployTools.무기', tool).code, 0);
    const data = JSON.parse(readFileSync(c.file, 'utf8'));
    assert.deepEqual(data, { _: '메모', _old: { a: 1 }, adCodexRoot: c.place, deployTools: { 무기: tool } });
    assert.equal(run(c.env, 'get', 'adCodexRoot').out, `${c.place}\n`);
    assert.equal(run(c.env, 'get', 'deployTools.무기').out, `${tool}\n`);
    assert.equal(run(c.env, 'get', 'deployTools.펫').code, 3);
    assert.match(run(c.env, 'show').out, /무기 폴더/);
    if (process.platform === 'win32') assert.ok(c.place.includes('\\'));
  } finally {
    c.done();
  }
});

test('art settings: set checks the path (absolute, existing, no control characters) and leaves the file alone', () => {
  const c = config();
  try {
    assert.match(setArtSetting(c.file, 'spineRoot', `${c.place}\tx`), /control characters/);
    assert.match(setArtSetting(c.file, 'spineRoot', 'relative/dir'), /absolute path/);
    assert.match(setArtSetting(c.file, 'spineRoot', path.join(c.place, 'missing')), /does not exist/);
    assert.match(setArtSetting(c.file, 'other', c.place), /unknown key "other"/);
    assert.equal(existsSync(c.file), false);
    // A config folder that does not exist is never created.
    const gone = artSettingsFile({ CLAUDE_CONFIG_DIR: path.join(c.base, 'none') });
    assert.match(setArtSetting(gone, 'spineRoot', c.place), /config folder does not exist/);
    assert.equal(existsSync(path.join(c.base, 'none')), false);
  } finally {
    c.done();
  }
});

test('art settings: gameRoot goes round, refuses a relative or missing path, and a file holding it reads cleanly', () => {
  const c = config();
  try {
    assert.equal(run(c.env, 'set', 'gameRoot', c.place).code, 0);
    assert.equal(run(c.env, 'get', 'gameRoot').out, `${c.place}\n`);
    assert.equal(run(c.env, 'set', 'gameRoot', 'relative/game').code, 1);
    assert.match(setArtSetting(c.file, 'gameRoot', path.join(c.place, 'missing')), /gameRoot does not exist/);
    assert.equal(JSON.parse(readFileSync(c.file, 'utf8')).gameRoot, c.place);
    writeFileSync(c.file, JSON.stringify({ gameRoot: path.join(c.base, 'gone'), spineRoot: c.place }));
    assert.deepEqual(readArtSettings(c.file), { data: { gameRoot: path.join(c.base, 'gone'), spineRoot: c.place } });
  } finally {
    c.done();
  }
});

test('art settings: a stale lock is taken over, a live one makes set wait and then fail', () => {
  const c = config();
  try {
    mkdirSync(path.dirname(c.file));
    writeFileSync(`${c.file}.lock`, '');
    let t = Date.now() + 60_000;
    assert.equal(setArtSetting(c.file, 'spineRoot', c.place, { now: () => t }), '');
    assert.equal(existsSync(`${c.file}.lock`), false);
    writeFileSync(`${c.file}.lock`, '');
    t = Date.now();
    assert.match(setArtSetting(c.file, 'python', c.place, { now: () => t, waitMs: -1 }), /another writer holds/);
    assert.equal(JSON.parse(readFileSync(c.file, 'utf8')).python, undefined);
    assert.deepEqual(readdirSync(path.dirname(c.file)).sort(), ['art.json', 'art.json.lock']);
  } finally {
    c.done();
  }
});

test('art settings: two set commands at once both land', async () => {
  const c = config();
  try {
    const one = (key, value) => new Promise((resolve) => {
      const p = spawn(process.execPath, [CLI, 'set', key, value], { env: { ...process.env, CLAUDE_CONFIG_DIR: c.dir } });
      p.on('close', resolve);
    });
    const codes = await Promise.all([one('spineRoot', c.place), one('adCodexRoot', c.base), one('deployTools.펫', c.place)]);
    assert.deepEqual(codes, [0, 0, 0]);
    const data = JSON.parse(readFileSync(c.file, 'utf8'));
    assert.equal(Object.keys(data).length, 3);
    assert.equal(data.spineRoot, c.place);
    assert.equal(data.adCodexRoot, c.base);
    assert.equal(data.deployTools.펫, c.place);
  } finally {
    c.done();
  }
});

// autoChanged is the old am-art 0.1.3 list: read and kept as it is, never written; am-util:git-sync keeps the live list.
test('art settings: an art.json written by am-art 0.1.3 still reads and set keeps its autoChanged', () => {
  const c = config();
  try {
    mkdirSync(path.dirname(c.file));
    const repo = path.join(c.base, '게임 저장소');
    // Only the shape is checked, so patterns git-sync would refuse still read.
    const old = { _note: '메모', spineRoot: c.place, autoChanged: { [repo]: ['Packages/', '../odd', ''] } };
    writeFileSync(c.file, JSON.stringify(old, null, 2));
    assert.deepEqual(readArtSettings(c.file), { data: old });
    assert.equal(run(c.env, 'set', 'python', c.place).code, 0);
    assert.equal(readFileSync(c.file, 'utf8'), `${JSON.stringify({ ...old, python: c.place }, null, 2)}\n`);
    for (const args of [['auto', 'list', repo], ['auto']]) {
      const r = run(c.env, ...args);
      assert.equal(r.code, 2);
      assert.match(r.err, /^usage: /);
      assert.doesNotMatch(r.err, /auto/);
    }
  } finally {
    c.done();
  }
});

test('art settings: a broken autoChanged is still a read error that set refuses', () => {
  const c = config();
  try {
    mkdirSync(path.dirname(c.file));
    for (const bad of [{ autoChanged: [] }, { autoChanged: { x: 'Packages/' } }, { autoChanged: { x: [3] } }]) {
      writeFileSync(c.file, JSON.stringify(bad));
      assert.match(readArtSettings(c.file).error, /autoChanged/, JSON.stringify(bad));
      const r = run(c.env, 'set', 'spineRoot', c.place);
      assert.equal(r.code, 1);
      assert.match(r.err, /autoChanged.*fix or remove/);
      assert.equal(readFileSync(c.file, 'utf8'), JSON.stringify(bad));
    }
    writeFileSync(c.file, JSON.stringify({ autoChange: {} }));
    assert.match(readArtSettings(c.file).error, /unknown key "autoChange"/);
  } finally {
    c.done();
  }
});

test('art settings: get and set autoChanged point to am-util:git-sync, and show adds a note only when the key is there', () => {
  const c = config();
  try {
    const set = run(c.env, 'set', 'autoChanged', c.place);
    assert.equal(set.code, 1);
    assert.match(set.err, /moved to am-util:git-sync/);
    assert.equal(existsSync(c.file), false);
    const get = () => {
      const r = run(c.env, 'get', 'autoChanged');
      assert.deepEqual([r.code, r.out], [1, '']);
      assert.match(r.err, /git-sync\.json/);
    };
    get();
    mkdirSync(path.dirname(c.file));
    const data = { autoChanged: { [c.place]: ['Packages/'] } };
    writeFileSync(c.file, JSON.stringify(data));
    get();
    let r = run(c.env, 'show');
    assert.deepEqual([r.code, r.out], [0, `${c.file}\n${JSON.stringify(data, null, 2)}\n`]);
    assert.match(r.err, /^note: .*git-sync\.json\n$/);
    writeFileSync(c.file, JSON.stringify({ spineRoot: c.place }));
    r = run(c.env, 'show');
    assert.deepEqual([r.code, r.err], [0, '']);
    writeFileSync(c.file, '{ broken');
    r = run(c.env, 'get', 'autoChanged');
    assert.equal(r.code, 1);
    assert.match(r.err, /not valid JSON/);
    assert.doesNotMatch(r.err, /moved to/);
  } finally {
    c.done();
  }
});

// The generator runs on a real Python: none, or the Windows Store stand-in, skips these tests with the reason.
const GENERATOR = path.join(REPO, 'art', 'scripts', 'make_compare.py');
function findPython() {
  for (const cmd of ['python', 'python3']) {
    const r = spawnSync(cmd, ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' });
    const exe = (r.stdout || '').trim();
    // The Store stand-in prints nothing and fails; a real Store Python passes.
    if (r.status === 0 && exe) {
      const pil = spawnSync(cmd, ['-c', 'import PIL'], { encoding: 'utf8' }).status === 0;
      return { cmd, pil };
    }
  }
  return null;
}
const PY = findPython();
const noPython = PY ? false : 'no Python on PATH (or only the Windows Store stand-in)';
const noPillow = noPython || (PY.pil ? false : 'Python has no Pillow');

// Fake art: an opaque 600x300 background, a transparent 64x64 sprite and a missing file, under a Korean folder with a space.
function artFixture() {
  const base = mkdtempSync(path.join(os.tmpdir(), 'am-art-gen-'));
  const src = path.join(base, '원본 이미지');
  mkdirSync(src);
  const script = [
    'import sys', 'from PIL import Image', 'd = sys.argv[1]',
    "Image.new('RGB', (600, 300), (40, 90, 160)).save(d + '/bg 원시.png')",
    "im = Image.new('RGBA', (64, 64), (0, 0, 0, 0)); im.putpixel((5, 5), (255, 0, 0, 255)); im.save(d + '/cat.png')",
  ].join('\n');
  const made = spawnSync(PY.cmd, ['-c', script, src], { encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  const rules = path.join(base, 'compare.json');
  writeFileSync(rules, JSON.stringify({ title: '배경 비교', columns: 3, gameSize: { width: 300, height: 150 }, firstSection: '근대', overlays: [{ name: '고양이', on: true }] }));
  const manifest = path.join(base, 'manifest.json');
  writeFileSync(manifest, JSON.stringify({ sections: [
    { name: '원시', rows: [{ title: '배경', cells: [
      { label: '원시 1', image: '원본 이미지/bg 원시.png', overlays: { 고양이: [{ image: '원본 이미지/cat.png', x: 10, y: 50, w: 20 }] } },
      { label: '원시 2', image: path.join(src, 'cat.png') },
    ] }] },
    { name: '근대', rows: [{ title: '배경', columns: 2, cells: [{ label: '근대 1', image: path.join(src, 'missing.png') }] }] },
  ] }));
  return { base, src, rules, manifest, done: () => rmSync(base, { recursive: true, force: true }) };
}

function generate(f, mode, out, extra = []) {
  const r = spawnSync(PY.cmd, [GENERATOR, '--rules', f.rules, '--manifest', f.manifest, '--mode', mode, '--out', out, ...extra], { encoding: 'utf8' });
  const last = (r.stdout || '').trim().split('\n').pop();
  return { status: r.status, stderr: r.stderr, summary: last ? JSON.parse(last) : null };
}
const pageData = (file) => JSON.parse(/<script type="application\/json" id="data">([\s\S]*?)<\/script>/.exec(readFileSync(file, 'utf8'))[1]);

test('make_compare: the local page points at the originals and reports the missing image', { skip: noPillow }, () => {
  const f = artFixture();
  try {
    const out = path.join(f.base, '결과', 'local.html');
    const r = generate(f, 'local', out);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.summary.out, out);
    assert.deepEqual(r.summary.missing, [path.join(f.src, 'missing.png')]);
    assert.equal(r.summary.over20MB, false);
    const text = readFileSync(out, 'utf8');
    assert.match(text, /<meta name="generator" content="am-art make_compare">/);
    for (const word of ['칸 크기', '실사용 크기(1:1)', '별표 목록 내보내기', '원본 열기', '경로 복사', '켜기/끄기', '이미지 없음']) assert.ok(text.includes(word), word);
    assert.match(text, /localStorage\.setItem[^;]*;\s*\} catch/);
    const page = pageData(out);
    assert.equal(page.firstSection, '근대');
    const cell = page.sections[0].rows[0].cells[0];
    assert.equal(cell.path, path.join(f.src, 'bg 원시.png'));
    assert.match(cell.src, /^file:\/\/\/.*%EC%9B%90%EB%B3%B8%20/);
    assert.equal(cell.overlays.고양이.length, 1);
    assert.equal(page.sections[1].rows[0].columns, 2);
    assert.equal(page.sections[1].rows[0].cells[0].src, null);
  } finally {
    f.done();
  }
});

test('make_compare: the share page holds only data URIs, keeps the transparent PNG and turns the opaque one to JPEG', { skip: noPillow }, () => {
  const f = artFixture();
  try {
    const out = path.join(f.base, 'share.html');
    const r = generate(f, 'share', out, ['--jpeg-long-edge', '200', '--jpeg-quality', '70']);
    assert.equal(r.status, 0, r.stderr);
    // Moved to another folder, the page still names no file.
    const moved = path.join(os.tmpdir(), `am-art-moved-${process.pid}.html`);
    writeFileSync(moved, readFileSync(out));
    try {
      const page = pageData(moved);
      const [bg, cat] = page.sections[0].rows[0].cells;
      assert.match(bg.src, /^data:image\/jpeg;base64,/);
      assert.match(cat.src, /^data:image\/png;base64,/);
      assert.equal(bg.path, undefined);
      const catBytes = Buffer.from(cat.src.split(',')[1], 'base64');
      assert.deepEqual(catBytes, readFileSync(path.join(f.src, 'cat.png')));
      const size = spawnSync(PY.cmd, ['-c', 'import sys,io,base64;from PIL import Image;print(Image.open(io.BytesIO(base64.b64decode(sys.stdin.read()))).size)'], { input: bg.src.split(',')[1], encoding: 'utf8' });
      assert.equal(size.stdout.trim(), '(200, 100)');
      const text = readFileSync(moved, 'utf8');
      assert.doesNotMatch(text, /file:\/\//);
      assert.ok(!text.includes(f.src));
    } finally {
      rmSync(moved, { force: true });
    }
  } finally {
    f.done();
  }
});

test('make_compare: a hostile label keeps the page data whole, a transparent TGA becomes PNG, and stars are kept per page', { skip: noPillow }, () => {
  const f = artFixture();
  try {
    const tga = spawnSync(PY.cmd, ['-c', "import sys; from PIL import Image; im = Image.new('RGBA', (8, 8), (0, 0, 0, 0)); im.save(sys.argv[1])", path.join(f.src, 'alpha.tga')], { encoding: 'utf8' });
    assert.equal(tga.status, 0, tga.stderr);
    writeFileSync(f.manifest, JSON.stringify({ sections: [{ name: '원시', rows: [{ title: 'x', cells: [{ label: '<!--<script></script>', image: '원본 이미지/alpha.tga' }] }] }] }));
    const out = path.join(f.base, 'page-a.html');
    assert.equal(generate(f, 'share', out).status, 0);
    const text = readFileSync(out, 'utf8');
    const data = /<script type="application\/json" id="data">([\s\S]*?)<\/script>/.exec(text)[1];
    assert.ok(!data.includes('<'));
    const page = JSON.parse(data);
    assert.equal(page.sections[0].rows[0].cells[0].label, '<!--<script></script>');
    assert.match(page.sections[0].rows[0].cells[0].src, /^data:image\/png;base64,iVBORw0KGgo/);
    assert.equal(page.page, 'page-a.html');
    assert.ok(text.includes("'am-art-stars:' + page.page"));
  } finally {
    f.done();
  }
});

test('make_compare: a bad manifest ends with the JSON error line, not a traceback', { skip: noPython }, () => {
  const f = { base: mkdtempSync(path.join(os.tmpdir(), 'am-art-bad-')) };
  try {
    f.rules = path.join(f.base, 'compare.json');
    f.manifest = path.join(f.base, 'm.json');
    writeFileSync(f.rules, JSON.stringify({ columns: 'three' }));
    writeFileSync(f.manifest, JSON.stringify({ sections: [] }));
    let r = generate(f, 'local', path.join(f.base, 'o.html'));
    assert.equal(r.status, 1);
    assert.match(r.summary.error, /칸 수/);
    writeFileSync(f.rules, '{}');
    writeFileSync(f.manifest, JSON.stringify({ sections: [{ rows: [{ cells: [{ overlays: { 고양이: [{ x: 1 }] } }] }] }] }));
    r = generate(f, 'local', path.join(f.base, 'o.html'));
    assert.equal(r.status, 1);
    assert.match(r.summary.error, /image 가 없습니다/);
    assert.doesNotMatch(r.stderr, /Traceback/);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test('make_compare: it never overwrites a page it did not make or an input, but rewrites its own', { skip: noPillow }, () => {
  const f = artFixture();
  try {
    const hand = path.join(f.base, 'bg_overview2.html');
    writeFileSync(hand, '<html>손으로 만든 페이지</html>');
    let r = generate(f, 'local', hand);
    assert.equal(r.status, 1);
    assert.match(r.summary.error, /덮어쓰지 않습니다/);
    assert.equal(readFileSync(hand, 'utf8'), '<html>손으로 만든 페이지</html>');
    const image = path.join(f.src, 'cat.png');
    const before = readFileSync(image);
    r = generate(f, 'local', image);
    assert.equal(r.status, 1);
    assert.deepEqual(readFileSync(image), before);
    const own = path.join(f.base, 'own.html');
    assert.equal(generate(f, 'local', own).status, 0);
    assert.equal(generate(f, 'share', own).status, 0);
    assert.deepEqual(readdirSync(f.base).filter((n) => n.endsWith('.tmp')), []);
  } finally {
    f.done();
  }
});

// make_dropin: one shrunk copy for the game, written only as a new file.
const DROPIN = path.join(REPO, 'art', 'scripts', 'make_dropin.py');
function dropinFixture() {
  const base = mkdtempSync(path.join(os.tmpdir(), 'am-art-drop-'));
  const src = path.join(base, '정본 이미지');
  mkdirSync(src);
  const script = [
    'import sys', 'from PIL import Image, ImageDraw', 'd = sys.argv[1]',
    "im = Image.new('RGBA', (256, 256), (0, 0, 0, 0)); ImageDraw.Draw(im).ellipse((28, 28, 228, 228), fill=(255, 0, 0, 255)); im.save(d + '/빨간 원.png')",
    "Image.new('RGBA', (512, 256), (0, 128, 255, 255)).save(d + '/wide.png')",
    "Image.new('RGBA', (64, 64), (0, 128, 255, 255)).save(d + '/small.png')",
  ].join('\n');
  const made = spawnSync(PY.cmd, ['-c', script, src], { encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  return { base, src, done: () => rmSync(base, { recursive: true, force: true }) };
}
function dropin(src, out, extra = []) {
  const r = spawnSync(PY.cmd, [DROPIN, '--src', src, '--out', out, ...extra], { encoding: 'utf8' });
  const last = (r.stdout || '').trim().split('\n').pop();
  return { status: r.status, stderr: r.stderr, summary: last ? JSON.parse(last) : null };
}
const failed = (r) => {
  assert.equal(r.status, 1);
  assert.equal(typeof r.summary.error, 'string');
  assert.match(r.stderr, /오류: /);
  assert.doesNotMatch(r.stderr, /Traceback/);
};

test('make_dropin: a transparent 256 circle becomes a 128 PNG with no dark fringe, and a wide image keeps its ratio', { skip: noPillow }, () => {
  const f = dropinFixture();
  try {
    const out = path.join(f.base, '게임 투입', '새 폴더', 'icon_circle.png');
    const r = dropin(path.join(f.src, '빨간 원.png'), out);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.summary, { out, src: path.join(f.src, '빨간 원.png'), srcSize: [256, 256], size: [128, 128], transparent: true });
    const probe = [
      'import sys', 'from PIL import Image', 'im = Image.open(sys.argv[1])', 'print(im.size, im.mode, im.getpixel((0, 0))[3])',
      'px = im.load()', 'edge = [px[x, y] for x in range(im.width) for y in range(im.height) if 0 < px[x, y][3] < 255]',
      'print(len(edge) > 0, min(p[0] for p in edge))',
    ].join('\n');
    const p = spawnSync(PY.cmd, ['-c', probe, out], { encoding: 'utf8' });
    assert.equal(p.status, 0, p.stderr);
    const [first, second] = p.stdout.trim().split(/\r?\n/);
    assert.equal(first, '(128, 128) RGBA 0');
    const [hasEdge, minRed] = second.split(' ');
    assert.equal(hasEdge, 'True');
    assert.ok(Number(minRed) >= 250, `edge red ${minRed}`);
    const wide = dropin(path.join(f.src, 'wide.png'), path.join(f.base, 'wide.tga'));
    assert.equal(wide.status, 0, wide.stderr);
    assert.deepEqual(wide.summary.size, [128, 64]);
    assert.equal(wide.summary.transparent, false);
  } finally {
    f.done();
  }
});

test('make_dropin: it refuses an existing output, the input itself, enlarging and a .jpg, writing nothing', { skip: noPillow }, () => {
  const f = dropinFixture();
  try {
    const circle = path.join(f.src, '빨간 원.png');
    const before = readFileSync(circle);
    const taken = path.join(f.base, 'taken.png');
    writeFileSync(taken, 'game file');
    let r = dropin(circle, taken);
    failed(r);
    assert.match(r.summary.error, /덮어쓰지 않습니다/);
    assert.equal(readFileSync(taken, 'utf8'), 'game file');
    failed(dropin(circle, circle));
    assert.deepEqual(readFileSync(circle), before);
    r = dropin(path.join(f.src, 'small.png'), path.join(f.base, 'small_128.png'));
    failed(r);
    assert.match(r.summary.error, /키우지 않습니다/);
    failed(dropin(circle, path.join(f.base, 'circle.jpg')));
    failed(dropin(circle, path.join(f.base, 'zero.png'), ['--size', '0']));
    assert.deepEqual(readdirSync(f.base).sort(), ['taken.png', '정본 이미지']);
    assert.deepEqual(readdirSync(f.src).sort(), ['small.png', 'wide.png', '빨간 원.png']);
  } finally {
    f.done();
  }
});

test('make_dropin: a missing input ends with the JSON error line, not a traceback', { skip: noPython }, () => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'am-art-drop-'));
  try {
    const r = dropin(path.join(base, '없는 그림.png'), path.join(base, 'out', 'x.png'));
    failed(r);
    assert.match(r.summary.error, /입력 이미지가 없습니다/);
    assert.deepEqual(readdirSync(base), []);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// The repository is public: company paths and page IDs live only in each PC's art.json. Placeholders such as
// `<adCodexRoot>` match none of these. New files are read from disk, so a file not yet in git is checked too.
const COMPANY = [
  ['drive-letter path', /(?<![A-Za-z0-9])[A-Za-z]:[\\/]/],
  ['Notion collection', /collection:\/\//],
  ['Notion URL', /notion\.(?:so|com)/i],
  ['32-digit hex ID', /\b[0-9a-f]{32}\b/i],
  ['UUID', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
  // A personal account must never be named (am-art:ad-execute asks the operator instead).
  ['mail address', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/],
];
// The README's generic examples (a placeholder user folder, the developer's own checkout), built so this file holds no hit.
const DRIVE = (rest) => `C${':'}${rest}`;
const KEPT = { 'README.md': [DRIVE('\\Users\\<이름>\\'), DRIVE('\\Projects\\am')] };
const companyHits = (text) => text.split('\n').flatMap((line, i) => COMPANY.filter(([, re]) => re.test(line)).map(([what]) => `${i + 1}: ${what}`));

test('art: no company value in the art plugin, its shared block, am-util git-sync, the docs or this test', () => {
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (e.name !== '__pycache__') walk(path.join(dir, e.name));
      } else files.push(path.join(dir, e.name));
    }
  };
  walk(path.join(REPO, 'art'));
  assert.ok(files.some((f) => f.endsWith('SKILL.md')) && files.some((f) => f.endsWith('make_compare.py')), 'the art folder is read');
  // The artists' git helper moved to am-util in am-art 0.1.4 and still reads art.json.
  walk(path.join(REPO, 'util', 'skills', 'git-sync'));
  assert.ok(files.some((f) => f.endsWith(path.join('util', 'skills', 'git-sync', 'SKILL.md'))), 'the util git-sync skill is read');
  for (const f of ['util/scripts/git-sync-settings.mjs', 'shared/art.md', 'README.md', 'README-ART.md', 'CHANGELOG.md', 'tests/art.test.mjs']) files.push(path.join(REPO, f));
  const found = files.flatMap((f) => {
    const rel = path.relative(REPO, f).split(path.sep).join('/');
    let text = readFileSync(f, 'utf8');
    for (const kept of KEPT[rel] ?? []) text = text.split(kept).join('');
    return companyHits(text).map((h) => `${rel}:${h}`);
  });
  assert.deepEqual(found, []);
  // The patterns themselves catch what they are for (each sample is built from pieces, so this file stays clean).
  const samples = [`D${':'}/git/x`, DRIVE('\\Spine'), `collection${':'}//x`, `www.notion${'.'}so/x`, 'a'.repeat(32), ['0e0c1a3b', '1111', '2222', '3333', '444455556666'].join('-'), `someone${'@'}example.com`];
  assert.equal(companyHits(samples.join('\n')).length, 7);
  assert.deepEqual(companyHits('file:///<encoded path> https://github.com <adCodexRoot>/_공통/ `codex plugin add am-art@am-workflow`'), []);
});

test('art settings: the command line prints Korean paths as UTF-8', () => {
  const c = config();
  try {
    const env = { ...process.env, CLAUDE_CONFIG_DIR: c.dir };
    assert.equal(spawnSync(process.execPath, [CLI, 'set', 'spineRoot', c.place], { env }).status, 0);
    const r = spawnSync(process.execPath, [CLI, 'get', 'spineRoot'], { env });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.toString('utf8'), `${c.place}\n`);
  } finally {
    c.done();
  }
});
