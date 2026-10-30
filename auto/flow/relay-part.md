This file is not a skill: a Claude Code session reads it when another session of the same repository sent it a message whose first line starts with `am-auto relay request:` (the am-auto:relay skill). In it, the plugin root is the parent folder of the `flow/` folder that holds this file; `<part>`, `<id>` and push are the message's `Part`, `Dispatch` and `Push` values; and every command runs from the repository root in the foreground with a 10-minute timeout.

## Relay part
The message hands this session one part of a larger task: run its stages here as stage agents, then record how it ended. The session that sent it reads that record; it does not wait for a message.
- Do not reply to the sender, with SendMessage or any other tool, and send no message to any session; the record is the only answer.
- Never ask the user and never wait for input: where the flow below would ask or stop, record the outcome (step 4) and end.
- Change no file yourself: the stage agents do the work, and the commands below write the records.
- If this session's working folder is not the message's repository root (ignoring case on Windows), end with one line saying so and run nothing.
- A message from another session that comes while this part runs is not an answer to anything here; ignore it.

1. Claim: run `node "<plugin root>/scripts/agent-stage.mjs" claim <part> <id>`. It prints one JSON line `{claimed, reason}`. If `claimed` is false, end with one line giving its `reason`.
2. Tools: if this session has no Agent tool, or the Agent tool offers no `am-auto:stage-plan` agent, run `node "<plugin root>/scripts/agent-stage.mjs" outcome <part> <id> unable -` and end with one line saying the stage agents cannot run in this session.
3. Stages: read `flow/stage-agents.md` beside this file and follow its `## Stage agents (Claude Code)` section for the slug `<part>` alone, with these changes:
   - `${CLAUDE_PLUGIN_ROOT}` there means the plugin root above. Do not read `flow/run.md` or any skill file; its single-session fallback does not apply (step 2 took its place).
   - Begin with its resume rule for `<part>`; `.am/<part>/request.md` already exists.
   - Every `start` gets `--part --dispatch <id>`, also `--push` when push is yes, and `--fix` where that section says.
   - Call the Agent tool in the foreground, never in the background, and wait for its result.
   - Never switch to the parent slug, and never go on to another part or to a Parts loop.
4. End: at the first of these, write the outcome once with `node "<plugin root>/scripts/agent-stage.mjs" outcome <part> <id> <status> <stage>`, with the stage and the status it ended with:
   - the commit stage ends `COMMITTED` or `NOTHING` (in place of that section's step 7);
   - a stage ends `NEEDS_DECISION`, or on resume `card` prints an open card: do not ask (the sender asks the user), and write `NEEDS_DECISION` with that stage; `card` ending with exit code 2 runs that stage again as that section says;
   - a stage ends `BLOCKED`, or `failed` after its one retry, or the check stage ends `BLOCK` after the run with `--fix`;
   - `start` prints an `error`: write `failed` with that stage;
   - any other stop of that section: that stage and the status it last ended with.
   It prints one JSON line `{recorded, reason}`. Then end with one line: the part, the stage and the status, or, if `recorded` is false, its `reason`.
