export type InteractiveContextWindowCommandAction =
	| { type: "show-dialog" }
	| { type: "clear" }
	| { type: "set"; value: number }
	| { type: "invalid"; message: string };

export function resolveInteractiveContextWindowCommand(
	arg: string | undefined,
): InteractiveContextWindowCommandAction {
	if (!arg) {
		return { type: "show-dialog" };
	}
	if (arg === "auto" || arg === "reset") {
		return { type: "clear" };
	}

	const value = Number.parseInt(arg, 10);
	if (Number.isNaN(value) || value < 1024) {
		return {
			type: "invalid",
			message: "Invalid number - usage: /set-context <tokens>, e.g. /set-context 44000",
		};
	}

	return {
		type: "set",
		value,
	};
}

export function resolveInteractiveContextWindowInput(
	raw: string | undefined,
): Exclude<InteractiveContextWindowCommandAction, { type: "show-dialog" }> {
	if (raw === undefined) {
		return { type: "clear" };
	}

	const value = Number.parseInt(raw, 10);
	if (Number.isNaN(value) || value < 1024) {
		return {
			type: "invalid",
			message: `Invalid value: "${raw}". Enter a number >= 1024.`,
		};
	}

	return {
		type: "set",
		value,
	};
}
