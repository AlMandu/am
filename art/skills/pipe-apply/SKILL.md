---
name: pipe-apply
description: "아트 작업에서 확정된 이미지(정본)를 파치 → Spine 슬롯 → Unity 까지 반영하고, 세 곳 중 빠진 곳이 없는지 실제 파일로 확인합니다. ‘파치에 적용해’, ‘파치에도 적용’, ‘파치·스파인·유니티 반영’, ‘스파인>유니티 익스포트’, ‘유니티 익스포트’, ‘유니티에 적용해봐’, ‘유니티 반영’, ‘게임 반영 승인’, ‘6종 스파인·파치 교체 승인’, ‘작업된게 있으면 파치에 적용해’, ‘무기 유니티 적용되어 있어?’ 라고 하면 씁니다. 점검 인자를 주면 파일을 바꾸지 않습니다. 이미지 생성·검수·커밋·업로드는 하지 않습니다."
argument-hint: "[무기|캐릭터|펫] [슬롯 번호…] [파치만|스파인까지|유니티까지] [점검]"
model: opus
effort: medium
---

# am-art:pipe-apply

Argument: $ARGUMENTS

Apply canonical images to 파치 → Spine slots → Unity and prove none of the three was missed. This skill exists because of what the owner kept pointing out: "파치에도 적용해야지" (파치 was skipped while Spine and Unity were done), "파치에서 적용된게 안보여 확인해봐" (the file changed but the screen did not), "스파인>유니티 익스포트. 업로드는 하지마" (applying and uploading are separate).

Not this skill's job: generating or reviewing images (the am-art:ad-review skill), commit and push (only when the owner asks separately), deciding what is canonical.

<!-- am:shared:art:start -->
## Working with the owner
- Ask the owner with AskUserQuestion, one question at a time, as a pick from options; put your recommendation first and end its label with "(추천)".
- Show every result and evidence file one per line as a Markdown link: text is the absolute path as Windows writes it, target is its `file:///` URI with `/` separators and percent-encoded spaces and non-ASCII (`[<absolute path>](file:///<encoded path>)`).
- Read and write per-PC values only with the Bash tool through `node "${CLAUDE_PLUGIN_ROOT}/scripts/art-settings.mjs"` (`get <key>`, `get deployTools.<name>`, `set <key> <value>`, `show`); never write art.json any other way. A missing value (exit 3), unless the skill says otherwise: ask the owner for it, one at a time, and `set` it; when `set` fails, stop and report its line. Never write those values into any other file.
- When an owner request conflicts with the package documents, the settings copy or these rules, say where it conflicts and offer an alternative; never simply agree.
<!-- am:shared:art:end -->

## Existing tools: wrap them, never reimplement
The tools are per-PC values in art.json under `deployTools.<name>`, the Python that runs them under `python`, the Spine repository under `spineRoot`, the AD packages under `adCodexRoot`.
- `deployTools.무기`: weapons. Slot → 파치 key comes from the package's `참조/무기규칙/weapon_slots.json`. Without arguments it only checks; `--apply`, `--unity`, `--sub <name>`.
- `deployTools.캐릭터`: costumes (7 parts, the `data/queue.yaml` preview swap, `--line <n>`).
- `deployTools.spine-unity`: Spine → Unity export with atlas checks; `--apply` backs up and overwrites.
- `deployTools.펫`: pets.
- A kind with no `deployTools` entry (background, boss, icon and the like): do not ask for one and do not touch files by hand; report "반영 도구 없음" for it. A tool is added only when the owner names its script: `set deployTools.<name> <path>`.
Before choosing arguments, read each script's docstring. Never hard-code paths or Spine source file names (they change between versions); use the script's defaults. Confirm from the docstring which option runs without changing files; when you cannot find one, ask before running it at all.

## Arguments
Kind (무기/캐릭터/펫), slot numbers, scope (`파치만` / `스파인까지` / `유니티까지`; none means all three). `점검`: a check only, steps 1-2 and the step 5 table, with no file changed (no `--apply`, no `--unity`, no ledger line).

## Steps
1. Targets: without slots, "작업된 것" means slots whose package `_상태.md` says `통과` or `채택·이관` without a later `교체완료`. Show the list, then start.
2. Pre-check:
   - `git status` in `spineRoot`: stop and ask when `.spine` files or `spine/images` hold uncommitted changes from another session (the owner often warns "다른 세션 병렬작업 주의").
   - A character in the test category never goes into Spine (owner rule: "테스트 카테고리에 들어가는 캐릭터는 spine에 적용하지 마"). Refuse it and say so.
   - Run each tool in its check mode first and take the list of files it would change.
3. Authority: when a tool's docstring says the owner delegated it to AD up to Unity ("★ 오너 … 유니티까지 전결"), go ahead and report afterwards. Any other target, or a canonical replacement mixed in: ask once.
4. Apply: `--apply`, then (scope up to Unity) `--unity`. When several batches are applied together, run Unity once at the end.
5. Missing check (the core): for each slot, check the three places on the actual files and show a table.
   - 파치: the hash of the png and preview 파치 reads equals the canonical file. If the 파치 server is running, reload and confirm it shows on screen (suggest a server restart when needed).
   - Spine: the slot file hash under `spine/images/<part>/...` equals the canonical file.
   - Unity: the export check passed and the atlas holds that skin's image.
   With any empty cell, never say "완료".
6. Record: check that the script wrote a `교체완료` line in `_상태.md`; on a path where it does not, add one line yourself.
7. Report: the three-place table, the backup folder, the changed files (clickable paths) and "되돌리려면 이 백업에서 복원". Do not commit or upload; ask "커밋할까요?" as one question. Commits follow the target repository's own branch and merge rules.

## Rollback
When the owner asks for a rollback, first show the files to restore (backup path → original path), and restore only after approval.

## Never
Edit canonical images; apply a kind with no tool by hand; upload; commit without the owner's request; put a test-category character into Spine.
