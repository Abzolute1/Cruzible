# AG1 Audit Execution Plan

This plan translates the GPT-5.5 Pro audit into a conservative hardening pass. The goal is to make direct reliability and safety improvements without starting a broad architecture rewrite in one pass.

## Immediate Scope

1. Restore deleted skill Markdown that is part of runtime/test behavior.
   - Restore `packages/coding-agent/docs/skills.md`.
   - Restore example and fixture `SKILL.md` files.
   - Do not restore benchmark artifacts or broad deleted docs.

2. Lock down `webFetch`.
   - Allow only `http:` and `https:`.
   - Reject localhost, loopback, private, link-local, multicast, documentation, and otherwise reserved IP ranges.
   - Resolve hostnames before fetch and reject private/reserved DNS targets.
   - Ask curl to report HTTP status and final effective URL.
   - Reject redirects into blocked targets.
   - Enforce a bounded response size.
   - Do not cache failed or rejected fetches as usable content.

3. Disable implicit binary auto-download.
   - `rg` and `fd` may still be used when installed locally or available on `PATH`.
   - Automatic download is disabled by default.
   - Temporary escape hatch: `AG1_ALLOW_TOOL_AUTO_DOWNLOAD=1`.
   - Keep offline behavior unchanged.

4. Verification.
   - Add focused tests for webFetch network policy and tool auto-download default behavior.
   - Run targeted tests.
   - Run `npm run build --workspace packages/coding-agent`.
   - Run `git diff --check`.

## Deferred Follow-Up

These remain important but are intentionally not mixed into this first pass:

- transaction-safe file mutation layer
- retrieval module decomposition
- autonomous runtime state machine
- bash full-output secret-retention cleanup
- streaming/ranged `read`

## Second Slice

5. Generalize benchmark-shaped production heuristics.
   - Remove benchmark-specific command/script lookup wording from production search and steering code.
   - Replace benchmark-harness special cases with generic repo-level command/script lookup guidance.
   - Remove metric-name special casing tied to old benchmark output.
   - Keep tests for the generic behavior so the useful navigation improvements remain.

## Third Slice

6. Make built-in file mutations transactional.
   - Keep the existing per-file mutation queue.
   - Route default local `edit` and `write` writes through same-directory temp files and atomic rename.
   - Preserve existing file permissions on overwrite.
   - Clean temporary files on failed writes.
   - Simplify abort handling so a tool call does not report cancellation while a background mutation is still running.

7. Reduce bash full-output secret retention.
   - Keep normal bash responses bounded by the existing rolling buffer and truncation result.
   - Do not write full command output to temp logs by default.
   - Add an explicit escape hatch: `AG1_RETAIN_BASH_FULL_OUTPUT=1`.
   - When retention is enabled, create temp files with owner-only permissions.

8. Bound default text reads.
   - Keep image handling unchanged.
   - Keep custom read operations backward compatible.
   - Add a default local streaming text window path so large files are counted and sampled without retaining the entire file in memory.
   - Preserve existing offset/limit/truncation behavior.

## Fourth Slice

9. Tighten unmanaged tool safety.
   - Keep built-in read/search tools allowed in read-only modes.
   - Keep built-in edit/write/bash behavior under existing mode-specific policy.
   - Block unmanaged custom tools in headless, planning, and autonomous modes unless listed in `trustedTools`.
   - Require interactive approval for unmanaged custom tools in interactive mode.
   - Keep autonomous support tools such as `verify` and visual verification available in autonomous mode.

10. Start autonomous control decomposition.
    - Extract budget pressure classification out of the monolithic autonomous runner.
    - Extract budget trim/squeeze directives and checkpoint counter updates.
    - Add direct unit tests for the extracted budget-control helper.
    - Keep the runner behavior unchanged and verify the existing runner suite.

11. Continue autonomous control decomposition conservatively.
    - Extract intent/degraded-turn control directives out of the monolithic autonomous runner.
    - Keep escalation behavior unchanged for recover, replan, narrow-scope, and stop-blocked directives.
    - Add direct unit tests for the extracted intent-control helper, including pending ledger state.
    - Verify the existing autonomous runner suite after extraction.

