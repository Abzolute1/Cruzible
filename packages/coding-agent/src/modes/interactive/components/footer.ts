import { type Component, truncateToWidth, visibleWidth } from "@ag1/tui";
import type { AgentSession } from "../../../core/agent-session.js";
import { estimateContextTokens } from "../../../core/compaction/index.js";
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

function buildFooterMetric(
	label: string,
	value: string,
	options: {
		tone?: "accent" | "success" | "warning" | "error" | "muted" | "text";
		bold?: boolean;
	} = {},
): string {
	const tone = options.tone ?? "text";
	const styledValue = options.bold ? theme.bold(theme.fg(tone, value)) : theme.fg(tone, value);
	return `${theme.fg("dim", label)} ${styledValue}`;
}

function buildFooterModelLabel(provider: string, model: string): string {
	return `${theme.fg("muted", provider)} ${theme.fg("dim", "/")} ${theme.bold(theme.fg("accent", model))}`;
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
		let totalCost = 0;

		for (const entry of this.session.sessionManager.getEntries()) {
			if (entry.type === "message" && entry.message.role === "assistant") {
				totalInput += entry.message.usage.input;
				totalOutput += entry.message.usage.output;
				totalCost += entry.message.usage.cost.total;
			}
		}

		// Calculate context usage from session. This is usage-based when available,
		// otherwise a conservative heuristic estimate.
		const contextUsage = this.session.getContextUsage();
		const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
		const liveContextTokens = contextUsage?.tokens ?? null;
		const rawContextTokens = estimateContextTokens(this.session.messages).tokens;
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
			leftParts.push(buildFooterMetric("ctx", contextPercentDisplay, { tone: "error", bold: true }));
		} else if (contextPercentValue > 70) {
			leftParts.push(buildFooterMetric("ctx", contextPercentDisplay, { tone: "warning", bold: true }));
		} else {
			leftParts.push(buildFooterMetric("ctx", contextPercentDisplay, { tone: "accent", bold: true }));
		}
		if (typeof liveContextTokens === "number" && liveContextTokens > 0) {
			leftParts.push(buildFooterMetric("live", formatTokens(liveContextTokens), { tone: "text", bold: true }));
		}
		if (
			typeof liveContextTokens === "number" &&
			liveContextTokens > 0 &&
			rawContextTokens > liveContextTokens + Math.max(512, Math.round(liveContextTokens * 0.08))
		) {
			leftParts.push(buildFooterMetric("raw", formatTokens(rawContextTokens), { tone: "muted", bold: true }));
		}
		leftParts.push(buildFooterMetric(`in${INPUT_ARROW}`, formatTokens(totalInput), { tone: "text", bold: true }));
		leftParts.push(buildFooterMetric(`out${OUTPUT_ARROW}`, formatTokens(totalOutput), { tone: "text", bold: true }));

		const costStr = `$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`;
		leftParts.push(buildFooterMetric("api", costStr, { tone: usingSubscription ? "accent" : "success", bold: true }));

		if (this.warningMessage) {
			leftParts.push(
				buildFooterMetric("warn", sanitizeStatusText(this.warningMessage), { tone: "warning", bold: true }),
			);
		}

		const extensionStatuses = this.footerData.getExtensionStatuses();
		if (extensionStatuses.size > 0) {
			const sortedStatuses = Array.from(extensionStatuses.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => sanitizeStatusText(text));
			leftParts.push(theme.fg("dim", sortedStatuses.join(" • ")));
		}

		const rightParts = [
			buildFooterModelLabel(formatProviderLabel(state.model?.provider), state.model?.id || "no-model"),
		];
		if (state.model?.reasoning && !this.autoCompactEnabled) {
			rightParts.push(buildFooterMetric("compact", "off", { tone: "warning", bold: true }));
		}

		const left = leftParts.join(theme.fg("borderMuted", "  │  "));
		const right = rightParts.join(theme.fg("borderMuted", "  │  "));

		return [buildAlignedFooterLine(left, right, width)];
	}
}
