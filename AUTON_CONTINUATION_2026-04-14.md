# Continuation Handoff

Date: 2026-04-14

## Completed This Pass

1. NVIDIA Nemotron pricing is now wired into the runtime model registry.
   - `nvidia/nemotron-3-super-120b-a12b`: `$0.20` in / `$0.80` out per 1M
   - `nvidia/llama-3.1-nemotron-ultra-253b-v1`: `$0.60` in / `$1.80` out per 1M

2. Interactive model pickers now surface pricing.
   - Main picker shows compact per-model pricing in the list.
   - Main picker shows detailed pricing in the selected-model detail area.
   - Scoped picker does the same.

3. Footer token stats are clearer.
   - Replaced arrow shorthand with explicit labels:
     - `in`
     - `out`
     - `cache-read`
     - `cache-write`

4. Verification completed.
   - `npm test --workspace packages/coding-agent -- footer-width model-selector-pricing main-cli-contract`
   - `npm run build --workspace packages/coding-agent`
   - `ag1 --help`
   - `cruzible --help`

5. Autonomous cwd guard now allows nested project folders under `Desktop`-style locations.
   - Broad personal roots like `~/Desktop` are still blocked.
   - Nested directories such as `~/Desktop/Tests/Snake` are no longer rejected solely because of the top-level folder name.
   - Verification:
     - `npm test --workspace packages/coding-agent -- interactive-mode-workspace interactive-mode-status`
     - `npm run build --workspace packages/coding-agent`

6. Explicit CLI startup models now survive the real file-backed runtime path.
   - Root cause: `SessionManager.buildSessionContext()` returns `model: null` for a fresh session, but `main.ts` only treated `undefined` as “no model yet”.
   - Fixes:
     - `shouldUseRequestedStartupModel(...)` now treats `null` and `undefined` as empty startup state.
     - `createRuntimeFn` now re-resolves the startup model against the current services instead of carrying a stale `preferredRuntimeModel`.
     - `enforceExplicitRuntimeModel(...)` remains as a final runtime-level backstop for explicit `--model` / `--provider` requests.
   - Verified:
     - `npm test --workspace packages/coding-agent -- main-cli-contract agent-session-runtime`
     - `npm run build --workspace packages/coding-agent`
     - real CLI repro:
       - `node packages/coding-agent/dist/cli.js --agent-dir /tmp/ag1-cli-fixed --cwd /home/alex/AG1 --print --model gpt-5.4-mini --no-extensions --no-skills --no-prompt-templates --no-themes "say hi"`
       - first persisted `model_change` is now `openai/gpt-5.4-mini`
       - assistant attempts also stay on `openai/gpt-5.4-mini`

7. `/new` now preserves the live runtime model and thinking level explicitly.
   - Root cause: starting a new session relied on `SettingsManager` default writes from prior `setModel()` / `setThinkingLevel()` calls having flushed in time.
   - That made `/new` timing-sensitive instead of deterministic.
   - Fix:
     - `AgentSessionRuntime.newSession()` now snapshots the current runtime model and thinking level before replacement and reapplies them to the freshly created session after the runtime swap.
   - Verification:
     - `npm test --workspace packages/coding-agent -- agent-session-runtime main-cli-contract`
     - `npm run build --workspace packages/coding-agent`
     - `ag1 --help`

8. Retry and auto-compaction now share a single replay freshness policy.
   - Root cause: both coordinators kept their own transcript-only snapshot logic, so stale recovery could still fire after model/thinking changes and the rules were duplicated.
   - Fix:
     - added shared helper: `packages/coding-agent/src/core/agent-session-continue-replay.ts`
     - retry and compaction now both gate delayed `continue()` on:
       - transcript shape
       - selected model
       - thinking level
       - non-streaming state
   - Verification:
     - `npm test --workspace packages/coding-agent -- agent-session-continue-replay agent-session-retry-coordinator agent-session-auto-compaction-queue`
     - `npm run build --workspace packages/coding-agent`
     - `cruzible --help`

9. Retry and compaction now arbitrate replay ownership.
   - Root cause: even with shared freshness checks, delayed replay scheduling still lived in two separate coordinators with no shared ownership model.
   - Fix:
     - added shared arbiter: `packages/coding-agent/src/core/agent-session-recovery-arbiter.ts`
     - retry must claim replay ownership before scheduling
     - compaction must claim replay ownership before scheduling
     - same-owner re-arming is allowed, different-owner overlap is blocked
   - Verification:
     - `npm test --workspace packages/coding-agent -- agent-session-recovery-arbiter agent-session-retry-coordinator agent-session-compaction-coordinator agent-session-continue-replay agent-session-auto-compaction-queue`
     - `npm run build --workspace packages/coding-agent`
     - `ag1 --help`

