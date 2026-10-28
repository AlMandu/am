# am plugin repository

Lightweight plan/do/check/commit workflow plugin for Claude Code and Codex CLI. The repository root is the marketplace (`.claude-plugin/marketplace.json`) and lists five plugins, each installed into users' caches on its own: `plugin/` is `am` (plan, do, check, commit, the commit gate, the second opinion), `auto/` is `am-auto` (Claude Code only, depends on am: the unattended run skills, stage agents and stage runner), `util/` is `am-util` (land, update-branch, git-sync), `art/` is `am-art` (art skills; Claude Code and Codex see different skill folders) and `orchestrator/` is `am-orchestrator` (Claude Code only, runs the am skills task by task over a design document).

The full maintainer rules live in `CLAUDE.full.md`. This file keeps only the rules every change needs and an index into that file.

## Rules
- One source for both tools: Codex reads `.claude-plugin/` manifests and plugin hooks natively; no Codex-only copies. The one exception is am-art: `art/.codex-plugin/plugin.json` names `./codex-skills/` and `art/.claude-plugin/plugin.json` names `./claude-skills/` as `skills`; `art/` has no default `skills/` folder.
- `hooks/hooks.json` handler keys are `type`, `command` and `timeout` only; the command must not rely on shell path expansion (Codex runs it with `cmd /C` on Windows).
- `plugin.json` must not list `hooks`, `skills` or `agents` (the default folders are scanned; listing registers twice), except am-art's two `skills` paths.
- Hooks always exit 0; stdout is empty or exactly one JSON object; block with `hookSpecificOutput.permissionDecision: "deny"` plus a non-empty reason.
- `plugin/hooks/hooks.json` is frozen byte for byte (SHA-256 pinned in `tests/gate.test.mjs`): changing a `hooks.json` makes every Codex user re-trust the hook. `plugin/hooks/hook.mjs` ends with no output and loads nothing for input whose `agent_type` starts with `am-auto:stage-`.
- Shared copies: edit only the `plugin/` source of files that `auto/` and `util/` ship as copies (the gate, `user-models.mjs`, `user-settings.mjs`, `codex-opinion.mjs`, `second-opinion.md`; `COPIES` of `scripts/sync-shared.mjs`), then run `node scripts/sync-shared.mjs` (`--check` lists drift).
- Skills: English bodies; frontmatter `description` and `argument-hint`, README and CHANGELOG in Korean. The common rules block is edited only in `shared/common.md` and written into every SKILL.md by `node scripts/skills.mjs`. Size limits are enforced by `tests/skills.test.mjs`. Refer to other skills as "the am:check skill", not by slash command.
- Model and effort: change values only in `models.json`, then run `node scripts/models.mjs` (it rewrites every frontmatter and code target; `--check` lists drift). Write models as aliases (`opus`), never full IDs.
- The repository is public: company values (work folders, tool paths, page IDs, personal mail addresses) never go into it (`tests/art.test.mjs`).
- Text sent to a model is English; what a person reads (script output, reports, README) is Korean.
- Keep `plugin/`, `auto/` and `util/` small: no telemetry, panels, release gates or batch runners. Batch running belongs to `orchestrator/`, and the others must work without it.
- Each plugin has its own `version`: a user-visible change bumps that folder's `.claude-plugin/plugin.json` (for am-art also `art/.codex-plugin/plugin.json`, same `name`, `version` and `description`) and adds a CHANGELOG entry (`am-auto <version>`, `am-util <version>`, `am-art <version>`, `am-orchestrator <version>`; plain for `plugin/`).
- Tests that start a script point `CLAUDE_CONFIG_DIR` at a temporary folder (`makeRepo` of `tests/orchestrator-helpers.mjs`); wait values, timeouts, paths and commands are function parameters, never environment variables.
- Many strings and formats are pinned across files by tests ("change X, Y and its test in the same commit"). When you change a pinned string or format, change every side and that test in the same commit; the index below says where those pairs are listed.

