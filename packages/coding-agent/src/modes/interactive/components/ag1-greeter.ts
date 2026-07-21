import { type Component, truncateToWidth, visibleWidth } from "@ag1/tui";
import { theme } from "../theme/theme.js";

const LOGO_LINES = [
	"  █████╗  ██████╗  ██╗",
	" ██╔══██╗██╔════╝ ███║",
	" ███████║██║  ███╗╚██║",
	" ██╔══██║██║   ██║ ██║",
	" ██║  ██║╚██████╔╝ ██║",
	" ╚═╝  ╚═╝ ╚═════╝  ╚═╝",
];

const LOGO_GRADIENT = [
	{ at: 0, color: "#7fb6d8" },
	{ at: 0.42, color: "#9bb8a8" },
	{ at: 0.76, color: "#d7b46a" },
	{ at: 1, color: "#afc8bb" },
];

function fitLine(line: string, width: number): string {
	return truncateToWidth(line, Math.max(0, width), "...");
}

function padLine(line: string, width: number): string {
	const clipped = fitLine(line, width);
	return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
	const value = hex.replace("#", "");
	return {
		r: Number.parseInt(value.slice(0, 2), 16),
		g: Number.parseInt(value.slice(2, 4), 16),
		b: Number.parseInt(value.slice(4, 6), 16),
	};
}

function interpolateHexColor(start: string, end: string, amount: number): string {
	const a = hexToRgb(start);
	const b = hexToRgb(end);
	const mix = (from: number, to: number) => Math.round(from + (to - from) * amount);
	return `\x1b[38;2;${mix(a.r, b.r)};${mix(a.g, b.g)};${mix(a.b, b.b)}m`;
}

function logoAnsiForColumn(column: number, width: number): string {
	const position = width <= 1 ? 0 : column / (width - 1);
	for (let i = 0; i < LOGO_GRADIENT.length - 1; i++) {
		const left = LOGO_GRADIENT[i]!;
		const right = LOGO_GRADIENT[i + 1]!;
		if (position >= left.at && position <= right.at) {
			const amount = (position - left.at) / Math.max(0.001, right.at - left.at);
			return interpolateHexColor(left.color, right.color, amount);
		}
	}
	return interpolateHexColor(LOGO_GRADIENT.at(-1)!.color, LOGO_GRADIENT.at(-1)!.color, 0);
}

function colorLogoLine(line: string): string {
	const chars = [...line];
	const width = Math.max(...LOGO_LINES.map((logoLine) => visibleWidth(logoLine)));
	return chars
		.map((char, index) => {
			if (char === " ") return char;
			return `${logoAnsiForColumn(index, width)}${char}\x1b[39m`;
		})
		.join("");
}

function renderInfoPanel(width: number, options: Ag1GreeterOptions): string[] {
	const innerWidth = Math.max(1, width - 4);
	const border = (text: string) => theme.fg("borderMuted", text);
	const title = `${theme.fg("accent", ">_ AG1")} ${theme.fg("muted", `(v${options.version})`)}`;
	const provider = [options.providerLabel, options.modelLabel].filter(Boolean).join(" | ");
	const mode = options.modeLine;

	return [
		border(`╭${"─".repeat(Math.max(1, width - 2))}╮`),
		`${border("│")} ${padLine(title, innerWidth)} ${border("│")}`,
		`${border("│")} ${padLine(theme.fg("muted", provider || "local"), innerWidth)} ${border("│")}`,
		`${border("│")} ${padLine(theme.fg("text", mode), innerWidth)} ${border("│")}`,
		border(`╰${"─".repeat(Math.max(1, width - 2))}╯`),
	];
}

export interface Ag1GreeterOptions {
	version: string;
	cwd: string;
	modeLine: string;
	providerLabel: string;
	modelLabel: string;
}

export class Ag1GreeterComponent implements Component {
	constructor(private options: Ag1GreeterOptions) {}

	setContent(options: Ag1GreeterOptions): void {
		this.options = options;
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (width < 76) {
			return this.renderStacked(width);
		}
		return this.renderWide(width);
	}

	private renderWide(width: number): string[] {
		const logoWidth = Math.max(...LOGO_LINES.map((line) => visibleWidth(line)));
		const gap = 4;
		const panelWidth = Math.min(58, Math.max(34, width - logoWidth - gap));
		const logo = LOGO_LINES.map(colorLogoLine);
		const panel = renderInfoPanel(panelWidth, this.options);
		const lines: string[] = [];
		const rows = Math.max(logo.length, panel.length);

		for (let i = 0; i < rows; i++) {
			const left = padLine(logo[i] ?? "", logoWidth);
			const right = panel[i] ?? "";
			lines.push(`${left}${" ".repeat(gap)}${right}`);
		}

		lines.push(
			theme.fg("muted", "Tip: ") +
				theme.fg("text", fitLine("/workspace sandbox review · /research saved sources · Alt+R plan", width - 5)),
		);
		lines.push(theme.fg("dim", fitLine(this.options.cwd, width)));
		return lines;
	}

	private renderStacked(width: number): string[] {
		const lines = LOGO_LINES.map((line) => fitLine(colorLogoLine(line), width));
		const panelWidth = Math.max(24, Math.min(width, 58));
		lines.push(...renderInfoPanel(panelWidth, this.options));
		lines.push(theme.fg("muted", fitLine(this.options.cwd, width)));
		return lines;
	}
}
