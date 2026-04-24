#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: scripts/harness-probe.sh <prompt> [cwd] [label]" >&2
  exit 1
fi

prompt="$1"
cwd="${2:-$PWD}"
label="${3:-probe}"
timestamp="$(date +%Y%m%d-%H%M%S)"
probe_root="${AG1_PROBE_ROOT:-/tmp/harness-probe-${label}-${timestamp}}"
timeout_secs="${AG1_PROBE_TIMEOUT:-90}"
retry_count="${AG1_PROBE_RETRIES:-2}"
retry_delay_secs="${AG1_PROBE_RETRY_DELAY:-2}"
report_file="$probe_root/probe-report.txt"

mkdir -p "$probe_root"

echo "Probe cwd: $cwd"
echo "Agent dir: $probe_root"
echo "Prompt: $prompt"
echo "Timeout: ${timeout_secs}s"
echo

status="ok"
attempts_run=0
latest_session=""
session_list=""
context_report=""
session_summary=""
attempt_reports=""

run_attempt() {
  local attempt="$1"
  local attempt_dir="$probe_root/attempt-$attempt"
  local attempt_log="$attempt_dir/attempt-output.log"
  local attempt_status="ok"
  local attempt_session_list=""
  local attempt_latest_session=""
  local attempt_context_report=""
  local attempt_session_summary=""
  local attempt_output=""

  mkdir -p "$attempt_dir"
  echo "Attempt $attempt/$retry_count"
  if command -v timeout >/dev/null 2>&1; then
    if ! timeout "${timeout_secs}" ag1 --print --agent-dir "$attempt_dir" --cwd "$cwd" "$prompt" >"$attempt_log" 2>&1; then
      echo
      echo "Probe command exited non-zero or timed out." >&2
      attempt_status="timeout_or_error"
    fi
  else
    if ! ag1 --print --agent-dir "$attempt_dir" --cwd "$cwd" "$prompt" >"$attempt_log" 2>&1; then
      echo
      echo "Probe command exited non-zero." >&2
      attempt_status="error"
    fi
  fi
  if [[ -f "$attempt_log" ]]; then
    cat "$attempt_log"
    attempt_output="$(cat "$attempt_log")"
  fi

  attempt_session_list="$(find "$attempt_dir/sessions" -type f -name '*.jsonl' -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -n 3 | cut -d' ' -f2-)"
  attempt_latest_session="$(printf '%s\n' "$attempt_session_list" | head -n 1)"

  if [[ -n "$attempt_latest_session" && -f "$attempt_latest_session" ]] && command -v node >/dev/null 2>&1; then
    attempt_context_report="$(node /home/alex/AG1/scripts/probe-context-report.mjs "$attempt_latest_session" 2>/dev/null || true)"
    attempt_session_summary="$(node /home/alex/AG1/scripts/probe-session-summary.mjs "$attempt_latest_session" 2>/dev/null || true)"
  fi

  if [[ -z "$attempt_latest_session" ]]; then
    attempt_status="no_session"
  fi

  if printf '%s\n%s\n%s\n' "$attempt_output" "$attempt_context_report" "$attempt_session_summary" | grep -qiE "Local model backend unavailable|Connection error\\."; then
    attempt_status="backend_unavailable"
  elif printf '%s\n%s\n' "$attempt_context_report" "$attempt_session_summary" | grep -q "placeholder_fetch"; then
    : # keep successful run status; placeholder is a quality signal, not execution failure
  fi

  attempt_reports="${attempt_reports}attempt=${attempt}\nstatus=${attempt_status}\nagent_dir=${attempt_dir}\nlatest_session=${attempt_latest_session}\n"
  if [[ -n "$attempt_output" ]]; then
    attempt_reports="${attempt_reports}attempt_output<<EOF\n${attempt_output}\nEOF\n"
  fi
  if [[ -n "$attempt_context_report" ]]; then
    attempt_reports="${attempt_reports}context_report<<EOF\n${attempt_context_report}\nEOF\n"
  fi
  if [[ -n "$attempt_session_summary" ]]; then
    attempt_reports="${attempt_reports}session_summary<<EOF\n${attempt_session_summary}\nEOF\n"
  fi
  attempt_reports="${attempt_reports}\n"

  status="$attempt_status"
  latest_session="$attempt_latest_session"
  session_list="$attempt_session_list"
  context_report="$attempt_context_report"
  session_summary="$attempt_session_summary"
}

for attempt in $(seq 1 "$retry_count"); do
  attempts_run="$attempt"
  run_attempt "$attempt"
  if [[ "$status" == "ok" ]]; then
    break
  fi
  if [[ "$status" != "backend_unavailable" && "$status" != "timeout_or_error" && "$status" != "no_session" ]]; then
    break
  fi
  if [[ "$attempt" -lt "$retry_count" ]]; then
    echo
    echo "Retrying probe after ${retry_delay_secs}s because status=$status..."
    sleep "$retry_delay_secs"
    echo
  fi
done

echo
echo "Latest saved sessions:"
printf '%s\n' "$session_list"

{
  echo "status=$status"
  echo "attempts_run=$attempts_run"
  echo "retry_budget=$retry_count"
  echo "cwd=$cwd"
  echo "agent_dir=$probe_root"
  echo "prompt=$prompt"
  echo "timeout_secs=$timeout_secs"
  echo "latest_sessions<<EOF"
  printf '%s\n' "$session_list"
  echo "EOF"
  echo "attempt_reports<<EOF"
  printf '%b' "$attempt_reports"
  echo "EOF"
  if [[ -n "$context_report" ]]; then
    echo "context_report<<EOF"
    printf '%s\n' "$context_report"
    echo "EOF"
  fi
  if [[ -n "$session_summary" ]]; then
    echo "session_summary<<EOF"
    printf '%s\n' "$session_summary"
    echo "EOF"
  fi
} > "$report_file"

echo
if [[ -n "$context_report" ]]; then
  printf '%s\n' "$context_report"
  echo
fi
if [[ -n "$session_summary" ]]; then
  printf '%s\n' "$session_summary"
  echo
fi
echo "Probe report: $report_file"
