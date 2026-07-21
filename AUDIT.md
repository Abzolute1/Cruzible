# AG1 Codebase Audit — 2026-07-17

Full-file audit of all 7 packages (~140k lines TS). Main call paths traced (`AgentSession.prompt()` → prompt coordinator → agent loop → tool execution → event loop → persistence; Slack event → mom runner → sandbox exec; RPC stdin → command dispatch). All Critical findings verified first-hand against cited lines.

Status legend: `[x]` fixed · `[~]` deferred/won't-fix (reason noted). All items triaged in the 2026-07-17 resolution pass — see the Resolution section at the end for verification results and deferrals.

## What's genuinely good

- `packages/coding-agent/src/core/tools/path-utils.ts:112-148` (`resolveContainedPath`) — real containment: realpath both ends, per-component symlink rejection, nearest-existing-ancestor walk. Used by read/write/edit/grep/find/ls.
- `core/tools/file-mutation-transaction.ts` + `file-mutation-queue.ts` — atomic temp→fsync→rename writes, serialized per-file.
- `packages/agent/src/agent-loop.ts:472-522` (`prepareToolCall`) — all tool-validation/beforeToolCall failures become error tool results fed back to the model; never crash the run.
- `packages/agent` two-layer design — pure-function loop vs stateful wrapper; `StreamFn` "never throw" contract documented at the type (`types.ts:18-23`).
- `core/agent-session-continue-replay.ts` + `recovery-arbiter.ts` — snapshot-guarded delayed `continue()` replay; single-arm arbiter for retry+compaction.
- `packages/ai/src/providers/transform-messages.ts` — single owner for orphaned tool calls / thinking-block downgrades across 12 providers.
- `packages/ai/src/utils/sanitize-unicode.ts` — paired-surrogate-aware fix applied at every provider boundary.
- `core/auth-storage.ts` — `0o700`/`0o600`, re-chmod per write, proper lockfile; no keys in logs/session files.
- `core/tools/webfetch.ts:102-131` — manual redirects with per-hop URL revalidation + private-range DNS blocklist.
- `packages/tui/src/stdin-buffer.ts` — real incremental escape-sequence tokenizer (CSI/OSC/DCS/APC/SS3) with remainder buffering.
- `packages/tui/src/keys.ts:666-679` — mode-aware Kitty disambiguation with Dvorak/Colemak false-match guard.
- `packages/web-ui/src/components/sandbox/SandboxedIframe.ts:210,399` — `allow-scripts` without `allow-same-origin`; `JSON.stringify` + `</script` escaping in runtime script.
- `packages/mom/src/tools/truncate.ts` — byte/line-aware truncation with UTF-8 continuation boundaries.
- `packages/pods/src/ssh.ts` — argv arrays, no shell interpolation locally.
- `core/safety-policy.ts` — pure decision function, fail-closed, enforced below the UI via `agent.beforeToolCall`.

## Critical

### C1. Persistence failure silently swallowed → permanent session data loss `[x]`
- `packages/coding-agent/src/core/session-manager.ts:906-911` — `_appendEntry` mutates `fileEntries`/`byId`/`leafId` **before** `_persist()`; if `_rewriteFile()` throws (lock timeout, disk full, `JSON.stringify` on extension `details` with BigInt/circular refs), memory diverges from disk and every subsequent append also throws.
- Throw is swallowed by `.catch(() => {})` at `agent-session-event-loop-coordinator.ts:52`.
- **Fix:** validate serializability at append boundary before mutating; mutate state only after successful persist (or roll back); replace blanket catch with `console.error` + surfaced `persistence_error` event.

### C2. Every append rewrites + re-reads the whole session file, synchronously — O(n²) blocking I/O `[x]`
- `session-manager.ts:901-904` — `_persist(_entry)` ignores its arg, calls `_rewriteFile()` → `mergeEntriesForSessionRewrite` re-reads/parses whole file from disk per `message_end`, inside the serialized event loop.
- **Fix:** common path = true `appendFileSync` of the single entry line under the lock; full rewrite+merge only for migration/branch ops.

