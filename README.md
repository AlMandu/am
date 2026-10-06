# am

Claude Code 와 Codex CLI 에서 쓰는 가벼운 개발 워크플로 플러그인입니다. 스킬 5개, 2차 의견 서브에이전트 1개, 커밋 게이트 훅 1개로 되어 있습니다.

- `am:plan`: 큰 변경을 시작하기 전에 의도를 확인하고, 사용자만 정할 수 있는 것만 묻고, 짧은 계획 문서를 씁니다.
- `am:do`: 계획 문서대로 구현합니다. 끝난 단계는 건너뛰고 남은 단계부터 이어 갑니다. 커밋은 하지 않습니다.
- `am:check`: 커밋 전에 빌드·테스트(게이트), 실행 확인, 계획 대비 검토를 한 번에 합니다.
- `am:commit`: 이번 작업 파일만 논리 단위로 커밋합니다. 맨 앞에 `push` 를 붙였을 때만 push 까지 합니다.
- `am:auto`: 요청 하나를 계획 → 구현 → 점검 → 커밋까지 중간 질문 없이 이어 갑니다. 대신 정한 것은 마지막 답에서 알려 줍니다.
- 2차 의견(`am:second-opinion`): 기술적 선택을 작업 세션이 자기 추천안으로 정하지 않습니다. 대화를 보지 못한 별도 서브에이전트(모델·effort 고정, 아래 "모델과 effort 기본값" 표)가 코드를 직접 읽고 고른 안을 적용합니다. PC 에 codex CLI 가 있으면 Codex 도 같은 선택을 따로 고르고, 둘이 갈리면 서로의 답을 보며 다시 고르게 해 끝까지 갈린 것만 사용자에게 묻습니다. Claude Code 에서만 동작합니다.
- 커밋 게이트: 에이전트가 `git commit` 을 실행하기 직전에 프로젝트의 `am-gate.json` 명령을 돌리고, 실패하면 커밋을 막습니다.

작은 수정(파일 몇 개, 결과가 분명한 일)은 스킬 없이 그냥 요청하면 됩니다. 커밋 게이트는 그때도 동작합니다.

## 왜 이렇게 만들었나

이전에 쓰던 무거운 워크플로(단계 6개, 스킬 19종)의 실행 기록을 분석한 결과에서 나온 원칙입니다.

- 사람이 들인 수고의 대부분은 AI 오류 수정이 아니라 멈춤에 답하기, 결정 질문, 경고 처리, 어려운 출력 해독이었습니다. 그래서 질문은 화면·범위·되돌리기 어려운 선택에만 하고, 기술 선택은 묻지 않고 정한 뒤 알립니다. 정하는 쪽은 작업 세션이 아니라 2차 의견입니다(아래 "2차 의견" 절).
- 경고는 커밋을 막지 않습니다. 막는 것은 게이트 실패와 실패 시나리오가 확인된 결함뿐입니다.
- 답은 결론 → 사용자가 보는 변화 → 할 일 순서로, 내부 라벨 없이 씁니다.
- 실행 확인은 에이전트가 할 수 있는 만큼 먼저 하고, 사람에게는 "어디서·무엇을·무엇이 보이면 통과" 체크리스트만 넘깁니다.
- 가장 값진 장치였던 결정론적 게이트(실제로 빌드·테스트를 돌림)는 훅으로 남겼습니다.

세션마다 늘 드는 비용은 약 921토큰, 스킬 호출 한 번은 약 1.7~2.1k 토큰입니다(`claude plugin details am` 기준). `am:auto` 는 다른 네 스킬 파일을 함께 읽어 한 번에 약 10.8k 토큰이고, `am-orchestrator` 가 설치돼 있으면 그 실행 스킬 파일(약 3k)도 읽어 약 13.8k 토큰입니다.

## 요구 사항

- Node.js 18 이상(`node` 가 PATH 에 있어야 게이트 훅이 돎)
- Claude Code 또는 Codex CLI(0.160 에서 확인)
- 2차 의견은 Claude Code 2.1.280 이상(Opus 5.5 를 쓸 수 있는 버전)에서만 동작합니다. Codex 에는 이 서브에이전트가 없습니다.
- 선택: codex CLI(0.160 에서 확인, 로그인된 상태)가 있으면 Claude Code 의 2차 의견에 Codex 가 함께 들어갑니다(아래 "Codex 와 함께 정하기").

## 설치

