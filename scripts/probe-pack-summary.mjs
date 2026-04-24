#!/usr/bin/env node

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function parseReport(text) {
  const result = {};
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const blockMatch = line.match(/^([a-zA-Z0-9_]+)<<EOF$/);
    if (blockMatch) {
      const key = blockMatch[1];
      const buffer = [];
      i += 1;
      while (i < lines.length && lines[i] !== "EOF") {
        buffer.push(lines[i]);
        i += 1;
      }
      result[key] = buffer.join("\n").trim();
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    result[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return result;
}

function parseKeyValueBlock(text) {
  const result = {};
  if (!text) return result;
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    result[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return result;
}

function parseInteger(value) {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function summarizePack(root) {
  const labels = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const rows = [];
  const aggregate = {
    probes: 0,
    ok: 0,
    unstable: 0,
    backendUnavailable: 0,
    noSession: 0,
    totalToolCalls: 0,
    totalCallsBeforeFinal: 0,
    repeatedToolProbes: 0,
    placeholderProbes: 0,
    xmlLeakProbes: 0,
    connectionErrorProbes: 0,
  };

  for (const label of labels) {
    const reportPath = join(root, label, "probe-report.txt");
    let parsed;
    try {
      parsed = parseReport(readFileSync(reportPath, "utf8"));
    } catch {
      continue;
    }
    const context = parseKeyValueBlock(parsed.context_report);
    const summary = parseKeyValueBlock(parsed.session_summary);
    const stallSignatures = new Set((summary.stall_signatures ?? "").split(",").filter(Boolean));
    const row = {
      label,
      status: parsed.status ?? "unknown",
      attempts: parseInteger(parsed.attempts_run) ?? 0,
      liveContext: parseInteger(context.live_context_tokens) ?? 0,
      rawContext: parseInteger(context.raw_context_tokens) ?? 0,
      firstTool: summary.first_tool && summary.first_tool.trim() ? summary.first_tool : "none",
      toolCalls: parseInteger(summary.tool_call_count) ?? 0,
      beforeFinal: parseInteger(summary.tool_calls_before_final_answer) ?? 0,
      repeatedTools: summary.repeated_tools ?? "",
      stallSignatures: [...stallSignatures].join(","),
    };
    rows.push(row);

    aggregate.probes += 1;
    if (row.status === "ok") aggregate.ok += 1;
    if (row.status === "backend_unavailable") aggregate.backendUnavailable += 1;
    if (row.status === "no_session") aggregate.noSession += 1;
    if (row.status !== "ok") aggregate.unstable += 1;
    aggregate.totalToolCalls += row.toolCalls;
    aggregate.totalCallsBeforeFinal += row.beforeFinal;
    if (row.repeatedTools) aggregate.repeatedToolProbes += 1;
    if (stallSignatures.has("placeholder_fetch")) aggregate.placeholderProbes += 1;
    if (stallSignatures.has("xml_tool_leak")) aggregate.xmlLeakProbes += 1;
    if (stallSignatures.has("connection_error") || row.status === "backend_unavailable") aggregate.connectionErrorProbes += 1;
  }

  console.log(`pack_root=${root}`);
  console.log(`probe_count=${aggregate.probes}`);
  console.log(`ok_probes=${aggregate.ok}`);
  console.log(`unstable_probes=${aggregate.unstable}`);
  console.log(`backend_unavailable_probes=${aggregate.backendUnavailable}`);
  console.log(`no_session_probes=${aggregate.noSession}`);
  console.log(`total_tool_calls=${aggregate.totalToolCalls}`);
  console.log(`total_tool_calls_before_final_answer=${aggregate.totalCallsBeforeFinal}`);
  console.log(`repeated_tool_probes=${aggregate.repeatedToolProbes}`);
  console.log(`placeholder_fetch_probes=${aggregate.placeholderProbes}`);
  console.log(`xml_leak_probes=${aggregate.xmlLeakProbes}`);
  console.log(`connection_error_probes=${aggregate.connectionErrorProbes}`);
  console.log("rows<<EOF");
  console.log("label\tstatus\tattempts\tfirst_tool\ttool_calls\tbefore_final\tlive_ctx\traw_ctx\trepeated_tools\tstall_signatures");
  for (const row of rows) {
    console.log(
      [
        row.label,
        row.status,
        row.attempts,
        row.firstTool,
        row.toolCalls,
        row.beforeFinal,
        row.liveContext,
        row.rawContext,
        row.repeatedTools || "-",
        row.stallSignatures || "-",
      ].join("\t"),
    );
  }
  console.log("EOF");
}

const root = process.argv[2];
if (!root) {
  console.error("usage: scripts/probe-pack-summary.mjs <probe-pack-root>");
  process.exit(1);
}
if (!statSync(root).isDirectory()) {
  console.error(`not a directory: ${root}`);
  process.exit(1);
}

summarizePack(root);