### C3. `agentLoop()`/`agentLoopContinue()`: rejection → unhandled + stream never terminates `[x]`
- `packages/agent/src/agent-loop.ts:40-51, 80-90` — `.then(...)` without `.catch()`: unhandled rejection (process crash) + no `agent_end` → consumers hang forever.
- **Fix:** `.catch` that pushes terminal event + ends stream.

### C4. `streamProxy`: premature close hangs the run forever `[x]`
- `packages/agent/src/proxy.ts:156-186` — server closes SSE without `done`/`error` → `stream.end()` with no result; `EventStream.end()` only resolves with an argument → `result()` pends forever; abort can't rescue.
- **Fix:** track terminal-event receipt; if none, push `error` event before `stream.end(partial)`.

### C5. Partial-JSON recovery used for FINAL tool-call args → truncated commands execute `[x]`
- `packages/ai/src/utils/json-parse.ts` `parseStreamingJson` is final parse at: `anthropic.ts:350,386`, `amazon-bedrock.ts:349,415`, `openai-completions.ts:223,384`, `openai-responses-shared.ts:401,413,453`, `mistral.ts:411,426`. Silently closes open strings.
- **Fix:** strict `JSON.parse` at finalization; on failure mark tool call (`malformedArguments`) so agent layer refuses execution.

### C6. PKCE `code_verifier` reused as OAuth `state` `[x]`
- `packages/ai/src/utils/oauth/anthropic.ts:237,252`; `google-gemini-cli.ts:434`; `google-antigravity.ts:292`. Verifier exposed in redirect URL alongside `code` → PKCE nullified.
- **Fix:** independent random `state` (as `openai-codex.ts:42-47`); verifier stays private.

### C7. OAuth token responses logged → live tokens in logs `[x]`
- `packages/ai/src/utils/oauth/openai-codex.ts:110,121,147,158`; `anthropic.ts:216,370` embeds raw token-response body in Error.
- **Fix:** log key names only, never payloads.

### C8. Gemini CLI + Antigravity OAuth dead — placeholder credentials `[x]`
- `packages/ai/src/utils/oauth/google-gemini-cli.ts:26-27`, `google-antigravity.ts:27-28` — `PLACEHOLDER_CLIENT_ID/SECRET` since initial commit; login can never succeed.
- **Fix (chosen):** fail fast at login start with "provider not configured" (real credentials are a product/infra decision). `[~]`

### C9. Retry loops retry deliberately-terminal errors `[x]`
- `packages/ai/src/providers/google-gemini-cli.ts:449-468` — terminal `throw` caught by own `catch` → 400/401 retried 3× with backoff; defeats `maxRetryDelayMs` surfacing. `openai-codex-responses.ts:227-241` same, gated on literal substring `"usage limit"`.
- **Fix:** rethrow terminal errors from catch (flag/classify); delete substring heuristic.

### C10. mom attach: path traversal → host file exfiltration into Slack `[x]`
- `packages/mom/src/agent.ts:866-882` + `tools/attach.ts:37-40` — no `..` rejection; `/workspace/C123/../../../home/...` read on host even in docker mode. Exfiltrates `~/.ag1/mom/auth.json`.
- **Fix:** `resolve()` + `startsWith(resolve(channelDir)+sep)` check; enforce in attach.ts too.

### C11. web-ui: model SVG injected raw → XSS → API-key theft `[x]`
- `packages/web-ui/src/tools/artifacts/SvgArtifact.ts:62` — `unsafeHTML(content)` in main-page light DOM; keys live in IndexedDB.
- **Fix:** DOMPurify (SVG profile) or blob-URL `<img>` or sandboxed iframe.

