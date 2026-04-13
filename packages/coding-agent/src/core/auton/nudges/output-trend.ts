// Auton — Output trend tracking
// Ported from Kairos src/agent/nudges.ts (OutputTrendTracker class)

export const DIMINISHING_THRESHOLD = 500;
export const MAX_DIMINISHING_CONTINUATIONS = 3;

/**
 * Tracks output tokens across continuation turns to detect diminishing output.
 */
export class OutputTrendTracker {
	private deltas: number[] = [];

	record(turnOutputTokens: number): void {
		this.deltas.push(turnOutputTokens);
	}

	/** Returns true if the last N continuations all produced below threshold. */
	isDiminishing(): boolean {
		if (this.deltas.length < MAX_DIMINISHING_CONTINUATIONS) return false;
		const recent = this.deltas.slice(-MAX_DIMINISHING_CONTINUATIONS);
		return recent.every((d) => d < DIMINISHING_THRESHOLD);
	}

	/** Reset after a non-continuation turn. */
	reset(): void {
		this.deltas = [];
	}

	/** Get the last recorded output token count. */
	getLastOutputTokens(): number {
		if (this.deltas.length === 0) return 0;
		return this.deltas[this.deltas.length - 1];
	}

	/** Check if the most recent turn produced any output. */
	hasRecentOutput(): boolean {
		return this.deltas.length > 0 && this.deltas[this.deltas.length - 1] > 0;
	}
}
