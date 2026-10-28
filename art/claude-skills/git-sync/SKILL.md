---
name: git-sync
description: "Unity 아트 저장소의 git 상태를 쉬운 말로 보여 주고(내 작업 / 저절로 바뀐 것 / 모르는 것), 내 작업만 골라 하나씩 스테이징해 승인 뒤 커밋하며, 허락받았을 때만 push 하고 코드 파일이 섞이면 멈춥니다. 충돌·리베이스 오류 메시지도 설명합니다. 최신화와 마스터 반영은 am-util 명령을 안내합니다. 아트 작업 중 ‘깃 상태’, ‘지금 깃 상태 봐줘’, ‘최신화’, ‘스테이징 해줘’, ‘커밋해줘 우리 작업 관련된거만’, ‘마스터에 merge 해줘’, ‘리베이스 했더니 이런 메시지가 떠’, ‘로컬 체인지가 갑자기 엄청 많이 생겼는데’, ‘올려줘’, ‘push’ 라고 하면 씁니다. 강제 push 는 하지 않습니다. Claude Code 전용입니다."
argument-hint: "[상태|커밋|올리기|설명]"
model: opus
effort: high
---

# am-art:git-sync

Argument: $ARGUMENTS

For an artist who knows little git and usually works in Fork. Four modes: **상태** (default), **커밋**, **올리기**, **설명**. With no argument, pick the mode from the artist's words ("깃 상태 봐줘" 상태, "우리 작업 관련된거만 커밋해줘" 커밋, "올려줘" 올리기, a pasted error message 설명); when unclear, ask.

Not this skill's job: bringing the branch up to date or merging into the base branch (the am-util skills, see Update and merge), force push, rewriting history.

<!-- am:shared:art:start -->
## Working with the owner
- Ask the owner with AskUserQuestion, one question at a time, as a pick from options; put your recommendation first and end its label with "(추천)".
- Show every result and evidence file one per line as a Markdown link: text is the absolute path as Windows writes it, target is its `file:///` URI with `/` separators and percent-encoded spaces and non-ASCII (`[<absolute path>](file:///<encoded path>)`).
- Read and write per-PC values only with the Bash tool through `node "${CLAUDE_PLUGIN_ROOT}/scripts/art-settings.mjs"` (`get <key>`, `get deployTools.<name>`, `set <key> <value>`, `show`); never write art.json any other way. A missing value (exit 3), unless the skill says otherwise: ask the owner for it, one at a time, and `set` it; when `set` fails, stop and report its line. Never write those values into any other file.
- When an owner request conflicts with the package documents, the settings copy or these rules, say where it conflicts and offer an alternative; never simply agree.
<!-- am:shared:art:end -->

## Always
- When the artist asks only for an answer or an opinion ("대답만", "의견만"), answer without running anything.
- After every git command, say in one plain Korean line what it did.
- The repository is `git rev-parse --show-toplevel` (call it `<repo>`); when it is not a git repository, say so and stop. Run git as `git -c core.quotepath=off …` so Korean names show as they are.
- Never `git add -A`, `git add .` or `git add -u`; paths always go after `--`. Never `--no-verify`, never `--force` or `--force-with-lease`.
- Destructive commands (`reset --hard`, `checkout -- <path>`, `restore` of the working tree, `clean`, `branch -D`, `stash drop`): say what will be lost, in plain words, and run them only after the artist approves.
- The per-repository list of paths that change by themselves lives in art.json, read and written only through `node "${CLAUDE_PLUGIN_ROOT}/scripts/art-settings.mjs"`: `auto list <repo>`, `auto add <repo> <pattern>`, `auto remove <repo> <pattern>`, `auto match <repo>` (paths on standard input, one per line; prints `<path>` and the matching pattern, tab-separated).
- Code files: a path ending in `.cs`, `.asmdef`, `.asmref`, `.dll`, `.so`, `.shader`, `.cginc`, `.hlsl`, `.compute`, `.js`, `.ts`, `.py`, `.lua`, `.java`, `.kt`, `.c`, `.cpp`, `.h`, `.m`, `.mm`, or any other script or source file. The code check of a commit range is `git -c core.quotepath=off diff --name-only <range> -- "*.cs" "*.asmdef" "*.asmref" "*.dll" "*.so" "*.shader" "*.cginc" "*.hlsl" "*.compute" "*.js" "*.ts" "*.py" "*.lua" "*.java" "*.kt" "*.c" "*.cpp" "*.h" "*.m" "*.mm"`, then a look at the full `--name-only` list for other sources; any output means code is in it.

