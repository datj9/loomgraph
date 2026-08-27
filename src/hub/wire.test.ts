import { describe, expect, it } from "vitest";
import {
  MAX_BODY_BYTES,
  NO_EVENTS_YET,
  eventBatchSchema,
  type EventBatch,
  type IngestConflict,
  type IngestResult,
  type ProjectedNode,
  type ProjectedState,
  type RunRow,
} from "./wire.js";

const rawLine =
  '{"ts":"2026-08-25T00:00:00.000Z","runId":"run-1","seq":0,"kind":"run_started","data":{"graph":"g"}}';

function baseState(): ProjectedState {
  return {
    runId: "run-1",
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
    seq: 1,
  };
}

function baseBatch(overrides: Partial<EventBatch> = {}): EventBatch {
  return {
    runId: "run-1",
    streamId: "s-1",
    graphName: "g",
    state: baseState(),
    events: [rawLine],
    ...overrides,
  };
}

describe("eventBatchSchema", () => {
  it("rejects a batch whose events elements are objects rather than strings", () => {
    const batch = baseBatch({
      events: [JSON.parse(rawLine) as unknown as string],
    });
    expect(eventBatchSchema.safeParse(batch).success).toBe(false);
  });

  it("rejects an events element that is not valid JSON", () => {
    const batch = baseBatch({ events: ["this is {not json"] });
    expect(eventBatchSchema.safeParse(batch).success).toBe(false);
  });

  it("accepts a realistic raw line unchanged and projects its seq", () => {
    const batch = baseBatch();
    const result = eventBatchSchema.safeParse(batch);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const [line] = result.data.events;
    expect(line).toBe(rawLine);
    expect(JSON.parse(line ?? "").seq).toBe(0);
  });

  it("accepts a line carrying an unknown top-level key and returns it byte-identically", () => {
    const line = rawLine.slice(0, -1) + ',"futureKey":{"x":1}}';
    const batch = baseBatch({ events: [line] });
    const result = eventBatchSchema.safeParse(batch);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.events[0]).toBe(line);
  });

  it("rejects a line that is missing seq", () => {
    const line = rawLine.replace(',"seq":0', "");
    expect(eventBatchSchema.safeParse(baseBatch({ events: [line] })).success).toBe(false);
  });

  it("rejects a line whose kind is not one of the known kinds", () => {
    const line = rawLine.replace('"kind":"run_started"', '"kind":"run_exploded"');
    expect(eventBatchSchema.safeParse(baseBatch({ events: [line] })).success).toBe(false);
  });

  it("rejects a state carrying an unknown extra key", () => {
    const state = { ...baseState(), vars: {} };
    expect(eventBatchSchema.safeParse(baseBatch({ state })).success).toBe(false);
  });

  it("rejects a ProjectedNode carrying an output key", () => {
    const state = baseState();
    state.nodes = {
      n1: {
        nodeId: "n1",
        status: "succeeded",
        startedAt: "2026-08-25T00:00:00.000Z",
        endedAt: "2026-08-25T00:00:01.000Z",
        attempts: 1,
        error: null,
        costUsd: 0.1,
        output: "should not be here",
      } as ProjectedNode & { output: string },
    };
    expect(eventBatchSchema.safeParse(baseBatch({ state })).success).toBe(false);
  });

  it("rejects a batch whose state.runId differs from its top-level runId", () => {
    const batch = baseBatch({ state: { ...baseState(), runId: "run-B" } });
    const result = eventBatchSchema.safeParse(batch);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((i) => i.path.join(".") === "state.runId")).toBe(true);
  });

  it("rejects a batch whose state.graphName differs from its top-level graphName", () => {
    const batch = baseBatch({ state: { ...baseState(), graphName: "other" } });
    const result = eventBatchSchema.safeParse(batch);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((i) => i.path.join(".") === "state.graphName")).toBe(
      true,
    );
  });

  it("reports both problems when runId and graphName both disagree", () => {
    const batch = baseBatch({
      runId: "run-A",
      graphName: "gA",
      state: { ...baseState(), runId: "run-B", graphName: "gB" },
    });
    const result = eventBatchSchema.safeParse(batch);
    expect(result.success).toBe(false);
    if (result.success) return;
    const paths = result.error.issues.map((i) => i.path.join("."));
    expect(paths).toContain("state.runId");
    expect(paths).toContain("state.graphName");
  });

  it("rejects a batch whose nodes map key differs from the node's nodeId", () => {
    const state = baseState();
    state.nodes = {
      alpha: {
        nodeId: "BETA",
        status: "running",
        startedAt: "2026-08-25T00:00:00.000Z",
        endedAt: null,
        attempts: 1,
        error: null,
        costUsd: 0.1,
      },
    };
    const result = eventBatchSchema.safeParse(baseBatch({ state }));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((i) => i.path.join(".") === "state.nodes.alpha.nodeId")).toBe(
      true,
    );
  });

  it("reports every mismatched nodes entry, not just the first", () => {
    const state = baseState();
    state.nodes = {
      alpha: {
        nodeId: "BETA",
        status: "running",
        startedAt: "2026-08-25T00:00:00.000Z",
        endedAt: null,
        attempts: 1,
        error: null,
        costUsd: 0.1,
      },
      gamma: {
        nodeId: "delta",
        status: "succeeded",
        startedAt: "2026-08-25T00:00:00.000Z",
        endedAt: "2026-08-25T00:00:01.000Z",
        attempts: 1,
        error: null,
        costUsd: 0.1,
      },
    };
    const result = eventBatchSchema.safeParse(baseBatch({ state }));
    expect(result.success).toBe(false);
    if (result.success) return;
    const paths = result.error.issues.map((i) => i.path.join("."));
    expect(paths).toContain("state.nodes.alpha.nodeId");
    expect(paths).toContain("state.nodes.gamma.nodeId");
  });

  it("tells a not-JSON line apart from a JSON-but-invalid-event line", () => {
    const notJson = eventBatchSchema.safeParse(baseBatch({ events: ["this is {not json"] }));
    expect(notJson.success).toBe(false);
    if (notJson.success) return;
    const notJsonMessages = notJson.error.issues.map((i) => i.message);
    expect(notJsonMessages.some((m) => m !== "Invalid input")).toBe(true);
    expect(notJsonMessages.some((m) => m.includes("JSON"))).toBe(true);

    const badEvent = eventBatchSchema.safeParse(
      baseBatch({ events: [rawLine.replace(',"seq":0', "")] }),
    );
    expect(badEvent.success).toBe(false);
    if (badEvent.success) return;
    const badEventMessages = badEvent.error.issues.map((i) => i.message);
    expect(badEventMessages.some((m) => m !== "Invalid input")).toBe(true);
    expect(badEventMessages.some((m) => m.includes("seq"))).toBe(true);
  });

  it("accepts a fully valid batch", () => {
    expect(eventBatchSchema.safeParse(baseBatch()).success).toBe(true);
  });

  it("rejects an event line whose seq is negative", () => {
    const line = rawLine.replace('"seq":0', '"seq":-1');
    expect(eventBatchSchema.safeParse(baseBatch({ events: [line] })).success).toBe(false);
  });

  it("rejects an event line whose seq is not an integer", () => {
    const line = rawLine.replace('"seq":0', '"seq":1.5');
    expect(eventBatchSchema.safeParse(baseBatch({ events: [line] })).success).toBe(false);
  });

  it("rejects a state whose seq is negative", () => {
    const state = { ...baseState(), seq: -1 };
    expect(eventBatchSchema.safeParse(baseBatch({ state })).success).toBe(false);
  });

  it("rejects a state whose seq is not an integer", () => {
    const state = { ...baseState(), seq: 1.5 };
    expect(eventBatchSchema.safeParse(baseBatch({ state })).success).toBe(false);
  });

  it("rejects an empty identity string on the batch or the state", () => {
    expect(eventBatchSchema.safeParse(baseBatch({ runId: "" })).success).toBe(false);
    expect(eventBatchSchema.safeParse(baseBatch({ streamId: "" })).success).toBe(false);
    expect(eventBatchSchema.safeParse(baseBatch({ graphName: "" })).success).toBe(false);
    expect(
      eventBatchSchema.safeParse(baseBatch({ state: { ...baseState(), runId: "" } })).success,
    ).toBe(false);
    expect(
      eventBatchSchema.safeParse(baseBatch({ state: { ...baseState(), graphName: "" } })).success,
    ).toBe(false);
  });

  it("rejects a node with negative costUsd", () => {
    const state = baseState();
    state.nodes = {
      n1: {
        nodeId: "n1",
        status: "succeeded",
        startedAt: "2026-08-25T00:00:00.000Z",
        endedAt: "2026-08-25T00:00:01.000Z",
        attempts: 1,
        error: null,
        costUsd: -0.1,
      },
    };
    expect(eventBatchSchema.safeParse(baseBatch({ state })).success).toBe(false);
  });

  it("rejects a node whose attempts is negative or not an integer", () => {
    const withAttempts = (attempts: number) => {
      const state = baseState();
      state.nodes = {
        n1: {
          nodeId: "n1",
          status: "running",
          startedAt: "2026-08-25T00:00:00.000Z",
          endedAt: null,
          attempts,
          error: null,
          costUsd: 0.1,
        },
      };
      return baseBatch({ state });
    };
    expect(eventBatchSchema.safeParse(withAttempts(-1)).success).toBe(false);
    expect(eventBatchSchema.safeParse(withAttempts(1.5)).success).toBe(false);
  });

  it("rejects negative or non-integer spent values", () => {
    const withSpent = (spent: { usd: number; wallClockSec: number; nodeRuns: number }) =>
      baseBatch({ state: { ...baseState(), spent } });
    expect(eventBatchSchema.safeParse(withSpent({ usd: -0.1, wallClockSec: 0, nodeRuns: 0 })).success).toBe(false);
    expect(eventBatchSchema.safeParse(withSpent({ usd: 0, wallClockSec: -1, nodeRuns: 0 })).success).toBe(false);
    expect(eventBatchSchema.safeParse(withSpent({ usd: 0, wallClockSec: 0, nodeRuns: -1 })).success).toBe(false);
    expect(eventBatchSchema.safeParse(withSpent({ usd: 0, wallClockSec: 0, nodeRuns: 1.5 })).success).toBe(false);
  });

  it("rejects a budget the engine's own graph parser would reject", () => {
    const withBudget = (budget: { maxUsd: number; maxWallClockSec: number; maxNodeRuns: number }) =>
      baseBatch({ state: { ...baseState(), budget } });
    expect(eventBatchSchema.safeParse(withBudget({ maxUsd: 0, maxWallClockSec: 60, maxNodeRuns: 10 })).success).toBe(false);
    expect(eventBatchSchema.safeParse(withBudget({ maxUsd: 1, maxWallClockSec: 0, maxNodeRuns: 10 })).success).toBe(false);
    expect(eventBatchSchema.safeParse(withBudget({ maxUsd: 1, maxWallClockSec: 60, maxNodeRuns: 0 })).success).toBe(false);
    expect(eventBatchSchema.safeParse(withBudget({ maxUsd: 1, maxWallClockSec: 60, maxNodeRuns: 1.5 })).success).toBe(false);
  });

  it("rejects a varKeys array with duplicate entries", () => {
    const state = { ...baseState(), varKeys: ["a", "b", "a"] };
    expect(eventBatchSchema.safeParse(baseBatch({ state })).success).toBe(false);
  });

  it("rejects a batch whose event seqs are not strictly increasing", () => {
    const events = [2, 0, 1].map((s) => rawLine.replace('"seq":0', `"seq":${s}`));
    const result = eventBatchSchema.safeParse(baseBatch({ events }));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((i) => i.path.join(".") === "events.1")).toBe(true);
  });

  it("rejects intra-batch duplicate seqs", () => {
    const events = [rawLine, rawLine.replace('"seq":0', '"seq":0')];
    const result = eventBatchSchema.safeParse(baseBatch({ events }));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((i) => i.path.join(".") === "events.1")).toBe(true);
  });

  it("rejects an event line whose runId differs from the batch runId", () => {
    const line = rawLine.replace('"runId":"run-1"', '"runId":"run-other"');
    const result = eventBatchSchema.safeParse(baseBatch({ events: [line] }));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((i) => i.path.join(".") === "events.0")).toBe(true);
  });

  it("rejects a completed id that is absent from nodes", () => {
    const state = baseState();
    state.nodes = {
      n1: {
        nodeId: "n1",
        status: "succeeded",
        startedAt: "2026-08-25T00:00:00.000Z",
        endedAt: "2026-08-25T00:00:01.000Z",
        attempts: 1,
        error: null,
        costUsd: 0.1,
      },
    };
    state.completed = ["n1", "ghost"];
    const result = eventBatchSchema.safeParse(baseBatch({ state }));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((i) => i.path.join(".") === "state.completed")).toBe(true);
  });

  it("still accepts a batch with no events", () => {
    expect(eventBatchSchema.safeParse(baseBatch({ events: [] })).success).toBe(true);
  });

  const node = (overrides: Partial<ProjectedNode> = {}): ProjectedNode => ({
    nodeId: "n1",
    status: "succeeded",
    startedAt: "2026-08-25T00:00:00.000Z",
    endedAt: "2026-08-25T00:00:01.000Z",
    attempts: 1,
    error: null,
    costUsd: 0.1,
    ...overrides,
  });

  const withNode = (n: ProjectedNode) => {
    const state = baseState();
    state.nodes = { [n.nodeId]: n };
    return baseBatch({ state });
  };

  describe("CLASS 1: timestamps must round-trip through toISOString", () => {
    const bad = ["", "   ", "banana", "\u0001"];

    it.each(bad)("rejects ts %j on an event line", (ts) => {
      const line = rawLine.replace('"ts":"2026-08-25T00:00:00.000Z"', `"ts":${JSON.stringify(ts)}`);
      expect(eventBatchSchema.safeParse(baseBatch({ events: [line] })).success).toBe(false);
    });

    it.each(bad)("rejects state.createdAt %j", (createdAt) => {
      const state = { ...baseState(), createdAt } as ProjectedState;
      expect(eventBatchSchema.safeParse(baseBatch({ state })).success).toBe(false);
    });

    it.each(bad)("rejects state.updatedAt %j", (updatedAt) => {
      const state = { ...baseState(), updatedAt } as ProjectedState;
      expect(eventBatchSchema.safeParse(baseBatch({ state })).success).toBe(false);
    });

    it.each(bad)("rejects node.startedAt %j", (startedAt) => {
      const batch = withNode(node({ startedAt }));
      expect(eventBatchSchema.safeParse(batch).success).toBe(false);
    });

    it.each(bad)("rejects a non-null node.endedAt %j", (endedAt) => {
      const batch = withNode(node({ status: "succeeded", endedAt }));
      expect(eventBatchSchema.safeParse(batch).success).toBe(false);
    });
  });

  describe("CLASS 2: identity strings", () => {
    const bad = ["   ", "a\nb"];

    it.each(bad)("rejects eventBatchSchema.runId %j", (runId) => {
      expect(eventBatchSchema.safeParse(baseBatch({ runId })).success).toBe(false);
    });
    it.each(bad)("rejects eventBatchSchema.streamId %j", (streamId) => {
      expect(eventBatchSchema.safeParse(baseBatch({ streamId })).success).toBe(false);
    });
    it.each(bad)("rejects eventBatchSchema.graphName %j", (graphName) => {
      expect(eventBatchSchema.safeParse(baseBatch({ graphName })).success).toBe(false);
    });
    it.each(bad)("rejects state.runId %j", (runId) => {
      const state = { ...baseState(), runId } as ProjectedState;
      expect(eventBatchSchema.safeParse(baseBatch({ state })).success).toBe(false);
    });
    it.each(bad)("rejects state.graphName %j", (graphName) => {
      const state = { ...baseState(), graphName } as ProjectedState;
      expect(eventBatchSchema.safeParse(baseBatch({ state })).success).toBe(false);
    });
    it.each(bad)("rejects state.cwd %j", (cwd) => {
      const state = { ...baseState(), cwd } as ProjectedState;
      expect(eventBatchSchema.safeParse(baseBatch({ state })).success).toBe(false);
    });
  });

  describe("CLASS 3: node identity", () => {
    const bad = ["", "a b", "x".repeat(70), "END"];

    it.each(bad)("rejects a nodes map key %j", (key) => {
      const state = baseState();
      state.nodes = { [key]: node({ nodeId: key }) };
      expect(eventBatchSchema.safeParse(baseBatch({ state })).success).toBe(false);
    });

    it.each(bad)("rejects a nodeId field %j", (nodeId) => {
      expect(eventBatchSchema.safeParse(withNode(node({ nodeId }))).success).toBe(false);
    });
  });

  describe("CLASS 4: status and timestamp coherence", () => {
    it("rejects a succeeded node with a null endedAt", () => {
      const batch = withNode(node({ status: "succeeded", endedAt: null }));
      const result = eventBatchSchema.safeParse(batch);
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.issues.some((i) => i.path.join(".") === "state.nodes.n1.endedAt")).toBe(
        true,
      );
    });

    it("rejects a failed node with a null endedAt", () => {
      const batch = withNode(node({ status: "failed", endedAt: null, error: "boom" }));
      expect(eventBatchSchema.safeParse(batch).success).toBe(false);
    });

    it("rejects a skipped node with a null endedAt", () => {
      const batch = withNode(node({ status: "skipped", endedAt: null }));
      expect(eventBatchSchema.safeParse(batch).success).toBe(false);
    });

    it("accepts a pending or running node with a null endedAt", () => {
      expect(eventBatchSchema.safeParse(withNode(node({ status: "pending", endedAt: null }))).success).toBe(true);
      expect(eventBatchSchema.safeParse(withNode(node({ status: "running", endedAt: null }))).success).toBe(true);
    });

    it("rejects an endedAt earlier than its startedAt", () => {
      const batch = withNode(
        node({ startedAt: "2026-08-25T00:00:02.000Z", endedAt: "2026-08-25T00:00:01.000Z" }),
      );
      const result = eventBatchSchema.safeParse(batch);
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.issues.some((i) => i.path.join(".") === "state.nodes.n1.endedAt")).toBe(
        true,
      );
    });

    it("accepts endedAt equal to startedAt", () => {
      const batch = withNode(
        node({ startedAt: "2026-08-25T00:00:00.000Z", endedAt: "2026-08-25T00:00:00.000Z" }),
      );
      expect(eventBatchSchema.safeParse(batch).success).toBe(true);
    });
  });

  describe("CLASS 5: attempts", () => {
    it("rejects attempts of 0", () => {
      expect(eventBatchSchema.safeParse(withNode(node({ attempts: 0 }))).success).toBe(false);
    });

    it("rejects attempts above MAX_ATTEMPTS", () => {
      expect(eventBatchSchema.safeParse(withNode(node({ attempts: 1001 }))).success).toBe(false);
    });
  });

  describe("CLASS 6: cardinality", () => {
    it("rejects varKeys with more than MAX_VAR_KEYS entries", () => {
      const state = { ...baseState(), varKeys: Array.from({ length: 257 }, (_, i) => `k${i}`) };
      expect(eventBatchSchema.safeParse(baseBatch({ state })).success).toBe(false);
    });

    it("rejects nodes with more than MAX_NODES entries", () => {
      const state = baseState();
      for (let i = 0; i < 1001; i++) {
        const id = `n${i}`;
        state.nodes[id] = node({ nodeId: id });
      }
      expect(eventBatchSchema.safeParse(baseBatch({ state })).success).toBe(false);
    });

    it("rejects completed with more than MAX_NODES entries", () => {
      const state = baseState();
      for (let i = 0; i < 1001; i++) {
        const id = `n${i}`;
        state.nodes[id] = node({ nodeId: id });
      }
      state.completed = Array.from({ length: 1001 }, (_, i) => `n${i}`);
      expect(eventBatchSchema.safeParse(baseBatch({ state })).success).toBe(false);
    });
  });

  describe("CLASS 7: completed duplicates", () => {
    it("rejects a completed list with duplicate ids", () => {
      const state = baseState();
      state.nodes = {
        n1: node(),
        n2: node({ nodeId: "n2" }),
      };
      state.completed = ["n1", "n1"];
      expect(eventBatchSchema.safeParse(baseBatch({ state })).success).toBe(false);
    });
  });

  describe("CLASS 8: empty error string", () => {
    it("rejects a node error that is an empty string", () => {
      expect(eventBatchSchema.safeParse(withNode(node({ status: "failed", error: "" }))).success).toBe(false);
    });

    it("rejects a node error that is whitespace only", () => {
      expect(eventBatchSchema.safeParse(withNode(node({ status: "failed", error: "   " }))).success).toBe(false);
    });

    it("accepts a null error", () => {
      expect(eventBatchSchema.safeParse(withNode(node({ error: null }))).success).toBe(true);
    });
  });

  describe("must remain accepted", () => {
    it("accepts an event seq gap, e.g. [0,5]", () => {
      const events = [0, 5].map((s) => rawLine.replace('"seq":0', `"seq":${s}`));
      expect(eventBatchSchema.safeParse(baseBatch({ events })).success).toBe(true);
    });

    it("accepts a line with empty data", () => {
      const line = rawLine.replace('"data":{"graph":"g"}', '"data":{}');
      expect(eventBatchSchema.safeParse(baseBatch({ events: [line] })).success).toBe(true);
    });

    it("accepts an unknown top-level key and returns it byte-identically", () => {
      const line = rawLine.slice(0, -1) + ',"futureKey":{"x":1}}';
      const result = eventBatchSchema.safeParse(baseBatch({ events: [line] }));
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.events[0]).toBe(line);
    });

    it("accepts an empty nodes map alongside a run_started line", () => {
      const state = { ...baseState(), nodes: {} };
      expect(eventBatchSchema.safeParse(baseBatch({ state })).success).toBe(true);
    });

    it("accepts a seq of Number.MAX_SAFE_INTEGER on a line", () => {
      const line = rawLine.replace('"seq":0', `"seq":${Number.MAX_SAFE_INTEGER}`);
      expect(eventBatchSchema.safeParse(baseBatch({ events: [line] })).success).toBe(true);
    });

    it("accepts spent greater than budget", () => {
      const state = {
        ...baseState(),
        spent: { usd: 5, wallClockSec: 0, nodeRuns: 20 },
      };
      expect(eventBatchSchema.safeParse(baseBatch({ state })).success).toBe(true);
    });

    it("accepts a budget.maxUsd of 1e-300", () => {
      const state = { ...baseState(), budget: { maxUsd: 1e-300, maxWallClockSec: 60, maxNodeRuns: 10 } };
      expect(eventBatchSchema.safeParse(baseBatch({ state })).success).toBe(true);
    });
  });
});

