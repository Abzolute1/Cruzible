#!/usr/bin/env node
/**
 * opencode-usage.mjs — scrape opencode's on-disk session DB for token usage
 * of eval runs driven by harness-benchmark-run.mjs.
 *
 * opencode (>=1.17) stores sessions in ~/.local/share/opencode/opencode.db (SQLite):
 *   session.directory — workspace cwd the session ran in
 *   session.tokens_input / tokens_output / tokens_reasoning / tokens_cache_read / tokens_cache_write
 *
 * Usage:
 *   node scripts/opencode-usage.mjs --eval-dir <runner adapter out-dir> [--db ~/.local/share/opencode/opencode.db] [--out file.json]
 *
 * --eval-dir should be the runner's adapter out-dir (the one containing <scenario>/fixture dirs).
 * Prints a per-scenario table + aggregate (incl. tokens/solved when verify results exist).
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

function parseArgs(argv) {
	const args = { evalDir: "", db: join(process.env.HOME, ".local/share/opencode/opencode.db"), out: "" };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--eval-dir") args.evalDir = resolve(argv[++i] ?? "");
		else if (argv[i] === "--db") args.db = resolve(argv[++i] ?? "");
		else if (argv[i] === "--out") args.out = resolve(argv[++i] ?? "");
	}
	if (!args.evalDir) throw new Error("--eval-dir is required");
	if (!existsSync(args.db)) throw new Error(`opencode DB not found at ${args.db}`);
	return args;
}

function listFixtureDirs(evalDir) {
	const dirs = [];
	for (const entry of readdirSync(evalDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const fixture = join(evalDir, entry.name, "fixture");
		if (existsSync(fixture)) dirs.push({ scenario: entry.name, fixture });
	}
	return dirs;
}

function loadVerifyResults(evalDir) {
	const results = new Map();
	for (const candidate of [
		join(evalDir, "opencode.results.json"),
		join(evalDir, "opencode.run.json"),
		join(evalDir, "..", "opencode.results.json"),
		join(evalDir, "..", "opencode.run.json"),
	]) {
		if (!existsSync(candidate)) continue;
		try {
			const data = JSON.parse(readFileSync(candidate, "utf8"));
			const rows = Array.isArray(data) ? data : (data.rows ?? []);
			for (const row of rows) {
				if (row.scenario) results.set(row.scenario, row.verify_status ?? "");
			}
		} catch {
			// ignore malformed results files
		}
	}
	return results;
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const fixtures = listFixtureDirs(args.evalDir);
	if (fixtures.length === 0) throw new Error(`No <scenario>/fixture dirs under ${args.evalDir}`);
	const verifyResults = loadVerifyResults(args.evalDir);

	const db = new DatabaseSync(args.db, { readOnly: true });
	const sessions = db
		.prepare(
			`SELECT id, directory, cost,
							tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write
			 FROM session`,
		)
		.all();
	db.close();

	const rows = [];
	for (const { scenario, fixture } of fixtures) {
		const matched = sessions.filter(
			(session) => session.directory === fixture || session.directory.startsWith(`${fixture}/`),
		);
		const totals = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0, total: 0 };
		for (const session of matched) {
			totals.input += Number(session.tokens_input ?? 0);
			totals.output += Number(session.tokens_output ?? 0);
			totals.reasoning += Number(session.tokens_reasoning ?? 0);
			totals.cacheRead += Number(session.tokens_cache_read ?? 0);
			totals.cacheWrite += Number(session.tokens_cache_write ?? 0);
			totals.cost += Number(session.cost ?? 0);
		}
		totals.total = totals.input + totals.output + totals.reasoning;
		rows.push({ scenario, sessions: matched.length, verify: verifyResults.get(scenario) ?? "", ...totals });
	}

	const solved = rows.filter((row) => row.verify === "passed").length;
	const aggregate = {
		scenarios: rows.length,
		solved,
		total_tokens: rows.reduce((sum, row) => sum + row.total, 0),
		total_input: rows.reduce((sum, row) => sum + row.input, 0),
		total_output: rows.reduce((sum, row) => sum + row.output, 0),
		total_reasoning: rows.reduce((sum, row) => sum + row.reasoning, 0),
		cache_read: rows.reduce((sum, row) => sum + row.cacheRead, 0),
		cache_write: rows.reduce((sum, row) => sum + row.cacheWrite, 0),
		total_cost: Math.round(rows.reduce((sum, row) => sum + row.cost, 0) * 1e6) / 1e6,
		tokens_per_solved: Math.round(rows.reduce((sum, row) => sum + row.total, 0) / Math.max(1, solved)),
		matched_sessions: rows.reduce((sum, row) => sum + row.sessions, 0),
	};

	console.log(`eval_dir=${args.evalDir}`);
	for (const row of rows) {
		console.log(
			`${row.scenario.padEnd(38)} ${(row.verify || "?").padEnd(7)} sessions=${row.sessions} in=${String(row.input).padStart(7)} out=${String(row.output).padStart(6)} total=${String(row.total).padStart(7)}`,
		);
	}
	console.log(
		`\nscenarios=${aggregate.scenarios} solved=${aggregate.solved} total_tokens=${aggregate.total_tokens} tokens_per_solved=${aggregate.tokens_per_solved} matched_sessions=${aggregate.matched_sessions}`,
	);

	if (args.out) {
		writeFileSync(args.out, `${JSON.stringify({ eval_dir: args.evalDir, aggregate, rows }, null, 2)}\n`, "utf8");
		console.log(`wrote ${args.out}`);
	}
}

main();
