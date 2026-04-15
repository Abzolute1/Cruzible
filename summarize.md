# Overnight Progress Summary

## 2026-04-14

### Plan Mode Stabilization
- Clarifying replies now normalize into selector-friendly interview questions instead of brittle raw prose parsing.
- Example paths like `e.g. /home/...` no longer become selector options.
- Binary clarification prompts now synthesize `Yes` / `No` options.
- Clarifying state now shows interview progress instead of fake `0/0 complete`.
- Duplicate interview progress lines in the plan review surface were removed.

### Verification Completed
- Focused plan-mode suites passed after the parser/UI fixes.
- Typecheck passed for `packages/coding-agent`.
- Build passed for `packages/coding-agent`.
- Live PTY smoke test for:
  - `/plan`
  - `let's plan a snake game`
- Live behavior now reaches:
  - clarifying plan artifact
  - immediate interview dialog
  - selector-based language options
  - no exploratory tool churn first

### New Work In Progress
- Added a local unattended runner at `scripts/ag1-overnight.py`.
- Initial version proved a real gap:
  - `ag1 --auto` arms autonomous mode in the TUI
  - but it does not exit on its own after the autonomous slice
  - so it is not a reliable overnight primitive

### Current Fix In Progress
- Adding a true headless autonomous CLI mode so unattended runs can:
  - start cleanly
  - run without the TUI
  - exit with a real status code
  - resume across bounded runs via the supervisor

### Major Addition: Headless Autonomous CLI
- Added `--autonomous` to `ag1`.
- This is separate from `--auto`:
  - `--auto` still arms autonomous mode inside the TUI
  - `--autonomous` runs a headless autonomous session and exits
- This is the path the overnight supervisor now uses.

### Major Addition: Overnight Supervisor
- Added `scripts/ag1-overnight.py`.
- It creates a dedicated run directory with:
  - `manifest.json`
  - `state.json`
  - `events.jsonl`
  - `tui.log`
  - `tui.raw.log`
  - dedicated `agent/` state
- It supports:
  - `start`
  - `status`
  - `resume`
  - `stop`

### Active Overnight Run
- Run directory:
  - `/home/alex/.ag1-overnight/20260414-040835-better-than-opencode`
- Goal:
  - Make AG1 materially better than OpenCode.
- Current status when this note was written:
  - worker launched
  - run state is `running`
  - headless autonomous mode started

### Morning Check Commands
```bash
python3 /home/alex/AG1/scripts/ag1-overnight.py status \
  --run-dir /home/alex/.ag1-overnight/20260414-040835-better-than-opencode --tail 60

python3 /home/alex/AG1/scripts/ag1-overnight.py stop \
  --run-dir /home/alex/.ag1-overnight/20260414-040835-better-than-opencode
```

### NVIDIA Model Picker Restore
- Restored NVIDIA NIM model registration in the live picker path.
- Added the official Ultra route:
  - `nvidia/llama-3.1-nemotron-ultra-253b-v1`
- Kept the older Super route available:
  - `nvidia/nemotron-3-super-120b-a12b`
- Switched AG1's NVIDIA default model preference to the Ultra route.
- Added a user-scoped env file at `~/.config/ag1/env.sh` and sourced it from shell startup so new `ag1` launches can discover NVIDIA models automatically.

### NVIDIA Verification
- Focused tests passed:
  - `test/model-resolver.test.ts`
  - `test/main-cli-contract.test.ts`
- Typecheck passed.
- Build passed.
- Live verification from a fresh shell showed:
  - NVIDIA env present
  - `ag1 --list-models` includes both:
    - `nvidia/llama-3.1-nemotron-ultra-253b-v1`
    - `nvidia/nemotron-3-super-120b-a12b`