### C12. TUI: no control-char sanitization in render pipeline → terminal escape injection `[x]`
- `packages/tui/src/components/text.ts:45-105`, `markdown.ts`, `utils.ts:520,613` — OSC 52 (clipboard), OSC 8 (link spoofing) preserved; fed model output (`assistant-message.ts:81`) and web snippets (`websearch.ts:1006`).
- Contributing: model-invoked bash output raw (`coding-agent/core/tools/bash.ts:353-385`) vs user `!` path sanitized (`bash-executor.ts:111`).
- **Fix:** central `sanitizeTerminalText()` (strip C0/C1 except `\n`, SGR-only allowlist) at component boundary; sanitize in bash tool path too.

### C13. TUI: bracketed-paste deadlock — unterminated paste eats all input forever `[x]`
- `packages/tui/src/stdin-buffer.ts:283-302` (+ `editor.ts:557-574`, `input.ts:60-83`) — no timeout/cap/escape; unbounded memory.
- **Fix:** timeout in pasteMode → flush as normal data; cap buffer.

### C14. TUI: autocomplete chain permanently poisoned by one provider error `[x]`
- `packages/tui/src/editor.ts:2087-2108` — rejected predecessor poisons all later requests; `void` call sites → unhandled rejections.
- **Fix:** try/catch around `await previousTask` + request body; `.catch` at call sites.

## Significant

### State / architecture
- **S1.** Retry removes failed message from live state but it's persisted → reappears on resume (`agent-session-retry-coordinator.ts:146-153`); micro-compact mutates live messages while compaction summarizes from file (`agent-session-compaction-coordinator.ts:263-289,302-303`). Fix: file = source of truth, or persist retraction entries. `[x]` retry path — fixed via branch-to-parent + rebuild from file (failed entry remains as abandoned branch). `[~]` microCompact/snipHistory persistence — deferred: genuinely needs entry-level context editing (entries are append-only, no entry↔message mapping); TODO documented in `agent-session-compaction-coordinator.ts`.
- **S2.** Run-level failures never persisted + unbalanced lifecycle (`packages/agent/src/agent.ts:459-474` — no `message_start/end`, no `turn_end`, empty assistant message left in transcript). `[x]`
- **S3.** `navigateTree` no streaming guard (`agent-session-tree-coordinator.ts:38-197`) → tree parentage corruption mid-run. `[x]`
- **S4.** Manual `compact()` no concurrency guard; `isCompacting` never checked (`agent-session-compaction-coordinator.ts:92-96`). `[x]`
- **S5.** Fork/resume without draining event queue → loses tail messages (`agent-session-runtime.ts:240-245`). `[x]`
- **S6.** Session lock = blocking main-thread spin up to 30s then throws into swallowed path; stale-lock force-remove race (`session-manager.ts:219-253`). `[x]`
- **S7.** Parallel tool results out of source order when immediate outcomes mixed (`agent-loop.ts:398-437`; contract at `types.ts:33`). `[x]`
- **S8.** No abort checks in `runLoop` (`agent-loop.ts:168-229`); no `maxTurns` circuit breaker. `[x]`
- **S9.** `state.messages` getter returns live array (`agent.ts:74-85`); web-ui `ArtifactsRuntimeProvider.ts:175-182` pushes into it directly, bypassing events/persistence. `[x]`
- **S10.** Listener exceptions not isolated: `agent.ts:535-537` (kills runs; corrupts tool results via `agent-loop.ts:550-558`), `extensions/runner.ts:669-690` `emitToolCall`, TUI dispatch `tui.ts:563-570,902`. `[x]`
- **S11.** `reset()` no active-run guard (`agent.ts:299-307`). `[x]`
- **S12.** Bash coordinator races: single `bashAbortController` overwritten (`agent-session-bash-coordinator.ts:33-53`); `pendingBashMessages` never persisted if no next turn; RPC fires `void handleInputLine` unserialized (`rpc-mode.ts:683`). `[x]`

