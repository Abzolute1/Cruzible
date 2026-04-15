# Harness Follow-up Improvements — 2026-04-15

This pass focused on two things that directly affect cost and tool quality:

1. Query-intent-aware web ranking
   - `webSearch` now distinguishes:
     - `code_lookup`
     - `current_events`
     - `docs_reference`
     - `general`
   - Current-events queries no longer get misrouted toward repos/docs just because they mention a code product.
   - Docs/reference queries no longer get misclassified as “current events” just because they say `latest`.

2. Slimmer, more honest system prompts
   - Read-only/headless tool sets now get a read-only role line instead of a generic “run commands, edit files” identity.
   - The pi-doc section is shorter and cheaper while keeping the same guardrail.

Why this should help:

- Fewer wasted turns from bad first-source selection.
- Less prompt overhead every turn in headless/read-only runs.
- Better alignment between the visible tool surface and the prompt’s stated capabilities.

Verification:

- `npm test --workspace packages/coding-agent -- system-prompt web-tools-context`
- `27 passed`
- `npm run build --workspace packages/coding-agent`

Next likely high-value cost/control slice:

1. Make `webFetch` support a richer research mode only when the query intent is broad/news-heavy.
2. Stop feeding repeated “next step” prose into the model once a source is already clearly sufficient.
3. Separate current-context tokens from cumulative session totals in the footer so cost regressions are easier to spot.
