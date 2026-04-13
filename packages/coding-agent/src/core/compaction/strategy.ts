/**
 * Strategy selector: which compaction layer to use based on current context tokens.
 *
 * Uses the existing CompactionPolicy from auton/compaction-policy.ts
 * to decide which layer fires.
 */

import type { CompactionPolicy, CompactionStrategy } from "../auton/compaction-policy.js";
import { getAutoCompactTrigger } from "../auton/compaction-policy.js";

/**
 * Selects the appropriate compaction strategy based on current context token usage
 * and the configured policy for this model's context window.
 *
 * Strategy priority (first applicable wins):
 * 1. micro — if tokens >= policy.microCompactThreshold
 * 2. snip — if tokens >= auto-compact trigger threshold (and "snip" is in strategies)
 * 3. auto — if tokens >= auto-compact trigger threshold
 *
 * @param currentTokens - Estimated current context token count
 * @param policy - The compaction policy for this model
 * @returns The strategy to use, or null if no compaction needed yet
 */
export function selectCompactionStrategy(currentTokens: number, policy: CompactionPolicy): CompactionStrategy | null {
	const autoTrigger = getAutoCompactTrigger(policy);

	// Iterate through policy.strategies array in order
	for (const strategy of policy.strategies) {
		switch (strategy) {
			case "micro":
				if (currentTokens >= policy.microCompactThreshold) {
					return "micro";
				}
				break;
			case "snip":
				if (currentTokens >= autoTrigger) {
					return "snip";
				}
				break;
			case "auto":
				if (currentTokens >= autoTrigger) {
					return "auto";
				}
				break;
		}
	}

	return null;
}
