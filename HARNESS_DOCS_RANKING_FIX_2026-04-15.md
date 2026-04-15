# Harness Docs Ranking Fix — 2026-04-15

Implemented:

- `docs_reference` now wins over generic `code_lookup` when the query is clearly asking for docs/reference material and does not include explicit repo/source-path signals.
- Docs/reference search ranking now uses query-term matching across title, URL, and snippet instead of relying mostly on host/path heuristics.

Files changed:

- [packages/coding-agent/src/core/tools/research-intent.ts](/home/alex/AG1/packages/coding-agent/src/core/tools/research-intent.ts)
- [packages/coding-agent/src/core/tools/websearch.ts](/home/alex/AG1/packages/coding-agent/src/core/tools/websearch.ts)
- [packages/coding-agent/test/web-tools-context.test.ts](/home/alex/AG1/packages/coding-agent/test/web-tools-context.test.ts)

What changed:

1. Intent detection
   - Queries with clear docs/reference wording now classify as `docs_reference` unless they also carry explicit repo/source-file signals such as `github`, `src/`, `packages/`, or file extensions.

2. Docs ranking
   - Search ranking now boosts official docs pages when the query’s meaningful terms appear in:
     - the page title
     - the URL path
     - the snippet
   - This fixes the previous behavior where a generic page on the right domain could outrank the actually relevant API/reference page.

Regression test added:

- `ranks matching framework reference pages above generic docs pages`
  - Query: `look up React docs on actions and summarize briefly`
  - Expected top result: `https://react.dev/reference/react/useActionState`

Verification:

- `npm test --workspace packages/coding-agent -- web-tools-context`
- `npm run build --workspace packages/coding-agent`
- refreshed `/usr/local/bin/ag1`
- refreshed `/usr/local/bin/cruzible`
- `ag1 --help`
- `cruzible --help`

Live probe:

- Command:
  - `ag1 --print --agent-dir /tmp/harness-probe-followup --cwd /home/alex/AG1 "look up React docs on actions and summarize briefly"`
- Session:
  - [/tmp/harness-probe-followup/sessions/--home-alex-AG1--/2026-04-14T23-43-23-075Z_60b524dc-8c82-46bf-961b-14f2486b8fc3.jsonl](/tmp/harness-probe-followup/sessions/--home-alex-AG1--/2026-04-14T23-43-23-075Z_60b524dc-8c82-46bf-961b-14f2486b8fc3.jsonl)

Observed probe behavior:

- `webSearch`
  - intent: `docs_reference`
  - top result: `https://react.dev/reference/react/useActionState`
- `webFetch`
  - fetched `useActionState`
- final answer

Why this matters:

- The old path could turn a simple docs lookup into:
  - `webSearch`
  - `webFetch`
  - `webSearch`
  - `webFetch`
- The new path completes in:
  - `webSearch`
  - `webFetch`
  - final answer

Expected impact:

- fewer wasted tool calls on framework/docs questions
- lower token burn from reduced search/fetch churn
- better first-source selection without reducing model intelligence

Next worthwhile follow-up:

- improve docs/reference summarization quality so API pages with noisy boilerplate yield cleaner key facts without the model having to reinterpret as much raw reference text
