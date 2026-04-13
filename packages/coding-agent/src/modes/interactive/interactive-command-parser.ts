export type InteractiveBuiltinCommand =
	| { kind: "settings" }
	| { kind: "scoped-models" }
	| { kind: "model"; searchTerm?: string }
	| { kind: "export"; text: string }
	| { kind: "import"; text: string }
	| { kind: "share" }
	| { kind: "copy" }
	| { kind: "name"; text: string }
	| { kind: "session" }
	| { kind: "research"; text: string }
	| { kind: "debug" }
	| { kind: "workspace"; text: string }
	| { kind: "changelog" }
	| { kind: "hotkeys" }
	| { kind: "fork" }
	| { kind: "tree" }
	| { kind: "login" }
	| { kind: "logout" }
	| { kind: "new" }
	| { kind: "compact"; customInstructions?: string }
	| { kind: "set-context"; arg?: string }
	| { kind: "reload" }
	| { kind: "arminsayshi" }
	| { kind: "resume" }
	| { kind: "quit" };

function matchesCommandWithOptionalArg(text: string, command: string): boolean {
	return text === command || text.startsWith(`${command} `);
}

export function parseInteractiveBuiltinCommand(text: string): InteractiveBuiltinCommand | undefined {
	if (text === "/settings") return { kind: "settings" };
	if (text === "/scoped-models") return { kind: "scoped-models" };

	if (matchesCommandWithOptionalArg(text, "/model")) {
		return {
			kind: "model",
			searchTerm: text.startsWith("/model ") ? text.slice(7).trim() : undefined,
		};
	}

	if (matchesCommandWithOptionalArg(text, "/export")) return { kind: "export", text };
	if (matchesCommandWithOptionalArg(text, "/import")) return { kind: "import", text };
	if (text === "/share") return { kind: "share" };
	if (text === "/copy") return { kind: "copy" };
	if (matchesCommandWithOptionalArg(text, "/name")) return { kind: "name", text };
	if (text === "/session") return { kind: "session" };
	if (matchesCommandWithOptionalArg(text, "/research")) return { kind: "research", text };
	if (text === "/debug") return { kind: "debug" };
	if (matchesCommandWithOptionalArg(text, "/workspace")) return { kind: "workspace", text };
	if (text === "/changelog") return { kind: "changelog" };
	if (text === "/hotkeys") return { kind: "hotkeys" };
	if (text === "/fork") return { kind: "fork" };
	if (text === "/tree") return { kind: "tree" };
	if (text === "/login") return { kind: "login" };
	if (text === "/logout") return { kind: "logout" };
	if (text === "/new") return { kind: "new" };

	if (matchesCommandWithOptionalArg(text, "/compact")) {
		return {
			kind: "compact",
			customInstructions: text.startsWith("/compact ") ? text.slice(9).trim() : undefined,
		};
	}

	if (matchesCommandWithOptionalArg(text, "/set-context")) {
		return {
			kind: "set-context",
			arg: text.startsWith("/set-context ") ? text.slice(13).trim() : undefined,
		};
	}

	if (text === "/reload") return { kind: "reload" };
	if (text === "/arminsayshi") return { kind: "arminsayshi" };
	if (text === "/resume") return { kind: "resume" };
	if (text === "/quit") return { kind: "quit" };
	return undefined;
}
