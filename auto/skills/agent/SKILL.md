---
name: agent
description: "am-auto:multi 처럼 요청 하나를 계획 → 구현 → 점검 → 커밋까지 중간 질문 없이 이어 갑니다. Claude Code 에서는 단계마다 이 세션의 서브에이전트(단계 에이전트)를 띄워 진행만 맡고, 단계가 끝날 때마다 채팅에 한 줄만 남깁니다. 터미널을 닫으면 멈추고 기존 slug 를 주면 남은 단계부터 이어 가며, 맨 앞에 push 를 붙이면 push 까지 합니다."
argument-hint: "[push] <만들거나 고칠 내용 | 기존 slug>"
disable-model-invocation: true
model: opus
effort: medium
---

# am-auto:agent

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

<!-- am:shared:sibling-runs:start -->
## How this skill runs
Read `${CLAUDE_PLUGIN_ROOT}/flow/run.md` (if the placeholder was not replaced, `flow/run.md` under the plugin root, the folder two levels above this SKILL.md) and follow its rules and Steps, with the Request above as its request and this skill's `${CLAUDE_PLUGIN_ROOT}` wherever that file names it (inside the four skill files of its step 2, the folder that step names). If it cannot be read, change no file and stop. These additions apply:
- If the whole request is a part slug (its `.am/<slug>/request.md` starts with `Part <k> of <N> of .am/<parent>/plan.md:`), resume the parent slug instead.
- After the plan, and when you resume a plan, a Scale of 1 implementation run goes on as that file says; 2 or more replace its steps 4 to 6 (the do, check and commit stages) with Parts (below).
<!-- am:shared:sibling-runs:end -->
- If the plan's Change log has a `Hand-over:` line (with stage agents: `.am/<slug>/progress.jsonl` holds a `stage: "handover"` event, `"stage":"handover"`), stop and tell the user to continue with the am-auto:multi skill.
- Read "a fresh session" for each stage as "a fresh stage agent"; "run this skill again" means the am-auto:agent skill.

