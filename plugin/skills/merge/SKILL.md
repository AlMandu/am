---
name: merge
description: "한 작업(slug)이 만든 커밋들을 지정한 브랜치에서 새로 딴 feature/<slug> 로 차례로 옮겨 그 브랜치에 merge 하고, 시작할 때의 브랜치와 작업 중이던 변경을 원래대로 돌려놓습니다. 충돌은 풀고 게이트와 검토로 확인하며, push 는 하지 않습니다."
argument-hint: "<slug> <브랜치>"
disable-model-invocation: true
model: opus
effort: high
---

# am:merge

Task: $ARGUMENTS

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
Run every git command from the repository root, one per call; if one in steps 7-10 fails in a way these steps do not cover, go to step 11 and report. Never push, force, `reset --hard`, overwrite or delete a branch, or drop a stash before it is restored.
1. Arguments: `<slug> <branch>`, both required. If one is missing, `.am/<slug>/plan.md` does not exist or the branch is not a local branch, list the folders under `.am/` that hold a plan.md and ask; never guess. If `.am/<slug>/merge.md` holds a record without a finished mark, resume (step 12) instead of starting again.
2. Other sessions: if `.orchestrator/lock.json` exists, or the last line of some `.am/*/progress.jsonl` has an `ev` other than `end`, name that run or task and go on only if the user says to continue.
3. Commits: read `.am/<slug>/commits.md` (`<hash> <subject>` per line), and if the plan's Change log records a hand-over to am-orchestrator with a run ID, add `tasks.*.commits` of `.orchestrator/runs/<run>/state.json` (the first word of each entry is a hash). Expand each with `git rev-parse --verify <h>^{commit}` and check it is an ancestor of the start HEAD (`git merge-base --is-ancestor`). If there is no record or any hash fails, show an estimated list (start-branch commits not on the target branch that touch a path in the plan's Files) with subjects and go on only with the user's approval. Sort them oldest first. Leave out commits already on the target branch and say so; if none are left, stop without changing anything.
4. Preflight, stop and report on any of: a merge, cherry-pick or rebase in progress; `feature/<slug>` already exists (also after a finished earlier merge); an ignored file (`git ls-files -o -i --exclude-standard --directory`; a listed folder covers every path under it) that is tracked on the target branch (`git ls-tree -r --name-only <branch>`) or touched by a commit to move. Note whether `am-gate.json` exists now.
5. Record, before any git change: write `.am/<slug>/merge.md` with the start branch (its hash for a detached HEAD), start HEAD, target branch and its tip, the full-hash commit list, the new branch name, and the stash message `am:merge <slug> <time>`. After each of the actions below, add one line saying it is done.
6. Stash: if there are changes, `git stash push --include-untracked -m <message>`. If it says "No local changes to save", record no stash. Record the stash's object hash only when the top stash carries that message.
7. Branch: `git switch <branch>`, then `git switch -c feature/<slug>`.
8. Move: for each commit, `git cherry-pick -x <hash>`, recording original -> copy hash. An empty pick: `git cherry-pick --skip`, and record it. On a conflict: fix it keeping the intent of both sides (the plan, `git show <hash>`), `git add` only the fixed files by path (never `-A` or `.`), check that the message file (`git rev-parse --git-path MERGE_MSG`, usually `.git/MERGE_MSG`) holds the `(cherry picked from commit ...)` line (add it if missing), then `git cherry-pick --continue --no-edit`. If you cannot resolve it with confidence, `git cherry-pick --abort` and go to step 11. If every pick was empty, go to step 11 without merging and say so.
9. Confirm, only if you resolved a conflict: run `node "${CLAUDE_PLUGIN_ROOT}/hooks/gate.mjs" --run --json` with a 10-minute timeout (if the placeholder was not replaced, the plugin root is the folder two levels above this SKILL.md), and one review (a subagent if available) comparing each resolved file with the target side's original, the original commit's change and the plan, keeping only defects with a concrete failure scenario. On gate `fail`, a confirmed defect, or `unconfigured` while `am-gate.json` existed at the start, do not merge; go to step 11. A gate failure may come from ignored files of the start branch (for example node_modules); say so.
10. Merge: if `git merge-base --is-ancestor feature/<slug> <branch>` succeeds, it is already merged. Otherwise check that the target branch tip still equals the record (if not, go to step 11 and report), `git switch <branch>`, then `git merge --no-ff feature/<slug>` with the default message.
11. Restore: `git switch <start branch>` (`git switch --detach <hash>` for a detached HEAD). Find the recorded stash by its object hash, else by its message. If an untracked file of that stash (`<stash>^3`) already exists in the working tree, keep the stash and report. Otherwise `git stash pop --index stash@{n}`; if it fails, keep the stash and report. Mark the record finished. Keep `feature/<slug>` as it is, also after a failure.
12. Resume: match the record with the real state - current branch, a cherry-pick in progress, commits already moved (the record's original -> copy pairs, the `cherry picked from` lines of the copies and `git cherry`, all as full hashes), whether it is merged (the ancestor check above), and whether the recorded stash exists. Then go on from the first unfinished action; if the user wants to undo, only step 11.
13. Reply: the conclusion in one line; commits moved and left out; each conflict and how it was resolved; the confirmation result; the merge commit hash; the branch now checked out and whether the stash was restored; that nothing was pushed, and the next step.
