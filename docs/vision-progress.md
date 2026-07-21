# Vision progress — beating opencode (2026-07-18, autonomous session)

**The metric that matters:** cost per solved task (pass rate × tokens × wall time), on identical fixtures, externally verified.

## Headline comparison — v4 full suite (15 scenarios, qwen3.5-9B local, same hardware)

| Harness / model | Solved | Total tokens | Tokens/solved | Notes |
|---|---|---|---|---|
| **ag1 + qwen3.5-9B** | **14/15, 15/15** | 483,309 / 526,873 | **34,522 / 35,125** | best cost; one scenario flip-flops on model nondeterminism |
| opencode + qwen3.5-9B | 15/15 | 915,080 | 61,005 | full pass at **1.75× our token cost** |
| ag1 + Nemotron 550B (NVIDIA free tier) | 7/15, 10/15 | 530,672 / 657,029 | 75,810 / 65,703 | `ResourceExhausted 32/32` window cap kills 1–2 scenarios per run (instant, 0 tokens); ~2× our tokens even when passing |

**At equal pass rate, ag1 is ~1.75–1.77× more token-efficient.** Earlier v3.5 (6 easy scenarios) was 1.87×; opencode survives the harder suite on pass rate but not on cost. The 550B is not a free upgrade: on small deterministic tasks its long thinking doubles spend while the free-tier window cap randomly kills scenarios — the right shape is cheap-by-default with strength on demand (the 550B did solve `multi_file_feature`, the 9B's hardest scenario, at 107k tokens).

Environment lessons baked in: LM Studio runs must be sequential per model (single slot; JIT swaps kill in-flight streams), the 9B must be loaded at ≥32k context, and NVIDIA free-tier runs need request pacing or tolerance for mid-run `32/32` kills.

## Headline comparison (suite v3.5, 6 scenarios, qwen3.5-9B local, same hardware)

| Harness | Solved | Total tokens | Tokens/solved | Avg duration |
|---|---|---|---|---|
| **ag1** | **6/6 (100%)** | 230,238 | **38,373** | **24s** |
| opencode 1.17.20 | 5/6 (83%) | 359,345 | **71,869** | 93s |

**ag1 is 1.87× more token-efficient per solved task, ~4× faster, and solves more.** opencode token data comes from its own SQLite session DB via the new `scripts/opencode-usage.mjs` scraper (matches sessions by workspace directory; verify results joined from the runner). First time the comparison has real usage on both sides.

Post-economy-items ag1 run (grounding + schema diet + notice removal): 36,512 tokens/solved (−4.9%), 6/6 — so the current ratio is ~**1.97×**.

## Model-vs-harness split (suite v3.5, 6 scenarios)

| Model | Solved | Tokens/solved | Notes |
|---|---|---|---|
| qwen3.5-9B (local) | 6/6 | 38,373 | turns 7–12/scenario |
| Nemotron 3 Ultra 550B (NVIDIA API) | 6/6 | 42,583 | turns 10–12, durations up to 290s (long thinking) |

Read: on easy tasks the harness is good enough that the 550B's strength goes unused — it costs *more* (reasoning tokens, extra verification turns) for the same 6/6. The 9B's only v4 failure (`multi_file_feature` timeout debugging its own broken retry) is exactly where a stronger model would differentiate. This validates the user's sequencing: cheap-by-default, strength on demand — routing is the lever, and it's a *budget* question, not a capability one.

## Shipped this session (all verified)

| Item | What | Verification |
|---|---|---|
| Eval honesty | headline metrics = solved + cost/tokens per solved; heuristic composite demoted to "deprecated, do not tune" | smoke + baseline runs |
| `scripts/eval-compare.mjs` | one-command cross-harness comparison (ag1/opencode/codex/claude) | baseline comparison run |
| `scripts/opencode-usage.mjs` | scrapes opencode's `opencode.db` for real token usage per eval workspace | 359,345 tokens matched over 6/6 sessions |
| `scripts/benchmark-scenarios-v4.json` | 9 new honest scenarios (refactor, build-error, flaky-test, docs lookup, entrypoint, precision, long-file, shell script, multi-file feature) | every fixture fails pre-fix for the intended reason |
| Verification gate | text-claimed "done" can't complete a mutating run; real checkpoint required | 3 regression tests; auton suite 71/71 |
| Stall watchdog | provider streams die loudly after N ms of silence (default 600s, `AG1_STREAM_STALL_TIMEOUT_MS`) | event-stream tests |
| Long-generation fix | undici 300s `bodyTimeout` + OpenAI SDK 600s default killed long local generations at ~310s/~610s | 35B browser-game repro survived 38-min turn |
| Live generation stats | TUI loader shows phase, ~tokens, tok/s, elapsed, and a silence counter | 5 tracker tests |
| Condensed UI | thinking auto-collapse, 2-line tool blocks, hint dedup, render-time family grouping, turn rail, `/verbose` | component + rail suites |
| NVIDIA 550B | `nvidia-nim` provider wired, secrets-file precedence over stale env, set as default model | end-to-end answers in-harness |

## Token anatomy (9B, per scenario avg)

- ~4.0k input/turn × 7–12 turns; output ~1–2.4k total.
- Base per-turn cost: system prompt ~1.1k (compact local profile) + tool schemas ~1.2k (was ~1.34k before diet).
- Final-context content ~3k; tool results ~600 tokens. Tool-call duplicates: 1.9% (not worth a heuristic).

## Transcript-analysis findings (drove what we did NOT do)

- Exact-duplicate tool calls: 1/52 (1.9%) — no dedup logic warranted.
- `ls`+`read` dance persists post-grounding on tiny fixtures (mixed deltas) — grounding still pays on real-size workspaces; not worth forcing.
- Dominant cost is **turns × base prompt cost**. Remaining levers, in order: cheap-model routing (late-stage goal), model strength (fewer wasted turns), prompt caching on API models.

## Model-flip bug (found via Phase A, fixed same day)

The "550B" v3_5 numbers in this doc were **not the 550B**: `--autonomous` silently switched the driver model to `local/lm-studio` at workspace-isolation time. Root cause: `switchSession` re-creates the session, and `createAgentSessionFromServices` only restored the header model when the session had *messages* (`hasExistingSession` = messages.length > 0). A fresh session carries the model in its header with zero messages, so resolution fell through to `pickPreferredAvailableModel` → `local/lm-studio`. Fix: `core/sdk.ts` now restores the header model whenever present (auth-gated), regardless of message count. Verified: `--autonomous --provider nvidia-nim --model 550B` stays on the 550B through workspace isolation (both model_changes 550B, turns on nvidia-nim). Side effects of the same collision: LM Studio's single slot JIT-thrashing also `terminated` opencode's parallel v4 run — benchmarks on one shared local server must run sequentially.

## Efficiency changes shipped (measured)

1. **Economy set** (grounding, schema diet, notice removal): 38,373 → 36,512 tokens/solved (−4.9%), re-confirmed at 35,339 avg on the same 6 scenarios in v4 run 1. Pass rate held.
2. **AG1-docs relevance gate** (`system-prompt.ts isAg1Workspace`): the AG1-docs pointer section is only sent when the workspace package.json is `ag1*`/`@ag1/*` — saves ~260 chars/turn on non-AG1 projects. Mechanism is deterministic (verified by prompt comparison, tests green); the eval delta (~1.6%) is below run-to-run noise, so the honest claim is mechanism, not measurement: `/tmp/ag1-eval-docsgate-v35` (5/6 — `strict_precision` flipped to fail on pure variance; input/turn ≈ 3,894 flat vs 3,908 as expected within noise).

## What the data said NO to

- Duplicate-call dedup (1.9% occurrence — not worth it).
- Forcing more prompt/schema cuts — remaining base cost is functional; further trimming risks capability for crumbs.
- Heuristic `ls`/read-dance suppression — behavioral, unproven.

The real remaining lever is routing (cheap-by-default with strength on demand) — deferred per the user's sequencing (single-model correctness first).

## Known edges (documented, not chased this round)

- **Mid-turn rebuild can drop an in-flight tool's result** from the rebuilt render: a user-triggered rebuild (verbose/thinking toggle, `/reload`, tree nav) while a tool executes loses that result until the next rebuild. Narrow (auto-compaction runs between turns); fix deferred deliberately.
- `model-registry.test.ts` ×2, auto-compaction-queue, bash-persistence×5, queue, concurrent, runtime-cross-cwd test failures are pre-existing from the user's in-flight NVIDIA/auth work — untouched.
- opencode comparison is adapter-fairness-limited (its own defaults vs our autonomous mode); treat as direction, not laboratory truth.

## Run logs

- Baseline (pre-economy): `/tmp/ag1-eval-baseline-9b/comparison.md`
- opencode usage: `/tmp/ag1-eval-baseline-9b/opencode-usage.json`
- v4 run 1: `/tmp/ag1-eval-v4-run1` — 14/15, 34,522 tok/solved · v4 run 2: `/tmp/ag1-eval-v4-run2` — **15/15, 35,125 tok/solved**
- 550B confirmation run: `/tmp/ag1-eval-550b-v35` — **6/6, 42,583 tokens/solved** (see model-vs-harness split above).

## Variance (v4 suite, 9B, 2 runs, identical build)

| Metric | Run 1 | Run 2 | Read |
|---|---|---|---|
| Solved | 14/15 | 15/15 | pass rate is the noisy metric — `multi_file_feature` flipped fail→pass on pure model nondeterminism |
| Tokens/solved | 34,522 | 35,125 | aggregate is stable (~±1%) despite per-scenario swings of ±3–12k (up to ±50%) |
| Total tokens | 483,309 | 526,873 | driven by the flip + a few big per-scenario swings |

Rules this sets: never judge a change on one run or one scenario; aggregate tokens/solved is the stable metric; pass-rate deltas need ≥3 runs to mean anything.

- [x] Phase A1: 550B v4 suite → discovered model-flip bug instead (fixed); real 550B v4 run in flight
- [x] Phase A2: opencode v4 suite → first run destroyed by LM Studio slot collision; clean rerun in flight
- [ ] Phase A3: publish v4 comparison (pending both reruns)

## Next bets (priority order)

1. Variance: v4 suite repeats → mean±spread before claiming any deltas.
2. Cheap-model routing for bounded subtasks (compaction, summaries) — the user's late-stage lever; now gated on the 550B run showing model-vs-harness split.
3. Prompt-caching validation on an API model (cacheRead tokens).

## Task tool / subagents (shipped 2026-07-18)

The `task` tool per `docs/subagent-proposal.md` is shipped: 5 profiles (explore/research/implement/verify/plan), structural tool sets (read-only by construction, hard no-recursion), isolated `Agent` per task, result-only return `{state, summary, evidence[], usage}`, scheduler (local depth 1 / API depth 3), bounds (turns 12/25, 300s, 200k token budget, loop detection), safety policy inherited below the boundary, gate honesty (verify-task evidence counts only with a real recorded bash exit-0 reliable command), usage roll-up into the parent session (`ag1.subagent_task` entries — counted by the harness, so delegation never looks free). Kill switch: `AG1_DISABLE_TASK_TOOL=1`. Tests: 28 new (test/subagent.test.ts), suite green (10 known pre-existing failures only).

### Delegation eval (v4-delegation suite, 9B local, external verify)

| Scenario | Verify | Total tokens | Subagent tokens | Parent tokens | Subagent detail |
|---|---|---:|---:|---:|---|
| delegation_explore_answer | passed | 40,092 | 14,494 (explore, 7 turns) | ~25.6k | answer arrived fully formed; parent only wrote ANSWER.md |
| delegation_implement_verify | passed | 50,082 | 24,491 (implement 20,038 + verify 4,453) | ~25.6k | fix + npm test exit 0 happened below the boundary |

Read: the mechanism works end-to-end (2/2, evidence + usage honestly accounted). Total tokens are comparable to doing the work directly — the efficiency win is context isolation (parent stays ~25k regardless of how noisy the subtask gets), which compounds on long-horizon runs and protects the prefix cache. Parent overhead (~25k on small scenarios) says the per-turn base cost is still the dominant tax — the routing phase's real target.

### v4 A/B: cost of the task tool's PRESENCE (9B, never calls it)

The task tool is on by default, and the 9B never invoked it in any of the 15 standard scenarios — yet its presence in the prompt/schema changed run economics. Three runs, same suite/model/build line:

| Run | Tokens/solved | Solved | Note |
|---|---:|---:|---|
| v4 run 1 (pre-tool) | 34,522 | 14/15 | baseline |
| v4 run 2 (pre-tool) | 35,125 | 15/15 | baseline (aggregate stable ±1%) |
| task enabled, fat schema (~560 tok/turn) | 49,426 | 15/15 | +44% vs baseline |
| task DISABLED (AG1_DISABLE_TASK_TOOL=1) | 34,341 | 15/15 | back to baseline — causation confirmed |

Mechanism split: ~+5k/scenario schema tokens (fat description) + behavioral turn-count blowups on some scenarios (strict_precision 7→22 tools / 26.7k→111.4k; ambiguous_entrypoint 9→14; multi_file_feature 12→14; all normalized with the tool off; entrypoint_wireup high in both — natural variance). The 9B fumbles more with an extra unfamiliar tool in context, even unused.

Actions: description slimmed (~560→~420 tok/turn); slim-enabled A/B in flight. If behavioral cost persists, the tool needs capability-gating (small local models can't steer subagents anyway) — decision pending data.

### Verdict: capability-gated task surface

Slimming the description helped but did not fix it: enabled-slim (~420 tok/turn) = **42,125 tok/solved (14/15)** vs disabled = 34,341 (15/15) vs enabled-fat = 49,426 (15/15). The behavioral tax persists at any description size — small models fumble with an unfamiliar delegation tool in context, and the cost scales with prompt prominence. Blowups moved around between runs (strict_precision 111k→36k; multi_file_feature 74k→29k) but the aggregate held ~+23%.

**Decision (data-forced, reverses the earlier "on by default for everything" intent):** the task tool is capability-gated via the existing `inferModelCapabilityProfile` — models with `toolCallReliability: "low"` (small local models, ≤32k context) get a focused tool surface WITHOUT `task`. Capable models (mid-local, frontier API, the 550B) get it by default. Overrides: `AG1_TASK_TOOL=1` forces on, `=0` forces off (`AG1_DISABLE_TASK_TOOL=1` still honored). This matches the architecture's existing pattern (per-model compaction policy, compact prompt profile) and the user's own model-strength model: small models can't steer subagents; the harness must not make them worse. The 9B benchmark default now runs at baseline cost; delegation ships for the models that benefit.

Gate tests: 4 new (test/subagent.test.ts, 32 total) — gated out for qwen3.5-9b, in for capable models, env override both directions.

### Confirmatory runs (gate shipped)

| Run | Tokens/solved | Solved |
|---|---:|---:|
| v4 default (9B, capability gate active) | 34,168 | 15/15 — baseline restored, tool absent from the 9B's prompt (verified in session dumps) |
| v4-delegation with AG1_TASK_TOOL=1 | 67,948 (instructed delegation on tiny fixtures; mechanism proof, not an efficiency claim) | 2/2 — forced-on path works end-to-end |

Final state: the 9B benchmark default is untouched (34.2k vs 34.3–35.1k baseline); the task tool ships on by default for capable models; delegation remains one env var away for small models.
