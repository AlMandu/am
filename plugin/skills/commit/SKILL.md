---
name: commit
description: "이번 작업의 변경만 논리 단위로 커밋합니다(커밋 게이트 통과 후). 사용자가 커밋·저장·마무리를 요청하거나 am:commit 을 실행할 때 씁니다. push 는 하지 않습니다."
argument-hint: "[메모]"
---

# am:commit

Notes: $ARGUMENTS

<!-- am:common:start -->
## Working with the user
- Reply in the user's language. Lead with a one-line conclusion, then what changes in terms the user sees (screen, behavior, data), then what the user needs to do and the next step.
- Keep file paths, line numbers and internal labels in the files you write, not in chat. Use plain words that fit the reader; avoid heavy analogies.
- Ask only what only the user can decide: what they will see or feel, what is in or out of scope, and choices that are hard to undo. Ask at most 3 questions at a time, each with 2-4 options and your recommendation first; use a structured question tool if one exists, otherwise number the options. For technical choices, apply your recommendation and list it under "Defaults applied".
- Never edit or revert changes you did not make (the user's or another session's). Mention them only if they block the work.
- Refer to other am skills by name, e.g. "the am:check skill"; the slash or $ prefix differs per tool.
<!-- am:common:end -->

## Steps
1. Commit only if the user asked for a commit in this conversation; running this skill counts. If you picked this skill on your own, propose the commit and stop.
2. Collect `git status --porcelain`. Leave out `.am/` and ignored files. Exclude anything that looks secret (.env, credentials, keys, *.pem) and say so. If `.am/<slug>/check.md` for this task says BLOCK, stop and explain why.
3. Commit only this task's files. Leave other changes in place and report how many were left; ask only when you cannot tell whether a file belongs to the task. Split into several commits only when the changes are independent of each other, because the gate builds the whole working tree, not each commit.
4. Messages: follow the repository's style (`git log -10 --format=%s`) and any commit rules in the user's or project's instructions. Otherwise use Conventional Commits, `type(scope): summary`, with the summary in the user's language.
5. Run `git add <files>` and `git commit` without asking again. The commit gate runs before each commit:
   - If it blocks, report the failing command and the tail of its output, do not bypass it, and stop.
   - If `am-gate.json` exists at the repository root but no "am gate: pass" line came back, tell the user in one line that the gate hook did not run (in Codex, trust the hook from the hooks list; check that `node` is installed).
6. Never push. Reply with each commit's hash and message, and what was left uncommitted.
