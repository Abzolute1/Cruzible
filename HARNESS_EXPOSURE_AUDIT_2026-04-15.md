# Harness Exposure Audit

Date: 2026-04-15

Method:
- Ran real `ag1 --print` probe sessions under an isolated `--agent-dir` at `/tmp/harness-probe-agent`
- Inspected saved session JSONL directly
- Mapped observed failures back to source paths

Primary evidence:
- local backend failure sessions:
  - [0ebc7198 session](/tmp/harness-probe-agent/sessions/--home-alex-AG1--/2026-04-14T22-55-35-985Z_0ebc7198-205d-406a-8009-a82ac37155ec.jsonl:1)
  - [63103a0f session](/tmp/harness-probe-agent/sessions/--home-alex-AG1--/2026-04-14T22-55-36-000Z_63103a0f-e4fa-4b9c-9ddc-8236a225f2d0.jsonl:1)
- successful-but-drifted local session:
  - [1ae3ecbc session](/tmp/harness-probe-agent/sessions/--home-alex-AG1--/2026-04-14T22-57-09-454Z_1ae3ecbc-e494-4bfe-a322-c9121ad9b475.jsonl:1)

## Findings

### 1. Headless mode exposes a tool surface that it cannot actually execute
What went wrong:
- In a real headless `--print` run, the model chose `bash` twice for a repo-search task, and both calls were blocked immediately.
- The session then drifted into long self-talk and fallback web search instead of switching cleanly to `grep/find/read`.

Evidence:
- Headless mode installs a policy that blocks interactive approvals in [main.ts](/home/alex/AG1/packages/coding-agent/src/main.ts:689)
- `bash` is hard-blocked in headless mode in [safety-policy.ts](/home/alex/AG1/packages/coding-agent/src/core/safety-policy.ts:245)
- The live session shows:
  - first blocked `bash` call at [session line 5](/tmp/harness-probe-agent/sessions/--home-alex-AG1--/2026-04-14T22-57-09-454Z_1ae3ecbc-e494-4bfe-a322-c9121ad9b475.jsonl:5)
  - blocked tool result at [line 6](/tmp/harness-probe-agent/sessions/--home-alex-AG1--/2026-04-14T22-57-09-454Z_1ae3ecbc-e494-4bfe-a322-c9121ad9b475.jsonl:6)
  - second blocked `bash` attempt at [line 7](/tmp/harness-probe-agent/sessions/--home-alex-AG1--/2026-04-14T22-57-09-454Z_1ae3ecbc-e494-4bfe-a322-c9121ad9b475.jsonl:7)
  - blocked tool result at [line 8](/tmp/harness-probe-agent/sessions/--home-alex-AG1--/2026-04-14T22-57-09-454Z_1ae3ecbc-e494-4bfe-a322-c9121ad9b475.jsonl:8)

Why it happens:
- The harness still presents a capability shape that suggests shell search is available.
- The safety policy rejects the call only after the model has already spent reasoning/output tokens choosing it.

How to fix it:
- Remove `bash` entirely from headless tool exposure when it is not executable.
- Or expose a distinct read-only shell/search tool for headless and hide unrestricted `bash`.
- Add a hard runtime nudge after the first blocked `bash` result: `bash unavailable here; use grep/find/ls/read only`.

### 2. Provider/backend failure handling is too thin and too repetitive
What went wrong:
- When LM Studio was unreachable from the initial probe path, the harness emitted four consecutive assistant error messages with empty content and the same `Connection error.` string.
- No backend diagnostics, no stop classification, no actionable remediation, and no early abort.

Evidence:
- repeated empty assistant error turns in:
  - [0ebc7198 lines 5-8](/tmp/harness-probe-agent/sessions/--home-alex-AG1--/2026-04-14T22-55-35-985Z_0ebc7198-205d-406a-8009-a82ac37155ec.jsonl:5)
  - [63103a0f lines 5-8](/tmp/harness-probe-agent/sessions/--home-alex-AG1--/2026-04-14T22-55-36-000Z_63103a0f-e4fa-4b9c-9ddc-8236a225f2d0.jsonl:5)
- a remote-path probe also failed with a terse auth error at [44d56cbb line 5](/tmp/harness-probe-agent/sessions/--home-alex-AG1--/2026-04-14T22-56-57-881Z_44d56cbb-d1bc-402b-9095-5283d9463aab.jsonl:5)

Why it happens:
- Provider failures are being surfaced as generic assistant error turns instead of typed backend-state failures.
- The harness appears willing to retry without upgrading the explanation or terminating decisively.

How to fix it:
- Classify backend failures into:
  - local model unavailable
  - auth invalid
  - network unreachable
  - provider 5xx / timeout
- Stop after 1 failed startup attempt for these classes unless the provider is known-transient.
- Surface concrete remediation in the stored session and user-facing output.

### 3. Research source ranking is over-biased toward generic “authoritative” domains
What went wrong:
- For a codebase-specific symbol lookup, `webSearch` preferred Claude docs and later a Microsoft Answers page over the actual GitHub repository source.
- That steered the model away from the repo hit it actually needed.

