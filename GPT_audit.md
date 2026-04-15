# Planning Mode Audit

## Bugs / Regressions

1. **Illegal status transitions let non-approved plans become `accepted`**

- Refs:
  [interactive-mode.ts](/home/alex/AG1/packages/coding-agent/src/modes/interactive/interactive-mode.ts:4435),
  [interactive-mode.ts](/home/alex/AG1/packages/coding-agent/src/modes/interactive/interactive-mode.ts:4514),
  [interactive-mode.ts](/home/alex/AG1/packages/coding-agent/src/modes/interactive/interactive-mode.ts:4531),
  [interactive-plan-artifacts.ts](/home/alex/AG1/packages/coding-agent/src/modes/interactive/interactive-plan-artifacts.ts:471),
  [interactive-plan-artifacts.ts](/home/alex/AG1/packages/coding-agent/src/modes/interactive/interactive-plan-artifacts.ts:492)
- What can go wrong:
  `/plan done` and `/plan reopen` can turn a `draft`, `rejected`, `superseded`, or `discarded` artifact back into `accepted`.
  `/plan accept` can accept `rejected`, `superseded`, `discarded`, and `executing` artifacts because it only blocks `accepted` and `clarifying`.
  That means a stale or explicitly rejected plan can be resurrected without review.
- Why it happens:
  `handlePlanCommand()` does not validate allowed source statuses for `accept`, `done`, or `reopen`.
  `markInteractivePlanStepComplete()` and `reopenInteractivePlanStep()` hard-code the next status to `"accepted"`.
- How to fix it:
  Centralize transitions in one validator, for example `transitionPlanArtifact(artifact, action)`.
  Allow:
  `draft -> accepted|rejected|discarded`
  `clarifying -> clarifying|draft|discarded`
  `accepted -> executing|rejected|discarded`
  `executing -> accepted|executing`
  Reject all other transitions in code, not in UI copy.

2. **There is no stable notion of the “active” plan; revision lookup is ambiguous and accepted plans get superseded too early**

- Refs:
  [interactive-mode.ts](/home/alex/AG1/packages/coding-agent/src/modes/interactive/interactive-mode.ts:4790),
  [interactive-mode.ts](/home/alex/AG1/packages/coding-agent/src/modes/interactive/interactive-mode.ts:4871),
  [interactive-mode.ts](/home/alex/AG1/packages/coding-agent/src/modes/interactive/interactive-mode.ts:5424),
  [interactive-mode.ts](/home/alex/AG1/packages/coding-agent/src/modes/interactive/interactive-mode.ts:6118),
  [interactive-plan-artifacts.ts](/home/alex/AG1/packages/coding-agent/src/modes/interactive/interactive-plan-artifacts.ts:55),
  [PLAN_MODE.md](/home/alex/AG1/PLAN_MODE.md:14)
- What can go wrong:
  If a session contains multiple plan threads, `/plan show 1`, `/plan accept 1`, etc. are ambiguous because revision numbers are not globally unique.
  Revising an `accepted` plan immediately marks the accepted artifact `superseded` before the new revision is approved.
  After that, “latest artifact” points at the new draft/clarifying revision, so `/plan next` and the mode strip can stop referring to the actually approved executable plan.
- Why it happens:
  `getPlanArtifactByRevision()` searches by `revision` only.
  `persistLatestPlanArtifact()` supersedes `previousArtifact` even when it was `accepted`.
  UI surfaces use `getLatestPlanArtifact()` instead of an explicit active-plan pointer.
- How to fix it:
  Track plan identity as `(planId, revision)`, not revision alone.
  Introduce explicit pointers:
  `activePlanningArtifactId`
  `activeAcceptedPlanId`
  `activeExecutingPlanId`
  Do not supersede an `accepted` plan until a replacement revision is explicitly accepted.

3. **Accepted -> execution can enter `executing` with no valid step**

