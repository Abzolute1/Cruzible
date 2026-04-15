# Harness Probe Results — 2026-04-15

Direct probe runs against the live local harness:

1. Research-heavy query
   - Prompt: `research the latest claude code leak and summarize it`
   - Session: [/tmp/harness-probe-followup/sessions/--home-alex-AG1--/2026-04-14T23-34-35-836Z_2d16152c-fcb9-449f-bbff-ab1b00008516.jsonl](/tmp/harness-probe-followup/sessions/--home-alex-AG1--/2026-04-14T23-34-35-836Z_2d16152c-fcb9-449f-bbff-ab1b00008516.jsonl)

Observed:

- The harness did exactly:
  - `webSearch`
  - `webFetch`
  - final answer
- No repeated search/fetch churn.
- `webSearch` tagged the query as `current_events`.
- `webFetch` returned a widened summary:
  - 6 facts
  - longer preview
  - enough evidence for the model to stop after one fetch

Conclusion:

- The richer research fetch path is working.
- This is the intended “fewer tool calls, more useful first fetch” behavior.

2. Docs/reference query
   - Prompt: `look up React docs on actions and summarize briefly`
   - Session: [/tmp/harness-probe-followup/sessions/--home-alex-AG1--/2026-04-14T23-35-49-002Z_8bf94a61-625a-4baf-8add-5da8c5416770.jsonl](/tmp/harness-probe-followup/sessions/--home-alex-AG1--/2026-04-14T23-35-49-002Z_8bf94a61-625a-4baf-8add-5da8c5416770.jsonl)

Observed:

- First `webSearch` classified the query as `code_lookup`, not `docs_reference`.
- Top result was wrong for the user’s likely intent:
  - `react.dev/reference/react-dom/components/form`
- The model had to recover manually:
  - ignore the first result
  - fetch `useActionState`
  - search again for “React actions overview”
  - fetch again
- So this simple docs lookup expanded into:
  - `webSearch`
  - `webFetch`
  - `webSearch`
  - `webFetch`

Conclusion:

- The compact fetch behavior worked as intended for a normal docs query.
- But ranking/intent still wastes turns on framework-doc queries where the right source is present but not ranked first.

Main takeaways:

1. The recent research/fetch changes improved the broad-research path.
2. The remaining pressure point is search intent and ranking for docs/framework queries.
3. The next useful fix is not “more fetch”.
   - It is better query-intent detection plus title/snippet ranking for docs/reference searches.

Recommended next fix:

- Add a `framework_docs` / `api_reference` style intent that boosts official reference pages with matching terms in the title/snippet, not just domain/path scoring.
- For example, `React actions documentation` should favor `useActionState` over generic `<form>` reference pages.
