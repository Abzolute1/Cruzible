# Plan Mode

This document describes what plan mode is supposed to do, how the current pipeline works, and which failure modes have already been hardened.

## Goal

Plan mode should feel like a distinct phase, not normal chat with a different prompt.

For an underspecified request, the pipeline should:

1. enter a read-only planning turn
2. avoid edits, bash, and exploratory churn
3. ask only the missing implementation questions first
4. open a structured interview UI when clarification is needed
5. produce a concrete plan only after the key choices are fixed
6. move the user into review/approval, not raw assistant prose

For a well-specified request, the pipeline should:

1. stay read-only
2. produce a structured plan immediately
3. save a plan artifact
4. open the approval/review flow

## Intended Pipeline

### 1. Mode entry

Interactive mode switches into planning mode.

Planning mode should enforce:
- no edits
- no bash
- no normal execution actions
- read-only planning-only UI and status

Relevant code:
- [interactive-mode.ts](/home/alex/AG1/packages/coding-agent/src/modes/interactive/interactive-mode.ts)
- [safety-policy.ts](/home/alex/AG1/packages/coding-agent/src/core/safety-policy.ts)

### 2. Prompt shaping

The user’s visible prompt should stay simple.

Hidden planning guidance should instruct the model to:
- remain read-only
- avoid narrating inspection
- ask clarifying questions first for greenfield/generic asks
- not invent language/platform/framework/library choices
- return either:
  - `Summary + Clarifying Questions`
  - or a full structured plan

Relevant code:
- [interactive-autonomous-stabilization.ts](/home/alex/AG1/packages/coding-agent/src/modes/interactive/interactive-autonomous-stabilization.ts)

### 3. Tool policy during planning

For generic greenfield asks, the planner should not:
- browse
- search
- inspect the repo
- churn through tools before asking the first questions

If the task is actually codebase-bound, limited read-only inspection may be allowed.

Relevant code:
- [interactive-mode.ts](/home/alex/AG1/packages/coding-agent/src/modes/interactive/interactive-mode.ts)
- [safety-policy.ts](/home/alex/AG1/packages/coding-agent/src/core/safety-policy.ts)

### 4. Artifact extraction

After the model responds, the harness parses the output into one of:
- `clarifying`
- `draft`

This is the critical fork.

If the response contains clarifying questions, the artifact should become `clarifying`, not `draft`.

If the response contains a real plan, it should become `draft`.

Relevant code:
- [interactive-plan-artifacts.ts](/home/alex/AG1/packages/coding-agent/src/modes/interactive/interactive-plan-artifacts.ts)

### 5. Clarifying interview

If the artifact is `clarifying`:
- do not dump a normal plan review card first
- open the interview flow directly
- use selector choices where possible
- persist per-question answers
- allow “continue planning with current answers”

Relevant code:
- [interactive-mode.ts](/home/alex/AG1/packages/coding-agent/src/modes/interactive/interactive-mode.ts)
- [interactive-plan-review-ui.ts](/home/alex/AG1/packages/coding-agent/src/modes/interactive/interactive-plan-review-ui.ts)
- [plan-workflow-dialog.ts](/home/alex/AG1/packages/coding-agent/src/modes/interactive/components/plan-workflow-dialog.ts)

### 6. Draft review

If the artifact is `draft`:
- show the dedicated review/approval surface
- allow approve / approve + clear context / revise / reject
- preserve the plan artifact and revision history

Relevant code:
- [interactive-mode.ts](/home/alex/AG1/packages/coding-agent/src/modes/interactive/interactive-mode.ts)
- [interactive-plan-review-ui.ts](/home/alex/AG1/packages/coding-agent/src/modes/interactive/interactive-plan-review-ui.ts)
- [plan-review-card.ts](/home/alex/AG1/packages/coding-agent/src/modes/interactive/components/plan-review-card.ts)

## What We Had To Harden

### 1. The model used to ignore planning and narrate inspection

Early behavior looked like:
- “let me inspect files”
- attempted bash
- raw chat planning text

Fixes:
- hidden planning guidance instead of visible scaffold
- stricter read-only instructions
- planning-time tool blocking

### 2. Valid plans were not always parsed as plans

Markdown headings plus `Step 1:` labels were initially too brittle.

Fixes:
- parser accepts markdown headings
- parser accepts `Step N:` style

### 3. Clarifying questions were misparsed as plan steps

This caused:
- question lists to become `draft`
- approve/reject UI to appear when the user should have gotten an interview

Fixes:
- numbered/bulleted question lists are reclassified into `clarifying`
- interrogative `Steps:` lists are reclassified into `clarifying`

### 4. Clarifying responses were too dependent on raw model wording

The first interview path was too brittle.

Fixes:
- question normalization
- option extraction from:
  - colon lists
  - parentheses
  - brackets
  - chained `?` forms
- fallback option synthesis for common categories:
  - language
  - platform/interface
  - scope/features

