---
name: plan
description: "Plans a non-trivial change before coding: confirms intent, explores the code, asks only the decisions the user must make, and writes a short plan file. Also resumes implementation from an existing plan. Use when the user runs am:plan; small, obvious edits do not need it."
argument-hint: "<what to build or fix | existing slug>"
disable-model-invocation: true
---

# am:plan

Request: $ARGUMENTS

<!-- am:common:start -->
## Working with the user
- Reply in the user's language. Lead with a one-line conclusion, then what changes in terms the user sees (screen, behavior, data), then what the user needs to do and the next step.
- Keep file paths, line numbers and internal labels in the files you write, not in chat. Use plain words that fit the reader; avoid heavy analogies.
- Ask only what only the user can decide: what they will see or feel, what is in or out of scope, and choices that are hard to undo. Ask at most 3 questions at a time, each with 2-4 options and your recommendation first; use a structured question tool if one exists, otherwise number the options. For technical choices, apply your recommendation and list it under "Defaults applied".
- Never edit or revert changes you did not make (the user's or another session's). Mention them only if they block the work.
- Refer to other am skills by name, e.g. "the am:check skill"; the slash or $ prefix differs per tool.
<!-- am:common:end -->

## Resume an existing plan
If the argument names a slug whose `.am/<slug>/plan.md` exists and has no open decisions, implement it now by the rules at the top of that file. Do not plan again.

## Steps
1. Restate the goal in 1-3 lines from the user's point of view. Ask first only if two reasonable readings lead to different results.
2. Explore the code the change touches. For a wide search, use a read-only exploration subagent if one is available.
3. Small change (3 files or fewer, obvious result): say so, offer to do it directly without a plan file, and stop.
4. Folder: `.am/<slug>/` at the repository root. The slug is short kebab-case English; reuse a slug already used in this conversation and never guess from recent folders. If `.am/` does not exist yet and `git check-ignore -q .am` fails, create `.am/.gitignore` containing `*`. If the folder holds an older `analyze.md` or `design.md`, read only their summary and decisions.
5. Risk review, only when the change touches saved data or save formats, server or network contracts, concurrency or async ordering, data migration, security, or deletion of user data: have one independent reviewer (a subagent if available, otherwise a separate pass by you) attack the draft from at most 3 relevant angles. Keep only CRITICAL or HIGH issues that come with a concrete failure scenario and fix the plan for them; list the rest under Risks. Do not ask the user about review findings.
6. Write `.am/<slug>/plan.md` in the user's language: at most 150 lines, no full code listings, this skeleton with translated headings:

   ```markdown
   # <title>
   > Implementation rules: 1) do the Steps in order 2) run each step's check 3) for a bug, record the reproduction result before fixing it 4) log any deviation under Change log 5) when done, use the am:check skill
   ## Summary      goal, what changes for the user, main risk (8 lines or fewer)
   ## Decisions    user decisions; "Defaults applied": choice - one-line reason
   ## Files        path - what changes
   ## Steps        numbered; each ends with "Check: ..."
   ## Checks       automated (gate, tests) / agent runtime checks / human checklist (where, what to do, what they should see) / bug reproduction (steps, result before the fix)
   ## Risks        only real ones
   ## Change log
   ## Next         one line
   ```

7. Ask the open decisions (rules above). End with one line saying you will record the answers and stop, and that adding "go" to the answer continues straight into implementation. Record the answers under Decisions. If the user said go, implement by the rules in plan.md; otherwise stop with the summary and the next step.
