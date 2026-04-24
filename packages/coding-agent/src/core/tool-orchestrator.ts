import { basename, normalize, relative, resolve } from "node:path";
import {
	buildEvidencePlan,
	formatEvidencePlanStep,
	nextEvidencePlanStep,
	type EvidencePlanStep,
} from "./evidence-planner.js";
import { RepairController } from "./repair-controller.js";
import { StopController } from "./stop-controller.js";
import type { TaskPolicy } from "./task-policy.js";
import { isContainedPath, resolveToCwd } from "./tools/path-utils.js";
import { commandMatchesVerifier } from "./verification-controller.js";

export type ControlledToolDecision =
	| { allow: true; reason?: string }
	| { allow: false; reason: string; nextAction?: string };

export type ControlledToolObservation = {
	toolName: string;
	args: unknown;
	isError: boolean;
	result?: unknown;
};

export type ToolOrchestratorOptions = {
	cwd: string;
	policy: TaskPolicy;
};

type ToolCounters = {
	readsBeforePatch: number;
	searchesBeforePatch: number;
	patchAttempts: number;
	discoveryCalls: number;
};

const SEARCH_TOOLS = new Set(["grep", "find"]);
const MUTATION_TOOLS = new Set(["edit", "write", "notebook_edit", "NotebookEdit"]);

function normalizeRelativePath(value: string): string {
	return value.split("\\").join("/");
}

function normalizeCommand(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function getToolPath(args: unknown): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const record = args as { path?: unknown; filePath?: unknown; file_path?: unknown };
	const path = record.path ?? record.filePath ?? record.file_path;
	return typeof path === "string" ? path : undefined;
}

function getBashCommand(args: unknown): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const command = (args as { command?: unknown }).command;
	return typeof command === "string" ? command : undefined;
}

function setBashCommand(args: unknown, command: string): void {
	if (!args || typeof args !== "object") return;
	(args as { command?: string }).command = command;
}

function getFindPattern(args: unknown): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const pattern = (args as { pattern?: unknown }).pattern;
	return typeof pattern === "string" ? pattern : undefined;
}

