import { describe, expect, it } from "vitest";
import {
  MAX_BODY_BYTES,
  eventBatchSchema,
  type EventBatch,
  type ProjectedNode,
  type ProjectedState,
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

  it("accepts a fully valid batch", () => {
    expect(eventBatchSchema.safeParse(baseBatch()).success).toBe(true);
  });
});

describe("MAX_BODY_BYTES", () => {
  it("is 5 MiB", () => {
    expect(MAX_BODY_BYTES).toBe(5 * 1024 * 1024);
  });
});
