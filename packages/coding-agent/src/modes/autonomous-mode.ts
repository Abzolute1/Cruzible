import * as path from "node:path";
import { getAgentDir } from "../config.js";
import type { AgentSessionRuntime } from "../core/agent-session-runtime.js";
import type { AutonConfig } from "../core/auton/auton-hook.js";
import type { AutonomousRunSnapshot } from "../core/auton/ledger.js";
import { normalizeToolName, type ToolOutcome } from "../core/auton/nudges/types.js";
import { runAutonomousSession } from "../core/auton/runner.js";
import { type ActivatedAutonomousWorkspace, activateAutonomousWorkspace } from "../core/auton/workspace.js";
import { DelegationEvidenceTracker } from "../core/delegation-evidence.js";
import type { ToolSafetyPolicy } from "../core/safety-policy.js";
import type { TaskPolicy } from "../core/task-policy.js";
import { inferTaskPolicy } from "../core/task-policy.js";
import { collectExistingTestPaths } from "../core/test-paths.js";
import { parseEmbeddedTaskPolicy } from "../core/tool-orchestrator.js";
import { buildToolCallDigest, buildToolResultDigest } from "../core/tool-outcome-digests.js";
import { extractTrackedFileFromToolResult } from "../core/tool-outcome-file.js";
import { buildWorkspaceIndex, buildWorkspaceManifest } from "../core/workspace-index.js";

// Legacy note:
// The shipping harness now owns autonomous execution through the shared
// core/auton/runner.ts engine. This file remains only as a compatibility
// wrapper for any direct programmatic imports that still expect
// runAutonomousMode().

export interface AutonomousModeOptions {
	goal: string;
	autonConfig: AutonConfig;
	cwd: string;
	/** Defaults to true. Kept injectable for tests and custom embedders. */
	isolateWorkspace?: boolean;
	/** Defaults to AG1's configured agent directory. */
	agentDir?: string;
}

