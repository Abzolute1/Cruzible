# AG1 Architecture

AG1 is a coding-agent harness built around a single live `AgentSession`. The session owns the model-facing transcript, tool registry, persistence hooks, and recovery controls, but most non-trivial behavior is delegated to narrow coordinators.

## Runtime Shape

```text
CLI / TUI / RPC
    |
    v
AgentSessionRuntime
    | creates cwd-bound services
    v
AgentSession
    | owns session facade and event dispatch
    +-- AgentSessionPromptCoordinator
    +-- AgentSessionEventLoopCoordinator
    +-- AgentSessionCompactionCoordinator
    +-- AgentSessionRetryCoordinator
    +-- AgentSessionToolRegistryCoordinator
    +-- AgentSessionModelCoordinator
    +-- AgentSessionBashCoordinator
    +-- AgentSessionXmlCoordinator
    +-- AgentSessionTreeCoordinator
    +-- extension lifecycle/core coordinators
```

The detailed ownership table is codified in `packages/coding-agent/src/core/agent-session-coordinator-map.ts` and guarded by tests. If a new coordinator is added, it should claim one primary area there before it grows state.

## Main Turn Flow

```text
user input
  -> InteractiveMode / PrintMode / RpcMode
  -> AgentSession.prompt()
  -> AgentSessionPromptCoordinator
  -> Agent transport call
  -> tool calls, tool results, assistant messages
  -> AgentSessionEventLoopCoordinator
  -> retry / compaction / XML fallback checks
  -> persistence via SessionManager
  -> final UI/reporting
```

The event loop serializes recovery-sensitive work so queued messages, compaction replay, retry replay, and XML fallback do not race each other.

## Context And Cost Flow

Context management is layered:

- `micro-compact` trims stale hidden/runtime content inside live history.
- `snipHistory` removes old protected turn groups when emergency space is needed.
- `compact` writes durable structured summaries into the session tree.
- deterministic working memory is stored in compaction details and promoted to the front of compacted summaries.
- context attribution estimates system prompt, tool schema, summaries, tool outputs, retained transcript, and provider overhead.

Cheap-model routing is centralized in `model-routing.ts`. Compaction uses it for summarization when a cheaper authenticated model has enough context and output capacity.

## Persistence

`SessionManager` is the session-store boundary. It owns JSONL parsing, migration, branch traversal, label changes, compaction entries, and session-file write serialization. Callers should append structured entries instead of rewriting session files directly.

See [session-store.md](session-store.md) for the event-store and concurrent writer safety notes.

## Tooling Boundary

Tool definitions live under `core/tools` and are wrapped by the tool registry coordinator. Interactive rendering belongs under `modes/interactive`; reusable tool-result facts and local evidence steering live in `core` because they affect model behavior independent of the UI.

## Subagent Boundary

The `task` tool delegates a self-contained subtask to an isolated subagent. `core/subagent-runner.ts` builds a fresh `Agent` per task with a profile-shaped tool set (read-only by construction for explore/research/verify/plan; hard no-recursion — subagents never see `task`), an ephemeral in-memory transcript, and bounds (turn cap, wall timeout, token budget, repeated-call loop detection). `core/subagent-scheduler.ts` serializes local-model subagents on a single slot (LM Studio cannot run parallel streams) and pools API subagents at depth 3. Only the structured result (`{state, summary, evidence[], usage}`) returns to the parent transcript; usage rolls up into the parent session as `ag1.subagent_task` custom entries so token accounting never treats delegation as free. The active safety policy applies below the boundary identically, and the auton verification gate counts a verify task's evidence only when it records a real bash execution (same sweet-talk rule as the main loop).

## Safety Boundary

Shell/file safety is enforced by policy objects, workspace containment helpers, and autonomous workspace isolation. Autonomous headless and interactive modes should use the same workspace activation path and restore the previous safety policy on exit.

## Extension Boundary

Extensions receive a facade through extension core/lifecycle coordinators. They can add tools, commands, context, and lifecycle hooks, but core session persistence and recovery decisions remain owned by `AgentSession` and its coordinators.
