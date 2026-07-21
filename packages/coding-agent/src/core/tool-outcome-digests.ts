/**
 * Content-aware digests for tool outcomes.
 *
 * callDigest identifies the *operation* (tool + argument content), resultDigest
 * identifies the *outcome* (error flag + produced content). Loop detection
 * compares these instead of crude tool|path fingerprints, so repeated use of a
 * tool with different arguments or changing results is never flagged.
 *
 * Shared by interactive mode, autonomous mode, and the session debug logger.
 */

/** FNV-1a 32-bit — tiny, dependency-free, stable across runs. */
function fnv1a(input: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16);
}

const MAX_DIGEST_PAYLOAD = 4000;

function hashPayload(parts: Array<string | undefined>): string {
	const payload = parts
		.map((part) => part ?? "")
		.join("|")
		.slice(0, MAX_DIGEST_PAYLOAD);
	return fnv1a(payload);
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function argsPath(args: Record<string, unknown>): string | undefined {
	return asString(args.path) ?? asString(args.filePath) ?? asString(args.file_path);
}

/** JSON.stringify with sorted object keys, for stable fallback digests. */
function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "";
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined && typeof v !== "function")
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
	return `{${entries.join(",")}}`;
}

/**
 * Semantic identity of a tool call. Two calls with the same digest are the
 * same operation; different edits to the same file produce different digests.
 */
export function buildToolCallDigest(toolName: string, args: Record<string, unknown> | undefined): string {
	const tool = toolName.trim().toLowerCase();
	if (!args) return `${tool}|`;

	let identity: string | undefined;

	if (tool === "edit" || tool === "multi_edit" || tool === "patch" || tool === "str_replace_editor") {
		const path = argsPath(args) ?? "";
		const edits = Array.isArray(args.edits) ? args.edits : undefined;
		if (edits) {
			identity = `${path}|${hashPayload(edits.map((e) => stableStringify(e)))}`;
		} else if (typeof args.oldText === "string" || typeof args.newText === "string") {
			identity = `${path}|${hashPayload([asString(args.oldText), asString(args.newText)])}`;
		} else if (typeof args.old_string === "string" || typeof args.new_string === "string") {
			identity = `${path}|${hashPayload([asString(args.old_string), asString(args.new_string)])}`;
		}
	} else if (tool === "write") {
		identity = `${argsPath(args) ?? ""}|${hashPayload([asString(args.content)])}`;
	} else if (tool === "bash" || tool === "verify" || tool === "run") {
		const command = asString(args.command);
		if (command) identity = command.replace(/\s+/g, " ").trim();
	} else if (tool === "read" || tool === "read_file") {
		const path = argsPath(args) ?? "";
		identity = `${path}|${args.offset ?? ""}|${args.limit ?? ""}`;
	} else if (tool === "grep") {
		identity = `${asString(args.pattern) ?? ""}|${argsPath(args) ?? ""}|${stableStringify({
			glob: args.glob,
			type: args.type,
			literal: args.literal,
			i: args.i ?? args.ignoreCase,
		})}`;
	} else if (tool === "websearch") {
		identity = asString(args.query);
	} else if (tool === "webfetch") {
		identity = asString(args.url);
	} else if (tool === "task") {
		identity = `${asString(args.type) ?? ""}:${asString(args.description) ?? ""}`;
	}

	if (identity === undefined) {
		// Generic fallback: full arguments, stable key order
		identity = stableStringify(args);
	}

	return `${tool}|${fnv1a(identity)}`;
}

/**
 * Identity of what a tool call produced. Prefer structural details (the diff
 * an edit generated) over result text; fall back to normalized result text.
 * Includes the error flag so an error and a success never compare equal.
 */
export function buildToolResultDigest(result: unknown, isError: boolean): string {
	const flag = isError ? "err" : "ok";

	let payload: string | undefined;
	if (result && typeof result === "object") {
		const details = (result as { details?: unknown }).details;
		if (details && typeof details === "object") {
			const diff = (details as { diff?: unknown }).diff;
			if (typeof diff === "string" && diff.length > 0) {
				payload = diff;
			}
		}
		if (payload === undefined) {
			const content = (result as { content?: unknown }).content;
			if (Array.isArray(content)) {
				const text = content
					.filter((item) => item && typeof item === "object" && (item as { type?: unknown }).type === "text")
					.map((item) => (item as { text?: unknown }).text)
					.filter((t): t is string => typeof t === "string")
					.join("\n");
				if (text.length > 0) {
					payload = text;
				}
			}
		}
	}

	if (payload === undefined) return flag;
	return `${flag}|${fnv1a(payload.replace(/\s+/g, " ").trim().slice(0, MAX_DIGEST_PAYLOAD))}`;
}