export async function runAutonomousMode(
	runtimeHost: AgentSessionRuntime,
	options: AutonomousModeOptions,
): Promise<number> {
	const toolCallHistory: ToolOutcome[] = [];
	const fileAccessHistory: ToolOutcome[] = [];
	const pendingToolArgs = new Map<string, Record<string, unknown>>();
	// Bridges delegation outcomes to the ledger: tools like an extension
	// `subagent` return no structured evidence, so observed workspace changes
	// are attached as file evidence instead (see core/delegation-evidence.ts).
	const delegationEvidence = new DelegationEvidenceTracker();
	let isolatedWorkspace: ActivatedAutonomousWorkspace | undefined;
	let unsubscribe: (() => void) | undefined;
	const originalSafetyPolicy = runtimeHost.session.toolSafetyPolicy;
	const originalCwd = runtimeHost.session.sessionManager.getCwd();
	// Autonomous runs are unattended: default bash to workspace sandboxing unless
	// the user explicitly chose a mode (explicit option/env always wins — the bash
	// tool resolves option > AG1_BASH_SANDBOX > default).
	const originalBashSandboxEnv = process.env.AG1_BASH_SANDBOX;

	try {
		if (options.isolateWorkspace !== false) {
			if (originalBashSandboxEnv === undefined) {
				process.env.AG1_BASH_SANDBOX = "workspace";
			}
			process.stderr.write("[Autonomous] Preparing isolated autonomous workspace...\n");
			isolatedWorkspace = await activateAutonomousWorkspace(runtimeHost, {
				agentDir: options.agentDir ?? getAgentDir(),
			});
			process.stderr.write(
				`[Autonomous] Autonomous workspace ready (${isolatedWorkspace.strategy}): ${isolatedWorkspace.activeCwd}\n`,
			);
			setAutonomousSafetyPolicy(runtimeHost.session, {
				mode: "autonomous",
				cwd: isolatedWorkspace.activeCwd,
				// Test files present NOW (the copied source tree) are the
				// protected set; test files the agent creates during the run
				// stay mutable so it can repair its own tests.
				existingTestPaths: collectExistingTestPaths(isolatedWorkspace.activeCwd),
				// Extension tools are user-installed code: thread their registered
				// names into the policy so autonomous mode trusts them by default
				// (see ToolSafetyPolicy.extensionTools in core/safety-policy.ts).
				extensionTools: getExtensionToolNames(runtimeHost),
			});
		}

		const session = runtimeHost.session;
		const activeCwd = isolatedWorkspace?.activeCwd ?? session.sessionManager.getCwd() ?? options.cwd;
		installControlledToolPolicy(session, options.goal, activeCwd, (message) => {
			process.stderr.write(`[Autonomous] ${message}\n`);
		});
		unsubscribe = session.subscribe((event) => {
			switch (event.type) {
				case "tool_execution_start":
					pendingToolArgs.set(event.toolCallId, event.args ?? {});
					delegationEvidence.handleToolStart(event.toolName, event.toolCallId, activeCwd);
					break;
				case "tool_execution_end": {
					const toolName = normalizeToolName(event.toolName);
					const args = pendingToolArgs.get(event.toolCallId);
					pendingToolArgs.delete(event.toolCallId);
					const filePath = extractTrackedFileFromToolResult(
						toolName,
						args,
						event.result,
						session.sessionManager.getCwd(),
					);
					const toolOutcome: ToolOutcome = {
						tool: toolName,
						success: !event.isError,
						file: filePath,
						detail: extractToolDetail(toolName, args),
						estimatedTokens: estimateToolResultTokens(event.result),
						metadata: delegationEvidence.handleToolEnd(
							toolName,
							event.toolCallId,
							activeCwd,
							extractToolMetadata(event.result),
						),
						callDigest: buildToolCallDigest(toolName, args),
						resultDigest: buildToolResultDigest(event.result, event.isError),
					};
					toolCallHistory.push(toolOutcome);
					if (filePath && !event.isError) fileAccessHistory.push(toolOutcome);
					break;
				}
			}
		});

		const result = await runAutonomousSession({
			runtimeHost,
			userMessage: options.goal,
			config: {
				maxCostUsd: options.autonConfig.maxCost,
				maxTokens: options.autonConfig.maxTokens,
				maxTurns: options.autonConfig.maxTurns,
				enableNudges: options.autonConfig.enableNudges,
				enableBehavioralPrompt: options.autonConfig.enableBehavioralPrompt,
				verbose: options.autonConfig.verbose,
			},
			projectRoot: resolveRepoRootFromModuleUrl(import.meta.url),
			getToolCallHistory: () => toolCallHistory,
			getFileAccessHistory: () => fileAccessHistory,
			onStatus: (status) => {
				process.stderr.write(`[Autonomous] ${status}\n`);
			},
			onCheckpoint: (snapshot) => {
				process.stderr.write(`${formatAutonomousCheckpoint(snapshot)}\n`);
			},
			onError: (message) => {
				process.stderr.write(`[Autonomous] ${message}\n`);
			},
		});

		return result.stopReason === "complete" ? 0 : 1;
	} finally {
		unsubscribe?.();
		if (originalBashSandboxEnv === undefined) {
			delete process.env.AG1_BASH_SANDBOX;
		} else {
			process.env.AG1_BASH_SANDBOX = originalBashSandboxEnv;
		}
		if (isolatedWorkspace) {
			await isolatedWorkspace.restore();
			setAutonomousSafetyPolicy(runtimeHost.session, originalSafetyPolicy);
			process.stderr.write(
				`[Autonomous] Returned to ${originalCwd}. Autonomous workspace preserved at ${isolatedWorkspace.workspaceRoot}\n`,
			);
		}
	}
}

function setAutonomousSafetyPolicy(
	session: AgentSessionRuntime["session"] & { setToolSafetyPolicy?: (policy: ToolSafetyPolicy | undefined) => void },
	policy: ToolSafetyPolicy | undefined,
): void {
	if (typeof session.setToolSafetyPolicy === "function") {
		session.setToolSafetyPolicy(policy);
	}
}