### Security
- **S13.** Project extensions auto-execute, no trust gate (`extensions/loader.ts:530-536`, jiti in-process, API exposes `exec`/`setActiveTools`; handlers run before safety policy). Fix: workspace-trust prompt; skip in print/rpc/autonomous unless trusted. `[x]`
- **S14.** Git package path traversal → `rmSync` arbitrary dir (`utils/git.ts:82-85`, `package-manager.ts:1732-1740,1649-1654`; also `npm:../../x`). `[x]`
- **S15.** XML fallback executes text-parsed tool calls; drops extension `{block}` (`xml-coordinator.ts:138-146`); `tool.execute(..., undefined)` signal (`:183`); autonomous bash auto-allow (`safety-policy.ts:309-311`) → prompt-injection→RCE. `[x]`
- **S16.** `OPENAI_API_KEY` fallback sent to arbitrary providers/URLs (`openai-completions.ts:473-484`, `openai-responses.ts:155-162`, `azure-openai-responses.ts:182-189`). `[x]`
- **S17.** web-ui markdown → `javascript:` links survive (mini-lit `MarkdownBlock`: regex-escape → marked → `unsafeHTML`; generated HTML never sanitized). Fix: DOMPurify wrapper consumer-side. `[x]` — fixed consumer-side via new `SafeMarkdownBlock` wrapper (MutationObserver + scheme allowlist, no new dependency); upstream mini-lit `MarkdownBlock` remains unsanitized for other consumers — worth an upstream patch.
- **S18.** web-ui sandbox router: no `e.source`/`origin` check (`RuntimeMessageRouter.ts:126-161`); predictable sandboxIds; `readWrite:false` unenforced (`ArtifactsRuntimeProvider.ts:139-215`); `window.open` no `noopener`; all attachments base64-injected into network-capable sandbox (`SandboxedIframe.ts:557-562`). `[x]`
- **S19.** Shell containment regexes leaky: `<`/`>` redirect bypass, `$VAR`, `$(...)`, `cd` bypass (`safety-policy.ts:190-230`); forbidden-rules evaded (`s""udo`, `${IFS}`). Fix: add `<>`+`cd` checks, document best-effort, default sandbox template for autonomous. `[x]` — `<>` boundary, `cd` check, `/dev/null` allowance, best-effort docs, unmissable truncation marker all landed; NOT done: shipping a default `AG1_BASH_SANDBOX_COMMAND` template for autonomous mode (remains opt-in — product decision).
- **S20.** pods secrets in `ps`/`.bashrc`/logs (`pods.ts:112-118`, `pod_setup.sh:308-310`, `model_run.sh:55,61`, `models.ts:373,378`); cleartext HTTP + static bearer. `[x]`
- **S21.** mom default sandbox = `host` (`main.ts:27`); channel chatter synced into context without mention. `[x]`
- **S22.** RPC mode: no input validation (`rpc-mode.ts:661` cast); session teardown mid-stream; `process.chdir()` global mutation. Fix: schema validation, serialize mutations, reject switch while streaming. `[x]`
- **S23.** Model-generator code injection (`packages/ai/scripts/generate-models.ts:1578-1607` — network data interpolated raw into shipped file). Fix: `JSON.stringify` all strings. `[x]`
- **S24.** `packages/ai/src/cli.ts:8,24-26` — `auth.json` world-readable in CWD, non-atomic. `[x]`
- **S25.** OAuth refresh race, no dedup (`utils/oauth/index.ts:137-162`); cause discarded. `[x]`
- **S26.** webfetch SSRF: IPv4-mapped IPv6 not blocked; DNS-rebinding TOCTOU (`webfetch.ts:88-99,119,281`). `[x]`
- **S27.** `--api-key` in argv (`cli/args.ts:106-107`); unknown-flag parser eats first prompt word (`args.ts:240-245`). `[x]`

