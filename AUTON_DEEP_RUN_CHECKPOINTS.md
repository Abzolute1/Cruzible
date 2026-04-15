# Autonomous Hardening Run

Goal: harden the coding-agent harness so autonomous execution is more reliable and cheaper, then shift into direct product improvements from a stable base.

Work only in `packages/coding-agent`.

Priority checkpoints:

1. Normalize recovery arbitration behavior.
   The shared stale-state guard, replay arbiter, skipped-replay event, dispose-time aborts, runtime replacement regressions, and shared replay scheduler now exist. The next step is prompt stability, not replay lifecycle correctness.

2. Reduce prompt churn in recovery paths.
   Audit where retry, compaction, queued follow-ups, or system prompt addenda unnecessarily mutate prompt shape. Prefer stable wrappers and small changing tails.

3. Add adversarial tests for stale recovery and prompt stability.
   Cover cases where:
   - queued recovery fires after a newer prompt
   - compaction/retry resumes after state drift
   - pending recovery timers survive runtime replacement or dispose
   - custom focus or recovery guidance changes prompt framing more than necessary

4. Tighten autonomous-mode invariants in code.
   Enforce machine-checked behavior where possible instead of relying on prompt compliance.

5. Verify and rebuild.
   Run targeted tests for touched areas and rebuild the package.

6. UI improvement track is now active.
   - Keep the rollback copy at `ui-backups/interactive_ui_backup_2026-04-14`.
   - Warnings, startup/idle state, and plan/workspace context surfaces now use the new operator-console card language.
   - Next UI pass should focus on long-running autonomy/planning state and session-reporting surfaces.
   - Preserve the rule: every major UI slice ends with focused tests, rebuild, reinstall, and `ag1` / `cruzible` smoke checks.

Execution constraints:

- Be skeptical. Look for race conditions, stale state, duplicated logic, and wasteful retries.
- Prefer smaller, composable helpers over scattered one-off checks.
- Do not broaden into unrelated refactors.
- Add or update tests for every meaningful behavior change.
- Finish with a concise summary of changed files, tests run, and any residual risks.
