import type { LgEvent } from "../core/events.js";
import { planLevels } from "../core/engine.js";
import type { Graph } from "../core/graph.js";
import type { RunState } from "../core/types.js";

const COST_NOTE =
  "note: adapters that do not report a price (codex, command) record 0.0000 usd - the number is not estimated.";

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function durationSec(startedAt: string, endedAt: string | null): string {
  if (!startedAt || !endedAt) return "-";
  const ms = Date.parse(endedAt) - Date.parse(startedAt);
  if (Number.isNaN(ms)) return "-";
  return `${(ms / 1000).toFixed(1)}s`;
}

export function renderStatus(state: RunState): string {
  const lines: string[] = [];
  lines.push(`run     ${state.runId}`);
  lines.push(`graph   ${state.graphName}`);
  lines.push(`status  ${state.status}`);
  lines.push(`cwd     ${state.cwd}`);
  lines.push(`updated ${state.updatedAt}`);
  lines.push("");

  const results = Object.values(state.nodes);
  if (results.length === 0) {
    lines.push("no nodes have run yet");
  } else {
    const idWidth = Math.max(4, ...results.map((r) => r.nodeId.length));
    lines.push(`${pad("node", idWidth)}  ${pad("status", 10)}  attempts  ${pad("cost usd", 10)}  duration`);
    for (const r of results) {
      lines.push(
        `${pad(r.nodeId, idWidth)}  ${pad(r.status, 10)}  ${pad(String(r.attempts), 8)}  ${pad(r.costUsd.toFixed(4), 10)}  ${durationSec(r.startedAt, r.endedAt)}`,
      );
    }
    for (const r of results) {
      if (r.error) lines.push(`  ${r.nodeId}: ${r.error}`);
    }
  }

  lines.push("");
  lines.push(
    `budget  ${state.spent.usd.toFixed(4)}/${state.budget.maxUsd.toFixed(4)} usd   ` +
      `${Math.round(state.spent.wallClockSec)}s/${state.budget.maxWallClockSec}s wall clock   ` +
      `${state.spent.nodeRuns}/${state.budget.maxNodeRuns} node runs`,
  );
  lines.push(COST_NOTE);
  return lines.join("\n");
}

export function renderRuns(states: RunState[]): string {
  if (states.length === 0) return "no runs found under .loomgraph/runs";

  const idWidth = Math.max(5, ...states.map((s) => s.runId.length));
  const lines = [`${pad("run", idWidth)}  ${pad("status", 10)}  ${pad("cost usd", 10)}  nodes  updated`];
  for (const s of states) {
    lines.push(
      `${pad(s.runId, idWidth)}  ${pad(s.status, 10)}  ${pad(s.spent.usd.toFixed(4), 10)}  ${pad(String(s.completed.length), 5)}  ${s.updatedAt}`,
    );
  }
  return lines.join("\n");
}

export function renderPlan(graph: Graph): string {
  const lines = [`plan for graph "${graph.name}" (nothing is executed)`, ""];
  planLevels(graph).forEach((level, i) => {
    const detail = level.map((id) => `${id} (${graph.nodes[id]!.type})`).join(", ");
    lines.push(`${i + 1}. ${level.join(", ")}${level.length > 1 ? "  [concurrent]" : ""}`);
    lines.push(`   ${detail}`);
  });
  lines.push("");
  lines.push(`budget  ${graph.budget.maxUsd} usd, ${graph.budget.maxWallClockSec}s, ${graph.budget.maxNodeRuns} node runs`);
  return lines.join("\n");
}

/** 0 success, 1 validation/usage error, 2 run failed, 3 budget exceeded, 4 paused. */
export function exitCodeFor(state: RunState, events: LgEvent[]): number {
  if (state.status === "succeeded") return 0;
  if (state.status === "paused") return 4;
  if (events.some((e) => e.kind === "budget_exceeded")) return 3;
  return 2;
}

export function parseVars(pairs: string[]): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new Error(`--var expects key=value, got "${pair}"`);
    vars[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return vars;
}

function reportDuration(startedAt: string, endedAt: string | null): string {
  if (!startedAt || !endedAt) return "-";
  const ms = Date.parse(endedAt) - Date.parse(startedAt);
  if (Number.isNaN(ms)) return "-";
  return `${(ms / 1000).toFixed(1)}s`;
}

export function renderReportHtml(state: RunState, events: LgEvent[]): string {
  const esc = escapeHtml;

  const nodeRows: string[] = [];
  for (const nodeId of Object.keys(state.nodes)) {
    const n = state.nodes[nodeId]!;
    nodeRows.push(
      `<tr><td>${esc(n.nodeId)}</td><td>${esc(n.status)}</td><td>${esc(String(n.attempts))}</td>` +
        `<td>${esc(n.costUsd.toFixed(4))}</td><td>${esc(reportDuration(n.startedAt, n.endedAt))}</td></tr>`,
    );
    if (n.error !== null) {
      nodeRows.push(`<tr><td colspan="5">${esc(n.error)}</td></tr>`);
    }
  }

  const eventRows: string[] = [];
  for (const e of events) {
    eventRows.push(
      `<tr><td>${esc(String(e.seq))}</td><td>${esc(e.ts)}</td><td>${esc(e.kind)}</td>` +
        `<td>${esc(e.nodeId ?? "")}</td><td>${esc(JSON.stringify(e.data))}</td></tr>`,
    );
  }

  const budgetLine =
    `${state.spent.usd.toFixed(4)}/${state.budget.maxUsd.toFixed(4)} usd · ` +
    `${Math.round(state.spent.wallClockSec)}s/${state.budget.maxWallClockSec}s wall clock · ` +
    `${state.spent.nodeRuns}/${state.budget.maxNodeRuns} node runs`;

  return (
    "<!DOCTYPE html>" +
    '<html lang="en">' +
    "<head>" +
    '<meta charset="utf-8">' +
    `<title>loomgraph run ${esc(state.runId)}</title>` +
    "<style>" +
    "body{font-family:system-ui,sans-serif;margin:2rem;max-width:64rem}" +
    "table{border-collapse:collapse;width:100%;margin-bottom:1.5rem}" +
    "td,th{border:1px solid #ccc;padding:.35rem .5rem;text-align:left}" +
    "th{background:#eee}" +
    "</style>" +
    "</head>" +
    "<body>" +
    "<h1>loomgraph run</h1>" +
    `<p>runId: ${esc(state.runId)}<br>graphName: ${esc(state.graphName)}<br>status: ${esc(state.status)}<br>` +
    `cwd: ${esc(state.cwd)}<br>createdAt: ${esc(state.createdAt)}<br>updatedAt: ${esc(state.updatedAt)}</p>` +
    "<h2>nodes</h2>" +
    `<table><tr><th>node</th><th>status</th><th>attempts</th><th>cost usd</th><th>duration</th></tr>` +
    nodeRows.join("") +
    "</table>" +
    `<p>${esc(budgetLine)}</p>` +
    `<p>${esc(COST_NOTE)}</p>` +
    "<h2>events</h2>" +
    `<table><tr><th>seq</th><th>ts</th><th>kind</th><th>nodeId</th><th>data</th></tr>` +
    eventRows.join("") +
    "</table>" +
    "</body>" +
    "</html>"
  );
}
