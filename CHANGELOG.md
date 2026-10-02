# Changelog

## 0.1.0 (2026-10-02)

- 첫 릴리스: 스킬 3개(`am:plan`, `am:check`, `am:commit`)와 커밋 게이트 훅. Claude Code 와 Codex CLI 0.160 에서 같은 파일로 동작한다.
- 게이트는 옛 AlMandu 툴킷의 `am-gate.json` 형식을 그대로 읽는다. 커밋 한 번당 시간 예산 840초, 첫 실패에서 멈춤, PowerShell 도구와 `git -C` 대상 저장소 인식.
- Codex 사용자는 업데이트로 훅이 바뀌면 훅을 다시 신뢰해야 한다.
