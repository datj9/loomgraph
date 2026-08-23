import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseGraph } from "../core/graph.js";
import { planLevels, newRunState } from "../core/engine.js";
import { CheckpointStore } from "../core/store.js";
import { renderPlan } from "./render.js";
import { resumeCommand } from "./resume.js";

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

const GATED = `
name: gated
budget: { maxUsd: 1, maxWallClockSec: 60, maxNodeRuns: 9 }
nodes:
  before: { type: command, run: "echo before" }
  approve: { type: human, question: "Ship it?" }
  later: { type: human, question: "Later?" }
edges:
  - { from: before, to: approve }
  - { from: approve, to: later }
  - { from: later, to: END }
`;

describe("resumeCommand --answer validation", () => {
  let dir: string;
  let originalCwd: string;
  let store: CheckpointStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lg-resume-"));
    originalCwd = process.cwd();
    process.chdir(dir);
    store = new CheckpointStore(join(dir, ".loomgraph", "runs"));
  });

  afterEach(() => {
    process.chdir(originalCwd);
  });

  function seedPausedRun(runId: string, graphSrc: string): void {
    const graph = parseGraph(graphSrc);
    const state = newRunState(graph, { runId, cwd: dir });
    state.status = "paused";
    state.nodes = {
      before: {
        nodeId: "before", status: "succeeded", startedAt: "", endedAt: null,
        attempts: 1, output: "", error: null, costUsd: 0,
      },
    };
    state.completed = ["before"];
    store.save(state);
    store.saveGraphSource(runId, graphSrc);
  }

  async function captureError(fn: () => Promise<number>): Promise<{ code: number; errors: string[] }> {
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void errors.push(args.join(" "));
    try {
      const code = await fn();
      return { code, errors };
    } finally {
      console.error = original;
    }
  }

  it("exits 1 and names the node when --answer names a node that is not in the graph", async () => {
    seedPausedRun("gated-unknown", GATED);
    const { code, errors } = await captureError(() => resumeCommand("gated-unknown", { answer: ["nosuch=hi"] }));
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain('--answer: no node "nosuch" in this run');
  });

  it("exits 1 and names the node when --answer names a node that is not awaiting an answer", async () => {
    seedPausedRun("gated-notpaused", GATED);
    const { code, errors } = await captureError(() => resumeCommand("gated-notpaused", { answer: ["later=hi"] }));
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain('--answer: node "later" is not awaiting an answer');
  });

  it("reports a malformed --answer pair without mentioning --var", async () => {
    seedPausedRun("gated-malformed", GATED);
    const { code, errors } = await captureError(() => resumeCommand("gated-malformed", { answer: ["approve"] }));
    expect(code).toBe(1);
    const message = errors.join("\n");
    expect(message).toContain('--answer expects nodeId=text, got "approve"');
    expect(message).not.toContain("--var");
  });
});
