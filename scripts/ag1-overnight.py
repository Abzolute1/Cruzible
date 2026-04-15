#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import pty
import re
import select
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

DEFAULT_RUNS_ROOT = Path.home() / ".ag1-overnight"
DEFAULT_RESUME_MESSAGE = (
    "Continue working autonomously on the current task. "
    "Make concrete progress, verify what you can, and only stop if you hit a real blocker or the run budget ends."
)
DEFAULT_STARTUP_PROGRESS_TIMEOUT_SECONDS = 600
DEFAULT_IDLE_PROGRESS_TIMEOUT_SECONDS = 1200
ANSI_CSI_RE = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")
ANSI_OSC_RE = re.compile(r"\x1b\][^\x07]*\x07")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def slugify(value: str) -> str:
    normalized = re.sub(r"[^a-zA-Z0-9]+", "-", value.lower()).strip("-")
    return (normalized or "run")[:48]


def ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def read_json(path: Path, default: dict[str, Any]) -> dict[str, Any]:
    if not path.exists():
        return dict(default)
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, data: dict[str, Any]) -> None:
    path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def strip_ansi(text: str) -> str:
    return ANSI_CSI_RE.sub("", ANSI_OSC_RE.sub("", text)).replace("\r", "\n")


def append_text(path: Path, text: str) -> None:
    with path.open("a", encoding="utf-8") as handle:
        handle.write(text)


def update_state(run_dir: Path, **updates: Any) -> dict[str, Any]:
    state_path = run_dir / "state.json"
    state = read_json(
        state_path,
        {
            "status": "created",
            "attempts": 0,
            "createdAt": utc_now(),
            "updatedAt": utc_now(),
        },
    )
    state.update(updates)
    state["updatedAt"] = utc_now()
    write_json(state_path, state)
    return state


def append_event(run_dir: Path, event: dict[str, Any]) -> None:
    with (run_dir / "events.jsonl").open("a", encoding="utf-8") as handle:
        handle.write(json.dumps({"timestamp": utc_now(), **event}) + "\n")


