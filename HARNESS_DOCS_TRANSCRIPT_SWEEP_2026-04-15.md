# Harness Docs Transcript Sweep — 2026-04-15

Scope:

- complete the remaining docs/API fetch cleanup in one pass so the harness can move on to the next optimization area

Files changed:

- [packages/coding-agent/src/core/tools/research-output.ts](/home/alex/AG1/packages/coding-agent/src/core/tools/research-output.ts)
- [packages/coding-agent/test/web-tools-context.test.ts](/home/alex/AG1/packages/coding-agent/test/web-tools-context.test.ts)

What this sweep finished:

1. Docs-reference excerpt de-duplication
   - `formatFetchTranscriptContent(...)` now suppresses excerpt lines that are already present in:
     - the fetch title
     - the fact list
   - This removes duplicated:
     - page heading
     - API signature line
     - section headings already emitted as facts

2. Docs-only gate
   - the de-dup path is now only used for docs/reference-like fetches
   - ordinary article/research fetches keep the prior compact preview behavior
   - this prevents the docs cleanup logic from degrading non-docs summaries

3. Cleaner docs transcript shape
   - for docs pages like `useActionState`, the transcript now prefers:
     - one code example/signature-adjacent line
     - a few useful section cues
   - instead of repeating:
     - title heading
     - exact API signature already listed in facts
     - low-value `Reference` chrome

Regression coverage added/updated:

- docs excerpt lines already present in title/facts are suppressed
- non-docs rich fetch summaries still compact correctly
- docs/autonomous fetch transcript stays clean while useful section names survive

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
  - [/tmp/harness-probe-followup/sessions/--home-alex-AG1--/2026-04-15T00-02-09-268Z_40c3fbb5-ca8f-4bf9-945a-a09229240457.jsonl](/tmp/harness-probe-followup/sessions/--home-alex-AG1--/2026-04-15T00-02-09-268Z_40c3fbb5-ca8f-4bf9-945a-a09229240457.jsonl)

Observed final `webFetch` transcript:

- facts keep:
  - `` `useActionState` is a React Hook that lets you update state with side effects using Actions.``
  - `` `useActionState(reducerAction, initialState, permalink?)` ``
  - `Adding state to an Action`
  - `Using multiple Action types`
- excerpt keeps:
  - `` `const [state, dispatchAction, isPending] = useActionState(reducerAction, initialState, permalink?);` ``
  - `Using with useOptimistic`
  - `Using with Action props`
  - `Cancelling queued Actions`
- excerpt drops:
  - `# useActionState`
  - duplicate API signature already listed in facts
  - `- Reference`
  - `` `reducerAction` function ``

Expected impact:

- denser docs/API evidence in one fetch
- less token waste from repeated title/signature/reference scaffolding
- less model effort spent reinterpreting the same API line twice

This closes the docs-fetch cleanup chain started by:

- [HARNESS_DOCS_RANKING_FIX_2026-04-15.md](/home/alex/AG1/HARNESS_DOCS_RANKING_FIX_2026-04-15.md)
- [HARNESS_DOCS_FETCH_SUMMARY_2026-04-15.md](/home/alex/AG1/HARNESS_DOCS_FETCH_SUMMARY_2026-04-15.md)
- [HARNESS_DOCS_PREVIEW_FILTER_2026-04-15.md](/home/alex/AG1/HARNESS_DOCS_PREVIEW_FILTER_2026-04-15.md)

Next worthwhile optimization area:

- codebase-local inspection tools:
  - `read`
  - `grep`
  - `find`
  - `ls`
- especially around:
  - evidence de-duplication across sequential inspection calls
  - better “enough evidence” signals to stop repeated local probing
