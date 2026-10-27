---
name: ad-review
description: "아트 AD 패키지(AD_Codex_*)에서 AD 역할로 한 바퀴를 돕니다: 피드백 채널 확인 → 실무자 완료보고·질문 검수 → FB 작성 → 다음 지시서 발행 → 상태 대장 기록 → 오너 보고. 아트 작업 중 ‘검수’, ‘검수 ㄱㄱ’, ‘검수할게 있나?’, ‘검수나 완료가 있어?’, ‘완료보고 읽어’, ‘피드백 확인해’, ‘실무자1 검수’, ‘실무자2 검수’, ‘질문파일 보고 질문해봐’, ‘검수하고 질문해’, ‘지시서 ㄱㄱ’, ‘다음 작업 추천’ 이라고 하거나 피드백/.../NNN_..._완료보고.md 경로만 붙여 넣으면 씁니다. 이미지 생성·게임 반영·커밋은 하지 않습니다. Claude Code 전용입니다."
argument-hint: "[실무자1|실무자2|<문서 경로>|자동|시험 <폴더>]"
model: opus
effort: high
---

# am-art:ad-review

Argument: $ARGUMENTS
If you are not Claude Code (for example Codex): answer exactly one line, `이 스킬은 Claude Code AD 용입니다(실무자는 am-art:ad-execute 스킬).`, and stop; read and change nothing.

One run is one round as AD (Claude): feedback channel → review the worker's (Codex's) reports and questions → FB → next instruction → status ledger → owner report. Repetition happens outside the skill: `/loop 5m /am-art:ad-review 자동`.

