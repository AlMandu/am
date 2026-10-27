---
name: log-compare
description: "아트 작업 이미지 여러 장을 한 화면에서 비교하는 HTML 을 만듭니다(원본을 가리키는 로컬 보기, 이미지를 파일 안에 넣은 공유용). ‘비교용 html 만들어’, ‘비교해서 볼수 있는 페이지’, ‘모아보기’, ‘한눈에 볼수 있게’, 비교 페이지 경로와 함께 ‘여기 넣어줘’·‘적용해줘’, ‘다른사람에게 보낼수 있게 만들어줘’, ‘공유용으로’, ‘별표한거 최종본 뭐야’ 라고 하면 씁니다. 원본 이미지와 손으로 만든 기존 페이지는 바꾸지 않습니다."
argument-hint: "[공유용] [페이지 이름 또는 기존 페이지 경로]"
model: sonnet
effort: medium
---

# am-art:log-compare

Argument: $ARGUMENTS

Build one HTML page that compares many images. Two modes: **로컬 보기** (`--mode local`: points at the original files, fast; a cell opens the original or copies its path) and **공유용** (`--mode share`: every image inside one HTML file, to send to someone, asked for as "다른사람에게 보낼수 있게").

<!-- am:shared:art:start -->
## Working with the owner
- Ask the owner with AskUserQuestion, one question at a time, as a pick from options; put your recommendation first and end its label with "(추천)".
- Show every result and evidence file one per line as a Markdown link: text is the absolute path as Windows writes it, target is its `file:///` URI with `/` separators and percent-encoded spaces and non-ASCII (`[<absolute path>](file:///<encoded path>)`).
- Read and write per-PC values only with the Bash tool through `node "${CLAUDE_PLUGIN_ROOT}/scripts/art-settings.mjs"` (`get <key>`, `get deployTools.<name>`, `set <key> <value>`, `show`); never write art.json any other way. A missing value (exit 3), unless the skill says otherwise: ask the owner for it, one at a time, and `set` it; when `set` fails, stop and report its line. Never write those values into any other file.
- When an owner request conflicts with the package documents, the settings copy or these rules, say where it conflicts and offer an alternative; never simply agree.
<!-- am:shared:art:end -->

## Parts
- Generator: `${CLAUDE_PLUGIN_ROOT}/scripts/make_compare.py`, run with art.json's `python`. Its docstring gives the two JSON formats; read it before writing either. Features: section → row → cell, cells per row, rows scroll sideways, a cell-size gauge, click to enlarge, a star per cell (grey ↔ yellow, 최종본) with a button that exports the starred list as text, overlay on/off buttons, real size (1:1, the rules' game display size), section tabs and the first section shown.
- Display rules: one `compare.json` per project, at the root of the repository the owner works in: `title`, `outDir`, `columns`, `gameSize`, `firstSection`, `overlays`.
- Image list: one manifest per page, `<outDir>/<page>.manifest.json`. Output: `<outDir>/<page>.html` for 로컬 보기 and `<outDir>/<page>.share.html` for 공유용, so one mode never replaces the other.

## Steps
1. Python: `get python`. Check Pillow once: `<python> -c "import PIL"`. Without it local mode still works; for share mode ask which environment to install it into (the art.json Python first) and install with `<python> -m pip install Pillow` only after the answer.
2. Rules: read `compare.json`. Missing: ask one at a time (output folder, how sections are split, cells per row, game display size) and write it.
3. Image list: a new page gets a new manifest; adding to an existing page adds entries to that page's manifest only. Check that every image path exists and list the missing ones.
4. Generate: `<python> "${CLAUDE_PLUGIN_ROOT}/scripts/make_compare.py" --rules <compare.json> --manifest <manifest> --mode local|share --out <html>`; share mode may add `--jpeg-long-edge N --jpeg-quality Q` (big opaque images become JPEG, transparent PNG stays as it is). The last output line is a JSON summary: report the size; when `over20MB` is true, ask one question with ways to shrink it (shorter long edge, lower quality, one page per section).
5. Browser check: with art.json's `browserSmoke` set (optional, never asked), run it on the page; otherwise take a Playwright screenshot when available. Confirm no image is broken. Say plainly when no browser check could run.
6. Answer with the page as a clickable path.

## Stars ("별표한거 최종본 뭐야")
Stars live in the viewer's browser only. Ask the owner to press "별표 목록 내보내기" and paste the list, then use it as the 최종본 list.

## Keep
- A share page never goes into a repository (the owner's rule: "공유 HTML은 올리지 마"). After writing it, run `git check-ignore -q <the share html path>` from its folder: exit 1 means it is not ignored, tell the owner; exit 128 means it is outside any repository, nothing to check.
- Never overwrite a page this generator did not make (it refuses by itself). The first run against a hand-made page writes a new file showing the same screen, for side-by-side comparison; change the old page only when the owner says so.
- Never change an original image; reduced copies exist only inside the HTML.
