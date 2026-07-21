import { Box, type Component, Container, getCapabilities, Image, Spacer, Text, type TUI } from "@ag1/tui";
import type { ToolDefinition, ToolRenderContext } from "../../../core/extensions/types.js";
import { allToolDefinitions } from "../../../core/tools/index.js";
import { getTextOutput as getRenderedTextOutput } from "../../../core/tools/render-utils.js";
import { convertToPng } from "../../../utils/image-convert.js";
import { theme } from "../theme/theme.js";
import { buildConsoleHeader } from "./console-chrome.js";
import { keyHint } from "./keybinding-hints.js";

export interface ToolExecutionOptions {
	showImages?: boolean;
}

const COMPACT_TOOL_SUMMARY_NAMES = new Set(["read", "write", "webFetch", "webSearch", "bash"]);

function matchesRendererShape(candidate: unknown, builtIn: unknown): boolean {
	if (typeof candidate !== "function" || typeof builtIn !== "function") return false;
	return candidate.toString() === builtIn.toString();
}

export class ToolExecutionComponent extends Container {
	private contentBox: Box;
	private contentText: Text;
	private callRendererComponent?: Component;
	private resultRendererComponent?: Component;
	private rendererState: any = {};
	private imageComponents: Image[] = [];
	private imageSpacers: Spacer[] = [];
	private toolName: string;
	private toolCallId: string;
	private args: any;
	private expanded = false;
	private showImages: boolean;
	private isPartial = true;
	private toolDefinition?: ToolDefinition<any, any>;
	private builtInToolDefinition?: ToolDefinition<any, any>;
	private ui: TUI;
	private cwd: string;
	private executionStarted = false;
	private argsComplete = false;
	private result?: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		isError: boolean;
		details?: any;
	};
	private convertedImages: Map<number, { data: string; mimeType: string }> = new Map();
	private hideComponent = false;
	/** Verbose mode: full 3-line call/result blocks with expand hints. Condensed default: 2 lines. */
	private verbose = false;

	/** Tool name (for run-family grouping labels). */
	get name(): string {
		return this.toolName;
	}

	constructor(
		toolName: string,
		toolCallId: string,
		args: any,
		options: ToolExecutionOptions = {},
		toolDefinition: ToolDefinition<any, any> | undefined,
		ui: TUI,
		cwd: string = process.cwd(),
	) {
		super();
		this.toolName = toolName;
		this.toolCallId = toolCallId;
		this.args = args;
		this.toolDefinition = toolDefinition;
		this.builtInToolDefinition = allToolDefinitions[toolName as keyof typeof allToolDefinitions];
		this.showImages = options.showImages ?? true;
		this.ui = ui;
		this.cwd = cwd;

		this.addChild(new Spacer(1));

		// Always create both. contentBox is used for tools with renderer-based call/result composition.
		// contentText is reserved for generic fallback rendering when no tool definition exists.
		this.contentBox = new Box(0, 0, undefined);
		this.contentText = new Text("", 0, 0);

		if (this.hasRendererDefinition()) {
			this.addChild(this.contentBox);
		} else {
			this.addChild(this.contentText);
		}

		this.updateDisplay();
	}

	private getCallRenderer(): ToolDefinition<any, any>["renderCall"] | undefined {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderCall;
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderCall;
		}
		return this.toolDefinition.renderCall ?? this.builtInToolDefinition.renderCall;
	}

	private getResultRenderer(): ToolDefinition<any, any>["renderResult"] | undefined {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderResult;
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderResult;
		}
		return this.toolDefinition.renderResult ?? this.builtInToolDefinition.renderResult;
	}

	private hasRendererDefinition(): boolean {
		return this.builtInToolDefinition !== undefined || this.toolDefinition !== undefined;
	}

	private getRenderContext(lastComponent: Component | undefined): ToolRenderContext {
		return {
			args: this.args,
			toolCallId: this.toolCallId,
			invalidate: () => {
				this.invalidate();
				this.ui.requestRender();
			},
			lastComponent,
			state: this.rendererState,
			cwd: this.cwd,
			executionStarted: this.executionStarted,
			argsComplete: this.argsComplete,
			isPartial: this.isPartial,
			expanded: this.expanded,
			showImages: this.showImages,
			isError: this.result?.isError ?? false,
		};
	}

	private shouldUseCompactBuiltInSummary(): boolean {
		if (!COMPACT_TOOL_SUMMARY_NAMES.has(this.toolName)) return false;
		if (!this.builtInToolDefinition) return false;
		if (!this.toolDefinition) return true;
		const customCallRenderer =
			this.toolDefinition.renderCall !== undefined &&
			!matchesRendererShape(this.toolDefinition.renderCall, this.builtInToolDefinition.renderCall);
		const customResultRenderer =
			this.toolDefinition.renderResult !== undefined &&
			!matchesRendererShape(this.toolDefinition.renderResult, this.builtInToolDefinition.renderResult);
		return !customCallRenderer && !customResultRenderer;
	}

	private createCallFallback(): Component {
		return new Text(theme.fg("toolTitle", theme.bold(this.toolName)), 0, 0);
	}

	private createResultFallback(): Component | undefined {
		const output = this.getTextOutput();
		if (!output) {
			return undefined;
		}
		return new Text(theme.fg("toolOutput", output), 0, 0);
	}

	updateArgs(args: any): void {
		this.args = args;
		this.updateDisplay();
	}

	markExecutionStarted(): void {
		this.executionStarted = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	setArgsComplete(): void {
		this.argsComplete = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	updateResult(
		result: {
			content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			details?: any;
			isError: boolean;
		},
		isPartial = false,
	): void {
		this.result = result;
		this.isPartial = isPartial;
		this.updateDisplay();
		this.maybeConvertImagesForKitty();
	}

	private maybeConvertImagesForKitty(): void {
		const caps = getCapabilities();
		if (caps.images !== "kitty") return;
		if (!this.result) return;

		const imageBlocks = this.result.content.filter((c) => c.type === "image");
		for (let i = 0; i < imageBlocks.length; i++) {
			const img = imageBlocks[i];
			if (!img.data || !img.mimeType) continue;
			if (img.mimeType === "image/png") continue;
			if (this.convertedImages.has(i)) continue;

			const index = i;
			convertToPng(img.data, img.mimeType).then((converted) => {
				if (converted) {
					this.convertedImages.set(index, converted);
					this.updateDisplay();
					this.ui.requestRender();
				}
			});
		}
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	setShowImages(show: boolean): void {
		this.showImages = show;
		this.updateDisplay();
	}

	/** True once a final (non-partial) result has been rendered — safe to collapse into a group. */
	get isComplete(): boolean {
		return this.result !== undefined && !this.isPartial;
	}

	setVerbose(verbose: boolean): void {
		this.verbose = verbose;
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	override render(width: number): string[] {
		if (this.hideComponent) {
			return [];
		}
		return super.render(width);
	}

	private updateDisplay(): void {
		let hasContent = false;
		this.hideComponent = false;
		if (this.hasRendererDefinition()) {
			this.contentBox.setBgFn(undefined);
			this.contentBox.clear();
			this.contentBox.addChild(new Text(this.buildHeaderLine(), 0, 0));

			if (this.shouldUseCompactBuiltInSummary()) {
				const component = this.expanded
					? this.renderExpandedCompactSummary()
					: this.renderCollapsedCompactSummary();
				if (component) {
					this.contentBox.addChild(new Spacer(1));
					this.contentBox.addChild(component);
					hasContent = true;
				} else if (!this.verbose) {
					// Condensed no-result state: header (with the call target) is enough to show.
					hasContent = true;
				}
			} else {
				const callRenderer = this.getCallRenderer();
				if (!callRenderer) {
					this.contentBox.addChild(new Spacer(1));
					this.contentBox.addChild(this.createCallFallback());
					hasContent = true;
				} else {
					try {
						const component = callRenderer(this.args, theme, this.getRenderContext(this.callRendererComponent));
						this.callRendererComponent = component;
						this.contentBox.addChild(new Spacer(1));
						this.contentBox.addChild(component);
						hasContent = true;
					} catch {
						this.callRendererComponent = undefined;
						this.contentBox.addChild(new Spacer(1));
						this.contentBox.addChild(this.createCallFallback());
						hasContent = true;
					}
				}

				if (this.result) {
					const resultRenderer = this.getResultRenderer();
					if (!resultRenderer) {
						const component = this.createResultFallback();
						if (component) {
							this.contentBox.addChild(new Spacer(1));
							this.contentBox.addChild(component);
							hasContent = true;
						}
					} else {
						try {
							const component = resultRenderer(
								{ content: this.result.content as any, details: this.result.details },
								{ expanded: this.expanded, isPartial: this.isPartial },
								theme,
								this.getRenderContext(this.resultRendererComponent),
							);
							this.resultRendererComponent = component;
							this.contentBox.addChild(new Spacer(1));
							this.contentBox.addChild(component);
							hasContent = true;
						} catch {
							this.resultRendererComponent = undefined;
							const component = this.createResultFallback();
							if (component) {
								this.contentBox.addChild(new Spacer(1));
								this.contentBox.addChild(component);
								hasContent = true;
							}
						}
					}
				}
			}
		} else {
			this.contentText.setCustomBgFn(undefined);
			this.contentText.setText(this.formatToolExecution());
			hasContent = true;
		}

		for (const img of this.imageComponents) {
			this.removeChild(img);
		}
		this.imageComponents = [];
		for (const spacer of this.imageSpacers) {
			this.removeChild(spacer);
		}
		this.imageSpacers = [];

		if (this.result) {
			const imageBlocks = this.result.content.filter((c) => c.type === "image");
			const caps = getCapabilities();
			for (let i = 0; i < imageBlocks.length; i++) {
				const img = imageBlocks[i];
				if (caps.images && this.showImages && img.data && img.mimeType) {
					const converted = this.convertedImages.get(i);
					const imageData = converted?.data ?? img.data;
					const imageMimeType = converted?.mimeType ?? img.mimeType;
					if (caps.images === "kitty" && imageMimeType !== "image/png") continue;

					const spacer = new Spacer(1);
					this.addChild(spacer);
					this.imageSpacers.push(spacer);
					const imageComponent = new Image(
						imageData,
						imageMimeType,
						{ fallbackColor: (s: string) => theme.fg("toolOutput", s) },
						{ maxWidthCells: 60 },
					);
					this.imageComponents.push(imageComponent);
					this.addChild(imageComponent);
				}
			}
		}

		if (this.hasRendererDefinition() && !hasContent && this.imageComponents.length === 0) {
			this.hideComponent = true;
		}
	}

	private getTextOutput(): string {
		return getRenderedTextOutput(this.result, this.showImages);
	}

	private renderExpandedCompactSummary(): Component {
		const lines: string[] = [];
		if (this.verbose) {
			// Condensed headers already carry the call target; only repeat it in verbose.
			lines.push(this.getNestedTargetLine(this.getCompactCallSummary()));
		}
		const resultSummary = this.getCompactResultSummary();
		if (resultSummary) {
			lines.push(theme.fg("text", resultSummary));
		}
		return new Text(lines.join("\n"), 0, 0);
	}

	private renderCollapsedCompactSummary(): Component | undefined {
		const resultSummary = this.getCollapsedResultSummary();
		if (this.verbose) {
			const lines: string[] = [];
			if (resultSummary) {
				const expandHint = this.shouldOfferExpansionHint() ? ` ${keyHint("app.tools.expand", "to expand")}` : "";
				lines.push(theme.fg("text", resultSummary) + expandHint);
			}
			const callSummary = this.getCompactCallSummary();
			if (callSummary) {
				lines.push(this.getNestedTargetLine(callSummary));
			}
			if (lines.length === 0) return undefined;
			return new Text(lines.join("\n"), 0, 0);
		}
		// Condensed: the call target already lives in the header line; one muted result line.
		if (!resultSummary) return undefined;
		return new Text(theme.fg("muted", `└ ${resultSummary}`), 0, 0);
	}

	private getCompactCallSummary(): string {
		switch (this.toolName) {
			case "read":
				return this.formatCompactReadCall();
			case "write":
				return this.formatCompactWriteCall();
			case "webFetch":
				return this.formatCompactWebFetchCall();
			case "webSearch":
				return this.formatCompactWebSearchCall();
			case "bash":
				return this.formatCompactBashCall();
			default:
				return this.toolName;
		}
	}

	private getCompactResultSummary(): string | undefined {
		switch (this.toolName) {
			case "read":
				return this.formatCompactReadResult();
			case "write":
				return this.formatCompactWriteResult();
			case "webFetch":
				return this.formatCompactWebFetchResult();
			case "webSearch":
				return this.formatCompactWebSearchResult();
			case "bash":
				return this.formatCompactBashResult();
			default:
				return this.getCompactPreview(this.getTextOutput(), 3);
		}
	}

	private getCollapsedResultSummary(): string | undefined {
		switch (this.toolName) {
			case "read":
				return this.summarizeReadResult();
			case "write":
				return this.summarizeWriteResult();
			case "webFetch":
				return this.summarizeWebFetchResult();
			case "webSearch":
				return this.summarizeWebSearchResult();
			case "bash":
				return this.summarizeBashResult();
			default:
				return this.result ? this.getCollapsedTextSummary(this.getTextOutput()) : undefined;
		}
	}

	private formatCompactReadCall(): string {
		const path =
			this.getStringArg("path") ?? this.getStringArg("file_path") ?? this.missingArgLabel("(missing path)");
		const offset = this.args?.offset;
		const limit = this.args?.limit;
		const range =
			offset !== undefined || limit !== undefined
				? ` lines ${offset ?? 1}${limit !== undefined ? `-${(offset ?? 1) + limit - 1}` : "+"}`
				: "";
		return `${path}${range}`;
	}

	private formatCompactWriteCall(): string {
		const path =
			this.getStringArg("path") ?? this.getStringArg("file_path") ?? this.missingArgLabel("(missing path)");
		const content = this.getStringArg("content") ?? this.getStringArg("newText") ?? "";
		const lineCount = content ? content.split("\n").length : 0;
		return `${path}${lineCount > 0 ? ` • ${lineCount} lines staged` : ""}`;
	}

	private formatCompactWebFetchCall(): string {
		return this.getStringArg("url") ?? this.missingArgLabel("(missing url)");
	}

	private formatCompactWebSearchCall(): string {
		return this.getStringArg("query") ?? this.missingArgLabel("(missing query)");
	}

	private formatCompactBashCall(): string {
		const command = this.getStringArg("command");
		if (command === undefined) return this.missingArgLabel("(missing command)");
		return this.getCompactPreview(command, 1, 140) ?? command;
	}

	/**
	 * While args are still streaming, a missing key usually just hasn't arrived
	 * yet (models choose the key order) — show a neutral state, not an error.
	 */
	private missingArgLabel(label: string): string {
		return this.argsComplete ? label : "receiving args…";
	}

	private formatCompactReadResult(): string | undefined {
		if (!this.result) return undefined;
		const output = this.getTextOutput();
		if (!output.trim()) return undefined;
		const lines = output.split("\n");
		const preview = this.getCompactPreview(output, this.expanded ? 8 : 2);
		const prefix = `${lines.filter((line) => line.trim().length > 0).length} line${lines.length === 1 ? "" : "s"} loaded`;
		return preview ? `${prefix}\n${preview}` : prefix;
	}

	private formatCompactWriteResult(): string | undefined {
		if (!this.result) return undefined;
		const diff = typeof this.result.details?.diff === "string" ? this.result.details.diff : undefined;
		if (diff) {
			const changeLines = diff
				.split("\n")
				.filter((line: string) => line.startsWith("+") || line.startsWith("-")).length;
			const preview = this.getCompactPreview(diff, this.expanded ? 8 : 3);
			return `${changeLines} changed line${changeLines === 1 ? "" : "s"}\n${preview ?? ""}`.trim();
		}
		return this.getCompactPreview(this.getTextOutput(), this.expanded ? 8 : 3);
	}

	private formatCompactWebFetchResult(): string | undefined {
		const details = this.result?.details as
			| {
					title?: string;
					facts?: string[];
					preview?: string;
					truncated?: boolean;
					cacheHit?: boolean;
					status?: string;
					statusReason?: string;
					coverage?: { kind?: string; present?: string[]; missing?: string[] };
			  }
			| undefined;
		if (!details) return this.getCompactPreview(this.getTextOutput(), this.expanded ? 8 : 3);
		const lines: string[] = [];
		if (details.title) lines.push(details.title);
		const statusLine = this.formatWebFetchStatusLine(details);
		if (statusLine) lines.push(statusLine);
		if (details.facts?.length) {
			lines.push(...details.facts.slice(0, this.expanded ? 4 : 2));
		}
		if (details.preview) {
			const preview = this.getCompactPreview(details.preview, this.expanded ? 6 : 2);
			if (preview) lines.push(preview);
		}
		if (details.truncated && !this.expanded) {
			lines.push("Preview truncated. Expand for more.");
		}
		return lines.join("\n");
	}

	private formatCompactWebSearchResult(): string | undefined {
		const details = this.result?.details as
			| {
					resultCount?: number;
					searchProvider?: string;
					searchProviderMode?: string;
					fallbackUsed?: boolean;
					results?: Array<{
						title?: string;
						url?: string;
						sourceKind?: string;
						authoritative?: boolean;
						fetchRisk?: string;
					}>;
			  }
			| undefined;
		if (!details) return this.getCompactPreview(this.getTextOutput(), this.expanded ? 8 : 3);
		const results = details.results ?? [];
		const shown = results.slice(0, this.expanded ? 5 : 2);
		const lines: string[] = [];
		if (typeof details.resultCount === "number") {
			const provider = details.searchProvider ? ` · ${details.searchProvider}` : "";
			const fallback = details.fallbackUsed ? " · fallback" : "";
			lines.push(`${details.resultCount} result${details.resultCount === 1 ? "" : "s"} found${provider}${fallback}`);
		}
		for (const entry of shown) {
			const title = entry.title ?? entry.url ?? "Untitled result";
			const labels = [
				entry.sourceKind,
				entry.authoritative ? "authoritative" : undefined,
				entry.fetchRisk && entry.fetchRisk !== "low" ? `${entry.fetchRisk} fetch risk` : undefined,
			].filter((value): value is string => typeof value === "string" && value.length > 0);
			lines.push(`- ${title}${labels.length ? ` [${labels.join(", ")}]` : ""}`);
		}
		if (!this.expanded && results.length > shown.length) {
			lines.push(`+${results.length - shown.length} more results`);
		}
		return lines.join("\n");
	}

	private formatWebFetchStatusLine(details: {
		status?: string;
		statusReason?: string;
		coverage?: { kind?: string; present?: string[]; missing?: string[] };
	}): string | undefined {
		const parts: string[] = [];
		if (details.status === "placeholder") {
			parts.push("placeholder/interstitial");
		} else if (details.status === "thin") {
			parts.push("thin extract");
		} else if (details.status === "rich") {
			parts.push("rich source");
		}
		const coverage = details.coverage;
		if (coverage) {
			const present = Array.isArray(coverage.present) ? coverage.present.length : 0;
			const missing = Array.isArray(coverage.missing) ? coverage.missing.length : 0;
			if (present > 0 || missing > 0) {
				const total = present + missing;
				const kind = coverage.kind ? `${coverage.kind} ` : "";
				parts.push(`${kind}coverage ${present}/${total}`);
			}
			if (this.expanded && Array.isArray(coverage.missing) && coverage.missing.length > 0) {
				parts.push(`missing ${coverage.missing.join(", ")}`);
			}
		}
		if (this.expanded && details.statusReason) {
			parts.push(details.statusReason);
		}
		return parts.length > 0 ? parts.join(" · ") : undefined;
	}

	private formatCompactBashResult(): string | undefined {
		return this.getCompactPreview(this.getTextOutput(), this.expanded ? 10 : 4);
	}

	private summarizeReadResult(): string | undefined {
		const path = this.getStringArg("path") ?? this.getStringArg("file_path") ?? "file";
		if (!this.result) return undefined;
		const count = this.countNonEmptyLines(this.getTextOutput());
		if (count === 0) return `Loaded ${path}`;
		return `Loaded ${path} · ${count} line${count === 1 ? "" : "s"}`;
	}

	private summarizeWriteResult(): string | undefined {
		const path = this.getStringArg("path") ?? this.getStringArg("file_path") ?? "file";
		if (!this.result) return `Staging ${path}`;
		const diff = typeof this.result.details?.diff === "string" ? this.result.details.diff : undefined;
		if (diff) {
			const changeLines = diff
				.split("\n")
				.filter((line: string) => line.startsWith("+") || line.startsWith("-")).length;
			if (changeLines > 0) {
				return `Updated ${path} · ${changeLines} changed line${changeLines === 1 ? "" : "s"}`;
			}
		}
		return `Updated ${path}`;
	}

	private summarizeWebFetchResult(): string | undefined {
		const url = this.getStringArg("url") ?? "page";
		if (!this.result) return `Fetching ${url}`;
		const details = this.result.details as
			| {
					title?: string;
					status?: string;
					coverage?: { kind?: string; present?: string[]; missing?: string[] };
			  }
			| undefined;
		const suffix = details ? this.formatWebFetchSummarySuffix(details) : "";
		if (details?.title) {
			return `Fetched ${details.title}${suffix}`;
		}
		return `Fetched ${url}${suffix}`;
	}

	private summarizeWebSearchResult(): string | undefined {
		const query = this.getStringArg("query") ?? "search";
		if (!this.result) return `Searching ${query}`;
		const details = this.result.details as
			| {
					resultCount?: number;
					searchProvider?: string;
					fallbackUsed?: boolean;
					results?: Array<{ sourceKind?: string }>;
			  }
			| undefined;
		if (typeof details?.resultCount === "number") {
			const sourceKind = details.results?.[0]?.sourceKind ? ` · top ${details.results[0].sourceKind}` : "";
			const provider = details.searchProvider ? ` · ${details.searchProvider}` : "";
			const fallback = details.fallbackUsed ? " · fallback" : "";
			return `Search returned ${details.resultCount} result${details.resultCount === 1 ? "" : "s"}${provider}${fallback}${sourceKind}`;
		}
		return `Search completed`;
	}

	private formatWebFetchSummarySuffix(details: {
		status?: string;
		coverage?: { kind?: string; present?: string[]; missing?: string[] };
	}): string {
		const parts: string[] = [];
		if (details.status === "placeholder") {
			parts.push("placeholder");
		} else if (details.status === "thin") {
			parts.push("thin");
		} else if (details.status === "rich") {
			parts.push("rich");
		}
		const coverage = details.coverage;
		if (coverage) {
			const present = Array.isArray(coverage.present) ? coverage.present.length : 0;
			const missing = Array.isArray(coverage.missing) ? coverage.missing.length : 0;
			if (present > 0 || missing > 0) {
				parts.push(`coverage ${present}/${present + missing}`);
			}
		}
		return parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
	}

	private summarizeBashResult(): string | undefined {
		const command = this.getStringArg("command") ?? "command";
		if (!this.result) {
			return this.executionStarted ? `Running ${this.summarizeCommandAction(command)}` : undefined;
		}
		if (this.result.isError) {
			return `Command failed`;
		}
		const count = this.countNonEmptyLines(this.getTextOutput());
		if (count === 0) return `${this.summarizeCommandAction(command)} complete`;
		return `${this.summarizeCommandAction(command)} · ${count} line${count === 1 ? "" : "s"} available`;
	}

	private summarizeCommandAction(command: string): string {
		const trimmed = command.trim();
		if (/^ls(\s|$)/.test(trimmed)) return "directory listing";
		if (/^rg(\s|$)|^grep(\s|$)|^find(\s|$)/.test(trimmed)) return "search";
		if (/^git\s+status(\s|$)/.test(trimmed)) return "git status";
		if (/^git\s+diff(\s|$)/.test(trimmed)) return "git diff";
		if (/^npm\s+test(\s|$)|^pnpm\s+test(\s|$)|^yarn\s+test(\s|$)/.test(trimmed)) return "test run";
		return "command";
	}

	private getCollapsedTextSummary(text: string): string | undefined {
		const normalized = text
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
		if (normalized.length === 0) return undefined;
		if (normalized.length === 1) {
			return this.truncateInline(normalized[0]!, 90);
		}
		return `${normalized.length} output lines`;
	}

	private shouldOfferExpansionHint(): boolean {
		if (this.expanded || !this.result) return false;
		const output = this.getTextOutput();
		return this.countNonEmptyLines(output) > 0;
	}

	private getNestedTargetLine(content: string): string {
		return theme.fg("text", `└ ${this.truncateInline(content, 140)}`);
	}

	private countNonEmptyLines(text: string): number {
		return text
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean).length;
	}

	private truncateInline(text: string, maxChars: number): string {
		if (text.length <= maxChars) return text;
		return `${text.slice(0, Math.max(1, maxChars - 1))}…`;
	}

	private getCompactPreview(text: string, maxLines: number, maxChars = 160): string | undefined {
		const normalized = text
			.split("\n")
			.map((line) => line.trimEnd())
			.filter((line) => line.trim().length > 0);
		if (normalized.length === 0) return undefined;
		const limited = normalized
			.slice(0, maxLines)
			.map((line) => (line.length > maxChars ? `${line.slice(0, maxChars - 1)}…` : line));
		if (!this.expanded && normalized.length > limited.length) {
			limited.push(`… ${normalized.length - limited.length} more lines`);
		}
		return limited.join("\n");
	}

	private getStringArg(key: string): string | undefined {
		const value = this.args?.[key];
		return typeof value === "string" ? value : undefined;
	}

	private formatToolExecution(): string {
		let text = `${this.buildHeaderLine()}\n\n${theme.fg("toolTitle", theme.bold(this.toolName))}`;
		const content = JSON.stringify(this.args, null, 2);
		if (content) {
			text += `\n\n${content}`;
		}
		const output = this.getTextOutput();
		if (output) {
			text += `\n${output}`;
		}
		return text;
	}

	private buildHeaderLine(): string {
		const dot = theme.bold(theme.fg(this.getExecutionDotColor(), "●"));
		const header = buildConsoleHeader({
			badge: this.toolName,
			badgeColor: "text",
		});
		if (this.verbose) return `${dot} ${header}`;
		// Condensed: the call target (query, path, command, URL) is the informative part — put it
		// in the header with accent color instead of a separate line below.
		const target = this.getCompactCallSummary();
		if (!target || target === this.toolName) return `${dot} ${header}`;
		return `${dot} ${header} ${theme.fg("muted", "·")} ${theme.fg("accent", this.truncateInline(target, 100))}`;
	}

	private getExecutionDotColor(): "muted" | "success" | "error" {
		if (!this.executionStarted && !this.result) {
			return "muted";
		}
		if (this.isPartial) {
			return "muted";
		}
		if (this.result?.isError) {
			return "error";
		}
		return "success";
	}
}