10. Retry and compaction now emit a shared skipped-replay event, and compaction skips are no longer silent in interactive mode.
   - Root cause: retry surfaced replay failures through `auto_retry_end`, but compaction could lose its delayed replay with no machine-readable event and no user-visible status.
   - Fix:
     - added `recovery_replay_skipped` to `AgentSessionEvent`
     - retry now emits it for:
       - arbitration blocked by another recovery path
       - stale replay after state drift
     - compaction now emits it for:
       - arbitration blocked by another recovery path
       - stale replay after state drift
     - interactive mode now surfaces compaction replay skips via a status message instead of dropping them silently
   - Verification:
     - `npm test --workspace packages/coding-agent -- agent-session-retry-coordinator agent-session-compaction-coordinator agent-session-auto-compaction-queue interactive-event-actions`
     - `npm run build --workspace packages/coding-agent`
     - `ag1 --help`

11. Session teardown now aborts pending recovery work instead of only disconnecting listeners.
   - Root cause: `AgentSession.dispose()` previously left retry timers, auto-compaction replay timers, and in-flight work alive. On runtime replacement, an old session could still call `continue()` after it had been disposed.
   - Fix:
     - `AgentSession.dispose()` now aborts:
       - retry coordination
       - compaction coordination
       - branch summary work
       - bash execution
       - the underlying agent
     - added regression coverage for:
       - pending retry replay canceled by `dispose()`
       - pending auto-compaction replay canceled by `dispose()`
   - Verification:
     - `npm test --workspace packages/coding-agent -- agent-session-dispose-recovery agent-session-auto-compaction-queue agent-session-retry-coordinator agent-session-compaction-coordinator interactive-event-actions`
     - `npm run build --workspace packages/coding-agent`
     - `ag1 --help`

12. Runtime replacement now has direct regression coverage for pending recovery carryover.
   - Root cause: after fixing `dispose()`, we still only had indirect confidence that old retry/compaction timers would not survive a real `runtime.newSession()` or `runtime.switchSession()` cutover.
   - Fix:
     - added runtime-level tests proving:
       - a pending retry replay is canceled when `newSession()` replaces the runtime
       - a pending compaction replay is canceled when `switchSession()` replaces the runtime
   - Verification:
     - `npm test --workspace packages/coding-agent -- suite/agent-session-runtime agent-session-dispose-recovery agent-session-auto-compaction-queue agent-session-retry-coordinator agent-session-compaction-coordinator interactive-event-actions`
     - runtime suite now covers replacement-level teardown instead of relying only on coordinator tests

13. Retry and compaction now share a single replay scheduling primitive instead of duplicating timer logic.
   - Root cause: replay freshness and ownership were already shared, but retry and compaction still each owned their own timer, arbiter clearance, stale-state handling, and skipped-replay event emission.
   - Fix:
     - added `packages/coding-agent/src/core/agent-session-recovery-replay-scheduler.ts`
     - the shared scheduler now owns:
       - snapshot capture
       - timer replacement/cancellation
       - replay ownership claims
       - stale replay checks
       - `recovery_replay_skipped` event emission
     - retry and compaction coordinators now keep only their mode-specific behavior
   - Verification:
     - `npm test --workspace packages/coding-agent -- agent-session-recovery-replay-scheduler agent-session-retry-coordinator agent-session-compaction-coordinator agent-session-dispose-recovery agent-session-auto-compaction-queue interactive-event-actions`
     - `npm test --workspace packages/coding-agent -- suite/agent-session-runtime`

14. Interactive UI overhaul has started with a safe rollback copy and a verified first redesign slice.
   - Rollback copy:
     - `ui-backups/interactive_ui_backup_2026-04-14`
     - the original backup was moved out of `src/` because TypeScript tried to compile it during builds
   - UI work completed:
     - neutralized the old flatter accent palette in both dark and light themes
     - upgraded the persistent mode strip and footer into clearer operator-style rails
     - introduced shared card chrome across assistant, user, tool, plan, dialog, and system-message surfaces
     - replaced loose status, warning, error, package-update, and startup-diagnostic lines with structured runtime notice cards
     - added a persistent startup overview card so idle sessions open with workspace and control context
     - converted the pending context dock into structured queue, plan, and workspace cards
     - added focused UI regression coverage in `packages/coding-agent/test/interactive-ui-cards.test.ts`
   - Verification:
     - `npm test --workspace packages/coding-agent -- footer-width interactive-mode-status interactive-mode-workspace interactive-plan-review-ui tool-execution-component interactive-ui-cards`
     - `npm run build --workspace packages/coding-agent`
     - `ag1 --help`
     - `cruzible --help`

## Open Harness Gaps

1. Recovery state correctness is now mostly closed.
   - The main remaining hardening work is no longer timer ownership or replacement leaks.
   - The next remaining robustness/cost risk is prompt-shape churn across recovery and continuation paths.

