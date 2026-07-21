# Contributing To AG1

This repo is a TypeScript monorepo. Most harness work currently happens in `packages/coding-agent`.

## Package Map

- `packages/coding-agent`: CLI, TUI, session runtime, tools, autonomous runner, compaction, safety, extensions, SDK exports.
- `packages/ai`: provider abstractions, model definitions, request/response types, streaming helpers.
- `packages/agent`: low-level agent loop, state shape, tool execution protocol.
- `packages/tui`: terminal UI primitives used by the interactive mode.
- `packages/pods*` and `packages/web-ui`: adjacent package/runtime surfaces used by the broader monorepo.
- `scripts`: benchmark and maintenance scripts.
- `docs`: architecture, contributor, and project-facing documentation.

## Common Commands

Install dependencies:

```bash
npm install
```

Build the coding-agent package:

```bash
npm run build --workspace packages/coding-agent
```

Run all coding-agent tests:

```bash
npm test --workspace packages/coding-agent
```

Run focused tests:

```bash
npm test --workspace packages/coding-agent -- compaction.test.ts model-routing.test.ts
```

Build supporting packages when provider or agent-core types change:

```bash
npm run build --workspace packages/ai
npm run build --workspace packages/coding-agent
```

## Where To Start

- Session lifecycle: `packages/coding-agent/src/core/agent-session.ts`
- Coordinator ownership: `packages/coding-agent/src/core/agent-session-coordinator-map.ts`
- Autonomous runner: `packages/coding-agent/src/core/auton/runner.ts`
- Compaction: `packages/coding-agent/src/core/compaction/`
- Built-in tools: `packages/coding-agent/src/core/tools/`
- Interactive TUI: `packages/coding-agent/src/modes/interactive/`
- Runtime services: `packages/coding-agent/src/core/agent-session-services.ts`

## Change Discipline

- Keep changes narrowly scoped to the owner module.
- Add tests near the behavior being changed.
- Prefer deterministic helpers over model-text regexes where possible.
- Preserve structured state across compaction and recovery paths.
- Treat shell/file/web behavior as safety-sensitive.
- Run focused tests first, then the package build, then the full package suite for shared runtime changes.

## Safety Notes

AG1 can run shell commands and edit files. Tests should use temporary directories and avoid touching the developer's home directory, global git config, or real credentials. New tools should enforce workspace containment and return compact, actionable output.

## Workspace Hygiene

The repository deliberately avoids committing debug dumps, UI backups, temp copies, Python caches, and one-off generators. These make the tree feel cluttered and slow onboarding.

- Run `npm run clean` (enhanced) to remove dists + common dev artifacts (Debug/, ui-backups/, New_files*/, caches).
- `Debug/` and similar are already in `.gitignore`.
- If you generate large session dumps or backups during development, clean them before commits.
- See root `package.json` scripts and `.gitignore` for the current list of ignored hygiene targets.

Keeping the workspace minimal helps the "coherent, standalone harness" goal.
