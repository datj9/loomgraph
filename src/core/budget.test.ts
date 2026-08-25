import { describe, it, expect } from "vitest";
import { checkBudget, recordSpend } from "./budget.js";
import type { RunState } from "./types.js";

function makeState(overrides: Partial<RunState> = {}): RunState {
  return {
    runId: "r", streamId: "s-1", graphName: "g", status: "running",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    cwd: "/tmp", vars: {},
    budget: { maxUsd: 1, maxWallClockSec: 60, maxNodeRuns: 5 },
    spent: { usd: 0, wallClockSec: 0, nodeRuns: 0 },
    nodes: {}, completed: [], seq: 0,
    ...overrides,
  };
}

describe("checkBudget", () => {
  it("passes when every ceiling has headroom", () => {
    const res = checkBudget(makeState({ spent: { usd: 0.5, wallClockSec: 1, nodeRuns: 2 } }));
    expect(res.ok).toBe(true);
  });

  it("fails exactly at the usd ceiling", () => {
    const res = checkBudget(makeState({ spent: { usd: 1, wallClockSec: 0, nodeRuns: 0 } }));
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toMatch(/maxUsd/);
  });

  it("fails exactly at the node-run ceiling", () => {
    const res = checkBudget(makeState({ spent: { usd: 0, wallClockSec: 0, nodeRuns: 5 } }));
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toMatch(/maxNodeRuns/);
  });

  it("fails exactly at the wall-clock ceiling measured from createdAt", () => {
    const createdAt = new Date(Date.now() - 61_000).toISOString();
    const res = checkBudget(makeState({ createdAt }));
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toMatch(/maxWallClockSec/);
  });

  it("does not fail on wall-clock for a run that just started", () => {
    expect(checkBudget(makeState()).ok).toBe(true);
  });
});

describe("recordSpend", () => {
  it("accumulates usd and node runs without mutating the input", () => {
    const before = makeState();
    const after = recordSpend(before, { usd: 0.25, nodeRuns: 1 });
    expect(after.spent).toEqual({ usd: 0.25, wallClockSec: after.spent.wallClockSec, nodeRuns: 1 });
    expect(before.spent).toEqual({ usd: 0, wallClockSec: 0, nodeRuns: 0 });
    expect(after).not.toBe(before);
  });

  it("accumulates across repeated calls", () => {
    let state = makeState();
    state = recordSpend(state, { usd: 0.1, nodeRuns: 1 });
    state = recordSpend(state, { usd: 0.2, nodeRuns: 1 });
    expect(state.spent.usd).toBeCloseTo(0.3, 10);
    expect(state.spent.nodeRuns).toBe(2);
  });

  it("refreshes the wall-clock spend from createdAt", () => {
    const createdAt = new Date(Date.now() - 5_000).toISOString();
    const after = recordSpend(makeState({ createdAt }), { usd: 0, nodeRuns: 1 });
    expect(after.spent.wallClockSec).toBeGreaterThanOrEqual(5);
  });
});
