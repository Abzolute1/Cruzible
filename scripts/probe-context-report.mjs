import { readFileSync } from "node:fs";
import {
	buildSessionContext,
	migrateSessionEntries,
	parseSessionEntries,
} from "../packages/coding-agent/dist/core/session-manager.js";
import { createContextHygieneCopy } from "../packages/coding-agent/dist/core/compaction/micro-compact.js";
import { estimateContextTokens } from "../packages/coding-agent/dist/core/compaction/compaction.js";

const sessionPath = process.argv[2];
if (!sessionPath) {
	console.error("usage: scripts/probe-context-report.mjs <session.jsonl>");
	process.exit(1);
}

const content = readFileSync(sessionPath, "utf8");
const entries = parseSessionEntries(content);
migrateSessionEntries(entries);
const sessionEntries = entries.filter((entry) => entry.type !== "session");
const context = buildSessionContext(sessionEntries);
const rawEstimate = estimateContextTokens(context.messages);
const cleanedMessages = createContextHygieneCopy(context.messages);
const liveEstimate = estimateContextTokens(cleanedMessages);

console.log(`latest_session=${sessionPath}`);
console.log(`raw_context_tokens=${rawEstimate.tokens}`);
console.log(`live_context_tokens=${liveEstimate.tokens}`);
console.log(`raw_usage_tokens=${rawEstimate.usageTokens}`);
console.log(`live_usage_tokens=${liveEstimate.usageTokens}`);
console.log(`raw_trailing_tokens=${rawEstimate.trailingTokens}`);
console.log(`live_trailing_tokens=${liveEstimate.trailingTokens}`);
console.log(`message_count=${context.messages.length}`);
console.log(`live_message_count=${cleanedMessages.length}`);
