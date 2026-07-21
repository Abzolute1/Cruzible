# AG1 Audit Action Plan

This plan turns the deep audit into an execution order. The priority is intelligence-per-dollar: make the harness safer, more reliable, and cheaper before adding surface area.

## Phase 1: Critical Correctness And Safety

1. [x] Make headless `--autonomous` use the same isolated autonomous workspace path as interactive autonomy.
2. [x] Add tests that prove headless autonomy activates, uses, restores, and reports the isolated workspace.
3. [x] Add session-file locking or another write-serialization guard around session persistence.
4. [x] Add redaction to `AG1_CONTEXT_AUDIT_DIR` output before full prompts/messages are written.

## Phase 2: Autonomy Control Plane

1. [x] Split `core/auton/runner.ts` into a small state machine plus policy/prompt modules.
2. [x] Replace regex-only completion detection with a structured finalization contract.
3. [x] Make autonomous state transitions testable without model text.
4. [x] Surface current autonomous state, verifier, budget pressure, and next allowed action in `/session`.

## Phase 3: Cost And Context Efficiency

1. [x] Promote deterministic working memory to the primary compacted state.
2. [x] Add token attribution for system prompt, tool schemas, retained transcript, summaries, and tool outputs.
3. [x] Cache stable repo indexes and tool-result facts across turns.
4. [x] Route cheap summarization, title, direct lookup, and duplicate-detection tasks to cheaper models.

## Phase 4: Architecture Cleanup

1. [x] Reduce coordinator naming/ownership overlap around `AgentSession`.
2. [x] Extract `interactive-mode.ts` into smaller UI ownership modules.
3. [x] Add a concise architecture diagram and control-flow document.
4. [x] Remove or archive public-repo clutter such as debug output, backups, and scratch audit files.

## Phase 5: Product And Open-Source Readiness

1. [x] Reconcile root README and package README so positioning, autonomy, safety, and limitations match.
2. [x] Add a contributor-oriented getting-started path with build/test commands and package map.
3. [x] Add benchmark documentation comparing cost, pass rate, turns, and recovery quality.
4. [x] Publish clear security boundaries: what AG1 blocks, what it cannot block, and recommended sandbox usage.

## Phase 6: Ambitious Differentiators

1. [x] Add an LSP/repo-map layer for cheap codebase intelligence.
2. [x] Add a durable event-sourced session store with concurrent writer safety.
3. [x] Add a stronger sandbox backend for unattended execution.
4. [x] Build a benchmark harness against OpenCode, Aider, Codex CLI, Claude Code, and Continue.
