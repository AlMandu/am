---
name: auto
description: "요청 하나를 계획 → 구현 → 점검 → 커밋까지 중간 질문 없이 이어 갑니다. 화면·범위 질문은 추천안으로 정해 마지막 답에서 결론 바로 다음에 알리고, 되돌리기 어려운 일에서만 멈춥니다. 기존 slug 를 주면 남은 단계부터 이어 가고, 맨 앞에 push 를 붙이면 push 까지 합니다."
argument-hint: "[push] <만들거나 고칠 내용 | 기존 slug>"
disable-model-invocation: true
---

# am:auto

Request: $ARGUMENTS

<!-- am:common:start -->
## Working with the user
- Reply in the user's language. Lead with a one-line conclusion, then what changes in terms the user sees (screen, behavior, data), then what the user needs to do and the next step.
- Keep file paths, line numbers and internal labels in the files you write, not in chat. Use plain words that fit the reader; avoid heavy analogies.
- Ask only what only the user can decide: what they will see or feel, what is in or out of scope, and choices that are hard to undo. Ask at most 3 questions at a time.
- Every other technical choice is settled by a second opinion, not by your own recommendation. A technical choice is a design or implementation decision with two or more workable options that differ in structure, behavior or cost; where only one option is sensible, just take it.
  1. Settle your own pick first and keep it out of the brief.
  2. Send every pending choice in one brief to the am:second-opinion subagent: the goal, the user's decisions and other fixed constraints, questions still waiting for the user's answer, the paths involved, and each choice with its options in neutral wording. Its model and effort are pinned in its definition; do not override them.
  3. Wait for its answer and apply its picks, not yours. A user decision always wins over a pick.
  4. List each under "Defaults applied": choice - one-line reason (second opinion), adding your own pick when it differed.
  5. Reopen a settled choice only when a user decision, including one given later, conflicts with it, a fact the brief left out changes it, or it proves unworkable (a failed check or a review finding). Send that choice back to the second opinion with the new fact, never to the user as a question, and update its line; do not swap in your own pick.
  If that subagent cannot be started (a tool that does not have it, or an error), apply your own pick and mark the line (no second opinion).
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

## Running without stops
This skill runs the am:plan, am:do, am:check and am:commit skills in one session. Running it is the user's request for all four, including the commit. Inside this skill the rules below replace the asking rules above; do not wait for the user between phases.
- A question about what the user sees or what is in scope, wherever a skill would ask it (the am:plan skill steps 1 and 8, the am:do skill step 2, a plan that turns out wrong in the am:do skill step 4): take your recommendation, record it under Decisions in plan.md with a one-line reason and the mark `(auto-decided)` translated into the plan's language (`(자동 결정)` in a Korean plan), and continue. Technical choices still go through the second opinion (rules above).
- A small change (the am:plan skill step 3): write a short plan.md anyway.
- Done marks that do not match the files (the am:do skill step 3): redo a done step whose change is missing; run the Check of an unmarked step that already looks done and mark it if it passes. Log either under Change log and list it in the final reply with what you decided for the user.
- A file you cannot tell belongs to this task (the am:commit skill step 3): leave it out of the commit and report it.
- Skip the intermediate replies of those skills; what they would report goes into the final reply.

Besides the failures where those skills stop on their own (a step's Check you cannot fix, a blocked commit or push), stop only in these cases:
- The next action would delete user data or files that existed before this run, change a saved-data format, or migrate data.
- The next action would change anything outside this repository (other folders, external services, installed packages), other than the push asked for.
- The user's or project's instructions say the next action needs confirmation. The push keyword is that confirmation for the push.
- The request is empty or the push keyword is unclear (step 1), a skill file cannot be read (step 2), or the check is still BLOCK after the retry (step 5).
In the first three cases, ask with a decision card (rules above); after the answer, record it in plan.md and continue from where you stopped. Whenever you stop after step 2, leave the files as they are; if plan.md exists, record the reason and any open question in it.

## Steps
1. Request: if the first word is `push`, push mode is on and the rest is the request; if you cannot tell whether it is the keyword or part of the request, ask before anything else. If the request is empty, ask what to do and stop. If the whole request is a slug whose `.am/<slug>/plan.md` exists, resume that plan; otherwise it is a new request.
2. Read the four skill files `${CLAUDE_PLUGIN_ROOT}/skills/<name>/SKILL.md` for plan, do, check and commit; if the placeholder was not replaced, `skills/<name>/SKILL.md` under the plugin root, the folder two levels above this SKILL.md. If any of them cannot be read, change no file and stop. Follow their Steps in this session.
3. Plan: for a new request, follow the am:plan skill's Steps up to writing plan.md, using a slug not already under `.am/`, then settle its open questions as above. To resume, do not plan again; settle any open decisions in that plan as above. If every step is marked done and its changes are already committed (for example after a rejected push), go to step 6.
4. Do: follow the am:do skill's Steps for this slug, from the first step not marked done, through the runtime checks of its last step; the check itself is step 5 here.
5. Check: follow the am:check skill's Steps for this slug. If the verdict is BLOCK, fix the causes that lie inside this task and follow them once more. If it is still BLOCK, do not commit; stop.
6. Commit: follow the am:commit skill's Steps with no notes, in push mode only if step 1 set it. If the gate could not run (status `error`, or `node` missing, in the check or at the commit), commit but do not push, and say why.
7. Reply in this order:
   - the conclusion in one line;
   - what you decided for the user, under a heading in the user's language: each auto-decided choice and each choice where the second opinion overruled your own pick, in plain words, or none;
   - what changes for the user, and any deviation from the plan;
   - the check verdict and the human checklist;
   - each commit's hash and message, and what was left uncommitted;
   - in push mode where it was pushed or why not, otherwise that nothing was pushed;
   - the next step.
   If you stopped, reply instead with why, what is done so far, and how to continue: answer the question, or fix the cause and run this skill again with the slug (`push <slug>` in push mode).
