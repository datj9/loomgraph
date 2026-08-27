import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../core/events.js";
import { CheckpointStore } from "../core/store.js";
import { eventsCommand } from "./events.js";
import type { RunState } from "../core/types.js";

const RUN_ID = "run-123";

/** The 9 documented event kinds, exactly as in the README. */
const VALID_KINDS = [
  "run_started",
  "node_started",
  "node_finished",
  "edge_crossed",
  "budget_checked",
  "budget_exceeded",
  "human_requested",
  "human_resolved",
  "run_finished",
];

function makeState(): RunState {
  return {
    runId: RUN_ID,
    streamId: "stream-1",
    graphName: "demo",
    status: "succeeded",
    createdAt: "2026-08-14T12:00:00.000Z",
    updatedAt: "2026-08-14T12:01:00.000Z",
    cwd: "/repo",
    vars: { ticket: "LG-1" },
    budget: { maxUsd: 2, maxWallClockSec: 1800, maxNodeRuns: 20 },
    spent: { usd: 0.25, wallClockSec: 60, nodeRuns: 2 },
    nodes: {},
    completed: [],
    seq: 1,
  };
}

describe("eventsCommand --kind validation", () => {
  let work: string;
  let originalCwd: string;

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "lg-events-test-"));
    originalCwd = process.cwd();
    process.chdir(work);

    // A real run checkpoint, so the command gets past the existence check.
    new CheckpointStore(join(work, ".loomgraph", "runs")).save(makeState());
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(work, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("rejects an unknown --kind with exit 1, a stderr message, and no stdout", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = eventsCommand(RUN_ID, { kind: "node_startedd" });

    expect(code).toBe(1);
    const message = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(message).toContain("node_startedd");
    for (const kind of VALID_KINDS) expect(message).toContain(kind);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("accepts every valid kind, even when the run has no events of it", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    for (const kind of VALID_KINDS) {
      const code = eventsCommand(RUN_ID, { kind });
      expect(code).toBe(0);
    }
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("still prints matching events for a known kind", () => {
    const log = new EventLog(join(work, ".loomgraph", "runs"));
    log.append(RUN_ID, { kind: "budget_exceeded", data: { reason: "maxUsd" } });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = eventsCommand(RUN_ID, { kind: "budget_exceeded" });

    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledTimes(1);
  });

  it("leaves behaviour unchanged when --kind is not supplied", () => {
    const log = new EventLog(join(work, ".loomgraph", "runs"));
    log.append(RUN_ID, { kind: "run_started", data: {} });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = eventsCommand(RUN_ID, {});

    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledTimes(1);
  });
});