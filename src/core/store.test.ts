import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckpointStore } from "./store.js";
import type { RunState } from "./types.js";

function makeState(runId: string): RunState {
  return {
    runId, graphName: "t", status: "running",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    cwd: "/tmp", vars: {}, budget: { maxUsd: 1, maxWallClockSec: 60, maxNodeRuns: 5 },
    spent: { usd: 0, wallClockSec: 0, nodeRuns: 0 },
    nodes: {}, completed: [], seq: 0,
  };
}

describe("CheckpointStore", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lg-")); });

  it("round-trips a run state", () => {
    const s = new CheckpointStore(dir);
    const st = makeState("r1");
    s.save(st);
    expect(s.load("r1")).toEqual(st);
  });

  it("returns null for an unknown run", () => {
    expect(new CheckpointStore(dir).load("nope")).toBeNull();
  });

  it("bumps seq and updatedAt on every save", () => {
    const s = new CheckpointStore(dir);
    const st = makeState("r2");
    s.save(st); const a = s.load("r2")!;
    s.save(a);  const b = s.load("r2")!;
    expect(b.seq).toBe(a.seq + 1);
  });

  it("lists saved runs", () => {
    const s = new CheckpointStore(dir);
    s.save(makeState("r3")); s.save(makeState("r4"));
    expect(s.list().sort()).toEqual(["r3", "r4"]);
  });
});
