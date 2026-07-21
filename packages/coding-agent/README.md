<p align="center">
  <a href="https://shittycodingagent.ai">
    <img src="https://shittycodingagent.ai/logo.svg" alt="AG1 logo" width="128">
  </a>
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://www.npmjs.com/package/@ag1/coding-agent"><img alt="npm" src="https://img.shields.io/npm/v/@ag1/coding-agent?style=flat-square" /></a>
  <a href="https://github.com/badlogic/pods-mono/actions/workflows/ci.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/badlogic/pods-mono/ci.yml?style=flat-square&branch=main" /></a>
</p>
<p align="center">
  <a href="https://pods.dev">ag1.dev</a> domain graciously donated by
  <br /><br />
  <a href="https://exe.dev"><img src="docs/images/exy.png" alt="Exy mascot" width="48" /><br />exe.dev</a>
</p>

AG1 is a stateful terminal coding harness for supervised and autonomous work. The goal is a model-agnostic control plane that keeps context cheap, preserves structured state, verifies work, and recovers from common agent failure modes instead of looping blindly. Adapt ag1 to your workflows, not the other way around, without having to fork and modify ag1 internals. Extend it with TypeScript [Extensions](#extensions), [Skills](#skills), [Prompt Templates](#prompt-templates), and [Themes](#themes). Put your extensions, skills, prompt templates, and themes in [AG1 Packages](#ag1-packages) and share them with others via npm or git.

AG1 ships with powerful defaults and keeps advanced workflows inspectable: autonomous runs use bounded budgets, structured run state, verification checks, and isolated workspaces. Some workflows remain intentionally extensible instead of hard-coded into core; you can build them with extensions or install a third party ag1 package that matches your process.

AG1 runs in four modes: interactive, print or JSON, RPC for process integration, and an SDK for embedding in your own apps. See [openclaw/openclaw](https://github.com/openclaw/openclaw) for a real-world SDK integration.

AG1 is under active hardening. It includes safety policies, path containment, compaction, and autonomous workspace isolation, but it is not a perfect sandbox. Run unattended work in an OS/container sandbox when the target repo or commands are untrusted.

## Share your OSS coding agent sessions

If you use ag1 for open source work, please share your coding agent sessions.

Public OSS session data helps improve models, prompts, tools, and evaluations using real development workflows.

For the full explanation, see [this post on X](https://x.com/badlogicgames/status/2037811643774652911).

To publish sessions, use [`badlogic/pods-share-hf`](https://github.com/badlogic/pods-share-hf). Read its README.md for setup instructions. All you need is a Hugging Face account, the Hugging Face CLI, and `ag1-share-hf`.

You can also watch [this video](https://x.com/badlogicgames/status/2041151967695634619), where I show how I publish my `ag1` sessions.

I regularly publish my own `ag1` work sessions here:

- [badlogicgames/pods-mono on Hugging Face](https://huggingface.co/datasets/badlogicgames/pods-mono)

## Table of Contents

- [Quick Start](#quick-start)
- [Providers & Models](#providers--models)
- [Interactive Mode](#interactive-mode)
  - [Editor](#editor)
  - [Commands](#commands)
  - [Keyboard Shortcuts](#keyboard-shortcuts)
  - [Message Queue](#message-queue)
- [Sessions](#sessions)
  - [Branching](#branching)
  - [Compaction](#compaction)
- [Settings](#settings)
- [Context Files](#context-files)
- [Customization](#customization)
  - [Prompt Templates](#prompt-templates)
  - [Skills](#skills)
  - [Extensions](#extensions)
  - [Themes](#themes)
  - [AG1 Packages](#ag1-packages)
- [Programmatic Usage](#programmatic-usage)
- [Philosophy](#philosophy)
- [CLI Reference](#cli-reference)

---

## Quick Start

```bash
npm install -g @ag1/coding-agent
```

Authenticate with an API key:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
ag1
```

Or use your existing subscription:

```bash
ag1
/login  # Then select provider
```

Then just talk to ag1. By default, ag1 gives the model four tools: `read`, `write`, `edit`, and `bash`. The model uses these to fulfill your requests. Add capabilities via [skills](#skills), [prompt templates](#prompt-templates), [extensions](#extensions), or [ag1 packages](#ag1-packages).

**Platform notes:** [Windows](docs/windows.md) | [Termux (Android)](docs/termux.md) | [tmux](docs/tmux.md) | [Terminal setup](docs/terminal-setup.md) | [Shell aliases](docs/shell-aliases.md)

---

## Providers & Models

For each built-in provider, ag1 maintains a list of tool-capable models, updated with every release. Authenticate via subscription (`/login`) or API key, then select any model from that provider via `/model` (or Ctrl+L).

**Subscriptions:**
- Anthropic Claude Pro/Max
- OpenAI ChatGPT Plus/Pro (Codex)
- GitHub Copilot
- Google Gemini CLI
- Google Antigravity

**API keys:**
- Anthropic
- OpenAI
- Azure OpenAI
- Google Gemini
- Google Vertex
- Amazon Bedrock
- Mistral
- Groq
- Cerebras
- xAI
- OpenRouter
- Vercel AI Gateway
- ZAI
- OpenCode Zen
- OpenCode Go
- Hugging Face
- Kimi For Coding
- MiniMax

See [docs/providers.md](docs/providers.md) for detailed setup instructions.

**Custom providers & models:** Add providers via `~/.ag1/agent/models.json` if they speak a supported API (OpenAI, Anthropic, Google). For custom APIs or OAuth, use extensions. See [docs/models.md](docs/models.md) and [docs/custom-provider.md](docs/custom-provider.md).

---

## Interactive Mode

<p align="center"><img src="docs/images/interactive-mode.png" alt="Interactive Mode" width="600"></p>

The interface from top to bottom:

- **Startup header** - Shows shortcuts (`/hotkeys` for all), loaded AGENTS.md files, prompt templates, skills, and extensions
- **Messages** - Your messages, assistant responses, tool calls and results, notifications, errors, and extension UI
- **Editor** - Where you type; border color indicates thinking level
- **Footer** - Working directory, session name, total token/cache usage, cost, context usage, current model

The editor can be temporarily replaced by other UI, like built-in `/settings` or custom UI from extensions (e.g., a Q&A tool that lets the user answer model questions in a structured format). [Extensions](#extensions) can also replace the editor, add widgets above/below it, a status line, custom footer, or overlays.

### Editor

| Feature | How |
|---------|-----|
| File reference | Type `@` to fuzzy-search project files |
| Path completion | Tab to complete paths |
| Multi-line | Shift+Enter (or Ctrl+Enter on Windows Terminal) |
| Images | Ctrl+V to paste (Alt+V on Windows), or drag onto terminal |
| Bash commands | `!command` runs and sends output to LLM, `!!command` runs without sending |

Standard editing keybindings for delete word, undo, etc. See [docs/keybindings.md](docs/keybindings.md).

### Commands

Type `/` in the editor to trigger commands. [Extensions](#extensions) can register custom commands, [skills](#skills) are available as `/skill:name`, and [prompt templates](#prompt-templates) expand via `/templatename`.

| Command | Description |
|---------|-------------|
| `/login`, `/logout` | OAuth authentication |
| `/model` | Switch models |
| `/scoped-models` | Enable/disable models for Ctrl+P cycling |
| `/settings` | Thinking level, theme, message delivery, transport |
| `/resume` | Pick from previous sessions |
| `/new` | Start a new session |
| `/name <name>` | Set session display name |
| `/session` | Show session info (path, tokens, cost) |
| `/tree` | Jump to any point in the session and continue from there |
| `/fork` | Create a new session from the current branch |
| `/compact [prompt]` | Manually compact context, optional custom instructions |
| `/copy` | Copy last assistant message to clipboard |
| `/export [file]` | Export session to HTML file |
| `/share` | Upload as private GitHub gist with shareable HTML link |
| `/reload` | Reload keybindings, extensions, skills, prompts, and context files (themes hot-reload automatically) |
| `/hotkeys` | Show all keyboard shortcuts |
| `/changelog` | Display version history |
| `/quit` | Quit ag1 |

### Keyboard Shortcuts

See `/hotkeys` for the full list. Customize via `~/.ag1/agent/keybindings.json`. See [docs/keybindings.md](docs/keybindings.md).

**Commonly used:**

| Key | Action |
|-----|--------|
| Ctrl+C | Clear editor |
| Ctrl+C twice | Quit |
| Escape | Cancel/abort |
| Escape twice | Open `/tree` |
| Ctrl+L | Open model selector |
| Ctrl+P / Shift+Ctrl+P | Cycle scoped models forward/backward |
| Shift+Tab | Cycle thinking level |
| Ctrl+O | Collapse/expand tool output |
| Ctrl+T | Collapse/expand thinking blocks |

### Message Queue

Submit messages while the agent is working:

- **Enter** queues a *steering* message, delivered after the current assistant turn finishes executing its tool calls
- **Alt+Enter** queues a *follow-up* message, delivered only after the agent finishes all work
- **Escape** aborts and restores queued messages to editor
- **Alt+Up** retrieves queued messages back to editor

On Windows Terminal, `Alt+Enter` is fullscreen by default. Remap it in [docs/terminal-setup.md](docs/terminal-setup.md) so ag1 can receive the follow-up shortcut.

Configure delivery in [settings](docs/settings.md): `steeringMode` and `followUpMode` can be `"one-at-a-time"` (default, waits for response) or `"all"` (delivers all queued at once). `transport` selects provider transport preference (`"sse"`, `"websocket"`, or `"auto"`) for providers that support multiple transports.

---

## Sessions

Sessions are stored as JSONL files with a tree structure. Each entry has an `id` and `parentId`, enabling in-place branching without creating new files. See [docs/session.md](docs/session.md) for file format.

### Management

Sessions auto-save to `~/.ag1/agent/sessions/` organized by working directory.

```bash
ag1 -c                  # Continue most recent session
ag1 -r                  # Browse and select from past sessions
ag1 --no-session        # Ephemeral mode (don't save)
ag1 --session <path>    # Use specific session file or ID
ag1 --fork <path>       # Fork specific session file or ID into a new session
```

### Branching

**`/tree`** - Navigate the session tree in-place. Select any previous point, continue from there, and switch between branches. All history preserved in a single file.

<p align="center"><img src="docs/images/tree-view.png" alt="Tree View" width="600"></p>

- Search by typing, fold/unfold and jump between branches with Ctrl+←/Ctrl+→ or Alt+←/Alt+→, page with ←/→
- Filter modes (Ctrl+O): default → no-tools → user-only → labeled-only → all
- Press Shift+L to label entries as bookmarks and Shift+T to toggle label timestamps

**`/fork`** - Create a new session file from the current branch. Opens a selector, copies history up to the selected point, and places that message in the editor for modification.

**`--fork <path|id>`** - Fork an existing session file or partial session UUID directly from the CLI. This copies the full source session into a new session file in the current project.

### Compaction

Long sessions can exhaust context windows. Compaction summarizes older messages while keeping recent ones.

**Manual:** `/compact` or `/compact <custom instructions>`

**Automatic:** Enabled by default. Triggers on context overflow (recovers and retries) or when approaching the limit (proactive). Configure via `/settings` or `settings.json`.

Compaction is lossy. The full history remains in the JSONL file; use `/tree` to revisit. Customize compaction behavior via [extensions](#extensions). See [docs/compaction.md](docs/compaction.md) for internals.

---

## Settings

Use `/settings` to modify common options, or edit JSON files directly:

| Location | Scope |
|----------|-------|
| `~/.ag1/agent/settings.json` | Global (all projects) |
| `.ag1/settings.json` | Project (overrides global) |

See [docs/settings.md](docs/settings.md) for all options.

---

## Context Files

AG1 loads `AGENTS.md` (or `CLAUDE.md`) at startup from:
- `~/.ag1/agent/AGENTS.md` (global)
- Parent directories (walking up from cwd)
- Current directory

Use for project instructions, conventions, common commands. All matching files are concatenated.

### System Prompt

Replace the default system prompt with `.ag1/SYSTEM.md` (project) or `~/.ag1/agent/SYSTEM.md` (global). Append without replacing via `APPEND_SYSTEM.md`.

---

## Customization

### Prompt Templates

Reusable prompts as Markdown files. Type `/name` to expand.

```markdown
<!-- ~/.ag1/agent/prompts/review.md -->
Review this code for bugs, security issues, and performance problems.
Focus on: {{focus}}
```

Place in `~/.ag1/agent/prompts/`, `.ag1/prompts/`, or a [ag1 package](#ag1-packages) to share with others. See [docs/prompt-templates.md](docs/prompt-templates.md).

### Skills

On-demand capability packages following the [Agent Skills standard](https://agentskills.io). Invoke via `/skill:name` or let the agent load them automatically.

```markdown
<!-- ~/.ag1/agent/skills/my-skill/SKILL.md -->
# My Skill
Use this skill when the user asks about X.

## Steps
1. Do this
2. Then that
```

Place in `~/.ag1/agent/skills/`, `~/.agents/skills/`, `.ag1/skills/`, or `.agents/skills/` (from `cwd` up through parent directories) or a [ag1 package](#ag1-packages) to share with others. See [docs/skills.md](docs/skills.md).

### Extensions

<p align="center"><img src="docs/images/doom-extension.png" alt="Doom Extension" width="600"></p>

TypeScript modules that extend ag1 with custom tools, commands, keyboard shortcuts, event handlers, and UI components.

```typescript
export default function (ag1: ExtensionAPI) {
  ag1.registerTool({ name: "deploy", ... });
  ag1.registerCommand("stats", { ... });
  ag1.on("tool_call", async (event, ctx) => { ... });
}
```

**What's possible:**
- Custom tools (or replace built-in tools entirely)
- Sub-agents and plan mode
- Custom compaction and summarization
- Permission gates and path protection
- Custom editors and UI components
- Status lines, headers, footers
- Git checkpointing and auto-commit
- SSH and sandbox execution
- MCP server integration
- Make ag1 look like Claude Code
- Games while waiting (yes, Doom runs)
- ...anything you can dream up

Place in `~/.ag1/agent/extensions/`, `.ag1/extensions/`, or a [ag1 package](#ag1-packages) to share with others. See [docs/extensions.md](docs/extensions.md) and [examples/extensions/](examples/extensions/).

### Themes

Built-in: `dark`, `light`. Themes hot-reload: modify the active theme file and ag1 immediately applies changes.

Place in `~/.ag1/agent/themes/`, `.ag1/themes/`, or a [ag1 package](#ag1-packages) to share with others. See [docs/themes.md](docs/themes.md).

### AG1 Packages

Bundle and share extensions, skills, prompts, and themes via npm or git. Find packages on [npmjs.com](https://www.npmjs.com/search?q=keywords%3Api-package) or [Discord](https://discord.com/channels/1456806362351669492/1457744485428629628).

> **Security:** AG1 packages run with full system access. Extensions execute arbitrary code, and skills can instruct the model to perform any action including running executables. Review source code before installing third-party packages.

```bash
ag1 install npm:@foo/pods-tools
ag1 install npm:@foo/pods-tools@1.2.3      # pinned version
ag1 install git:github.com/user/repo
ag1 install git:github.com/user/repo@v1  # tag or commit
ag1 install git:git@github.com:user/repo
ag1 install git:git@github.com:user/repo@v1  # tag or commit
ag1 install https://github.com/user/repo
ag1 install https://github.com/user/repo@v1      # tag or commit
ag1 install ssh://git@github.com/user/repo
ag1 install ssh://git@github.com/user/repo@v1    # tag or commit
ag1 remove npm:@foo/pods-tools
ag1 uninstall npm:@foo/pods-tools          # alias for remove
ag1 list
ag1 update                               # skips pinned packages
ag1 config                               # enable/disable extensions, skills, prompts, themes
```

Packages install to `~/.ag1/agent/git/` (git) or global npm. Use `-l` for project-local installs (`.ag1/git/`, `.ag1/npm/`). If you use a Node version manager and want package installs to reuse a stable npm context, set `npmCommand` in `settings.json`, for example `["mise", "exec", "node@20", "--", "npm"]`.

Create a package by adding a `ag1` key to `package.json`:

```json
{
  "name": "my-ag1-package",
  "keywords": ["ag1-package"],
  "ag1": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

Without a `ag1` manifest, ag1 auto-discovers from conventional directories (`extensions/`, `skills/`, `prompts/`, `themes/`).

See [docs/packages.md](docs/packages.md).

---

## Programmatic Usage

### SDK

```typescript
import { AuthStorage, createAgentSession, ModelRegistry, SessionManager } from "@ag1/coding-agent";

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);
const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  authStorage,
  modelRegistry,
});

await session.prompt("What files are in the current directory?");
```

For advanced multi-session runtime replacement, use `createAgentSessionRuntime()` and `AgentSessionRuntime`.

See [docs/sdk.md](docs/sdk.md) and [examples/sdk/](examples/sdk/).

### RPC Mode

For non-Node.js integrations, use RPC mode over stdin/stdout:

```bash
ag1 --mode rpc
```

RPC mode uses strict LF-delimited JSONL framing. Clients must split records on `\n` only. Do not use generic line readers like Node `readline`, which also split on Unicode separators inside JSON payloads.

See [docs/rpc.md](docs/rpc.md) for the protocol.

---

## Philosophy

AG1 is aggressively extensible so it doesn't have to dictate your workflow. Features that other tools bake in can be built with [extensions](#extensions), [skills](#skills), or installed from third-party [ag1 packages](#ag1-packages). This keeps the core minimal while letting you shape ag1 to fit how you work.

**No MCP.** Build CLI tools with READMEs (see [Skills](#skills)), or build an extension that adds MCP support. [Why?](https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/)

**No sub-agents.** There's many ways to do this. Spawn ag1 instances via tmux, use `--auto` mode which includes the `Agent` tool, or build your own with [extensions](#extensions), or install a package that does it your way.

**No permission popups.** Run in a container, or build your own confirmation flow with [extensions](#extensions) inline with your environment and security requirements.

**No plan mode.** Write plans to files, use `--auto` mode which auto-generates and executes plans, or build it with [extensions](#extensions), or install a package.

**No built-in to-dos.** They confuse models. Use a TODO.md file, or build your own with [extensions](#extensions).

**No background bash.** Use tmux. Full observability, direct interaction.

Read the [blog post](https://mariozechner.at/posts/2025-11-30-ag1-coding-agent/) for the full rationale.

---

## CLI Reference

```bash
ag1 [options] [@files...] [messages...]
```

### Package Commands

```bash
ag1 install <source> [-l]     # Install package, -l for project-local
ag1 remove <source> [-l]      # Remove package
ag1 uninstall <source> [-l]   # Alias for remove
ag1 update [source]           # Update packages (skips pinned)
ag1 list                      # List installed packages
ag1 config                    # Enable/disable package resources
```

### Modes

| Flag | Description |
|------|-------------|
| (default) | Interactive mode |
| `-p`, `--print` | Print response and exit |
| `--mode json` | Output all events as JSON lines (see [docs/json.md](docs/json.md)) |
| `--mode rpc` | RPC mode for process integration (see [docs/rpc.md](docs/rpc.md)) |
| `--export <in> [out]` | Export session to HTML |

In print mode, ag1 also reads piped stdin and merges it into the initial prompt:

```bash
cat README.md | ag1 -p "Summarize this text"
```

### Model Options

| Option | Description |
|--------|-------------|
| `--provider <name>` | Provider (anthropic, openai, google, etc.) |
| `--model <pattern>` | Model pattern or ID (supports `provider/id` and optional `:<thinking>`) |
| `--api-key <key>` | API key (overrides env vars) |
| `--thinking <level>` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` |
| `--models <patterns>` | Comma-separated patterns for Ctrl+P cycling |
| `--list-models [search]` | List available models |

### Session Options

| Option | Description |
|--------|-------------|
| `-c`, `--continue` | Continue most recent session |
| `-r`, `--resume` | Browse and select session |
| `--session <path>` | Use specific session file or partial UUID |
| `--fork <path>` | Fork specific session file or partial UUID into a new session |
| `--session-dir <dir>` | Custom session storage directory |
| `--no-session` | Ephemeral mode (don't save) |

### Tool Options

| Option | Description |
|--------|-------------|
| `--tools <list>` | Enable specific built-in tools (default: `read,bash,edit,write`) |
| `--no-tools` | Disable all built-in tools (extension tools still work) |

Available built-in tools: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`

### Resource Options

| Option | Description |
|--------|-------------|
| `-e`, `--extension <source>` | Load extension from path, npm, or git (repeatable) |
| `--no-extensions` | Disable extension discovery |
| `--skill <path>` | Load skill (repeatable) |
| `--no-skills` | Disable skill discovery |
| `--prompt-template <path>` | Load prompt template (repeatable) |
| `--no-prompt-templates` | Disable prompt template discovery |
| `--theme <path>` | Load theme (repeatable) |
| `--no-themes` | Disable theme discovery |

Combine `--no-*` with explicit flags to load exactly what you need, ignoring settings.json (e.g., `--no-extensions -e ./my-ext.ts`).

### Autonomous Mode

Unattended execution with PLAN → EXECUTE → VERIFY → REPORT loop.

| Option | Description |
|--------|-------------|
| `--auto` | Enable autonomous mode |
| `--max-cost <amount>` | Maximum cost in USD (`0` = unlimited) |
| `--max-tokens <count>` | Maximum tokens (`0` = unlimited) |
| `--max-turns <count>` | Maximum turns (`0` = unlimited) |
| `--enable-nudges` | Enable nudge engine (default: on in autonomous mode) |
| `--enable-behavioral-prompt` | Append behavioral system prompt (default: on in autonomous mode)

Autonomous mode ships with 10 built-in tools: `Verify`, `LSP`, `WebSearch`, `WebFetch`, `NotebookEdit`, `GitWorktree`, `TaskManager`, `TodoWrite`, `Skill`, and `Agent`.

> **Budget safety:** `--max-cost`, `--max-tokens`, and `--max-turns` act as hard stop conditions. At least one is recommended for unattended runs.

### Other Options

| Option | Description |
|--------|-------------|
| `--system-prompt <text>` | Replace default prompt (context files and skills still appended) |
| `--append-system-prompt <text>` | Append to system prompt |
| `--verbose` | Force verbose startup |
| `-h`, `--help` | Show help |
| `-v`, `--version` | Show version |

### File Arguments

Prefix files with `@` to include in the message:

```bash
ag1 @prompt.md "Answer this"
ag1 -p @screenshot.png "What's in this image?"
ag1 @code.ts @test.ts "Review these files"
```

### Examples

```bash
# Interactive with initial prompt
ag1 "List all .ts files in src/"

# Non-interactive
ag1 -p "Summarize this codebase"

# Non-interactive with piped stdin
cat README.md | ag1 -p "Summarize this text"

# Different model
ag1 --provider openai --model gpt-4o "Help me refactor"

# Model with provider prefix (no --provider needed)
ag1 --model openai/gpt-4o "Help me refactor"

# Model with thinking level shorthand
ag1 --model sonnet:high "Solve this complex problem"

# Limit model cycling
ag1 --models "claude-*,gpt-4o"

# Read-only mode
ag1 --tools read,grep,find,ls -p "Review the code"

# High thinking level
ag1 --thinking high "Solve this complex problem"

# Autonomous mode (unattended execution)
ag1 --auto "Fix all test failures in the project"
ag1 --auto "Add error handling to the API endpoints" --max-cost 5.0
ag1 --auto "Refactor the authentication module" --max-turns 50
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `AG1_CODING_AGENT_DIR` | Override config directory (default: `~/.ag1/agent`) |
| `AG1_PACKAGE_DIR` | Override package directory (useful for Nix/Guix where store paths tokenize poorly) |
| `AG1_SKIP_VERSION_CHECK` | Skip version check at startup |
| `AG1_CACHE_RETENTION` | Set to `long` for extended prompt cache (Anthropic: 1h, OpenAI: 24h) |
| `VISUAL`, `EDITOR` | External editor for Ctrl+G |

---

## Contributing & Development

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for guidelines and [docs/development.md](docs/development.md) for setup, forking, and debugging.

---

## License

MIT

## See Also

- [@ag1/ai](https://www.npmjs.com/package/@ag1/ai): Core LLM toolkit
- [@ag1/pods-agent](https://www.npmjs.com/package/@ag1/pods-agent): Agent framework
- [@ag1/tui](https://www.npmjs.com/package/@ag1/tui): Terminal UI components
