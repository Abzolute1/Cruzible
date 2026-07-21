# AG1 Audit Request

Repo: https://github.com/Abzolute1/Cruzible

You are reviewing AG1 as a serious coding-agent/harness project. Please do a deep technical audit, not a surface-level code review. The goal is to find real correctness risks, architectural weaknesses, security issues, excessive complexity, brittle assumptions, missing tests, and places where the system will fail under weaker/local models.

## Project Vision

AG1 is intended to be a pragmatic, model-agnostic coding agent that works well with both frontier APIs and cheaper/local models. The important design goal is not just "more tools"; it is a harness that actively helps models behave better:

- reduce wasted tool calls
- prevent loops and repeated discovery
- guide weaker models toward the right files and evidence
- keep local/repo evidence compact and actionable
- make web retrieval source-aware instead of raw search-result dumping
- preserve exact technical identifiers and errors
- support autonomous coding tasks with verification and clean stopping behavior
- make behavior inspectable through tests, diagnostics, and TUI/tool output

Please evaluate whether the current codebase actually supports that vision, and where it is overbuilt, underbuilt, brittle, or internally inconsistent.

## Main Areas To Review

### 1. Tool Layer

Audit all core tools and tool orchestration, especially:

- `packages/coding-agent/src/core/tools/*`
- `packages/coding-agent/src/core/tool-orchestrator.ts`
- `packages/coding-agent/src/core/tools/websearch.ts`
- `packages/coding-agent/src/core/tools/webfetch.ts`
- `packages/coding-agent/src/core/tools/research-intent.ts`
- `packages/coding-agent/src/core/tools/research-output.ts`
- `packages/coding-agent/src/core/local-evidence-steering.ts`
- `packages/coding-agent/src/core/evidence-planner.ts`
- `packages/coding-agent/src/core/workspace-index.ts`

Questions:

- Are tool schemas and outputs clear enough for weaker/local models?
- Are tool outputs too verbose, too lossy, or inconsistent?
- Are the read/find/grep/edit/write/bash tools safe and predictable?
- Are path handling, workspace boundaries, and mutation controls robust?
- Are policy blocks helpful or likely to block legitimate work?
- Are there race conditions or state leaks across turns/sessions?
- Are diagnostics exposed in the right place, or mixed into user-visible output too much?

### 2. Web Retrieval Layer

The retrieval layer was recently upgraded from basic DuckDuckGo search/fetch into a more source-aware subsystem. Please audit the implementation and tests.

Intended behavior:

- DuckDuckGo HTML remains the free default.
- Optional paid providers are provider-abstracted but not required.
- Query planning should preserve exact identifiers and make vague/current/docs/pricing/error/source queries more specific.
- Search ranking should prefer official docs, source repos, primary sources, and strong technical coverage.
- Fetch should classify pages as rich/thin/placeholder.
- Fetch output should assess whether enough evidence exists to answer.
- Loop prevention should block duplicate/broad/redundant research without imposing blind hard caps.

Review:

- `websearch.ts`
- `webfetch.ts`
- `research-intent.ts`
- `research-output.ts`
- `agent-session.ts` web research budget logic
- `agent-session-web-research-budget.test.ts`
- `web-tools-context.test.ts`

Questions:

- Is the provider abstraction clean enough for Brave/SerpAPI/Tavily/Exa later?
- Are DDG parser assumptions too fragile?
- Is source ranking defensible, or too heuristic?
- Are coverage slots useful or likely to mislead the model?
- Does loop prevention risk blocking valid research?
- Are fallback URLs, cache keys, and provider diagnostics implemented safely?
- Are tests deterministic and meaningful, or too coupled to implementation details?

### 3. Autonomous Runtime And Control

Audit autonomous-mode behavior and the newer control pieces:

- `packages/coding-agent/src/modes/autonomous-mode.ts`
- `packages/coding-agent/src/core/auton/*`
- `packages/coding-agent/src/core/task-policy.ts`
- `packages/coding-agent/src/core/task-intent.ts`
- `packages/coding-agent/src/core/patch-intent.ts`
- `packages/coding-agent/src/core/prompt-intent-steering.ts`
- `packages/coding-agent/src/core/repair-controller.ts`
- `packages/coding-agent/src/core/stop-controller.ts`
- `packages/coding-agent/src/core/verification-controller.ts`
- `packages/coding-agent/src/core/run-diagnostics.ts`

Questions:

- Is autonomous behavior understandable and maintainable?
- Are stop/repair/verification controls principled, or just benchmark-shaped heuristics?
- Is there too much policy scattered across files?
- Can frontier models and local 9B models both use this effectively?
- Are there regressions for normal human-guided interactive use?
- Are benchmark-specific ideas leaking too much into production behavior?

### 4. Agent Session Architecture

Please deeply inspect:

