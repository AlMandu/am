---
name: check
description: "Checks finished work before a commit: runs the project's gate commands, verifies behavior at runtime where the agent can, and reviews the diff against the plan. Use when the user asks to verify, test or check changes, or runs am:check. Warnings never block a commit; only gate failures and confirmed defects do."
argument-hint: "[slug]"
---

# am:check

Target: $ARGUMENTS

<!-- am:common:start -->
## Working with the user
- Reply in the user's language. Lead with a one-line conclusion, then what changes in terms the user sees (screen, behavior, data), then what the user needs to do and the next step.
- Keep file paths, line numbers and internal labels in the files you write, not in chat. Use plain words that fit the reader; avoid heavy analogies.
- Ask only what only the user can decide: what they will see or feel, what is in or out of scope, and choices that are hard to undo. Ask at most 3 questions at a time, each with 2-4 options and your recommendation first; use a structured question tool if one exists, otherwise number the options. For technical choices, apply your recommendation and list it under "Defaults applied".
- Never edit or revert changes you did not make (the user's or another session's). Mention them only if they block the work.
- Refer to other am skills by name, e.g. "the am:check skill"; the slash or $ prefix differs per tool.
<!-- am:common:end -->

## Steps
1. Scope: the uncommitted changes (`git status`, `git diff HEAD`) plus `.am/<slug>/plan.md` for the slug given or used in this conversation. Without a plan, check the diff alone.
2. Gate. From the repository root run:
   `node "${CLAUDE_PLUGIN_ROOT}/hooks/gate.mjs" --run --json`
   If the placeholder was not replaced, the plugin root is the folder two levels above this SKILL.md. Give the command a 10-minute timeout, or run it in the background and wait for it to finish. Read `status`:
   - `pass`
   - `fail`: quote the failing command and the tail of its output
   - `unconfigured`: there is no am-gate.json, so no automated build or test check exists; say so
   - `error`: say what could not run
   If `node` itself is missing, report the gate as not run.
3. Runtime. Follow the project's runtime-check instructions (a "Runtime check" section in CLAUDE.md or AGENTS.md, or a file they point to). Do what you can yourself first: run the app or editor commands, read logs, capture the screen, run probes. For a bug fix, repeat the plan's reproduction and compare it with the result recorded before the fix. Hand the human only what you cannot do: at most 5 items, each "where / what to do / what they should see".
4. Review. One reviewer (a subagent if available, otherwise a separate pass by you) compares the code diff with the plan (missing, extra, different) and looks for defects. Give the reviewer code files only; list asset and generated files (.prefab, .unity, .asset, .meta, lock files) by name. Keep a finding only if it comes with a concrete failure scenario (inputs, then the wrong result).
5. Verdict:
   - BLOCK: gate `fail`, a confirmed defect, or a planned step missing without a reason.
   - NOTE: everything else, including steps dropped with a reason in the Change log or by the user. Notes never block a commit.
   Fix small, safe, local problems right away and run the gate once more. If a failure comes from files outside this task, do not fix it; report it.
6. With a slug, write `.am/<slug>/check.md` (20 lines or fewer): verdict, gate result, what you checked at runtime, the human checklist, notes.
7. Reply: the verdict in one line, then what was verified (gate, runtime, review), then the human checklist, then the next step (the am:commit skill, or what to fix).
