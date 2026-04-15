# Web Research Quality Plan

## Goals
- Reduce repeated `webSearch` / `webFetch` loops caused by weak or misleading fetch summaries.
- Improve fetched-page quality detection so placeholder/interstitial pages are labeled clearly.
- Preserve low token usage by making transcript payloads denser, not just longer.
- Keep interactive and autonomous web tools behavior aligned.

## Planned Changes
1. Add shared fetch-quality assessment for:
   - placeholder/interstitial pages
   - thin extracts
   - usable/rich source summaries
2. Improve preview selection so `webFetch` surfaces informative lines instead of page chrome.
3. Add fact fallback from meta descriptions when article extraction is thin.
4. Change fetch transcript wording:
   - stop telling the model every rich fetch is “only a compact preview”
   - explicitly mark placeholder/thin sources
   - say when a source summary is likely sufficient for answering
5. Add fact extraction to autonomous `webFetch` so it is not materially weaker than interactive mode.
6. Tighten `webSearch` transcript guidance to be shorter and less repetitive.
7. Add regression tests for:
   - placeholder pages
   - thin extracts
   - rich extracts that should not trigger extra fetch churn
   - autonomous fetch fact extraction parity

## Remaining Follow-Up
- Consider richer extraction for JS-heavy pages if simple HTML fetch remains too lossy.
- Consider a “research mode” that spends slightly more context on web results only when the task explicitly requests broad summarization.