- Refs:
  [interactive-mode.ts](/home/alex/AG1/packages/coding-agent/src/modes/interactive/interactive-mode.ts:4844),
  [interactive-mode.ts](/home/alex/AG1/packages/coding-agent/src/modes/interactive/interactive-mode.ts:4898),
  [interactive-mode.ts](/home/alex/AG1/packages/coding-agent/src/modes/interactive/interactive-mode.ts:5298),
  [interactive-plan-artifacts.ts](/home/alex/AG1/packages/coding-agent/src/modes/interactive/interactive-plan-artifacts.ts:432),
  [interactive-plan-artifacts.ts](/home/alex/AG1/packages/coding-agent/src/modes/interactive/interactive-plan-artifacts.ts:356)
- What can go wrong:
  A fully completed accepted plan still offers “Execute full plan”.
  `executePlanArtifact()` will then append an `executing` artifact with `executionStepIndex === undefined` and no `executionStep`.
  That is a wrong state: the plan is complete, but the system says it is executing.
- Why it happens:
  `offerAcceptedPlanHandoff()` and `getPlanReviewActions()` always expose “Execute full plan”.
  `executePlanArtifact()` does not require a valid remaining step before switching status to `executing`.
- How to fix it:
  Block execution when `getNextInteractivePlanStepIndex()` is `undefined`.
  Add a terminal `completed` plan status, or keep `accepted` but refuse execution once all steps are complete.

4. **Execution review parsing is still corrupting sections, and malformed model output is silently recorded as a real review**

- Refs:
  [interactive-plan-artifacts.ts](/home/alex/AG1/packages/coding-agent/src/modes/interactive/interactive-plan-artifacts.ts:513),
  [interactive-plan-artifacts.ts](/home/alex/AG1/packages/coding-agent/src/modes/interactive/interactive-plan-artifacts.ts:697),
  [interactive-plan-artifacts.ts](/home/alex/AG1/packages/coding-agent/src/modes/interactive/interactive-plan-artifacts.ts:709),
  [interactive-plan-artifacts.ts](/home/alex/AG1/packages/coding-agent/src/modes/interactive/interactive-plan-artifacts.ts:908),
  [interactive-mode.ts](/home/alex/AG1/packages/coding-agent/src/modes/interactive/interactive-mode.ts:5311),
  [interactive-plan-artifacts.test.ts](/home/alex/AG1/packages/coding-agent/test/interactive-plan-artifacts.test.ts:532)
- What can go wrong:
  `Execution Summary` can absorb `Files Touched`.
  `Verification` can absorb `Remaining`.
  Any assistant prose with a paragraph can still become a `reviewed` step record even if the required headings were ignored.
- Why it happens:
  `findSection()` only knows about plan headings, not execution-review headings like `Remaining` or `Blockers`.
  `extractInteractivePlanStepExecutionStatus()` defaults to `reviewed`.
  `extractExecutionReviewFallbackSummary()` accepts the first non-empty paragraph.
  `executePlanArtifact()` always calls `persistPlanExecutionReview()` after the turn.
- How to fix it:
  Stop reusing the plan-section parser for execution reviews.
  Parse execution reviews with a dedicated heading map, or require a structured tool/custom artifact instead of free text.
  Refuse to record a review unless all required sections are present and bounded correctly.

5. **Mutating `/plan` commands bypass busy-state guards, and one accepted-plan action keeps the user in the wrong mode**

- Refs:
  [interactive-mode.ts](/home/alex/AG1/packages/coding-agent/src/modes/interactive/interactive-mode.ts:2436),
  [interactive-mode.ts](/home/alex/AG1/packages/coding-agent/src/modes/interactive/interactive-mode.ts:2477),
  [interactive-mode.ts](/home/alex/AG1/packages/coding-agent/src/modes/interactive/interactive-mode.ts:4345),
  [interactive-mode.ts](/home/alex/AG1/packages/coding-agent/src/modes/interactive/interactive-mode.ts:4956)
- What can go wrong:
  `/plan accept`, `/plan clear`, `/plan done`, etc. can run while the agent is streaming or compacting because built-in commands are dispatched before the normal submit path enforces busy-state rules.
  “Clear context for implementation” compacts around an accepted plan but does not switch out of planning mode, so the user can remain in read-only planning after choosing an implementation action.
