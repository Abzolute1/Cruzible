import type { TaskPolicy } from "./task-policy.js";

export type EvidencePlanAction = "read" | "edit" | "verify" | "final_answer";

export type EvidencePlanStep = {
	action: EvidencePlanAction;
	path?: string;
	command?: string;
	required: boolean;
	reason: string;
};

export type EvidencePlanState = {
	readPaths?: Iterable<string>;
	mutatedPaths?: Iterable<string>;
	mutationSinceVerifier?: boolean;
	verifierPassedAfterMutation?: boolean;
};

function unique(values: string[]): string[] {
	return [...new Set(values.filter(Boolean))];
}

function isLikelyTest(path: string): boolean {
	return /(^|\/)(test|tests|__tests__)\/|[._-](test|spec)\.[cm]?[jt]sx?$/i.test(path);
}

function mutationCandidates(policy: TaskPolicy): string[] {
	const expected = policy.expectedChangedPaths;
	if (expected.length > 0) return expected;
	return policy.allowedPaths
		.filter((path) => !isLikelyTest(path))
		.slice(0, policy.intent === "multi_file_change" ? 6 : 1);
}

export function buildEvidencePlan(policy: TaskPolicy): EvidencePlanStep[] {
	const steps: EvidencePlanStep[] = [];
	const targets = unique(mutationCandidates(policy));
	const likelyTests = unique(
		policy.likelyTests.filter((path) => policy.allowedPaths.length === 0 || policy.allowedPaths.includes(path)),
	);

	if (policy.mutationExpected) {
		for (const path of likelyTests) {
			steps.push({
				action: "read",
				path,
				required: true,
				reason: "read the likely failing or regression test before patching",
			});
		}
		for (const path of targets) {
			steps.push({
				action: "read",
				path,
				required: true,
				reason: "read the expected mutation target before patching",
			});
		}
		const plannedReadPaths = new Set(steps.filter((step) => step.action === "read").map((step) => step.path));
		const optionalSupportLimit = policy.intent === "multi_file_change" ? 2 : 1;
		for (const path of policy.allowedPaths
			.filter((path) => !plannedReadPaths.has(path))
			.slice(0, optionalSupportLimit)) {
			steps.push({
				action: "read",
				path,
				required: false,
				reason: "optional supporting context if required by the already-read evidence",
			});
		}
		for (const path of targets) {
			steps.push({
				action: "edit",
				path,
				required: true,
				reason: "patch the expected mutation target after required evidence is read",
			});
		}
	} else if (policy.intent === "verification_only" && policy.verification) {
		steps.push({
			action: "verify",
			command: policy.verification,
			required: true,
			reason: "run the requested verification command",
		});
	} else if (policy.allowedPaths.length > 0 && policy.intent !== "research") {
		for (const path of policy.allowedPaths.slice(0, policy.intent === "direct_answer" ? 1 : 2)) {
			steps.push({
				action: "read",
				path,
				required: true,
				reason: "read the smallest relevant local evidence set",
			});
		}
	}

	if (policy.verification && policy.mutationExpected) {
		steps.push({
			action: "verify",
			command: policy.verification,
			required: true,
			reason: "verify after mutation",
		});
	}
	steps.push({
		action: "final_answer",
		required: true,
		reason: "summarize the completed work and verification result",
	});

	const seen = new Set<string>();
	return steps.filter((step) => {
		const key = `${step.action}:${step.path ?? ""}:${step.command ?? ""}:${step.required}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

export function formatEvidencePlanStep(step: EvidencePlanStep): string {
	if (step.action === "read" && step.path) return `read ${step.path}`;
	if (step.action === "edit" && step.path) return `edit ${step.path}`;
	if (step.action === "verify" && step.command) return `bash ${step.command}`;
	return "final_answer";
}

export function nextEvidencePlanStep(
	plan: EvidencePlanStep[],
	state: EvidencePlanState = {},
): EvidencePlanStep | undefined {
	if (state.verifierPassedAfterMutation) return plan.find((step) => step.action === "final_answer");

	const readPaths = new Set(state.readPaths ?? []);
	const mutatedPaths = new Set(state.mutatedPaths ?? []);
	const requiredUnread = plan.find(
		(step) => step.action === "read" && step.required && step.path && !readPaths.has(step.path),
	);
	if (requiredUnread) return requiredUnread;

	const missingMutation = plan.find(
		(step) => step.action === "edit" && step.required && step.path && !mutatedPaths.has(step.path),
	);
	if (missingMutation) return missingMutation;

	if (state.mutationSinceVerifier) {
		const verifier = plan.find((step) => step.action === "verify" && step.command);
		if (verifier) return verifier;
	}

	return plan.find((step) => step.action === "final_answer");
}
