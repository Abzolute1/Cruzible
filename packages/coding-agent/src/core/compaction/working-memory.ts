import type { AgentMessage } from "@ag1/agent-core";
import type { AssistantMessage } from "@ag1/ai";
import type { CompactionEntry, SessionEntry } from "../session-manager.js";
import { computeFileLists, type FileOperations } from "./utils.js";

export interface WorkingMemoryLedger {
	goals: string[];
	constraints: string[];
	readFiles: string[];
	modifiedFiles: string[];
	commandsRun: string[];
	failedAttempts: string[];
	verification: Array<{
		command: string;
		status: "passed" | "failed" | "unknown";
		detail?: string;
	}>;
	nextSteps: string[];
	openQuestions: string[];
}

const MAX_ITEMS = 12;
const MAX_TEXT = 220;
const CONSTRAINT_PATTERN =
	/\b(must|should|need(?:s)? to|required|requirement|constraint|only|never|do not|don't|avoid|stay inside|verify|acceptance|definition of done)\b/i;
const NEXT_STEP_PATTERN = /\b(next|remaining|todo|follow[- ]?up|still need|need(?:s)? to|should now|continue by)\b/i;
const FAILURE_PATTERN =
	/\b(error|failed|failure|exception|traceback|cannot|can't|enoent|exit code [1-9]|timed out|timeout)\b/i;
const PASS_PATTERN = /\b(pass(?:ed|ing)?|success|ok|exit code 0|0 failed|all tests passed)\b/i;
const VERIFICATION_COMMAND_PATTERN =
	/\b(?:npm|pnpm|yarn|bun)\s+(?:test|run\s+(?:test|lint|typecheck|build|check)|lint|typecheck|build|check)\b|\b(?:node\s+--test|vitest|jest|pytest|cargo test|go test|playwright test|eslint|tsc|make\s+(?:test|lint|build|check))\b/i;

export function emptyWorkingMemory(): WorkingMemoryLedger {
	return {
		goals: [],
		constraints: [],
		readFiles: [],
		modifiedFiles: [],
		commandsRun: [],
		failedAttempts: [],
		verification: [],
		nextSteps: [],
		openQuestions: [],
	};
}

export function getPreviousWorkingMemory(
	entries: SessionEntry[],
	prevCompactionIndex: number,
): WorkingMemoryLedger | undefined {
	if (prevCompactionIndex < 0) return undefined;
	const prevCompaction = entries[prevCompactionIndex] as CompactionEntry;
	if (prevCompaction.fromHook || !prevCompaction.details || typeof prevCompaction.details !== "object")
		return undefined;
	const candidate = (prevCompaction.details as { workingMemory?: unknown }).workingMemory;
	return isWorkingMemoryLedger(candidate) ? candidate : undefined;
}

export function extractWorkingMemory(options: {
	messages: AgentMessage[];
	previous?: WorkingMemoryLedger;
	fileOps?: FileOperations;
}): WorkingMemoryLedger {
	const memory = cloneWorkingMemory(options.previous);
	let pendingCommand: string | undefined;

	for (const message of options.messages) {
		if (message.role === "user") {
			const text = getMessageText(message);
			addUnique(memory.goals, compactText(text));
			for (const fragment of splitFragments(text)) {
				if (CONSTRAINT_PATTERN.test(fragment)) addUnique(memory.constraints, compactText(fragment));
				if (fragment.includes("?")) addUnique(memory.openQuestions, compactText(fragment));
			}
			continue;
		}

		if (message.role === "assistant") {
			const assistant = message as AssistantMessage;
			for (const block of assistant.content) {
				if (block.type === "text") {
					for (const fragment of splitFragments(block.text)) {
						if (NEXT_STEP_PATTERN.test(fragment)) addUnique(memory.nextSteps, compactText(fragment));
						if (fragment.includes("?") || /\b(unknown|unclear|blocked|blocker)\b/i.test(fragment)) {
							addUnique(memory.openQuestions, compactText(fragment));
						}
					}
				} else if (block.type === "toolCall") {
					const args = block.arguments as Record<string, unknown>;
					const path = typeof args.path === "string" ? args.path : undefined;
					if (path && block.name === "read") addUnique(memory.readFiles, path);
					if (path && (block.name === "edit" || block.name === "write")) addUnique(memory.modifiedFiles, path);
					if (block.name === "bash" && typeof args.command === "string") {
						pendingCommand = compactText(args.command);
						addUnique(memory.commandsRun, pendingCommand);
						if (VERIFICATION_COMMAND_PATTERN.test(pendingCommand)) {
							upsertVerification(memory, pendingCommand, "unknown");
						}
					}
				}
			}
			continue;
		}

		if (message.role === "toolResult") {
			const resultText = getMessageText(message);
			if (pendingCommand && FAILURE_PATTERN.test(resultText)) {
				addUnique(memory.failedAttempts, `${pendingCommand}: ${compactText(resultText)}`);
				if (VERIFICATION_COMMAND_PATTERN.test(pendingCommand)) {
					upsertVerification(memory, pendingCommand, "failed", compactText(resultText));
				}
			} else if (
				pendingCommand &&
				VERIFICATION_COMMAND_PATTERN.test(pendingCommand) &&
				PASS_PATTERN.test(resultText)
			) {
				upsertVerification(memory, pendingCommand, "passed", compactText(resultText));
			}
			pendingCommand = undefined;
		}
	}

	if (options.fileOps) {
		const { readFiles, modifiedFiles } = computeFileLists(options.fileOps);
		for (const file of readFiles) addUnique(memory.readFiles, file);
		for (const file of modifiedFiles) addUnique(memory.modifiedFiles, file);
	}

	return normalizeWorkingMemory(memory);
}

export function formatWorkingMemoryForSummary(memory: WorkingMemoryLedger): string {
	const sections: string[] = [];
	addListSection(sections, "goals", memory.goals);
	addListSection(sections, "constraints", memory.constraints);
	addListSection(sections, "read-files", memory.readFiles);
	addListSection(sections, "modified-files", memory.modifiedFiles);
	addListSection(sections, "commands-run", memory.commandsRun);
	addListSection(sections, "failed-attempts", memory.failedAttempts);
	if (memory.verification.length > 0) {
		sections.push(
			`verification:\n${memory.verification
				.map((item) => `- ${item.status}: ${item.command}${item.detail ? ` — ${item.detail}` : ""}`)
				.join("\n")}`,
		);
	}
	addListSection(sections, "next-steps", memory.nextSteps);
	addListSection(sections, "open-questions", memory.openQuestions);
	if (sections.length === 0) return "";
	return `\n\n<working-memory>\n${sections.join("\n\n")}\n</working-memory>`;
}

export function formatWorkingMemoryPrimaryState(memory: WorkingMemoryLedger): string {
	const formatted = formatWorkingMemoryForSummary(memory).trim();
	if (!formatted) return "";
	return `## Deterministic Working Memory\n\n${formatted}\n\nTreat this ledger as the primary compacted state for goals, constraints, touched files, verification, open questions, and next steps.`;
}

function cloneWorkingMemory(previous: WorkingMemoryLedger | undefined): WorkingMemoryLedger {
	if (!previous) return emptyWorkingMemory();
	return {
		goals: [...previous.goals],
		constraints: [...previous.constraints],
		readFiles: [...previous.readFiles],
		modifiedFiles: [...previous.modifiedFiles],
		commandsRun: [...previous.commandsRun],
		failedAttempts: [...previous.failedAttempts],
		verification: previous.verification.map((item) => ({ ...item })),
		nextSteps: [...previous.nextSteps],
		openQuestions: [...previous.openQuestions],
	};
}

function normalizeWorkingMemory(memory: WorkingMemoryLedger): WorkingMemoryLedger {
	return {
		goals: trimList(memory.goals),
		constraints: trimList(memory.constraints),
		readFiles: trimList(memory.readFiles),
		modifiedFiles: trimList(memory.modifiedFiles),
		commandsRun: trimList(memory.commandsRun),
		failedAttempts: trimList(memory.failedAttempts),
		verification: memory.verification.slice(-MAX_ITEMS),
		nextSteps: trimList(memory.nextSteps),
		openQuestions: trimList(memory.openQuestions),
	};
}

function isWorkingMemoryLedger(value: unknown): value is WorkingMemoryLedger {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<Record<keyof WorkingMemoryLedger, unknown>>;
	return (
		Array.isArray(candidate.goals) &&
		Array.isArray(candidate.constraints) &&
		Array.isArray(candidate.readFiles) &&
		Array.isArray(candidate.modifiedFiles) &&
		Array.isArray(candidate.commandsRun) &&
		Array.isArray(candidate.failedAttempts) &&
		Array.isArray(candidate.verification) &&
		Array.isArray(candidate.nextSteps) &&
		Array.isArray(candidate.openQuestions)
	);
}

function addListSection(sections: string[], label: string, values: string[]): void {
	if (values.length === 0) return;
	sections.push(`${label}:\n${values.map((value) => `- ${value}`).join("\n")}`);
}

function upsertVerification(
	memory: WorkingMemoryLedger,
	command: string,
	status: "passed" | "failed" | "unknown",
	detail?: string,
): void {
	const existing = memory.verification.find((item) => item.command === command);
	if (existing) {
		existing.status = status;
		if (detail) existing.detail = detail;
		return;
	}
	memory.verification.push({ command, status, ...(detail ? { detail } : {}) });
}

function getMessageText(message: AgentMessage): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (!block || typeof block !== "object") return "";
			if ((block as { type?: string }).type === "text") return String((block as { text?: string }).text ?? "");
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function splitFragments(text: string): string[] {
	return text
		.split(/\n+|(?<=[.!?])\s+/)
		.map((fragment) => fragment.trim())
		.filter(Boolean);
}

function compactText(text: string): string {
	return text.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
}

function addUnique(values: string[], value: string): void {
	if (!value) return;
	if (values.includes(value)) return;
	values.push(value);
}

function trimList(values: string[]): string[] {
	return values.filter(Boolean).slice(-MAX_ITEMS);
}
