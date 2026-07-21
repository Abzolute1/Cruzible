import { parse as partialParse } from "partial-json";

/**
 * Attempts to parse potentially incomplete JSON during streaming.
 * Always returns a valid object, even if the JSON is incomplete.
 *
 * @param partialJson The partial JSON string from streaming
 * @returns Parsed object or empty object if parsing fails
 */
export function parseStreamingJson<T = any>(partialJson: string | undefined): T {
	if (!partialJson || partialJson.trim() === "") {
		return {} as T;
	}

	// Try standard parsing first (fastest for complete JSON)
	try {
		return JSON.parse(partialJson) as T;
	} catch {
		// Try partial-json for incomplete JSON
		try {
			const result = partialParse(partialJson);
			return (result ?? {}) as T;
		} catch {
			// If all parsing fails, return empty object
			return {} as T;
		}
	}
}

/**
 * Strictly parses complete tool-call argument JSON at stream finalization.
 * Unlike parseStreamingJson, this never closes open strings or guesses, so a
 * truncated stream is reported as malformed instead of silently shortened.
 *
 * @param json The final, complete JSON string for the tool-call arguments
 * @returns The parsed arguments, with `malformed: true` (and empty arguments)
 *          when strict parsing fails
 */
export function parseFinalToolCallJson<T = any>(json: string | undefined): { arguments: T; malformed: boolean } {
	if (!json || json.trim() === "") {
		return { arguments: {} as T, malformed: false };
	}

	try {
		return { arguments: JSON.parse(json) as T, malformed: false };
	} catch {
		return { arguments: {} as T, malformed: true };
	}
}
