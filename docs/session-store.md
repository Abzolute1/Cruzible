# Session Store

AG1 sessions are durable JSONL event streams. Each entry records one session event such as a message, compaction, model change, thinking-level change, label change, branch summary, or custom extension record.

## Event Shape

Entries have stable `id` and `parentId` fields. This makes a session file a tree, not only a flat transcript. `/tree`, `/fork`, branch summaries, and in-place branch navigation all build on this structure.

## Write Safety

`SessionManager` is the only component that should write session files. It provides:

- append-only entry persistence for normal turns;
- full-file rewrite paths for migrations and branch edits;
- session-file locking around rewrite operations;
- stale lock recovery;
- merge-before-rewrite protection so one writer does not clobber entries appended by another manager;
- temp-file rewrite followed by rename.

## Compaction Entries

Compaction is also an event. The compacted summary keeps a `firstKeptEntryId`, `tokensBefore`, and structured `details`, including file-operation metadata and deterministic working memory. The full original history remains in the event stream unless a future explicit maintenance operation removes it.

## Ownership Rule

Callers should append semantic entries through `SessionManager` methods instead of editing JSONL directly. Runtime code should rebuild live context from the session manager after compaction, tree navigation, or branch operations.
