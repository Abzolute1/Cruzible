import { MissingSessionCwdError } from "../../core/session-cwd.js";

export interface InteractiveRuntimeTransitionResult {
	cancelled: boolean;
}

export async function performInteractiveRuntimeReplacement<
	TResult extends InteractiveRuntimeTransitionResult,
>(options: {
	clearTransientUi: () => void;
	execute: () => Promise<TResult>;
	applyRuntimeSessionChange: () => Promise<void>;
	renderCurrentSessionState: () => void;
	handleFatalRuntimeError: (prefix: string, error: unknown) => Promise<never>;
	fatalPrefix: string;
	afterApplied?: (result: TResult) => Promise<void> | void;
	onCancelled?: (result: TResult) => Promise<void> | void;
}): Promise<TResult> {
	options.clearTransientUi();
	try {
		const result = await options.execute();
		if (result.cancelled) {
			await options.onCancelled?.(result);
			return result;
		}
		await options.applyRuntimeSessionChange();
		options.renderCurrentSessionState();
		await options.afterApplied?.(result);
		return result;
	} catch (error: unknown) {
		return options.handleFatalRuntimeError(options.fatalPrefix, error);
	}
}

export async function performInteractiveRuntimeTransition<TResult extends InteractiveRuntimeTransitionResult>(options: {
	clearTransientUi: () => void;
	execute: (cwdOverride?: string) => Promise<TResult>;
	promptForMissingSessionCwd?: (error: MissingSessionCwdError) => Promise<string | undefined>;
	applyRuntimeSessionChange: () => Promise<void>;
	renderCurrentSessionState: () => void;
	showStatus: (message: string) => void;
	handleFatalRuntimeError: (prefix: string, error: unknown) => Promise<never>;
	successMessage: (result: TResult, usedFallbackCwd: boolean) => string;
	cancelMessage?: string;
	fatalPrefix: string;
	afterApplied?: (result: TResult) => Promise<void> | void;
}): Promise<TResult | undefined> {
	options.clearTransientUi();

	const applyResult = async (result: TResult, usedFallbackCwd: boolean): Promise<TResult> => {
		await options.applyRuntimeSessionChange();
		options.renderCurrentSessionState();
		await options.afterApplied?.(result);
		options.showStatus(options.successMessage(result, usedFallbackCwd));
		return result;
	};

	try {
		const result = await options.execute();
		if (result.cancelled) {
			if (options.cancelMessage) {
				options.showStatus(options.cancelMessage);
			}
			return result;
		}
		return await applyResult(result, false);
	} catch (error: unknown) {
		if (error instanceof MissingSessionCwdError && options.promptForMissingSessionCwd) {
			const selectedCwd = await options.promptForMissingSessionCwd(error);
			if (!selectedCwd) {
				if (options.cancelMessage) {
					options.showStatus(options.cancelMessage);
				}
				return undefined;
			}
			const retryResult = await options.execute(selectedCwd);
			if (retryResult.cancelled) {
				if (options.cancelMessage) {
					options.showStatus(options.cancelMessage);
				}
				return retryResult;
			}
			return await applyResult(retryResult, true);
		}
		return options.handleFatalRuntimeError(options.fatalPrefix, error);
	}
}
