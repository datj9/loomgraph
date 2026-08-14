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