- Why it happens:
  `setupEditorSubmitHandler()` routes built-ins first.
  `handlePlanCommand()` has no `isStreaming` / `isCompacting` guard.
  `handlePlanReviewAction("Clear context for implementation")` never calls `setExecutionMode("interactive")`.
- How to fix it:
  Add a command gate for state-changing plan actions when the session is busy.
  Treat implementation actions as execution-mode transitions and switch mode before compaction/execution.

6. **The no-artifact path still leaves stale planning UI behind**

- Refs:
  [interactive-mode.ts](/home/alex/AG1/packages/coding-agent/src/modes/interactive/interactive-mode.ts:1524),
  [interactive-mode.ts](/home/alex/AG1/packages/coding-agent/src/modes/interactive/interactive-mode.ts:1537),
  [interactive-mode.ts](/home/alex/AG1/packages/coding-agent/src/modes/interactive/interactive-mode.ts:3465),
  [interactive-mode.ts](/home/alex/AG1/packages/coding-agent/src/modes/interactive/interactive-mode.ts:5461),
  [PLAN_MODE.md](/home/alex/AG1/PLAN_MODE.md:177)
- What can go wrong:
  If planning output is blank, tool-only, or unparsable, the user gets only `Planning response captured. No structured plan artifact was detected yet.`
  Because the planning transcript is suppressed and the pending block still renders the latest saved artifact, the screen can keep showing an older plan as if it were the current result.
- Why it happens:
  `runPlanningPrompt()` suppresses the planning transcript and only post-processes `getLastAssistantText()`.
  If artifact extraction fails, there is no explicit reset of pending plan state.
- How to fix it:
  When planning output cannot produce a new artifact, clear any “current planning result” pointer and show an explicit failure card.
  Do not keep rendering an old plan as the implied result of the latest planning turn.

## Structural Risks

7. **The workflow dialog can strand awaiters when it is forcibly hidden**

- Refs:
  [interactive-mode.ts](/home/alex/AG1/packages/coding-agent/src/modes/interactive/interactive-mode.ts:1728),
  [interactive-mode.ts](/home/alex/AG1/packages/coding-agent/src/modes/interactive/interactive-mode.ts:1987),
  [interactive-mode.ts](/home/alex/AG1/packages/coding-agent/src/modes/interactive/interactive-mode.ts:2030)
- What can go wrong:
  A plan flow awaiting `showPlanWorkflowDialog()` can hang forever if the overlay is cleared by `resetExtensionUI()` or another forced UI reset.
- Why it happens:
  The promise returned by `showPlanWorkflowDialog()` is only resolved by `onSelect` or `onCancel`.
  `hidePlanWorkflowDialog()` and `resetExtensionUI()` do not settle that promise.
- How to fix it:
  Store the resolver and always settle it on forced close with `undefined`.
  Give plan dialogs the same abortable lifecycle that `showExtensionSelector()` already has.

8. **Planning actions are stringly typed across UI copy, hotkeys, and behavior**

- Refs:
  [interactive-mode.ts](/home/alex/AG1/packages/coding-agent/src/modes/interactive/interactive-mode.ts:4821),
  [interactive-mode.ts](/home/alex/AG1/packages/coding-agent/src/modes/interactive/interactive-mode.ts:4940),
  [plan-workflow-dialog.ts](/home/alex/AG1/packages/coding-agent/src/modes/interactive/components/plan-workflow-dialog.ts:121)
- What can go wrong:
  Renaming an action label can silently break hotkeys or action dispatch.
  Different UI surfaces can present different labels for the same underlying action.
- Why it happens:
  Actions are plain strings.
  `PlanWorkflowDialogComponent` derives hotkeys from label text.
  `handlePlanReviewAction()` switches on label text.
- How to fix it:
  Use action IDs, for example `{ id: "execute_next", label: "Execute next step", hotkey: "n" }`.
  Keep copy separate from behavior and test action IDs, not display strings.

9. **Clarification parsing and “current question” logic are duplicated and already diverging**

