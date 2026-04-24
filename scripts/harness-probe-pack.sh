#!/usr/bin/env bash
set -euo pipefail

repo_root="/home/alex/AG1"
cwd="${1:-$repo_root}"
pack_root="${AG1_PROBE_PACK_ROOT:-/tmp/harness-probe-pack-$(date +%Y%m%d-%H%M%S)}"

mkdir -p "$pack_root"

run_probe() {
  local label="$1"
  local prompt="$2"
  echo "=== $label ==="
  AG1_PROBE_ROOT="$pack_root/$label" "$repo_root/scripts/harness-probe.sh" "$prompt" "$cwd" "$label"
  echo
}

run_probe "greeting" "hello"
run_probe "local_lookup" "find the file that defines buildLocalEvidencePromptAddendum and summarize what it does"
run_probe "docs_lookup" "look up React docs on actions and summarize briefly"
run_probe "broad_research" "research the latest claude code leak and summarize it"

echo "Probe pack root: $pack_root"
