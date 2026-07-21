# TODO — capability-scaled guardrails ("the harness is a prison for bigger models")

**Priority: high. This is the top behavioral fix before the next release push.**

## Problem (evidence, 2026-07-20, two live sessions on nvidia/nemotron-3-ultra-550b-a55b)

Volume-triggered guardrails calibrated on small local models misfire on frontier models doing legitimately large work:

1. **Output truncation manufactures failure.** A 550B writing one large file hit the output cap mid-file (`output=8192`), then burned 4 write retries, 28k re-reasoning tokens, 194s silent, **34 minutes for one file** — while the degraded-turn nudge scolded it to "keep the next response concise."
2. **Verbosity nudges fire on productive work.** `reasons=high_output_tokens` and `error_turn` ("avoid replaying the full prior reasoning") treat frontier-model thoroughness as small-model rambling.
3. **Nudges fired on a PROVIDER failure.** The NVIDIA free-tier window cap (`ResourceExhausted: Worker local total request limit reached (32/32)`) is a rate limit, not a model failure — the harness answered with `error_turn` "think less" anyway. Wrong on two levels: provider errors need pacing/retry handling, not model scolding.
4. **Context discipline is off for big models.** The same 550B session sat at 381k in / 56k out / 77k live (29.3% of 262k) with compaction off — fine for a 262k model, but the degraded-turn warnings kept firing as if it were a 32k local model suffocating.

Behavior-triggered guardrails (loop/drift/laundering/test-integrity/budget) are correct for all model classes — do NOT touch these.

## Fix direction (agreed in session discussion)

Gate the **volume-triggered** mechanisms by the **measured capability profile** (context-window buckets, reasoning flag, provider locality, maxTokens — already computed; do NOT gate on provider name — that re-introduces the tuning-by-name smell deleted this week):

- [ ] **Degraded-turn evaluation**: skip `high_output_tokens` / verbosity-class reasons for non-local-small profiles. Choke point: degraded-turn evaluation in the auton checkpoint path (`checkpoint-control.ts` / runner's `lastTurnDegradedEvent`).
- [ ] **Output cap**: derive from the model's own `maxTokens` (or a class multiple), not a global constant. A 262k-context model should effectively never be truncated mid-artifact.
- [ ] **One-call-per-turn guidance**: keep for weak tool-callers; disable for capable profiles (frontier models parallelize fine).
- [ ] **Concision pressure in prompts/nudges**: suppress for large-artifact tasks (single-file pages, big refactors) — "write a complete file" and "be concise" contradict.
- [ ] **Provider rate-limit errors**: classify `ResourceExhausted`/`429`-class errors as provider-fault, not `error_turn` — pace/retry instead of degraded-turn nudges. HARD EVIDENCE (2026-07-20 550B session jsonl): THREE ResourceExhausted failures in one session — **80/32 at the very first turn** (window saturated by earlier sessions), then 32/32 and 62/32 mid-run — each surfaced as a model error turn. The `x/32` window counter is right in the message text — parse it for backoff duration. (The 32/32 NVIDIA window cap is documented in docs/vision-progress.md.)
- [ ] **Instrumentation**: tag nudge-fired/resolved timeline events with the model's capability class so per-class calibration becomes evidence, not guesswork (debugger already captures the events).

## New findings from the 550B session journals (2026-07-20, a_test_game COD-zombies task)

- [ ] **Truncation corrupts the heredoc fallback.** When a `write` call failed schema validation (`path` missing — emitted incomplete, likely after a capped turn), the 550B fell back to `cat > game.js << 'ENDOFFILE'` — and the output cap cut the heredoc mid-body: "here-document delimited by end-of-file" warnings, partial files, then the model confused about file state (`read offset=20000` on a 321-line file). Two fixes: (a) tool-arg validation errors should hint "the call may have been truncated — re-emit complete arguments", and (b) heredoc-style bash writes need the same cap relief as the write tool, or a warning when a heredoc is cut.
- [ ] **Write results should always confirm persisted size.** The write tool reports "Wrote 24960B" (good) but the bash fallback has no equivalent — after capped/partial writes the model cannot tell what landed. Consider: mutation results (write/edit AND bash-redirect heuristics) report final file bytes/lines.
- [ ] **Verify interactive debug logging persists in non-git cwds.** `/home/alex/Documents/a_test_game` had multiple sessions (Jul 17–21) but NO `Debug/` artifacts (dir cleaned 00:35; can't distinguish "never written" from "deleted"). If the interactive debug logger silently no-ops outside git roots, the debugger has a blind spot exactly where these sessions live. Check `SessionDebugLogger` projectRoot resolution for non-git cwds.

## UX / TUI improvements (Alex, 2026-07-21 — first live TODO sighting: 9B driving a 12-item list well)

- [ ] **Live todo rendering instead of transcript spam.** Every todo mutation currently appends a FULL fresh checklist render to the chat (a 12-item list re-printed on each of 12 updates). Wanted: one evolving todo component that updates in place (widget-style, like the footer/loader), not N renders of the same list. Also: todo updates must not require any accept/approval step — the todo tool is the model's own scratchpad, mutating it should never prompt.
- [ ] **Thinking expanded by default.** Thinking blocks render collapsed as one-line stubs ("Thinking… (76 chars)"). Alex wants them expanded so the reasoning is readable inline. Make expanded the default (or a first-class `/verbose`-adjacent toggle that defaults to on for thinking).
- [ ] **Dedupe thinking-stub litter.** Runs of tiny collapsed thinking blocks (e.g. four "Thinking… (76–371 chars)" lines in a row) flood the scrollback. If stubs stay available as a mode, collapse consecutive tiny thinking stubs into one summarized line instead of one line per block.

## Validation

- [ ] Re-run the exact 550B file-writing task from the first screenshot: expect zero volume nudges, no WRITE×4 truncation dance, wall time near model speed (was 34 min), behavior guardrails still armed in the timeline.
- [ ] Re-run the 9B dogfood fixture (/tmp/ag1-dogfood): expect the small-model economics unchanged (~41k tokens / ~8 turns) — the rails must stay down for the class that needs them.
- [ ] Suite stays 2,294+/0; tsgo/biome clean.

## References

- Capability profile: `packages/coding-agent/src/core/model-capability*.ts`, profile inference in `agent-session.ts`
- Degraded-turn path: `auton/runner.ts` (`lastTurnDegradedEvent`, `updateDegradedTurnCheckpointState`), `auton/checkpoint-control.ts`
- Guidance injection: `agent-session-prompt-coordinator.ts` (`controlled-runtime-guidance` tagged section)
- Prior discussion & analysis: session of 2026-07-20 (guardrail families: volume-triggered vs behavior-triggered)
