import { describe, expect, it } from "vitest";
import { HubStore, type HubStoreDeps } from "./storage.js";
import type { EventBatch, ProjectedState } from "./wire.js";
import { exportGroups } from "./export.js";

const FROZEN = "2026-08-25T00:00:00.000Z";
const frozenClock: HubStoreDeps = { now: () => FROZEN };

function openStore(): HubStore {
  return HubStore.open(":memory:", frozenClock);
}

function baseState(runId = "run-1"): ProjectedState {
  return {
    runId,
    graphName: "g",
    status: "running",
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:01.000Z",
    cwd: "/work",
    varKeys: [],
    budget: { maxUsd: 1, maxWallClockSec: 60, maxNodeRuns: 10 },
    spent: { usd: 0, wallClockSec: 0, nodeRuns: 0 },
    nodes: {},
    completed: [],
    seq: 2,
  };
}

function batch(runId: string, events: string[], state: ProjectedState = baseState(runId)): EventBatch {
  return { runId, streamId: "s-1", graphName: "g", state, events };
}

/*
 * A stored line is the verbatim client line, so the export must pass it through
 * byte-for-byte. These are deliberately non-canonical: two spaces after a colon,
 * multibyte data values, and an unknown top-level field.
 */
const awkwardLines = [
  '{"ts":  "2026-08-25T00:00:00.000Z", "runId":  "run-1", "seq": 0, "kind": "run_started", "data":  {"note":  "café ☕"}, "extraField":  "unknown"}',
  '{"extraField":  "unknown", "kind": "node_started", "seq":  1, "ts": "2026-08-25T00:00:01.000Z", "runId": "run-1", "data":  {"v":  "こんにちは"}}',
  '{"seq": 2, "kind": "run_finished", "ts": "2026-08-25T00:00:02.000Z", "runId": "run-1", "data": {}}',
];

describe("exportGroups", () => {
  it("1. passes awkward lines through byte-identical to what was ingested", () => {
    const s = openStore();
    s.ingest("alice", batch("run-1", awkwardLines));
    const groups = exportGroups(s);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.member).toBe("alice");
    expect(groups[0]!.runId).toBe("run-1");
    expect(groups[0]!.lines).toHaveLength(3);
    for (let i = 0; i < awkwardLines.length; i++) {
      expect(groups[0]!.lines[i]).toBe(awkwardLines[i]);
    }
  });

  it("2. returns lines in seq order", () => {
    const s = openStore();
    const shuffled = [awkwardLines[2]!, awkwardLines[0]!, awkwardLines[1]!];
    s.ingest("alice", batch("run-1", shuffled));
    const groups = exportGroups(s);
    expect(groups[0]!.lines).toEqual([awkwardLines[0], awkwardLines[1], awkwardLines[2]]);
  });

  it("3. two members pushing the same runId produce two groups with their own lines", () => {
    const s = openStore();
    s.ingest("alice", batch("run-1", [awkwardLines[0]!]));
    s.ingest("bob", batch("run-1", [awkwardLines[1]!, awkwardLines[2]!]));
    const groups = exportGroups(s);
    expect(groups).toHaveLength(2);
    const alice = groups.find((g) => g.member === "alice")!;
    const bob = groups.find((g) => g.member === "bob")!;
    expect(alice.lines).toEqual([awkwardLines[0]]);
    expect(bob.lines).toEqual([awkwardLines[1], awkwardLines[2]]);
  });

  it("4. a store with no events produces no groups", () => {
    const s = openStore();
    expect(exportGroups(s)).toEqual([]);
  });

  it("5. a stored line is never re-encoded (export passes the original through)", () => {
    const s = openStore();
    s.ingest("alice", batch("run-1", [awkwardLines[0]!]));
    const groups = exportGroups(s);
    const exported = groups[0]!.lines[0]!;
    expect(exported).not.toBe(JSON.stringify(JSON.parse(exported)));
  });
});
