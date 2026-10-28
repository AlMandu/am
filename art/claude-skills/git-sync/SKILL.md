---
name: git-sync
description: "이 명령은 am-util 의 git-sync 로 옮겨졌습니다. 새 명령 이름과 am-util 설치·업데이트 방법만 알려 주고 깃 명령은 실행하지 않습니다. am-art 0.1.5 에서 없어집니다. Claude Code 전용입니다."
argument-hint: "[상태|커밋|올리기|설명]"
disable-model-invocation: true
---

# am-art:git-sync (moved)

Argument: $ARGUMENTS

Run no command and read no file. Answer exactly once with the Korean text below, putting the argument above in place of `<인자>` (drop it when the argument is empty), then stop.

> 이 명령은 `am-util:git-sync` 로 옮겨졌습니다. 앞으로는 `/am-util:git-sync <인자>` 를 입력해 주세요.
>
> `/am-util` 까지 쳤을 때 목록에 `git-sync` 가 없으면:
> 1. `/plugin marketplace update am-workflow` 를 입력합니다.
> 2. am-util 이 설치돼 있지 않으면 `/plugin install am-util@am-workflow`, 설치돼 있으면 `/plugin update am-util@am-workflow` 를 입력합니다. 꺼져 있으면 `/plugin` 에서 켭니다.
> 3. Claude Code 를 다시 시작합니다.
>
> 전에 등록해 둔 "저절로 바뀌는 파일" 목록은 새 명령이 그대로 이어서 씁니다.
