# am

Claude Code 와 Codex CLI 에서 쓰는 가벼운 개발 워크플로 플러그인입니다. 스킬 3개와 커밋 게이트 훅 1개로 되어 있습니다.

- `am:plan`: 큰 변경을 시작하기 전에 의도를 확인하고, 사용자만 정할 수 있는 것만 묻고, 짧은 계획 문서를 씁니다.
- `am:check`: 커밋 전에 빌드·테스트(게이트), 실행 확인, 계획 대비 검토를 한 번에 합니다.
- `am:commit`: 이번 작업 파일만 논리 단위로 커밋합니다. push 는 하지 않습니다.
- 커밋 게이트: 에이전트가 `git commit` 을 실행하기 직전에 프로젝트의 `am-gate.json` 명령을 돌리고, 실패하면 커밋을 막습니다.

작은 수정(파일 몇 개, 결과가 분명한 일)은 스킬 없이 그냥 요청하면 됩니다. 커밋 게이트는 그때도 동작합니다.

## 왜 이렇게 만들었나

이전에 쓰던 무거운 워크플로(단계 6개, 스킬 19종)의 실행 기록을 분석한 결과에서 나온 원칙입니다.

- 사람이 들인 수고의 대부분은 AI 오류 수정이 아니라 멈춤에 답하기, 결정 질문, 경고 처리, 어려운 출력 해독이었습니다. 그래서 질문은 화면·범위·되돌리기 어려운 선택에만 하고, 기술 선택은 추천안을 적용한 뒤 알립니다.
- 경고는 커밋을 막지 않습니다. 막는 것은 게이트 실패와 실패 시나리오가 확인된 결함뿐입니다.
- 답은 결론 → 사용자가 보는 변화 → 할 일 순서로, 내부 라벨 없이 씁니다.
- 실행 확인은 에이전트가 할 수 있는 만큼 먼저 하고, 사람에게는 "어디서·무엇을·무엇이 보이면 통과" 체크리스트만 넘깁니다.
- 가장 값진 장치였던 결정론적 게이트(실제로 빌드·테스트를 돌림)는 훅으로 남겼습니다.

세션마다 늘 드는 비용은 약 260토큰, 스킬 호출 한 번은 약 0.9~1.3k 토큰입니다(`claude plugin details am` 기준).

## 요구 사항

- Node.js 18 이상(`node` 가 PATH 에 있어야 게이트 훅이 돎)
- Claude Code 또는 Codex CLI(0.160 에서 확인)

## 설치

`<저장소>` 자리에는 로컬 경로(예: `C:\Projects\am`)나, 공개한 뒤의 GitHub 주소를 넣습니다.

**Claude Code**

```
/plugin marketplace add <저장소>
/plugin install am@am-workflow
```

**Codex CLI**

```
codex plugin marketplace add <저장소>
codex plugin add am@am-workflow
```

Codex 는 플러그인 훅을 사용자가 신뢰해야 실행합니다. 설치 뒤 Codex 를 시작하면 나오는 훅 검토 화면에서 "Trust all and continue" 를 고르거나, 세션 중 훅 목록에서 `t` 를 누르세요. 신뢰하기 전에도 스킬은 동작하지만 커밋 게이트는 돌지 않습니다. 플러그인을 업데이트해 훅이 바뀌면 다시 신뢰해야 합니다.

옛 AlMandu 툴킷(`am@almandu`)과는 이름이 같아서 함께 설치할 수 없습니다. 먼저 제거하세요.

## 사용법

| 하고 싶은 일 | Claude Code | Codex |
|---|---|---|
| 계획 세우기 | `/am:plan 0으로 나누면 오류 문구를 보여 줘` | `$am:plan ...` |
| 계획 이어서 구현(새 세션) | `/am:plan <slug>` | `$am:plan <slug>` |
| 커밋 전 점검 | `/am:check` | `$am:check` |
| 커밋 | `/am:commit` | `$am:commit` |

