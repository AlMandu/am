#!/usr/bin/env python3
"""am-art make_compare: builds one HTML page that compares many images side by side.

usage: make_compare.py --rules <compare.json> --manifest <manifest.json> --mode local|share --out <html>
                       [--jpeg-long-edge N] [--jpeg-quality Q]

compare.json (per project, display rules):
  {"title": str, "outDir": path (read by the skill, not here), "columns": int, "gameSize": {"width": px, "height": px}, "firstSection": str,
   "overlays": [{"name": str, "on": bool}]}
manifest.json (per page, the images):
  {"sections": [{"name": str, "rows": [{"title": str, "columns": int,
     "cells": [{"label": str, "image": path, "gameSize": {...},
                "overlays": {<overlay name>: [{"image": path, "x": %, "y": %, "w": %}]}}]}]}]}
Relative image paths are read against the manifest's folder.

local mode points at the original files (file:/// links, open and copy-path buttons); share mode puts every image inside
the page as a data URI: opaque images become JPEG (long edge and quality options), images with transparency stay PNG.
Share mode needs Pillow; local mode does not. Source images are only read. The page carries a generator mark, and an
existing file without that mark, or a path equal to an input, is never written. The last stdout line is a JSON summary.
"""
import argparse
import base64
import html
import io
import json
import os
import sys
import tempfile
from pathlib import Path

MARK = '<meta name="generator" content="am-art make_compare">'
SHARE_LIMIT = 20 * 1024 * 1024


class Fail(Exception):
    pass


def load_json(path, what):
    try:
        with open(path, encoding='utf-8-sig') as f:
            return json.load(f)
    except FileNotFoundError:
        raise Fail(f'{what} 파일이 없습니다: {path}')
    except (OSError, ValueError) as e:
        raise Fail(f'{what} 파일을 읽지 못했습니다: {path} ({e})')


def same_file(a, b):
    try:
        return os.path.normcase(os.path.realpath(a)) == os.path.normcase(os.path.realpath(b))
    except OSError:
        return False


def collect_images(manifest, base):
    """Every image path of the manifest (cells and overlays), resolved, in order."""
    out = []
    for section in manifest.get('sections', []):
        for row in section.get('rows', []):
            for cell in row.get('cells', []):
                if cell.get('image'):
                    out.append(resolve(cell['image'], base))
                for items in (cell.get('overlays') or {}).values():
                    for item in items:
                        if item.get('image'):
                            out.append(resolve(item['image'], base))
    return out


def resolve(p, base):
    path = Path(p)
    return str(path if path.is_absolute() else (base / path).resolve())


def encode_share(path, long_edge, quality, cache):
    if path in cache:
        return cache[path]
    from PIL import Image  # only share mode needs Pillow
    try:
        im = Image.open(path)
        im.load()
    except OSError as e:
        raise Fail(f'이미지를 읽지 못했습니다: {path} ({e})')
    with im:
        transparent = im.mode in ('RGBA', 'LA', 'PA') or (im.mode == 'P' and 'transparency' in im.info)
        if transparent:
            alpha = im.convert('RGBA').getchannel('A')
            transparent = alpha.getextrema()[0] < 255
        if transparent:
            with open(path, 'rb') as f:
                data = f.read()
            if data[:8] != b'\x89PNG\r\n\x1a\n':  # TGA, WebP and the like: browsers may not show them, so re-encode
                buf = io.BytesIO()
                im.save(buf, 'PNG')
                data = buf.getvalue()
            kind = 'image/png'
        else:
            rgb = im.convert('RGB')
            if long_edge and max(rgb.size) > long_edge:
                scale = long_edge / max(rgb.size)
                rgb = rgb.resize((max(1, round(rgb.width * scale)), max(1, round(rgb.height * scale))), Image.LANCZOS)
            buf = io.BytesIO()
            rgb.save(buf, 'JPEG', quality=quality, optimize=True)
            data = buf.getvalue()
            kind = 'image/jpeg'
    uri = f'data:{kind};base64,{base64.b64encode(data).decode("ascii")}'
    cache[path] = uri
    return uri


