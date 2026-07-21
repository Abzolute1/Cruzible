import { buildToolOutcomeFingerprint, normalizeToolName, type ToolOutcome } from "./auton/nudges/types.js";

export interface CachedToolFact {
	tool: string;
	success: boolean;
	file?: string;
	detail?: string;
	estimatedTokens?: number;
	fingerprint: string;
	hits: number;
	lastSeenAt: number;
}

export interface ToolFactCacheOptions {
	maxFacts?: number;
	ttlMs?: number;
}

const DEFAULT_MAX_FACTS = 24;
const DEFAULT_TTL_MS = 10 * 60_000;
const REUSABLE_TOOLS = new Set(["read", "grep", "find", "glob", "ls", "websearch", "webfetch", "bash"]);
const MUTATION_TOOLS = new Set(["edit", "write", "notebookedit", "notebook-edit"]);

export class ToolFactCache {
	private readonly maxFacts: number;
	private readonly ttlMs: number;
	private facts = new Map<string, CachedToolFact>();

	constructor(options: ToolFactCacheOptions = {}) {
		this.maxFacts = options.maxFacts ?? DEFAULT_MAX_FACTS;
		this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
	}

	record(outcome: ToolOutcome, now: number = Date.now()): void {
		this.prune(now);
		const tool = normalizeToolName(outcome.tool);
		if (outcome.file && MUTATION_TOOLS.has(tool)) {
			this.invalidateFile(outcome.file);
		}
		if (!outcome.success || !REUSABLE_TOOLS.has(tool)) return;

		const fingerprint = buildToolOutcomeFingerprint(outcome);
		const existing = this.facts.get(fingerprint);
		if (existing) {
			existing.hits += 1;
			existing.lastSeenAt = now;
			existing.estimatedTokens = outcome.estimatedTokens ?? existing.estimatedTokens;
			return;
		}

		this.facts.set(fingerprint, {
			tool,
			success: outcome.success,
			file: outcome.file,
			detail: outcome.detail,
			estimatedTokens: outcome.estimatedTokens,
			fingerprint,
			hits: 1,
			lastSeenAt: now,
		});
		this.trim();
	}

	getReusableFacts(now: number = Date.now(), limit: number = 6): CachedToolFact[] {
		this.prune(now);
		return [...this.facts.values()].sort((left, right) => right.lastSeenAt - left.lastSeenAt).slice(0, limit);
	}

	invalidateFile(file: string): void {
		const normalized = normalizePath(file);
		for (const [fingerprint, fact] of this.facts.entries()) {
			if (fact.file && normalizePath(fact.file) === normalized) {
				this.facts.delete(fingerprint);
			}
		}
	}

	clear(): void {
		this.facts.clear();
	}

	private prune(now: number): void {
		for (const [fingerprint, fact] of this.facts.entries()) {
			if (now - fact.lastSeenAt > this.ttlMs) {
				this.facts.delete(fingerprint);
			}
		}
	}

	private trim(): void {
		if (this.facts.size <= this.maxFacts) return;
		const ordered = [...this.facts.entries()].sort((left, right) => left[1].lastSeenAt - right[1].lastSeenAt);
		for (const [fingerprint] of ordered.slice(0, this.facts.size - this.maxFacts)) {
			this.facts.delete(fingerprint);
		}
	}
}

export function buildToolFactCachePromptAddendum(
	cache: ToolFactCache,
	options: { limit?: number; now?: number } = {},
): string | undefined {
	const facts = cache.getReusableFacts(options.now ?? Date.now(), options.limit ?? 5);
	if (facts.length === 0) return undefined;
	const lines = [
		"Reusable facts from prior tool calls are available in runtime memory. Prefer using these cached results instead of re-running identical reads, greps, finds, ls, web searches, or fetches.",
	];
	for (const fact of facts) {
		const target = fact.file ?? fact.detail;
		const tokenHint =
			fact.estimatedTokens && fact.estimatedTokens > 0 ? ` (~${formatTokenCount(fact.estimatedTokens)} result)` : "";
		lines.push(`- ${fact.tool}${target ? `: ${target}` : ""}${tokenHint}`);
	}
	lines.push(
		"Only re-execute a cached tool if the underlying data may have changed or you need a specific detail not covered by the prior result.",
	);
	return lines.join("\n");
}

function normalizePath(file: string): string {
	return file.replace(/\\/g, "/").toLowerCase();
}

function formatTokenCount(tokens: number): string {
	if (tokens < 1000) return `${tokens} tokens`;
	return `${Math.round(tokens / 100) / 10}k tokens`;
}
