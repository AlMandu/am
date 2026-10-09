---
name: do
description: "am:plan 이 쓴 계획 문서(.am/<slug>/plan.md)대로 구현합니다. 끝난 단계는 건너뛰고 남은 단계를 순서대로 진행하며, 단계마다 확인하고 계획과 달라진 점을 기록합니다. 커밋은 하지 않고, 끝나면 am:check 로 넘어갑니다."
argument-hint: "<slug>"
disable-model-invocation: true
model: opus
effort: medium
---

# am:do

Plan: $ARGUMENTS

<!-- am:common:start -->
## Working with the user
- Reply in the user's language. Lead with a one-line conclusion, then what changes in terms the user sees (screen, behavior, data), then what the user needs to do and the next step.
- Keep file paths, line numbers and internal labels in the files you write, not in chat. Use plain words that fit the reader; avoid heavy analogies.
- Ask only what only the user can decide: what they will see or feel, what is in or out of scope, and choices that are hard to undo. Ask at most 3 questions at a time.
- Every other technical choice is settled by a second opinion, not by your own recommendation. A technical choice is a design or implementation decision with two or more workable options that differ in structure, behavior or cost; where only one option is sensible, just take it.
  1. Settle your own pick first and keep it out of the brief.
  2. Write every pending choice in one brief: the goal, the user's decisions and other fixed constraints, questions still waiting for the user's answer, the paths involved, and each choice with its options in neutral wording.
  3. Codex, in Claude Code only: save the brief as a new file `opinion-<round>.md` under `.am/` (in the plan's folder when there is one; a new `.am/` folder also gets a `.gitignore` containing `*` unless `git check-ignore -q .am` succeeds) and, if `${CLAUDE_PLUGIN_ROOT}/scripts/codex-opinion.mjs` exists, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-opinion.mjs" <brief file>` from the repository root with a 10-minute timeout. It prints Codex's answer to the brief; exit code 2 means Codex is not installed. Then send the brief to the am:second-opinion subagent. If the first line of the script's output is `Claude reviewer: model <model>, effort <effort> …`, pass that model and effort as the Agent call's `model` and `effort`; otherwise do not override the ones pinned in its definition.
  4. With both answers, send each choice they split on back to both, for at most 2 more rounds: a new brief with the original brief's content for those choices plus both picks and reasons from the last round, labelled Claude and Codex. A choice still split after that goes to the user as a decision card (rules below) that gives both picks and reasons. If one reviewer fails, in any round, the other's answer stands.
  5. Apply the agreed picks, not yours. A user decision always wins over a pick.
  6. List each under "Defaults applied": choice - one-line reason (second opinion), written (second opinion, Codex agreed) when both agreed and naming a reviewer that failed, adding your own pick when it differed.
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
1. Plan: `.am/<slug>/plan.md` for the slug given, or the one used in this conversation. With neither, list the folders under `.am/` that hold a plan.md and ask which one; never guess. If the file does not exist, say so, suggest the am:plan skill, and stop without changing any file.
2. Open decisions: if Decisions still has unanswered questions, ask them (rules above) and record the answers there before changing code, reopening any settled choice they conflict with (rules above).
3. Starting point: read the done marks on the Steps, the Change log and `git status`. Files an earlier session changed for this plan, including a step it left unfinished, are this task's work, not another session's. Never redo or revert finished work. Start at the first step not marked done. If the files do not match the marks (a done step whose change is missing, or an unmarked step that already looks done), ask before continuing; a plan with no marks at all is new or predates am:do; judge it from the Change log and the files and ask only when unclear.
4. Each step, in order:
   - Implement only what the step says, in the style of the surrounding code.
   - For a bug, run the reproduction and record its result in plan.md before fixing it.
   - Run the step's Check. If it fails, fix it within the step and run it again; if you cannot, stop and report what failed.
   - When the Check passes, mark the step done: append `(done)`, written in the plan's language, to the step's first line.
   - Log anything done differently from the plan under Change log, one line each: what and why.
   - If the plan turns out wrong in a way that changes what the user sees or the scope, stop and ask. Otherwise make the smallest fix and log it.
   - Choices the plan settled stand unless the rules above reopen them. A new or reopened technical choice goes through the second opinion (rules above); record it under "Defaults applied" in plan.md.
5. Do not commit or push; that is the am:commit skill's job.
6. When every step is done, run the agent runtime checks listed under Checks that you can do here, then use the am:check skill for this slug. In the final reply, also list any deviation from the plan and any choice where the second opinion overruled your own pick.