def build_data(rules, manifest, base, mode, long_edge, quality):
    missing = []
    cache = {}

    def src(p):
        full = resolve(p, base)
        if not os.path.isfile(full):
            if full not in missing:
                missing.append(full)
            return None, full
        if mode == 'share':
            return encode_share(full, long_edge, quality, cache), full
        return Path(full).as_uri(), full

    def count(v, where):
        try:
            n = int(v)
        except (TypeError, ValueError):
            n = 0
        if n < 1:
            raise Fail(f'{where} 의 칸 수는 1 이상의 정수여야 합니다 (지금 {v!r})')
        return n

    sections = []
    default_cols = count(rules.get('columns') or 3, '표시 규칙 columns')
    for section in manifest.get('sections', []):
        rows = []
        for row in section.get('rows', []):
            cells = []
            for cell in row.get('cells', []):
                url, full = src(cell['image']) if cell.get('image') else (None, '')
                overlays = {}
                for name, items in (cell.get('overlays') or {}).items():
                    overlays[name] = []
                    for item in items:
                        if not isinstance(item, dict) or not item.get('image'):
                            raise Fail(f'겹쳐 보기 {name!r} 항목에 image 가 없습니다 (칸 {cell.get("label", "")!r})')
                        o_url, o_full = src(item['image'])
                        if o_url:
                            overlays[name].append({'src': o_url, 'x': item.get('x', 0), 'y': item.get('y', 0), 'w': item.get('w', 30)})
                entry = {'label': cell.get('label', Path(full).name if full else ''), 'key': Path(full).name if full else '', 'src': url, 'overlays': overlays,
                         'gameSize': cell.get('gameSize') or rules.get('gameSize')}
                if mode == 'local':
                    entry['path'] = full
                cells.append(entry)
            cols = count(row['columns'], f'행 {row.get("title", "")!r}') if row.get('columns') is not None else default_cols
            rows.append({'title': row.get('title', ''), 'columns': cols, 'cells': cells})
        sections.append({'name': section.get('name', ''), 'rows': rows})
    names = [o['name'] for o in rules.get('overlays', [])]
    for s in sections:
        for r in s['rows']:
            for c in r['cells']:
                for n in c['overlays']:
                    if n not in names:
                        names.append(n)
    on = {o['name']: bool(o.get('on')) for o in rules.get('overlays', [])}
    page = {'title': rules.get('title') or '이미지 비교', 'mode': mode, 'firstSection': rules.get('firstSection'),
            'overlays': [{'name': n, 'on': on.get(n, False)} for n in names], 'sections': sections}
    return page, missing


STYLE = """
:root{--cell:240px;--bg:#1e1f22;--fg:#e8e8e8;--muted:#9aa0a6;--line:#3a3d42;--accent:#f5c518}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif}
header{position:sticky;top:0;z-index:5;background:var(--bg);border-bottom:1px solid var(--line);padding:8px 16px;display:flex;flex-wrap:wrap;gap:8px;align-items:center}
h1{font-size:16px;margin:0 12px 0 0}button{background:#2c2e33;color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:4px 10px;cursor:pointer}
button.on{border-color:var(--accent);color:var(--accent)}nav{display:flex;flex-wrap:wrap;gap:4px}
main{padding:12px 16px}section{display:none}section.show{display:block}h2{font-size:15px;margin:12px 0 4px;color:var(--muted)}
.row{display:grid;grid-auto-flow:column;grid-auto-columns:var(--cell);gap:8px;overflow-x:auto;padding-bottom:8px}
.row.wrap{grid-auto-flow:row;grid-template-columns:repeat(var(--cols),var(--cell));overflow-x:auto}
.cell{position:relative;background:#26282c;border:1px solid var(--line);border-radius:6px;padding:4px}
.frame{position:relative;cursor:zoom-in}.frame img.main{display:block;width:100%;height:auto}
.frame .ov{position:absolute;pointer-events:none;display:none}body.ov-on .frame .ov.on{display:block}
.real .frame img.main{width:auto;max-width:none}.real .row{grid-auto-columns:max-content}.real .row.wrap{grid-template-columns:repeat(var(--cols),max-content)}
.star{position:absolute;left:6px;top:6px;z-index:2;background:rgba(0,0,0,.5);border:none;font-size:18px;line-height:1;color:#777;padding:2px 4px}
.star.on{color:var(--accent)}.label{font-size:12px;color:var(--muted);word-break:break-all;margin-top:2px}
.tools{display:flex;gap:4px;margin-top:2px}.tools button{font-size:11px;padding:1px 6px}
.none{display:flex;align-items:center;justify-content:center;height:120px;color:#f28b82}
#box{position:fixed;inset:0;background:rgba(0,0,0,.85);display:none;align-items:center;justify-content:center;z-index:10;cursor:zoom-out}
#box.show{display:flex}#box img{max-width:96vw;max-height:94vh}
#out{position:fixed;right:16px;top:60px;width:min(520px,90vw);z-index:11;background:#2c2e33;border:1px solid var(--line);border-radius:8px;padding:8px;display:none}
#out.show{display:block}#out textarea{width:100%;height:240px;background:#1e1f22;color:var(--fg);border:1px solid var(--line)}
"""