### Fragile logic / error handling
- **S28.** Safety refusals flattened to "An unknown error occurred" (8 sites: `anthropic.ts:425-427`, `google.ts:255-257`, `google-vertex.ts:269-271`, `google-gemini-cli.ts:786-788`, `amazon-bedrock.ts:205-207`, `openai-responses.ts:112-114`, `azure-openai-responses.ts:105-107`, `mistral.ts:85-87`). Pattern to copy: `openai-completions.ts:915-939`. `[x]`
- **S29.** `transform-messages.ts:100-169` trailing orphaned tool calls never flushed → provider 400 on crash-mid-turn histories. `[x]`
- **S30.** `forwardStream` no catch (`register-builtins.ts:138-145`) → unhandled rejection + hang. `[x]`
- **S31.** mom silent-truncation cluster: unbounded image reads (`agent.ts:757`, `read.ts:53-57`), 10MB stdout cap corrupts base64 (`sandbox.ts:141-143`), `edit.ts:109,143` corrupts >10MB files, unbounded attachment download racing the run (`store.ts:188-233`). `[x]`
- **S32.** mom module-global `uploadFn` cross-channel race (`tools/attach.ts:6-10`, `agent.ts:678-681`). `[x]`
- **S33.** `pods stop` orphans vLLM — wrong kill target in setsid tree (`models.ts:432-437`). `[x]`
- **S34.** mom events: arbitrary `channelId` (`events.ts:336-342`); invalid dates fire immediately (`:279-298`). `[x]`
- **S35.** TUI `doRender` throws on width overflow → process crash; crash log contains full session (`tui.ts:1102-1129`). `[x]`
- **S36.** TUI scrollback wiped on every resize (`tui.ts:918`, `\x1b[3J`). `[x]`
- **S37.** TUI `setTitle` OSC injection (`terminal.ts:356-359`). `[x]`
- **S38.** WS session cache races (`openai-codex-responses.ts:522,588-662,717`). `[x]`
- **S39.** Anthropic OAuth accepts malformed 200 → persists `{refresh: undefined, expires: NaN}` (`anthropic.ts:211-224,361-378`). `[x]`
- **S40.** Print-mode turn completion = 150ms idle timer; `.catch(() => {})` swarm (`print-mode.ts:50,217-224,282,532,558-560`). `[x]`
- **S41.** pods startup detection: log-regex wait, no timeout (`models.ts:300-340`). `[x]`

## Minor