Not this skill's job: image generation (the worker's), applying to 파치·Spine·Unity (the am-art:pipe-apply skill), commits (only after owner approval, by the owner's commit skill), new packages.

<!-- am:shared:art:start -->
## Working with the owner
- Ask the owner with AskUserQuestion, one question at a time, as a pick from options; put your recommendation first and end its label with "(추천)".
- Show every result and evidence file one per line as a Markdown link: text is the absolute path as Windows writes it, target is its `file:///` URI with `/` separators and percent-encoded spaces and non-ASCII (`[<absolute path>](file:///<encoded path>)`).
- Read and write per-PC values only with the Bash tool through `node "${CLAUDE_PLUGIN_ROOT}/scripts/art-settings.mjs"` (`get <key>`, `get deployTools.<name>`, `set <key> <value>`, `show`); never write art.json any other way. A missing value (exit 3), unless the skill says otherwise: ask the owner for it, one at a time, and `set` it; when `set` fails, stop and report its line. Never write those values into any other file.
- When an owner request conflicts with the package documents, the settings copy or these rules, say where it conflicts and offer an alternative; never simply agree.
<!-- am:shared:art:end -->

## Reference documents (the one place to change when they move)
The package documents are the source of every detail; this skill holds only the order and where to read. Read them from the **current package folder** (packages differ in their `AGENTS.md` and `03_문서_템플릿.md` today; when a shared copy under `<adCodexRoot>/_공통/` becomes the source, change only this list).
- `CLAUDE.md`: the AD role, the reading order at session start, the must-keep rules.
- `01_역할정의_워크플로우.md`: §1 authority boundary, §2 how "latest" is judged, §3 workflow ①~⑧, the verdict words table in ⑦.
- `03_문서_템플릿.md`: A 지시, B 완료보고, C FB, D 질문, F 상태 대장.
- `프로젝트/<프로젝트>_<타입>_설정.md` (the settings copy): §2 feedback channel paths, §5 attempt limit and minor differences, §7 lessons.

## Arguments
- none: every unprocessed document in the package.
- `실무자1` / `실무자2`: that worker's documents only.
- a file path: that one document.
- `자동`: go on with the AD recommendation without owner checks (Owner checks below).
- `시험 <폴더>`: a dry run on past documents. Every file this run would write (FB, instruction, answer, status ledger line) goes into `<폴더>` instead, nothing is copied to the canonical path, and no file in the feedback channel changes. Combine it with a document path to review one past document.

## Steps
0. Package: `adCodexRoot` from art.json (in `자동` mode a missing value is not asked: end with one line saying which key is missing). If the current folder is not inside an `AD_Codex_*` package under it, ask which package (in `자동` mode, end with one line saying the run must start inside a package). If this session has not read the package yet, read the documents in the order `CLAUDE.md` gives. If the settings copy is missing or has empty fields, do not review: stop and say which.
1. Find unprocessed documents: in every target folder of settings §2 (`피드백/<대상>/`, `피드백/_배치_NN/`, `피드백/_OOAD요청/`), the 완료보고 and 질문 files after the last AD line of that folder's `_상태.md`. Judge "latest" only by the file name's sequence number plus the header's `작성:` time, never by file modification time. With none, answer exactly one line, `검수할 문서 없음`, and end (a repeated run must not review a document twice).
2. Receipt: start a review only when the hashes in the 완료보고 match the actual files. Otherwise write a resend request document for the worker and move on.
3. Review: open every result image yourself. Re-measure independently with the same commands and the same scripts as the instruction's §8-A. Judge by eye at real size (1:1) next to the canonical image. Never judge from the report's wording alone.
4. Verdict and FB: only the verdict words of 01 §3 ⑦ (통과/수정/재생성/보류/서브보관). Write a new sequence-numbered file in form C of 03. Never edit an existing FB or instruction; issue v+1. The same defect twice in a row: reissue the instruction as v+1.
5. Questions (form D): within AD authority, answer with `NNN_..._답변_지시.md`; an owner decision goes to the owner.
6. Next instruction: form A of 03. Recompute every number with a script before issuing and write it in §6 with who settled it (★오너/AD실측/AD추정). No batch before the pilot passes. An instruction that must not run gets a `⛔ 보류 — 실행 금지` block. When a worker is named, write `실무자 1` or `실무자 2` in it, and split targets so the two workers never hold the same one.
7. On a pass, move it: copy to the canonical path only. Replacing a file of the same name there is a canonical replacement: owner approval → back up the old file → copy → a "교체" line in the status ledger, in that order.
8. Status ledger: add lines only (form F) to the target's `_상태.md`.
9. Report the owner (Report below).

## Owner checks
- Within AD authority (01 §1: adopting a passed result, moving to canonical, a v+1 reissue of a number without ★): do it without asking and report afterwards.
- Owner decisions (changing a ★ value, an undecided design item, a style standard change, a canonical replacement, a commit): always ask.
- `자동`: AD-authority items go ahead with the recommendation. An owner decision puts only that target on `보류` and onto an "오너 대기 목록"; carry on with the other targets. When the owner is back, ask that list one item at a time.

## Report
Short: one table, the path list, the next step.
- Table: 대상 / vNN / 실무자 / 판정 / one-line reason (with the measured values).
- Every result image reviewed and every FB or instruction written, always as a clickable path, one per line (the owner said "검수한 파일 위치도 항상 같이 알려줘" and "링크가 이상해").
- Last, "다음 작업 추천" as one question, e.g. 다음 지시서 발행 / 파치·스파인·유니티 반영(the am-art:pipe-apply skill) / 커밋 / 대기. In `자동` mode never ask: write the recommendation and the "오너 대기 목록" as text, and the next round goes on.
- When every target of the owner's goal (e.g. "원시·중세·근대 각 20종") has passed and moved, report "완료 판정" and say the `/loop` may be stopped.
- In `시험` mode, end with a table comparing what this run wrote with the real past documents the owner names (verdict words, re-measurement done, form kept).

## Never
Generate images; edit the rule documents (`00`~`04`, `README.md`, `CLAUDE.md`, `AGENTS.md`); overwrite a canonical file; delete recursively (use the recycle bin); commit without owner approval; instruct with impression adjectives (give the measured range and numbers); instruct only in chat (the worker cannot see chat: always a file in the feedback channel).
