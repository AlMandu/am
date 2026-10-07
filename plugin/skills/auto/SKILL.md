---
name: auto
description: "요청 하나를 계획 → 구현 → 점검 → 커밋까지 중간 질문 없이 이어 갑니다. 화면·범위 질문은 추천안으로 정해 마지막 답에서 결론 바로 다음에 알리고, 되돌리기 어려운 일에서만 멈춥니다. 큰 작업은 am-orchestrator 가 설치돼 있으면 그쪽에 넘깁니다. 기존 slug 를 주면 남은 단계부터 이어 가고, 맨 앞에 push 를 붙이면 push 까지 합니다."
argument-hint: "[push] <만들거나 고칠 내용 | 기존 slug>"
disable-model-invocation: true
hooks: { PreToolUse: [ { matcher: "Read|Edit|Write|MultiEdit|NotebookEdit", hooks: [ { type: command, command: "node -e \"import(require('url').pathToFileURL(process.env.CLAUDE_PLUGIN_ROOT+'/hooks/handover.mjs')).then((m) => m.main()).catch(() => {})\"", timeout: 60 } ] } ] }
model: opus
effort: medium
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
  2. Write every pending choice in one brief: the goal, the user's decisions and other fixed constraints, questions still waiting for the user's answer, the paths involved, and each choice with its options in neutral wording.
  3. Codex, in Claude Code only: save the brief as a new file `opinion-<round>.md` under `.am/` (in the plan's folder when there is one; a new `.am/` folder also gets a `.gitignore` containing `*`) and, if `${CLAUDE_PLUGIN_ROOT}/scripts/codex-opinion.mjs` exists, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-opinion.mjs" <brief file>` from the repository root with a 10-minute timeout. It prints Codex's answer to the brief; exit code 2 means Codex is not installed. Then send the brief to the am:second-opinion subagent. Its model and effort are pinned in its definition; do not override them.
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

## Running without stops
This skill runs the am:plan, am:do, am:check and am:commit skills in one session, or hands a large task to the am-orchestrator run skill (step 4). Running it is the user's request for all of them, including the commits. Inside this skill the rules below replace the asking rules above; do not wait for the user between phases.
- A question about what the user sees or what is in scope, wherever a skill would ask it (the am:plan skill steps 1 and 8, the am:do skill step 2, a plan that turns out wrong in the am:do skill step 4): take your recommendation, record it under Decisions in plan.md with a one-line reason and the mark `(auto-decided)` translated into the plan's language (`(자동 결정)` in a Korean plan), and continue. Technical choices still go through the second opinion (rules above).
- A small change (the am:plan skill step 3): write a short plan.md anyway.
- Done marks that do not match the files (the am:do skill step 3): redo a done step whose change is missing; run the Check of an unmarked step that already looks done and mark it if it passes. Log either under Change log and list it in the final reply with what you decided for the user.
- A file you cannot tell belongs to this task (the am:commit skill step 3): leave it out of the commit and report it.
- Skip the intermediate replies of those skills; what they would report goes into the final reply.
- The run skill (step 4): its `decide` questions are scope or screen questions; decide them as above unless one falls under a stop below, and pass each answer with `decide`. Keep its one-line progress notes. Its rule never to merge or push covers its own flow only; step 4 merges after it.

Besides the failures where those skills stop on their own (a step's Check you cannot fix, a blocked commit, push or fast-forward, the run skill's `answer` and `blocked` questions), stop only in these cases:
- The next action would delete user data or files that existed before this run, change a saved-data format, or migrate data.
- The next action would change anything outside this repository (other folders, external services, installed packages), other than the push asked for.
- The user's or project's instructions say the next action needs confirmation. The push keyword is that confirmation for the push.
- The run skill asks in its Prepare step (no `am-gate.json`, uncommitted changes you did not make, a gate that fails before the run). Do not fall back to the am:do skill.
- The two reviewers of a technical choice still split on it after their rounds (rules above).
- The request is empty or the push keyword is unclear (step 1), a skill file cannot be read (step 2 or 4), or the check is still BLOCK after the retry (step 5).
In the first five cases, ask with a decision card (rules above); after the answer, record it in plan.md and continue from where you stopped. Whenever you stop after step 2, leave the files as they are; if plan.md exists, record the reason and any open question in it.

## Steps
1. Request: if the first word is `push`, push mode is on and the rest is the request; if you cannot tell whether it is the keyword or part of the request, ask before anything else. If the request is empty, ask what to do and stop. If the whole request is a slug whose `.am/<slug>/plan.md` exists, resume that plan; otherwise it is a new request.
2. Read the four skill files `${CLAUDE_PLUGIN_ROOT}/skills/<name>/SKILL.md` for plan, do, check and commit; if the placeholder was not replaced, `skills/<name>/SKILL.md` under the plugin root, the folder two levels above this SKILL.md. If any of them cannot be read, change no file and stop. Follow their Steps in this session.
   In Claude Code only, also run `claude plugin list --json`: if an `am-orchestrator@` entry has `enabled: true` and `<installPath>/skills/run/SKILL.md` exists, read that file too (the run skill). A missing command, an error, no such entry or no such file means it is not installed; go on without it.
3. Plan: for a new request, follow the am:plan skill's Steps up to writing plan.md, using a slug not already under `.am/`, then settle its open questions as above. To resume, do not plan again; settle any open decisions in that plan as above. If every step is marked done and its changes are already committed (for example after a rejected push), go to step 6.
   Scale: add one line to the plan's Summary in its language, `Scale: N implementation runs, M commits` (`규모: 구현 N회, 커밋 M개` in a Korean plan), also when a resumed plan lacks it. One implementation run is one am:do run that a fresh session can finish and verify: about 8 files and a plan of at most 150 lines. M is the number of logical units the am:commit skill would commit separately.
4. Do: hand over (below) if the Change log records a hand-over with a run ID, or if you read the run skill in step 2, no step is marked done and the scale is above 1 implementation run or 1 commit. Otherwise follow the am:do skill's Steps for this slug, from the first step not marked done, through the runtime checks of its last step; the check itself is step 5 here.
   In Claude Code, this skill's hook denies file edits outside `.am/`, `.orchestrator/` and `am-gate.json` while this session's plan is above that scale, the run skill is installed, no step is marked done and no hand-over is logged; follow its reason, and never lower the scale only to get past it.
   Hand-over: if the run skill could not be read, stop. A new hand-over first notes `run.id` from `status --json` (none if `run` is null), then follows the run skill's Steps with the path of this plan.md as its request; once `split` has made the run (`run.id` present and not the noted one; otherwise stop and report), log in one Change log line that it went to the am-orchestrator run skill, with `run.id` and the current branch as the start branch. If the log already has that line, check that `status --json` shows the same `run.id` (if not, stop and report), then follow the run skill from its step 4. When `next` is `done`: unless `run.branch` is the start branch, check out the start branch and run `git merge --ff-only <run.branch>` and `git branch -d <run.branch>`; log the merge, and in push mode push the start branch by the am:commit skill's push rules (its step 6). A resumed hand-over whose merge is logged only pushes. Skip steps 5 and 6: the run checks and commits each task.
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
   After a hand-over, the check and commit items become: tasks done of all and the branch they are on, the cost from `costUsd`, the human checklist of the report at `run.report` (shortened, with its path), and the run's `autoDecided` lines join what you decided.
   If you stopped, reply instead with why, what is done so far (after a hand-over, also which branch holds which commits and which one is checked out), and how to continue: answer the question, or fix the cause and run this skill again with the slug (`push <slug>` in push mode).
