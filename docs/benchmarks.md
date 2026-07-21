# Benchmarking AG1

Benchmarks should measure intelligence-per-dollar, not only whether a task eventually passed.

## Headline metrics (2026-07)

The only headline numbers are externally-verifiable ones:

- **Solved**: scenarios where the scenario's external `verifyCommand` exits 0 (never model-graded).
- **Cost per solved**: total cost / solved count (per-turn usage read from session files; `$0` for local models).
- **Tokens per solved**: total tokens / solved count.
- **Wall time**.

The runner's older composite `score` (weighted heuristics over tool sequences etc.) is **deprecated** — it is still emitted for continuity but must never be tuned against. Product code must never contain benchmark-aware logic; any scenario whose purpose is to exercise AG1-internal steering gets deleted, not kept.

Side-by-side adapter comparison (ag1 vs opencode/codex/...) with these metrics:

```bash
node scripts/eval-compare.mjs --model qwen/qwen3.6-35b-a3b --provider local \
  --adapters ag1,opencode --timeout 300 --out-dir /tmp/ag1-eval
```

## Current Harness

The local benchmark entry point is:

```bash
node scripts/harness-benchmark-run.mjs \
  --adapter ag1 \
  --scenarios scripts/benchmark-scenarios-v3_5.json \
  --provider local \
  --model qwen/qwen3.5-9b \
  --timeout 120 \
  --out-dir /tmp/ag1-benchmark-qwen9b \
  --skip-history
```

`--provider` selects the AG1 provider for the ag1 adapter (default `local`; use e.g. `anthropic` for API models — the key comes from auth.json/env as usual).

Run one scenario:

```bash
node scripts/harness-benchmark-run.mjs \
  --adapter ag1 \
  --model qwen/qwen3.5-9b \
  --scenario docs_lookup \
  --timeout 120 \
  --out-dir /tmp/ag1-benchmark-docs-lookup
```

The same runner can execute other harnesses against identical fixtures:

```bash
AG1_BENCH_OPENCODE_COMMAND='opencode run --dir {workspace} --model {model} {task}' \
node scripts/harness-benchmark-run.mjs \
  --adapter opencode \
  --model qwen/qwen3.5-9b \
  --timeout 120 \
  --out-dir /tmp/opencode-benchmark-qwen9b \
  --skip-history
```

Supported adapters are `ag1`, `opencode`, `aider`, `codex`, `claude`, `continue`, and `command`. Non-AG1 adapters are command templates supplied with `--command-template` or `AG1_BENCH_<ADAPTER>_COMMAND`, for example `AG1_BENCH_AIDER_COMMAND`, `AG1_BENCH_CODEX_COMMAND`, or `AG1_BENCH_CONTINUE_COMMAND`.

External adapter templates support these placeholders:

- `{workspace}`: fixture workspace path.
- `{task}`: task prompt text.
- `{taskFile}`: path to `TASK.md`.
- `{scenario}`: scenario id.
- `{model}`: model id passed to the benchmark runner.
- `{maxTurns}` and `{maxOutput}`: scenario limits.
- `{agentDir}`: per-scenario artifact directory.
- `{metricsFile}`: optional JSON file the adapter can write for token/tool metrics.

If an external adapter writes `{metricsFile}`, the runner reads fields such as `toolSequence`, `toolCallCount`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `totalTokens`, `totalCost`, and `usageTurns`. Without that file, the runner still records exit status, stdout/stderr sizes, changed files, verification result, and duration.

## Required Result Fields

Every benchmark report should include:

- `adapter`: harness name and version or commit.
- `model`: provider/model id and local/server settings.
- `scenario`: stable scenario id.
- `passed`: boolean pass/fail.
- `turns`: autonomous/model turns used.
- `tool_calls`: total tool calls.
- `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`.
- `estimated_cost_usd`: zero for local models, real estimate for API models.
- `wall_time_seconds`.
- `verification`: command/check used to judge pass/fail.
- `recovery_quality`: `none`, `recovered`, `partial`, or `failed`.
- `notes`: short explanation for failures or unusual recovery.

## Comparison Table

Use this shape when comparing AG1 against OpenCode, Aider, Codex-style agents, Claude Code, Continue, or custom harnesses:

| Harness | Model | Suite | Pass Rate | Median Turns | Median Tool Calls | Median Cost | Recovery Quality | Notes |
|---------|-------|-------|-----------|--------------|-------------------|-------------|------------------|-------|
| AG1 | qwen/qwen3.5-9b | v3.5 | TBD | TBD | TBD | TBD | TBD | local model |
| OpenCode | same | v3.5 | TBD | TBD | TBD | TBD | TBD | same fixture |

Keep scenario fixtures identical. If another harness cannot run a scenario without custom glue, record that as harness overhead instead of silently changing the task.

## Recovery Quality Rubric

- `none`: task passed without failed verification, repeated discovery, or retry.
- `recovered`: task initially failed but used the error output to fix and pass.
- `partial`: task made useful progress but stopped with a clear blocker or incomplete verification.
- `failed`: task looped, drifted, corrupted files, or stopped without actionable evidence.

## Reporting Rules

- Report medians and p90s, not only averages.
- Separate local-model runs from paid API runs.
- Include prompt/context settings when they differ.
- Include exact commit SHA and scenario file SHA.
- Preserve raw transcripts outside the main README; summarize only the metrics in public docs.
- Treat destructive or network-dependent failures separately from model reasoning failures.