- `EMPTY_USAGE` shared mutable constant (`agent.ts:33`).
- Hand-rolled SSE parsing (`proxy.ts:165-179`): `"data: "` space-only, one bad line kills stream, no final flush.
- Shallow event snapshots alias live content (`agent-loop.ts:282,300`).
- AJV: `coerceTypes:true`; `compile` per call, no cache; `new Function` per call; validation error embeds full tool args (secret leakage into logs) (`ai/validation.ts:33,66,71,90`).
- `isOAuthToken` `.includes` → `startsWith` (`anthropic.ts:518-520`).
- `google-vertex.ts:327-348` ignores `model.baseUrl`.
- `overflow.ts`: "too many tokens per minute" misclassified as context overflow.
- `anthropic.ts:617` magic `maxTokens/3` default.
- `env-api-keys.ts:30-56` ADC check cached forever; `"<authenticated>"` sentinel through apiKey channel.
- OAuth fetch timeouts missing (codex/gemini-cli/antigravity/copilot); `loginAnthropic` ignores `callbacks.signal`.
- JWT decode without base64url normalization (`openai-codex-responses.ts:856-867`, `oauth/openai-codex.ts:79-89`).
- `openai-codex.ts:129` no 5-min expiry skew buffer.
- `sleep()` retry listeners never removed (`openai-codex-responses.ts:92-104`, `google-gemini-cli.ts:251-263`).
- `transform-messages.ts` tool-call ID collision merge (promote mistral hasher pattern `mistral.ts:144-174`).
- `mistral.ts:379` literal `"null"` treated as missing ID.
- Base64-obfuscated public client IDs (`anthropic.ts:27-28`, `github-copilot.ts:13-14`).
- settings-manager: read-before-lock TOCTOU (`:182-210`); no schema validation (`:316-328`); non-atomic writes (also `auth-storage.ts:100,145`).
- `bash.ts:349` temp stream no `'error'` listener; `tempFileStream.end()` not awaited; `:433` `exitCode===null` treated as success.
- `safety-policy.ts:157,319` approval shows 600/800 trimmed chars, executes full command.
- `utils/shell.ts:182-188` Windows `taskkill` no error listener.
- SessionManager: quarantine orphan file + silent id change (`:790-798`); `create()`+`newSession` double-create (`agent-session-runtime.ts:181-184,227-228`); vacuous migration id check (`:258-268`); no per-entry parse validation (`:490-516`); `open()` EISDIR uncaught (`:495`).
- `prompt()` resets web-research budget when only queued (`agent-session.ts:1567-1568`).
- Compaction auto-continue failure dropped (`recovery-replay-scheduler.ts:64-66`).
- `tree-coordinator.ts:78,114` leaks `branchSummaryAbortController` on error.
- `path-utils.ts:115` `allowMissing` accepted, never read.
- Extension loader: manifest parse failures silently disable packages (`loader.ts:414-417`).
- TUI: unbounded undo stack/kill ring; `Input.handlePaste` no control-char filter (`input.ts:418-428`); Kitty timer outlives `stop()` (`terminal.ts:188-193`); `SettingsList` strips all spaces (`:190`); `readdirSync`/`statSync` per keystroke (`autocomplete.ts:527,596`); `logRedraw` ENOENT when dir missing (`tui.ts:946`); theme-coupled regex `markdown.ts:539,552`; write-only `_lastEventType` (`keys.ts:515`); `\x1bb` double-booked `alt+left`/`alt+b` (`keys.ts:471-475,1137-1140`); newline heuristic `editor.ts:714`; paste-marker spoofing `editor.ts:907-914`; `editor.ts:2132` live `lines` to providers; `loader.ts:21,30-33` ref'd interval; astral chars split across data events (`stdin-buffer.ts:218`).
- web-ui: editor cleared before send (`AgentInterface.ts:246-261,371-373`); `auth-token.ts:8-16` infinite prompt loop; 1.5s fixed wait (`artifacts.ts:445-452`); unbounded console logs (`HtmlArtifact.ts:110-117`); `runtime-response` `targetOrigin:"*"` (`RuntimeMessageRouter.ts:137-146`); `apiKey.startsWith("{")` (`proxy-utils.ts:28`); `marked.use` per render (mini-lit); `SandboxedIframe.ts:341-345` no cleanup on validation-fail; `:320-332` stale 30s comment; artifact reconstruction divergence (`artifacts.ts:367-375,401-403`); unsandboxed error iframe + dead `validateHtml` (`SandboxedIframe.ts:110-120,415-430`); IDB transaction completion unawaited (`indexeddb-storage-backend.ts:172`).
- mom: floating promises (`slack.ts:314,393,316,324,395,402`, `main.ts:367`); `execSimple` no error listener (`sandbox.ts:51-67`); docker-exec timeout orphan (`sandbox.ts:184-216`); `channelDir.replace` first-occurrence (`agent.ts:413`); `startupTs` after `start()` (`slack.ts:163-166`); thread pagination drop (`download.ts:81-95`); unbounded runner cache (`agent.ts:392`); debug dump every message (`agent.ts:772-778`); `read.ts:73` off-by-one; `log.ts:56-62` identical branches; `read.ts:117` unescaped path in suggestion.
- pods: `scpFile` arg parser breaks on `-i` (`ssh.ts:120-130`); inconsistent host extraction (`models.ts:276,493`, `prompt.ts:36-39`); model `name` unescaped in remote paths/heredoc + `__proto__` (`models.ts:212-216,241-249,277`, `config.ts:53`); corrupt `pods.json` silently destroyed (`config.ts:28-31,37`); NaN to vLLM (`models.ts:171,184`); `model_run.sh:45-48` dead check, `:78` self-kill; `pods.ts:67-73` dup mount extraction; misleading "set as active" message (`pods.ts:168`, `config.ts:56-58`).
- `isRetryableError` provider-text regex (`agent-session-retry-coordinator.ts:88-90`).

