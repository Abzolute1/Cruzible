# Harness Docs Preview Filter — 2026-04-15

Implemented:

- preview filtering for docs/API fetches now drops low-value reference bullets without stripping useful section names

Files changed:

- [packages/coding-agent/src/core/tools/research-output.ts](/home/alex/AG1/packages/coding-agent/src/core/tools/research-output.ts)
- [packages/coding-agent/test/web-tools-context.test.ts](/home/alex/AG1/packages/coding-agent/test/web-tools-context.test.ts)

What changed:

1. Preview-only docs cleanup
   - `buildResearchPreview(...)` now filters low-value docs bullets such as:
     - `- Reference`
     - `- API Reference`
     - `` - `reducerAction` function ``
   - This is preview-only tightening; it does not broadly strip useful section names.

2. Useful section names preserved
   - lines like `Using with Action props` remain eligible for the preview/detail path
   - the goal is denser reference evidence, not more aggressive summarization

Regression coverage:

- preview test now proves:
  - low-value bullets are removed
  - useful section names survive
- autonomous `webFetch` test still verifies docs boilerplate stays out of the model-visible transcript while useful sections survive in preview details

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
  - [/tmp/harness-probe-followup/sessions/--home-alex-AG1--/2026-04-14T23-55-32-464Z_7078763b-da2d-49d0-b023-0a1468d92cd2.jsonl](/tmp/harness-probe-followup/sessions/--home-alex-AG1--/2026-04-14T23-55-32-464Z_7078763b-da2d-49d0-b023-0a1468d92cd2.jsonl)

Observed:

- `webSearch` still ranks `useActionState` first
- `webFetch` transcript no longer contains:
  - `- Reference`
  - `` `reducerAction` function ``
- preview detail still contains useful sections such as:
  - `Using with Action props`
  - `Using with useOptimistic`

Expected impact:

- slightly denser docs/API previews
- less model attention wasted on low-value docs chrome
- lower risk of the model paraphrasing navigation/reference scaffolding as if it were substance

Next worthwhile follow-up:

- de-duplicate docs previews further when the signature already appears in both facts and excerpt
- consider promoting one or two meaningful section headings into the transcript when they add answer quality without increasing churn
