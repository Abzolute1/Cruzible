# Harness Docs Fetch Summary Cleanup — 2026-04-15

Implemented:

- shared research extraction now strips common docs/API chrome before building previews and facts
- docs-reference fetches no longer promote generic meta descriptions into key facts

Files changed:

- [packages/coding-agent/src/core/tools/research-output.ts](/home/alex/AG1/packages/coding-agent/src/core/tools/research-output.ts)
- [packages/coding-agent/src/core/tools/webfetch.ts](/home/alex/AG1/packages/coding-agent/src/core/tools/webfetch.ts)
- [packages/coding-agent/src/core/auton/tools/webfetch.ts](/home/alex/AG1/packages/coding-agent/src/core/auton/tools/webfetch.ts)
- [packages/coding-agent/test/web-tools-context.test.ts](/home/alex/AG1/packages/coding-agent/test/web-tools-context.test.ts)

What changed:

1. Docs/API chrome filtering
   - preview and fact extraction now drop lines that are mostly docs scaffolding, such as:
     - `API Reference Hooks Copy pageCopy`
     - generic docs-navigation token clusters
     - the React tagline `The library for web and native user interfaces`

2. Meta description handling
   - `docs_reference` fetches no longer inject generic meta descriptions into the fact list just because they are long enough
   - non-docs research fetches keep the old behavior when that summary is still useful

3. Shared behavior
   - both interactive and autonomous `webFetch` now use the same stricter docs cleanup path

Regression coverage added:

- preview filters docs scaffolding
- fact extraction filters docs scaffolding
- autonomous `webFetch` suppresses docs boilerplate for remembered `docs_reference` URLs

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
  - [/tmp/harness-probe-followup/sessions/--home-alex-AG1--/2026-04-14T23-49-27-629Z_53c64607-6b76-4ecd-b886-354e43705acb.jsonl](/tmp/harness-probe-followup/sessions/--home-alex-AG1--/2026-04-14T23-49-27-629Z_53c64607-6b76-4ecd-b886-354e43705acb.jsonl)

Observed probe behavior:

- search still ranks `useActionState` first
- fetched fact list is now cleaner:
  - keeps:
    - `` `useActionState` is a React Hook that lets you update state with side effects using Actions.``
    - `` `useActionState(reducerAction, initialState, permalink?)` ``
  - drops:
    - `The library for web and native user interfaces`
    - `API Reference Hooks Copy pageCopy`

Expected impact:

- better first-fetch usefulness on docs/API pages
- less model effort spent reinterpreting docs chrome
- lower token waste because the model gets denser evidence from a single fetch

Remaining smaller gap:

- preview text can still include low-value reference bullets such as `- Reference`
- next follow-up should tighten preview filtering for docs pages without stripping useful section names like `Using with Action props`
