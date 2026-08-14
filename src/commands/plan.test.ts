import { describe, it, expect } from "vitest";
import { parseGraph } from "../core/graph.js";
import { planLevels } from "../core/engine.js";
import { renderPlan } from "./render.js";

const FANOUT = `
name: fanout
budget: { maxUsd: 1, maxWallClockSec: 60, maxNodeRuns: 9 }
nodes:
  a: { type: command, run: "echo a" }
  b: { type: command, run: "echo b" }
  c: { type: command, run: "echo c" }
  d: { type: command, run: "echo d" }
edges:
  - { from: a, to: [b, c] }
  - { from: [b, c], to: d, when: all_succeeded }
  - { from: d, to: END }
`;

describe("planLevels", () => {
  it("groups nodes into the batches the scheduler will dispatch", () => {
    expect(planLevels(parseGraph(FANOUT))).toEqual([["a"], ["b", "c"], ["d"]]);
  });
});

describe("renderPlan", () => {
  it("prints each batch with its node ids and types", () => {
    const out = renderPlan(parseGraph(FANOUT));
    expect(out).toContain("fanout");
    expect(out).toMatch(/1\..*a/);
    expect(out).toMatch(/2\..*b, c/);
    expect(out).toContain("command");
  });
});