describe("MAX_BODY_BYTES", () => {
  it("is 5 MiB", () => {
    expect(MAX_BODY_BYTES).toBe(5 * 1024 * 1024);
  });
});

describe("NO_EVENTS_YET", () => {
  it("is -1 and cannot collide with a real zero-based seq", () => {
    expect(NO_EVENTS_YET).toBe(-1);
    expect(NO_EVENTS_YET).toBeLessThan(0);
  });
});

describe("ingest result union", () => {
  function ingestTag(result: IngestResult | IngestConflict): number {
    if (result.conflict) {
      return result.seq;
    }
    return result.highWaterSeq;
  }

  it("routes both arms of the conflict-tagged union to distinguishable values", () => {
    const success: IngestResult = {
      conflict: false,
      highWaterSeq: 7,
      accepted: 2,
      duplicates: 1,
    };
    const conflict: IngestConflict = {
      conflict: true,
      runId: "run-1",
      seq: 3,
    };
    expect(ingestTag(success)).toBe(7);
    expect(ingestTag(conflict)).toBe(3);
  });
});

describe("RunRow status", () => {
  function runRowStatus(row: RunRow): number {
    switch (row.status) {
      case "pending":
        return 0;
      case "running":
        return 1;
      case "paused":
        return 2;
      case "succeeded":
        return 3;
      case "failed":
        return 4;
    }
  }

  it("switches exhaustively over the status union, like the ingest union test", () => {
    const base: RunRow = {
      member: "m",
      runId: "run-1",
      streamId: "s-1",
      graphName: "g",
      status: "running",
      updatedAt: "2026-08-25T00:00:00.000Z",
      receivedAt: "2026-08-25T00:00:00.000Z",
    };
    expect(runRowStatus({ ...base, status: "pending" })).toBe(0);
    expect(runRowStatus(base)).toBe(1);
    expect(runRowStatus({ ...base, status: "succeeded" })).toBe(3);
    expect(runRowStatus({ ...base, status: "failed" })).toBe(4);
  });
});
