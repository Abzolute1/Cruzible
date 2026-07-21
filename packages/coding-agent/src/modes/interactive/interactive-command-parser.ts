type PlanAction =
	| "toggle"
	| "show"
	| "history"
	| "routes"
	| "review"
	| "interview"
	| "answer"
	| "accept"
	| "reject"
	| "execute"
	| "next"
	| "step"
	| "clear"
	| "revise"
	| "done"
	| "reopen"
	| "planner-model"
	| "executor-model"
	| "verifier-model";

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
	| { kind: "plan"; action: PlanAction; feedback?: string; revision?: number; stepIndex?: number; modelRef?: string }
	| { kind: "todo" }
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
	| { kind: "verbose" }
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
	const planCommand = parsePlanCommand(text);
	if (planCommand) return planCommand;
	if (matchesCommandWithOptionalArg(text, "/research")) return { kind: "research", text };
	if (text === "/debug") return { kind: "debug" };
	if (matchesCommandWithOptionalArg(text, "/workspace")) return { kind: "workspace", text };
	if (text === "/changelog") return { kind: "changelog" };
	if (text === "/hotkeys") return { kind: "hotkeys" };
	if (text === "/todo" || text === "/todos") return { kind: "todo" };
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
	if (text === "/verbose") return { kind: "verbose" };
	if (text === "/quit") return { kind: "quit" };
	return undefined;
}

function parsePlanCommand(text: string): Extract<InteractiveBuiltinCommand, { kind: "plan" }> | undefined {
	if (text === "/plan") return { kind: "plan", action: "toggle" };

	const match = text.match(/^\/plan(?:\s+([a-z-]+))?(?:\s+(.+))?$/i);
	if (!match) return undefined;

	const action = (match[1] ?? "toggle").toLowerCase() as PlanAction;
	const arg = match[2]?.trim();

	switch (action) {
		case "toggle":
			return arg ? undefined : { kind: "plan", action: "toggle" };
		case "show":
		case "reject":
		case "accept":
		case "execute":
		case "next":
		case "clear": {
			const revision = parseOptionalRevision(arg);
			return arg !== undefined && revision === undefined ? undefined : { kind: "plan", action, revision };
		}
		case "history":
			return arg ? undefined : { kind: "plan", action: "history" };
		case "routes":
			return arg ? undefined : { kind: "plan", action: "routes" };
		case "review":
			return arg ? undefined : { kind: "plan", action: "review" };
		case "interview": {
			const revision = parseOptionalRevision(arg);
			return arg !== undefined && revision === undefined
				? undefined
				: { kind: "plan", action: "interview", revision };
		}
		case "planner-model":
		case "executor-model":
		case "verifier-model":
			return { kind: "plan", action, modelRef: arg };
		case "answer": {
			if (!arg) return { kind: "plan", action: "answer", feedback: undefined };
			const revisionMatch = arg.match(/^(\d+)\s+(.+)$/);
			if (revisionMatch) {
				return {
					kind: "plan",
					action: "answer",
					revision: Number.parseInt(revisionMatch[1]!, 10),
					feedback: revisionMatch[2]!.trim(),
				};
			}
			return { kind: "plan", action: "answer", feedback: arg };
		}
		case "revise": {
			if (!arg) return { kind: "plan", action: "revise", feedback: undefined };
			const revisionMatch = arg.match(/^(\d+)\s+(.+)$/);
			if (revisionMatch) {
				return {
					kind: "plan",
					action: "revise",
					revision: Number.parseInt(revisionMatch[1]!, 10),
					feedback: revisionMatch[2]!.trim(),
				};
			}
			return { kind: "plan", action: "revise", feedback: arg };
		}
		case "done":
		case "reopen": {
			const target = parsePlanStepTarget(arg);
			if (!target) return undefined;
			return { kind: "plan", action, revision: target.revision, stepIndex: target.stepIndex };
		}
		case "step": {
			const target = parsePlanStepTarget(arg);
			if (!target) return undefined;
			return { kind: "plan", action: "step", revision: target.revision, stepIndex: target.stepIndex };
		}
		default:
			return undefined;
	}
}

function parseOptionalRevision(value: string | undefined): number | undefined {
	if (!value) return undefined;
	if (!/^\d+$/.test(value)) return undefined;
	return Number.parseInt(value, 10);
}

function parsePlanStepTarget(value: string | undefined): { revision?: number; stepIndex: number } | undefined {
	if (!value) return undefined;
	const parts = value.trim().split(/\s+/);
	if (parts.length === 1) {
		const step = parseOptionalRevision(parts[0]);
		if (step === undefined || step <= 0) return undefined;
		return { stepIndex: step - 1 };
	}
	if (parts.length === 2) {
		const revision = parseOptionalRevision(parts[0]);
		const step = parseOptionalRevision(parts[1]);
		if (revision === undefined || step === undefined || step <= 0) return undefined;
		return { revision, stepIndex: step - 1 };
	}
	return undefined;
}
