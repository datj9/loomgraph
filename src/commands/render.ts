import type { LgEvent } from "../core/events.js";
import { planLevels } from "../core/engine.js";
import type { Graph } from "../core/graph.js";
import type { RunState } from "../core/types.js";

const COST_NOTE =
  "note: adapters that do not report a price (codex, opencode, command) record 0.0000 usd - the number is not estimated.";

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
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
