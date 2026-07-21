# Routing design (Phase B) — cheap by default, strong on demand

**Thesis (data-backed):** on easy tasks the harness is good enough that strength goes unused (550B: 6/6 @ 42.6k vs 9B: 6/6 @ 38.4k). On hard tasks the cheap model alone can burn the whole budget without finishing (`multi_file_feature` 9B timeout vs pass). So: run cheap by default, pay for strength only where it measurably matters.

## Current state

- `core/model-routing.ts` — `selectCheapModelForTask` picks the cheapest eligible model (context window / maxTokens / cost; `local` = 0). Used today for compaction summarization + branch titles.
- Driver model for a session: `session.model`, used for every agent turn. Retry coordinator already counts retry attempts per run.
- Cross-provider mid-run switching is safe: `providers/transform-messages.ts` normalizes thinking blocks + tool-call IDs across providers.

## B1 — cheap-by-default subtask routing

Extend existing cheap routing to every non-driver call site:

| Call site | Route | Min context |
|---|---|---|
| Compaction summary | cheapest eligible (existing) | 32k |
| Branch/session titles | cheapest eligible (existing) | 8k |
| Micro-compact hidden-content trims | cheapest eligible | 32k |
| Web-research snippets/coverage scoring (if model-graded — check) | cheapest eligible | 16k |

Rules: driver model untouched; routing must be silent in the transcript (same message shapes); log the route choice into the session debug log only.

## B2 — escalation-on-struggle

New mechanism: mid-run model escalation for the *driver*.

- **Trigger:** `retryAttempt >= 2` on a single turn, OR 2 consecutive turns with zero successful tool calls, OR turn budget consumed >60% with the ledger's plan items >50% incomplete (auton only).
- **Action:** swap the driver to the configured `escalationModel` (user setting; default: strongest authenticated model — 550B here) for the remainder of the run. One escalation per run (no flapping).
- **Record:** ledger event + footer notice ("escalated to <model> after N failed turns") so users see the spend decision.
- **Fallback:** if escalation model equals driver or no auth → no-op.

## B3 — measurement gates (before any of this ships as default)

1. v4 suite 3× per arm (cheap-only, B1, B1+B2): pass rate must not regress; tokens/solved must drop ≥10% on B1; hard-scenario pass rate must not drop on B2 (expect it to rise).
2. Report in `docs/vision-progress.md` with variance.

## Risks / non-goals

- No model switching *within* a single LLM call (obviously).
- No cost-based user surprises: escalation must be visible (footer + ledger), never silent.
- Cross-provider quirks on switch: thinking blocks from the prior model get dropped/normalized by transform-messages; verified by tests, but watch the first real switch in a live session.
- Local models as "cheap" is correct for tokens but not wall-clock: B1 must not route latency-critical interactive text to a 35B local if the driver is an API model (route only within same "latency class" unless the task is offline: compaction/summaries are offline-safe).
