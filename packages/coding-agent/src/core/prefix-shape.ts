import { createHash } from "node:crypto";

/**
 * Prefix-shape hashing for provider-side prompt-cache observability.
 *
 * DeepSeek-style prefix caching only pays when the request prefix is
 * byte-stable across turns. Hashing the parts of the prefix that influence
 * cache reuse (system prompt, tool schemas, history-rewrite version) and
 * comparing snapshots across turns lets us explain *why* a cache miss
 * happened. Modeled on reasonix's internal/agent/cache_shape.go.
 */

export type PrefixChangeReason = "system" | "tools" | "history_rewrite";

export interface PrefixShape {
	systemHash: string;
	toolsHash: string;
	prefixHash: string;
	logRewriteVersion: number;
	toolSchemaTokens: number;
}

/** Minimal structural view of a tool schema; satisfied by Tool/AgentTool. */
export interface ToolSchemaLike {
	name: string;
	description?: string;
	parameters?: unknown;
}

export interface PrefixShapeUsage {
	cacheReadTokens: number;
	inputTokens: number;
}

export interface PrefixShapeComparison {
	prefixHash: string;
	prefixChanged: boolean;
	reasons: PrefixChangeReason[];
	systemHash: string;
	toolsHash: string;
	logRewriteVersion: number;
	toolSchemaTokens: number;
	cacheReadTokens: number;
	inputTokens: number;
	cacheHitRatio: number | undefined;
}

/** JSON.stringify with recursively sorted object keys for stable hashing. */
function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value) ?? "undefined";
	}
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableStringify(item)).join(",")}]`;
	}
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
	return `{${entries.join(",")}}`;
}

function shortHash(value: unknown): string {
	return createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 16);
}

/**
 * Rough token count from character length (~4 chars per token works for
 * code-heavy JSON). A proper tokenizer would be more accurate, but for
 * diagnostic purposes a char-based estimate is sufficient.
 */
export function estimateTokens(s: string): number {
	if (s.length === 0) {
		return 0;
	}
	return Math.floor(s.length / 4);
}

/** cacheRead / (cacheRead + input); undefined when no tokens were reported. */
export function cacheHitRatio(usage: PrefixShapeUsage | undefined): number | undefined {
	if (!usage) {
		return undefined;
	}
	const total = usage.cacheReadTokens + usage.inputTokens;
	if (total <= 0) {
		return undefined;
	}
	return usage.cacheReadTokens / total;
}

function normalizeToolSchemas(schemas: ToolSchemaLike[]): ToolSchemaLike[] {
	return schemas
		.map((s) => ({ name: s.name, description: s.description, parameters: s.parameters }))
		.sort((a, b) => {
			if (a.name !== b.name) {
				return a.name < b.name ? -1 : 1;
			}
			const descA = a.description ?? "";
			const descB = b.description ?? "";
			if (descA !== descB) {
				return descA < descB ? -1 : 1;
			}
			const paramsA = stableStringify(a.parameters);
			const paramsB = stableStringify(b.parameters);
			return paramsA < paramsB ? -1 : paramsA > paramsB ? 1 : 0;
		});
}

/**
 * Snapshot the current prefix state. Tool schemas are normalized (sorted by
 * name/description/parameters with sorted JSON keys) so equivalent but
 * reordered schemas hash identically.
 */
export function capturePrefixShape(
	systemPrompt: string,
	toolSchemas: ToolSchemaLike[],
	historyRewriteVersion = 0,
): PrefixShape {
	const normalizedSchemas = normalizeToolSchemas(toolSchemas);
	const toolsJSON = stableStringify(normalizedSchemas);
	return {
		systemHash: shortHash(systemPrompt),
		toolsHash: shortHash(toolsJSON),
		prefixHash: shortHash({ system: systemPrompt, tools: toolsJSON }),
		logRewriteVersion: historyRewriteVersion,
		toolSchemaTokens: estimateTokens(toolsJSON),
	};
}

/**
 * Compare two prefix shapes, returning what changed between them. A missing
 * (first-turn) previous shape yields no reasons. Usage is passed through so
 * callers can correlate shape changes with the observed cache-hit ratio.
 */
export function comparePrefixShape(
	prev: PrefixShape | undefined,
	cur: PrefixShape,
	usage?: PrefixShapeUsage,
): PrefixShapeComparison {
	const reasons: PrefixChangeReason[] = [];
	if (prev) {
		if (prev.systemHash !== cur.systemHash) {
			reasons.push("system");
		}
		if (prev.toolsHash !== cur.toolsHash) {
			reasons.push("tools");
		}
		if (prev.logRewriteVersion !== cur.logRewriteVersion) {
			reasons.push("history_rewrite");
		}
	}
	return {
		prefixHash: cur.prefixHash,
		prefixChanged: reasons.length > 0,
		reasons,
		systemHash: cur.systemHash,
		toolsHash: cur.toolsHash,
		logRewriteVersion: cur.logRewriteVersion,
		toolSchemaTokens: cur.toolSchemaTokens,
		cacheReadTokens: usage?.cacheReadTokens ?? 0,
		inputTokens: usage?.inputTokens ?? 0,
		cacheHitRatio: cacheHitRatio(usage),
	};
}
