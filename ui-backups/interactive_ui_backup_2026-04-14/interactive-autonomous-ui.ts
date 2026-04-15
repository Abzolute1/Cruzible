import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { RuntimeStabilizationProfile } from "../../core/runtime-health.js";
import type { InteractivePlanArtifact } from "./interactive-plan-artifacts.js";
import { summarizeInteractivePlanForModeLine } from "./interactive-plan-review-ui.js";
import { theme } from "./theme/theme.js";

const AUTONOMOUS_BROAD_SCOPE_DIR_NAMES = new Set([
	"desktop",
	"documents",
	"downloads",
	"pictures",
	"videos",
	"music",
]);

const AUTONOMOUS_PROJECT_MARKERS = [
	".git",
	"package.json",
	"pnpm-workspace.yaml",
	"pyproject.toml",
	"requirements.txt",
	"Cargo.toml",
	"go.mod",
	"pom.xml",
	"build.gradle",
	"build.gradle.kts",
	"Makefile",
	"README.md",
];

export function getAutonomousScopeGuardReason(cwd: string): string | undefined {
	const normalizedCwd = path.resolve(cwd);
	const homeDir = path.resolve(os.homedir());
	if (normalizedCwd === path.parse(normalizedCwd).root) {
		return "Autonomous mode cannot run from the filesystem root. Change into a specific project directory first.";
	}
	if (normalizedCwd === homeDir) {
		return "Autonomous mode cannot run from your home directory. Change into a specific project directory first.";
	}

	const relativeToHome = path.relative(homeDir, normalizedCwd);
	if (relativeToHome && !relativeToHome.startsWith("..")) {
		const segments = relativeToHome.split(path.sep).filter(Boolean);
		const topLevel = segments[0]?.toLowerCase();
		const isBroadPersonalRoot = segments.length === 1;
		if (
			topLevel &&
			isBroadPersonalRoot &&
			AUTONOMOUS_BROAD_SCOPE_DIR_NAMES.has(topLevel) &&
			!hasProjectMarkers(normalizedCwd)
		) {
			return `Autonomous mode cannot run from broad personal directories like ${segments[0]}. Change into a specific project directory first.`;
		}
	}

	return undefined;
}

export function summarizeAutonomousLiveStatus(status: string | undefined): string | undefined {
	if (!status) return undefined;
	const normalized = status.replace(/^Autonomous:\s*/i, "");
	const summary = normalized.split("|")[0]?.trim();
	return summary || undefined;
}

export function formatPersistentModeLine(options: {
	autonomousMode: boolean;
	planningMode?: boolean;
	latestPlanArtifact?: InteractivePlanArtifact;
	lastAutonomousWorkspace: unknown;
	profile: RuntimeStabilizationProfile;
	currentCwd: string;
	lastAutonomousLiveStatus?: string;
}): string {
	const scopeGuardReason = getAutonomousScopeGuardReason(options.currentCwd);
	if (options.planningMode) {
		const details = ["read-only planning", "edits and bash blocked"];
		details.push(...summarizeInteractivePlanForModeLine(options.latestPlanArtifact, true));
		if (options.lastAutonomousWorkspace) {
			details.push("sandbox preserved");
		}
		if (scopeGuardReason) {
			details.push("autonomy unavailable from current cwd");
		}
		if (options.profile.level !== "none") {
			details.push(`${options.profile.level} runtime stabilization`);
		}
		return `${theme.bold("Planning Mode")} ${theme.fg("dim", `• ${details.join(" • ")}`)}`;
	}

	if (!options.autonomousMode) {
		const details = ["approvals required for edits and shell"];
		details.push(...summarizeInteractivePlanForModeLine(options.latestPlanArtifact, false));
		if (options.lastAutonomousWorkspace) {
			details.push("sandbox preserved");
		}
		if (scopeGuardReason) {
			details.push("autonomy unavailable from current cwd");
		}
		if (options.profile.level !== "none") {
			details.push(`${options.profile.level} runtime stabilization`);
		}
		return `${theme.bold("Interactive Mode")} ${theme.fg("dim", `• ${details.join(" • ")}`)}`;
	}

	const details = ["isolated workspace"];
	const liveStatus = summarizeAutonomousLiveStatus(options.lastAutonomousLiveStatus);
	if (liveStatus) {
		details.push(liveStatus);
	}
	if (options.profile.level !== "none") {
		details.push(`${options.profile.level} stabilization`);
	}
	return `${theme.bold("Autonomous Mode")} ${theme.fg("dim", `• ${details.join(" • ")}`)}`;
}

function hasProjectMarkers(cwd: string): boolean {
	try {
		return AUTONOMOUS_PROJECT_MARKERS.some((marker) => fs.existsSync(path.join(cwd, marker)));
	} catch {
		return false;
	}
}