저장소는 GitHub 공개 저장소 [AlMandu/am](https://github.com/AlMandu/am) 입니다. 플러그인을 고치는 사람은 저장소 주소 대신 로컬 경로(예: `C:\Projects\am`)로 설치하면, 커밋하지 않은 수정도 바로 시험할 수 있습니다.

**Claude Code**

```
/plugin marketplace add AlMandu/am
/plugin install am@am-workflow
```

**Codex CLI**

```
codex plugin marketplace add https://github.com/AlMandu/am.git
codex plugin add am@am-workflow
```

Codex 는 플러그인 훅을 사용자가 신뢰해야 실행합니다. 설치 뒤 Codex 를 시작하면 나오는 훅 검토 화면에서 "Trust all and continue" 를 고르거나, 세션 중 훅 목록에서 `t` 를 누르세요. 신뢰하기 전에도 스킬은 동작하지만 커밋 게이트는 돌지 않습니다. 플러그인을 업데이트해 훅이 바뀌면 다시 신뢰해야 합니다.

옛 AlMandu 툴킷(`am@almandu`)과는 이름이 같아서 함께 설치할 수 없습니다. 먼저 제거하세요.

## 사용법

| 하고 싶은 일 | Claude Code | Codex |
|---|---|---|
| 계획 세우기 | `/am:plan 0으로 나누면 오류 문구를 보여 줘` | `$am:plan ...` |
| 계획대로 구현(새 세션) | `/am:do <slug>` | `$am:do <slug>` |
| 계획 다시 열기(남은 질문·수정) | `/am:plan <slug>` | `$am:plan <slug>` |
| 커밋 전 점검 | `/am:check` | `$am:check` |
| 커밋 | `/am:commit` | `$am:commit` |
| 커밋하고 push | `/am:commit push` | `$am:commit push` |
| 요청 하나로 계획부터 커밋까지 | `/am:auto 0으로 나누면 오류 문구를 보여 줘` | `$am:auto ...` |
| 멈춘 자동 진행 이어 가기 | `/am:auto <slug>` | `$am:auto <slug>` |

- `am:plan` 은 `.am/<slug>/plan.md` 를 씁니다. 질문에 답할 때 "go" 를 붙이면 바로 구현까지 이어 갑니다(`am:do` 와 같은 규칙). `.am/` 은 자동으로 git 에서 제외됩니다(`.am/.gitignore`).
- 계획 문서 머리의 구현 규칙: 순서대로 진행, 단계마다 확인 후 완료 표시, 버그면 고치기 전 재현 기록, 계획과 다르면 변경 기록에 남김, 끝나면 `am:check`.
- `am:do` 는 완료 표시가 없는 첫 단계부터 이어 갑니다. 이전 세션이 이 계획으로 바꾼 파일은 이번 작업으로 보고, 표시와 파일 상태가 맞지 않으면 묻습니다. 계획에 답하지 않은 질문이 남아 있으면 먼저 묻습니다.
- `am:check` 의 판정은 BLOCK(게이트 실패, 확인된 결함, 이유 없이 빠진 계획 항목) 또는 NOTE(그 밖의 모든 것, 커밋을 막지 않음) 입니다.
- `am:commit` 은 다른 세션이나 사용자가 만든 변경을 남겨 두고, 남긴 개수를 알려 줍니다.
- `am:commit push` 는 커밋이 모두 성공했을 때만 현재 브랜치를 push 합니다. 먼저 나갈 커밋 목록을 보여 주고, 이번에 만들지 않은 커밋이 섞여 있으면 알립니다. 강제 push 는 하지 않으며, 원격에 새 커밋이 있어 거절되면 pull·rebase 없이 멈추고 알립니다. 커밋할 게 없으면 이미 있는 로컬 커밋만 push 합니다. 메모는 `push` 뒤에 씁니다(`/am:commit push 오타 수정`).
- `am:auto` 는 `am:plan` → `am:do` → `am:check` → `am:commit` 을 한 세션에서 이어 갑니다. 각 명령의 규칙은 그대로 따르고, 사용자에게 묻고 멈추던 곳만 바꿉니다. 화면·범위 질문은 추천안으로 정해 계획 문서에 "(자동 결정)" 으로 남기고, 마지막 답의 결론 바로 다음에 "대신 정한 것" 으로 보여 줍니다. 작은 변경에도 짧은 계획 문서를 씁니다.
- `am:auto` 가 멈추고 묻는 경우: 이번 실행 전부터 있던 데이터·파일 삭제, 저장 형식 변경·데이터 이전, 저장소 밖 변경, 사용자·프로젝트 지침이 확인을 요구하는 일. 점검이 BLOCK 이면 이번 작업 안의 원인을 고쳐 한 번 더 점검하고, 그래도 BLOCK 이면 커밋하지 않고 멈춥니다. 원인을 고친 뒤 `am:auto <slug>` 로 다시 실행하면 계획을 새로 쓰지 않고 남은 단계부터 이어 갑니다.
- `am:auto` 는 맨 앞에 `push` 를 붙였을 때만 push 합니다(`/am:auto push 오타 수정`). 붙이지 않으면 로컬 커밋까지만 하므로, 대신 정한 것이 마음에 들지 않으면 push 전에 되돌릴 수 있습니다. 커밋 전 검사를 돌리지 못했으면(설정 파일 오류, 검사 프로그램 없음) `push` 를 붙였어도 로컬 커밋까지만 하고 알립니다.
- `am:auto` 는 계획 문서 요약에 `규모: 구현 N회, 커밋 M개` 를 적습니다. 구현 1회는 새 세션 하나가 끝내고 확인할 수 있는 크기(파일 8개 안팎, 계획 150줄 이내)입니다. Claude Code 에서 `am-orchestrator` 가 설치·활성화돼 있고 규모가 구현 1회나 커밋 1개를 넘으면, 구현부터는 같은 세션이 오케스트레이터를 몰아 작업 단위로 돌립니다(몇 시간, 큰 비용이 들 수 있음). 끝나면 실행용 브랜치를 시작한 브랜치로 합치고(fast-forward) 지우므로, 커밋이 남는 곳과 `push` 는 작은 작업과 같습니다. 빌드·테스트 설정(`am-gate.json`)이 없거나, 이번 실행이 만들지 않은 미커밋 변경이 있거나, 시작 전부터 게이트가 실패하면 그 질문을 묻고 기다립니다. 마지막 답에 작업 수·브랜치·비용·사람 확인 목록이 나오고, 중간에 멈추면 `am:auto <slug>` 로 이어 갑니다. 설치돼 있지 않거나 Codex 에서는 지금처럼 `am:do` 로 구현합니다.

## 모델과 effort 기본값

Claude Code 에서는 스킬을 부르면 그 차례가 스킬에 정해 둔 모델과 effort 로 돕니다. 설치만 하면 적용되고 따로 설정할 것은 없습니다.

<!-- am:models:start -->

| 대상 | 모델 | effort |
|---|---|---|
| `am:plan` | `opus` | `high` |
| `am:do` | `opus` | `medium` |
| `am:check` | `opus` | `high` |
| `am:commit` | `opus` | `medium` |
| `am:auto` | `opus` | `medium` |
| 2차 의견 서브에이전트(`am:second-opinion`) | `claude-opus-5-5` | `high` |
| Codex 2차 의견 | 사용자의 codex 설정 | `medium` |

<!-- am:models:end -->

- 값은 각 `SKILL.md` 머리말(frontmatter)의 `model`, `effort` 에 있습니다. 원본은 저장소 루트의 `models.json` 이고, 고친 뒤 `node scripts/models.mjs` 를 돌리면 스킬·서브에이전트·Codex 스크립트·오케스트레이터와 이 표에 함께 반영됩니다(테스트가 어긋남을 잡음). 설치한 플러그인의 값을 사용자가 따로 바꾸는 방법은 Claude Code 에 없습니다.
- 스킬을 부른 그 차례에만 적용됩니다. 그 차례에는 세션에서 고른 모델보다 우선하고, 다음 입력부터는 세션의 모델과 effort 로 돌아갑니다. 그래서 `am:plan` 의 질문에 답한 뒤나 `am:auto` 가 멈췄다가 답을 받은 뒤의 차례는 세션 값으로 돕니다.
- `am:auto` 는 다른 네 스킬을 부르지 않고 파일을 읽어 따르므로, 그 세션에는 `am:auto` 의 값만 적용됩니다.
- 모델은 별칭(`opus`)으로 적었습니다. 쓰는 Claude Code 버전과 공급자의 Opus 로 풀리고, 환경 변수 `ANTHROPIC_DEFAULT_OPUS_MODEL` 로 다른 모델에 연결할 수 있습니다. effort 는 환경 변수 `CLAUDE_CODE_EFFORT_LEVEL` 이 우선합니다.
- Sonnet 세션에서 쓰던 경우 스킬을 부른 차례는 Opus 로 돌아 비용이 오릅니다. Opus 를 쓸 수 없는 계정에서 스킬이 어떻게 되는지는 Claude Code 문서에 없고 확인하지 못했습니다.
- 2차 의견 서브에이전트의 모델과 effort 는 따로 고정돼 있습니다(아래 "2차 의견" 절).
- Codex 에는 스킬별 모델 지정이 없어 이 값을 쓰지 않습니다. Codex 세션의 모델 그대로 돕니다.

## 오케스트레이터 (`am-orchestrator`, 별도 플러그인)

큰 설계 문서 하나를 끝까지 구현하게 하려면 같은 마켓플레이스의 `am-orchestrator` 를 함께 설치합니다. 설계 문서를 작은 작업으로 나누고, 작업마다 `am:plan` → `am:do` → `am:check` → `am:commit` 을 별도 세션으로 순서대로 돌립니다. Claude Code 전용입니다.

```
/plugin install am-orchestrator@am-workflow
/am-orchestrator:run docs/design.md
```

- 스킬을 실행한 세션이 준비·분할·실행·재개를 알아서 하고, 사용자만 답할 수 있는 것이 생겼을 때만 멈추고 결정 카드로 묻습니다. 묻고 멈추는 기준은 `am:auto` 와 같습니다.
- 작업마다 세션을 따로 띄워 단계별로 권한을 달리 주고, 단계 사이에 게이트(`am-gate.json`)와 작업 트리를 직접 확인합니다. 실행용 브랜치에 커밋만 쌓고 push 는 하지 않습니다.
- 띄우는 세션의 모델과 effort 도 단계별로 정해져 있습니다(값은 [orchestrator/README.md](orchestrator/README.md) 의 "모델과 effort" 표). 대상 저장소의 `.orchestrator/config.json` 에서 바꿉니다.
- 띄우는 세션은 이 PC 의 모든 실행을 합쳐 최대 3개까지만 함께 돕니다. `/am-orchestrator:run sessions 2` 처럼 바꾸고, 값은 업데이트해도 남습니다(자세한 것은 [orchestrator/README.md](orchestrator/README.md) 의 "동시 세션 제한").
- `am` 플러그인은 그대로 작게 둡니다. 오케스트레이터는 am 의 스킬과 게이트를 복사하지 않고 설치된 것을 부릅니다.
- 이 플러그인이 설치돼 있으면 `am:auto` 도 큰 작업의 구현을 여기에 넘깁니다. 이때는 `am:auto` 가 쓴 계획 문서를 설계 문서로 쓰고, 다 끝나면 실행용 브랜치를 시작한 브랜치로 합칩니다(위 `am:auto` 설명 참고).

자세한 내용은 [orchestrator/README.md](orchestrator/README.md) 에 있습니다.

## 2차 의견 (`am:second-opinion`)

작업 세션은 자기가 만든 안을 스스로 추천하고 그대로 고르기 쉽습니다. 그래서 사용자에게 묻지 않는 기술적 선택은 별도 서브에이전트가 정합니다.

- 대상: 구조·동작·비용이 달라지는 선택지가 둘 이상인 설계·구현 선택. 답이 하나뿐이면 보내지 않고 그대로 진행합니다. 화면·범위·되돌리기 어려운 선택은 지금처럼 사용자에게 묻습니다.
- 방식: 작업 세션이 자기 안을 먼저 정해 두고, 미정인 선택을 한 번에 모아 목표·사용자 결정·아직 답을 받지 않은 질문·관련 경로·선택지만 적어 보냅니다. 자기 안은 적지 않습니다. 2차 의견은 대화 기록 없이 시작해 코드를 직접 읽고, 선택마다 고른 안·이유·위험을 돌려줍니다. 선택지에 없는 안을 고를 수도 있습니다.
- 적용: 2차 의견이 고른 안을 적용합니다. 계획 문서의 "기본값 적용" 각 줄에 2차 의견이 골랐다는 표시가 붙고, 작업 세션의 안과 달랐으면 그 안도 함께 적힙니다. `am:plan` 과 `am:do` 는 답에서 달랐던 선택을 따로 알려 줍니다. 사용자 결정은 언제나 2차 의견보다 우선합니다.
- 다시 여는 경우: 정한 선택은 나중에 받은 사용자 답과 부딪히거나, 요약에서 빠졌던 사실이 드러나거나, 해 보니 안 될 때(확인 실패, 검토 지적)만 다시 엽니다. 그때도 작업 세션이 직접 바꾸거나 사용자에게 기술 질문으로 넘기지 않고, 새 사실을 붙여 2차 의견에 다시 보낸 뒤 그 줄을 고칩니다.
- 고정: 모델과 effort 는 위 "모델과 effort 기본값" 표의 값(모델은 별칭이 아닌 전체 ID), 도구는 읽기 전용(Read, Grep, Glob). `plugin/agents/second-opinion.md` 의 frontmatter 에 있고 테스트가 지킵니다. 실행 중 `/tasks` 를 열면 그 서브에이전트 줄에 모델과 effort 가 보입니다.
- 비용: 호출 한 번이 위 표의 모델·effort 로 도는 별도 실행입니다. 그래서 선택을 모아 한 번에 보내고, `am:plan` 은 계획당 한 번을 기본으로 합니다.
- 고정이 풀리는 경우: 환경 변수 `CLAUDE_CODE_EFFORT_LEVEL` 은 frontmatter 의 effort 보다 우선하고, `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` 은 서브에이전트의 model 을 무시합니다. 조직이 모델이나 effort 상한을 제한해 두었으면 그 제한을 따릅니다.
- 쓸 수 없을 때(Codex, 서브에이전트 실행 실패): 예전처럼 작업 세션이 정하고, 그 줄에 2차 의견 없이 정했다는 표시를 남깁니다.

### Codex 와 함께 정하기

Claude Code 에서 쓰고 PC 에 codex CLI 가 깔려 있으면(`codex` 명령이 PATH 에 있으면) 2차 의견이 둘이 됩니다. 따로 설정할 것은 없습니다.

- 방식: 작업 세션이 결정 요약을 `.am/` 아래 파일로 쓰고, `plugin/scripts/codex-opinion.mjs` 로 Codex 를 한 번 돌린 뒤 같은 요약을 Claude 2차 의견에도 보냅니다. 두 쪽은 서로의 답을 모른 채 고릅니다. 두 호출은 차례로 돕니다.
- 토론: 두 쪽이 다르게 고른 선택만, 원래 요약에 지난 라운드 두 쪽의 안과 이유를 붙여 두 쪽에 다시 묻습니다(매번 새로 띄우므로 전체 사정을 다시 넘김). 상대 이유는 주장으로 보고 코드로 확인하며, 놓친 사실이 있을 때만 바꾸게 합니다. 최대 2라운드 더 묻고(오케스트레이터 세션은 시간 제한 때문에 1라운드), 합의한 선택은 계획 문서의 "기본값 적용" 줄에 Codex 와 합의했다는 표시가 붙습니다.
- 끝까지 갈리면: 그 선택만 두 쪽 안과 이유를 담은 결정 카드로 사용자에게 묻습니다. `am:auto` 와 오케스트레이터도 이때는 멈추고 묻습니다.
- Codex 실행: 읽기 전용 샌드박스, 승인 요청 없음, 모델과 effort 는 위 "모델과 effort 기본값" 표의 값으로 고정(모델을 비워 두면 사용자의 codex 설정 그대로)입니다. 사용자의 MCP 서버와 실행 규칙(`.rules`)은 싣지 않고, 실행 기록도 남기지 않습니다(`--ephemeral`). 9분 안에 답이 없으면 끝냅니다. 스크립트는 `.am/` 안의 `.md` 요약 하나만 받고 다른 인자는 거부합니다.
- codex 가 없으면 지금과 같습니다. 깔려 있지만 실패하면(로그인 안 됨, 오류, 시간 초과) 어느 라운드든 Claude 2차 의견만으로 정하고 그 줄에 표시합니다. 반대로 Claude 쪽이 실패하면 Codex 답으로 정합니다.
- 비용과 시간: 기술 선택을 보낼 때마다 Codex 실행이 하나 더 들고(사용자의 Codex 사용량), 갈리면 양쪽이 다시 돕니다.
- Codex 의 읽기 전용 샌드박스는 디스크의 파일을 읽을 수 있으므로, Codex 가 읽은 내용은 OpenAI 로 갑니다. Codex 안에서 am 을 쓸 때는 바뀌지 않습니다(Claude 2차 의견이 없음).

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

언리얼(UE5) 예시는 [examples/unreal](examples/unreal/) 에 있습니다. `am-gate.json` 은 저장소 루트에, `ue-gate.mjs` 는 `DevTools/` 에 복사하고, `runtime-check.md` 의 절은 프로젝트 CLAUDE.md 나 AGENTS.md 에 붙여 넣습니다.

- 커밋 때 C++ 빌드와 자동화 테스트(Automation)가 돌고, 실패하면 커밋을 막습니다. 차단 메시지에는 실패한 테스트 이름과 첫 오류, 또는 컴파일 오류 줄이 나옵니다. 블루프린트 전체 컴파일은 느려서 `am:check` 에서만 돕니다.
- 에디터를 켜 둔 채 커밋해도 됩니다. 게이트는 프로젝트(.uproject, Source, Config, Content, Plugins)를 `Saved/AmGate` 에 복사해 그곳에서 DebugGame 으로 빌드·테스트합니다. 그래서 열린 에디터가 코드를 다시 불러오지 않고, 추적 중인 설정 파일도 바뀌지 않습니다. 대신 열린 에디터에 반영하려면 따로 Live Coding 이나 재시작이 필요합니다.
- 처음 한 번은 사본에서 C++ 전체를 컴파일합니다. 큰 프로젝트는 설치 직후 `node DevTools/ue-gate.mjs build` 를 손으로 한 번 돌려 두세요(게이트의 빌드 제한은 600초).
- 사본은 맥 APFS 에서는 복제(clone)라 디스크를 거의 쓰지 않고, 복제가 안 되는 파일 시스템에서는 Content 크기만큼 씁니다. 바뀐 파일만 다시 복사하고, `Saved/AmGate` 를 지우면 다음 실행에서 새로 만듭니다.
- 옵션: `--project <경로.uproject>`(루트나 한 단계 아래에 하나뿐이면 생략), `--filter <테스트 접두어>`(기본값은 프로젝트 이름, 맞는 테스트가 없으면 실패), `--config Development`. 엔진은 `.uproject` 의 엔진 버전으로 찾고, 못 찾으면 환경 변수 `UE_ROOT` 에 엔진 폴더를 지정합니다. `node DevTools/ue-gate.mjs info` 로 찾은 경로를 확인할 수 있습니다.
- 맥(UE 5.8)에서 실측했습니다. 윈도우 경로는 엔진 소스를 보고 작성했고 아직 실측하지 않았습니다. UE4 는 지원하지 않습니다.

### 런타임 확인 안내

`am:check` 는 프로젝트 CLAUDE.md 나 AGENTS.md 의 "Runtime check" 절을 읽고 그대로 실행 확인을 합니다. 앱 실행 명령, 로그 위치, 캡처 방법, 프로브 실행법을 적어 두면 에이전트가 직접 확인하는 범위가 넓어집니다.

## 우회와 한계

- 게이트를 끄려면 에이전트 세션을 시작하기 전에 환경 변수 `AM_GATE=off` 를 설정합니다. 차단 메시지에는 우회 방법을 일부러 적지 않았습니다(에이전트가 스스로 우회하지 않게).
- 게이트는 안전망이지 보안 장치가 아닙니다. 스크립트 안에서 하는 커밋, MCP git 도구, 사람이 터미널에서 직접 한 커밋은 거치지 않습니다.
- 게이트는 스테이징된 내용이 아니라 작업 트리 전체를 빌드합니다.
- Unity 예시 게이트는 .csproj 에 아직 들어가지 않은 새 .cs 파일을 컴파일하지 않습니다. 그래서 런타임 확인 첫 항목을 에디터 재컴파일로 둡니다.
- 언리얼 예시 사본에는 위 다섯 가지만 들어갑니다. `.uproject` 가 프로젝트 밖 폴더를 상대 경로로 가리키면(예: 추가 플러그인 폴더) 사본에서는 그 경로를 찾지 못합니다. 심볼릭 링크·정션은 복사하지 않고 출력에 알립니다.

## 업데이트

- Claude Code: `/plugin marketplace update am-workflow` 뒤 `/plugin update am@am-workflow`, 그리고 재시작
- Codex: `codex plugin marketplace upgrade` (Git 저장소일 때) 또는 `codex plugin remove am@am-workflow` 후 `codex plugin add am@am-workflow`. 훅이 바뀌었으면 다시 신뢰

## 개발

```
node --test tests/gate.test.mjs tests/skills.test.mjs tests/codex-opinion.test.mjs
claude plugin validate .
claude plugin validate plugin
claude --plugin-dir plugin plugin details am
```

오케스트레이터 플러그인을 고쳤을 때:

```
node --test tests/orchestrator-skill.test.mjs
node --test tests/orchestrator.test.mjs
claude plugin validate orchestrator
claude --plugin-dir orchestrator plugin details am-orchestrator
```

유지보수 규칙은 [CLAUDE.md](CLAUDE.md) 에 있습니다.
