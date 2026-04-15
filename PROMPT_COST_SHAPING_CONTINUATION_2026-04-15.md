# Prompt Cost Shaping Continuation

## Completed
- Slimmed the base system prompt in `packages/coding-agent/src/core/system-prompt.ts`.
- Removed the long pi-doc topic enumeration and replaced it with a shorter docs rule.
- Reduced repeated web-research guidance in the base prompt to a denser 3-line rule set.
- Compacted `read` continuation notices in `packages/coding-agent/src/core/tools/read.ts`.
- Compacted inspection-style `bash` transcript output in `packages/coding-agent/src/core/tools/bash.ts`.
- Compacted `grep/find/ls` limit notices and empty-result payloads.
- Shortened `write/edit` success payloads to state-dense forms.
- Added an inspection-output compaction regression in `packages/coding-agent/test/tools.test.ts`.
- Fixed `tools.test.ts` to use temp-directory-scoped tool instances instead of repo-root singletons, which keeps the workspace containment guard intact.
- Fixed `edit-tool-no-full-redraw.test.ts` to compute diffs inside its temp workspace instead of repo cwd.
- Kept existing behavior contracts covered in:
  - `test/system-prompt.test.ts`
  - `test/agent-session-dynamic-tools.test.ts`
  - `test/web-tools-context.test.ts`
- `test/tools.test.ts`
- `test/tool-execution-component.test.ts`
- `test/edit-tool-legacy-input.test.ts`
- `test/edit-tool-no-full-redraw.test.ts`

## Remaining High-Value Cost Work
1. Separate footer metrics clearly:
   - current live context
   - cumulative session input/output
   - current-turn delta
2. Compress more tool transcript prose into structured evidence blocks:
   - bash for non-inspection commands
   - auton-side tool transcript parity
   - degraded-turn / recovery prompt addenda
3. Reduce repeated “next step” coaching when the model already demonstrated correct tool sequencing.
4. Audit prompt addenda and runtime injections for duplicated guidance across:
   - base system prompt
   - mode/runtime addenda
   - degraded-turn recovery prompts
   - autonomous steering nudges
5. Add a token-regression test harness for representative tasks:
   - web research
   - repo audit
   - read/edit/test coding loop

## Next Recommended Slice
- Separate footer metrics clearly so live context is not confused with cumulative session totals.
- Then audit an actual harness-driven tool session (`ag1 --print` / saved session artifacts) to inspect the exact transcript payloads the model sees, not just the UI rendering.