## Stage agents (Claude Code)
In Claude Code with the Agent and Bash tools, when `${CLAUDE_PLUGIN_ROOT}/scripts/agent-stage.mjs` exists, steps 3 to 6 each run as a stage agent, a subagent of this session, and step 2 is skipped; otherwise (Codex, no such tool or file) follow the single-session flow of `flow/run.md`, with Parts in this session. This session only drives: until the last stage ends or you stop, never read the reply files, check.md, do-result.md, opinion or codex files or plan.md; only the commands and Grep patterns below touch them, and you write no brief.
- A new request: pick a short kebab-case slug not under `.am/`, write the request word for word to `.am/<slug>/request.md` as a new file, start with the plan stage.
- To resume: take the last `"ev":"end"` line of `.am/<slug>/progress.jsonl` and act on its `stage` and `status` by the list below: none, or a stage or status not in it, means the plan stage; `NEEDS_DECISION` starts at `card` (its exit code 2, no open card left, runs that stage again, once, as below); `BLOCKED` or `failed` runs that stage again. If plan.md exists but request.md does not, first write exactly `Continue the existing plan in .am/<slug>/plan.md.` to `.am/<slug>/request.md`.
- Each stage: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-stage.mjs" start <stage> <slug>` (`plan`, `do`, `check` or `commit`; add `--push` in push mode, `--fix` and `--part` where said) from the repository root in the foreground with a 10-minute timeout. It prints one JSON line with `agent`, `rules`, `skill`, `runId`, `model`, `effort`, `wait`, `note` and `error`. `error`: stop with it. `wait`: tell the user in one line, again when it changes, and run the same command again. `note`: tell the user once. Then call the Agent tool with `subagent_type` set to its `agent`, its `model` and `effort`, and exactly this prompt: `slug <slug>; stage <stage>; runId <runId>; rules file <rules>; SKILL.md <skill>`. Wait for its result (its completion notice when it runs in the background) and do nothing else meanwhile.
- The stage's status is the result's last line `AM_STAGE: <status> <runId>`, only with the runId `start` printed. With no such line (or an Agent error), run `node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-stage.mjs" end <slug> <runId> failed` and the same stage once more; no line again ends it the same way and stops. Otherwise run `node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-stage.mjs" end <slug> <runId> <status>`, take the `status` it prints (yours when that is null) and tell the user in one plain line the stage and that status.
- Act on it:
  - `READY` (plan): Grep `.am/<slug>/plan.md` for the Scale line `^(- )?(Scale: [0-9]+ implementation run|규모: 구현 [0-9]+회)` and the Part lines `^- Part [0-9]+: Steps`. Part lines: Parts (below). A Scale of 2 or more with none: the plan stage once more; still none stops. Else the do stage.
  - `DONE` (do): check. `NOTE` (check): commit. `COMMITTED` or `NOTHING` (commit): step 7.
  - `BLOCK` (check): run the do stage with `--fix`, then check once more; still `BLOCK` stops (step 5).
  - `NEEDS_DECISION`: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-stage.mjs" card <slug>` and ask what it prints, as written (a stop of `flow/run.md`); write the user's answer word for word as a new file `.am/<slug>.answer-<n>.md` (the first unused n from 1), run `node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-stage.mjs" answer <slug> <that file>`, then the same stage again with the same flags. `card` ending with exit code 2 runs the same stage again once, and stops when it ends that way again; any other failure of `card` or `answer` stops with what it printed.
  - `BLOCKED` or `failed` (any stage): stop with the stage and its status.
- Step 7: only now read plan.md, check.md and `.am/<slug>/reply-*.md`, and reply by step 7 of `flow/run.md`.

<!-- am:shared:sibling-parts:start -->
## Parts
A plan of 2 or more implementation runs is never implemented whole; each part runs as a task of its own.
- The plan holds a section headed exactly `## Parts` right after the Summary, with one line per part in exactly this form: `- Part <k>: Steps <a>-<b> — <the part's scope in one line>`. The parts take consecutive Steps in order and together cover every Step, each at most one implementation run; the lines never start with a number and never carry a done mark.
<!-- am:shared:sibling-parts:end -->
- The plan stage writes the `## Parts` section; in the single-session flow write it yourself.
- From the first Part line with no `- Part <k> done:` line in the parent's Change log (Grep `^- Part [0-9]+ done: `), in order:
  1. Tell the user in one plain line `Part <k>/<N>: <slug>-p<k>` and the part's scope.
  2. If `.am/<slug>-p<k>/request.md` is missing, write exactly `Part <k> of <N> of .am/<slug>/plan.md: <that Part line>. Plan only this part; the parent plan holds the whole design and its decisions.` as a new file; if the folder's request.md does not start with `Part <k> of <N> of .am/<slug>/plan.md:`, stop.
  3. Run the stage flow above with exactly `<slug>-p<k>` as the slug and `--part` on every `start` (its resume rule included). In push mode each part's commit stage pushes.
  4. When its commit stage ends `COMMITTED` or `NOTHING` (single-session flow: when the am:commit skill commits or finds nothing to commit), log the part with exactly this command from the repository root and go to the next part; an exit code other than 0 stops: `node -e 'const fs=require("fs"),[f,l]=process.argv.slice(1),t=fs.readFileSync(f,"utf8"),n=t.includes("\r\n")?"\r\n":"\n",a=t.split(n);if(a.includes(l))process.exit(0);const c=a.indexOf("## Change log");if(c<0)process.exit(1);let i=a.findIndex((x,j)=>j>c&&x.startsWith("## "));if(i<0)i=a.length;while(i>c+1&&a[i-1]==="")i--;a.splice(i,0,l);fs.writeFileSync(f,a.join(n))' .am/<slug>/plan.md '- Part <k> done: <slug>-p<k>'`. A part that stops stops this skill with its reason.
- In the single-session flow, run the same loop in this session with the am:plan, am:do, am:check and am:commit skills.
- When every part is done, reply by step 7 with each part's check verdict and commits. If you stopped, the way to continue is this skill with the parent slug (`push <slug>` in push mode).
