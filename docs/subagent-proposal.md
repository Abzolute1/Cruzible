# Subagent proposal — the `task` tool for AG1 (2026-07-18)

**Mission fit:** subagents are the token-efficiency weapon, not a feature checkbox. The parent never pays for a subagent's exploration transcript — it pays only for the final answer. That's how a 40k-token multi-file exploration costs the parent ~2k.

**Constraints that shape the design:** LM Studio is single-slot (local models serialize — parallel local subagents just thrash the GPU), NVIDIA 550B is rationed (200/day), verification gate + safety policy exist and must apply below the subagent boundary, and `packages/agent` (`Agent`, `agentLoop`) is already reusable.

## Research summary (what the best harnesses do)

- **Reasonix** (`internal/agent/task.go`): read-only vs writer variants with different system prompts and *structurally* different tool sets (read-only subagents never see writer tools); depth cap; meta/job tools hidden; foreground-only bash inside subagents; subagent events forwarded nested under the parent call; **only the final assistant message returns to the parent**; per-subagent model/effort override via a provider resolver.
- **opencode** (`tool/task.ts`): typed `subagent_type` profiles, foreground default + `background` async with auto-notification, `task_id` resume, and explicit anti-polling instructions ("DO NOT sleep, poll, or duplicate this task's work").
- **Claude Code Task**: profile-based subagents with isolated context windows; parent receives only the result.
- **Kimi CLI AgentSwarm (my own runtime)**: template + items, full isolation, resume-by-id, result-only return.

Consensus across all four: isolated context, result-only return, typed profiles, hard bounds, and the parent's UI nesting the subagent's live progress.

## Proposal: `task` tool, v1

### Tool schema

```
task({
  description: string,        // 3-5 words, shown in UI
  type: "explore" | "research" | "implement" | "verify",
  prompt: string,             // self-contained task brief (subagent sees NOTHING else)
  model?: string,             // optional override (provider/id); default = route by type
  maxTurns?: number,          // default 12, hard cap 25
  timeout?: number,           // seconds, default 300
  background?: boolean        // default false (foreground)
})
```

### Profiles (structural, not prompt-wishes)

| Type | Tool set | Default model route | System prompt shape |
|---|---|---|---|
| `explore` | read, grep, find, ls, bash(read-only commands) | cheapest eligible (local 9B) | "Inspect, return a concise self-contained answer with file:line evidence" |
| `research` | explore + webSearch + webFetch | cheapest eligible | same + "cite source URLs" |
| `implement` | full set | parent driver | "Do the change, verify it, report what changed and how verified" |
| `verify` | read, grep, find, ls, bash | cheapest eligible | "Run the verification the parent describes; report command + exit code + output summary" |

