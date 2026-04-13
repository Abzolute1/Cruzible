# AG1 — Build from Scratch Brief

## Context: Why This File Exists

This project has been through **3 days of failed back-and-forth** with multiple AI models trying to build an autonomous coding agent. Every attempt hit the same wall: `main.ts` imports 6 modules that don't exist, each stub revealed more missing pieces, and the scope kept ballooning. **This prompt prevents the next model from making the same mistakes.**

Read this entire document before touching any code. Every section matters.

---

## The Goal

Build **AG1**: a fork of Pi (the coding agent at `@mariozechner/pi-coding-agent` on npm) that adds an **autonomous mode**.

### What Autonomous Mode Actually Means

**Interactive mode** (Pi already has this):
```
User: "fix the bug"
Agent: reads file, edits, runs tests → WAITS for next user input
User: "also add logging"
Agent: adds logging → WAITS
```

**Autonomous mode** (what we're building):
```
User: "fix the bug"
Agent: reads file, edits, runs tests → CONTINUES → fixes remaining issues → verifies → DONE
Agent: "Done. Here's what I did..."
```

The difference is ONE thing: **instead of waiting for the user after each turn, the agent automatically continues until the task is done.**

### Mode Switching

Pi supports **Shift+Tab** to cycle through modes. The user should be able to:

```
[interactive] → Shift+Tab → [autonomous] → Shift+Tab → [print] → Shift+Tab → [rpc]
```

In autonomous mode, the user still types a prompt. The agent just doesn't stop after the first turn — it keeps going.

This means you don't need a completely separate `runAutoMode()` entry point that bypasses the TUI. **Autonomous mode is a flag on the existing prompt handler** that changes "wait for user" into "continue automatically."

### Why This Matters

The previous attempts failed because they tried to build a completely separate autonomous entry point (`runAutoMode()` with `AutonomousCoordinator`) that replaced the entire interactive flow. That required importing 7 modules that don't exist. 

The correct approach is simpler: **add a flag to the existing prompt handler**. When the flag is set, wrap the turn in a loop. When it's not, do the normal single-turn behavior.

---

## What Pi Already Gives You

Pi (`@mariozechner/pi-coding-agent`) is a production-ready coding agent with:

- **8 built-in tools**: Read, Write, Edit, Bash, Grep, Find, Ls, NotebookEdit
- **Full session management**: branching, forking, resuming, tree navigation
- **Model resolution**: 22+ providers (OpenAI, Anthropic, Google, Bedrock, Azure, OpenRouter, LM Studio, etc.)
- **Auth**: API keys + OAuth (Anthropic, Google, GitHub Copilot, Azure)
- **TUI**: Full terminal UI with themes, streaming, autocomplete, markdown rendering
- **Compaction**: Automatic context management when context gets large
- **Retry logic**: Exponential backoff on transient failures
- **Extension system**: Formal API for adding tools, commands, flags, UI widgets
- **Mode switching**: Shift+Tab to cycle through interactive/print/rpc modes

**You don't need to rebuild any of this.** Pi works. The installed `ag1` binary (symlinked to `@mariozechner/pi-coding-agent`) proves it.

---

## What's Broken Right Now

`/home/alex/AG1/packages/coding-agent/src/main.ts` has **6 broken imports** out of 9 local imports:

| # | Import (line in main.ts) | Problem |
|---|--------------------------|---------|
| 1 | `./tools/kairos-tool-registry.js` (23) | **Directory doesn't exist.** Was supposed to register "Kairos specialty tools" — 10 custom tools ported from a separate project called Kairos. **We are NOT using these.** We use Pi's built-in tools only. |
| 2 | `./providers/aikit-provider.js` (25) | **File doesn't exist.** Was supposed to load Qwen models via aikit.club proxy. **Delete.** Pi has built-in Qwen support. |
| 3 | `./providers/lmstudio.js` (27) | **File doesn't exist.** Was supposed to auto-detect LM Studio on port 1234. **Keep this functionality** — it's useful for local models, but rewrite it inline in main.ts. |
| 4 | `./core/behavioral-prompt.js` (28) | **Wrong path.** File exists at `./core/auton/behavioral-prompt.ts`. **Fix the path.** |
| 5 | `./utils/spinner.js` (30) | **File doesn't exist.** Spinner utilities for CLI progress display. **Delete.** Not needed. |
| 6 | `./agent/coordinator.js` (244) | **Directory doesn't exist.** Was supposed to be `AutonomousCoordinator` for the `--auto` mode. **This is what you need to replace** — with a simple loop, not a complex coordinator. |

Additionally:
- **Line 55**: `const nvidiaKey = "nvapi-1eDd..."` — a **hardcoded real API key** was in main.ts. Remove it. Use `process.env.NVIDIA_API_KEY`.
- **Line ~368**: `(modelRegistry as any).models = ...filter(...)` — mutates private field. Remove this; it's redundant since models.json on disk already has the right providers.
- **Line ~387**: `codingTools as any` and `getKairosSpecialtyTools() as any` — type-unsafe casts. Remove the Kairos reference entirely.

---

## The Auton Modules (KEEP THESE)

These files exist at `/home/alex/AG1/packages/coding-agent/src/core/auton/` and are **good code**. Don't rewrite them. You'll use them:

| File | Purpose |
|------|---------|
| `auton-hook.ts` | Cost tracking, budget enforcement, turn counting. Has `attachAutonHook()` and `AutonHook` class. **Keep.** |
| `behavioral-prompt.ts` | System prompt that tells the LLM "you're autonomous, don't ask for confirmation." **Keep.** |
| `compaction-policy.ts` | 3-tier compaction thresholds (cloud/moderate/local models). **Keep.** |
| `cost-tracker.ts` | Token→USD conversion with per-model pricing. **Keep.** |
| `nudges/nudge-eval.ts` | 9 behavioral heuristics with cooldown/escalation. **Keep but only 2-3 will actually fire in practice.** |
| `nudges/output-trend.ts` | Detects diminishing output across turns. **Keep.** |
| `nudges/types.ts` | Nudge type definitions. **Keep.** |
| `tools/*.ts` (10 files) | Custom tools (Verify, LSP, WebFetch, etc.). **Don't use them for MVP.** They're there if you want to add them later, but Pi's 7 built-in tools (Read, Write, Edit, Bash, Grep, Find, Ls) are sufficient for autonomous operation. |

**The barrel export at `core/auton/index.ts` exports all of these. It works.**

---

## Session Debug Logger (KEEP AS-IS)

`/home/alex/AG1/packages/coding-agent/src/core/session-debug-logger.ts` — **1,299 lines, fully working, already wired in.**

This is a non-blocking debug logger that records every agent session to disk. On each session it writes 3 files:

| File | Purpose |
|------|---------|
| `Debug/{date}_{model}/session.md` | Full turn-by-turn log with tool calls, results, token stats, compaction events |
| `Debug/{date}_{model}/session.compact.md` | One-line-per-turn summary table for quick scanning |
| `Debug/{date}_{model}/timeline.json` | Machine-parseable JSON array of all events with timestamps |

**It's already wired into:**
- `interactive-mode.ts` (line 564) — instantiated after session creation, disposed on stop
- `autonomous-mode.ts` (line 86) — same pattern

**What you must do:** When you integrate autonomous mode, instantiate the logger the same way:
```typescript
const debugLogger = new SessionDebugLogger({ session, projectRoot });
// ... run the loop ...
debugLogger.dispose();
```

**What you must NOT do:** Do NOT rewrite it. Do NOT "improve" it. Do NOT change the debug output format. It's 1,299 lines of tested code that works. The full spec is at `/home/alex/forked_auton_merge/debug_prompt.md` if you need to understand the design decisions.

**Why it matters:** After each autonomous run, the user reads `session.md` to understand how the loop performed. Without it, debugging autonomous failures is guesswork.

---

## What You MUST NOT Do

These are the mistakes from the previous sessions. **Do NOT repeat them:**

1. **Do NOT try to write a kairos-tool-registry.js** — We're using Pi's built-in tools. No custom tools for MVP.
2. **Do NOT write 7 missing modules to satisfy main.ts imports** — Delete the imports, don't stub the files. Each stub reveals another missing piece. It's a rabbit hole.
3. **Do NOT build a complex AutonomousCoordinator with plan extraction** — Kairos's `orchestrator.ts` tried to extract plan steps from LLM responses and verify them. It almost never works well. The LLM generates a wrong plan by step 2.
4. **Do NOT add per-model pricing, child agent spawning, task management, or todo tools** — These are scope additions. The autonomous loop is the core.
5. **Do NOT modify Pi's packages (agent/, ai/, tui/)** — Pi works. Your changes are in `coding-agent/src/` only.
6. **Do NOT use `as any` casts** — They hide real type errors. If something doesn't type-check, fix the root cause.
7. **Do NOT rewrite the SessionDebugLogger** — It's 1,299 lines of working code at `core/session-debug-logger.ts`. Just instantiate it in your autonomous mode integration.
8. **Do NOT build a separate entry point that replaces the TUI** — Autonomous mode should be a flag on the existing prompt handler. The user types a prompt, the agent loops until done, then returns to the prompt. No separate `runAutoMode()` that bypasses everything.

---

## What You MUST Build

### Step 1: Clean up main.ts

Remove all broken imports. Remove the hardcoded API key. Remove the kairos tool registry references. Remove the spinner import. Fix the behavioral-prompt path. Remove the `(modelRegistry as any)` mutation. Get main.ts to compile with zero type errors.

What remains after cleanup:
- Provider registration (NVIDIA via env var, LM Studio via probe, DashScope via env var)
- Model resolution (simplified — use `modelRegistry.getAvailable()`)
- Session creation (use Pi's `createAgentSessionRuntime`)
- Mode dispatch (interactive, print, rpc — autonomous will be added here)

### Step 2: Add Autonomous Mode to the Prompt Handler

**This is the core deliverable.** Not a separate entry point — a mode flag that changes behavior.

The approach: in the interactive mode's prompt handler (where the user types a message and the session processes it), add a check:

```typescript
// Pseudocode — read the actual interactive-mode.ts to understand the structure
if (autonomousMode) {
  // Autonomous: loop until done
  const debugLogger = new SessionDebugLogger({ session, projectRoot });
  attachAutonHook(runtime, modelId, { maxCostUsd, maxTokens, maxTurns, verbose: true });
  
  // Append behavioral prompt to system prompt
  session.agent.state.systemPrompt += AUTON_BEHAVIORAL_PROMPT;
  
  // Send initial user message
  await session.prompt(userMessage);
  
  let iterations = 0;
  const maxIterations = 200;
  
  while (iterations < maxIterations) {
    // Check budget
    const budget = autonHook.getBudgetStatus();
    if (budget.exceeded.cost || budget.exceeded.tokens || budget.exceeded.turns) {
      break;
    }
    
    // Check nudge
    const nudgeCtx = buildNudgeContext(session, trendTracker);
    const nudge = evaluateNudgeWithCooldown(nudgeCtx, cooldownState);
    if (nudge.shouldStop) break;
    
    // Check completion: did the last turn have no tool calls and a "stop" finish?
    if (looksComplete(session)) break;
    
    // Continue the loop — session.prompt() blocks until the turn completes
    await session.prompt("Continue working. The last turn completed. Proceed to the next step.");
    iterations++;
  }
  
  debugLogger.dispose();
  autonHook.dispose();
  
  // Print summary
  console.log(`Autonomous run complete: ${iterations} iterations`);
  console.log(autonHook.getCostSummary());
  
  // Return to interactive mode — user can type next prompt
} else {
  // Normal interactive: single turn, wait for user
  await session.prompt(userMessage);
}
```

**The critical insight:** `session.prompt()` blocks until the full turn completes — including tool execution, compaction, and retries. You don't need to manage tool execution yourself. You just decide: do we call `session.prompt()` again, or return to the user?

**Key components you'll wire in:**
- `attachAutonHook()` from `core/auton/index.js` — cost tracking, budget enforcement
- `AUTON_BEHAVIORAL_PROMPT` from `core/auton/behavioral-prompt.js` — tells the LLM it's autonomous
- `evaluateNudgeWithCooldown()` from `core/auton/nudges/nudge-eval.js` — stuck detection
- `OutputTrendTracker` from `core/auton/nudges/output-trend.js` — diminishing output detection
- `SessionDebugLogger` from `core/session-debug-logger.js` — session transcript logging

**What the autonomous loop needs to track:**
- Turn counter (for iteration cap)
- Budget status (from `AutonHook`)
- Nudge cooldown state (for stuck detection)
- Output trend (for diminishing output detection)
- Whether the last turn made tool calls (if no tools + "stop" finish → looks complete)

### Step 3: Add Mode Switching

Pi uses Shift+Tab to cycle modes. Add "autonomous" to the cycle:

```
interactive → autonomous → print → rpc → (back to interactive)
```

The mode determines whether the prompt handler loops or returns after a single turn. Look at how Pi implements mode cycling in `interactive-mode.ts` — follow the same pattern.

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                          main.ts                                 │
│  parseArgs → register providers → resolve model → session        │
│  → interactive mode (Shift+Tab cycles to autonomous/print/rpc)  │
├──────────────────────┬──────────────────┬────────────────────────┤
│  Pi's infrastructure │  Auton modules   │  What you write        │
│  (DON'T TOUCH)       │  (KEEP AS-IS)    │  (NEW)                 │
│                      │                  │                        │
│  - Session mgmt      │  - auton-hook    │  - Mode flag in        │
│  - 8 built-in tools  │  - nudges        │    prompt handler      │
│  - Model resolution  │  - cost-tracker  │  - Autonomous loop     │
│  - TUI + mode cycle  │  - compaction    │    (while loop around  │
│  - Compaction        │    -policy       │     session.prompt())  │
│  - Retry logic       │  - behavioral    │  - LM Studio probe     │
│  - Extensions        │    -prompt       │    (inline in main.ts) │
│  - Debug logger      │  - debug logger  │  - Completion detection│
│                      │    (1,299 lines) │  - Budget/nudge checks │
│                      │                  │  - Summary on exit     │
└──────────────────────┴──────────────────┴────────────────────────┘
```

### How It Flows

```
User types: "fix the bug"
  │
  ├─ Interactive mode: session.prompt("fix the bug") → turn runs → return to prompt
  │
  └─ Autonomous mode: session.prompt("fix the bug")
                        │
                        ▼
                    while (!done) {
                      await session.prompt(continueMsg)
                      done = checkBudget() || checkNudge() || looksComplete()
                    }
                        │
                        ▼
                    print summary → return to prompt
```

---

## Code Commenting Requirements

**Every file you write or significantly modify must have rich, explanatory comments.** Future models will need to understand what's going on. Do NOT write terse "increment counter" comments. Write comments that explain WHY, not just WHAT.

### Good comment example:
```typescript
// Autonomous loop: we call session.prompt() repeatedly instead of waiting 
// for user input. session.prompt() blocks until the full turn completes 
// (tool execution, compaction, retries all handled internally). After each 
// turn we check three independent exit conditions: budget (hard stop), 
// nudge engine (stuck detection), and completion (no tool calls + LLM said stop).
// The 200-iteration cap is an emergency brake — the loop should exit via 
// one of the three conditions first.
```

### Bad comment example:
```typescript
// Call prompt
await session.prompt(msg);
// Check budget
if (budget.exceeded) break;
```

**Specifically:**
- Comment the top of every new function with: what it does, why it exists, what calls it, what the exit conditions are
- Comment the autonomous loop's structure — the fact that `session.prompt()` blocks is the key design decision
- Comment every exit condition — what triggers it and why it's there
- Comment the mode switching — how Shift+Tab connects to the autonomous flag
- Comment the debug logger wiring — future models need to know it's intentionally there, not accidental

---

## Reference: How Kairos Did It

There is a reference implementation at `/home/alex/Kairos/src/agent/loop.ts` (969 lines). It's a well-designed `while(true)` loop with:
- Concurrent tool execution (parallel reads, serial writes)
- Thinking timeout (90s without output → abort)
- Complexity escalation on errors
- Compaction check after each turn
- Nudge evaluation after tool execution

**Do NOT copy this code.** It's coupled to Kairos's own provider, history, and TUI. Use it as a design reference only. The structure (exit checks → process turn → compaction → nudge → loop or exit) is the right pattern.

---

## File Locations

| Path | Description |
|------|-------------|
| `/home/alex/AG1/` | The Pi fork codebase |
| `/home/alex/AG1/packages/coding-agent/src/main.ts` | Entry point — needs cleanup |
| `/home/alex/AG1/packages/coding-agent/src/cli.ts` | CLI bootstrap — don't touch |
| `/home/alex/AG1/packages/coding-agent/src/core/auton/` | Auton modules — keep as-is |
| `/home/alex/AG1/packages/coding-agent/src/core/session-debug-logger.ts` | Debug logger — 1,299 lines, keep as-is |
| `/home/alex/AG1/packages/coding-agent/src/modes/interactive/interactive-mode.ts` | The file where you'll add the autonomous flag + loop |
| `/home/alex/AG1/packages/coding-agent/src/core/agent-session.ts` | Pi's session management — don't touch |
| `/home/alex/AG1/packages/coding-agent/src/core/extensions/types.ts` | Extension API types — don't touch |
| `/home/alex/Kairos/` | Reference implementation (separate project) |
| `/home/alex/Kairos/src/agent/loop.ts` | Reference autonomous loop — design reference only |
| `/home/alex/Kairos/src/agent/nudges.ts` | Reference nudge engine — already ported to auton/ |

---

## Success Criteria

1. `main.ts` compiles with **zero type errors**
2. `interactive-mode.ts` has an autonomous mode flag that works
3. Shift+Tab cycles: interactive → autonomous → print → rpc
4. In autonomous mode, the agent loops until done after the user's prompt
5. Budget tracking works (set `--max-cost 0.50` and it stops at $0.50)
6. Nudge engine fires (if the agent gets stuck, it stops)
7. The agent can use Pi's Read, Write, Edit, Bash tools to accomplish tasks
8. Debug logger produces `Debug/{date}_{model}/session.md` after each run
9. All new/modified code has rich, explanatory comments
10. No `as any` casts in your new code
11. No hardcoded secrets
12. No references to missing modules

---

## What "Done" Looks Like

A user runs:
```
ag1
```

The TUI starts. The user types a prompt:
```
> Add input validation to the login form in src/login.ts
```

If in **interactive mode** (default):
1. Agent reads the file
2. Edits it
3. Runs tests via Bash
4. Stops and waits for next user input

If in **autonomous mode** (Shift+Tab):
1. Agent reads the file
2. Edits it
3. Runs tests via Bash
4. Fixes errors if any
5. Continues until done or budget/nudge says stop
6. Prints a summary
7. A debug folder is produced at `Debug/{date}_{model}/` with `session.md`, `session.compact.md`, and `timeline.json`
8. Returns to the prompt — user can type next task

That's the whole product.