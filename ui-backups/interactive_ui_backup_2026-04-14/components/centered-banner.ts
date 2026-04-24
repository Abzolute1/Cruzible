import { type Component, truncateToWidth, visibleWidth } from "@ag1/tui";

function centerLine(line: string, width: number): string {
	const clipped = truncateToWidth(line, width, "...");
	const padding = Math.max(0, Math.floor((width - visibleWidth(clipped)) / 2));
	return `${" ".repeat(padding)}${clipped}`;
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