Read-only types get their tool set **by construction** (Reasonix lesson: prompt-text restrictions leak, registry restrictions don't).

### Core mechanics

1. **Isolation:** each task runs a fresh `Agent` (packages/agent) with an in-memory SessionManager — zero parent session-file pollution, zero prefix impact on the parent. Subagent's own persistence is ephemeral (debug log optional).
2. **Result-only return:** parent receives `{ state: completed|failed|timeout|budget, summary, evidence[] }` — the final assistant message plus a capped evidence list (commands run + exit codes, files changed). Never the transcript.
3. **Bounds:** `maxTurns` (12 default / 25 cap), wall timeout, and a per-task token budget that aborts cleanly with a partial-result marker. Depth cap: **subagents do not get the `task` tool** (recursion impossible by registry construction).
4. **Concurrency: a scheduler, not a free-for-all.** Foreground default (parent blocks). `background: true` returns immediately with a task id; completions arrive as a hidden `<background-task>` message riding the next turn (Reasonix drain pattern — never a poll). Local models: queue depth 1 (single GPU slot — parallel local tasks are an anti-feature). API providers: queue depth 3. Anti-polling instructions in the tool description (opencode lesson).
5. **Model routing:** type → `selectCheapModelForTask` candidates (existing `model-routing.ts`). explore/research/verify default to cheapest eligible; implement defaults to the parent driver; an explicit `model` arg or the future B2 escalation hook can promote a specific task to the 550B *within a daily budget counter* (it's 200/day — subagent calls must draw from the same pool, visibly).
6. **Safety:** subagent inherits the active safety policy (interactive/headless/autonomous). Mutating types in interactive mode route approvals through the parent's existing approval path. Path containment (`resolveContainedPath`) applies identically.
7. **Verification honesty:** a `verify` task's report only counts as a verification checkpoint when it records a real tool execution (bash command + exit code) — the parent's gate sees structured evidence, not prose (same sweet-talk rule as the main loop).
8. **Observability:** subagent progress renders nested under the parent's tool call in the TUI (spinner + live stats from the existing GenerationStatsTracker); auton ledger gets task entries; costs roll up to the parent run's usage accounting.

### Explicit non-goals (v1)

No fleet/parallel-swarm mode, no persistent named agents, no `task_id` resume, no depth-2 delegation, no automatic "use a subagent for everything" steering. The model decides; we just make delegation cheap and safe.

### Implementation shape (small)

- `core/tools/task.ts` — ToolDefinition following the existing tool pattern (schema, execute, render hooks for the TUI nesting).
- `core/subagent-runner.ts` — builds the isolated `Agent` + filtered registry + in-memory session, enforces bounds, emits nested events, returns the structured result.
- `core/subagent-scheduler.ts` — foreground/background queue with provider-aware depth limits.
- Registration in `core/tools/index.ts` behind a setting (default on; `AG1_DISABLE_TASK_TOOL=1` to kill).
- Eval: 2 new scenarios modeled on Reasonix's delegation task (must-delegate search; must-delegate implement+verify), then measure tokens/solved vs. direct.

## Decision points for you

1. Profiles `explore/research/implement/verify` — right four, or do you want `plan` too (read-only planning for the auton planner lane)?
2. Depth: hard no-recursion (my recommendation) vs. depth-2 like Reasonix?
3. Background mode in v1 (adds scheduler + turn-injection complexity) or foreground-only v1 with background in v1.1? I lean foreground-first — simpler, and the model misuses background more often than it helps.
4. Should `task` be on by default in interactive+autonomous, or opt-in flag for the first week?

## Decisions (locked 2026-07-18)

1. **Add `plan`** — read-only planning profile (explore tool set + planner-shaped system prompt) feeding the auton planner lane.
2. **The cardinal rule: efficiency comes from isolation, never from dumbing down.** Subagents must be as capable as the task needs: `implement` and `plan` run the driver model (or better), never a weaker one to save tokens; `explore`/`research`/`verify` may route cheap because those tasks are mechanical. Savings come from the parent not paying for the subagent's transcript — not from weaker models, amputated evidence, or starved turn budgets. Bounds exist to stop loops (loop detection, generous caps), not to ration real work. If an efficiency tweak would cost capability, it doesn't ship.
3. Recursion: no `task` tool inside subagents (hard no-recursion).
4. Background: foreground-first v1; background queue as v1.1 if it earns it.
5. Default on in interactive + autonomous.

## Amendment (2026-07-18, data-forced): capability-gated surface

Measured on the v4 suite (9B local, tool never invoked in any scenario): the tool's mere presence cost **+44% tokens/solved** with the full description and **+23%** with a slimmed one (A/B with `AG1_DISABLE_TASK_TOOL=1` returned to baseline, 34.3k). Small models fumble with an unfamiliar delegation tool in context — decision 5 as written would tax exactly the models that can't use the feature.

**Shipped behavior:** the tool is offered when `inferModelCapabilityProfile(model).toolCallReliability !== "low"` — capable local models and API/frontier models (incl. the 550B) get it by default; small local models get a focused tool surface without it. Overrides: `AG1_TASK_TOOL=1` forces on, `=0` forces off. Everything else in this doc shipped as locked.
