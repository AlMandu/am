---
name: one
description: "am-auto:multi 처럼 요청 하나를 계획 → 구현 → 점검 → 커밋까지 중간 질문 없이 이어 갑니다. Claude Code 에서는 단계마다 새 세션을 띄우는 대신 한 세션을 이어 쓰되 다음 단계의 모델이 바뀌면 그 단계는 새 세션으로 시작하고, 대화가 맥락 창의 20% 이상이면 먼저 압축한 뒤 그래도 넘을 때만 새 세션으로 시작하며, 큰 작업도 am-orchestrator 에 넘기지 않고 부분으로 나눠 그 세션에서 차례로 돕니다. 세션 이어 쓰기는 Claude Code 에서만 합니다. 기존 slug 를 주면 남은 단계부터 이어 가고, 맨 앞에 push 를 붙이면 push 까지 합니다."
argument-hint: "[push] <만들거나 고칠 내용 | 기존 slug>"
disable-model-invocation: true
model: opus
effort: medium
---

# am-auto:one

Request: $ARGUMENTS

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

## How this skill runs
Read `${CLAUDE_PLUGIN_ROOT}/flow/run.md` (if the placeholder was not replaced, `flow/run.md` under the plugin root, the folder two levels above this SKILL.md) and follow its rules and Steps, with the Request above as its request and this skill's `${CLAUDE_PLUGIN_ROOT}` wherever that file names it (inside the four skill files of its step 2, the folder that step names). If it cannot be read, change no file and stop. Read `${CLAUDE_PLUGIN_ROOT}/flow/parts.md` the same way (if the placeholder was not replaced, `flow/parts.md` under the plugin root) and follow it too; the `## Parts` section below adds to its loop. These additions apply:
- Read `${CLAUDE_PLUGIN_ROOT}/flow/stage-sessions.md` the same way (if the placeholder was not replaced, `flow/stage-sessions.md` under the plugin root) and follow its stage sessions section.
- If the plan's Change log already has a `Hand-over:` line, stop and tell the user to continue with the am-auto:multi skill.
- Add `--solo` to every `stage.mjs` command of this task (`--solo=<slug>` for a part, below), next to `--push` and `--fix`, also when a stage runs again after `WAIT` or `NEEDS_DECISION` and when you resume.
- Read "a fresh session" for each stage as: the stages continue one session; between stages the runner starts the stage in a new session when it runs on another model than the last stage, the conversation still fills 20 percent or more of the context window after the runner compacted it, or the same stage last ended BLOCKED or failed (its result then says why). "Run this skill again" means the am-auto:one skill.

## Parts
- When you plan in this session (no stage sessions), write the `## Parts` section yourself. If the plan stage ends without it, run the plan stage once more; still none stops.
- Loop step 3: the stage flow is that of `flow/stage-sessions.md` with `--solo=<slug>` (its progress command included).
- In Codex, or after `unavailable`, run the same loop in this session with the am:plan, am:do, am:check and am:commit skills (no compaction).
- When every part is done, reply by step 7 with each part's check verdict and commits, and, for each stage result whose `solo` is not null and whose `fresh` is not null, why a new session was started and whether it was given the saved context (`context`). If you stopped, the way to continue is this skill with the parent slug (`push <slug>` in push mode).
