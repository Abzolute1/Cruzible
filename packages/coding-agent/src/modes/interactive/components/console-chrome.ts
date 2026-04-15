import type { ThemeColor } from "../theme/theme.js";
import { theme } from "../theme/theme.js";

export function buildConsoleBadge(label: string, color: ThemeColor = "accent"): string {
	return theme.bold(theme.fg(color, label.toUpperCase()));
}

export function buildConsoleMeta(parts: Array<string | undefined>, color: ThemeColor = "dim"): string {
	return parts
		.map((part) => part?.trim())
		.filter((part): part is string => Boolean(part))
		.map((part) => theme.fg(color, part))
		.join(theme.fg("dim", " • "));
}

export function buildConsoleHeader(options: {
	badge: string;
	badgeColor?: ThemeColor;
	title?: string;
	meta?: Array<string | undefined>;
	metaColor?: ThemeColor;
}): string {
	const segments = [buildConsoleBadge(options.badge, options.badgeColor)];
	if (options.title?.trim()) {
		segments.push(theme.bold(theme.fg("text", options.title.trim())));
	}
	const meta = buildConsoleMeta(options.meta ?? [], options.metaColor);
	if (meta) {
		segments.push(meta);
	}
	return segments.join(" ");
}
