# Security Boundaries

AG1 is a coding-agent harness, not a complete sandbox. It can reduce risk, but it cannot make arbitrary model-driven shell/file/network activity safe by itself.

## What AG1 Blocks Or Narrows

- Workspace path containment for built-in file tools.
- Dangerous shell/file operations through safety policies.
- Autonomous execution in an isolated workspace before explicit promotion.
- Broad personal roots such as home/Desktop/Downloads for autonomous mode unless narrowed to a project scope.
- Controlled autonomous task policies for expected paths and mutation intent.
- Web fetch policy checks for supported fetch tools.
- Context audit redaction for common secret shapes before writing audit payloads.

## What AG1 Does Not Guarantee

- It does not provide a kernel, container, VM, or network sandbox.
- It cannot prevent every dangerous command if external tools, extensions, or direct shell access bypass policy.
- It cannot prove third-party packages, extensions, skills, or prompt templates are safe.
- It cannot guarantee that model output is correct, non-malicious, or prompt-injection resistant.
- It cannot fully protect secrets already present in repo files, command output, browser pages, logs, or external tool responses.
- It cannot make untrusted repositories safe to execute without an OS/container boundary.

## Recommended Setup For Untrusted Work

- Run AG1 inside a container, VM, or disposable user account.
- Mount only the target repo and required caches.
- Keep API keys and production credentials out of the workspace.
- Disable or restrict network access when the task does not require it.
- Use autonomous workspace isolation and inspect diffs before promotion.
- Prefer project-local credentials with minimal permissions.
- Review third-party AG1 packages before installing them.

## Optional Bash Sandbox Backend

By default, AG1 runs bash commands through the local shell after policy checks. For unattended or untrusted work, route bash through an external sandbox by setting `AG1_BASH_SANDBOX_COMMAND`.

The value is a shell command template. AG1 replaces `{command}` with the shell-quoted model command and `{cwd}` with the shell-quoted working directory before execution:

```bash
AG1_BASH_SANDBOX_COMMAND='firejail --quiet --private={cwd} -- bash -lc {command}'
```

Use a sandbox command that fits your environment, such as `bwrap`, `firejail`, `nsjail`, Docker, or a site-local wrapper script. The AG1 backend is only a routing layer; the actual isolation strength depends on the external sandbox configuration.

## Extension And Package Risk

Extensions are code. They can run arbitrary JavaScript/TypeScript with the user's permissions. Skills and prompt templates are not code by themselves, but they can instruct the model to run tools or commands. Treat packages from npm, git, or local folders as trusted-code dependencies.

## Reporting Security Issues

Do not publish secrets, exploit payloads, or private repo details in public issues. Share a minimal reproduction and the affected boundary: shell, file mutation, web fetch, extension loading, session persistence, or autonomous workspace promotion.