- `packages/coding-agent/src/core/agent-session.ts`
- related coordinators under `packages/coding-agent/src/core/agent-session-*`
- session manager/debug/logger/runtime/bootstrap code
- compaction and summarization modules

Questions:

- Is session state coherent?
- Are tool calls, retries, compaction, model switching, and event dispatch separated cleanly?
- Are there hidden ordering bugs?
- Does session-level state reset correctly between turns?
- Are failures recoverable and observable?
- Is `agent-session.ts` still too large or too central?

### 5. Model/Provider Handling

Audit provider/model support:

- `packages/ai/src/providers/*`
- `packages/ai/src/models.generated.ts`
- `packages/coding-agent/src/core/model-registry.ts`
- `packages/coding-agent/src/core/model-resolver.ts`
- `packages/coding-agent/src/core/provider-secret-file.ts`
- LM Studio/local model handling

Questions:

- Are provider abstractions internally consistent?
- Is auth/token handling safe?
- Are local model IDs and OpenAI-compatible providers resolved cleanly?
- Are provider errors surfaced well?
- Are generated model files or provider maps likely to drift?

### 6. Security And Safety

Please look for practical risks:

- command execution risks
- path traversal or symlink issues
- accidental edits outside workspace
- secret leakage in logs/transcripts
- GitHub/token/provider credential handling
- unsafe default permissions
- prompt-injection paths through fetched web pages or repo files
- extension/plugin attack surface

Be concrete. If a risk exists only under a certain mode or config, say that.

### 7. TUI And User Experience

Review:

- `packages/coding-agent/src/modes/interactive/*`
- tool rendering components
- status/debug/report views
- compact webSearch/webFetch display

Questions:

- Is the UI giving enough information without noise?
- Are tool states clear during live use?
- Are there likely layout regressions?
- Is debugging information discoverable?
- Are interactive and autonomous modes consistent?

### 8. Tests And Quality Bar

Review tests under:

- `packages/coding-agent/test/*`
- `packages/ai/test/*`
- other package tests

Questions:

- Which critical behavior is missing tests?
- Which tests are brittle or too implementation-specific?
- Are there fixtures or helper patterns that will be hard to maintain?
- Are deleted docs/benchmark artifacts referenced by tests or runtime code?
- Are there stale benchmark-specific tests that should be renamed or reframed?

## Important Context

The repo was intentionally cleaned before this review:

- benchmark artifacts were removed
- benchmark runner/scenario files were removed
- non-README Markdown docs were removed

That cleanup was done to reduce noise for audit. If you find broken references caused by this cleanup, call them out. Especially check package scripts, docs links, tests, examples, and hardcoded file paths.

Also note that some "benchmark" language may remain in production code/tests because AG1 has a controlled-runtime concept that was developed using benchmark fixtures. Please distinguish between:

- genuinely useful model-control logic
- stale benchmark-only logic that should be removed
- naming that should be generalized

## Requested Output Format

Please structure the review like this:

1. Executive Summary
   - overall assessment
   - top 5 risks
   - top 5 highest-leverage improvements

2. Blockers
   - bugs or design issues that should be fixed before relying on this release
   - include file paths and line references

3. High Severity Findings
   - correctness, security, data-loss, or major UX risks
   - include concrete repro or failure scenario when possible

4. Medium Severity Findings
   - maintainability, brittle heuristics, missing tests, unclear APIs

5. Low Severity Findings
   - cleanup, naming, docs, polish

6. Architecture Review
   - where the system is well designed
   - where responsibilities are blurred
   - suggested module boundaries

7. Tool And Harness Review
   - specific critique of tool behavior, tool outputs, policy controls, and weak-model support

8. Retrieval Layer Review
   - specific critique of search planning, ranking, provider abstraction, fetch coverage, and loop prevention

9. Security Review
   - secrets, shell execution, filesystem boundaries, web content, extension surface

10. Test Review
   - missing coverage
   - brittle tests
   - recommended new tests

11. Suggested Patch Plan
   - ordered list of changes
   - group into "quick fixes", "medium refactors", and "larger redesign"
   - avoid vague advice; give implementation-level guidance

12. Questions For The Maintainer
   - only questions that materially affect design decisions

## Review Standards

Please be direct and skeptical. Do not spend much space praising the project. Focus on what can break, what is hard to maintain, and what would make AG1 more reliable.

Use source-grounded claims. If you infer intent from code, say so. Prefer findings with:

- exact file path
- relevant function/class name
- observed behavior
- why it matters
- suggested fix

Avoid generic comments like "add more tests" unless you specify the exact behavior and a recommended test shape.

## Core Question

Does AG1 currently look like a coherent, reliable, model-agnostic coding-agent harness, or is it accumulating brittle heuristics faster than durable architecture?

Answer that directly, then support the conclusion with evidence.
