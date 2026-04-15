import { type Component, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { AgentSession } from "../../../core/agent-session.js";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.js";
import { theme } from "../theme/theme.js";
import { formatTokens } from "./model-metrics.js";

/**
 * Sanitize text for display in a single-line status.
 * Removes newlines, tabs, carriage returns, and other control characters.
 */
function sanitizeStatusText(text: string): string {
	// Replace newlines, tabs, carriage returns with space, then collapse multiple spaces
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

function buildFooterBadge(
	text: string,
	options: {
		tone?: "accent" | "success" | "warning" | "error" | "muted" | "text";
		bold?: boolean;
	} = {},
): string {
	const tone = options.tone ?? "muted";
	const content = options.bold ? theme.bold(theme.fg(tone, text)) : theme.fg(tone, text);
	return `[${content}]`;
}

const INPUT_ARROW = "↓";
const OUTPUT_ARROW = "↑";

function formatProviderLabel(provider: string | undefined): string {
	if (!provider) return "unknown";
	if (provider === "local") return "Local";
	if (provider === "nvidia") return "NVIDIA";
	return provider.charAt(0).toUpperCase() + provider.slice(1);
}

function buildAlignedFooterLine(left: string, right: string, width: number): string {
	const leftWidth = visibleWidth(left);
	const rightWidth = visibleWidth(right);

	if (leftWidth + rightWidth + 2 <= width) {
		return `${left}${" ".repeat(width - leftWidth - rightWidth)}${right}`;
	}

	const reservedGap = rightWidth < width ? 2 : 0;
	const leftMaxWidth = Math.max(0, width - rightWidth - reservedGap);
	if (leftMaxWidth > 0) {
		const truncatedLeft = truncateToWidth(left, leftMaxWidth, theme.fg("dim", "..."));
		const truncatedLeftWidth = visibleWidth(truncatedLeft);
		const gap = Math.max(0, width - truncatedLeftWidth - rightWidth);
		return `${truncatedLeft}${" ".repeat(gap)}${right}`;
	}

	return truncateToWidth(right, width, theme.fg("dim", "..."));
}

/**
 * Footer component that shows pwd, token stats, and context usage.
 * Computes token/context stats from session, gets git branch and extension statuses from provider.
 */
export class FooterComponent implements Component {
	private autoCompactEnabled = true;
	private warningMessage: string | null = null;

	constructor(
		private session: AgentSession,
		private footerData: ReadonlyFooterDataProvider,
	) {}

	setSession(session: AgentSession): void {
		this.session = session;
	}

	setAutoCompactEnabled(enabled: boolean): void {
		this.autoCompactEnabled = enabled;
	}

	/** Set or clear a warning message in the footer */
	setWarning(message: string | null): void {
		this.warningMessage = message;
	}

	/** Get current warning message */
	getWarning(): string | null {
		return this.warningMessage;
	}

	/**
	 * No-op: git branch caching now handled by provider.
	 * Kept for compatibility with existing call sites in interactive-mode.
	 */
	invalidate(): void {
		// No-op: git branch is cached/invalidated by provider
	}

	/**
	 * Clean up resources.
	 * Git watcher cleanup now handled by provider.
	 */
	dispose(): void {
		// Git watcher cleanup handled by provider
	}

	render(width: number): string[] {
		const state = this.session.state;

		// Calculate cumulative usage from ALL session entries (not just post-compaction messages)
		let totalInput = 0;
		let totalOutput = 0;
		let totalCacheRead = 0;
		let totalCacheWrite = 0;
		let totalCost = 0;

		for (const entry of this.session.sessionManager.getEntries()) {
			if (entry.type === "message" && entry.message.role === "assistant") {
				totalInput += entry.message.usage.input;
				totalOutput += entry.message.usage.output;
				totalCacheRead += entry.message.usage.cacheRead;
				totalCacheWrite += entry.message.usage.cacheWrite;
				totalCost += entry.message.usage.cost.total;
			}
		}

		// Calculate context usage from session. This is usage-based when available,
		// otherwise a conservative heuristic estimate.
		const contextUsage = this.session.getContextUsage();
		const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
		const liveContextTokens = contextUsage?.tokens ?? null;
		const contextPercentValue = contextUsage?.percent ?? 0;
		const contextPercent =
			contextUsage?.percent !== null
				? `${contextUsage?.estimated ? "~" : ""}${contextPercentValue.toFixed(1)}`
				: "?";

		const leftParts = [];

		const usingSubscription = state.model ? this.session.modelRegistry.isUsingOAuth(state.model) : false;
		const autoIndicator = this.autoCompactEnabled ? " (auto)" : "";
		const contextPercentDisplay =
			contextPercent === "?"
				? `?/${formatTokens(contextWindow)}${autoIndicator}`
				: `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;
		if (contextPercentValue > 90) {
			leftParts.push(buildFooterBadge(`context ${contextPercentDisplay}`, { tone: "error", bold: true }));
		} else if (contextPercentValue > 70) {
			leftParts.push(buildFooterBadge(`context ${contextPercentDisplay}`, { tone: "warning", bold: true }));
		} else {
			leftParts.push(buildFooterBadge(`context ${contextPercentDisplay}`, { tone: "accent", bold: true }));
		}
		if (typeof liveContextTokens === "number" && liveContextTokens > 0) {
			leftParts.push(buildFooterBadge(`live ${formatTokens(liveContextTokens)}`, { tone: "text", bold: true }));
		}
		leftParts.push(buildFooterBadge(`Σ${INPUT_ARROW} ${formatTokens(totalInput)}`, { tone: "text", bold: true }));
		leftParts.push(buildFooterBadge(`Σ${OUTPUT_ARROW} ${formatTokens(totalOutput)}`, { tone: "text", bold: true }));

		const costStr = `$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`;
		leftParts.push(buildFooterBadge(`api ${costStr}`, { tone: usingSubscription ? "accent" : "success", bold: true }));

		if (this.warningMessage) {
			leftParts.push(buildFooterBadge(`warning ${sanitizeStatusText(this.warningMessage)}`, { tone: "warning", bold: true }));
		}

		const extensionStatuses = this.footerData.getExtensionStatuses();
		if (extensionStatuses.size > 0) {
			const sortedStatuses = Array.from(extensionStatuses.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => sanitizeStatusText(text));
			leftParts.push(theme.fg("dim", sortedStatuses.join(" • ")));
		}

		const rightParts = [
			buildFooterBadge(formatProviderLabel(state.model?.provider), { tone: "muted", bold: true }),
			buildFooterBadge(state.model?.id || "no-model", { tone: "accent", bold: true }),
		];
		if (state.model?.reasoning && !this.autoCompactEnabled) {
			rightParts.push(buildFooterBadge("autocompact off", { tone: "warning", bold: true }));
		}

		const left = leftParts.join(theme.fg("dim", " "));
		const right = rightParts.join(theme.fg("dim", " "));

		return [
			buildAlignedFooterLine(left, right, width),
		];
	}
}
