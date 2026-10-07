---
name: commit
description: "이번 작업의 변경만 논리 단위로 커밋합니다(커밋 게이트 통과 후). 사용자가 커밋·저장·마무리를 요청하거나 am:commit 을 실행할 때 씁니다. 인자 맨 앞에 push 를 붙이거나 대화에서 커밋 뒤 push 를 요청하면 push 까지 하고, 그 밖에는 push 하지 않습니다."
argument-hint: "[push] [메모]"
model: opus
effort: medium
---

# am:commit

Notes: $ARGUMENTS

<!-- am:common:start -->
## Working with the user
- Reply in the user's language. Lead with a one-line conclusion, then what changes in terms the user sees (screen, behavior, data), then what the user needs to do and the next step.
- Keep file paths, line numbers and internal labels in the files you write, not in chat. Use plain words that fit the reader; avoid heavy analogies.
- Ask only what only the user can decide: what they will see or feel, what is in or out of scope, and choices that are hard to undo. Ask at most 3 questions at a time.
- Every other technical choice is settled by a second opinion, not by your own recommendation. A technical choice is a design or implementation decision with two or more workable options that differ in structure, behavior or cost; where only one option is sensible, just take it.
  1. Settle your own pick first and keep it out of the brief.
  2. Write every pending choice in one brief: the goal, the user's decisions and other fixed constraints, questions still waiting for the user's answer, the paths involved, and each choice with its options in neutral wording.
  3. Codex, in Claude Code only: save the brief as a new file `opinion-<round>.md` under `.am/` (in the plan's folder when there is one; a new `.am/` folder also gets a `.gitignore` containing `*` unless `git check-ignore -q .am` succeeds) and, if `${CLAUDE_PLUGIN_ROOT}/scripts/codex-opinion.mjs` exists, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-opinion.mjs" <brief file>` from the repository root with a 10-minute timeout. It prints Codex's answer to the brief; exit code 2 means Codex is not installed. Then send the brief to the am:second-opinion subagent. Its model and effort are pinned in its definition; do not override them.
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
1. Commit only if the user asked for a commit in this conversation; running this skill counts. If you picked this skill on your own, propose the commit and stop.
   Push mode: the first word of Notes is `push` (the rest are notes), or the user explicitly asked in this conversation to push after committing. If you cannot tell whether a leading "push" is the keyword or part of a note, ask.
2. Collect `git status --porcelain`. Leave out `.am/` and ignored files. Exclude anything that looks secret (.env, credentials, keys, *.pem) and say so. The task's folder: a slug named in Notes whose `.am/<slug>/` exists, otherwise the slug used in this conversation. With neither, list the folders under `.am/` that hold a check.md and ask which one; never guess. With no such folder, say that no check result was read and go on. If the task's check.md says BLOCK, stop and explain why.
3. Commit only this task's files. Leave other changes in place and report how many were left; ask only when you cannot tell whether a file belongs to the task. Split into several commits only when the changes are independent of each other, because the gate builds the whole working tree, not each commit.
4. Messages: follow the repository's style (`git log -10 --format=%s`) and any commit rules in the user's or project's instructions. Otherwise use Conventional Commits, `type(scope): summary`, with the summary in the user's language.
5. Run `git add <files>` and `git commit` without asking again. The commit gate runs before each commit:
   - If it blocks, report the failing command and the tail of its output, do not bypass it, and stop.
   - If `am-gate.json` exists at the repository root but no "am gate: pass" line came back, tell the user in one line that the gate hook did not run (in Codex, trust the hook from the hooks list; check that `node` is installed).
6. Push only in push mode, and only if no commit was blocked or failed. With nothing to commit, push mode still pushes the existing local commits.
   - First list the commits that will go out (`git log --oneline @{u}..HEAD`; without an upstream, the commits not on any remote branch) and say if any were not made in this run.
   - Run `git push` to the branch's upstream; without one, `git push -u origin <branch>`. With no remote or a detached HEAD, do not push and say why.
   - Never force push or skip hooks. If the push is rejected because the remote has newer commits, do not pull, merge or rebase; report it and stop.
7. Reply with each commit's hash and message, what was left uncommitted, and in push mode where it was pushed (or why not).
