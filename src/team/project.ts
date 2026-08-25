import type { RunState } from "../core/types.js";
import type { ProjectedState, ProjectedNode } from "../hub/wire.js";
import { rewritePaths } from "../handoff/scan.js";

/**
 * Build the wire projection of a run's state. This is where content stops being pushed:
 * `vars` VALUES and node `output` are structurally unpublishable, because `ProjectedState`
 * has no field that can carry them. The mapping is hand-written field by field - never a
 * type-level subtraction over `RunState`, never a mapped type, never an object spread
 * followed by deletes - so a future content-carrying field added to `RunState` cannot
 * silently start publishing itself.
 *
 * The signature mirrors `rewritePaths`' own opts (`{ home, username, repoRoot }`) rather than
 * the narrower `(state, home, repoRoot)` form, because `rewritePaths` rewrites the
 * `/home/<user>`, `/Users/<user>` and `C:\Users\<user>` shapes and skips all of them when
 * `username` is empty. A narrower signature invites a caller to pass `""` and silently
 * disable one of its three protections. Mirroring the opts shape keeps one vocabulary across
 * both functions and loses nothing. Do not "restore" the narrower form.
 */
export function projectState(
  state: RunState,
  opts: { home: string; username: string; repoRoot: string },
): ProjectedState {
  const nodes: Record<string, ProjectedNode> = {};
  for (const [id, node] of Object.entries(state.nodes)) {
    nodes[id] = {
      nodeId: node.nodeId,
      status: node.status,
      startedAt: node.startedAt,
      endedAt: node.endedAt,
      attempts: node.attempts,
      error: node.error,
      costUsd: node.costUsd,
    };
  }

  return {
    runId: state.runId,
    graphName: state.graphName,
    status: state.status,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    cwd: rewritePaths(state.cwd, opts),
    varKeys: Object.keys(state.vars),
    budget: state.budget,
    spent: state.spent,
    nodes,
    completed: state.completed,
    seq: state.seq,
  };
}