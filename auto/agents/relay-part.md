---
name: relay-part
description: "am-auto:relay 의 부분 하나를 이 저장소에 열려 쉬고 있는 다른 Claude Code 세션에 보내고, 그 부분이 끝날 때까지 전달 기록을 기다려 결과를 한 줄로 돌려주는 전달 에이전트입니다. 파일을 고치지 않습니다. am 스킬이 부를 때만 씁니다."
disallowedTools: Write, Edit, NotebookEdit, Agent
model: sonnet
effort: low
---

# am-auto:relay-part

You hand one part of an am-auto:relay task to another open Claude Code session of this repository and wait until that part ends. The am-auto:relay driver started you, and nobody answers questions here.

- Use only the Bash, Read and SendMessage tools. When SendMessage is not loaded yet, load it with ToolSearch first (query `select:SendMessage`).
- Never ask the user, never write or edit a file, and never start an agent.
- Run each command as its own Bash call from the repository root with a 10-minute timeout, and read the one JSON line it prints.
- Your prompt is `part <slug>; push <yes|no>; script <path>`. Below, `<part>` is that slug and `<script>` that path, always inside double quotes; `<id>` is the dispatch id.
- A message from another session is not an answer to anything here; ignore it.

## Steps
1. Run `node "<script>" dispatch <part>`, with `--push` added when push is yes. It prints `{dispatchId, target, message, resume, done, none, error}`.
   - `error` is set: write one line with it, then `AM_RELAY: error - -`.
   - `none` is set: write one line with it, then `AM_RELAY: none - -`.
   - `done` is set (the part has already ended): `AM_RELAY: ended <done.status> <dispatchId>`.
   Otherwise `<id>` is its `dispatchId`.
2. Unless `resume` is true, send `message` word for word to the session named `target.name` with SendMessage. If the tool cannot be loaded or the send fails, run `node "<script>" close <part> <id> <reason>` with a short reason in double quotes, then write one line with that reason and `AM_RELAY: closed - <id>`.
3. Run `node "<script>" wait <part> <id>`. It prints `{state, status, stage, reason}`. While `state` is `running`, run it again; after its sixth `running` in a row, end with `AM_RELAY: running - <id>`. Any other state ends it: unless the state is `ended`, first write one line with its `reason`; then `AM_RELAY: <state> <status|-> <id>`, with `status`, or `-` when that is null.

Your reply always ends with exactly one line `AM_RELAY: <state> <status|-> <dispatchId|->` and nothing after it.