function textFromToolResult(result: unknown): string {
	if (typeof result === "string") return result;
	if (!result || typeof result !== "object") return "";
	const content = (result as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((item) => {
			if (!item || typeof item !== "object") return "";
			const text = (item as { text?: unknown }).text;
			return typeof text === "string" ? text : "";
		})
		.filter(Boolean)
		.join("\n");
}

function commandLooksLikeDiscovery(command: string): boolean {
	const normalized = normalizeCommand(command);
	return /(^|[;&|]\s*)(ls\b|find\b|fd\b|rg\s+--files\b|pwd\b|git\s+status(\s|$)|git\s+branch(\s|$))/i.test(
		normalized,
	);
}

function isBroadFind(pattern: string | undefined): boolean {
	if (!pattern) return true;
	const normalized = pattern.trim();
	return normalized === "*" || normalized === "**/*" || normalized === "." || normalized === "./";
}

function relativeWorkspacePath(cwd: string, requestedPath: string): string {
	const absolute = resolveToCwd(requestedPath, cwd);
	return normalizeRelativePath(relative(cwd, absolute));
}

function formatList(values: string[], fallback = "the listed relevant paths"): string {
	return values.length > 0 ? values.join(", ") : fallback;
}

function isVerifierCommand(command: string, verifier?: string): boolean {
	return commandMatchesVerifier(command, verifier);
}

function isExactVerifierCommand(command: string, verifier?: string): boolean {
	return Boolean(verifier && normalizeCommand(command) === normalizeCommand(verifier));
}

function isBashSuccess(observation: ControlledToolObservation): boolean {
	if (observation.isError) return false;
	const text = textFromToolResult(observation.result).toLowerCase();
	return !text.includes("command exited with code") && !text.includes("command timed out");
}

export class ToolOrchestrator {
	private readonly policy: TaskPolicy;
	private readonly cwd: string;
	private readonly readPaths = new Set<string>();
	private readonly counters: ToolCounters = {
		readsBeforePatch: 0,
		searchesBeforePatch: 0,
		patchAttempts: 0,
		discoveryCalls: 0,
	};
	private readonly stopController: StopController;
	private readonly repairController: RepairController;
	private readonly evidencePlan: EvidencePlanStep[];
	private readonly mutatedPathsSinceVerifier = new Set<string>();
	private readonly mutatedPaths = new Set<string>();

	constructor(options: ToolOrchestratorOptions) {
		this.cwd = resolve(options.cwd);
		this.policy = options.policy;
		this.stopController = new StopController({ stopAfterVerifierPass: this.policy.stopAfterVerifierPass });
		this.repairController = new RepairController({
			relevantPaths: this.policy.allowedPaths,
			expectedChangedPaths: this.policy.expectedChangedPaths,
		});
		this.evidencePlan = buildEvidencePlan(this.policy);
	}

	evaluate(toolName: string, args: unknown): ControlledToolDecision {
		if (this.policy.mode === "flexible") return { allow: true };

		const stopDecision = this.stopController.evaluateToolUse();
		if (stopDecision.shouldStop && stopDecision.finalAnswerOnly) {
			return {
				allow: false,
				reason: stopDecision.reason ?? "Controlled runtime: task is complete. Provide the final summary.",
				nextAction: stopDecision.nextAction,
			};
		}
		const repairSnapshot = this.repairController.snapshot();
		if (repairSnapshot.shouldStop) {
			return {
				allow: false,
				reason: `Controlled runtime: repeated verifier failure limit reached. Summarize the blocker and smallest next repair: ${repairSnapshot.lastFailure?.summary ?? "unknown verifier failure"}`,
				nextAction: "final_answer",
			};
		}

		const path = getToolPath(args);
		if (path && !isContainedPath(path, this.cwd, { allowMissing: true })) {
			return {
				allow: false,
				reason: `Controlled runtime: ${toolName} path is outside the workspace: ${path}`,
			};
		}

		if (toolName === "ls") return this.evaluateLs(args);
		if (toolName === "find") return this.evaluateFind(args);
		if (SEARCH_TOOLS.has(toolName)) return this.evaluateSearch(toolName);
		if (toolName === "read") return this.evaluateRead(args);
		if (MUTATION_TOOLS.has(toolName)) return this.evaluateMutation(toolName, args);
		if (toolName === "bash") return this.evaluateBash(args);
		return { allow: true };
	}

	noteToolResult(observation: ControlledToolObservation): void {
		const command = getBashCommand(observation.args);
		if (
			observation.toolName === "bash" &&
			command &&
			isVerifierCommand(command, this.policy.verification) &&
			this.stopController.hasMutationSinceVerifier()
		) {
			const success = !observation.isError && isBashSuccess(observation);
			this.stopController.noteVerification({ matchedVerifier: true, success });
			if (success) {
				this.repairController.noteVerificationSuccess();
				this.mutatedPathsSinceVerifier.clear();
			} else {
				this.repairController.noteVerificationFailure(textFromToolResult(observation.result));
			}
			return;
		}

		if (observation.isError) return;

		const path = getToolPath(observation.args);
		if (observation.toolName === "read" && path) {
			this.readPaths.add(relativeWorkspacePath(this.cwd, path));
			if (this.counters.patchAttempts === 0) this.counters.readsBeforePatch++;
			return;
		}

		if (observation.toolName === "ls" || observation.toolName === "find" || SEARCH_TOOLS.has(observation.toolName)) {
			this.counters.discoveryCalls++;
			if (this.counters.patchAttempts === 0 && SEARCH_TOOLS.has(observation.toolName)) this.counters.searchesBeforePatch++;
			return;
		}

		if (MUTATION_TOOLS.has(observation.toolName)) {
			this.counters.patchAttempts++;
			this.stopController.noteMutation();
			this.repairController.noteMutation();
			if (path) this.mutatedPathsSinceVerifier.add(relativeWorkspacePath(this.cwd, path));
			if (path) this.mutatedPaths.add(relativeWorkspacePath(this.cwd, path));
			return;
		}

		if (observation.toolName === "bash" && command) {
			if (commandLooksLikeDiscovery(command)) this.counters.discoveryCalls++;
		}
	}

	getStopDecision(): ReturnType<StopController["evaluateToolUse"]> {
		return this.stopController.evaluateToolUse();
	}

	getNextActionHint(): string | undefined {
		if (this.policy.mode !== "strict_benchmark") return undefined;
		const repairGuidance = this.repairController.getGuidance();
		if (repairGuidance) return repairGuidance;
		return this.nextPlannedAction();
	}

	private evaluateLs(args: unknown): ControlledToolDecision {
		if (this.policy.mode !== "strict_benchmark") return { allow: true };
		const path = getToolPath(args) ?? ".";
		const relPath = relativeWorkspacePath(this.cwd, path);
		if (this.policy.allowedPaths.length > 0) {
			return {
				allow: false,
				reason: `Controlled runtime: broad directory listing is blocked because relevant files are already known: ${formatList(this.policy.allowedPaths)}.`,
				nextAction: this.nextPlannedAction() ?? this.nextReadAction(relPath),
			};
		}
		return { allow: true };
	}

	private evaluateFind(args: unknown): ControlledToolDecision {
		if (this.policy.mode !== "strict_benchmark") return { allow: true };
		if (this.policy.allowedPaths.length > 0 && isBroadFind(getFindPattern(args))) {
			return {
				allow: false,
				reason: `Controlled runtime: broad find is blocked because relevant files are already known: ${formatList(this.policy.allowedPaths)}.`,
				nextAction: this.nextPlannedAction() ?? this.nextReadAction(),
			};
		}
		return this.evaluateSearch("find");
	}

	private evaluateSearch(toolName: string): ControlledToolDecision {
		if (this.policy.mode !== "strict_benchmark") return { allow: true };
		if (this.counters.patchAttempts === 0 && this.counters.searchesBeforePatch >= this.policy.maxSearchesBeforePatch) {
			return {
				allow: false,
				reason: `Controlled runtime: ${toolName} exceeds the pre-patch search budget (${this.policy.maxSearchesBeforePatch}).`,
				nextAction: this.nextPlannedAction() ?? this.nextReadAction(),
			};
		}
		return { allow: true };
	}

	private evaluateRead(args: unknown): ControlledToolDecision {
		const path = getToolPath(args);
		if (!path) return { allow: true };
		const relativePath = relativeWorkspacePath(this.cwd, path);
		if (this.isRequiredPlannedRead(relativePath)) return { allow: true };
		if (
			this.policy.mode === "strict_benchmark" &&
			this.counters.patchAttempts === 0 &&
			this.policy.expectedChangedPaths.length === 1 &&
			this.readPaths.size >= 2 &&
			this.policy.expectedChangedPaths.some((path) => this.readPaths.has(path)) &&
			!this.policy.expectedChangedPaths.includes(relativePath)
		) {
			return {
				allow: false,
				reason: `Controlled runtime: the expected target and supporting context were already read. Edit ${formatList(this.policy.expectedChangedPaths)} before reading more files.`,
				nextAction: this.nextPlannedAction() ?? this.nextMutationOrVerifierAction(),
			};
		}
		if (
			this.policy.mode === "strict_benchmark" &&
			this.counters.patchAttempts === 0 &&
			this.counters.readsBeforePatch >= this.policy.maxReadsBeforePatch &&
			!this.policy.expectedChangedPaths.includes(relativePath)
		) {
			return {
				allow: false,
				reason: `Controlled runtime: read budget before patch is exhausted (${this.policy.maxReadsBeforePatch}).`,
				nextAction: this.nextPlannedAction() ?? this.nextMutationOrVerifierAction(),
			};
		}
		return { allow: true };
	}

	private evaluateMutation(toolName: string, args: unknown): ControlledToolDecision {
		if (!this.policy.mutationExpected) {
			return {
				allow: false,
				reason: `Controlled runtime: ${toolName} is blocked because this task was classified as non-mutating (${this.policy.intent}).`,
			};
		}
		const path = getToolPath(args);
		if (!path) return { allow: true };
		const relativePath = relativeWorkspacePath(this.cwd, path);
		const allowedMutationPaths =
			this.policy.expectedChangedPaths.length > 0 ? this.policy.expectedChangedPaths : this.policy.allowedPaths;
		if (
			this.policy.mode === "strict_benchmark" &&
			this.stopController.hasMutationSinceVerifier() &&
			!this.stopController.hasVerifierFailedAfterMutation() &&
			this.mutatedPathsSinceVerifier.has(relativePath)
		) {
			return {
				allow: false,
				reason: `Controlled runtime: ${relativePath} was already edited. Run the verifier before making another edit to the same file.`,
				nextAction: this.policy.verification ? `bash ${this.policy.verification}` : "final_answer",
			};
		}
		if (
			this.policy.mode === "strict_benchmark" &&
			allowedMutationPaths.length > 0 &&
			!allowedMutationPaths.includes(relativePath)
		) {
			return {
				allow: false,
				reason: `Controlled runtime: ${toolName} target ${relativePath} is outside the expected mutation set: ${formatList(allowedMutationPaths)}.`,
				nextAction: `edit ${allowedMutationPaths[0]}`,
			};
		}
		return { allow: true };
	}

	private evaluateBash(args: unknown): ControlledToolDecision {
		const command = getBashCommand(args);
		if (!command) {
			return {
				allow: false,
				reason: "Controlled runtime: bash requires a concrete command. Use the verifier command or a final answer.",
				nextAction: this.policy.verification ? `bash ${this.policy.verification}` : "final_answer",
			};
		}
		if (isVerifierCommand(command, this.policy.verification)) {
			const repairDecision = this.repairController.evaluateVerifierRun();
			if (!repairDecision.allow) return repairDecision;
			const verifier = this.policy.verification;
			if (this.policy.mode === "strict_benchmark" && verifier && !isExactVerifierCommand(command, verifier)) {
				setBashCommand(args, verifier);
				return { allow: true, reason: `Controlled runtime: verifier command rewritten to: ${verifier}` };
			}
			const missingExpectedMutations = this.policy.expectedChangedPaths.filter((path) => !this.mutatedPaths.has(path));
			if (
				this.policy.mode === "strict_benchmark" &&
				this.policy.mutationExpected &&
				this.policy.expectedChangedPaths.length > 0 &&
				missingExpectedMutations.length > 0
			) {
				return {
					allow: false,
					reason: `Controlled runtime: verifier is blocked until expected mutation paths are edited: ${formatList(missingExpectedMutations)}.`,
					nextAction: `edit ${missingExpectedMutations[0]}`,
				};
			}
			return { allow: true };
		}
		if (this.policy.mode === "strict_benchmark" && commandLooksLikeDiscovery(command) && this.policy.allowedPaths.length > 0) {
			return {
				allow: false,
				reason: `Controlled runtime: shell discovery is blocked because relevant files are already known: ${formatList(this.policy.allowedPaths)}.`,
				nextAction: this.stopController.hasMutationSinceVerifier() && this.policy.verification
					? `bash ${this.policy.verification}`
					: this.nextPlannedAction() ?? this.nextReadAction(),
			};
		}
		return { allow: true };
	}

	private nextPlannedAction(): string | undefined {
		const repairSnapshot = this.repairController.snapshot();
		if (repairSnapshot.shouldStop) return "final_answer";
		if (repairSnapshot.failed && !repairSnapshot.mutationSinceFailure) return this.repairController.nextRepairAction();
		const next = nextEvidencePlanStep(this.evidencePlan, {
			readPaths: this.readPaths,
			mutatedPaths: this.mutatedPaths,
			mutationSinceVerifier: this.stopController.hasMutationSinceVerifier(),
			verifierPassedAfterMutation: this.stopController.snapshot().verifierPassedAfterMutation,
		});
		return next ? formatEvidencePlanStep(next) : undefined;
	}

	private isRequiredPlannedRead(path: string): boolean {
		return this.evidencePlan.some(
			(step) => step.action === "read" && step.required && step.path === path && !this.readPaths.has(path),
		);
	}

	private nextReadAction(_attemptedDirectory?: string): string {
		const unread = this.policy.allowedPaths.find((path) => !this.readPaths.has(path));
		return unread ? `read ${unread}` : this.nextMutationOrVerifierAction();
	}

	private nextMutationOrVerifierAction(): string {
		const target = this.policy.expectedChangedPaths[0] ?? this.policy.allowedPaths.find((path) => basename(path).includes(".")) ?? "";
		if (this.policy.mutationExpected && target) return `edit ${target}`;
		if (this.policy.verification) return `bash ${this.policy.verification}`;
		return "final_answer";
	}
}

export function parseEmbeddedTaskPolicy(text: string): Partial<TaskPolicy> {
	const expected = matchCsvLine(text, "expected changed paths");
	const allowed = matchCsvLine(text, "allowed changed paths");
	const allowedPaths = matchManifestList(text, "Relevant files");
	const tests = matchManifestList(text, "Relevant tests");
	const verifier = matchLineValue(text, "verifier") ?? matchLineValue(text, "Likely verifier");
	const intent = matchLineValue(text, "intent") as TaskPolicy["intent"] | undefined;
	const mode = matchLineValue(text, "mode") as TaskPolicy["mode"] | undefined;
	return {
		mode,
		intent,
		allowedPaths,
		expectedChangedPaths: expected.length > 0 ? expected : allowed,
		likelyTests: tests,
		verification: verifier,
	};
}

function matchLineValue(text: string, label: string): string | undefined {
	const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = text.match(new RegExp(`(?:^-\\s*)?${escaped}:\\s*([^\\n]+)`, "im"));
	return match?.[1]?.trim();
}

function matchCsvLine(text: string, label: string): string[] {
	const value = matchLineValue(text, label);
	if (!value) return [];
	return value
		.split(",")
		.map((item) => normalizeRelativePath(normalize(item.trim())))
		.filter(Boolean);
}

function matchManifestList(text: string, heading: string): string[] {
	const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = text.match(new RegExp(`${escaped}:\\n((?:-\\s+[^\\n]+\\n?)+)`, "i"));
	if (!match?.[1]) return [];
	return match[1]
		.split(/\r?\n/)
		.map((line) => line.replace(/^-\s+/, "").trim())
		.filter(Boolean)
		.map((item) => normalizeRelativePath(normalize(item)));
}
