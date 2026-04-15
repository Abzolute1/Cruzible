# Harness Local Discovery Guidance

## Goal

Reduce wasted local-inspection turns by steering the model toward `grep`, `find`, and `ls` before it guesses paths and misuses `read`.

## What Changed

- `read` now exposes stronger discovery guidance:
  - use `find` when the path is uncertain
  - use `grep` to locate symbols/strings before opening files
  - use `ls` to inspect directories before reading files inside them
- `read` now returns actionable errors instead of raw filesystem misses:
  - `Path not found: ... Use find to locate files or ls to inspect directories before retrying read.`
  - `Path is a directory: ... Use ls to inspect it, then read a specific file.`
- `grep`, `find`, and `ls` now each include prompt guidance that teaches the discovery workflow explicitly.

## Evidence

### Bad Baseline

Default headless probe before this sweep:

- [/tmp/harness-probe-followup/sessions/--home-alex-AG1--/2026-04-15T00-06-21-150Z_1c9c109e-6b88-40c4-8009-b47222f4090c.jsonl](/tmp/harness-probe-followup/sessions/--home-alex-AG1--/2026-04-15T00-06-21-150Z_1c9c109e-6b88-40c4-8009-b47222f4090c.jsonl)
  - guessed a path and used `read`
  - hit ENOENT
  - did not use discovery tools first

- [/tmp/harness-probe-followup/sessions/--home-alex-AG1--/2026-04-15T00-06-21-181Z_a124dc37-9cce-427e-9356-8205ca42a02d.jsonl](/tmp/harness-probe-followup/sessions/--home-alex-AG1--/2026-04-15T00-06-21-181Z_a124dc37-9cce-427e-9356-8205ca42a02d.jsonl)
  - tried to `read` a directory
  - got raw `EISDIR`
  - continued path-guessing instead of switching cleanly to discovery tools

### Improved Path

Probe with the local inspection tool set available:

- [/tmp/harness-probe-followup/sessions/--home-alex-AG1--/2026-04-15T00-07-27-512Z_63926f19-ef46-4efd-859d-e8893005fe00.jsonl](/tmp/harness-probe-followup/sessions/--home-alex-AG1--/2026-04-15T00-07-27-512Z_63926f19-ef46-4efd-859d-e8893005fe00.jsonl)
  - first tool: `grep`
  - then `grep` with context
  - only then `read` on the correct file and line range

- [/tmp/harness-probe-followup/sessions/--home-alex-AG1--/2026-04-15T00-07-27-458Z_4812f9c0-8e6f-4af4-9d92-c02f156beec8.jsonl](/tmp/harness-probe-followup/sessions/--home-alex-AG1--/2026-04-15T00-07-27-458Z_4812f9c0-8e6f-4af4-9d92-c02f156beec8.jsonl)
  - first tool: `find`
  - then `ls`
  - then `grep`
  - the model still made one bad `read` path guess later, but the discovery workflow was materially better

## Why This Matters

This should reduce:

- wasted turns on guessed paths
- repeated `ENOENT` / `EISDIR` churn
- token burn from long reasoning detours after a bad first tool choice

It should improve:

- first-tool choice on file/symbol lookup tasks
- local evidence gathering before opening files
- resilience in headless/read-only runs

## Remaining Pressure Point

The model can still over-explore directories before searching source directly.

Next likely optimization in this area:

- add stronger “enough evidence” / “next best tool” signals in `grep` and `find`
- probe repeated symbol/file lookup tasks and de-duplicate nearby local evidence
