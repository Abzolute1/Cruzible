import { type Component, truncateToWidth, visibleWidth } from "@ag1/tui";

function centerLine(line: string, width: number): string {
	const clipped = truncateToWidth(line, width, "...");
	const padding = Math.max(0, Math.floor((width - visibleWidth(clipped)) / 2));
	return `${" ".repeat(padding)}${clipped}`;
}

function edgeLine(left: string, right: string, width: number): string {
	const gap = "  ";
	let leftClipped = truncateToWidth(left, width, "...");
	let rightClipped = truncateToWidth(right, width, "...");
	let leftWidth = visibleWidth(leftClipped);
	let rightWidth = visibleWidth(rightClipped);

	if (leftWidth + visibleWidth(gap) + rightWidth > width) {
		const maxLeftWidth = Math.max(0, width - visibleWidth(gap) - rightWidth);
		leftClipped = truncateToWidth(left, maxLeftWidth, "...");
		leftWidth = visibleWidth(leftClipped);
	}

	if (leftWidth + visibleWidth(gap) + rightWidth > width) {
		const maxRightWidth = Math.max(0, width - visibleWidth(gap) - leftWidth);
		rightClipped = truncateToWidth(right, maxRightWidth, "...");
		rightWidth = visibleWidth(rightClipped);
	}

	const spaces = Math.max(1, width - leftWidth - rightWidth);
	return `${leftClipped}${" ".repeat(spaces)}${rightClipped}`;
}

export class CenteredBannerComponent implements Component {
	constructor(private lines: string[] = []) {}

	setLines(lines: string[]): void {
		this.lines = lines;
	}

	invalidate(): void {}

	render(width: number): string[] {
		return this.lines.map((line) => centerLine(line, width));
	}
}

export class HeaderBannerComponent implements Component {
	constructor(
		private left: string,
		private right: string,
		private centeredLines: string[] = [],
	) {}

	setContent(left: string, right: string, centeredLines: string[]): void {
		this.left = left;
		this.right = right;
		this.centeredLines = centeredLines;
	}

	invalidate(): void {}

	render(width: number): string[] {
		return [edgeLine(this.left, this.right, width), ...this.centeredLines.map((line) => centerLine(line, width))];
	}
}

function fitLine(content: string, width: number): string {
	return truncateToWidth(content, Math.max(0, width), "...");
}

function padLine(content: string, width: number): string {
	const clipped = fitLine(content, width);
	return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

export class SplitPanelBannerComponent implements Component {
	constructor(
		private label: string,
		private leftTitle: string,
		private leftLines: string[],
		private rightTitle: string,
		private rightLines: string[],
	) {}

	setContent(label: string, leftTitle: string, leftLines: string[], rightTitle: string, rightLines: string[]): void {
		this.label = label;
		this.leftTitle = leftTitle;
		this.leftLines = leftLines;
		this.rightTitle = rightTitle;
		this.rightLines = rightLines;
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (width < 72) {
			return this.renderStacked(width);
		}
		return this.renderSplit(width);
	}

	private renderSplit(width: number): string[] {
		const available = Math.max(24, width - 7);
		const leftWidth = Math.min(Math.max(26, Math.floor(available * 0.43)), Math.max(26, available - 24));
		const rightWidth = Math.max(20, available - leftWidth);
		const rows = Math.max(this.leftLines.length, this.rightLines.length, 1);
		const lines: string[] = [];
		lines.push(this.renderTopBorder(width));
		lines.push(this.renderRow(this.leftTitle, leftWidth, this.rightTitle, rightWidth));
		for (let i = 0; i < rows; i++) {
			lines.push(this.renderRow(this.leftLines[i] ?? "", leftWidth, this.rightLines[i] ?? "", rightWidth));
		}
		lines.push(`╰${"─".repeat(Math.max(1, width - 2))}╯`);
		return lines;
	}

	private renderStacked(width: number): string[] {
		const innerWidth = Math.max(1, width - 4);
		const lines: string[] = [];
		lines.push(this.renderTopBorder(width));
		lines.push(`│ ${padLine(this.leftTitle, innerWidth)} │`);
		for (const line of this.leftLines) {
			lines.push(`│ ${padLine(line, innerWidth)} │`);
		}
		lines.push(`│ ${padLine("", innerWidth)} │`);
		lines.push(`│ ${padLine(this.rightTitle, innerWidth)} │`);
		for (const line of this.rightLines) {
			lines.push(`│ ${padLine(line, innerWidth)} │`);
		}
		lines.push(`╰${"─".repeat(Math.max(1, width - 2))}╯`);
		return lines;
	}

	private renderTopBorder(width: number): string {
		const label = fitLine(this.label, Math.max(0, width - 6));
		const fill = Math.max(1, width - visibleWidth(label) - 4);
		return `╭─${label}${"─".repeat(fill)}╮`;
	}

	private renderRow(left: string, leftWidth: number, right: string, rightWidth: number): string {
		return `│ ${padLine(left, leftWidth)} │ ${padLine(right, rightWidth)} │`;
	}
}
