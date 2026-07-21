export type RunDiagnosticInput = {
	status?: string;
	errorKind?: string;
	finalAnswerDetected?: boolean;
	verifyCommand?: string;
	verifyStatus?: string;
	toolSequence?: string[];
	repeatedTools?: string;
	maxConsecutiveSameTool?: number;
	stallSignatures?: string[];
	totalTokens?: number;
	toolCallsBeforeFinalAnswer?: number;
	changedFiles?: string[];
	requiredChangedPaths?: string[];
	allowedChangedPaths?: string[];
	policyBlockReasons?: string[];
};

export type RunDiagnostics = {
	failureLabels: string[];
	wasteLabels: string[];
	policyLabels: string[];
	summary: string;
};

const ENVIRONMENT_ERROR_KINDS = new Set([
	"backend_unavailable",
	"benchmark_terminated",
	"connection_refused",
	"connection_error",
	"provider_stream_error",
	"provider_api_error",
	"db_wal_checkpoint_failure",
	"model_load_failure",
]);

const DISCOVERY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const VERIFY_TOOLS = new Set(["bash", "run"]);

function unique(values: string[]): string[] {
	return [...new Set(values.filter(Boolean))];
}

function pathMatches(path: string, prefixes: string[]): boolean {
	return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function countRepeatedToolExtras(repeatedTools?: string): number {
	if (!repeatedTools) return 0;
	return repeatedTools
		.split(",")
		.map((item) => {
			const [, countText] = item.split(":");
			const count = Number.parseInt(countText ?? "", 10);
			return Number.isFinite(count) && count > 1 ? count - 1 : 0;
		})
		.reduce((sum, count) => sum + count, 0);
}

function hasToolAfterVerifier(toolSequence: string[]): boolean {
	let lastVerifierIndex = -1;
	for (let index = toolSequence.length - 1; index >= 0; index -= 1) {
		if (VERIFY_TOOLS.has(toolSequence[index]?.toLowerCase() ?? "")) {
			lastVerifierIndex = index;
			break;
		}
	}
	return lastVerifierIndex >= 0 && lastVerifierIndex < toolSequence.length - 1;
}

function countDiscoveryTools(toolSequence: string[]): number {
	return toolSequence.filter((tool) => DISCOVERY_TOOLS.has(tool.toLowerCase())).length;
}

function classifyPolicyBlock(reason: string): string {
	const normalized = reason.toLowerCase();
	if (normalized.includes("verifier already passed")) return "post_verifier_tool_block";
	if (normalized.includes("run the verifier exactly")) return "non_exact_verifier_block";
	if (normalized.includes("until expected mutation paths are edited")) return "early_verifier_block";
	if (
		normalized.includes("repair before rerunning verifier") ||
		normalized.includes("same verifier failure repeated")
	) {
		return "repair_loop_block";
	}
	if (normalized.includes("already edited")) return "duplicate_edit_block";
	if (normalized.includes("already read") || normalized.includes("before reading more files"))
		return "over_read_block";
	if (
		normalized.includes("broad directory") ||
		normalized.includes("broad find") ||
		normalized.includes("shell discovery")
	) {
		return "broad_discovery_block";
	}
	if (normalized.includes("multiple tool calls in one assistant turn")) return "multi_tool_turn_block";
	if (normalized.includes("outside the expected mutation set") || normalized.includes("outside allowed"))
		return "wrong_target_block";
	if (normalized.includes("outside the workspace")) return "workspace_escape_block";
	if (normalized.includes("bash requires a concrete command")) return "empty_bash_block";
	return "controlled_runtime_block";
}

export function buildRunDiagnostics(input: RunDiagnosticInput): RunDiagnostics {
	const failureLabels: string[] = [];
	const wasteLabels: string[] = [];
	const policyLabels = unique((input.policyBlockReasons ?? []).map(classifyPolicyBlock));
	const toolSequence = input.toolSequence ?? [];
	const changedFiles = input.changedFiles ?? [];
	const requiredChangedPaths = input.requiredChangedPaths ?? [];
	const allowedChangedPaths = input.allowedChangedPaths ?? [];
	const repeatedExtras = countRepeatedToolExtras(input.repeatedTools);
	const maxConsecutive = input.maxConsecutiveSameTool ?? 0;
	const stallCount = input.stallSignatures?.length ?? 0;
	const toolCount = input.toolCallsBeforeFinalAnswer ?? toolSequence.length;
	const tokenCount = input.totalTokens ?? 0;

	if (input.errorKind && ENVIRONMENT_ERROR_KINDS.has(input.errorKind)) failureLabels.push("environment_blocked");
	else if (input.errorKind === "timeout" || input.status === "timeout") failureLabels.push("timeout");
	else if (input.errorKind) failureLabels.push(input.errorKind);

	if (input.finalAnswerDetected === false) {
		failureLabels.push("final_answer_missing");
		if (input.verifyStatus === "passed") failureLabels.push("stopping_failure");
	}
	if (input.verifyCommand && !input.verifyStatus) failureLabels.push("verification_not_run");
	if (input.verifyStatus === "failed") failureLabels.push("verification_failed");
	if (input.verifyStatus === "passed" && !toolSequence.some((tool) => VERIFY_TOOLS.has(tool.toLowerCase()))) {
		failureLabels.push("verification_missing_in_turn");
	}

	const missingRequired = requiredChangedPaths.filter(
		(path) => !changedFiles.some((changed) => pathMatches(changed, [path])),
	);
	if (missingRequired.length > 0) failureLabels.push("missing_required_change");
	if (allowedChangedPaths.length > 0 && changedFiles.some((path) => !pathMatches(path, allowedChangedPaths))) {
		failureLabels.push("wrong_target");
	}
	if (stallCount > 0) failureLabels.push("stopping_or_stall_signal");

	if (repeatedExtras > 0) wasteLabels.push("repeated_tool_calls");
	if (repeatedExtras >= 3) wasteLabels.push("high_tool_churn");
	if (maxConsecutive >= 3) wasteLabels.push("same_tool_loop");
	if (toolCount >= 7) wasteLabels.push("over_exploration");
	if (countDiscoveryTools(toolSequence) >= 4) wasteLabels.push("excessive_discovery");
	if (hasToolAfterVerifier(toolSequence)) wasteLabels.push("post_verifier_tool_attempt");
	if (tokenCount >= 35_000) wasteLabels.push("high_token_use");
	if (tokenCount >= 60_000) wasteLabels.push("context_bloat");
	if (policyLabels.length > 0) wasteLabels.push("policy_blocked_waste");

	const summaryParts = [
		failureLabels.length > 0 ? `failures=${unique(failureLabels).join("|")}` : "failures=none",
		wasteLabels.length > 0 ? `waste=${unique(wasteLabels).join("|")}` : "waste=none",
		policyLabels.length > 0 ? `policy=${policyLabels.join("|")}` : "policy=none",
	];

	return {
		failureLabels: unique(failureLabels),
		wasteLabels: unique(wasteLabels),
		policyLabels,
		summary: summaryParts.join("; "),
	};
}
