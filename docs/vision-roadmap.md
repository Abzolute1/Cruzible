# Vision roadmap — beat opencode (autonomous work plan, 2026-07-18)

**Vision:** a release that outperforms opencode on **cost-per-solved-task** and **long-session reliability** while being **more token efficient**. Correctness first (no session loss, no hangs); cheap-model routing last.

**Measured state at plan time**
- Eval (6 scenarios, qwen3.5-9B, external verify): ag1 **6/6**, ~24s avg, **36.5k tokens/solved** · opencode 1.17.20 **5/6**, ~93s avg, tokens unknown.
- Shipped: honest eval harness + cost-per-solved metric; verification gate; stall watchdog (600s) + undici/SDK timeout fixes; condensed UI v2 (render-time grouping, thinking collapse, rail, /verbose); economy items (−4.9% tokens); NVIDIA 550B wired as default model.

## Phase 1 — Eval strength (gates every later decision)
1. `scripts/benchmark-scenarios-v4.json`: ≥8 new scenarios (cross-file refactor, build-error diagnosis, flaky-test repair, docs-lookup answer, entrypoint wireup, precision multi-edit, git regression hunt, long-file bug hunt, shell script fix). Honest by construction: deterministic fixtures, `node --test`/shell exit-code verifies, no benchmark-aware product code.
2. Run suite v4 (6 old + 8 new) 2–3× on local 9B → variance table (pass rate, tokens/solved mean±spread).
3. `scripts/opencode-usage.mjs`: scrape opencode's on-disk session storage for the eval workspaces → real opencode token numbers in the comparison report.
4. One confirmation run on the NVIDIA 550B (budget-aware: ≤1 full suite) to separate model-vs-harness signal. Local models for iteration.

## Phase 2 — Efficiency, measured first
1. Transcript analysis over eval context-audit dirs: count duplicate/repeated tool calls (same tool+args), oversized tool results, re-reads. Write findings into vision-progress.md.
2. Implement the top 1–3 wins the data supports (candidates: repeat-read dedup/notice, tighter bash/grep result compaction, schema/cache micro-wins). Each change must show an eval delta (tokens/solved, pass rate unchanged).
3. Re-run A/B: tokens/solved before vs after.

## Phase 3 — Reliability leftovers
1. Proxy path (`packages/agent/src/proxy.ts`): stall watchdog parity with the provider EventStream (600s default, env override).
2. Mid-turn rebuild in-flight tool result loss: fix if small, else document precisely in vision-progress.md.
3. Re-verify: full builds + suites green (only the known pre-existing failures).

## Phase 4 — Report
- `docs/vision-progress.md`: metrics tables (baseline → now), what shipped, what the data says, next bets.

**Rules while autonomous:** no git commits; don't touch the user's in-flight NVIDIA files; no swarms unless strictly necessary; verify every change (build + targeted tests + eval where applicable); keep changes minimal and honest.