- Refs:
  [interactive-plan-artifacts.ts](/home/alex/AG1/packages/coding-agent/src/modes/interactive/interactive-plan-artifacts.ts:929),
  [interactive-plan-artifacts.ts](/home/alex/AG1/packages/coding-agent/src/modes/interactive/interactive-plan-artifacts.ts:1130),
  [interactive-mode.ts](/home/alex/AG1/packages/coding-agent/src/modes/interactive/interactive-mode.ts:5052),
  [interactive-mode.ts](/home/alex/AG1/packages/coding-agent/src/modes/interactive/interactive-mode.ts:5096),
  [interactive-plan-review-ui.ts](/home/alex/AG1/packages/coding-agent/src/modes/interactive/interactive-plan-review-ui.ts:78),
  [interactive-plan-review-ui.ts](/home/alex/AG1/packages/coding-agent/src/modes/interactive/interactive-plan-review-ui.ts:123)
- What can go wrong:
  The interview selector, the parser, and the review cards can disagree about the same question and its options.
  The review card can keep showing question 1 as “Current question” even after question 1 is already answered.
- Why it happens:
  Choice splitting exists both in artifact parsing and again in `InteractiveMode`.
  `formatPlanSelectorOption()` computes the next unanswered question, but `buildInteractivePlanReviewLines()` and `buildInteractivePlanCardLines()` just use `openQuestions[0]`.
- How to fix it:
  Create one normalized interview view model and reuse it everywhere.
  Compute `currentQuestionIndex` once from saved answers and pass it into all plan UI builders.

10. **Planning inspection control is still mostly prompt-driven and over-broad**

- Refs:
  [interactive-mode.ts](/home/alex/AG1/packages/coding-agent/src/modes/interactive/interactive-mode.ts:3673),
  [interactive-autonomous-stabilization.ts](/home/alex/AG1/packages/coding-agent/src/modes/interactive/interactive-autonomous-stabilization.ts:85),
  [safety-policy.ts](/home/alex/AG1/packages/coding-agent/src/core/safety-policy.ts:31),
  [safety-policy.ts](/home/alex/AG1/packages/coding-agent/src/core/safety-policy.ts:266),
  [PLAN_MODE.md](/home/alex/AG1/PLAN_MODE.md:57)
- What can go wrong:
  Any prompt containing loose anchors like `test`, `bug`, `runtime`, `.ts`, or `package.json` flips planning turns into inspection-allowed mode.
  Once inspection is allowed, the same boolean also allows `webSearch` and `webFetch`, even though repo inspection and internet research are different policies.
- Why it happens:
  `shouldAllowPlanningInspection()` is a substring heuristic on the prompt text.
  The safety policy only has a single `planningReadOnlyTools` switch.
- How to fix it:
  Split planning permissions into narrower capabilities:
  `allowRepoRead`
  `allowWebResearch`
  `allowSessionIntrospection`
  Decide them from structured context, not raw prompt substrings.

11. **Artifact normalization accepts invalid persisted states instead of enforcing invariants**

- Refs:
  [interactive-plan-artifacts.ts](/home/alex/AG1/packages/coding-agent/src/modes/interactive/interactive-plan-artifacts.ts:556),
  [interactive-plan-artifacts.ts](/home/alex/AG1/packages/coding-agent/src/modes/interactive/interactive-plan-artifacts.ts:647)
- What can go wrong:
  A persisted artifact can claim an arbitrary `status`, mismatched `executionStepIndex`, or contradictory fields and still load.
  That makes stale sessions and partial migrations harder to reason about.
- Why it happens:
  `parseInteractivePlanArtifact()` casts `candidate.status` directly and does not validate cross-field invariants.
- How to fix it:
  Validate status membership and field relationships on load.
  Examples:
  `clarifying` must have no executable steps.
  `executing` must have a valid `executionStepIndex`.
  `accepted` must not carry open execution state.

## Test Gaps

- **Multi-plan identity is effectively untested.**
  The command tests mock `getPlanArtifactByRevision()` directly instead of exercising the real lookup path:
  [interactive-plan-commands.test.ts](/home/alex/AG1/packages/coding-agent/test/interactive-plan-commands.test.ts:38),
  [interactive-plan-commands.test.ts](/home/alex/AG1/packages/coding-agent/test/interactive-plan-commands.test.ts:75).
  Missing cases:
  two different `planId`s both with revision `1`
  old accepted plan plus new draft revision
  default `/plan next` should target the active accepted plan, not merely the latest artifact