## Dead code / duplication / maintenance liabilities

- `agent-session.ts` 2467-line facade, ~100 closure injections in constructor — group into option structs.
- `_checkCompaction` duplicated; coordinator copy (`agent-session-compaction-coordinator.ts:181-242`) has zero call sites.
- `core/tools/notebook-edit.ts` — dead, uncontained, non-atomic. Delete.
- `google.ts`/`google-vertex.ts` ~250 duplicated lines; Gemini-3 regexes diverged (`(?:\.\d+)?` vs `(?:\.1)?`).
- `pods/src/commands/prompt.ts:78-83` — advertised command that just throws "Not implemented" (+60 lines plumbing).
- mom: `store.ts:115-183`, most of `log.ts`, per-channel `ChannelStore` — zero callers; unused dep `@anthropic-ai/sandbox-runtime`.
- `web-ui/src/test-sessions.ts` — 2,357 lines of canned transcripts shipped in package.
- `core/tools/guidance-trap-paths.ts` + `grep.ts:341-388` — benchmark-tuning hacks referencing this repo's own paths; `/test/` classified as "trap" in any project.
- ai: dead `Error Code` template (`openai-responses-shared.ts:493`); pointless `delete index` (`azure-openai-responses.ts:112`, `google.ts:263-267`); module-level `toolCallCounter` ×3.
- `openai-codex-responses.ts` retry loop ignores `Retry-After` despite `maxRetryDelayMs` plumbed everywhere (`types.ts:96-102`).

## Product decisions needed (not code-fixable here)

- **C8:** real Google OAuth client credentials (placeholder since initial commit) — interim fix: fail fast.
- **Provider impersonation:** `anthropic.ts:64-101,566-586,622-636` spoofs Claude Code (headers, UA, tool renames, system-prompt prepend) on OAuth; `google-gemini-cli.ts:69-87,927-937` spoofs gcloud/Antigravity UAs + injects identity/ignore-tags into system instruction. ToS/ban exposure + silently alters prompts and cache breakpoints. Needs explicit decision; documented here.

## Fix order (agreed)

1. Persistence path (C1+C2).
2. Model-output→execution trust gaps (C5, S15, C12).
3. Termination guarantees (C3, C4, S30).
Then remaining Significant, then Minor/Dead code.

---

# Resolution — 2026-07-17

Three fix waves landed (21 package-scoped changesets). Every Critical and Significant item above is marked; minors were fixed in wave 3 except the deferrals listed below.

## Wave summary

- **Wave 1 (critical):** C1–C7, C9–C14 fixed. C8 fixed as fail-fast at login start (real Google OAuth client credentials remain a product/infra decision — see Product decisions).
- **Wave 2 (significant):** S1–S41 fixed, except S1(b) deferred (needs entry-level context editing; TODO in code) and the S19 sandbox-template default (product decision).
- **Wave 3 (minor + dead code):** ~60 minor items fixed; dead code removed (`core/tools/notebook-edit.ts`, duplicated `_checkCompaction`, `guidance-trap-paths.ts` + grep recovery hardcodes, mom `store.ts`/`log.ts` dead exports + unused `@anthropic-ai/sandbox-runtime` dep, pods `agent` command + `prompt.ts`, web-ui dead `validateHtml`, `test-sessions.ts` moved to `example/`, ai dead-code batch). The `packages/ai` build script no longer regenerates `models.generated.ts` from the network on every build (now an explicit `generate-models` script).

