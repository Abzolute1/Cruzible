import type { Model } from "@ag1/ai";

/**
 * Whether a model can consume image inputs, based on its declared metadata.
 * Registry metadata is the source of truth — models with missing declarations
 * can still be force-enabled via the visualTools setting ("on").
 */
export function modelSupportsVision(model: Model<any>): boolean {
	const inputTypes = (model.input ?? []) as string[];
	if (inputTypes.includes("image") || inputTypes.includes("image_url") || inputTypes.includes("vision")) {
		return true;
	}

	const capabilities = (model as { capabilities?: unknown }).capabilities;
	if (Array.isArray(capabilities) && capabilities.includes("vision")) return true;
	if ((capabilities as { vision?: boolean } | undefined)?.vision === true) return true;

	return false;
}
