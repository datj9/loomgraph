import { join, resolve } from "node:path";
import { EventLog } from "../core/events.js";
import { CheckpointStore } from "../core/store.js";
import type { LgEvent } from "../core/events.js";

/** Runs live under `<cwd>/.loomgraph/runs/<runId>/`. */
export function runsDir(cwd: string = process.cwd()): string {
  return resolve(join(cwd, ".loomgraph", "runs"));
}

export function openStore(cwd?: string): CheckpointStore {
  return new CheckpointStore(runsDir(cwd));
}

export function openLog(cwd?: string): EventLog {
  return new EventLog(runsDir(cwd));
}

/** One concise line per event, for live progress on stdout. */
export function formatEventLine(event: LgEvent): string | null {
  const d = event.data;
  switch (event.kind) {
    case "run_started":
      return `> run ${event.runId} (${d.resumed ? "resumed" : "new"})`;
    case "node_started":
      return `> ${event.nodeId} started (attempt ${d.attempt})`;
    case "node_finished":
      return `> ${event.nodeId} ${d.status}${d.error ? `: ${d.error}` : ""}`;
    case "budget_exceeded":
      return `! budget exceeded: ${d.reason}`;
    case "human_requested":
      return `? ${event.nodeId} needs an answer: ${d.question}`;
    case "human_resolved":
      return `> ${event.nodeId} answered`;
    case "run_finished":
      return `> run ${d.status}${d.error ? `: ${d.error}` : ""}`;
    default:
      return null;
  }
}
