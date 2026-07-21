/**
 * Independent acceptance review for autonomous runs.
 *
 * Before a mutation run may stop as "complete", the gate first collects
 * GROUND TRUTH from the workspace itself: which files were actually modified
 * during the run (mtime window + git status), and — when the recorded
 * verification detail looks like a shell command — a fresh re-run of that
 * command. A fresh re-run that fails rejects completion outright, without an
 * LLM call. Otherwise one review call asks a verifier model (the configured
 * verifierModel route, else the active model) to judge the goal against the
 * ground truth, with the ledger's own record included only as secondary
 * context. The reviewer answers strict JSON
 * `{ "verdict": "accept" | "reject", "reason": string }`.
 *
 * Failure posture is deliberately soft:
 * - "reject" (or an unparseable response) is treated as a failed verification —
 *   the run continues with the review reason as the blocker detail.
 * - A reviewer that cannot be reached at all (call throws) yields `undefined`,
 *   which callers treat as "review unavailable" and skip — completion is never
 *   blocked solely because the reviewer is missing.
 */

import { spawnSync } from "node:child_process";
import { type Dirent, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { completeSimple, type Model } from "@ag1/ai";
import type { AutonomousRunLedger } from "./ledger.js";

export interface AcceptanceReviewVerdict {
	verdict: "accept" | "reject";
	reason: string;
}

/** A workspace file whose mtime falls inside the run's time window. */
export interface WorkspaceEvidenceFile {
	/** Workspace-relative path. */
	path: string;
	mtimeMs: number;
}

/**
 * Ground truth collected from the workspace itself (reality, not receipts):
 * which files actually changed during the run, plus git's own view when the
 * workspace is a git repo.
 */
export interface WorkspaceEvidence {
	changedFiles: WorkspaceEvidenceFile[];
	gitStatus?: string;
}

/** Result of re-running the recorded verification command against the real workspace. */
export interface VerificationRerunResult {
	command: string;
	/** Process exit code; null when the process never produced one (timeout, spawn failure). */
	exitCode: number | null;
	timedOut: boolean;
	/** Last ~2k chars of combined stdout/stderr, trimmed. */
	outputTail: string;
}

export interface AcceptanceReviewInput {
	goal: string;
	ledger: Pick<AutonomousRunLedger, "touchedFiles" | "recentMutations">;
	verificationDetail?: string;
	workspaceEvidence?: WorkspaceEvidence;
	verificationRerun?: VerificationRerunResult;
}

/** Injectable for tests: returns the reviewer's raw text response. */
export type AcceptanceReviewRunner = (model: Model<any>, systemPrompt: string, userText: string) => Promise<string>;

const ACCEPTANCE_REVIEW_SYSTEM_PROMPT = [
	"You are an independent acceptance reviewer for an autonomous coding run. You did not do the work; you judge it.",
	"You receive the goal, ground truth collected from the workspace itself (files actually modified during the run, git status, and a fresh re-run of the recorded verification command), and the run's own ledger record as secondary, self-reported context.",
	"Trust the ground truth over the ledger: the ledger is what the run claims, the ground truth is what really happened.",
	"Answer ACCEPT only when the evidence shows the goal is genuinely implemented and verified.",
	"Answer REJECT when any of these hold:",
	"- the changes do not implement the goal,",
	"- files or tests were deleted or weakened to make verification pass,",
	"- the verification does not actually exercise the change (e.g. unrelated command, no test covers the new behavior),",
	"- the ground truth contradicts the ledger (e.g. a mutation run with no files actually modified on disk).",
	"Respond with strict JSON only, no prose, no markdown fences:",
	'{ "verdict": "accept" | "reject", "reason": "<one sentence citing the decisive evidence>" }',
].join("\n");

const MAX_FIELD_CHARS = 4000;
const MAX_EVIDENCE_FILES = 50;
const MAX_SCAN_ENTRIES = 50_000;
const OUTPUT_TAIL_CHARS = 2000;
const GIT_STATUS_TIMEOUT_MS = 5000;
const EVIDENCE_EXCLUDED_DIRS = new Set(["node_modules", ".git", "Debug"]);
const EVIDENCE_LOCKFILE_NAMES = new Set([
	"package-lock.json",
	"yarn.lock",
	"pnpm-lock.yaml",
	"bun.lock",
	"bun.lockb",
	"Cargo.lock",
	"composer.lock",
	"Gemfile.lock",
	"poetry.lock",
]);
/** Executables a verification detail may plausibly start with to count as a shell command. */
const COMMAND_FIRST_TOKENS = new Set([
	"node",
	"npm",
	"npx",
	"pnpm",
	"yarn",
	"bun",
	"deno",
	"vitest",
	"jest",
	"pytest",
	"python",
	"python3",
	"cargo",
	"go",
	"make",
	"tsc",
	"tsgo",
	"eslint",
	"biome",
	"sh",
	"bash",
	"git",
	"cd",
	"env",
]);

function truncate(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/**
 * Collect ground truth from the workspace: files modified at or after
 * `sinceMs` (the run's start), excluding dependency/VCS/debug noise and
 * lockfiles, capped at the newest ~50 paths. When the workspace is a git
 * repo, `git status --porcelain` output is included as well. Never throws —
 * any failure degrades to whatever evidence could still be collected.
 */
export function collectWorkspaceEvidence(cwd: string, sinceMs: number): WorkspaceEvidence {
	const evidence: WorkspaceEvidence = { changedFiles: [] };
	try {
		const found: WorkspaceEvidenceFile[] = [];
		let visited = 0;
		const walk = (dir: string): void => {
			if (visited >= MAX_SCAN_ENTRIES) return;
			let entries: Dirent[];
			try {
				entries = readdirSync(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				if (visited >= MAX_SCAN_ENTRIES) return;
				visited++;
				const fullPath = join(dir, entry.name);
				if (entry.isDirectory()) {
					if (!EVIDENCE_EXCLUDED_DIRS.has(entry.name)) walk(fullPath);
					continue;
				}
				if (EVIDENCE_LOCKFILE_NAMES.has(entry.name)) continue;
				try {
					const stat = statSync(fullPath);
					if (stat.isFile() && stat.mtimeMs >= sinceMs) {
						found.push({ path: relative(cwd, fullPath) || entry.name, mtimeMs: stat.mtimeMs });
					}
				} catch {
					// Unreadable entry (broken symlink, permissions) — skip it.
				}
			}
		};
		walk(cwd);
		found.sort((a, b) => b.mtimeMs - a.mtimeMs);
		evidence.changedFiles = found.slice(0, MAX_EVIDENCE_FILES);
	} catch {
		// Evidence collection must never break the review — degrade to empty.
	}
	try {
		if (existsSync(join(cwd, ".git"))) {
			const result = spawnSync("git", ["status", "--porcelain"], {
				cwd,
				timeout: GIT_STATUS_TIMEOUT_MS,
				encoding: "utf8",
				maxBuffer: 256 * 1024,
			});
			if (!result.error && result.status === 0 && typeof result.stdout === "string" && result.stdout.trim()) {
				evidence.gitStatus = truncate(result.stdout.trim(), MAX_FIELD_CHARS);
			}
		}
	} catch {
		// Git is best-effort context only.
	}
	return evidence;
}

/**
 * Conservative judge: does a recorded verification detail look like a shell
 * command we can re-run, rather than prose? Only single-line details whose
 * first token is a known executable (or an explicit path) qualify — anything
 * sentence-like is left to the LLM review path.
 */
export function looksLikeShellCommand(detail: string | undefined): detail is string {
	if (!detail) return false;
	const normalized = detail.trim();
	if (!normalized || normalized.length > 300 || normalized.includes("\n")) return false;
	const firstToken = normalized.split(/\s+/, 1)[0] ?? "";
	if (firstToken.startsWith("./") || firstToken.startsWith("/")) return true;
	return COMMAND_FIRST_TOKENS.has(firstToken.toLowerCase());
}

/**
 * Re-run a verification command against the real workspace and capture what
 * actually happens: exit code plus a trimmed tail of combined output. Never
 * throws — a spawn failure yields `exitCode: null`.
 */
export function rerunVerificationCommand(command: string, cwd: string, timeoutMs = 120_000): VerificationRerunResult {
	try {
		const result = spawnSync("sh", ["-lc", command], {
			cwd,
			timeout: timeoutMs,
			encoding: "utf8",
			maxBuffer: 1024 * 1024,
		});
		const output = [result.stdout, result.stderr]
			.filter((part): part is string => typeof part === "string")
			.join("\n")
			.trim();
		const outputTail = output.length > OUTPUT_TAIL_CHARS ? `…${output.slice(-OUTPUT_TAIL_CHARS)}` : output;
		const timedOut =
			(result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" || result.signal === "SIGTERM";
		return {
			command,
			exitCode: typeof result.status === "number" ? result.status : null,
			timedOut,
			outputTail,
		};
	} catch (error) {
		return {
			command,
			exitCode: null,
			timedOut: false,
			outputTail: error instanceof Error ? error.message : String(error),
		};
	}
}

export function buildAcceptanceReviewUserText(input: AcceptanceReviewInput): string {
	const touched = input.ledger.touchedFiles.length > 0 ? input.ledger.touchedFiles.join("\n") : "(none recorded)";
	const mutations =
		input.ledger.recentMutations.length > 0 ? input.ledger.recentMutations.join("\n") : "(none recorded)";
	const verification = input.verificationDetail?.trim() || "(no verification output recorded)";
	const sections = [`Goal:\n${input.goal}`];
	if (input.workspaceEvidence) {
		const changed =
			input.workspaceEvidence.changedFiles.length > 0
				? input.workspaceEvidence.changedFiles
						.map((file) => `${file.path} (mtime ${new Date(file.mtimeMs).toISOString()})`)
						.join("\n")
				: "(none — no workspace files were modified during this run)";
		sections.push(`Ground truth — files modified on disk during this run:\n${changed}`);
		if (input.workspaceEvidence.gitStatus) {
			sections.push(`Ground truth — git status (porcelain):\n${input.workspaceEvidence.gitStatus}`);
		}
	}
	if (input.verificationRerun) {
		const rerun = input.verificationRerun;
		const outcome = rerun.timedOut
			? `timed out (no exit code)`
			: `exited ${rerun.exitCode === null ? "with no exit code (could not run)" : rerun.exitCode}`;
		sections.push(
			`Ground truth — fresh re-run of the recorded verification command \`${rerun.command}\`: ${outcome}\nOutput tail:\n${rerun.outputTail || "(no output)"}`,
		);
	}
	sections.push(
		`Ledger record (secondary, self-reported by the run) — files changed:\n${touched}`,
		`Ledger record — change summary:\n${mutations}`,
		`Ledger record — latest verification output:\n${verification}`,
	);
	return truncate(sections.join("\n\n"), MAX_FIELD_CHARS * 3);
}

/** Extract a JSON object from the raw response, tolerating code fences and surrounding prose. */
function extractJsonObject(text: string): string | undefined {
	const trimmed = text.trim();
	if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
	const fenced = trimmed.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/i);
	if (fenced?.[1]) return fenced[1];
	const start = trimmed.indexOf("{");
	const end = trimmed.lastIndexOf("}");
	if (start !== -1 && end > start) return trimmed.slice(start, end + 1);
	return undefined;
}

/**
 * Parse the reviewer's response. Anything that is not a JSON object with
 * verdict "accept" or "reject" degrades to a reject with the raw response as
 * the reason — callers treat it as a failed verification, not a hard error.
 */
export function parseAcceptanceReviewResponse(text: string): AcceptanceReviewVerdict {
	const candidate = extractJsonObject(text);
	if (candidate) {
		try {
			const parsed: unknown = JSON.parse(candidate);
			const verdict = (parsed as { verdict?: unknown })?.verdict;
			const rawReason = (parsed as { reason?: unknown })?.reason;
			const reason = typeof rawReason === "string" && rawReason.trim() ? rawReason.trim() : "(no reason given)";
			if (verdict === "accept" || verdict === "reject") {
				return { verdict, reason };
			}
		} catch {
			// Fall through to the unparseable verdict below.
		}
	}
	return {
		verdict: "reject",
		reason: `acceptance review response was not parseable: ${truncate(text.trim(), 200) || "(empty response)"}`,
	};
}

async function defaultReviewRunner(model: Model<any>, systemPrompt: string, userText: string): Promise<string> {
	const response = await completeSimple(model, {
		systemPrompt,
		messages: [
			{
				role: "user",
				content: [{ type: "text" as const, text: userText }],
				timestamp: Date.now(),
			},
		],
	});
	if (response.stopReason === "error") {
		throw new Error(response.errorMessage || "Acceptance review call failed");
	}
	return response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

/**
 * Run one acceptance review. Returns the verdict, or `undefined` when the
 * reviewer could not be reached (treated by callers as "review unavailable").
 */
export async function runAcceptanceReview(
	model: Model<any>,
	input: AcceptanceReviewInput,
	runReview?: AcceptanceReviewRunner,
): Promise<AcceptanceReviewVerdict | undefined> {
	const reviewRunner = runReview ?? defaultReviewRunner;
	let raw: string;
	try {
		raw = await reviewRunner(model, ACCEPTANCE_REVIEW_SYSTEM_PROMPT, buildAcceptanceReviewUserText(input));
	} catch {
		return undefined;
	}
	return parseAcceptanceReviewResponse(raw);
}