def is_pid_running(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def build_ag1_command(manifest: dict[str, Any], *, resume: bool) -> list[str]:
    command = [
        manifest.get("binary", "/usr/local/bin/ag1"),
        "--agent-dir",
        manifest["agentDir"],
        "--cwd",
        manifest["cwd"],
        "--autonomous",
        "--max-turns",
        str(manifest["maxTurns"]),
    ]
    if manifest.get("maxCost", 0) > 0:
        command += ["--max-cost", str(manifest["maxCost"])]
    if manifest.get("maxTokens", 0) > 0:
        command += ["--max-tokens", str(manifest["maxTokens"])]
    if manifest.get("maxOutput", 0) > 0:
        command += ["--max-output", str(manifest["maxOutput"])]
    if manifest.get("provider"):
        command += ["--provider", manifest["provider"]]
    if manifest.get("model"):
        command += ["--model", manifest["model"]]
    if manifest.get("enableNudges"):
        command.append("--enable-nudges")
    if manifest.get("enableBehavioralPrompt"):
        command.append("--enable-behavioral-prompt")
    if manifest.get("verbose"):
        command.append("--verbose")
    if resume:
        command.append("--continue")
        command.append(manifest.get("resumeMessage") or DEFAULT_RESUME_MESSAGE)
    else:
        command.append(manifest["goal"])
    return command


def extract_progress_markers(text: str) -> list[str]:
    markers: list[str] = []
    for raw_line in strip_ansi(text).splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith("[Autonomous] checkpoint"):
            markers.append(line)
            continue
        if line.startswith("[Autonomous] Autonomous run complete"):
            markers.append(line)
            continue
    return markers


def run_ag1_once(run_dir: Path, manifest: dict[str, Any], *, resume: bool, attempt: int) -> int:
    command = build_ag1_command(manifest, resume=resume)
    append_event(run_dir, {"type": "attempt_start", "attempt": attempt, "command": command})
    update_state(
        run_dir,
        status="running",
        currentAttempt=attempt,
        currentCommand=command,
        lastStartedAt=utc_now(),
    )

    raw_log = (run_dir / "tui.raw.log").open("ab")
    text_log = (run_dir / "tui.log").open("a", encoding="utf-8")
    last_output_at = time.monotonic()
    last_progress_at = time.monotonic()
    startup_timeout = float(manifest.get("startupProgressTimeoutSeconds", DEFAULT_STARTUP_PROGRESS_TIMEOUT_SECONDS))
    idle_timeout = float(manifest.get("idleProgressTimeoutSeconds", DEFAULT_IDLE_PROGRESS_TIMEOUT_SECONDS))
    seen_progress = False
    try:
        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(manifest["cwd"])
            os.execvp(command[0], command)

        while True:
            ready, _, _ = select.select([fd], [], [], 0.2)
            if not ready:
                try:
                    finished_pid, status = os.waitpid(pid, os.WNOHANG)
                except ChildProcessError:
                    break
                if finished_pid == pid:
                    if os.WIFEXITED(status):
                        exit_code = os.WEXITSTATUS(status)
                    else:
                        exit_code = 128 + os.WTERMSIG(status)
                    break
                now = time.monotonic()
                progress_deadline = idle_timeout if seen_progress else startup_timeout
                if now - last_progress_at > progress_deadline:
                    os.kill(pid, signal.SIGTERM)
                    append_event(
                        run_dir,
                        {
                            "type": "attempt_stalled",
                            "attempt": attempt,
                            "seenProgress": seen_progress,
                            "timeoutSeconds": progress_deadline,
                        },
                    )
                    update_state(
                        run_dir,
                        status="stalled",
                        lastProgressAt=utc_now(),
                        lastProgressDetail="stalled: no autonomous checkpoint progress",
                    )
                    exit_code = 124
                    break
                continue

            try:
                data = os.read(fd, 65536)
            except OSError:
                break
            if not data:
                break
            last_output_at = time.monotonic()
            raw_log.write(data)
            raw_log.flush()
            decoded = data.decode("utf-8", errors="ignore")
            stripped = strip_ansi(decoded)
            text_log.write(stripped)
            text_log.flush()
            progress_markers = extract_progress_markers(decoded)
            if progress_markers:
                seen_progress = True
                last_progress_at = time.monotonic()
                latest_marker = progress_markers[-1]
                append_event(
                    run_dir,
                    {
                        "type": "progress",
                        "attempt": attempt,
                        "detail": latest_marker,
                    },
                )
                update_state(
                    run_dir,
                    status="running",
                    lastProgressAt=utc_now(),
                    lastProgressDetail=latest_marker,
                )
    finally:
        raw_log.close()
        text_log.close()
        try:
            os.close(fd)
        except Exception:
            pass

    append_event(run_dir, {"type": "attempt_end", "attempt": attempt, "exitCode": exit_code})
    update_state(run_dir, lastExitCode=exit_code, lastFinishedAt=utc_now())
    return exit_code


def run_worker(run_dir: Path) -> int:
    manifest = read_json(run_dir / "manifest.json", {})
    if not manifest:
        print(f"Missing manifest: {run_dir / 'manifest.json'}", file=sys.stderr)
        return 1

    stop_file = run_dir / "STOP"
    attempts = int(read_json(run_dir / "state.json", {}).get("attempts", 0))
    max_runs = int(manifest["maxRuns"])
    restart_delay = float(manifest["restartDelaySeconds"])

    while attempts < max_runs and not stop_file.exists():
        attempts += 1
        update_state(run_dir, attempts=attempts, workerPid=os.getpid())
        exit_code = run_ag1_once(run_dir, manifest, resume=attempts > 1, attempt=attempts)
        if stop_file.exists():
            update_state(run_dir, status="stopped", stopReason="stop requested", workerPid=None)
            return 0
        if exit_code == 0:
            update_state(run_dir, status="completed", stopReason="agent exited successfully", workerPid=None)
            return 0
        if attempts >= max_runs:
            update_state(run_dir, status="budget_exhausted", stopReason="max runs reached", workerPid=None)
            return exit_code
        update_state(run_dir, status="sleeping", nextRetryAt=utc_now(), workerPid=os.getpid())
        time.sleep(restart_delay)

    if stop_file.exists():
        update_state(run_dir, status="stopped", stopReason="stop requested", workerPid=None)
        return 0
    update_state(run_dir, status="budget_exhausted", stopReason="max runs reached", workerPid=None)
    return 1


def start_worker(run_dir: Path, foreground: bool) -> int:
    if foreground:
        return run_worker(run_dir)

    worker_log = (run_dir / "worker.log").open("a", encoding="utf-8")
    process = subprocess.Popen(
        [sys.executable, __file__, "_worker", "--run-dir", str(run_dir)],
        stdout=worker_log,
        stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL,
        start_new_session=True,
        close_fds=True,
    )
    worker_log.close()
    update_state(run_dir, status="launched", workerPid=process.pid)
    print(str(run_dir))
    print(f"pid={process.pid}")
    return 0


def create_run(args: argparse.Namespace) -> Path:
    runs_root = ensure_dir(Path(args.runs_root).expanduser())
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    slug = slugify(args.name or args.goal)
    run_dir = runs_root / f"{timestamp}-{slug}"
    ensure_dir(run_dir)
    ensure_dir(run_dir / "agent")

    manifest = {
        "goal": args.goal,
        "cwd": str(Path(args.cwd).expanduser().resolve()),
        "agentDir": str((run_dir / "agent").resolve()),
        "binary": args.binary,
        "provider": args.provider,
        "model": args.model,
        "maxTurns": args.max_turns,
        "maxRuns": args.max_runs,
        "maxCost": args.max_cost,
        "maxTokens": args.max_tokens,
        "maxOutput": args.max_output,
        "restartDelaySeconds": args.restart_delay,
        "startupProgressTimeoutSeconds": args.startup_progress_timeout,
        "idleProgressTimeoutSeconds": args.idle_progress_timeout,
        "resumeMessage": args.resume_message or DEFAULT_RESUME_MESSAGE,
        "enableNudges": args.enable_nudges,
        "enableBehavioralPrompt": args.enable_behavioral_prompt,
        "verbose": args.verbose,
        "createdAt": utc_now(),
    }
    write_json(run_dir / "manifest.json", manifest)
    update_state(run_dir, status="created")
    append_text(run_dir / "goal.txt", args.goal + "\n")
    append_event(run_dir, {"type": "created"})
    return run_dir


def load_run_dir(value: str) -> Path:
    run_dir = Path(value).expanduser().resolve()
    if not run_dir.exists():
        raise SystemExit(f"Run directory does not exist: {run_dir}")
    return run_dir


def command_start(args: argparse.Namespace) -> int:
    run_dir = create_run(args)
    return start_worker(run_dir, args.foreground)


def command_resume(args: argparse.Namespace) -> int:
    run_dir = load_run_dir(args.run_dir)
    state = read_json(run_dir / "state.json", {})
    worker_pid = state.get("workerPid")
    if isinstance(worker_pid, int) and is_pid_running(worker_pid):
        print(f"Run already active: {run_dir} (pid={worker_pid})")
        return 0
    if (run_dir / "STOP").exists():
        (run_dir / "STOP").unlink()
    return start_worker(run_dir, args.foreground)


def command_status(args: argparse.Namespace) -> int:
    run_dir = load_run_dir(args.run_dir)
    manifest = read_json(run_dir / "manifest.json", {})
    state = read_json(run_dir / "state.json", {})
    worker_pid = state.get("workerPid")
    running = isinstance(worker_pid, int) and is_pid_running(worker_pid)
    print(f"run_dir: {run_dir}")
    print(f"goal: {manifest.get('goal', '(unknown)')}")
    print(f"cwd: {manifest.get('cwd', '(unknown)')}")
    print(f"status: {state.get('status', 'unknown')}")
    print(f"attempts: {state.get('attempts', 0)}/{manifest.get('maxRuns', '?')}")
    print(f"worker_pid: {worker_pid if worker_pid else '(none)'}")
    print(f"running: {'yes' if running else 'no'}")
    print(f"last_exit_code: {state.get('lastExitCode', '(none)')}")
    print(f"log: {run_dir / 'tui.log'}")
    if args.tail > 0:
        log_path = run_dir / "tui.log"
        if log_path.exists():
            lines = log_path.read_text(encoding="utf-8", errors="ignore").splitlines()
            print("")
            print(f"--- tail ({min(args.tail, len(lines))} lines) ---")
            for line in lines[-args.tail :]:
                print(line)
    return 0


def command_stop(args: argparse.Namespace) -> int:
    run_dir = load_run_dir(args.run_dir)
    state = read_json(run_dir / "state.json", {})
    worker_pid = state.get("workerPid")
    (run_dir / "STOP").write_text(f"stop requested at {utc_now()}\n", encoding="utf-8")
    if isinstance(worker_pid, int) and is_pid_running(worker_pid):
        os.kill(worker_pid, signal.SIGTERM)
        print(f"Sent SIGTERM to worker {worker_pid}")
    else:
        print("Stop requested. No active worker PID found.")
    update_state(run_dir, status="stopping")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Launch and supervise unattended ag1 autonomous runs.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    start = subparsers.add_parser("start", help="Create a new unattended run")
    start.add_argument("--goal", required=True, help="Initial task for ag1")
    start.add_argument("--cwd", default=os.getcwd(), help="Workspace root for the run")
    start.add_argument("--runs-root", default=str(DEFAULT_RUNS_ROOT), help="Directory that stores run state")
    start.add_argument("--binary", default="/usr/local/bin/ag1", help="ag1 binary to launch")
    start.add_argument("--name", help="Optional short label for the run directory")
    start.add_argument("--provider", help="Optional provider override")
    start.add_argument("--model", help="Optional model override")
    start.add_argument("--max-turns", type=int, default=40, help="Max autonomous turns per ag1 session")
    start.add_argument("--max-runs", type=int, default=6, help="Max ag1 sessions before the supervisor stops")
    start.add_argument("--max-cost", type=float, default=0, help="Max USD cost per ag1 session")
    start.add_argument("--max-tokens", type=int, default=0, help="Max tokens per ag1 session")
    start.add_argument("--max-output", type=int, default=0, help="Max output tokens per turn")
    start.add_argument("--restart-delay", type=float, default=10, help="Seconds between resumed sessions")
    start.add_argument(
        "--startup-progress-timeout",
        type=float,
        default=DEFAULT_STARTUP_PROGRESS_TIMEOUT_SECONDS,
        help="Seconds to wait for the first autonomous checkpoint before restarting the run",
    )
    start.add_argument(
        "--idle-progress-timeout",
        type=float,
        default=DEFAULT_IDLE_PROGRESS_TIMEOUT_SECONDS,
        help="Seconds to wait between autonomous checkpoint updates before restarting the run",
    )
    start.add_argument("--resume-message", help="Message to send on resumed sessions")
    start.add_argument("--enable-nudges", action="store_true", help="Enable autonomous nudges")
    start.add_argument(
        "--enable-behavioral-prompt",
        action="store_true",
        help="Append the autonomous behavioral prompt",
    )
    start.add_argument("--verbose", action="store_true", help="Enable verbose ag1 diagnostics")
    start.add_argument("--foreground", action="store_true", help="Run the supervisor in the foreground")
    start.set_defaults(func=command_start)

    resume = subparsers.add_parser("resume", help="Restart a stopped run directory")
    resume.add_argument("--run-dir", required=True, help="Existing run directory")
    resume.add_argument("--foreground", action="store_true", help="Run the supervisor in the foreground")
    resume.set_defaults(func=command_resume)

    status = subparsers.add_parser("status", help="Show current run state")
    status.add_argument("--run-dir", required=True, help="Existing run directory")
    status.add_argument("--tail", type=int, default=20, help="Tail the text log")
    status.set_defaults(func=command_status)

    stop = subparsers.add_parser("stop", help="Request stop for a running supervisor")
    stop.add_argument("--run-dir", required=True, help="Existing run directory")
    stop.set_defaults(func=command_stop)

    worker = subparsers.add_parser("_worker", help=argparse.SUPPRESS)
    worker.add_argument("--run-dir", required=True)
    worker.set_defaults(func=lambda args: run_worker(load_run_dir(args.run_dir)))

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
