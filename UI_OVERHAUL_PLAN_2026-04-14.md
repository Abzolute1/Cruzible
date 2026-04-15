# UI Overhaul Plan

Date: 2026-04-14

## Goals
- Make the interactive UI feel like a serious operator console instead of a flat chat log.
- Improve hierarchy, mode visibility, runtime visibility, and plan/workspace clarity.
- Keep changes reversible by preserving a full backup copy of the current interactive UI code.

## Execution Plan
1. Done: back up `packages/coding-agent/src/modes/interactive` before UI edits.
2. Done: audit layout containers, status surfaces, transcript rendering, and theme tokens.
3. Done: redesign persistent status presentation with a stronger mode line, clearer metrics, and better visual grouping.
4. Done: upgrade transcript/message cards for stronger role separation and better tool/plan readability.
5. In progress: improve empty-state, alert, planning/workspace, and transcript surfaces so status is legible at a glance.
6. Done for this slice: run targeted UI tests, rebuild, reinstall, and smoke-test `ag1` / `cruzible`.

## Completed In This Slice
- Introduced a more restrained graphite/steel palette in both dark and light themes.
- Reworked the persistent mode strip and footer into clearer operator-style status rails.
- Converted assistant, user, tool, plan, dialog, and extension/system cards to shared badge/header chrome.
- Replaced loose status, warning, error, package-update, and startup-diagnostic text blocks with structured runtime notice cards.
- Added a persistent startup overview card so idle sessions open with workspace, posture, and control context instead of only a banner.
- Reworked the pending-context area into structured queue, plan, and workspace cards instead of truncated prefixed lines.
- Added focused UI regression coverage for the new card headers and tool lifecycle states.
- Flattened ordinary `YOU` and `AGENT` transcript messages by removing the filled-card treatment from those components.
- Removed bracket-heavy transcript badge styling so headers read as plain bold labels rather than `[BADGE]` chips.
- Simplified successful tool headers so they no longer show `DONE`, leaving only failure/running state visible when it matters.
- Shifted user message text to a softer tinted lane so it stands out without becoming another hard block.
- Collapsed built-in tool transcript rows into summary-first execution logs with a nested target/command line instead of dumping raw output by default.
- Moved the rollback backup outside `src/` after the first backup location caused TypeScript to compile it during builds.

## Next UI Targets
- Group assistant turns as one unit instead of rendering thinking, tool activity, and final answer as separate slab-like surfaces.
- Move `thinking` into a lighter dedicated lane so it stops competing visually with the visible answer body.
- Group consecutive tool calls from one assistant turn into a shared execution cluster with nested rows instead of isolated blocks.
- Replace the remaining tool box treatment with compact execution rows and optional expansion, closer to the background terminal log style.
- Tighten the way long-running autonomous and planning context is presented so it reads like a control panel instead of a transcript footnote.
- Improve session and `/session` reporting surfaces so runtime health, sandbox state, and planning state match the new card language.
- Decide whether the top header should stay centered-banner based or move to a denser control-rail layout.

## Rollback
- Backup copy: `ui-backups/interactive_ui_backup_2026-04-14`
