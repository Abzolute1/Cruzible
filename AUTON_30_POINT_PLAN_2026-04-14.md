# 30-Point Harness Hardening Plan

Date: 2026-04-14

Status legend:
- `[x]` completed in this pass
- `[~]` in progress in this pass
- `[ ]` pending

1. `[x]` Fix explicit CLI startup-model drift in the real file-backed runtime path.
2. `[x]` Make `/new` preserve the live runtime model explicitly.
3. `[x]` Make `/new` preserve the live runtime thinking level explicitly.
4. `[x]` Centralize retry/compaction replay freshness rules in one shared helper.
5. `[x]` Ensure replay freshness checks consider model changes, not just transcript changes.
6. `[x]` Ensure replay freshness checks consider thinking-level changes, not just transcript changes.
7. `[ ]` Decide whether replay freshness should also consider cwd/session identity changes.
8. `[x]` Remove duplicate snapshot/can-replay logic from retry and compaction coordinators.
9. `[x]` Add retry regression coverage for stale replay after transcript mutation.
10. `[x]` Add retry regression coverage for stale replay after model switch.
11. `[x]` Add retry regression coverage for stale replay after thinking-level switch.
12. `[x]` Add compaction regression coverage for stale replay after transcript mutation.
13. `[x]` Add compaction regression coverage for stale replay after model switch.
14. `[x]` Add compaction regression coverage for stale replay after thinking-level switch.
15. `[x]` Add coverage for duplicate recovery triggers against the same stale snapshot.
16. `[x]` Audit whether recovery timers should emit an explicit skipped-replay event in all cases.
17. `[x]` Decide whether auto-compaction skipped replays should surface to the user or stay silent.
18. `[x]` Centralize delayed replay scheduling/cancellation instead of only centralizing eligibility.
19. `[x]` Audit retry and compaction timer cleanup on abort/dispose/session replacement.
20. `[ ]` Reduce prompt churn in retry recovery prompts and continuations.
21. `[ ]` Reduce prompt churn in compaction follow-up resumes.
22. `[ ]` Audit per-turn system prompt addenda for cache-hostile mutations.
23. `[ ]` Add a stable wrapper pattern for recovery prompts with a small changing tail.
24. `[ ]` Check whether autonomous resume modes can reuse the same replay freshness helper.
25. `[ ]` Audit model switching during queued recovery for stale state leaks into footer/status UI.
26. `[ ]` Add targeted tests for recovery behavior across `/new`, `/resume`, and `/fork`.
27. `[ ]` Revisit recovery after overflow compaction to ensure only one replay path is armed.
28. `[ ]` Verify no hidden dependency on async settings writes remains in runtime transitions.
29. `[ ]` Rebuild and refresh system installs after each major hardening slice.
30. `[ ]` Keep continuation markdown current so the next autonomous pass starts from evidence, not rediscovery.

## Current execution slice

This pass executed items 4 through 17 and continued 18:
- shared replay freshness helper
- retry + compaction adoption
- regression tests for transcript/model/thinking drift
- replay ownership arbiter across retry and compaction
- explicit `recovery_replay_skipped` events for retry + compaction
- interactive status surfacing for compaction replay skips
- `AgentSession.dispose()` now aborts pending retry/compaction/tree/bash work before teardown
- runtime-level regressions for pending retry/compaction across `newSession()` and `switchSession()`
- shared `AgentSessionRecoveryReplayScheduler` now owns replay timers, stale-state checks, arbiter claims, and skip events