SCRIPT = r"""
const page = JSON.parse(document.getElementById('data').textContent);
const KEY = 'am-art-stars:' + page.page;
const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) { return []; } };
const save = (list) => { try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (e) { /* stars last for this view only */ } };
let stars = new Set(load());
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const main = document.querySelector('main'), nav = document.querySelector('nav'), box = document.getElementById('box');
const tabs = [];
page.sections.forEach((s, si) => {
  const sec = el('section'); sec.dataset.i = si;
  s.rows.forEach((r, ri) => {
    if (r.title) sec.appendChild(el('h2', '', r.title));
    const row = el('div', 'row' + (r.cells.length > r.columns ? ' wrap' : '')); row.style.setProperty('--cols', r.columns);
    r.cells.forEach((c, ci) => {
      const id = [s.name, r.title, c.label, c.key].join(' / ');
      const cell = el('div', 'cell');
      const star = el('button', 'star' + (stars.has(id) ? ' on' : ''), '★'); star.title = '최종본 표시';
      star.onclick = () => { stars.has(id) ? stars.delete(id) : stars.add(id); star.classList.toggle('on'); save([...stars]); };
      cell.appendChild(star);
      const frame = el('div', 'frame');
      if (c.src) {
        const img = el('img', 'main'); img.src = c.src; img.alt = c.label; img.loading = 'lazy';
        if (c.gameSize && c.gameSize.width) img.dataset.real = c.gameSize.width;
        frame.appendChild(img);
        frame.onclick = () => { box.querySelector('img').src = c.src; box.classList.add('show'); };
      } else frame.appendChild(el('div', 'none', '이미지 없음'));
      Object.entries(c.overlays).forEach(([name, items]) => items.forEach((o) => {
        const ov = el('img', 'ov'); ov.src = o.src; ov.dataset.name = name;
        ov.style.left = o.x + '%'; ov.style.top = o.y + '%'; ov.style.width = o.w + '%'; frame.appendChild(ov);
      }));
      cell.appendChild(frame);
      cell.appendChild(el('div', 'label', c.label));
      if (page.mode === 'local' && c.path) {
        const tools = el('div', 'tools');
        const open = el('button', '', '원본 열기'); open.onclick = () => window.open(c.src, '_blank');
        const copy = el('button', '', '경로 복사');
        copy.onclick = () => navigator.clipboard.writeText(c.path).then(() => { copy.textContent = '복사됨'; }, () => prompt('경로', c.path));
        tools.append(open, copy); cell.appendChild(tools);
      }
      cell.dataset.id = id; cell.dataset.path = c.path || c.label;
      row.appendChild(cell);
    });
    sec.appendChild(row);
  });
  main.appendChild(sec);
  const tab = el('button', '', s.name || ('섹션 ' + (si + 1))); tab.onclick = () => show(si); nav.appendChild(tab); tabs.push(tab);
});
function show(i) {
  document.querySelectorAll('section').forEach((s) => s.classList.toggle('show', +s.dataset.i === i));
  tabs.forEach((t, ti) => t.classList.toggle('on', ti === i));
}
const first = page.sections.findIndex((s) => s.name === page.firstSection);
show(first >= 0 ? first : 0);
document.getElementById('size').oninput = (e) => document.documentElement.style.setProperty('--cell', e.target.value + 'px');
document.getElementById('real').onclick = (e) => {
  const on = document.body.classList.toggle('real'); e.target.classList.toggle('on', on);
  document.querySelectorAll('img.main').forEach((img) => { img.style.width = on && img.dataset.real ? img.dataset.real + 'px' : ''; });
};
const tools = document.getElementById('overlays');
page.overlays.forEach((o) => {
  const b = el('button', '', o.name + ' 켜기/끄기');
  const apply = (on) => { b.classList.toggle('on', on); document.querySelectorAll('.ov').forEach((v) => { if (v.dataset.name === o.name) v.classList.toggle('on', on); }); };
  let on = o.on; b.onclick = () => apply(on = !on); tools.appendChild(b); apply(on);
});
document.body.classList.add('ov-on');
box.onclick = () => box.classList.remove('show');
document.getElementById('export').onclick = () => {
  const lines = [...document.querySelectorAll('.cell')].filter((c) => stars.has(c.dataset.id)).map((c) => c.dataset.id + ' | ' + c.dataset.path);
  const out = document.getElementById('out'); out.querySelector('textarea').value = lines.length ? lines.join('\n') : '(별표한 칸 없음)';
  out.classList.add('show');
};
document.getElementById('close').onclick = () => document.getElementById('out').classList.remove('show');
document.getElementById('copyout').onclick = () => navigator.clipboard.writeText(document.querySelector('#out textarea').value);
"""