- **Illegal transitions are not covered.**
  The tests only cover happy-path `accepted` artifacts for `done`/`reopen`:
  [interactive-plan-commands.test.ts](/home/alex/AG1/packages/coding-agent/test/interactive-plan-commands.test.ts:675),
  [interactive-plan-commands.test.ts](/home/alex/AG1/packages/coding-agent/test/interactive-plan-commands.test.ts:695).
  Missing cases:
  `done` on `draft`
  `reopen` on `rejected`
  `accept` on `discarded` / `superseded`

- **Revising an accepted plan does not have a regression test for preserving the old accepted plan until approval.**
  Missing cases:
  accepted -> revise -> new `draft` should not supersede the old accepted plan yet
  accepted -> revise -> new `clarifying` should still leave the old accepted plan executable

- **Completed-plan execution is untested.**
  Missing cases:
  accepted artifact with all steps complete
  `/plan execute`
  accepted handoff “Execute full plan”
  selector action “Execute full plan”

- **Execution review parsing is only tested with shallow `toContain` assertions, so the current corruption slips through.**
  See:
  [interactive-plan-artifacts.test.ts](/home/alex/AG1/packages/coding-agent/test/interactive-plan-artifacts.test.ts:532).
  Missing assertions:
  `summary` must exclude later headings
  `verification` must not absorb `remaining`
  malformed output must be rejected instead of defaulting to `reviewed`

- **Busy-state races are untested.**
  Missing cases:
  `/plan accept` while `session.isStreaming === true`
  `/plan clear` during compaction
  plan dialog/reset while awaiting a selection

- **Some UI tests currently lock in stale or inconsistent behavior instead of detecting it.**
  [interactive-plan-review-ui.test.ts](/home/alex/AG1/packages/coding-agent/test/interactive-plan-review-ui.test.ts:59) expects “Current question” to be question 1, not the next unanswered question.
  [interactive-plan-review-ui.test.ts](/home/alex/AG1/packages/coding-agent/test/interactive-plan-review-ui.test.ts:81) expects executing cards to advertise `execute next` even though the actual executing review actions do not expose it.

## Refactor Opportunities

1. **Introduce a real plan state machine**

- One module should own transitions like `accept`, `reject`, `start_execution`, `record_review`, `mark_done`, `reopen`, `discard`.
- All UI handlers should call that module instead of appending custom entries directly.

2. **Separate “latest artifact” from “active plan”**

- Keep a history log for auditability.
- Keep explicit current pointers for planning, accepted, and executing plans.
- Most commands should target the active accepted/executing plan by default, not the latest artifact entry.

3. **Replace free-text execution review parsing with a structured artifact**

- Best option: have execution turns emit a custom JSON artifact alongside the assistant summary.
- If text parsing must stay, use a dedicated parser with strict required sections and explicit failures.

4. **Create a shared plan/interview view model**

- Compute:
  `progress`
  `nextStepIndex`
  `currentQuestionIndex`
  `availableActions`
  `availableHotkeys`
- Feed that into the mode strip, pending block, review cards, interview, and selector.

5. **Stop dispatching plan actions by display string**

- Replace label matching with typed action IDs.
- Make `PlanWorkflowDialogComponent` render labels, not own semantics.

## Recommended Attack Plan

1. **Enforce legal transitions in one place.**
   Block `accept`, `done`, and `reopen` from illegal source states immediately.

2. **Introduce active-plan identity.**
   Stop using `revision` alone and stop defaulting everything to `getLatestPlanArtifact()`.

3. **Fix execution-review parsing now.**
   The current parser is producing wrong data; either tighten it hard or replace it with a structured artifact path.

4. **Remove premature superseding of accepted plans.**
   A newly drafted revision should not invalidate the last approved executable plan.

5. **Add real pipeline tests instead of mocked happy paths.**
   Cover multi-plan sessions, illegal transitions, completed-plan execution, busy-state races, and dialog teardown.
