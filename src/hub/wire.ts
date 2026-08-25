import { z } from "zod";
import type { Budget, BudgetSpent, NodeStatus, RunStatus } from "../core/types.js";

/** One push. `events` are RAW LINES from events.jsonl, never re-serialized objects. */
export interface EventBatch {
  runId: string;
  streamId: string;
  graphName: string;
  state: ProjectedState;
  events: string[]; // each element is one verbatim line, ordered by seq
}

/** A node result with its content removed. No `output` field exists, by construction. */
export interface ProjectedNode {
  nodeId: string;
  status: NodeStatus;
  startedAt: string;
  endedAt: string | null;
  attempts: number;
  error: string | null;
  costUsd: number;
}

/**
 * `RunState` with every content-carrying field structurally absent. Declared HERE, not in
 * `src/team/project.ts`, because it is wire vocabulary; commit 1.10 supplies the function
 * that produces it. Note there is no `streamId` - `EventBatch` carries that at top level,
 * which is also why this type is buildable before commit 1.9 exists.
 */
export interface ProjectedState {
  runId: string;
  graphName: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  cwd: string; // rewritten by projectState() before it gets here
  varKeys: string[]; // KEY NAMES ONLY - there is nowhere to put a value
  budget: Budget;
  spent: BudgetSpent;
  nodes: Record<string, ProjectedNode>;
  completed: string[];
  seq: number;
}

/**
 * The two types below form a discriminated union tagged on `conflict`. `IngestResult`
 * carries `conflict: false` explicitly so a caller cannot narrow by accident or forget to
 * check. Commit 1.7's handler must switch on `.conflict` to produce a 409; a caller that
 * treats the union as a bare success object is a bug. Never widen this back to a union whose
 * success arm lacks the tag - forgetting the check must stay a type error.
 */
export interface IngestResult {
  conflict: false;
  highWaterSeq: number;
  accepted: number;
  duplicates: number;
}

export interface IngestConflict {
  conflict: true;
  runId: string;
  seq: number;
}

export interface FeedItem {
  ts: string;
  member: string;
  kind: FeedKind;
  ref: string;
}

// phases 2-3 use the later members
export type FeedKind =
  | "run_started"
  | "run_finished"
  | "brief_published"
  | "inbox_sent"
  | "inbox_accepted";

export interface RunRow {
  member: string;
  runId: string;
  streamId: string;
  graphName: string;
  status: string;
  updatedAt: string;
  receivedAt: string;
}

export const MAX_BODY_BYTES = 5 * 1024 * 1024;

/**
 * The value of `highWaterSeq` when no event has ever been ingested for a
 * (member, streamId, runId). It is -1 rather than 0 or null because `seq` is
 * zero-based: `EventLog.append` starts at `read(runId).length`, so seq 0 is a
 * real ingested event and cannot double as "nothing yet". `highWater()` returns
 * this instead of null so the type is a plain number and no caller can forget a
 * null check.
 */
export const NO_EVENTS_YET = -1;

const projectedNodeSchema = z
  .object({
    nodeId: z.string(),
    status: z.enum(["pending", "running", "succeeded", "failed", "skipped"]),
    startedAt: z.string(),
    endedAt: z.string().nullable(),
    attempts: z.number().int().nonnegative(),
    error: z.string().nullable(),
    costUsd: z.number().nonnegative(),
  })
  .strict();

const projectedStateSchema = z
  .object({
    runId: z.string().min(1),
    graphName: z.string().min(1),
    status: z.enum(["pending", "running", "paused", "succeeded", "failed"]),
    createdAt: z.string(),
    updatedAt: z.string(),
    cwd: z.string(),
    varKeys: z
      .array(z.string())
      .refine((keys) => new Set(keys).size === keys.length, {
        message: "varKeys must not contain duplicate entries",
      }),
    budget: z
      .object({
        maxUsd: z.number().positive(),
        maxWallClockSec: z.number().positive(),
        maxNodeRuns: z.number().int().positive(),
      })
      .strict(),
    spent: z
      .object({
        usd: z.number().nonnegative(),
        wallClockSec: z.number().nonnegative(),
        nodeRuns: z.number().int().nonnegative(),
      })
      .strict(),
    nodes: z.record(z.string(), projectedNodeSchema),
    completed: z.array(z.string()),
    seq: z.number().int().nonnegative(),
  })
  .strict();

