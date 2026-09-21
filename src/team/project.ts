import type { RunState } from "../core/types.js";
import type { ProjectedState, ProjectedNode } from "../hub/wire.js";
import { SCAN_RULES, rewritePaths } from "../handoff/scan.js";

/**
 * The machine facts every published string is rewritten against. Mirrors
 * `rewritePaths`' own opts (`src/handoff/scan.ts`) rather than a narrower
 * `(state, home, repoRoot)` form, because `rewritePaths` skips a protection
 * whenever the field it needs is empty - a narrower signature invites a caller
 * to pass `""` and silently disable one. `hostname` is REQUIRED for exactly
 * that reason: it was optional on `rewritePaths`, no caller on the sync path
 * ever supplied it, and the machine hostname published unrewritten for the
 * whole of phase 1. Do not make it optional again.
 */
export interface ProjectionIdentity {
  home: string;
  username: string;
  repoRoot: string;
  hostname: string;
}

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

/**
 * Remove control characters the hub's wire schema refuses, keeping the three
 * that legitimately appear in error text.
 *
 * `projectedNodeSchema.error` permits only TAB, LF and CR; the rest of C0, DEL
 * and ESC stay refused so ANSI colour and OSC terminal-title sequences cannot
 * ride in. Many CLI tools colour their stderr by default, so an unsanitised ESC
 * would 400 the batch and wedge that run's sync PERMANENTLY - the same failure
 * as the newline bug, reached by a different route. The producer strips, and the
 * hub keeps refusing: validation must never refuse a shape the engine can
 * legitimately produce, and the engine must not produce one it refuses.
 *
 * ORDER MATTERS - this runs FIRST, before rewrite and mask. An ESC spliced into
 * a secret or a path defeats their patterns, and stripping afterwards would
 * reassemble the original in clear. Full order: strip -> rewrite -> mask -> cap.
 * Do not reorder: a masked token is already `first4 + "..."`, so capping cannot
 * reveal a fragment, but any other arrangement is exploitable.
 */
function stripControl(s: string): string {
  return (
    s
      // OSC: ESC ] ... terminated by BEL or ST. Must run before CSI so a title
      // sequence is consumed whole rather than leaving its payload behind.
      .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, "")
      // CSI: ESC [ params intermediates final. Removing only the ESC byte would
      // leave "[31m" in the text - and, worse, leave a spliced secret still
      // unmatchable by the masker.
      .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]?/g, "")
      // Any other two-byte escape.
      .replace(/\u001b[@-_]?/g, "")
      // Remaining C0 and DEL, keeping TAB, LF and CR.
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
  );
}

/**
 * Sanitise a published string: paths rewritten, secrets masked, length capped.
 *
 * ORDER IS LOAD-BEARING - rewrite, then mask, then cap. Capping first would let
 * a secret straddling the 200th character be truncated below its rule's
 * `{16,}` tail, so the mask would no longer match and the surviving prefix
 * would publish real key material. Do not reorder these three lines.
 *
 * Exported because `buildBatch` sanitises event `data` with the SAME function.
 * A second implementation over there would drift from this one; there must be
 * exactly one definition of "safe to publish" on the sync path.
 */
export function safeText(
  error: string | null,
  opts: ProjectionIdentity,
): string | null {
  if (error === null) return null;

  // Strip FIRST. An ESC spliced into the middle of a secret or an absolute path
  // breaks the masker's and the rewriter's patterns; stripping afterwards would
  // then reassemble the original in clear. Removing the noise before either one
  // runs is what makes them see the real shape.
  let out = stripControl(error);
  out = rewritePaths(out, opts);
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
 * `opts` is `ProjectionIdentity` - see its doc comment for why every field is required.
 */
export function projectState(state: RunState, opts: ProjectionIdentity): ProjectedState {
  const nodes: Record<string, ProjectedNode> = {};
  for (const [id, node] of Object.entries(state.nodes)) {
    nodes[id] = {
      nodeId: node.nodeId,
      status: node.status,
      startedAt: node.startedAt,
      endedAt: node.endedAt,
      attempts: node.attempts,
      error: safeText(node.error, opts),
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