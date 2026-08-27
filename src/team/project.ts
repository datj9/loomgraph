import type { RunState } from "../core/types.js";
import type { ProjectedState, ProjectedNode } from "../hub/wire.js";
import { SCAN_RULES, rewritePaths } from "../handoff/scan.js";

/**
 * Ceiling on a published node error. 200 is the number `claude.ts:33` already
 * truncates stdout to, so it matches the largest thing the adapters
 * deliberately allow through; a multi-kilobyte stderr dump must not ride along.
 */
const MAX_ERROR_LENGTH = 200;

const MASK_PREFIX_LENGTH = 4;

/**
 * Mask every secret shape `SCAN_RULES` recognises, in the same at-most-
 * four-characters-plus-ellipsis shape as the private `mask()` in
 * scan.ts:158-164, with matches of 4 characters or fewer left as-is. Only the
 * PRESENTATION is written here; the RULES are imported, never copied, so this
 * is not a fork of the scanner - a rule added there starts masking here
 * without any edit to this file.
 */
function maskSecrets(text: string): string {
  let out = text;
  for (const rule of SCAN_RULES) {
    // Patterns ship without the `g` flag (scan.ts:26-27); clone with it so the
    // replace visits every match, not just the first.
    const global = new RegExp(rule.pattern.source, `${rule.pattern.flags}g`);
    out = out.replace(global, (match) => {
      if (match.length <= MASK_PREFIX_LENGTH) return match;
      return `${match.slice(0, MASK_PREFIX_LENGTH)}...`;
    });
  }
  return out;
}

/** Sanitise a node error for publication: paths rewritten, secrets masked, length capped. */
function safeError(
  error: string | null,
  opts: { home: string; username: string; repoRoot: string },
): string | null {
  if (error === null) return null;

  let out = rewritePaths(error, opts);
  out = maskSecrets(out);

  if (out.length > MAX_ERROR_LENGTH) {
    out = `${out.slice(0, MAX_ERROR_LENGTH)}…`;
  }
  return out;
}

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
      error: safeError(node.error, opts),
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