12. Extract autonomous verification checkpointing.
    - Move mutation/verification/visual-check classification out of the runner.
    - Keep bash verification command recognition behavior unchanged.
    - Keep visual blocking issue summaries and verification failure previews unchanged.
    - Add direct unit tests for verification checkpoint behavior.
    - Verify the existing autonomous runner suite after extraction.

13. Extract autonomous checkpoint counter transitions.
    - Move no-tool, completion, verification, truncation, degraded-turn, and intent streak updates out of the runner.
    - Keep the checkpoint state shape unchanged for resume snapshots.
    - Add direct unit tests for counter transitions.
    - Verify the existing autonomous runner suite after extraction.

## Fifth Slice

14. Add deterministic compaction working memory.
    - Extract a structured working-memory ledger during compaction.
    - Persist goals, constraints, read files, modified files, commands, failed attempts, verification state, next steps, and open questions in compaction details.
    - Append an inspectable working-memory block to compaction summaries so retained context is not only free-text LLM summarization.
    - Carry previous working memory through repeated compactions.
    - Add direct tests for extraction, carry-forward, and formatting.

15. Add opt-in actual-context audit artifacts.
    - Add an environment-gated `AG1_CONTEXT_AUDIT_DIR` logger.
    - Write the exact provider context after hygiene/live-context/image filtering.
    - Keep logging disabled by default and write audit files with owner-only permissions.
    - Add direct tests for disabled/enabled behavior.

## Sixth Slice

16. Add typed autonomous harness invariants.
    - Introduce a typed invariant evaluator for autonomous ledger state.
    - Require evidence before implementation, repair before verifier reruns, verification after mutation, and ledger-backed completion.
    - Prefix the next autonomous prompt with the required next action while preserving existing specialized directives.
    - Add direct tests and verify the autonomous runner suite.

17. Add model capability profiles.
    - Infer a conservative profile from model/provider/base URL/context window/input/reasoning metadata.
    - Classify small local OpenAI-compatible models with stricter tool-output, planning, XML fallback, and compaction recommendations.
    - Expose the profile as a core export and include it in opt-in context audit artifacts.
    - Add direct tests for local, frontier, and unknown hosted profiles.

18. Tighten fuzzy edit semantics.
    - Keep exact replacement as the default behavior.
    - Make fuzzy matching explicit with `allowFuzzyMatch`.
    - Report fuzzy usage in tool text and structured edit details.
    - Update fuzzy tests to assert opt-in behavior and add a default-reject regression test.

## Status

- [x] Restore skill Markdown.
- [x] Harden `webFetch`.
- [x] Disable implicit binary auto-download.
- [x] Add tests.
- [x] Run verification.
- [x] Generalize benchmark-shaped local search heuristics.
- [x] Add transactional built-in file writes.
- [x] Verify mutation safety tests.
- [x] Make bash full-output retention opt-in.
- [x] Verify bash retention tests.
- [x] Bound default text reads.
- [x] Verify read behavior tests.
- [x] Tighten unmanaged tool safety.
- [x] Verify safety policy tests.
- [x] Extract autonomous budget-control helper.
- [x] Verify autonomous budget-control and runner tests.
- [x] Extract autonomous intent-control helper.
- [x] Verify autonomous intent-control and runner tests.
- [x] Extract autonomous verification-control helper.
- [x] Verify autonomous verification-control and runner tests.
- [x] Extract autonomous checkpoint-control helper.
- [x] Verify autonomous checkpoint-control and runner tests.
- [x] Add deterministic compaction working memory.
- [x] Verify compaction working-memory tests.
- [x] Add opt-in actual-context audit artifacts.
- [x] Verify context audit tests.
- [x] Add typed autonomous harness invariants.
- [x] Verify invariant and autonomous runner tests.
- [x] Add model capability profiles.
- [x] Verify model capability tests.
- [x] Make fuzzy edit matching opt-in and reported.
- [x] Verify edit/tool tests.
