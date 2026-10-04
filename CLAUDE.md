# am plugin repository

Lightweight plan/do/check/commit workflow plugin for Claude Code and Codex CLI. The repository root is the marketplace (`.claude-plugin/marketplace.json`); only `plugin/` is installed into users' caches.

## Rules
- One source for both tools. Codex reads `.claude-plugin/` manifests and plugin hooks natively; do not add Codex-only copies.
- `hooks/hooks.json` handler keys: `type`, `command`, `timeout` only. No `args`, `if` or `commandWindows` (one of the two tools ignores or rejects them). The command must not rely on shell path expansion: Codex runs it with `cmd /C` on Windows.
- `plugin.json` must not list `hooks` or `skills`; the default folders are loaded and listing them registers twice in Claude Code. Do not list `agents` either; the default `agents/` folder is scanned.
- Hook output contract (measured on Claude Code 2.1 and Codex 0.160): always exit 0; stdout is empty or exactly one JSON object; block with `hookSpecificOutput.permissionDecision: "deny"` plus a non-empty reason. Codex ignored exit 2.
- Changing `hooks.json` makes every Codex user re-trust the hook. Avoid it.
- Skills: English bodies; frontmatter `description` and `argument-hint` in Korean (users see them in the command palette); README/CHANGELOG in Korean. The common rules block must stay identical in every SKILL.md; size limits plan/check 120 lines, commit/do 80 (tests enforce both). Refer to other skills as "the am:check skill", not `/am:check`.
- Second opinion: `plugin/agents/second-opinion.md` is the one subagent, and Claude Code only (Codex has no such subagent, so the common rules fall back to the session's own pick). Its frontmatter pins `model: claude-opus-5-5` and `effort: xhigh` and keeps the tools read-only. Use the full model ID: the `opus` alias follows the main session's Opus version. Claude Code ignores a misspelled frontmatter key without an error, so the tests check the exact keys and values. English body, Korean `description`.
- Keep it small: no telemetry, panels, release gates or batch runners.

## Before committing
- `node --test tests/gate.test.mjs tests/skills.test.mjs`
- `claude plugin validate .` and `claude plugin validate plugin`
- User-visible change: bump `version` in `plugin/.claude-plugin/plugin.json` and add one CHANGELOG entry.
- Refresh a local Codex install with `codex plugin remove am@am-workflow` then `codex plugin add am@am-workflow`.