## 상태 (default)
1. `git fetch origin`; when it fails, say the numbers below are from the last fetch.
2. The current branch (`git branch --show-current`), origin's default branch `<default>` (`git symbolic-ref --short refs/remotes/origin/HEAD` prints `origin/<default>`; drop the `origin/`; else ask), and ahead/behind with `git rev-list --left-right --count HEAD...origin/<default>` and, when the branch has an upstream, `"HEAD...@{u}"` (always quote `@{u}`: PowerShell reads it unquoted as a hashtable). Say whether the local default branch has diverged from origin's (`git rev-list --left-right --count <default>...origin/<default>`, both numbers above 0).
3. Changed files: `git -c core.quotepath=off status --porcelain`, and for matching the full lists `git -c core.quotepath=off diff --name-only HEAD` and `git -c core.quotepath=off ls-files --others --exclude-standard`. Sort every path into three groups:
   - **저절로 바뀐 것 후보**: the usual Unity ones (`Packages/`, a `.meta` whose diff has no real content change, automatic entries under `ProjectSettings/`, `.omc/`, untracked recording or capture folders, merge leftovers such as `*.orig` and `*_BACKUP_*`, `*_BASE_*`, `*_LOCAL_*`, `*_REMOTE_*`), plus every path `auto match <repo>` prints when both lists above go to its standard input. A match is only a candidate: look at the diff and give a short reason.
   - **내 작업**: files changed in this conversation and files the artist named.
   - **모르는 것**: the rest.
4. Report the counts and a few typical files per group in plain words.

## 커밋
1. Show the 내 작업 list. For each path, `git log -3 --format=%an%x09%ad -- <path>`; when someone other than the artist (`git config user.name`, `git config user.email`) changed it recently, say so and ask whether to include it.
2. When other files are already staged (`git diff --cached --name-status`), say so and ask whether to take them out with `git restore --staged -- <path>`.
3. Stage one path at a time with `git add -- <path>`, then show the final list from `git diff --cached --name-status`.
4. Propose a one-line message in the form of the artist's recent commits (`git log --author=<email> -10 --format=%s`), and ask in one question: "제가 할까요, 직접 하실래요?" (커밋은 제가 / Fork 에서 직접). Commit only on the first answer, with `git commit -m "<message>"`. When a hook blocks it, explain the reason from its output in plain words.
5. 저절로 바뀐 것: ask whether to put them back (say what is lost, then approval). When Fork cannot do it, the commands: a tracked file `git restore -- <path>`; an untracked one is only left out of the commit, and deleting it (to the recycle bin) only after approval.
6. When the artist confirms a file "저절로 바뀐 거야", propose one pattern (the exact path, `폴더/`, or `**/*.확장자`, whichever fits), and after approval run `auto add <repo> <pattern>`; a pattern added by mistake goes with `auto remove <repo> <pattern>`. When the command fails, report its line.

## 올리기
- Only when the artist asked in this conversation to push; a commit request is not permission to push.
- Show the commits that would go out (`git log --oneline "@{u}..HEAD"`) and their files (`git -c core.quotepath=off diff --name-only "@{u}..HEAD"`). With no upstream, say a new remote branch will be made, use `origin/<default>..HEAD` as the range, and ask before `git push -u origin <branch>`.
- Run the code check on that range. With any code file, do not push: name the code files and stop.
- Otherwise `git push`. When it is rejected, do not pull or merge: say in plain words that origin has newer commits, and point to the am-util:update-branch skill.

## Update and merge
- "최신화": tell the artist to type the am-util:update-branch skill themselves (only the user can invoke it). "마스터에 merge": first run the code check on `origin/<target>..HEAD`, and with code files stop as in 올리기, because the am-util:land skill also pushes; otherwise tell the artist to type the am-util:land skill. When those commands do not exist, say am-util must be installed.
- When the artist comes back after the merge: for the merge commit `M` with parents `P1` (the base branch side) and `P2`, take the files both sides changed (`git diff --name-only $(git merge-base P1 P2) P1` and the same for `P2`, the paths in both), and for each check with `git diff P1 M -- <path>` that the base branch's recent changes were not lost. When something was lost, tell the artist which file and what; do not fix it.

## 설명
- From `git status` and the pasted message, explain the conflict, the rebase error or "<default> and origin/<default> have diverged" in plain words: what happened, what is safe now.
- Offer choices: stop the operation with `git rebase --abort` or `git merge --abort` (recommended), bring the branch up to date with the am-util:update-branch skill, or ask a developer. Destructive choices follow Always.

## Report
One-line conclusion, the three groups as a table or a list, then one question about the next step.
