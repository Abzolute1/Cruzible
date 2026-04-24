#!/usr/bin/env node

import { readFileSync } from "node:fs";

const logPath = process.argv[2];
if (!logPath) {
	console.error("usage: scripts/opencode-log-summary.mjs <opencode-log.txt>");
	process.exit(1);
}

const text = readFileSync(logPath, "utf8");

function uniqueMatches(pattern, index = 1) {
	return [...new Set([...text.matchAll(pattern)].map((match) => match[index]).filter(Boolean))];
}

function classifyError() {
	if (/wal_checkpoint\(PASSIVE\)/i.test(text)) return "db_wal_checkpoint_failure";
	if (/Failed to load model/i.test(text)) return "model_load_failure";
	if (/ECONNREFUSED|Connection refused/i.test(text)) return "connection_refused";
	if (/stream error/i.test(text)) return "provider_stream_error";
	if (/AI_APICallError/i.test(text)) return "provider_api_error";
	return "";
}

function detectStallSignatures() {
	const signatures = new Set();
	if (/Failed to load model/i.test(text)) signatures.add("model_load_failure");
	if (/wal_checkpoint\(PASSIVE\)/i.test(text)) signatures.add("db_wal_checkpoint_failure");
	if (/enable javascript|just a moment|verify your browser/i.test(text)) signatures.add("placeholder_fetch");
	if (/<tool_call>|<function=|<function-/i.test(text)) signatures.add("xml_tool_leak");
	if (/Connection error\.|ECONNREFUSED|Connection refused/i.test(text)) signatures.add("connection_error");
	if (/stream error/i.test(text)) signatures.add("provider_stream_error");
	return [...signatures];
}

const sessionIds = uniqueMatches(/sessionID=(ses_[A-Za-z0-9]+)/g);
const providers = uniqueMatches(/service=llm providerID=([A-Za-z0-9_-]+)/g);
const models = uniqueMatches(/service=llm [^\n]* modelID=([A-Za-z0-9._:-]+)/g);
const availableTools = uniqueMatches(/service=tool\.registry status=started ([A-Za-z0-9._-]+)/g)
	.filter((name) => !["invalid", "question"].includes(name));
const promptSteps = uniqueMatches(/service=session\.prompt step=(\d+)/g)
	.map((value) => Number.parseInt(value, 10))
	.filter((value) => Number.isFinite(value));

console.log(`log_path=${logPath}`);
console.log(`session_ids=${sessionIds.join(",")}`);
console.log(`provider_ids=${providers.join(",")}`);
console.log(`model_ids=${models.join(",")}`);
console.log(`available_tools=${availableTools.join(",")}`);
console.log(`prompt_step_count=${promptSteps.length > 0 ? Math.max(...promptSteps) + 1 : 0}`);
console.log(`error_kind=${classifyError()}`);
console.log(`stall_signatures=${detectStallSignatures().join(",")}`);
