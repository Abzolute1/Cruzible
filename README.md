# Crucible

Crucible is a stateful coding harness for supervised and autonomous work.

The goal is not to be the flashiest agent shell. The goal is to be a harness that can:

- stay cheap on context and tool usage
- recover from failure modes instead of looping blindly
- operate interactively or autonomously from the same control plane
- preserve enough structured state that long runs do not depend on raw transcript alone
- be safe enough to trust more than a typical prompt wrapper

This repo still carries visible Pi fork lineage in package names and some metadata. The direction of the project is no longer "Pi plus random patches". The direction is a coherent harness with a stronger autonomous control plane.

The primary short command is `cru`. The full command is `crucible`. `ag1` remains as a compatibility alias while the rename settles.

## Philosophy

Crucible is being built with a base-layer-first philosophy.

That means:

- reliability over novelty
- explicit state over transcript guessing
- recovery and verification over "looks done"
- small prompts over bloated orchestration
- isolated autonomy over direct host mutation
- minimal telemetry over heavy observability stacks

The project is deliberately not following the pattern of shipping a large volume of shallow features. The intent is to make the harness correct, inspectable, and economical before adding more surface area.

## What Crucible Tries To Be

Crucible is a coding harness that can work in two modes:

- interactive mode: the user steers the run turn by turn
- autonomous mode: the harness continues until it reaches a verified stop condition, hits a blocker, or exhausts budget

The important distinction is that AG1 is not just "chat plus tools". The harness keeps control state outside the raw transcript:

- autonomous ledger and checkpoints
- planner/resume state
- verification state
- runtime health history
- research artifacts and source provenance
- visual verification state
- isolated autonomous workspace state

That is the main design bet: cheaper, stronger behavior comes from a better control plane, not just from a bigger model or a bigger prompt.

## Core Capabilities

- Interactive TUI with persistent mode display and keyboard-first autonomy toggle
- Autonomous runner with budget enforcement, stabilization, replanning, scope narrowing, and blocker stops
- Structured run ledger with checkpoint persistence and resume modes
- Workspace isolation for autonomous runs with diff, promote, and discard flows
- Safety policy for dangerous shell/file operations
- Research tools with source-aware search/fetch, caching, and saved artifacts
- Visual verification support with screenshot and interaction-aware frontend iteration state
- Session debug logging with timeline artifacts for post-run analysis
- Compaction and context management aimed at keeping runs affordable on smaller local models

## How The Harness Works

At a high level:

1. `main.ts` boots providers, model resolution, and the TUI/runtime.
2. `AgentSession` manages the active session and delegates critical control paths to dedicated coordinators.
3. `InteractiveMode` owns the TUI and session wiring.
4. The autonomous runner owns multi-turn unattended execution.
5. The safety layer, runtime health layer, and workspace layer constrain how autonomy operates.

The project has been moving away from "god objects" toward dedicated coordinators and helpers. Major control paths now have explicit owners for:

- event dispatch
- event loop handling
- retries
- compaction
- bash execution
- XML fallback handling
- extension lifecycle and binding
- prompt orchestration
- runtime bootstrap
- TUI runtime transitions
- TUI auth flow
- TUI selector and settings logic

That decomposition matters because reliability problems in agent harnesses usually come from control-flow sprawl, not from missing features.

## Autonomous Execution Model

Autonomous mode is designed to be bounded and inspectable.

- It uses a shared autonomous runner, not a second disconnected execution path.
- It works from an isolated workspace instead of editing the source tree in place.
- It tracks run state in a ledger instead of relying only on transcript continuation.
- It stops on explicit evidence conditions where possible:
  - research evidence
  - code verification
  - visual verification
- It can replan, narrow scope, or stop with a blocker summary when the run drifts.
- It persists snapshots so interrupted runs can resume from control state rather than guesswork.

## Research And Cost Discipline

Crucible is explicitly trying to be cheaper than heavier harnesses.

That only works if the harness avoids wasting turns. Current cost-control direction includes:

- compact search/fetch outputs
- saved research artifacts outside the main transcript
- source reuse instead of repeated search churn
- context compaction with structured state preservation
- explicit resume modes after interruption
- evidence-based stopping for research/code/visual slices

The intended result is not "the fewest tokens possible". The intended result is "spend tokens where they buy progress, not where they buy reconstruction of forgotten state".

## Safety Model

Crucible is being hardened for unattended execution, but "autonomous" does not mean "unrestricted".

Important current guardrails:

- dangerous shell patterns are blocked
- interactive mutating actions can require approval
- autonomous runs are isolated into a separate workspace
- broad roots like `HOME`, `Desktop`, `Downloads`, and similar personal directories are rejected for autonomy unless narrowed to a real project scope
- workspace promotion back into the source tree is explicit

This is still a harness under active hardening, not a claim of perfect sandbox security.

## Current Status

Crucible is already substantially more coherent than the original glued integration, but it is still under active cleanup.

Current strengths:

- stronger autonomous control plane
- better safety than the initial merge
- better runtime recovery
- better research discipline
- better visual verification policy
- less monolithic session/runtime code

Current realities:

- the repo still visibly inherits Pi structure and metadata
- `interactive-mode.ts` is still large, even after substantial decomposition
- there is more cleanup to do before the codebase feels fully standalone
- unattended trust is improving, but the project is not claiming "leave it on a production workstation with zero concern"

## Getting Started

Requirements:

- Node.js 20+
- npm

Install dependencies:

```bash
npm install
```

Build the coding agent package:

```bash
npm run build --workspace packages/coding-agent
```

Run the CLI from the package:

```bash
node packages/coding-agent/dist/cli.js
```

If you want system commands, point them at the built CLI:

```bash
sudo ln -sf /path/to/AG1/packages/coding-agent/dist/cli.js /usr/local/bin/cru
sudo ln -sf /path/to/AG1/packages/coding-agent/dist/cli.js /usr/local/bin/crucible
sudo ln -sf /path/to/AG1/packages/coding-agent/dist/cli.js /usr/local/bin/ag1
```

## Useful Commands

From the TUI:

- `Alt+M` toggles autonomous mode
- `/session` shows session, autonomy, runtime-health, and recovery state
- `/workspace` shows the preserved autonomous sandbox
- `/workspace diff` shows sandbox changes
- `/workspace promote` promotes sandbox changes back into the source tree
- `/workspace discard` removes the preserved sandbox
- `/research` shows saved research artifacts
- `/debug` writes a runtime snapshot and debug artifact pointers

## Repo Layout

- `packages/coding-agent`: main CLI/TUI harness
- `packages/agent`: agent core
- `packages/ai`: model/provider abstractions
- `packages/tui`: terminal UI primitives
- `Debug/`: session debug output from live runs
- `prompt.md`: original build brief and intent document

## Development Direction

The near-term direction is:

- keep simplifying and hardening the control plane
- keep reducing transcript dependence
- improve resume, verification, and recovery
- keep autonomous runs cheap enough for local and mid-context models
- finish the repo cleanup only after the harness architecture is genuinely stable

If you are evaluating this repo, the important question is not "how many tools does it have?" The important question is whether the harness keeps enough explicit state to make long-running work reliable. That is the main problem Crucible is trying to solve.