Evidence:
- ranking behavior in [websearch.ts](/home/alex/AG1/packages/coding-agent/src/core/tools/websearch.ts:49)
- `preferredSourceUrls` only keeps `authoritative` hits in [websearch.ts](/home/alex/AG1/packages/coding-agent/src/core/tools/websearch.ts:209)
- transcript guidance always points to the first displayed result in [research-output.ts](/home/alex/AG1/packages/coding-agent/src/core/tools/research-output.ts:285)
- live session examples:
  - Claude docs incorrectly preferred over GitHub at [1ae3ecbc line 16](/tmp/harness-probe-agent/sessions/--home-alex-AG1--/2026-04-14T22-57-09-454Z_1ae3ecbc-e494-4bfe-a322-c9121ad9b475.jsonl:16)
  - Microsoft Answers incorrectly preferred for a repo-symbol query at [1ae3ecbc line 18](/tmp/harness-probe-agent/sessions/--home-alex-AG1--/2026-04-14T22-57-09-454Z_1ae3ecbc-e494-4bfe-a322-c9121ad9b475.jsonl:18)

Why it happens:
- “Authoritative” is scored too generically and not conditioned on task type.
- Code lookup tasks need repo/file-host boosts, not general-doc boosts.

How to fix it:
- Add task-aware reranking:
  - code-symbol / file-path queries should strongly prefer GitHub/raw source links
  - product-doc queries can prefer vendor docs
- Demote generic high-authority domains when the query contains repo paths, filenames, code symbols, or `site:github.com`.

### 4. `webFetch` can claim sufficiency on clearly insufficient content
What went wrong:
- The session fetched the raw `write.ts` source, but the returned summary only contained import lines and still declared the source “likely sufficient to answer or cite without refetching.”
- That is a false positive sufficiency signal.

Evidence:
- sufficiency text for `rich` fetches in [research-output.ts](/home/alex/AG1/packages/coding-agent/src/core/tools/research-output.ts:333)
- “reuse this URL” steering in [research-output.ts](/home/alex/AG1/packages/coding-agent/src/core/tools/research-output.ts:342)
- live fetch result at [1ae3ecbc line 15](/tmp/harness-probe-agent/sessions/--home-alex-AG1--/2026-04-14T22-57-09-454Z_1ae3ecbc-e494-4bfe-a322-c9121ad9b475.jsonl:15)

Why it happens:
- Fetch quality is assessed structurally, not against the user’s target symbol or requested fact.
- A raw source file with imports and no matching symbol evidence can still be tagged `rich`.

How to fix it:
- Add query-aware sufficiency:
  - if the user asked for a symbol/function, check whether the fetched preview/facts include it
  - if not, mark the source as incomplete, not sufficient
- Add symbol-hit extraction for raw code fetches.

### 5. The harness lets blocked-tool turns balloon into long reasoning churn
What went wrong:
- After each blocked `bash` result, the model produced a long internal explanation about why it was blocked and what alternatives might exist.
- That is pure cost pressure with almost no progress.

Evidence:
- long post-block reasoning at [1ae3ecbc lines 7, 9, 13, 17, 19](/tmp/harness-probe-agent/sessions/--home-alex-AG1--/2026-04-14T22-57-09-454Z_1ae3ecbc-e494-4bfe-a322-c9121ad9b475.jsonl:7)

Why it happens:
- The harness returns the raw block reason, but does not impose a concise recovery scaffold.
- The model is left to reason its way out in prose.

How to fix it:
- After a blocked tool class, inject a compact recovery directive instead of letting the next turn freeform:
  - `bash unavailable in headless; allowed alternatives: grep/find/ls/read/webSearch/webFetch`
- Count repeated blocked-tool attempts and terminate or replan after the second failure.

### 6. Headless/print runs lack the richer debug artifacts that would make failures easy to inspect
What went wrong:
- The probe produced JSONL sessions, but no `Debug/` timeline/session markdown artifacts under the project root.
- That makes post-mortem analysis weaker exactly in the mode where you most want deterministic audit output.

Evidence:
- interactive mode starts `SessionDebugLogger` in [interactive-mode.ts](/home/alex/AG1/packages/coding-agent/src/modes/interactive/interactive-mode.ts:845)
- this probe produced no files under `/home/alex/AG1/Debug`

Why it happens:
- The richer debug logger path is wired for interactive/autonomous flows, not ordinary headless `--print`.

How to fix it:
- Add an opt-in `--debug-session` mode for headless/print runs that writes the same `session.md`, `session.compact.md`, and `timeline.json`.

## Where To Focus Next

1. Headless tool-surface correctness
- Hide or replace `bash` in headless mode.
- Give the model only the tools it can actually use.

2. Provider failure classification
- Stop generic `Connection error.` loops.
- Emit typed backend failure reasons and abort early.

3. Research ranking/task awareness
- Make code/repo lookup prefer GitHub/raw code over generic docs.

4. Fetch sufficiency validation
- Don’t label a source “sufficient” unless it actually contains evidence relevant to the user’s ask.

5. Blocked-tool recovery control logic
- Add concise, deterministic recovery nudges after blocked tool calls.

6. Headless debug visibility
- Add full debug artifacts for `--print` probes so harness audits don’t depend on ad hoc JSONL inspection.

## Bottom Line

The harness is no longer mainly failing on raw tool formatting. The bigger pressure points are:
- wrong tool surface in headless mode
- weak backend failure handling
- task-agnostic web source ranking
- overly optimistic fetch sufficiency
- too much freeform recovery reasoning after blocked actions

Those are the next fixes that will reduce wasted turns and token burn without making the harness less capable.
