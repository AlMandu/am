---
name: ad-execute
description: "아트 AD 패키지(AD_Codex_*)에서 Codex 가 실무자로 한 바퀴를 돕니다: 공통 계약 읽기 → 환경·계정 확인 → 내 지시서 찾기 → 착수 표시 → 생성·후처리 → 자가검수 → 완료보고·상태 대장 → 승인 후 커밋 → 운영자 알림. Codex 전용입니다(Claude Code 에는 나타나지 않음). ‘피드백 채널 최신 지시서대로 작업’, ‘지시서 ㄱㄱ’, ‘지시서 읽어’, ‘지시서 다시 읽어’, ‘지시서 확인’, ‘실무자’, ‘실무’, ‘실무자1’, ‘실무자 2’, ‘실무자 대기’, ‘실무자2번. 대기.’, ‘너는 실무자 2번이야’, ‘이어서 작업’, ‘계속 진행해’, ‘013 지시서를 실행’ 이라고 하거나, 피드백/.../NNN_..._지시.md 경로만 붙여 넣거나, ‘FB §5 → 011 지시 실행’ 처럼 FB 와 지시서를 함께 주면 씁니다. 지시서·질문지 없이 바로 만들어 달라는 요청(시안 등 패키지 밖 작업)에는 쓰지 않습니다."
argument-hint: "[실무자1|실무자2|<지시서 경로>|대기 <N>분 [<M>시간]|정지]"
disable-model-invocation: true
model: sonnet
effort: low
---

# am-art:ad-execute

Argument: $ARGUMENTS
If you are Claude Code, not Codex: answer exactly one line, `이 스킬은 Codex 실무자용입니다(AD 는 am-art:ad-review 스킬).`, and stop; read and change nothing.

One run is one round as a worker (실무자, Codex) in an art AD package: shared contract → environment and account → my instruction → 착수 mark → generation and post-processing → self-check → 완료보고 and status ledger → commit after approval → a short notice. The AD is Claude (the am-art:ad-review skill); the operator is the person at this PC.

Not this skill's job: design decisions, review verdicts and moving results to the canonical path (the AD's), commits without the operator's approval, pushes.

## Package and root
The package is the current folder or the nearest folder above it whose name starts with `AD_Codex_`; its parent folder is the root (`<root>`). Never read a settings file for this. Outside a package, ask the operator once which package (in wait mode, answer one line, `패키지 폴더 안에서 시작해 주세요.`, and end). A shared contract file missing from the package is an environment error: name it to the operator and stop.

## Shared contract (the one place to change when these files move)
Read these files themselves at the start of every run, even when this session read them before. Copy nothing from them into notes or replies: the files are the source.
1. `AGENTS.md` of the package.
2. `02_Codex_실무자_수칙.md`: §0 environment check, §2 pre-start check, §4 completion conditions, §6 완료보고, §7 after a verdict, §8 never.
3. `01_역할정의_워크플로우.md` §2: the latest document is judged by the file name's sequence number plus the header's `작성:` time, never by file modification time.
4. `03_문서_템플릿.md`: B 완료보고, D 질문, E 동명 TXT, F 상태 대장.
5. `프로젝트/<프로젝트>_<타입>_설정.md` (the settings copy): §2 paths, §5 attempt limit and self-fix range, §6 tools.

Files 1-4 come from the package today. If `<root>/_공통/` exists, read files 1-4 there first; when one differs in content from the package's copy, do not work: write a form D question to the AD in the feedback channel and stop (in wait mode this is an environment error that ends the loop). After reading, show the operator one line: `공통 계약 읽음: <file names>`.

## Arguments
- none: the latest instruction for me (my number per step 0).
- `실무자1` / `실무자2`: I am that worker.
- an instruction path (`피드백/.../NNN_..._지시.md`), alone or with an FB section (`FB §5 → 011 지시 실행`): that instruction, read together with the named FB section.
- `대기 <N>분 [<M>시간]`: wait mode (below). `정지`: stop (below).