### 5. Generic asks still sometimes produced “draft + open questions”

This was one of the most important remaining defects.

Example bad behavior:
- the model wrote a full snake-game plan
- then attached open questions like language/platform
- the parser accepted it as `draft`

Current fix:
- for greenfield/generic goals, if foundational choices are still open
  - language
  - platform
  - runtime/framework/library
- the extractor forces `clarifying`
- step list is discarded for that revision

### 6. Sometimes no artifact was detected at all

This produced:
- `Planning response captured. No structured plan artifact was detected yet.`

That is unacceptable for obvious generic asks.

Current fix:
- if extraction fails on a greenfield planning request
- synthesize a fallback `clarifying` artifact with standard interview questions
- this is a post-response recovery path, not a pre-model shortcut

### 7. Wrapper phrasing around plan mode used to bypass the greenfield gate

Examples:
- `Hey, let's enter planmode for a snake game!`
- `start planning mode for a snake game`

These are still obviously generic planning asks, but early heuristics keyed too literally on verbs like `plan` and missed `planmode` or wrapper phrases.

Current fix:
- normalize `planmode` and `planningmode`
- extract the real subject from wrappers like `enter plan mode for ...`
- use that subject for:
  - foundational-choice detection
  - post-response fallback recovery
  - stored plan goal text

Important design choice:
- the harness should not open a clarifying interview before the planner model responds
- the model should still ask the actual questions first
- fallback interviews exist only to recover from bad or non-structured model output

### 8. Auto-open planning UI should not narrate slash commands excessively

When the harness already opens:
- the interview dialog
- or the review dialog

the surrounding status line should not read like a slash-command manual.

Current fix:
- clarification status now stays short and notes that the interview opened
- draft-plan status now stays short and notes that the review opened
- explicit slash-command guidance is still available when needed, but it is no longer repeated on every automatic handoff

### 9. The interview overview should expose selector choices

If a question already has normalized options, the interview surface should hint at them before the user enters a sub-selector.

Otherwise the UI feels like:
- a question list with hidden mechanics
- or a text prompt even though the real interaction is selector-driven

Current fix:
- unanswered structured questions now show a short `Choices:` preview
- previews are truncated to avoid turning the interview into a wall of options
- answered questions keep their saved answer visible instead

### 10. Status text should read like workflow state, not storage events

Examples of bad copy:
- `Saved interview answer 1/3 for plan v1`

That sounds like internal bookkeeping, not product UI.

Current fix:
- per-answer status now reports interview progress directly
- example: `Interview: 1/3 answered.`

## Current Design Decisions

### Clarifying-first is intentionally stronger than draft-first

For greenfield/generic planning, the harness now prefers:
- asking questions first

over:
- accepting a half-grounded plan with open questions

This is deliberate.

### Planning no longer should depend on degraded-turn recovery behavior

Planning is a structured phase.

It should not inherit “recover tersely from the failed turn” behavior from a previous degraded assistant response. If planning starts from a bad runtime state, the fix should be in the planning harness, not left to the model.

## Practical Expectations

### Good outcome for generic ask

Input:
- `let's plan out a snake game`

Expected:
- no raw tool churn
- no bash
- no generic assistant preamble
- immediate clarifying interview
- likely questions:
  - language
  - platform/interface
  - scope/features

### Good outcome for specified ask

Input:
- `plan a snake game in TypeScript for the browser using canvas`

Expected:
- direct draft plan
- no clarifying interview unless something genuinely critical is still missing

## Remaining Risk Areas

These are still worth watching in future passes:

- model-specific formatting oddities can still affect extraction
- degraded-turn state can still leak into user-visible planning UX if not fully isolated
- live TUI behavior can diverge from unit-tested parser behavior
- selector wording and visual polish can still improve
- PTY capture of the full alt-screen interview/review flow is still weak, so live smoke tests need to be interpreted cautiously

## Files To Read First

If a future agent needs to continue plan-mode work, start here:

- [interactive-mode.ts](/home/alex/AG1/packages/coding-agent/src/modes/interactive/interactive-mode.ts)
- [interactive-plan-artifacts.ts](/home/alex/AG1/packages/coding-agent/src/modes/interactive/interactive-plan-artifacts.ts)
- [interactive-plan-review-ui.ts](/home/alex/AG1/packages/coding-agent/src/modes/interactive/interactive-plan-review-ui.ts)
- [interactive-autonomous-stabilization.ts](/home/alex/AG1/packages/coding-agent/src/modes/interactive/interactive-autonomous-stabilization.ts)
- [interactive-plan-artifacts.test.ts](/home/alex/AG1/packages/coding-agent/test/interactive-plan-artifacts.test.ts)
- [interactive-plan-commands.test.ts](/home/alex/AG1/packages/coding-agent/test/interactive-plan-commands.test.ts)
- [interactive-mode-status.test.ts](/home/alex/AG1/packages/coding-agent/test/interactive-mode-status.test.ts)