def render(page):
    # Every '<' escaped, so no label can close or reopen the script block ('<!--', '</script').
    data = json.dumps(page, ensure_ascii=False).replace('<', '\\u003c')
    title = html.escape(page['title'])
    mode = '공유용' if page['mode'] == 'share' else '로컬 보기'
    return f"""<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
{MARK}
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title><style>{STYLE}</style></head>
<body><header><h1>{title} <small style="color:var(--muted)">({mode})</small></h1><nav></nav>
<label>칸 크기 <input id="size" type="range" min="80" max="800" value="240"></label>
<button id="real">실사용 크기(1:1)</button><span id="overlays"></span>
<button id="export">별표 목록 내보내기</button></header>
<main></main><div id="box"><img alt=""></div>
<div id="out"><textarea readonly></textarea><button id="copyout">복사</button> <button id="close">닫기</button></div>
<script type="application/json" id="data">{data}</script>
<script>{SCRIPT}</script></body></html>
"""


def write_out(out, text, inputs):
    out = os.path.abspath(out)
    for p in inputs:
        if same_file(out, p):
            raise Fail(f'출력 경로가 입력 파일과 같습니다: {out}')
    if os.path.exists(out):
        try:
            with open(out, encoding='utf-8', errors='replace') as f:
                head = f.read(4096)
        except OSError as e:
            raise Fail(f'기존 출력 파일을 읽지 못했습니다: {out} ({e})')
        if MARK not in head:
            raise Fail(f'이 생성기가 만들지 않은 기존 파일이라 덮어쓰지 않습니다: {out}')
    folder = os.path.dirname(out)
    os.makedirs(folder, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix='.make_compare-', suffix='.tmp', dir=folder)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8', newline='\n') as f:
            f.write(text)
        os.replace(temp, out)
    except BaseException:
        if os.path.exists(temp):
            os.remove(temp)
        raise
    return out


def main(argv=None):
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8')
        except (AttributeError, ValueError):
            pass
    ap = argparse.ArgumentParser(prog='make_compare.py')
    ap.add_argument('--rules', required=True)
    ap.add_argument('--manifest', required=True)
    ap.add_argument('--mode', choices=['local', 'share'], required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--jpeg-long-edge', type=int, default=2048)
    ap.add_argument('--jpeg-quality', type=int, default=85)
    args = ap.parse_args(argv)
    try:
        if args.mode == 'share':
            try:
                import PIL  # noqa: F401
            except ImportError:
                raise Fail('공유용 모드에는 Pillow 가 필요합니다 (이 파이썬에 PIL 이 없습니다). 로컬 보기는 Pillow 없이 됩니다')
        if not 1 <= args.jpeg_quality <= 95:
            raise Fail('--jpeg-quality 는 1~95 사이여야 합니다')
        rules = load_json(args.rules, '표시 규칙')
        manifest = load_json(args.manifest, '이미지 목록')
        if not isinstance(rules, dict) or not isinstance(manifest, dict) or not isinstance(manifest.get('sections'), list):
            raise Fail('표시 규칙은 객체, 이미지 목록은 sections 배열을 가진 객체여야 합니다')
        base = Path(os.path.abspath(args.manifest)).parent
        page, missing = build_data(rules, manifest, base, args.mode, args.jpeg_long_edge, args.jpeg_quality)
        inputs = collect_images(manifest, base) + [os.path.abspath(args.rules), os.path.abspath(args.manifest)]
        page['page'] = os.path.basename(os.path.abspath(args.out))
        out = write_out(args.out, render(page), inputs)
    except Fail as e:
        print(f'오류: {e}', file=sys.stderr)
        print(json.dumps({'error': str(e)}, ensure_ascii=False))
        return 1
    size = os.path.getsize(out)
    for p in missing:
        print(f'없는 이미지: {p}')
    print(json.dumps({'out': out, 'bytes': size, 'missing': missing, 'over20MB': size > SHARE_LIMIT}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
