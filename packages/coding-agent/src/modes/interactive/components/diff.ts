import * as Diff from "diff";
import { theme } from "../theme/theme.js";

/**
 * Parse diff line to extract prefix, line number, and content.
 * Format: "+123 content" or "-123 content" or " 123 content" or "     ..."
 */
function parseDiffLine(line: string): { prefix: string; lineNum: string; content: string } | null {
	const match = line.match(/^([+-\s])(\s*\d*)\s(.*)$/);
	if (!match) return null;
	return { prefix: match[1], lineNum: match[2], content: match[3] };
}

/**
 * Replace tabs with spaces for consistent rendering.
 */
function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

type DiffRow =
	| { kind: "sep" }
	| { kind: "context"; oldNum: number; newNum: number; content: string }
	| { kind: "removed"; oldNum: number; content: string }
	| { kind: "added"; newNum: number; content: string };

/**
 * Parse the raw diff text into structured rows.
 * Removed lines carry old-file numbers, added lines new-file numbers, context
 * lines old-file numbers (see generateDiffString). New-file numbers for context
 * lines are reconstructed by tracking the running added-minus-removed delta.
 */
function parseRows(diffText: string): DiffRow[] {
	const rows: DiffRow[] = [];
	let delta = 0;

	for (const line of diffText.split("\n")) {
		const parsed = parseDiffLine(line);
		if (!parsed) continue;

		const lineNum = parsed.lineNum.trim();

		if (parsed.prefix === "-") {
			rows.push({ kind: "removed", oldNum: Number(lineNum), content: parsed.content });
			delta--;
		} else if (parsed.prefix === "+") {
			rows.push({ kind: "added", newNum: Number(lineNum), content: parsed.content });
			delta++;
		} else if (lineNum === "") {
			// Separator ("...") lines have no line number; real context lines always do
			rows.push({ kind: "sep" });
		} else {
			const oldNum = Number(lineNum);
			rows.push({ kind: "context", oldNum, newNum: oldNum + delta, content: parsed.content });
		}
	}

	return rows;
}

/**
 * Similarity ratio between two lines based on unchanged characters
 * (Sørensen–Dice style: 2 * common / (lenA + lenB)).
 */
function lineSimilarity(a: string, b: string): number {
	if (a === b) return 1;
	if (a.length === 0 || b.length === 0) return 0;
	let common = 0;
	for (const part of Diff.diffChars(a, b)) {
		if (!part.added && !part.removed) {
			common += part.value.length;
		}
	}
	return (2 * common) / (a.length + b.length);
}

/** Minimum similarity for a removed/added pair to get intra-line highlighting. */
const PAIR_THRESHOLD = 0.4;
/** Skip pairing when the block is huge (removed * added comparisons). */
const MAX_PAIR_COMPARISONS = 2500;

/**
 * Greedily pair removed lines with their most similar added line within a
 * change block. Returns a map from removed-line index (within the block) to
 * added-line index. Unpaired lines render without token highlighting.
 */
function pairBlockLines(removed: string[], added: string[]): Map<number, number> {
	const pairs = new Map<number, number>();
	if (removed.length === 0 || added.length === 0) return pairs;
	if (removed.length * added.length > MAX_PAIR_COMPARISONS) return pairs;

	const takenAdded = new Set<number>();
	for (let r = 0; r < removed.length; r++) {
		let bestIdx = -1;
		let bestScore = PAIR_THRESHOLD;
		for (let a = 0; a < added.length; a++) {
			if (takenAdded.has(a)) continue;
			const score = lineSimilarity(removed[r], added[a]);
			if (score >= bestScore) {
				bestScore = score;
				bestIdx = a;
			}
		}
		if (bestIdx !== -1) {
			pairs.set(r, bestIdx);
			takenAdded.add(bestIdx);
		}
	}
	return pairs;
}

type Segment = { text: string; changed: boolean };

/**
 * Compute word-level diff segments for a removed/added line pair.
 * Leading whitespace of the first changed token per side is marked unchanged
 * so indentation never gets highlighted.
 */
function computeIntraLineSegments(
	oldContent: string,
	newContent: string,
): { removedSegs: Segment[]; addedSegs: Segment[] } {
	const removedSegs: Segment[] = [];
	const addedSegs: Segment[] = [];
	let isFirstRemoved = true;
	let isFirstAdded = true;

	for (const part of Diff.diffWords(oldContent, newContent)) {
		if (part.removed) {
			let value = part.value;
			if (isFirstRemoved) {
				isFirstRemoved = false;
				const leadingWs = value.match(/^(\s*)/)?.[1] || "";
				if (leadingWs) {
					removedSegs.push({ text: leadingWs, changed: false });
					value = value.slice(leadingWs.length);
				}
			}
			if (value) removedSegs.push({ text: value, changed: true });
		} else if (part.added) {
			let value = part.value;
			if (isFirstAdded) {
				isFirstAdded = false;
				const leadingWs = value.match(/^(\s*)/)?.[1] || "";
				if (leadingWs) {
					addedSegs.push({ text: leadingWs, changed: false });
					value = value.slice(leadingWs.length);
				}
			}
			if (value) addedSegs.push({ text: value, changed: true });
		} else {
			removedSegs.push({ text: part.value, changed: false });
			addedSegs.push({ text: part.value, changed: false });
		}
	}

	return { removedSegs, addedSegs };
}