/**
 * Collect the names of all tools registered through the extension system so
 * the autonomous safety policy can trust them by default (user-installed
 * code; see ToolSafetyPolicy.extensionTools in core/safety-policy.ts).
 */
function getExtensionToolNames(runtimeHost: AgentSessionRuntime): string[] {
	const runner = runtimeHost.session.extensionRunner;
	if (!runner) return [];
	return runner.getAllRegisteredTools().map((tool) => tool.definition.name);
}

function installControlledToolPolicy(
	session: AgentSessionRuntime["session"] & { setToolPolicy?: (policy: TaskPolicy | undefined) => void },
	goal: string,
	cwd: string,
	onStatus?: (message: string) => void,
): void {
	if (typeof session.setToolPolicy !== "function") return;
	try {
		const index = buildWorkspaceIndex({ rootDir: cwd });
		const manifest = buildWorkspaceManifest(index, { prompt: goal });
		const embedded = parseEmbeddedTaskPolicy(goal);
		const mode = embedded.mode ?? "controlled";
		const inferred = inferTaskPolicy({
			index,
			manifest,
			mode,
			prompt: goal,
		});
		const policy: TaskPolicy = {
			...inferred,
			...embedded,
			mode,
			intent: embedded.intent ?? inferred.intent,
			mutationExpected:
				embedded.expectedChangedPaths && embedded.expectedChangedPaths.length > 0
					? true
					: inferred.mutationExpected,
			allowedPaths:
				embedded.allowedPaths && embedded.allowedPaths.length > 0 ? embedded.allowedPaths : inferred.allowedPaths,
			expectedChangedPaths:
				embedded.expectedChangedPaths && embedded.expectedChangedPaths.length > 0
					? embedded.expectedChangedPaths
					: inferred.expectedChangedPaths,
			likelyTests:
				embedded.likelyTests && embedded.likelyTests.length > 0 ? embedded.likelyTests : inferred.likelyTests,
			verification: embedded.verification ?? inferred.verification,
		};
		session.setToolPolicy(policy);
		if (policy.mode === "strict_benchmark") {
			onStatus?.(
				`controlled policy active: intent=${policy.intent} expected=${policy.expectedChangedPaths.join(",") || "none"} verifier=${policy.verification ?? "none"}`,
			);
		}
	} catch (error) {
		onStatus?.(`controlled policy unavailable: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function extractToolDetail(toolName: string, args: Record<string, unknown> | undefined): string | undefined {
	if (!args) return undefined;
	if (toolName === "task" && typeof args.description === "string") {
		const type = typeof args.type === "string" ? args.type : undefined;
		return type ? `${type}: ${args.description}` : args.description;
	}
	if ((toolName === "bash" || toolName === "verify") && typeof args.command === "string") {
		return args.command;
	}
	if (toolName === "websearch" && typeof args.query === "string") return args.query;
	if (toolName === "webfetch" && typeof args.url === "string") return args.url;
	if (toolName === "read") {
		const filePath =
			typeof args.filePath === "string" ? args.filePath : typeof args.path === "string" ? args.path : undefined;
		if (!filePath) return undefined;
		const suffix: string[] = [];
		if (typeof args.offset === "number") suffix.push(`offset=${args.offset}`);
		if (typeof args.limit === "number") suffix.push(`limit=${args.limit}`);
		return suffix.length > 0 ? `${filePath} (${suffix.join(", ")})` : filePath;
	}
	if (typeof args.filePath === "string") return args.filePath;
	if (typeof args.path === "string") return args.path;
	return undefined;
}

function extractToolMetadata(result: unknown): Record<string, unknown> | undefined {
	const metadata: Record<string, unknown> = {};
	if (result && typeof result === "object" && "details" in result) {
		const details = (result as { details?: unknown }).details;
		if (details && typeof details === "object") {
			Object.assign(metadata, details as Record<string, unknown>);
		}
	}
	const outputPreview = extractToolOutputPreview(result);
	if (outputPreview) metadata.outputPreview = outputPreview;
	return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function estimateToolResultTokens(result: unknown): number | undefined {
	if (!result || typeof result !== "object" || !("content" in result)) return undefined;
	const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
	if (!Array.isArray(content)) return undefined;
	const text = content
		.filter((item) => item && item.type === "text" && typeof item.text === "string")
		.map((item) => item.text ?? "")
		.join("\n");
	if (text.length === 0) return undefined;
	return Math.ceil(text.length / 4);
}

function extractToolOutputPreview(result: unknown): string | undefined {
	if (!result || typeof result !== "object" || !("content" in result)) return undefined;
	const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
	if (!Array.isArray(content)) return undefined;
	const text = content
		.filter((item) => item && item.type === "text" && typeof item.text === "string")
		.map((item) => item.text ?? "")
		.join("\n")
		.trim();
	if (text.length === 0) return undefined;
	return summarizeToolOutputPreview(text);
}

const FAILURE_PREVIEW_PATTERNS = [
	/\b(missing|not found|expected|assert|must|required|invalid|unable)\b/i,
	/\b(fail(?:ed|ure)?|error|exception|timed out|exited with code)\b/i,
];

const OUTPUT_PREVIEW_SKIP_PATTERNS = [
	/^tap version\b/i,
	/^# subtest:/i,
	/^not ok\b/i,
	/^ok\b/i,
	/^1\.\.\d+\b/i,
	/^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\b/i,
	/^(duration_ms|type|location|failureType|exitCode|signal|error|code):/i,
	/^command exited with code\b/i,
	/^error executing 'bash':\s*tap version\b/i,
];

function summarizeToolOutputPreview(text: string): string | undefined {
	const lines = text
		.split(/\r?\n/)
		.map((line) => line.trim().replace(/^#\s*/, ""))
		.filter(Boolean)
		.filter((line) => !/^```/.test(line))
		.filter((line) => !/^#{1,6}\s/.test(line))
		.filter((line) => !/^(type:|summary:|stdout:|stderr:)$/i.test(line))
		.filter((line) => !OUTPUT_PREVIEW_SKIP_PATTERNS.some((pattern) => pattern.test(line)));
	if (lines.length === 0) return undefined;
	const preferredLine =
		lines.find((line) => FAILURE_PREVIEW_PATTERNS[0]?.test(line)) ??
		lines.find((line) => FAILURE_PREVIEW_PATTERNS[1]?.test(line)) ??
		lines.find((line) => !/^(verify results:|\u2713 all \d+ command|command exited with code \d+)$/i.test(line)) ??
		lines[0];
	return preferredLine.length <= 220 ? preferredLine : `${preferredLine.slice(0, 217)}...`;
}

function resolveRepoRootFromModuleUrl(moduleUrl: string): string {
	const thisFileDir = path.dirname(new URL(moduleUrl).pathname);
	return path.resolve(thisFileDir, "../../../..");
}

function formatAutonomousCheckpoint(snapshot: AutonomousRunSnapshot): string {
	const activeSubtask = snapshot.ledger.taskJournal.activeSubtask?.trim();
	const nextAction = snapshot.ledger.taskJournal.nextAction?.trim();
	const checkpoint =
		snapshot.ledger.resume?.lastStableCheckpoint?.trim() ||
		snapshot.ledger.taskJournal.completedCheckpoints.at(-1)?.trim();
	const parts = [
		`[Autonomous] checkpoint phase=${snapshot.phase}`,
		`status=${snapshot.ledger.status}`,
		`turns=${snapshot.budgetStatus.turnsUsed}`,
	];
	if (activeSubtask) parts.push(`active=${activeSubtask}`);
	if (nextAction) parts.push(`next=${nextAction}`);
	if (checkpoint) parts.push(`stable=${checkpoint}`);
	return parts.join(" | ");
}
