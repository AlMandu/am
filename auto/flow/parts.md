This file is not a skill: am-auto:one and am-auto:agent read it while they run, after `flow/run.md`. In it, "this skill" means the skill that reads it, "step N" refers to `flow/run.md`, and "loop step N" to the numbered loop below; each `- Loop step N:` line of the reading skill's `## Parts` section adds to that loop step (`- Loop start:` to the sentence that starts the loop).

## Parts
A plan of 2 or more implementation runs is never implemented whole; each part runs as a task of its own.
- If the whole request is a part slug (its `.am/<slug>/request.md` starts with `Part <k> of <N> of .am/<parent>/plan.md:`), resume the parent slug instead.
- After the plan, and when you resume a plan, a Scale of 1 implementation run goes on as `flow/run.md` says; 2 or more replace its steps 4 to 6 (the do, check and commit stages) with these Parts.
- The plan holds a section headed exactly `## Parts` right after the Summary, with one line per part in exactly this form: `- Part <k>: Steps <a>-<b> — <the part's scope in one line>`. The parts take consecutive Steps in order and together cover every Step, each at most one implementation run; the lines never start with a number and never carry a done mark.
- From the first Part line with no `- Part <k> done:` line in the parent's Change log, in order:
  1. Tell the user in one plain line `Part <k>/<N>: <slug>-p<k>` and the part's scope.
  2. If `.am/<slug>-p<k>/request.md` is missing, write exactly `Part <k> of <N> of .am/<slug>/plan.md: <that Part line>. Plan only this part; the parent plan holds the whole design and its decisions.` as a new file; if the folder's request.md does not start with `Part <k> of <N> of .am/<slug>/plan.md:`, stop.
  3. Run this skill's stage flow for the part (its `## Parts` section says which) with exactly `<slug>-p<k>` as the slug (its resume rules included). In push mode each part's commit stage pushes.
  4. When its commit stage ends `COMMITTED` or `NOTHING` (without stages: when the am:commit skill commits or finds nothing to commit), log `- Part <k> done: <slug>-p<k>` in the parent's Change log (with this skill's command when its `## Parts` section gives one) and go to the next part. A part that stops stops this skill with its reason.
