import type { RunState } from "./types.js";

export type BudgetCheck = { ok: true } | { ok: false; reason: string };

export function elapsedSec(state: RunState, now = Date.now()): number {
  const started = Date.parse(state.createdAt);
  if (Number.isNaN(started)) return state.spent.wallClockSec;
  return Math.max(0, (now - started) / 1000);
}

/**
 * Checked before every dispatch batch.
 *
 * The node-run and wall-clock ceilings are exclusive: hitting the limit
 * exactly is allowed, only going over stops the run. Both are projected
 * forward at admission time, so an exclusive comparison still bounds the work
 * that actually gets dispatched.
 *
 * The usd ceiling is inclusive - reaching maxUsd stops the run. Dollars are
 * the one ceiling admission cannot project: a node's cost is unknown until it
 * has already run, so the engine admits with `{ usd: 0, nodeRuns: 1 }`. An
 * exclusive usd ceiling would therefore let a paid node dispatch when the
 * spend already equals maxUsd (and would let any paid node dispatch under
 * `maxUsd: 0`). Refusing at equality is the only way the dollar ceiling can be
 * a real ceiling.
 */
export function checkBudget(state: RunState, now = Date.now()): BudgetCheck {
  const { budget, spent } = state;

  if (spent.usd >= budget.maxUsd) {
    return { ok: false, reason: `maxUsd exceeded: spent ${spent.usd} of ${budget.maxUsd} usd` };
  }
  if (spent.nodeRuns > budget.maxNodeRuns) {
    return { ok: false, reason: `maxNodeRuns exceeded: ran ${spent.nodeRuns} of ${budget.maxNodeRuns} nodes` };
  }
  const elapsed = elapsedSec(state, now);
  if (elapsed > budget.maxWallClockSec) {
    return {
      ok: false,
      reason: `maxWallClockSec exceeded: ${Math.round(elapsed)}s elapsed of ${budget.maxWallClockSec}s`,
    };
  }
  return { ok: true };
}

/** Pure: returns a new state with the spend folded in. Never mutates. */
export function recordSpend(
  state: RunState,
  delta: { usd: number; nodeRuns: number },
  now = Date.now(),
): RunState {
  return {
    ...state,
    spent: {
      usd: state.spent.usd + delta.usd,
      wallClockSec: elapsedSec(state, now),
      nodeRuns: state.spent.nodeRuns + delta.nodeRuns,
    },
  };
}
