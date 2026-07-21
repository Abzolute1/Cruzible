#!/bin/bash
set -euo pipefail

# Convenience wrapper for the new deep benchmark against local Qwen models via AG1 harness.
# Usage example:
#   ./scripts/run-deep-qwen-bench.sh "qwen2.5-coder:32b" /tmp/qwen35-deep-results

MODEL="${1:-qwen3.5:35b-a3b}"
OUT_DIR="${2:-/tmp/ag1-qwen-deep-bench-$(date +%Y%m%d-%H%M%S)}"

echo "Running deep benchmark with model: $MODEL"
echo "Results will be in: $OUT_DIR"

node scripts/harness-benchmark-run.mjs \
  --adapter ag1 \
  --scenarios scripts/benchmark-scenarios-deep-qwen.json \
  --model "$MODEL" \
  --timeout 300 \
  --out-dir "$OUT_DIR" \
  --max-turns 60 \
  --skip-history

echo ""
echo "Benchmark complete."
echo "See $OUT_DIR for .json, .csv, .md reports and per-scenario logs."
echo "Key file: $OUT_DIR/ag1.results.json"
