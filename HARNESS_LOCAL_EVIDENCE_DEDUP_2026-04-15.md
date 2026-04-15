# Harness Local Evidence De-dup

## Goal

Reduce wasted local-inspection turns after the harness has already surfaced decisive file evidence.

## What Changed

### Shared tracked-file extraction

Added [tool-outcome-file.ts](/home/alex/AG1/packages/coding-agent/src/core/tool-outcome-file.ts) so both interactive mode and the session debug logger classify local evidence the same way.

It now extracts the concrete file/directory from:

- `grep` single-match output and follow-up hints
- `find` single file/directory results and follow-up hints
- `read` / `edit` / `write` result text
- `ls` requested directory path

This matters because repeated rediscovery was previously recorded as the search root like `"."` instead of the actual file that had already been found.

### Better local nudge signal

Updated [nudge-warnings.ts](/home/alex/AG1/packages/coding-agent/src/core/nudge-warnings.ts):

- repeated file-access detection now keys off the repeated file itself, not the full fingerprint
- discovery-only loops (`grep` / `find` / `ls`) now warn with a more explicit message:
  - `Repeatedly rediscovering <file>. Reuse the evidence you already have instead of searching again.`

### Wiring

Both:

- [interactive-mode.ts](/home/alex/AG1/packages/coding-agent/src/modes/interactive/interactive-mode.ts)
- [session-debug-logger.ts](/home/alex/AG1/packages/coding-agent/src/core/session-debug-logger.ts)

now use the shared tracked-file extraction path.

## Evidence

Regression coverage:

- [nudge-warnings.test.ts](/home/alex/AG1/packages/coding-agent/test/nudge-warnings.test.ts)
  - extracts the real file from `grep` / `find` transcript content
  - verifies the stronger rediscovery warning

- existing local-tool suite still passes:
  - [tools.test.ts](/home/alex/AG1/packages/coding-agent/test/tools.test.ts)

## Expected Effect

This does not directly remove transcript lines. It improves control logic:

- repeated local discovery loops are classified more accurately
- user-visible warnings become more actionable
- debug artifacts reflect the real evidence target, not just `"."`

That should make it easier to stop wasteful rediscovery in interactive runs and easier to diagnose remaining loops from session artifacts.

## Remaining Pressure Point

The next meaningful local-tool optimization is turn-level memory, not just warnings:

- if `grep` already found a single definitive file in the current turn, avoid needing another discovery call before `read`
- if `find` and `grep` both surface the same file within a short window, bias the next step toward `read` or answer, not more search
