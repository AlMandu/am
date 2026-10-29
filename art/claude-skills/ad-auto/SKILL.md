---
name: ad-auto
description: "자리를 비울 때 반복해서 돌리는 AD 자동 검수 한 바퀴입니다(loop 전용). 별도 하위 작업에서 am-art:ad-review 를 자동 모드로 한 바퀴 돌리고, 지금 대화에는 그 보고(또는 ‘검수할 문서 없음’ 한 줄)만 남깁니다. 오너에게 묻지 않으며, 오너가 정할 일은 ‘오너 대기 목록’에 모읍니다. 직접 검수하거나 돌아와서 그 목록을 물을 때는 am-art:ad-review 를 씁니다. Claude Code 전용입니다."
argument-hint: "(인자 없음)"
context: fork
model: opus
effort: high
---

# am-art:ad-auto

Argument: $ARGUMENTS
If you are not Claude Code (for example Codex): answer exactly one line, `이 스킬은 Claude Code AD 용입니다(실무자는 am-art:ad-execute 스킬).`, and stop; read and change nothing.

You run in a forked subagent (`context: fork`): one unattended AD round whose files and images stay here, so that the owner's conversation receives only the round's report. The owner repeats this skill with the loop line given in the am-art:ad-review skill. The argument is ignored.

## Steps
1. Invoke the am-art:ad-review skill through the Skill tool with the argument `자동`, and follow it to its end. Its `자동` rules apply as written: never ask the owner; owner decisions go to the "오너 대기 목록".
2. Your final message is that skill's Report exactly as written: the table, every path link one per line, the "오너 대기 목록", the next-step recommendation and any "완료 판정" line. Do not summarise, shorten or add to it. When the round ended with one line (`검수할 문서 없음`, a missing key, or the run not being inside a package), the final message is that line alone.
3. When the Skill tool is unavailable or the skill does not load, the final message is one line: `am-art:ad-review 를 불러오지 못했습니다: <reason>`.

## Never
Ask the owner (a forked subagent cannot); do anything outside that one round; start a second round.
