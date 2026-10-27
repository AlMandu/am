---
name: log-resume
description: "아트 작업의 진행 지점·제작 규칙·자료 위치를 알맞은 파일에 기록하거나(기억), 오너 수정본과 원본의 차이를 재서 규칙으로 남기거나(학습), 기록을 찾아 어디까지 했는지 답합니다(회상). 아트 작업 중 ‘기억해둬’, ‘지금 작업 기억해둬’, ‘현재작업을 기억해둬’, ‘추가작업도 기억해둬’, ‘학습해’, ‘내가 수정한거 학습해’, ‘학습해 뒀어?’, ‘학습 내용 파기’, ‘어디까지 했어’, ‘어디까지 했냐’, ‘어제 작업한 캐릭터 어디까지 했어’, ‘이어서 작업 시작’, ‘그때 내가 뭐라고 명령했어’, ‘이전엔 뭐라고 명령했어’, ‘~ 기억해?’ 라고 하면 씁니다. 외부 자료 학습(예: ‘디지몬 카드 학습해’)은 대상이 아닙니다."
argument-hint: "[기억|학습|회상] [내용]"
model: opus
effort: high
---

# am-art:log-resume

Argument: $ARGUMENTS

Three modes, picked from what the owner said:
- **기억**: "지금 작업 기억해둬", "현재 캐릭터 제작 방식 기억해둬" → write it into the right file.
- **학습**: "내가 수정한거 학습해", "36,37 몸 내부 라인 두께를 수정했어. 측정해서 최소값으로 기억해둬" → measure how the owner's edit differs from the original and record it as a rule.
- **회상**: "어디까지 했어", "어제 시켜놓은 작업 어디까지 했어?", "활 무기를 2개씩 만드는데 이전엔 뭐라고 명령했어?", "이전에 만든 6자리 코드 기억해?" → find it in the records and answer.
Learning from outside material ("디지몬 카드 학습해") is not this skill's job.

<!-- am:shared:art:start -->
## Working with the owner
- Ask the owner with AskUserQuestion, one question at a time, as a pick from options; put your recommendation first and end its label with "(추천)".
- Show every result and evidence file one per line as a Markdown link: text is the absolute path as Windows writes it, target is its `file:///` URI with `/` separators and percent-encoded spaces and non-ASCII (`[<absolute path>](file:///<encoded path>)`).
- Read and write per-PC values only with the Bash tool through `node "${CLAUDE_PLUGIN_ROOT}/scripts/art-settings.mjs"` (`get <key>`, `get deployTools.<name>`, `set <key> <value>`, `show`); never write art.json any other way. A missing value (exit 3), unless the skill says otherwise: ask the owner for it, one at a time, and `set` it; when `set` fails, stop and report its line. Never write those values into any other file.
- When an owner request conflicts with the package documents, the settings copy or these rules, say where it conflicts and offer an alternative; never simply agree.
<!-- am:shared:art:end -->

## Where it goes (the most important rule)
Progress and past decisions go to the status ledger, rules go to the project documents, memory holds only facts such as where material lives.

| What | Where |
|---|---|
| Progress ("어디까지 했다", next step) | an AD package (under art.json's `adCodexRoot`): add a line to the target's `_상태.md`. Other projects (such as `spineRoot`): the project's status ledger file; with none, ask where and create it there |
| Production rules and numbers (foot 위치 고정, minimum line width, the design name '낙서체') | an AD package: the settings copy §5 (규격) or §7 (교훈). The Spine repository: the matching rule file such as `prompts/_rule_*.txt` |
| Where material lives, outside facts (a DB path, the Unity path) | Claude Code memory of the project (`~/.claude/projects/<project>/memory/`, in its own format) |

- Image generation instructions never go into Claude memory.
- Never edit an AD package's rule documents (`00`~`04`, `README.md`, `CLAUDE.md`, `AGENTS.md`).
- When the place is unclear, ask one question with the recommended place first.
- Before writing, show briefly "이 파일에 이 내용을 추가합니다" with the file. When the same content is already there, change that line instead of adding one, and show it as before → after.

## 학습
1. Find the original (the generated result) and the owner's edit. When the owner gives neither, guess from the most recently changed files and confirm.
2. Measure the difference in numbers, not impressions: position (dx, dy), size, line width (minimum and median), colour. Use a script.
3. Show the measurement table and ask "이 수치를 규칙으로 기록할까요?" as one question.
4. On approval, write it to the rule place of the table above.
5. "학습 내용 파기": first show the lines that would be removed (file and line), and remove them only after approval.

## 회상: search order
1. The recent lines of the status ledger (`_상태.md`) of the current folder.
2. `git log` and `git status` (uncommitted means in progress).
3. The newest documents of the package's feedback channel (file name sequence number plus the header's `작성:` time).
4. What the owner said: `~/.claude/history.jsonl` (filter by `project` and `timestamp`, then search keywords). For "뭐라고 명령했어", quote the original words exactly, with the date.
5. The detailed course: the session logs `~/.claude/projects/<project>/*.jsonl`.
6. The worker's side: `~/.codex/history.jsonl`.

Answer form: 마지막 완료 / 진행 중 / 오너 결정 대기 / 다음 추천, each with its evidence file as a clickable path. What cannot be found is "기록 없음"; never guess.
