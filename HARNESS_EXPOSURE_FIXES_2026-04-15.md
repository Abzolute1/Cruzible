# Harness Exposure Fixes — 2026-04-15

Resolved from `HARNESS_EXPOSURE_AUDIT_2026-04-15.md`:

1. Headless/print mode no longer advertises approval-gated tools.
   - `print/json/rpc` now filter active tools to `read/grep/find/ls/webSearch/webFetch`.
   - Headless block reasons now point the model at those read-only alternatives.

2. Local backend startup failures are now classified as non-retryable.
   - `Connection error`, `connection refused`, `fetch failed`, and similar local-backend failures stop useless retry loops.
   - UI and print mode now show a recovery hint that points at LM Studio / `LM_STUDIO_URL` / model switching.

3. Web ranking is more task-aware for code lookups.
   - GitHub/raw/git hosting is boosted for code-symbol and repo-path queries.
   - Generic docs/learn/answers sources are demoted for those code-lookup queries.

4. `webFetch` is less eager to claim sufficiency.
   - Import-heavy / code-heavy extracts are downgraded to `thin`.
   - This blocks the false-positive “sufficient source” path that caused weak fetches to short-circuit research.

5. Print mode now writes session debug artifacts.
   - Headless runs now start the same debug logger path as interactive sessions.

Focused verification:

- `npm test --workspace packages/coding-agent -- headless-tool-filter safety-policy turn-health assistant-message agent-session-retry-coordinator web-tools-context print-mode`
- `52 passed`
- `npm run build --workspace packages/coding-agent`

Remaining pressure points after this pass:

1. Research ranking is still heuristic.
   - It is better for repo/code lookups now, but not yet query-intent-aware beyond lightweight pattern matching.

2. Print-mode debug logging needs one stronger integration test with a real session object.
   - The current unit coverage proves the path is wired, but the fake session still lacks some of the richer debug surface.

3. Headless tool exposure is honest now, but prompt wording could still be slimmer.
   - There is still standing overhead in the headless system prompt that can be cut further.