2. Recovery prompt shape is still more volatile than it should be.
   - Retry, compaction, and recovery guidance are better than before, but there is still avoidable prompt churn across resume paths.
   - That hurts both cache locality and predictability.

3. Prompt stability is now the larger remaining efficiency risk.
   - The worst state leaks are covered.
   - The next cost/robustness gain is reducing recovery and continuation prompt churn so caching and replay behavior stay stable under repeated turns.

4. UI is now the main direct-improvement track.
   - The harness is stable enough that UI work can proceed without being dominated by replay-state bugs.
   - The next UI pass should focus on long-running autonomy/planning state presentation and session reporting surfaces.

## Next Attack Plan

1. Reduce recovery prompt churn.
   - Stabilize retry/compaction continuation wrappers and keep the variable tail small.

2. Audit continuation prompt assembly across interactive and autonomous recovery.
   - Find where recovery-specific guidance still rewrites larger prompt prefixes than necessary.

3. Add adversarial tests around replay and state freshness.
   - queued recovery after a newer turn
   - compaction replay after model/thinking/cwd changes
   - duplicate recovery triggers against the same stale snapshot

4. Reduce recovery prompt churn.
   - Make retry/compaction continuation prompts reuse more stable wrappers with smaller variable tails.

5. Continue the UI overhaul.
   - Tighten long-running autonomy/planning state so it reads like a control panel.
   - Upgrade `/session` and related reporting surfaces to match the new card language.
   - Decide whether the centered top banner should remain or be replaced with a denser control rail.

## Files Changed In This Pass

- `packages/coding-agent/src/providers/nvidia-provider.ts`
- `packages/coding-agent/src/main.ts`
- `packages/coding-agent/src/core/agent-session-continue-replay.ts`
- `packages/coding-agent/src/core/agent-session-recovery-arbiter.ts`
- `packages/coding-agent/src/core/agent-session-recovery-replay-scheduler.ts`
- `packages/coding-agent/src/core/agent-session-runtime.ts`
- `packages/coding-agent/src/core/agent-session-retry-coordinator.ts`
- `packages/coding-agent/src/core/agent-session-compaction-coordinator.ts`
- `packages/coding-agent/src/core/agent-session.ts`
- `packages/coding-agent/src/modes/interactive/interactive-event-actions.ts`
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- `packages/coding-agent/src/modes/interactive/interactive-startup-actions.ts`
- `packages/coding-agent/src/modes/interactive/interactive-ui-context.ts`
- `packages/coding-agent/src/modes/interactive/theme/dark.json`
- `packages/coding-agent/src/modes/interactive/theme/light.json`
- `packages/coding-agent/src/modes/interactive/components/console-chrome.ts`
- `packages/coding-agent/src/modes/interactive/components/notice-card.ts`
- `packages/coding-agent/src/modes/interactive/components/model-metrics.ts`
- `packages/coding-agent/src/modes/interactive/components/footer.ts`
- `packages/coding-agent/src/modes/interactive/components/model-selector.ts`
- `packages/coding-agent/src/modes/interactive/components/scoped-models-selector.ts`
- `packages/coding-agent/src/modes/interactive/components/assistant-message.ts`
- `packages/coding-agent/src/modes/interactive/components/user-message.ts`
- `packages/coding-agent/src/modes/interactive/components/custom-message.ts`
- `packages/coding-agent/src/modes/interactive/components/branch-summary-message.ts`
- `packages/coding-agent/src/modes/interactive/components/compaction-summary-message.ts`
- `packages/coding-agent/src/modes/interactive/components/tool-execution.ts`
- `packages/coding-agent/src/modes/interactive/components/plan-review-card.ts`
- `packages/coding-agent/src/modes/interactive/components/plan-workflow-dialog.ts`
- `packages/coding-agent/src/modes/interactive/components/extension-input.ts`
- `packages/coding-agent/test/agent-session-continue-replay.test.ts`
- `packages/coding-agent/test/agent-session-recovery-arbiter.test.ts`
- `packages/coding-agent/test/agent-session-recovery-replay-scheduler.test.ts`
- `packages/coding-agent/test/agent-session-compaction-coordinator.test.ts`
- `packages/coding-agent/test/agent-session-retry-coordinator.test.ts`
- `packages/coding-agent/test/agent-session-auto-compaction-queue.test.ts`
- `packages/coding-agent/test/agent-session-dispose-recovery.test.ts`
- `packages/coding-agent/test/interactive-event-actions.test.ts`
- `packages/coding-agent/test/interactive-startup-actions.test.ts`
- `packages/coding-agent/test/suite/agent-session-runtime.test.ts`
- `packages/coding-agent/test/footer-width.test.ts`
- `packages/coding-agent/test/interactive-ui-cards.test.ts`
- `packages/coding-agent/test/main-cli-contract.test.ts`
- `packages/coding-agent/test/model-selector-pricing.test.ts`
- `packages/coding-agent/test/suite/agent-session-runtime.test.ts`
