/**
 * Runtime validation for incoming RPC commands.
 *
 * The stdin protocol is untrusted JSON: rpc-mode used to cast parsed lines to
 * RpcCommand with no checks, so a malformed payload crashed deep in the
 * command handlers. These are hand-rolled narrow checks per command type (no
 * schema dependency).
 */

import type { RpcCommand } from "./rpc-types.js";

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);
const QUEUE_MODES = new Set(["all", "one-at-a-time"]);
const STREAMING_BEHAVIORS = new Set(["steer", "followUp"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

type FieldType = "string" | "boolean" | "array";

function checkField(
	command: Record<string, unknown>,
	field: string,
	fieldType: FieldType,
	required: boolean,
): string | undefined {
	const value = command[field];
	if (value === undefined) {
		return required ? `missing required field '${field}'` : undefined;
	}
	switch (fieldType) {
		case "string":
			return typeof value === "string" ? undefined : `field '${field}' must be a string`;
		case "boolean":
			return typeof value === "boolean" ? undefined : `field '${field}' must be a boolean`;
		case "array":
			return Array.isArray(value) ? undefined : `field '${field}' must be an array`;
	}
}

/** Commands that tear down or replace the live session; rejected while streaming. */
export const SESSION_MUTATING_COMMANDS: ReadonlySet<RpcCommand["type"]> = new Set([
	"new_session",
	"switch_session",
	"fork",
]);

/**
 * Validate a parsed JSON value as an RpcCommand.
 * Returns undefined when valid, otherwise a human-readable error message.
 */
export function validateRpcCommand(value: unknown): string | undefined {
	if (!isRecord(value)) {
		return "command must be a JSON object";
	}
	if (typeof value.type !== "string") {
		return "command must have a string 'type' field";
	}
	if (value.id !== undefined && typeof value.id !== "string") {
		return "field 'id' must be a string";
	}

	const field = (name: string, type: FieldType, required: boolean): string | undefined =>
		checkField(value, name, type, required);

	switch (value.type as RpcCommand["type"]) {
		case "prompt":
			return (
				field("message", "string", true) ??
				field("images", "array", false) ??
				(value.streamingBehavior !== undefined && !STREAMING_BEHAVIORS.has(value.streamingBehavior as string)
					? "field 'streamingBehavior' must be 'steer' or 'followUp'"
					: undefined)
			);
		case "steer":
		case "follow_up":
			return field("message", "string", true) ?? field("images", "array", false);
		case "abort":
		case "get_state":
		case "cycle_model":
		case "get_available_models":
		case "cycle_thinking_level":
		case "abort_retry":
		case "abort_bash":
		case "get_session_stats":
		case "get_fork_messages":
		case "get_last_assistant_text":
		case "get_messages":
		case "get_commands":
			return undefined;
		case "new_session":
			return field("parentSession", "string", false);
		case "set_model":
			return field("provider", "string", true) ?? field("modelId", "string", true);
		case "set_thinking_level":
			return THINKING_LEVELS.has(value.level as string) ? undefined : "field 'level' must be a valid thinking level";
		case "set_steering_mode":
		case "set_follow_up_mode":
			return QUEUE_MODES.has(value.mode as string) ? undefined : "field 'mode' must be 'all' or 'one-at-a-time'";
		case "compact":
			return field("customInstructions", "string", false);
		case "set_auto_compaction":
		case "set_auto_retry":
			return field("enabled", "boolean", true);
		case "bash":
			return field("command", "string", true);
		case "export_html":
			return field("outputPath", "string", false);
		case "switch_session":
			return field("sessionPath", "string", true);
		case "fork":
			return field("entryId", "string", true);
		case "set_session_name":
			return field("name", "string", true);
		default:
			return `unknown command type: ${String(value.type)}`;
	}
}
