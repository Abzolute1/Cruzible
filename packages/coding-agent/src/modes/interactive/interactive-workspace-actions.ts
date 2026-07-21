import { rmSync } from "node:fs";
import {
	type ActivatedAutonomousWorkspace,
	diffAutonomousWorkspace,
	type PreparedAutonomousWorkspace,
	promoteAutonomousWorkspace,
} from "../../core/auton/workspace.js";
import {
	formatWorkspaceCommandSummary,
	formatWorkspaceDiffSummary,
	formatWorkspaceDiscardSummary,
	formatWorkspacePromotionSummary,
} from "./interactive-command-presenters.js";

type InteractiveWorkspaceState = ActivatedAutonomousWorkspace | PreparedAutonomousWorkspace;

export interface InteractiveWorkspaceCommandResult {
	warning?: string;
	output?: string;
	dim?: boolean;
	nextLastWorkspace?: PreparedAutonomousWorkspace | undefined;
}

export function executeInteractiveWorkspaceCommand(options: {
	text: string;
	activeWorkspace: ActivatedAutonomousWorkspace | undefined;
	lastWorkspace: PreparedAutonomousWorkspace | undefined;
}): InteractiveWorkspaceCommandResult {
	const arg = options.text.startsWith("/workspace ") ? options.text.slice(11).trim() : "";
	const workspace = options.activeWorkspace ?? options.lastWorkspace;

	if (arg === "diff") {
		if (!workspace) {
			return { warning: "No autonomous workspace is active or preserved in this session." };
		}

		return {
			output: formatWorkspaceDiffSummary(diffAutonomousWorkspace(workspace)),
		};
	}

	if (arg === "promote" || arg === "promote --delete") {
		if (options.activeWorkspace) {
			return { warning: "Cannot promote the autonomous workspace while it is active." };
		}
		if (!options.lastWorkspace) {
			return { warning: "No preserved autonomous workspace to promote." };
		}

		const deleteMissing = arg === "promote --delete";
		const promoted = promoteAutonomousWorkspace(options.lastWorkspace, { deleteMissing });
		return {
			output: formatWorkspacePromotionSummary(promoted, { deleteMissing }),
			dim: true,
		};
	}

	if (arg === "discard") {
		if (options.activeWorkspace) {
			return { warning: "Cannot discard the autonomous workspace while it is active." };
		}
		if (!options.lastWorkspace) {
			return { warning: "No preserved autonomous workspace to discard." };
		}

		const workspaceRoot = options.lastWorkspace.workspaceRoot;
		rmSync(workspaceRoot, { recursive: true, force: true });
		return {
			output: formatWorkspaceDiscardSummary(workspaceRoot),
			dim: true,
			nextLastWorkspace: undefined,
		};
	}

	if (!workspace) {
		return {
			output: "No autonomous workspace is active or preserved in this session.",
			dim: true,
		};
	}

	return {
		output: formatWorkspaceCommandSummary(workspace as InteractiveWorkspaceState, Boolean(options.activeWorkspace)),
	};
}
