# Harness Local Evidence Signals

## Goal

Reduce over-exploration after `grep` or `find` has already produced enough local evidence to take the next step.

## What Changed

### `grep`

- When `grep` yields exactly one definitive match and the output is not truncated, it now appends a compact next-step hint:
  - `[1 match in path/to/file.ts:123; next: read path/to/file.ts offset=118]`

This is intentionally narrow:

- no hint when results are truncated
- no hint when the match limit was hit
- no noisy prose for broad searches

### `find`

- When `find` yields exactly one definitive result and the output is not truncated, it now appends:
  - file result: `[1 match; next: read file.ts or grep inside it]`
  - directory result: `[1 directory match; next: ls src/]`

Again, this only appears when the result set is decisive.

## Why This Matters

The previous local-tool guidance taught the model to discover first, but it still had to infer whether discovery was already sufficient.

These follow-up hints make the next step explicit when the evidence is already conclusive, which should reduce:

- extra `find` / `grep` loops
- redundant directory exploration
- unnecessary reasoning turns after a clear single match

## Evidence

Tool-level regressions now lock in the model-visible transcript shape:

- [tools.test.ts](/home/alex/AG1/packages/coding-agent/test/tools.test.ts)
  - single `grep` match emits:
    - `[1 match in single-match.ts:2; next: read single-match.ts offset=1]`
  - single file `find` match emits:
    - `[1 match; next: read only.ts or grep inside it]`
  - single directory `find` match emits:
    - `[1 directory match; next: ls src/]`

## Probe Note

I attempted new live `ag1 --print` probes for:

- `find which file owns rankResearchResults and summarize what it does`
- `find the file that defines formatSearchTranscriptContent and tell me what it outputs`

Saved sessions:

- [/tmp/harness-probe-followup/sessions/--home-alex-AG1--/2026-04-15T00-16-46-993Z_1d71a594-ba3c-4ab8-9ba4-9791cbdaf1d1.jsonl](/tmp/harness-probe-followup/sessions/--home-alex-AG1--/2026-04-15T00-16-46-993Z_1d71a594-ba3c-4ab8-9ba4-9791cbdaf1d1.jsonl)
- [/tmp/harness-probe-followup/sessions/--home-alex-AG1--/2026-04-15T00-16-47-207Z_bc74bfad-9970-4a45-b5e3-60772a353279.jsonl](/tmp/harness-probe-followup/sessions/--home-alex-AG1--/2026-04-15T00-16-47-207Z_bc74bfad-9970-4a45-b5e3-60772a353279.jsonl)

Those runs stalled before producing usable tool events, so the strongest evidence for this sweep remains the direct tool-output regressions above rather than the live probe artifacts.

## Next Pressure Point

The remaining local-tool optimization is likely evidence de-duplication across nearby `grep` / `read` / `find` calls:

- avoid rediscovering the same file after a decisive match
- avoid rereading the same snippet when the relevant lines are already in transcript context
