# Harness Cost And Fetch Tuning — 2026-04-15

This pass improved two things:

1. Richer `webFetch` only when it is actually warranted
   - `webSearch` now remembers query intent per result URL.
   - Research-heavy/news-heavy queries mark result URLs for richer fetch summaries.
   - `webFetch` and autonomous `webFetch` widen facts/preview only for those remembered URLs.
   - Ordinary docs/code fetches stay compact.

2. Footer metrics now separate live context from cumulative spend
   - `context ...` remains the current context-pressure badge.
   - `live ...` shows current context tokens.
   - `Σ↓` and `Σ↑` now clearly represent cumulative session input/output totals.

Why this helps:

- Broad research tasks get enough source detail sooner, which should cut repeated fetch churn.
- Ordinary fetches do not get more expensive just because richer research mode exists.
- The footer now makes it easier to tell whether a task is expensive because of current context pressure or because of long cumulative history.

Verification:

- `npm test --workspace packages/coding-agent -- web-tools-context footer-width`
- `23 passed`
- `npm run build --workspace packages/coding-agent`

Next likely high-value slice:

1. Make `webFetch` classify “placeholder vs thin vs rich” even earlier for obviously weak article pages.
2. Add a direct harness probe regression for research-mode fetch widening.
3. Consider shrinking repeated tool transcript coaching further once the richer fetch path is stable.
