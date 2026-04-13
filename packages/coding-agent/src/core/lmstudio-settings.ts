/**
 * LM Studio settings integration.
 *
 * Reads user-configured context length from LM Studio's settings file.
 * This provides the actual configured value, not the GGUF theoretical max.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Parsed LM Studio settings for context length */
interface LmStudioContextSettings {
	/** User-configured context length in tokens, or undefined if not found */
	contextLength: number | undefined;
	/** Raw settings object for future extension */
	rawSettings: Record<string, unknown>;
}

/**
 * Read the user-configured context length from LM Studio settings.
 *
 * LM Studio stores its configuration in ~/.lmstudio/settings.json
 * The relevant field is:
 *   "defaultContextLength": { "type": "custom", "value": 44000 }
 *
 * @returns Object with contextLength (tokens) or undefined if not found/configured
 */
export function readLmStudioSettings(): LmStudioContextSettings {
	const lmStudioDir = process.env.LM_STUDIO_CONFIG_DIR
		? process.env.LM_STUDIO_CONFIG_DIR
		: join(process.env.HOME || process.env.USERPROFILE || "", ".lmstudio");

	const settingsPath = join(lmStudioDir, "settings.json");

	if (!existsSync(settingsPath)) {
		return { contextLength: undefined, rawSettings: {} };
	}

	try {
		const content = readFileSync(settingsPath, "utf-8");
		const settings = JSON.parse(content);

		const contextLengthConfig = settings.defaultContextLength;

		if (!contextLengthConfig || typeof contextLengthConfig !== "object") {
			return { contextLength: undefined, rawSettings: settings };
		}

		// LM Studio uses { "type": "custom" | "auto" | "max", "value": number }
		if (contextLengthConfig.type === "custom" && typeof contextLengthConfig.value === "number") {
			return {
				contextLength: Math.round(contextLengthConfig.value),
				rawSettings: settings,
			};
		}

		// For "auto" or "max" types, we don't have a specific value
		// Return undefined to fall back to model default
		return { contextLength: undefined, rawSettings: settings };
	} catch (error) {
		// If we can't read or parse the file, silently fall back
		console.error(`[LM Studio] Failed to read settings: ${error instanceof Error ? error.message : String(error)}`);
		return { contextLength: undefined, rawSettings: {} };
	}
}

/**
 * Get the effective context window for a model.
 *
 * Priority order:
 * 1. Custom context window set via /set-context (passed as customOverride)
 * 2. LM Studio user-configured value (if provider is "local" and settings exist)
 * 3. Model's hardcoded default contextWindow
 *
 * @param model The model object
 * @param customOverride Optional custom override (from /set-context)
 * @returns Effective context window in tokens
 */
export function getEffectiveContextWindow(
	model: { provider: string; id: string; contextWindow: number },
	customOverride?: number,
): number {
	// Priority 1: Custom override from /set-context
	if (customOverride !== undefined) {
		return customOverride;
	}

	// Priority 2: LM Studio user-configured value (only for local provider)
	if (model.provider === "local") {
		const settings = readLmStudioSettings();
		if (settings.contextLength !== undefined) {
			return settings.contextLength;
		}
	}

	// Priority 3: Model's hardcoded default
	return model.contextWindow;
}
