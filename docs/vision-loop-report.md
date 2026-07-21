# Vision loop — state of play (2026-07-20, pick up here)

**One-liner: the vision loop has never been used yet, but the entire gate chain blocking it is now fixed and proven — what remains unvalidated is whether the model *chooses* to use `verify_ui` when it's offered.**

## The goal

`verify_ui`: claim → headless screenshot → LLM-judge verdict, so a frontend-building agent gets a visual feedback loop (build → verify → fix → re-verify at desktop + mobile viewports) without images entering the main context.

## Why it never activated — four stacked bugs, all FIXED (2026-07-20)

1. **Stale negative cache, 24h TTL.** A "no" verdict from before the mmproj/vision adapter was loaded in LM Studio stayed in force for a day. Fix: `VISION_CACHE_NEGATIVE_TTL_MS` = 15 min in `core/vision-capability.ts` ("no" is usually transient runtime state; "yes" keeps 24h).
2. **Second TTL check bypassed the fix.** `AgentSession.getVisionVerdict` (the tool-registry gate) had its own inline flat 24h check; both read paths now share `getCachedVision`'s asymmetric TTL (`agent-session.ts`).
3. **Canary probe broken on reasoning models.** The probe image request used `max_tokens: 16`; reasoning models (qwen3.6, etc.) spend it entirely on `reasoning_content`, leaving the answer empty → verdict "unknown" → tools never offered. Now 512 tokens, and probe timeout 10s→30s. Verified live: `{"verdict":"yes","source":"canary"}` for `local/lm-studio`.
4. **Probe raced turn 1 and always lost.** On a single-slot local server the fire-and-forget canary queued behind the first generation and timed out → gated off for the whole session. Fix: `ensureVisionCapabilityResolved()` awaited at autonomous-run start and print-mode start (only when tools would otherwise start gated off; bounded by canary timeout). `agent-session.ts`, `auton/runner.ts`, `print-mode.ts`.

**Proof:** `Debug/2026-07-20_01-12-33_local_lm-studio/timeline.json` turn-1 snapshot shows all 15 active tools including `verify_ui`, `screenshot_url`, `interact_then_screenshot`.

## What's NOT yet validated (the actual next step)

Two dogfood runs (compact landing-page prompt, `/tmp/ag1-vision-dogfood2/prompt.md`) both show: the 35B builds the page, then verifies **manually** — headless Chrome screenshots via bash + `read` on the PNGs (which puts images in main context anyway) — instead of calling `verify_ui`. It never complained the tool was missing in run 2; it just routed around it.

Next run: same prompt, watch the timeline. If the model still doesn't call `verify_ui`, the fix is in the **tool's description/prompt snippet** (and possibly the autonomous visual-lane nudges), not the gate. Levers: make the description concrete ("call this to check your UI work; returns PASS/FAIL per claim"), and check `shouldUseVisualVerification` / visual-lane prompt hints actually fire for a landing-page task.

## Anomaly on file (not reproduced)

Run 2 (00:52) persisted verdict "yes" at 00:51:47 yet all 10 turn snapshots showed 12 tools (no verify_ui). Not reproducible since — SDK repro and the 01:12 run both show the gate opening correctly on the same dist. Suspect a swallowed refresh error on the live-detect path. If it recurs, instrument `_refreshToolRegistry` inside the probe's try block in `_resolveVisionCapability`.

## Environment notes

- LM Studio now has the vision adapter loaded: the 35B answers canary images correctly ("Red"/"teal"), `type: "vlm"` in `/api/v0/models`.
- Vision cache: `~/.ag1/agent/vision-cache.json` (per provider|baseUrl|model key). Localhost vs 127.0.0.1 spellings create separate entries — harmless, TTL handles both.
- The 35B's own vision via `read`-on-PNG works in-context — that's what it used to route around `verify_ui`.
- Dogfood recipe: `cd /tmp/ag1-vision-dogfood2 && node /home/alex/AG1/packages/coding-agent/dist/cli.js --autonomous --provider local --model lm-studio --max-turns 12 "$(cat prompt.md)"` (rebuild dist first after any src change).