- `am:plan` 은 `.am/<slug>/plan.md` 를 씁니다. 질문에 답할 때 "go" 를 붙이면 바로 구현까지 이어 갑니다. `.am/` 은 자동으로 git 에서 제외됩니다(`.am/.gitignore`).
- 계획 문서 머리의 구현 규칙: 순서대로 진행, 단계마다 확인, 버그면 고치기 전 재현 기록, 계획과 다르면 변경 기록에 남김, 끝나면 `am:check`.
- `am:check` 의 판정은 BLOCK(게이트 실패, 확인된 결함, 이유 없이 빠진 계획 항목) 또는 NOTE(그 밖의 모든 것, 커밋을 막지 않음) 입니다.
- `am:commit` 은 다른 세션이나 사용자가 만든 변경을 남겨 두고, 남긴 개수를 알려 줍니다.

## 커밋 게이트 설정 (`am-gate.json`)

저장소 루트에 둡니다. 없으면 게이트는 아무것도 하지 않고, `am:check` 와 `am:commit` 이 "게이트 미설정"을 알려 줍니다.

```json
{
  "timeoutMs": 300000,
  "commands": [
    { "name": "test", "run": "npm test" },
    { "name": "lint", "run": "npm run lint", "blocking": false }
  ]
}
```

- `run` 은 Windows 에서는 cmd.exe, 그 밖에서는 `/bin/sh` 로 실행됩니다.
- `blocking` 의 기본값은 true 입니다. `false` 인 명령은 커밋 때 돌지 않고 `am:check` 에서만 돌아갑니다.
- `timeoutMs` 는 명령 하나의 제한입니다(기본 300초). 명령마다 따로 줄 수도 있습니다.
- 커밋 한 번에 쓰는 시간 예산은 840초입니다. 넘으면 커밋을 막고 "느린 명령은 `blocking: false` 로" 라고 안내합니다. 훅 자체 시간 제한(900초)을 넘기면 도구들이 차단 없이 통과시키기 때문입니다.
- 첫 번째 blocking 실패에서 멈춥니다. 실행 파일을 찾을 수 없으면 커밋을 막지 않고 경고만 합니다.
- 옛 AlMandu 툴킷의 `am-gate.json` 은 그대로 읽힙니다(`_notes`, `lenses` 같은 키는 무시).

Unity 예시는 [examples/unity](examples/unity/) 에 있습니다. MSBuild 로 에디터 없이 컴파일하는 `gate-build.cmd` 와 런타임 확인 절 예시가 들어 있습니다.

### 런타임 확인 안내

`am:check` 는 프로젝트 CLAUDE.md 나 AGENTS.md 의 "Runtime check" 절을 읽고 그대로 실행 확인을 합니다. 앱 실행 명령, 로그 위치, 캡처 방법, 프로브 실행법을 적어 두면 에이전트가 직접 확인하는 범위가 넓어집니다.

## 우회와 한계

- 게이트를 끄려면 에이전트 세션을 시작하기 전에 환경 변수 `AM_GATE=off` 를 설정합니다. 차단 메시지에는 우회 방법을 일부러 적지 않았습니다(에이전트가 스스로 우회하지 않게).
- 게이트는 안전망이지 보안 장치가 아닙니다. 스크립트 안에서 하는 커밋, MCP git 도구, 사람이 터미널에서 직접 한 커밋은 거치지 않습니다.
- 게이트는 스테이징된 내용이 아니라 작업 트리 전체를 빌드합니다.
- Unity 예시 게이트는 .csproj 에 아직 들어가지 않은 새 .cs 파일을 컴파일하지 않습니다. 그래서 런타임 확인 첫 항목을 에디터 재컴파일로 둡니다.

## 업데이트

- Claude Code: `/plugin marketplace update am-workflow` 뒤 `/plugin update am@am-workflow`, 그리고 재시작
- Codex: `codex plugin marketplace upgrade` (Git 저장소일 때) 또는 `codex plugin remove am@am-workflow` 후 `codex plugin add am@am-workflow`. 훅이 바뀌었으면 다시 신뢰

## 개발

```
node --test tests/gate.test.mjs tests/skills.test.mjs
claude plugin validate .
claude plugin validate plugin
claude --plugin-dir plugin plugin details am
```

유지보수 규칙은 [CLAUDE.md](CLAUDE.md) 에 있습니다.
