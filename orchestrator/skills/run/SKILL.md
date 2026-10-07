---
name: run
description: "큰 설계 문서를 작은 작업으로 나누고, 작업마다 am 의 계획 → 구현 → 점검 → 커밋을 별도 세션으로 끝까지 돌립니다. 준비·분할·실행·재개는 이 세션이 알아서 하고, 사용자만 답할 수 있는 것이 생겼을 때만 멈추고 묻습니다. 인자를 비우면 진행 중인 실행을 이어 가고, `sessions 2` 처럼 주면 이 PC 에서 동시에 돌릴 세션 수를 바꿉니다. Claude Code 전용이고 am 플러그인이 함께 설치돼 있어야 합니다."
argument-hint: "<설계 문서 경로 | sessions [개수|default] | 비우면 진행 중인 실행을 이어 감>"
disable-model-invocation: true
model: opus
effort: medium
---

# am-orchestrator:run

Request: $ARGUMENTS

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

## What you are driving
The orchestrator is a Node script. It splits a design document into small tasks and, for each task, runs the am:plan, am:do, am:check and am:commit skills in separate `claude -p` sessions, with the project's gate between them, on a branch of its own, without pushing. Tasks that do not depend on each other and expect to touch different files run at the same time, up to `parallel` in the config (default 3) and never more `claude` sessions than the limit for this whole PC, shared by every run in every repository (`sessions`, default 3; a run waits for a free place when other runs hold them all): each one is implemented in its own git worktree under `.orchestrator/wt/` and combined into the run branch when it is committed. A task that runs alone uses the repository itself. Running this skill is the user's request for the whole run, including the commits. You drive it from start to finish and stop only to ask what only the user can answer.

Run it from the repository root: `node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.mjs" <command>`. If the placeholder was not replaced, the plugin root is the folder two levels above this SKILL.md.

| Command | What it does |
|---|---|
| `doctor` | checks the claude command, the am plugin and the gate; creates the config on first use |
| `split <file>` | turns the design document into a task list |
| `status --json` | the state, and what to do next |
| `decide <id> "<answer>"` | records the answer to a decision from the task list |
| `answer <task> "<answer>"` | answers a question that a task's plan raised and finishes that plan |
| `run` | runs every task that can run, unrelated ones at the same time; resumes where it stopped |
| `retry <task> --from plan\|implement\|check\|commit` | puts a blocked task back at that stage |
| `done <task>` | marks a task the user finished by hand as done |
| `sessions [<N>\|default]` | shows or sets how many `claude` sessions the orchestrator may run at once on this PC, across all runs; `default` goes back to the built-in value |

Rules while driving:
- `doctor`, `split`, `answer` and `run` start builds or model sessions and take minutes to hours. Start each one in the background, tell the user in one line that it is running, and go on when its completion notice arrives. Do not poll in a loop. Never start a command while another is running; the script refuses a second one. `sessions` is the exception: it may run at any time, and a new limit applies from the next session any run starts.
- While `split` or `run` is running, other sessions are changing this repository and its worktrees under `.orchestrator/wt/`. Do not edit, stage, commit, stash or switch branches, and do not open the project in an editor that the gate builds with.
- After every command read `status --json` and act on its `next` field. It is the only source of truth: under `.orchestrator/` edit nothing but `config.json`, in step 3 `tasks.json`, and in step 4 the plan.md of a task blocked on a split choice.
- Never push or merge. Do not use the am skills yourself on these tasks; the script runs them.
- Choices the run made for the user (marked "(auto-decided)" in the plans) are reported at the end, not asked.

## Steps
1. Request. Empty: continue the run in progress from step 4; if `status --json` says `next` is `doctor` or `split`, there is none, so ask for the design document and stop. A path to an existing file: a new run with that document. Exactly `sessions`, `sessions <N>` or `sessions default`: run that command, tell the user the limit it shows, and stop (if you are driving a run in this conversation, go back to step 4 instead). Anything else: ask which document to use and stop.
2. Prepare. Run `doctor` and read its output. Remove what you can without deciding anything for the user, then run it again:
   - tracked files that it says the gate rewrites: add them to `volatilePaths` in `.orchestrator/config.json`;
   - a name in `requiredGateCommands` that is not in `am-gate.json`: correct the name;
   - the gate does not pass in a separate worktree because a folder the repository ignores is missing there (installed dependencies, for example): add the command that recreates it to `worktreeSetup` (`ORCH_MAIN_REPO` holds this repository's path). For any other cause leave it; the run then goes one task at a time.
   Ask the user, with a decision card, only about these:
   - there is no `am-gate.json`: which build and test commands must pass before each commit (then write the file and commit it);
   - uncommitted changes you did not make: commit them first, set them aside, or stop;
   - the gate already fails before the run has changed anything.
   If the claude command or the am plugin is missing, say how to install it and stop.
3. Split. Run `split <file>`. Before spending a run on the result, read the task list (`run.tasks` in the status): every file a task names exists or is created by an earlier task, and nothing the design asks for is left out without a reason. Correct plain mistakes in `tasks.json` yourself (a wrong path, a wrong order); do not add, drop or reshape scope. Tell the user in two or three lines what will be built, in how many tasks and how many at a time (`parallel` in the status, with its reason when it is 1), then go on without waiting.
4. Loop: read `status --json` and follow `next` until it is `done` or you have to stop.
   - `decide`: `decisions` holds the questions the design leaves to the user, already written as decision cards. Ask them (rules above, at most 3 at a time) and record each answer with `decide`.
   - `answer`: a plan found a question only the user can answer. Read the file in `needsDecision[].file`, ask it as a decision card, and pass the answer with `answer`.
   - `blocked`: read `blocked[].reason` and the files it names under `blocked[].logs`. A task blocked in its own worktree keeps its changes in `blocked[].workspace`; anything done by hand for it happens in that folder. If the cause lies outside the task and you can remove it without deciding anything for the user (the gate could not run, a usage limit that has reset, an editor left open, a file a build rewrote), remove it and follow `blocked[].hint`, once per task. If the task's plan (`.am/<slug>/plan.md`, slug from `run.tasksJson`, inside `blocked[].workspace` when it is set) holds an OPEN card for a technical choice its two reviewers split on, ask that card, replace the card in place with the answer marked as the user's decision, and run `retry <task> --from implement`. Otherwise ask the user with a card: retry from a named stage, let them fix it by hand and mark it done, or stop the run here.
   - `fix-tasks`: `errors` lists what is wrong in `tasks.json`; correct it.
   - `run`: start `run` and wait. Exit code 0: every task is done. 1: questions or blocked tasks remain; go round the loop. 2: it stopped on an error; read the message. For a usage limit, say when the user can continue (this skill with no argument) and stop. Otherwise remove the cause and run again once; if it fails again, stop and report. 3: an internal error; report it and stop. 130: it was interrupted; say so and that this skill with no argument continues.
   - `wait`: a command is still running (`running.tasks` names each running task and its stage). Wait for its completion notice.
   - `doctor` or `split`: go back to step 2 or 3.
   - `stuck`: no task can run and none is waiting for an answer. Report what `status` (without `--json`) shows and stop.
5. Final reply, when `next` is `done` or when you stop:
   - the conclusion in one line: how many of how many tasks are done, on which branch, nothing pushed;
   - what was decided for the user: every line of `autoDecided` in plain words, or none;
   - what the user must check by hand: the checklist section of the report at `run.report`, shortened to what matters, with the path for the rest;
   - what is still open (a blocked task, an unanswered question) and how to continue: this skill with no argument;
   - the cost estimate from `costUsd`, and the next step, which is the user's: look at the result, then merge.
