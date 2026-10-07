---
name: compactmem
description: "구현·점검을 마친 작업에 관한 Claude Code 자동 메모리(MEMORY.md 와 항목 파일)를 정리합니다. 저장소에 이미 남은 항목은 지우고 앞으로도 쓸 사실은 짧게 줄이자고 제안하며, 사용자가 승인한 것만 적용합니다. am:check 와 am:commit 사이에 씁니다. Claude Code 전용입니다."
argument-hint: "[slug]"
disable-model-invocation: true
model: opus
effort: medium
---

# am:compactmem

Task: $ARGUMENTS

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

## What it tidies
Claude Code's auto memory of this project: `MEMORY.md`, an index with one line per memory, and the memory files it points to (one fact each, with frontmatter). Only the memories about the task that was just implemented and verified are in scope; every other memory stays as it is. The memory lies outside the repository and has no history, so no memory file changes without the user's approval.

## Steps
1. Where: this skill works on Claude Code's memory only, and never inside an am-orchestrator run. In another tool (Codex), or in a session the am-orchestrator started (its instructions say you are running inside am-orchestrator, or the working folder is under `.orchestrator/`), say so in one line and stop without reading or writing anything.
2. Task: `.am/<slug>/` for the slug given, or the one used in this conversation. With neither, list the folders under `.am/` that hold a plan.md and ask which one; never guess. Read its plan.md, its check.md if there is one, and the task's changes: `git status --porcelain` (new files too) and `git diff HEAD`, or once committed, the commits of this task (`git log`, `git show --stat`).
3. Memory folder: the persistent memory directory your system prompt names; if it names none, `<CLAUDE_CONFIG_DIR or ~/.claude>/projects/<repository root path with every character other than A-Z, a-z and 0-9 replaced by ->/memory/`. If the folder is missing or holds no memory file, write that to `.am/<slug>/compactmem.md`, say there is nothing to compact, and stop. Never overwrite a record already marked applied in that file; add below it.
4. Earlier proposal: keep any part of `.am/<slug>/compactmem.md` marked applied as it is, and add a new proposal below it. If it holds a proposal not marked applied, re-check each item against the current memory files. Keep an item whose memory is unchanged; drop or flag one whose memory changed or is gone. If the file cannot be read as a proposal, build a new one.
5. Proposal: read `MEMORY.md` and every memory file in the folder. For each memory about this task, pick one action:
   - delete: its content is recorded in the repository (code, CLAUDE.md, README, CHANGELOG, plan.md) or mattered only while the task was open. Name the place that records it; without one, do not propose deleting;
   - shorten: still useful later (a reason behind a decision, a non-obvious fact, a user preference). Give the new text;
   - merge: several memories hold one fact. Give the merged text and the files that go;
   - keep.
   Memories not about this task are kept and not listed. A `user` or `feedback` memory is only shortened, never deleted, unless the repository records the same rule.
   Write `.am/<slug>/compactmem.md` in the user's language: the memory folder, the date, a table with one row per item (file, action, reason, where it is recorded or the new text), and the `MEMORY.md` lines that would change.
6. Unattended run (a stage session of the am:auto skill, or any run where nobody can answer): stop here; the proposal is the result. Change no memory file.
7. Show the proposal in short (what goes, what shrinks, how many index lines `MEMORY.md` loses) and ask the user to approve all, approve some, or skip it. With nothing approved, record that in compactmem.md and stop.
8. Apply only what was approved: rewrite or delete those memory files, then update `MEMORY.md` so that every line points to an existing file and every remaining memory has its line. Touch no other memory. Mark compactmem.md as applied, with what was done.
9. Reply: what changed in the memory (counts and the main items), where the proposal is, and the next step (the am:commit skill).
