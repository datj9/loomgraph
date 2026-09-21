export type RunStatus = "pending" | "running" | "paused" | "succeeded" | "failed";
export type NodeStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";

export interface Budget {
  maxUsd: number;
  maxWallClockSec: number;
  maxNodeRuns: number;
}

export interface BudgetSpent {
  usd: number;
  wallClockSec: number;
  nodeRuns: number;
}

export interface NodeResult {
  nodeId: string;
  status: NodeStatus;
  startedAt: string;
  endedAt: string | null;
  attempts: number;
  output: unknown;
  error: string | null;
  costUsd: number;
}

export interface RunState {
  runId: string;
  /** Identifies THIS machine's history of the run, so a wiped or copied
   *  `.loomgraph` produces a different stream rather than a same-key conflict
   *  on the hub. */
  streamId: string;
  graphName: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  cwd: string;
  vars: Record<string, unknown>;
  budget: Budget;
  spent: BudgetSpent;
  nodes: Record<string, NodeResult>;
  completed: string[];
  seq: number;
}
