---
name: plan
description: "큰 변경을 시작하기 전에 의도를 확인하고, 사용자만 정할 수 있는 것만 묻고, 짧은 계획 문서(.am/<slug>/plan.md)를 씁니다. 기존 slug 를 주면 그 계획을 다시 열어 질문·수정을 이어 갑니다(구현은 am:do). 작고 결과가 뻔한 수정에는 필요 없습니다."
argument-hint: "<만들거나 고칠 내용 | 기존 slug>"
disable-model-invocation: true
---

# am:plan

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

## Existing plan
If the argument names a slug whose `.am/<slug>/plan.md` exists, do not plan from scratch. Ask its open decisions or apply the requested changes and record them in plan.md, then finish as in step 8: implement only if the user said go, otherwise point to the am:do skill.

## Steps
1. Restate the goal in 1-3 lines from the user's point of view. Ask first only if two reasonable readings lead to different results.
2. Explore the code the change touches. For a wide search, use a read-only exploration subagent if one is available.
3. Small change (3 files or fewer, obvious result): say so, offer to do it directly without a plan file, and stop.
4. Folder: `.am/<slug>/` at the repository root. The slug is short kebab-case English; reuse a slug already used in this conversation and never guess from recent folders. If `.am/` does not exist yet and `git check-ignore -q .am` fails, create `.am/.gitignore` containing `*`. If the folder holds an older `analyze.md` or `design.md`, read only their summary and decisions.
5. Technical choices: before drafting, list the ones this plan depends on. If there are any, settle them through the second opinion (rules above), all in one brief.
6. Risk review, only when the change touches saved data or save formats, server or network contracts, concurrency or async ordering, data migration, security, or deletion of user data: have one independent reviewer (a subagent if available, otherwise a separate pass by you) attack the draft from at most 3 relevant angles. Keep only CRITICAL or HIGH issues that come with a concrete failure scenario and fix the plan for them; list the rest under Risks. Do not ask the user about review findings.
7. Write `.am/<slug>/plan.md` in the user's language: at most 150 lines, no full code listings, this skeleton with translated headings:

   ```markdown
   # <title>
   > Implement with the am:do skill. Rules: 1) do the Steps in order 2) run each step's check and mark the step done 3) for a bug, record the reproduction result before fixing it 4) log any deviation under Change log 5) when done, use the am:check skill
   ## Summary      goal, what changes for the user, main risk (8 lines or fewer)
   ## Decisions    user decisions; "Defaults applied": choice - one-line reason (tag as in the rules above)
   ## Files        path - what changes
   ## Steps        numbered; each ends with "Check: ..."
   ## Checks       automated (gate, tests) / agent runtime checks / human checklist (where, what to do, what they should see) / bug reproduction (steps, result before the fix)
   ## Risks        only real ones
   ## Change log
   ## Next         one line
   ```

8. In the reply, name in plain words any technical choice where the second opinion overruled your own pick, then ask the open decisions (rules above). End with one line saying you will record the answers and stop, and that adding "go" to the answer continues straight into implementation. Record the answers under Decisions and reopen any settled choice they conflict with (rules above). If the user said go, read the am:do skill file (`${CLAUDE_PLUGIN_ROOT}/skills/do/SKILL.md`; if the placeholder was not replaced, `skills/do/SKILL.md` under the plugin root, the folder two levels above this SKILL.md) and follow its Steps for this slug; if you cannot read it, implement by the rules at the top of plan.md. Otherwise stop with the summary and the next step (the am:do skill).
