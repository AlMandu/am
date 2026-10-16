---
name: solo
description: "am:auto 처럼 요청 하나를 계획 → 구현 → 점검 → 커밋까지 중간 질문 없이 이어 갑니다. Claude Code 에서는 단계마다 새 세션을 띄우는 대신 한 세션을 이어 쓰되 맥락 사용량이 20% 이상일 때만 단계 사이에 압축하고, 압축으로도 부족하면 임시 맥락 파일을 남기고 새 세션으로 시작하며, 큰 작업도 am-orchestrator 에 넘기지 않고 부분으로 나눠 그 세션에서 차례로 돕니다. 압축은 Claude Code 에서만 합니다. 기존 slug 를 주면 남은 단계부터 이어 가고, 맨 앞에 push 를 붙이면 push 까지 합니다."
argument-hint: "[push] <만들거나 고칠 내용 | 기존 slug>"
disable-model-invocation: true
model: opus
effort: medium
---

# am:solo

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
Read `${CLAUDE_PLUGIN_ROOT}/skills/auto/SKILL.md` (if the placeholder was not replaced, `skills/auto/SKILL.md` under the plugin root, the folder two levels above this SKILL.md) and follow its rules and Steps, with the Request above as its request and this skill's `${CLAUDE_PLUGIN_ROOT}` wherever that file names it. If it cannot be read, change no file and stop. These differences override that file:
- Never look for, read or run the am-orchestrator run skill: skip the `claude plugin list --json` part of step 2, never hand over in step 4 (if the plan's Change log already has a `Hand-over:` line, stop and tell the user to continue with the am:auto skill), and ignore `HANDED`, every rule about the run skill or its hook, and step 7's hand-over items.
- Add `--solo` to every `stage.mjs` command of this task (`--solo=<slug>` for a part, below), next to `--push` and `--fix`, also when a stage runs again after `WAIT` or `NEEDS_DECISION` and when you resume.
- Read "a fresh session" for each stage as: the stages continue one session; between stages the runner compacts it when it fills 20 percent or more of the context window, and starts the stage in a new session when compacting is not enough or the same stage last ended BLOCKED or failed (its result then says why). "Run this skill again" means the am:solo skill.
- If the whole request is a part slug (its `.am/<slug>/request.md` starts with `Part <k> of <N> of .am/<parent>/plan.md:`), resume the parent slug instead.
- After the plan, and when you resume a plan, a Scale of 1 implementation run goes on as that file says; 2 or more replace its steps 4 to 6 (in stage sessions: the do, check and commit stages) with Parts (below).

## Parts
A plan of 2 or more implementation runs is never implemented whole; each part runs as a task of its own.
- The plan holds a section headed exactly `## Parts` right after the Summary, with one line per part in exactly this form: `- Part <k>: Steps <a>-<b> — <the part's scope in one line>`. The parts take consecutive Steps in order and together cover every Step, each at most one implementation run; the lines never start with a number and never carry a done mark. When you plan in this session (no stage sessions), write it yourself. If the plan stage ends without it, run the plan stage once more; still none stops.
- From the first Part line with no `- Part <k> done:` line in the parent's Change log, in order:
  1. Tell the user in one plain line `Part <k>/<N>: <slug>-p<k>` and the part's scope.
  2. If `.am/<slug>-p<k>/request.md` is missing, write exactly `Part <k> of <N> of .am/<slug>/plan.md: <that Part line>. Plan only this part; the parent plan holds the whole design and its decisions.`; if the folder's request.md does not start with `Part <k> of <N> of .am/<slug>/plan.md:`, stop.
  3. Run that file's stage flow with exactly `<slug>-p<k>` as the slug and `--solo=<slug>` (its resume rules and progress command included). In push mode each part's commit stage pushes.
  4. When its commit stage ends `COMMITTED` or `NOTHING` (without stage sessions: when the am:commit skill commits or finds nothing to commit), log `- Part <k> done: <slug>-p<k>` in the parent's Change log and go to the next part. A part that stops stops this skill with its reason.
- In Codex, or after `unavailable`, run the same loop in this session with the am:plan, am:do, am:check and am:commit skills (no compaction).
- When every part is done, reply by step 7 with each part's check verdict and commits, and, for each stage result whose `solo` is not null and whose `fresh` is not null, why a new session was started and whether it was given the saved context (`context`). If you stopped, the way to continue is this skill with the parent slug (`push <slug>` in push mode).
