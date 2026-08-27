import { describe, it, expect } from "vitest";
import { renderStatus, renderRuns, exitCodeFor, parseVars } from "./render.js";
import type { LgEvent } from "../core/events.js";
import type { RunState } from "../core/types.js";

function makeState(overrides: Partial<RunState> = {}): RunState {
  return {
    runId: "demo-20260814-120000-ab12",
    streamId: "stream-1",
    graphName: "demo",
    status: "succeeded",
    createdAt: "2026-08-14T12:00:00.000Z",
    updatedAt: "2026-08-14T12:01:00.000Z",
    cwd: "/repo",
    vars: { ticket: "LG-1" },
    budget: { maxUsd: 2, maxWallClockSec: 1800, maxNodeRuns: 20 },
    spent: { usd: 0.25, wallClockSec: 60, nodeRuns: 2 },
    nodes: {
      reproduce: {
        nodeId: "reproduce", status: "succeeded",
        startedAt: "2026-08-14T12:00:00.000Z", endedAt: "2026-08-14T12:00:30.000Z",
        attempts: 1, output: "the failing test", error: null, costUsd: 0.25,
      },
      fix: {
        nodeId: "fix", status: "failed",
        startedAt: "2026-08-14T12:00:30.000Z", endedAt: "2026-08-14T12:01:00.000Z",
        attempts: 2, output: "", error: "still red", costUsd: 0,
      },
    },
    completed: ["reproduce"],
    seq: 4,
    ...overrides,
  };
}

describe("renderStatus", () => {
  it("lists every node with its status, attempts and cost", () => {
    const out = renderStatus(makeState());
    expect(out).toContain("reproduce");
    expect(out).toContain("succeeded");
    expect(out).toContain("fix");
    expect(out).toContain("failed");
    expect(out).toContain("0.2500");
    expect(out).toMatch(/fix\s+failed\s+2/);
  });

  it("shows the run id, graph name and run status", () => {
    const out = renderStatus(makeState());
    expect(out).toContain("demo-20260814-120000-ab12");
    expect(out).toContain("demo");
  });

  it("shows a budget line with spent and remaining for all three ceilings", () => {
    const out = renderStatus(makeState());
    expect(out).toMatch(/budget/i);
    expect(out).toContain("0.2500/2.0000 usd");
    expect(out).toContain("2/20 node runs");
    expect(out).toMatch(/1800s/);
  });

  it("says that unreported costs are recorded as zero rather than estimated", () => {
    expect(renderStatus(makeState())).toMatch(/not report/i);
  });

  it("renders a run with no finished nodes", () => {
    const out = renderStatus(makeState({ nodes: {}, completed: [], status: "pending" }));
    expect(out).toContain("no nodes have run yet");
  });
});

describe("renderRuns", () => {
  it("lists each run with its status and cost", () => {
    const out = renderRuns([makeState(), makeState({ runId: "other-1", graphName: "other", status: "paused" })]);
    expect(out).toContain("demo-20260814-120000-ab12");
    expect(out).toContain("other-1");
    expect(out).toContain("paused");
    expect(out).toContain("0.2500");
  });

  it("reports an empty run list plainly", () => {
    expect(renderRuns([])).toMatch(/no runs/i);
  });
});

describe("exitCodeFor", () => {
  const noEvents: LgEvent[] = [];
  const budgetEvent: LgEvent[] = [
    { ts: "", runId: "r", seq: 0, kind: "budget_exceeded", data: { reason: "maxUsd exceeded" } },
  ];

  it("returns 0 for a succeeded run", () => {
    expect(exitCodeFor(makeState({ status: "succeeded" }), noEvents)).toBe(0);
  });

  it("returns 2 for a failed run", () => {
    expect(exitCodeFor(makeState({ status: "failed" }), noEvents)).toBe(2);
  });

  it("returns 3 when the run failed because of the budget", () => {
    expect(exitCodeFor(makeState({ status: "failed" }), budgetEvent)).toBe(3);
  });

  it("returns 4 for a run paused awaiting a human", () => {
    expect(exitCodeFor(makeState({ status: "paused" }), noEvents)).toBe(4);
  });
});

describe("parseVars", () => {
  it("parses key=value pairs and keeps later equals signs in the value", () => {
    expect(parseVars(["ticket=LG-1", "query=a=b"])).toEqual({ ticket: "LG-1", query: "a=b" });
  });

  it("rejects a var without an equals sign", () => {
    expect(() => parseVars(["broken"])).toThrow(/broken/);
  });

  it("returns an empty object for no vars", () => {
    expect(parseVars([])).toEqual({});
  });
});