/**
 * Deliberately NOT strict, unlike the projected schemas above. The hub stores each line
 * verbatim and projects only `(seq, kind, nodeId)` out of it, so an unknown top-level key is
 * inert data - refusing it buys no safety and would break forward compatibility (a member on
 * a newer `lg` than the hub could not sync at all, failing as a 400 on a whole batch).
 * ProjectedState and ProjectedNode ARE strict because an unknown key there is an
 * unclassified field that might carry content. Do not add `.strict()` here.
 */
const eventSchema = z
  .object({
    ts: z.string(),
    runId: z.string(),
    seq: z.number().int().nonnegative(),
    kind: z.enum([
      "run_started",
      "node_started",
      "node_finished",
      "edge_crossed",
      "budget_checked",
      "budget_exceeded",
      "human_requested",
      "human_resolved",
      "run_finished",
    ]),
    nodeId: z.string().optional(),
    data: z.record(z.string(), z.unknown()),
  });

/**
 * The verbatim-line rule is load-bearing. The server zod-parses each line to validate it
 * and to project `(seq, kind, node_id)` into columns, then stores the original string.
 * Re-stringifying breaks 6.4's lossless export with no failing test, so the schema accepts
 * an array of strings and does not transform them into parsed objects.
 */
export const eventBatchSchema = z
  .object({
    runId: z.string().min(1),
    streamId: z.string().min(1),
    graphName: z.string().min(1),
    state: projectedStateSchema,
    events: z.array(
      // each element must parse to a valid LgEvent but stays a string on the wire
      z.string().superRefine((line, ctx) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "line is not valid JSON",
          });
          return;
        }
        const result = eventSchema.safeParse(parsed);
        if (!result.success) {
          const detail = result.error.issues
            .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
            .join("; ");
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `line is valid JSON but not a valid event: ${detail}`,
          });
        }
      }),
    ),
  })
  .strict()
  .superRefine((batch, ctx) => {
    if (batch.state.runId !== batch.runId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["state", "runId"],
        message: `state.runId (${batch.state.runId}) does not match top-level runId (${batch.runId})`,
      });
    }
    if (batch.state.graphName !== batch.graphName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["state", "graphName"],
        message: `state.graphName (${batch.state.graphName}) does not match top-level graphName (${batch.graphName})`,
      });
    }
    for (const [key, value] of Object.entries(batch.state.nodes)) {
      if (key !== value.nodeId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["state", "nodes", key, "nodeId"],
          message: `state.nodes.${key}.nodeId (${value.nodeId}) does not match its map key (${key})`,
        });
      }
    }

    const parsedSeqs = batch.events.map((line) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return null;
      }
      const seq = (parsed as { seq?: unknown }).seq;
      return typeof seq === "number" ? seq : null;
    });
    for (let i = 1; i < parsedSeqs.length; i++) {
      const prev = parsedSeqs[i - 1]!;
      const cur = parsedSeqs[i]!;
      if (prev === null || cur === null) continue;
      if (cur <= prev) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["events", i],
          message: `event line ${i} has seq ${cur}, which is not greater than the previous line's seq ${prev}`,
        });
        break;
      }
    }

    for (let i = 0; i < batch.events.length; i++) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(batch.events[i]!);
      } catch {
        continue;
      }
      const runId = (parsed as { runId?: unknown }).runId;
      if (typeof runId === "string" && runId !== batch.runId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["events", i],
          message: `event line ${i} carries runId (${runId}), which does not match the top-level runId (${batch.runId})`,
        });
      }
    }

    const nodeKeys = new Set(Object.keys(batch.state.nodes));
    const unknownCompleted = batch.state.completed.filter((id) => !nodeKeys.has(id));
    if (unknownCompleted.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["state", "completed"],
        message: `completed references ids not present in nodes: ${unknownCompleted.join(", ")}`,
      });
    }
  });