## Verification

- **Builds:** all 7 packages pass (`tsgo -p tsconfig.build.json` each).
- **Tests:** packages/agent 56/56. packages/coding-agent 1832 pass / 11 fail. packages/tui 536 pass / 8 fail. packages/ai 134 pass / 38 fail (rest env-skipped). packages/web-ui + mom + pods: no test scripts; `check`/`build` pass.
- **Typecheck:** root `tsgo --noEmit` reports 94 errors, ALL in test files (stale literals/mocks vs. the in-flight type refactor: `StopReason`, `thinkingLevel`, `AssistantMessage.usage`, `AutonomousRunLedger`, `ExtensionContext` mocks, content-union `.text` access, etc.). Zero in `src/`.
- **All remaining test/typecheck failures are pre-existing and NOT from the audit fixes**, established by: clean-HEAD-worktree reproduction (agent-session suite failures), pristine-file comparison (tui markdown/overlay/render flakiness), baseline reconstruction (coding-agent's identical 11), and git-diff attribution (the ~94 tsgo errors live in test files tied to the uncommitted in-flight refactor; the 38 ai failures are E2E tests hitting the real OpenAI API with an invalid `OPENAI_API_KEY` in this environment). The user's uncommitted in-flight work (NVIDIA provider, webfetch/model-registry/compaction refactors) was preserved throughout — every changeset verified its hunks via `git diff`.
- Biome clean on all changed files; root `biome check --write` deliberately NOT run (it would restyle unrelated user-dirty files — 12 known pre-existing import-order violators in web-ui, etc.).

## Deferred / follow-ups (not fixed)

- **S1(b)** microCompact/snipHistory persistence — needs entry-level context editing rearchitecture; TODO in `agent-session-compaction-coordinator.ts`.
- **C8** real Google OAuth client credentials (interim: fail-fast). **Provider impersonation** (Claude Code / gcloud spoofing) — product decision, see Product decisions above.
- **S19** default sandbox template for autonomous mode not shipped (`AG1_BASH_SANDBOX_COMMAND` remains opt-in).
- `agent-session.ts` 2467-line facade refactor — stylistic; not attempted.
- ai `transform-messages.ts` tool-call ID collision merge (promote mistral hasher pattern) — rare edge, not fixed.
- mini-lit `MarkdownBlock` sanitization should go upstream (web-ui wrapper covers AG1).
- `local-evidence-steering.ts` still contains benchmark-tuned heuristics beyond the removed grep/trap logic (e.g. `looksLikeCurrentEventsPromptTrap`) — flagged for a decision.
- mom docker-mode image attachments: paths built from `/workspace` fail `existsSync` on the host, so images are always sent as paths — pre-existing behavior, flagged by the wave-2 agent.
- pods: unused `@ag1/agent-core` dependency in package.json; README "routes AG1 agent traffic" phrasing now loose.
- Behavior changes worth knowing: anthropic provider now sends full `model.maxTokens` when the caller doesn't cap it (was a hidden `/3` throttle); ai validation errors truncate embedded args at 500 chars; TUI resize no longer wipes scrollback (`\x1b[3J` removed); print-mode completes on real `agent_end` (150ms timer is now watchdog-only).
- Known rare edge (documented in code): bash results recorded mid-stream during a turn that ends in a retryable error land on the abandoned branch; event snapshots freeze at emit time (producer-outrunning-consumer edge is inherent).
- TUI `AG1_TUI_WRITE_LOG` debug flag captures all terminal output (incl. secrets) — debug-only; warning comment not added.
- Session migrations mutate parsed entries in place (stylistic; unchanged).
- web-ui `updateTitle` non-transactional read-modify-write (worst case: stale title; negligible).
