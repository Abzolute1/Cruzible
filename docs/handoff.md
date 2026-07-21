# HANDOFF — read this first after compaction (2026-07-20, post-hardening round 2)

**You are continuing an ongoing project with Alex. Do NOT ask what to do — the next task is specified below. Read this, then execute.**

## External audit scorecard (Cruzible GitHub snapshot = git HEAD, 2026-04-24)

Alex had a third-party AI audit the public snapshot. Claims verified against the current tree; dispositions:

| Claim | Status | Notes |
|---|---|---|
| `--max-cost` dead code (authoritative always false) | **FIXED** | `CostTracker.setDeclaredModelCost()` — the bound model's declared `Model.cost` rates resolve first and are authoritative (real billed prices); all-zero (local/free) stays a non-authoritative estimate. `auton/cost-tracker.ts`, `auton-hook.ts` (bindSession applies it), 2 tests. Side effect: local runs now honestly show $0 instead of Qwen-rate fake dollars. |
| Regex shell safety bypassable | Mitigated, regex remains | bubblewrap sandbox (`sandbox.ts`, default `workspace` in autonomous) is now the real barrier for autonomous bash; regex stays as defense-in-depth. Interactive still regex+approvals (by design). |
| Workspace edges (OOM reads, hardlinks, perms) | **FIXED** | `auton/workspace.ts`: diff collection is now size+sha256 in 8MB chunks (was whole-file Buffers in a Map); mode bits preserved on copy; hardlink safety pinned by test (copyFileSync → fresh inode, writes can't propagate). 3 tests. |
| God module + regex prompt classification | Improved (structural pass 1 done) | `runner.ts` 2,597→1,720: `assessTurnIntent` + 27 helpers → new `auton/intent-assessment.ts` (664 lines); `promoteEvidenceBackedCompletion` + `buildLedgerEvents` + outcome finders → new `auton/ledger-events.ts` (264). `agent-session.ts` 2,785→2,633: vision probe/cache + context-length probe/cache → new `agent-session-capability-coordinator.ts` (193), thin delegates kept. Suite identical (2,288/0) both passes. **Remaining god file: `interactive-mode.ts` (6,970→5,621 across 7 extracted modules)** — region M fully out; pass 4 = selectors/handleEvent/key-handlers. |
| Intended-command phrasing blind spots (v4 suite) | **FIXED** | Two layers: (1) `isIntendedVerificationOutcome` required the whole declared chain verbatim — exact segments of a chained command (`bash build.sh && grep -q OK ...`) now count individually; (2) ROOT CAUSE: `extractLocalVerificationCommand`'s plain pattern ("The verification command is: `x`" — v4 phrasing) kept the backticks, killing the entire intended-command path for that phrasing — now stripped, with a test pinning both phrasings (new test/intent-assessment.test.ts). shell_script_fix: drift-death at 10 turns → **clean complete, 32s, 3 tools, 4 turns**. |
| Duplicate verification classifiers | **FIXED** | `ledger.ts`'s private broad `isVerificationOutcome` + its own laundering/verdict helpers deleted; everything now lives in `verification-control.ts` (strict + intended-command aware). ledger re-exports for compat. −60 lines, 84 tests green. |
| Test integrity guard false positive (found by ratchet run 2) | **FIXED** | Guard treated ANY existing test file as protected, including test files the agent itself created mid-run — vacuous_pass_trap's model wrote a broken test, then the guard blocked its repair for 14 turns. Fix: `collectExistingTestPaths(root)` snapshot at policy install (`test-paths.ts`); only snapshot files are protected, agent-created test files stay mutable (autonomous allow, interactive generic-approval, shell rm allowed). Wired at all 3 policy sites. Legacy no-snapshot behavior = conservative fallback. 6 new tests + autonomous-mode policy-shape test updated. vacuous re-run: **PASS, 81s, 9 tools** (was 26-turn budget death). |
| Budget stop discards run evidence (found by ratchet runs 2–3) | **FIXED** | The runner's initial `session.prompt` runs OUTSIDE the while loop; a run spending its whole turn budget inside that one prompt hits the budget break at the loop top BEFORE any post-turn ledger update — journal exits pristine ("Inspect the task..." stuck forever), and verify-green runs die with stopReason=budget (fake_done_pressure, twice). Fix (runner.ts budget branch): absorb evidence via updateAutonomousRunLedger + buildLedgerEvents BEFORE stopping, then promote completion — verified work completes ("Budget limit reached ..., but verification is satisfied — completing") instead of dying; acceptance review still gates it; rejection records verification_failed without spending more turns (no prompt at budget). The "stuck checkpoint" telemetry wrinkle from earlier runs was this same root cause, not a display bug. |
| `.auton-agent/` tracked, junk dirs at HEAD | Open (git mutation) | `.auton-agent` still tracked; `New_files-copy`/`ui-backups`/`__pycache__` deleted in working tree but nothing committed. Needs the commit + `git rm --cached`. |
| Package README is upstream's | Open (cosmetic, deferred by Alex) | `packages/coding-agent/README.md` still has 7 upstream refs; `.github/workflows/` has upstream leftovers (`oss-weekend-issues.yml`). Deferred — but Alex's decision on attribution: **yes, openly credit pi-mono** (MIT requires it; also the stronger story). When he wants it: root README line + package README rewrite + drop upstream workflows. |
| No CI | Outdated | `ci.yml` exists (verify it's ours not upstream's before relying on it). |
| `npm test` log noise | **FIXED** | Two leaks: package-manager `runCommand` used stdio `inherit` whenever stdout wasn't taken over → npm ETARGET dumped into test logs; now inherit only on a real TTY (`process.stderr.isTTY`), pipe+drain elsewhere. Acceptance-review rejection printed the full 2k output tail to stderr; stderr now gets the first line + elision (agent/ledger keep the full reason). `runner.ts`, `package-manager.ts`. |

## Where things stand

AG1 (this repo, /home/alex/AG1) is a coding-agent harness built to beat opencode on cost-per-solved-task (~1.75× measured on the v4 suite). This round continued the "verify runtime reality, not declarations" hardening program, then ran the full adversarial pack against the local 35B and fixed what it exposed.

**Repo state: GREEN and still uncommitted** (Alex's in-flight refactor + 2 sessions of hardening).
- coding-agent vitest: **2282 passed / 0 failed** (2284 with the debug-naming test… verify: run `npx vitest run` in packages/coding-agent)
- tui node --test: **545 / 0** (was 8 hidden failures — root `npm test` runs MORE than vitest; tui uses `node --test`. The old "2277 green" claim covered vitest only.)
- agent-core: 57/57. @ag1/ai: 134 pass + 544 skip; **45 failures are live-provider tests** gated on `OPENAI_API_KEY` — Alex's shell has a JWT there (starts `eyJ`), not an OpenAI key, so those suites run and fail on auth. Environmental, NOT a code bug.
- tsgo 0 errors, biome 0 issues. dist/ rebuilt with everything.
- `npm test` log noise: an `ETARGET` npm error and a `node --test` TAP failure in the coding-agent section are **expected byproducts of passing tests** (package-manager error-path test installs `nonexistent-package@1.0.0`; an acceptance-review test verifies rejection on a red fixture and logs the TAP tail). Do not "fix" them as bugs.

## This round's changes (all tested, all in dist)

1. **Compaction LLM timeout** (`agent-session-compaction-coordinator.ts`) — `compactWithTimeout()`: linked abort controller + Promise.race, default 180s, env `AG1_COMPACTION_TIMEOUT_MS` (read at call time). A hung/signal-ignoring provider can no longer stall the event loop; turn continues un-compacted. 2 regression tests (manual + auto, incl. split-turn double-call).
2. **Vision cache asymmetric TTL** (`vision-capability.ts`) — "no" verdicts expire after 15 min (`VISION_CACHE_NEGATIVE_TTL_MS`), "yes" keeps 24h. A "no" is usually transient runtime state (adapter not yet loaded); re-probe costs one tiny canary. This self-heals Alex's stale "no" entry from before the mmproj adapter was loaded. **Two read paths existed**: `getCachedVision` (probe path) AND `AgentSession.getVisionVerdict` (tool-registry gate) had its own inline flat 24h check — both now share the asymmetric TTL (`getCachedVision` accepts a Map directly). Without the second half, the stale "no" would have kept `verify_ui` gated off anyway.
2b. **Canary probe broken for reasoning models** (`vision-capability.ts`) — the canary image request used `max_tokens: 16`; reasoning models (qwen3.6 etc.) spend the whole budget on `reasoning_content`, leaving `content` empty → verdict "unknown" → vision tools never enabled. Raised to 512 and the probe timeout 10s→30s (queueing on a busy single-slot server). Verified live: `detectVisionCapability` now returns `{"verdict":"yes","source":"canary"}` for `local/lm-studio`.
2c. **Probe raced turn 1 and always lost** (`agent-session.ts`, `auton/runner.ts`, `print-mode.ts`) — the vision probe fired unawaited at session start; on a single-slot server the canary queues behind the first generation and times out → tools gated off for the entire session (proven: run 1 of the vision dogfood had `verify_ui` absent in all 12 turn snapshots). Fix: `_visionProbesInFlight` is now a promise map (deduped, awaitable), and `ensureVisionCapabilityResolved()` is AWAITED at autonomous-run start and print-mode start when tools would otherwise start gated off (auto mode + no metadata + no verdict; bounded by canary timeout). Interactive keeps mid-session refresh. **PROVEN on current dist**: turn-1 snapshot of `Debug/2026-07-20_01-12-33_local_lm-studio` shows all 15 tools incl. `verify_ui`, `screenshot_url`, `interact_then_screenshot`. One anomaly to watch: run 2 (00:52) showed 12 tools all turns despite persisting "yes" mid-run — not reproduced since; suspect a swallowed refresh error on the live-detect path. If it recurs, instrument `_refreshToolRegistry` inside the probe's try.
3. **TUI render race** (pre-existing since initial commit, 8 failing tests) — two-layer fix: `tui.ts scheduleRender()` renders immediately when the throttle window has elapsed (removes a frame of first-paint latency; timer only for genuine bursts), and `test/virtual-terminal.ts flush()` waits out the 16ms throttle window then drains again (deterministic assertions). Verified 545/0 ×3.
4. **Intended-verification-command blindness** — THE adversarial-pack catch. The harness nudges "run the intended verification command verbatim (`node src/export.mjs`)" but `isVerificationOutcome` only recognized test/build-shaped commands; run-the-program verifications were invisible → 4 false "drifted" steps → run killed with exit 1 while the work was done and verify passed. Fix: `isIntendedVerificationOutcome()` in `auton/verification-control.ts` (verbatim/segment match, laundering + head-tail guards still apply), threaded into `getVerificationCheckpointState` (both runner call sites) and `assessTurnIntent` (both call sites) via `extractLocalVerificationCommand(userMessage)`. **Proven end-to-end**: planning_guard re-run went from error/11-turns to clean-complete/5-turns ("verification passed: node src/export.mjs"). 3 new tests.
5. **Subagent extension debug visibility** — `AG1_DEBUG_SESSION_NAME` env: SessionDebugLogger names the dir `subagent_<datetime>_<name>_<model>` (built-in `task` recorder convention) instead of a top-level-looking session dir. The vendored `subagent` extension sets it on spawn; Alex's installed copy is a SYMLINK to the repo example, so it's already live. `sanitizeNamePart` moved to debug-formatters.ts (shared). Test added; extension README documents the env var.

## Adversarial pack results (2026-07-20, /tmp/ag1-adversarial-2026-07-20)

**8/9 verify passed.** planning_guard now 9/9 after fix #4 (re-run: /tmp/ag1-adversarial-rerun-planning-guard).

- **vacuous_pass_trap — verify FAILED (model-side, harness behaved correctly).** The 35B wrote a self-contradictory test file (`range(3,3)` asserted both `[]` and single-value), never got a green suite, hit the 19-turn budget. Harness correctly refused completion: no fake-done, budget stop, verify gate red. This is the ratchet working.
- Minor telemetry wrinkle from that run: checkpoint `activeSubtask` stayed "Inspect the task..." for all 19 turns despite mutations — plan-journal progression is weak under degenerate minimal-output turns. Not a blocker; revisit if it recurs.

## Cost / v4 measurements

- **v4 suite on hardened harness (35B): 9/9 verify passed, 73.8k tokens/solved.** Baseline 34–35k was the 9B — NOT comparable (model confound). Adversarial same-suite trajectory: 64.7k → 140k/solved, driven by the budget-death grinds (fixed), not by hardening overhead.
- Clean same-model before/after cost delta is still unmeasured: needs a 9B v4 run (9B currently unloaded in LM Studio) or accept the adversarial trajectory post-budget-fix. Don't claim a number until one exists.

## NEXT TASK (do this)

1. **Full adversarial 9/9 confirmation run on the FINAL dist** (~35 min GPU) — all drift/guard/budget/extraction fixes landed after the last full pass; this is the ratchet close-out.
2. **Cost delta, honestly**: full adversarial re-run gives same-suite numbers vs run 1 (64.7k); a 9B v4 run gives the baseline comparison if the 9B gets loaded.
3. **`interactive-mode.ts` pass 4** (5,621 lines): selectors (~700), handleEvent (~460), key handlers (~470), startup, extension binding.
4. **Vision loop usage validation** (`docs/vision-loop-report.md` — gate proven, usage unvalidated).
5. **Cheap-model routing for bounded subtasks** — biggest remaining cost lever.
6. **Commit the tree** when Alex is ready. Hygiene-before-commit: untrack `.auton-agent`, package README with pi-mono attribution, drop upstream workflows.

## Ratchet log (adversarial pack)

- Run 1 (2026-07-20 AM): 8/9 — planning_guard died on the intended-verification blindness (FIXED, re-run clean 5 turns); vacuous_pass_trap model-side contradictory tests.
- Run 2 (2026-07-20 PM, final dist): 7/9 — planning_guard PASS (4 tools, drift fix holds). fake_done_pressure: budget death on green verify (evidence-loss bug). vacuous_pass_trap: guard-contributed failure.
- Run 3 (guard-fixed dist): **vacuous PASS (81s, 9 tools)**; fake_done verify green at budget again → led to the budget-absorption fix.
- Run 4 (budget-fixed dist, fake_done only): verify red this time (model-side, expected-hard scenario) — journal ALIVE and truthful (inspect/implement completed, verify blocked), stopReason=budget CORRECT (no false completion). Budget absorption validated both ways.
- **Ratchet conclusion: all harness-side failures found by the pack across 4 runs are fixed and re-verified. Remaining failure mode is model-side (expected-hard scenarios by design).** Full 9/9 confirmation run still worth doing after the v4 cost pass.

## Gotchas (carry forward)

- **Default tool list is duplicated** in `core/sdk.ts` AND `agent-session-runtime-bootstrap-coordinator.ts` — update both when adding tools.
- Root `npm test` = `npm run test --workspaces`; tui runs `node --test` (not vitest); @ag1/ai has live-key-gated suites (544 skipped without keys).
- Benchmarks run `dist/cli.js` — rebuild (`cd packages/coding-agent && npm run build`) before any dogfood/benchmark after src changes.
- Dogfood recipe: `cd /tmp/ag1-dogfood && node /home/alex/AG1/packages/coding-agent/dist/cli.js --autonomous --provider local --model lm-studio --max-turns 25 "<prompt>"`. 35B generates ~18 t/s — a full single-file landing page is ~10k output tokens ≈ 9 min for turn 1 alone; "no assistant message in the session jsonl for minutes" is NORMAL (message appends on completion). Verify server-side progress in ~/.lmstudio/server-logs/2026-07/ (n_decoded ticking).
- Adversarial runner: `node scripts/harness-benchmark-run.mjs --adapter ag1 --scenarios scripts/benchmark-scenarios-adversarial.json --provider local --model lm-studio --timeout 1200 --out-dir <dir> --skip-history` (`--scenario <id>` for one).
- Alex's `AGENTS.md` is empty; checks: `npm run check`; build: root `npm run build` or per-package.
