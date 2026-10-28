#!/usr/bin/env python3
"""am-art make_dropin: makes one smaller copy of an image for the game (a game drop-in).

usage: make_dropin.py --src <image> --out <png|tga> [--size N]   (N defaults to 128)

The copy keeps the aspect ratio with its long edge at N pixels. It is shrunk in premultiplied alpha, so transparent
edges do not turn dark. An image smaller than N is never enlarged (an error), one of exactly N is saved as it is.
Only a new file is written: an existing output, or an output equal to the input, is refused and nothing is written;
the input is only read. The output folder is made when missing. Needs Pillow. The last stdout line is a JSON summary
({"out", "src", "srcSize", "size", "transparent"} or {"error"}).
"""
import argparse
import io
import json
import os
import sys

FORMATS = {'.png': 'PNG', '.tga': 'TGA'}


class Fail(Exception):
    pass


def same_file(a, b):
    try:
        return os.path.normcase(os.path.realpath(a)) == os.path.normcase(os.path.realpath(b))
    except OSError:
        return False


def target_size(w, h, n):
    """(w, h) with the long edge at n, keeping the ratio (each side at least 1)."""
    if w >= h:
        return n, max(1, round(h * n / w))
    return max(1, round(w * n / h)), n


def shrink(src, out, n):
    fmt = FORMATS.get(os.path.splitext(out)[1].lower())
    if not fmt:
        raise Fail(f'출력 파일은 .png 또는 .tga 여야 합니다: {out}')
    if n < 1:
        raise Fail(f'--size 는 1 이상이어야 합니다 (지금 {n})')
    if same_file(out, src):
        raise Fail(f'출력 경로가 입력 파일과 같습니다: {out}')
    if os.path.lexists(out):
        raise Fail(f'출력 파일이 이미 있어 덮어쓰지 않습니다: {out}')
    if not os.path.isfile(src):
        raise Fail(f'입력 이미지가 없습니다: {src}')
    try:
        from PIL import Image
    except ImportError:
        raise Fail('Pillow 가 필요합니다 (이 파이썬에 PIL 이 없습니다)')
    try:
        with Image.open(src) as im:
            im.load()
            rgba = im.convert('RGBA')
    except FileNotFoundError:
        raise Fail(f'입력 이미지가 없습니다: {src}')
    except (OSError, ValueError) as e:
        raise Fail(f'입력 이미지를 읽지 못했습니다: {src} ({e})')
    w, h = rgba.size
    if max(w, h) < n:
        raise Fail(f'원본({w}x{h})이 목표 크기 {n} 보다 작아 키우지 않습니다: {src}')
    if max(w, h) == n:
        result = rgba
    else:
        result = rgba.convert('RGBa').resize(target_size(w, h, n), Image.LANCZOS).convert('RGBA')
    buf = io.BytesIO()
    result.save(buf, fmt)
    write_new(out, buf.getvalue())
    low, _ = result.getchannel('A').getextrema()
    return {'out': out, 'src': src, 'srcSize': [w, h], 'size': list(result.size), 'transparent': low < 255}


def write_new(out, data):
    """Creates `out` with `data`; never replaces a file, and removes only what it made on failure."""
    made = []
    folder = os.path.dirname(out)
    while folder and not os.path.isdir(folder):
        made.append(folder)
        folder = os.path.dirname(folder)

    def drop_made():
        for d in made:
            try:
                os.rmdir(d)
            except OSError:
                pass

    try:
        for d in reversed(made):
            os.mkdir(d)
    except OSError as e:
        drop_made()
        raise Fail(f'출력 폴더를 만들지 못했습니다: {os.path.dirname(out)} ({e})')
    try:
        f = open(out, 'xb')
    except FileExistsError:
        drop_made()
        raise Fail(f'출력 파일이 이미 있어 덮어쓰지 않습니다: {out}')
    except OSError as e:
        drop_made()
        raise Fail(f'출력 파일을 만들지 못했습니다: {out} ({e})')
    try:
        with f:
            f.write(data)
    except BaseException as e:
        try:
            os.remove(out)
        except OSError:
            pass
        drop_made()
        if isinstance(e, OSError):
            raise Fail(f'출력 파일을 쓰지 못했습니다: {out} ({e})')
        raise


def main(argv=None):
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8')
        except (AttributeError, ValueError):
            pass
    ap = argparse.ArgumentParser(prog='make_dropin.py')
    ap.add_argument('--src', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--size', type=int, default=128)
    args = ap.parse_args(argv)
    try:
        summary = shrink(os.path.abspath(args.src), os.path.abspath(args.out), args.size)
    except Fail as e:
        print(f'오류: {e}', file=sys.stderr)
        print(json.dumps({'error': str(e)}, ensure_ascii=False))
        return 1
    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
