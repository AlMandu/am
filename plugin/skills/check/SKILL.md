---
name: check
description: "커밋 전 점검: 프로젝트 게이트(빌드·테스트)를 돌리고, 할 수 있는 만큼 실제로 실행해 확인하고, 변경을 계획과 대조합니다. 사용자가 검증·테스트·점검을 요청하거나 am:check 를 실행할 때 씁니다. 경고는 커밋을 막지 않고, 게이트 실패와 확인된 결함만 막습니다."
argument-hint: "[slug]"
---

# am:check

Target: $ARGUMENTS

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

## Steps
1. Scope: the uncommitted changes (`git status`, `git diff HEAD`) plus `.am/<slug>/plan.md` for the slug given or used in this conversation. Without a plan, check the diff alone.
2. Gate. From the repository root run:
   `node "${CLAUDE_PLUGIN_ROOT}/hooks/gate.mjs" --run --json`
   If the placeholder was not replaced, the plugin root is the folder two levels above this SKILL.md. Give the command a 10-minute timeout, or run it in the background and wait for it to finish. Read `status`:
   - `pass`
   - `fail`: quote the failing command and the tail of its output
   - `unconfigured`: there is no am-gate.json, so no automated build or test check exists; say so
   - `error`: say what could not run
   If `node` itself is missing, report the gate as not run.
3. Runtime. Follow the project's runtime-check instructions (a "Runtime check" section in CLAUDE.md or AGENTS.md, or a file they point to). Do what you can yourself first: run the app or editor commands, read logs, capture the screen, run probes. For a bug fix, repeat the plan's reproduction and compare it with the result recorded before the fix. Hand the human only what you cannot do: at most 5 items, each "where / what to do / what they should see".
4. Review. One reviewer (a subagent if available, otherwise a separate pass by you) compares the code diff with the plan (missing, extra, different) and looks for defects. Give the reviewer code files only; list asset and generated files (.prefab, .unity, .asset, .meta, .uasset, .umap, lock files) by name. Keep a finding only if it comes with a concrete failure scenario (inputs, then the wrong result).
5. Verdict:
   - BLOCK: gate `fail`, a confirmed defect, or a planned step missing without a reason.
   - NOTE: everything else, including steps dropped with a reason in the Change log or by the user. Notes never block a commit.
   Fix small, safe, local problems right away and run the gate once more. If a failure comes from files outside this task, do not fix it; report it.
6. With a slug, write `.am/<slug>/check.md` (20 lines or fewer): verdict, gate result, what you checked at runtime, the human checklist, notes.
7. Reply: the verdict in one line, then what was verified (gate, runtime, review), then the human checklist, then the next step (the am:commit skill, or what to fix).
