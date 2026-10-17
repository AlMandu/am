---
name: sessions
description: "이 PC 에서 am:auto-multi·am:auto-one 과 am-orchestrator 가 띄운 백그라운드 세션이 작업 폴더별로 지금 무엇을 하는지 한 번 보여 줍니다. 사용자가 돌고 있는 세션의 상태를 묻거나 am:sessions 를 실행할 때 씁니다. 읽기만 하고 아무것도 바꾸거나 멈추지 않습니다."
argument-hint: ""
model: sonnet
effort: low
---

# am:sessions

<!-- am:common:start -->
## Working with the user
- Reply in the user's language. Lead with a one-line conclusion, then what changes in terms the user sees (screen, behavior, data), then what the user needs to do and the next step.
- Keep file paths, line numbers and internal labels in the files you write, not in chat. Use plain words that fit the reader; avoid heavy analogies.
- Ask only what only the user can decide: what they will see or feel, what is in or out of scope, and choices that are hard to undo. Ask at most 3 questions at a time.
- Every other technical choice is settled by a second opinion, not by your own recommendation. A technical choice is a design or implementation decision with two or more workable options that differ in structure, behavior or cost; where only one option is sensible, just take it.
  1. Settle your own pick first and keep it out of the brief.
  2. Write every pending choice in one brief: the goal, the user's decisions and other fixed constraints, questions still waiting for the user's answer, the paths involved, and each choice with its options in neutral wording.
  3. Codex, in Claude Code only: save the brief as a new file `opinion-<round>.md` under `.am/` (in the plan's folder when there is one; a new `.am/` folder also gets a `.gitignore` containing `*` unless `git check-ignore -q .am` succeeds) and, if `${CLAUDE_PLUGIN_ROOT}/scripts/codex-opinion.mjs` exists, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-opinion.mjs" <brief file>` from the repository root with a 10-minute timeout. It prints Codex's answer to the brief; exit code 2 means Codex is not installed. Then send the brief to the am:second-opinion subagent; when Codex is not installed (exit code 2), send it at once to two of them, Claude 1 and Claude 2, each Agent call's prompt adding one line that names which of the two it is. If the first line of the script's output is `Claude reviewer: model <model>, effort <effort> …`, pass that model and effort as the Agent call's `model` and `effort`; otherwise do not override the ones pinned in its definition (both calls when there are two).
  4. With both answers, send each choice they split on back to both, for at most 2 more rounds: a new brief with the original brief's content for those choices plus both picks and reasons from the last round, labelled Claude and Codex (Claude 1 and Claude 2 without Codex, each told again which one it is). A choice still split after that goes to the user as a decision card (rules below) that gives both picks and reasons. If one reviewer fails, in any round, the other's answer stands.
  5. Apply the agreed picks, not yours. A user decision always wins over a pick.
  6. List each under "Defaults applied": choice - one-line reason (second opinion), written (second opinion, Codex agreed) when Codex and Claude agreed or (second opinion, Claude reviewers agreed) when Claude 1 and Claude 2 agreed, and naming a reviewer that failed, adding your own pick when it differed; keep these marks in English in a plan of any language.
  7. Reopen a settled choice only when a user decision, including one given later, conflicts with it, a fact the brief left out changes it, or it proves unworkable (a failed check or a review finding). Send that choice back through steps 2-4 with the new fact, never to the user as a question unless the reviewers stay split, and update its line; do not swap in your own pick.
  If neither reviewer can answer (a tool without the subagent, or errors), apply your own pick and mark the line (no second opinion).
- Explain every question as a decision card first, written for someone who has seen neither this conversation nor the code:
  1. What is being decided, in one sentence, with no code names, file names or internal IDs.
  2. Why it must be decided now: how things are today and what stays blocked without an answer.
  3. For each option (2-4, your recommendation first): what the user will see or experience if they pick it, and its cost.
  4. Your recommendation and the one-sentence reason.
  5. Whether it is easy to change later or hard to undo.
  Before asking, check that a reader holding only the card could choose; if not, rewrite it. Put the card in the chat, then ask with a structured question tool if one exists (each option's description says what changes; for a screen decision, add a small text mockup as the option preview), otherwise as numbered options.
- Never edit or revert changes you did not make (the user's or another session's). Mention them only if they block the work.
- Refer to other am skills by name, e.g. "the am:check skill"; the slash or $ prefix differs per tool.
<!-- am:common:end -->

## Steps
1. From the repository root run, once and with no argument:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/sessions.mjs"`
   If the placeholder was not replaced, the plugin root is the folder two levels above this SKILL.md. If it fails (a non-zero exit code, or `node` is missing), report the tail of its output and stop; do not read the record files yourself.
2. Reply. When the script printed only `지금 돌고 있는 am 세션이 없습니다.`, that line is the whole reply. Otherwise:
   - First line, a one-line conclusion: how many sessions are running (am:auto-multi and am:auto-one task lines plus orchestrator task, split, gate and workspace lines) and which lines need a look. A line whose last news is more than 15 minutes old (`(M분 전)` above 15), or a line with no news whose `N분째` is above 15, is "no recent news"; never say it has stopped or hung. 15 minutes is longer than the 10-minute gate limit and the 8-minute wait of the progress news, so a normal run is rarely flagged.
   - Then the report exactly as printed, not wrapped in a code block and not reworded.
3. Change, remove or stop nothing: do not edit any file, do not stop any process and do not run another am skill. If the user wants to stop or resume a session, say that this skill only reports, and point to the skill that the task's line names to resume it: the am:auto-multi skill (`am:auto-multi <slug>`) or the am:auto-one skill (`am:auto-one <slug>`).
