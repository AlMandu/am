---
name: land
description: "지금 브랜치를 대상 브랜치(생략하면 원격 기본 브랜치)에 합쳐 원격에 push 하고, 끝으로 지금 브랜치를 합친 커밋으로 옮깁니다. 커밋하지 않은 변경은 그대로 두며, 대상 쪽 변경과 겹치면 옮기지 않고 알립니다. 로컬 대상 브랜치는 원격에 맞추고, 강제 push 는 하지 않습니다."
argument-hint: "[대상 브랜치]"
disable-model-invocation: true
model: opus
effort: high
---

# am-util:land

Target: $ARGUMENTS

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
Run every git command from the repository root, one per call, and never `cd`; run the temporary worktree's commands as `git -C <temp> …`. Until step 8, never touch this folder's working tree, except for step 5's temporary worktree under `.am/` and the `.am/.gitignore` it creates when missing; from then on only step 8's `git merge --ff-only` changes its checkout, keeping uncommitted changes and never pushing them or this branch. In this folder (not the temporary worktree): no switch, checkout, stash, reset, restore, rebase or pull, and no record file. Never force push (no `--force`, `--force-with-lease` or `+` refspec). Run no tests or gate before the push. Once step 5 has created a temporary worktree, every outcome (success, stop or failure) goes through step 7 before the reply.
1. Start: the current branch is `git symbolic-ref --short HEAD`; if that fails (detached HEAD), stop and ask the user to check out a branch. Stop if `git remote get-url origin` fails. Target: the argument; without one, `git symbolic-ref --short refs/remotes/origin/HEAD` minus its `origin/` prefix; if that fails, the `ref: refs/heads/<name>` line of `git ls-remote --symref origin HEAD`; with neither, stop and ask for the target branch. Stop if the current branch is the target, or if `git rev-parse --git-path <name>` exists for any of `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `rebase-merge`, `rebase-apply` (an operation in progress). If `ProjectSettings/ProjectVersion.txt` exists (a Unity project), ask the user to confirm the Unity editor is closed (step 8 changes files in this folder).
2. Fetch: `git fetch origin refs/heads/<target>`; stop if `git rev-parse --verify --quiet refs/remotes/origin/<target>` then fails. Local target: if `git rev-parse --verify --quiet refs/heads/<target>` fails, note that it is missing and go on. If it exists and differs from `origin/<target>`, do not stop (the user's decision): note its old tip hash and `git log --oneline origin/<target>..<target>` (commits only on the local target), then `git branch -f <target> origin/<target>`. This moves only the branch; if git refuses because the branch is checked out in another worktree, note it, skip every later local update and go on.
3. Already landed: if `git merge-base --is-ancestor HEAD origin/<target>` succeeds, push nothing and go to step 8.
4. Fast-forward, when `git merge-base --is-ancestor origin/<target> HEAD` succeeds: show `git log --oneline origin/<target>..HEAD`, note `git rev-parse HEAD` as the pushed commit and go to step 6.
5. Diverged (otherwise), make a merge commit in a temporary worktree; never on the current branch:
   - Temp folder: `.am/land-<YYYYMMDD-HHMMSS>` (another name if it exists). If `.am/` does not exist and `git check-ignore -q .am` fails, first create `.am/.gitignore` containing `*`.
   - `git worktree add --detach <temp> origin/<target>`, then `git -c core.editor=true -C <temp> merge --no-ff --no-edit -m "Merge branch '<branch>' into <target>" <branch>`.
   - Conflicts: for each file of `git -C <temp> diff --name-only --diff-filter=U`, read both sides (`git -C <temp> show :2:<path>` and `:3:<path>`, and the commits on each side), show in plain words what each side changed, and ask the user whether to abort or to let you resolve them (and which side to keep where they collide). During a merge `--ours` is the target side and `--theirs` this branch.
   - To resolve: edit a text file only inside `<temp>` (by its absolute path) so the intent of both sides survives; take a scene, prefab or binary file whole from one side with `git -C <temp> checkout --ours -- <path>` or `git -C <temp> checkout --theirs -- <path>`; then `git -C <temp> add -- <path>`. After the last file, finish with `git -c core.editor=true -C <temp> merge --continue`, never with a commit command: the commit gate would run in the temp folder, which has no installed dependencies.
   - If you are not confident about any file, the user chooses to abort, or a merge command fails for a reason other than conflicts, run `git -C <temp> merge --abort` and go to step 7.
   - The merge commit is `git -C <temp> rev-parse HEAD`; note it as the pushed commit and go to step 6.
6. Push and local update: `git push origin <pushed commit>:refs/heads/<target>`. If the push is rejected or fails, do not force, pull, merge or rebase; report it (when rejected, the remote has newer commits; otherwise git's message; run this skill again) and go to step 7.
   - On success, unless step 2 skipped every local update: `git fetch . <pushed commit>:refs/heads/<target>`; when the local target was missing this creates it, so then run `git branch --set-upstream-to=origin/<target> <target>`. If either fails, keep the push and report it.
7. Clean up whenever a temp worktree exists (success, stop or failure): `git worktree remove <temp>`; if git refuses, `git worktree remove --force <temp>` (only this run's folder); if that fails too, report its path.
8. Move this branch: only after a successful push in step 6, even if the local target update or upstream setup failed, or from step 3; otherwise skip to step 9. The landed commit is the pushed commit, or `origin/<target>` from step 3, never the local target branch.
   - Note `git rev-parse HEAD` as the old commit and `git diff --name-only --no-renames -z HEAD` as the set of changed tracked paths (NUL-delimited). Run `git merge --ff-only --no-autostash --no-overwrite-ignore <landed commit>` once.
   - If git refuses because local changes or untracked/ignored files would be overwritten, treat it as a conflict: the branch and working state stay unchanged, so there is nothing to undo. Keep the successful push; note the files git names (or its verbatim message if the paths cannot be read), then go to step 9.
   - On any other failure, compare `git rev-parse HEAD` with the old commit and report git's output and `git status --porcelain`; do not attempt recovery or claim the working state is unchanged. Go to step 9.
   - On success, note `git rev-parse HEAD` and repeat `git diff --name-only --no-renames -z HEAD`; paths present before but absent afterwards are already included in the target and no longer appear as uncommitted changes. Record their names for the reply.
9. Reply:
   - The conclusion in one line.
   - Fast-forward or merge commit (its hash).
   - Each conflict and how it was resolved, or that the merge was aborted.
   - The push result.
   - The local target: updated, created, upstream not set, or not moved because another worktree has it checked out; when local-only commits left it, its old tip hash and their list, so they can be recovered.
   - This branch's move: old → new commit, or why it was not moved, including conflict files.
   - Paths whose changes are already in the target and disappeared from the change list.
   - That this folder was untouched until the final move, with the number of remaining uncommitted changes (`git status --porcelain`) that were not pushed.
   - On a move conflict: commit or set aside the overlapping changes and run this skill again; the successful push is kept and this branch is not pushed.