## Detailed rules (CLAUDE.full.md)
Before editing files in an area below, read its entry in `CLAUDE.full.md`; keep that file current (see its header). Entries are named as "section, bullet label".
- `auto/hooks/stage-hook.mjs`, `stage-guard.mjs`, `auto/hooks/hooks.json`, `auto/scripts/agent-stage.mjs` -> Rules, `Stage guard:`
- `auto/hooks/handover.mjs` (`findCore`, `AM_MIN_VERSION`); any am skill file, am:do's done mark, the plan skeleton, `codex-opinion.mjs` or plugin.json `name`/`version` -> Rules, `Core lookup:`
- `auto/flow/`, the `## Parts` lines, skill size limits and skill homes -> Rules, `Skills:`
- `auto/flow/run.md`'s rules for running without stops -> also Rules, `Stage sessions:` and the Orchestrator plugin section's bullet beginning `Its rules for running without a user`
- `plugin/agents/`, `auto/agents/`, `scripts/second-opinion.md` -> Rules, `Second opinion:`; `codex-opinion.mjs`, `auto/scripts/claude-opinion.mjs` -> Rules, `Codex second opinion:`
- `models.json`, `scripts/models.mjs`, skill frontmatter -> Rules, `Model and effort:` and `One source for model and effort:`
- `plugin/scripts/user-files.mjs`, `user-models.mjs`, `user-settings.mjs`, `plugin/hooks/hook.mjs` -> Rules, `User files:`
- am-auto:multi's hand-over hook (`auto/hooks/handover.mjs`) -> Rules, `Hand-over hook:`
- `auto/scripts/stage.mjs`, `memory-guard.mjs`, `proc-tree.mjs`, solo mode (am-auto:one) -> Rules, `Stage sessions:`
- `progress.jsonl`, `auto/scripts/progress.mjs` -> Rules, `Progress news:`
- `auto/scripts/sessions.mjs`, the am-auto:sessions skill -> Rules, `Sessions report:`
- The am:plan, am:do, am:check and am:commit skills (`commits.md`, `.am/.active`, `do-result.md`) -> Rules, `Commit record:`, `Current task mark:` and `Do result:`
- `art/`, `shared/art.md` -> Rules, ``Art plugin (`art/`):``
- `orchestrator/`, or anything in `plugin/` or `auto/` it relies on (the gate, `shared/common.md`, the four am skills, `user-models.mjs`, `user-settings.mjs`, `codex-opinion.mjs`, `memory-guard.mjs`, `proc-tree.mjs`, `auto/flow/run.md`, `stage.mjs`) -> the whole Orchestrator plugin section, including its own `Progress news:` and `Worker and follower:`; orchestrator state and record files (`lock.json`, `worker.json`, `state.json`, `tasks.json`, `.gate` records) -> also Rules, `Sessions report:`

## Before committing
- `node --test tests/gate.test.mjs tests/skills.test.mjs tests/codex-opinion.test.mjs tests/models.test.mjs tests/handover.test.mjs tests/stage.test.mjs tests/progress.test.mjs tests/proc-tree.test.mjs tests/sessions.test.mjs tests/claude-opinion.test.mjs tests/agent-stage.test.mjs tests/stage-guard.test.mjs tests/art.test.mjs tests/git-sync.test.mjs`
- `claude plugin validate .`, `claude plugin validate plugin`, `claude plugin validate auto`, `claude plugin validate util` and `claude plugin validate art`
- After touching `orchestrator/`, anything in `plugin/` or `auto/` that it relies on, or am-auto:multi's hand-over: `node --test tests/orchestrator-skill.test.mjs tests/orchestrator.test.mjs tests/orchestrator-plan.test.mjs tests/orchestrator-commit.test.mjs tests/orchestrator-drive.test.mjs tests/orchestrator-doctor.test.mjs tests/orchestrator-parallel.test.mjs tests/orchestrator-volatile.test.mjs tests/orchestrator-rewrite.test.mjs tests/orchestrator-sessions.test.mjs tests/orchestrator-progress.test.mjs tests/orchestrator-follow.test.mjs` (the files after the first take about 55 seconds together on a 10-core PC and need no `claude`) and `claude plugin validate orchestrator`
- User-visible change to `plugin/`: bump `version` in `plugin/.claude-plugin/plugin.json` and add one CHANGELOG entry.
- Refresh a local Codex install with `codex plugin remove am@am-workflow` then `codex plugin add am@am-workflow`, and the same for `am-util@am-workflow` and `am-art@am-workflow`.