/** Style a segment: line color, with a background tint on changed tokens. */
function renderSegment(seg: Segment, lineColor: "toolDiffAdded" | "toolDiffRemoved"): string {
	if (!seg.changed) {
		return theme.fg(lineColor, seg.text);
	}
	const bgColor = lineColor === "toolDiffAdded" ? "toolDiffAddedBg" : "toolDiffRemovedBg";
	return theme.bg(bgColor, theme.fg(lineColor, seg.text));
}

export interface RenderDiffOptions {
	/** File path (unused, kept for API compatibility) */
	filePath?: string;
}

/**
 * Render a diff string with a two-column line-number gutter, colored lines,
 * and intra-line change highlighting.
 * - Gutter: old | new line numbers, right-aligned, dimmed, `│` separator
 * - Context lines: gray
 * - Removed/added lines: red/green fg with `-`/`+` marker
 * - Changed tokens within paired lines: background tint (toolDiffAddedBg/toolDiffRemovedBg)
 */
export function renderDiff(diffText: string, _options: RenderDiffOptions = {}): string {
	const rows = parseRows(diffText);

	let width = 0;
	for (const row of rows) {
		if (row.kind === "sep") continue;
		const nums =
			row.kind === "context" ? [row.oldNum, row.newNum] : row.kind === "removed" ? [row.oldNum] : [row.newNum];
		for (const n of nums) width = Math.max(width, String(n).length);
	}
	width = Math.max(width, 1);

	const blank = " ".repeat(width);
	const sep = theme.fg("toolDiffLineNum", "│");
	const result: string[] = [];

	let i = 0;
	while (i < rows.length) {
		const row = rows[i];

		if (row.kind === "sep") {
			result.push(`${blank} ${blank} ${sep} ${theme.fg("toolDiffLineNum", "...")}`);
			i++;
			continue;
		}

		if (row.kind === "context") {
			const gutter = theme.fg(
				"toolDiffLineNum",
				`${String(row.oldNum).padStart(width)} ${String(row.newNum).padStart(width)}`,
			);
			result.push(`${gutter} ${sep} ${theme.fg("toolDiffContext", replaceTabs(row.content))}`);
			i++;
			continue;
		}

		if (row.kind === "removed") {
			// Collect the whole change block: consecutive removed lines, then added lines
			const removedRows: Extract<DiffRow, { kind: "removed" }>[] = [];
			while (i < rows.length && rows[i].kind === "removed") {
				removedRows.push(rows[i] as Extract<DiffRow, { kind: "removed" }>);
				i++;
			}
			const addedRows: Extract<DiffRow, { kind: "added" }>[] = [];
			while (i < rows.length && rows[i].kind === "added") {
				addedRows.push(rows[i] as Extract<DiffRow, { kind: "added" }>);
				i++;
			}

			const removedContents = removedRows.map((r) => replaceTabs(r.content));
			const addedContents = addedRows.map((a) => replaceTabs(a.content));
			const pairs = pairBlockLines(removedContents, addedContents);

			const removedSegs: (Segment[] | null)[] = removedRows.map(() => null);
			const addedSegs: (Segment[] | null)[] = addedRows.map(() => null);
			for (const [r, a] of pairs) {
				const segs = computeIntraLineSegments(removedContents[r], addedContents[a]);
				removedSegs[r] = segs.removedSegs;
				addedSegs[a] = segs.addedSegs;
			}

			for (let r = 0; r < removedRows.length; r++) {
				const gutter = theme.fg("toolDiffLineNum", `${String(removedRows[r].oldNum).padStart(width)} ${blank}`);
				const marker = theme.fg("toolDiffRemoved", "-");
				const segs = removedSegs[r];
				const content = segs
					? segs.map((s) => renderSegment(s, "toolDiffRemoved")).join("")
					: theme.fg("toolDiffRemoved", removedContents[r]);
				result.push(`${gutter} ${sep} ${marker} ${content}`);
			}
			for (let a = 0; a < addedRows.length; a++) {
				const gutter = theme.fg("toolDiffLineNum", `${blank} ${String(addedRows[a].newNum).padStart(width)}`);
				const marker = theme.fg("toolDiffAdded", "+");
				const segs = addedSegs[a];
				const content = segs
					? segs.map((s) => renderSegment(s, "toolDiffAdded")).join("")
					: theme.fg("toolDiffAdded", addedContents[a]);
				result.push(`${gutter} ${sep} ${marker} ${content}`);
			}
			continue;
		}

		// Standalone added line (not preceded by removed lines)
		const gutter = theme.fg("toolDiffLineNum", `${blank} ${String(row.newNum).padStart(width)}`);
		const marker = theme.fg("toolDiffAdded", "+");
		result.push(`${gutter} ${sep} ${marker} ${theme.fg("toolDiffAdded", replaceTabs(row.content))}`);
		i++;
	}

	return result.join("\n");
}
