import { describe, it, expect, beforeEach } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "./events.js";

describe("EventLog", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lg-ev-")); });

  it("writes one jsonl line per event", () => {
    const log = new EventLog(dir);
    log.append("r1", { kind: "run_started", data: { graph: "t" } });
    log.append("r1", { kind: "node_started", nodeId: "a", data: {} });

    const raw = readFileSync(join(dir, "r1", "events.jsonl"), "utf8");
    const lines = raw.split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).kind).toBe("run_started");
    expect(JSON.parse(lines[1]!).nodeId).toBe("a");
  });

  it("reads events back in order with seq starting at 0", () => {
    const log = new EventLog(dir);
    log.append("r2", { kind: "run_started", data: {} });
    log.append("r2", { kind: "node_started", nodeId: "a", data: {} });
    log.append("r2", { kind: "node_finished", nodeId: "a", data: { status: "succeeded" } });

    const events = log.read("r2");
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(events.map((e) => e.kind)).toEqual(["run_started", "node_started", "node_finished"]);
    expect(events.every((e) => e.runId === "r2")).toBe(true);
    expect(events.every((e) => typeof e.ts === "string")).toBe(true);
  });

  it("continues the seq when a fresh writer appends to an existing log", () => {
    new EventLog(dir).append("r3", { kind: "run_started", data: {} });
    new EventLog(dir).append("r3", { kind: "run_finished", data: {} });

    expect(new EventLog(dir).read("r3").map((e) => e.seq)).toEqual([0, 1]);
  });

  it("skips malformed lines instead of throwing", () => {
    const log = new EventLog(dir);
    log.append("r4", { kind: "run_started", data: {} });
    appendFileSync(join(dir, "r4", "events.jsonl"), "{not json\n", "utf8");
    log.append("r4", { kind: "run_finished", data: {} });

    const events = log.read("r4");
    expect(events.map((e) => e.kind)).toEqual(["run_started", "run_finished"]);
  });

  it("returns an empty list for a run with no log", () => {
    expect(new EventLog(dir).read("nope")).toEqual([]);
  });

  it("records the nodeId and data payload verbatim", () => {
    const log = new EventLog(dir);
    log.append("r5", { kind: "budget_exceeded", nodeId: "fix", data: { reason: "usd ceiling" } });
    const [event] = log.read("r5");
    expect(event!.nodeId).toBe("fix");
    expect(event!.data).toEqual({ reason: "usd ceiling" });
  });

  it("tolerates a log directory that already exists", () => {
    mkdirSync(join(dir, "r6"), { recursive: true });
    const log = new EventLog(dir);
    log.append("r6", { kind: "run_started", data: {} });
    expect(log.read("r6")).toHaveLength(1);
  });
});