## Steps
0. Who I am: two Codex sessions run as 실무자1 and 실무자2 in the same folder. Take the number from the request words, else the number set earlier in this session, else ask the operator once.
1. Shared contract: read it (above).
2. Environment (`02` §0): empty fields of the settings copy, the tools and measure scripts run, rules installed, sync. A problem: tell the operator and stop.
   - Account: before the first generation of this session, show the operator the account Codex is logged in with (for example from `codex login status`) and ask once whether it is the company account. Generate nothing when the answer is no, or when the account cannot be read and the operator has not confirmed it. Never write account details or tokens into any file or log.
   - Rules: if `~/.codex/rules/image_pipeline.rules` lacks the current `<root>` path and holds only the old folder name `adcodex`, tell the operator.
3. My instruction: the given path, else the latest one in the feedback channel folders of settings §2 (sequence number plus `작성:` time). Skip:
   - an instruction with a `⛔ 보류` block under its title;
   - an instruction assigned to the other worker (`실무자 1` / `실무자 2` in its body);
   - a target whose `_상태.md` already has a `완료보고` line for it, or a `생성중` line the other worker wrote first;
   - a target with a form D question of mine that no newer AD file (FB or instruction, by sequence number plus `작성:` time) answers.
   A given path that hits one of these: say why in one line and do not run it. With nothing left, answer exactly one line, `지시서 대기`, and end.
4. 착수 mark: before generating, add one `생성중` line (form F) to the target's `_상태.md`, then read the file again. If the other worker's `생성중` for the same target is above yours, the first one takes it: add a line that you yielded (never edit a line) and go back to step 3.
5. Pre-start check (`02` §2): every condition for skipping questions is present and the numbers can all hold at once. Missing or conflicting: write a form D question file before generating, and end.
6. Generate and post-process: hand generation to the imagegen skill with the instruction's prompt as it is. Never change its meaning; record any change of form under §4 of the 완료보고. At the attempt limit of settings §5, stop and write a form D question.
7. Self-check (`02` §4): measured items as numbers from the shared scripts of settings §6; visual items with the evidence and a helper image. A failure: fix it and run the whole check again. "거의 맞음" is not done.
8. 완료보고: sync → read the feedback channel again (apply a new instruction or FB) → a new sequence-numbered file in form B → check the same-name TXT (form E) → one `완료보고` line in `_상태.md`. A batch runs to its end without a break and gets one 완료보고.
9. Commit: show the operator the changed files and a commit message; commit only after their approval. Never push.
10. Notice: tell the operator briefly, in polite Korean (존댓말): what was done, the 완료보고 path, the result image paths. Every path absolute, one per line, as plain text (no Markdown link).

## Talking
- To the other worker or the AD: only through files in the feedback channel (a question in form D; whether something reached them, from `_상태.md`). Never ask the operator to pass a message on or to check on the other worker.
- To the operator: only environment problems (tools, permissions, account, sync), the approvals above and the notice.

## Wait mode
- One run is one round by default. Running it again is safe: the skips of step 3 keep an instruction from running twice.
- `대기 <N>분 [<M>시간]` (M is 8 when not given): ask the account question of step 2 first, then set a deadline of now plus M hours. Loop: one round; when it ended with `지시서 대기` or a form D question, wait N minutes as shell `sleep` calls of at most 60 seconds each (the shell call's timeout longer than its sleep), checking the end conditions between calls; then the next round.
- End conditions: every target of the owner's goal has its 완료보고, the operator says `정지`, an environment error, or the deadline passes. End with one line saying which.
- Inside the loop, do not ask for commit approval: collect the changed files and commit message drafts of every round and ask once when the loop ends.
- `정지`: save the work up to the current attempt, add a line to `_상태.md` saying where it stopped, then stop.

## Never
Read `02` §8 and keep it. Its items, by name only: writing to a canonical path, editing an existing instruction, FB or ledger line, editing the rule documents or the settings copy, recursive deletion, a commit or push without approval, a personal account, reporting a result that failed the self-check.
