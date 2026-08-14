import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CommandAdapter } from "./adapters/command.js";
import type { Adapter, AdapterInput } from "./adapters/types.js";
import { execute, makeRunId, newRunState } from "./core/engine.js";
import { EventLog } from "./core/events.js";
import { loadGraph, parseGraph } from "./core/graph.js";
import { CheckpointStore } from "./core/store.js";
import { runCommand } from "./commands/run.js";
import { resumeCommand } from "./commands/resume.js";

/**
 * End to end over the real engine, real checkpoint store and the real shell
 * command adapter. Every node is a `command` node, so this never spawns an
 * agent CLI and never makes a network call.
 */

const HELLO = resolve("examples/hello.yaml");

let dir: string;
let originalCwd: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lg-e2e-"));
  originalCwd = process.cwd();
});

afterEach(() => {
  process.chdir(originalCwd);
});

/** Delegates to the real command adapter, but crashes on one node's command. */
function crashingOn(marker: string): Adapter {
  const real = new CommandAdapter();
  const calls: string[] = [];
  const adapter: Adapter & { calls: string[] } = {
    name: "command",
    calls,
    run: async (input: AdapterInput) => {
      calls.push(input.prompt);
      if (input.prompt.includes(marker)) throw new Error("SENTINEL: process killed");
      return real.run(input);
    },
  };
  return adapter;
}

describe("end to end", () => {
  it("runs examples/hello.yaml with zero cost", async () => {
    const graph = loadGraph(HELLO);
    const store = new CheckpointStore(join(dir, "runs"));
    const log = new EventLog(join(dir, "runs"));
    const runId = makeRunId(graph.name);

    const final = await execute(graph, newRunState(graph, { runId, cwd: dir }), {
      store,
      log,
      registry: { command: new CommandAdapter() },
    });

    expect(final.status).toBe("succeeded");
    expect(final.spent.usd).toBe(0);
    expect(final.completed).toEqual(["greet", "where", "done"]);
    expect(final.nodes.greet!.output).toContain("hello from loomgraph");
    expect(store.load(runId)!.status).toBe("succeeded");
    expect(log.read(runId).some((e) => e.kind === "run_finished")).toBe(true);
  });

  it("survives a kill mid-run and resumes without re-running finished nodes", async () => {
    const counter = join(dir, "counter.txt");
    const graphSrc = `
name: counted
budget: { maxUsd: 0.01, maxWallClockSec: 120, maxNodeRuns: 9 }
nodes:
  one: { type: command, run: "echo one >> counter.txt" }
  two: { type: command, run: "echo two >> counter.txt" }
  three: { type: command, run: "echo three >> counter.txt" }
edges:
  - { from: one, to: two }
  - { from: two, to: three }
  - { from: three, to: END }
`;
    writeFileSync(join(dir, "graph.yaml"), graphSrc, "utf8");
    const graph = parseGraph(graphSrc);
    const store = new CheckpointStore(join(dir, "runs"));
    const log = new EventLog(join(dir, "runs"));
    const runId = makeRunId(graph.name);

    // First attempt: the process dies while node "two" is running.
    const crashing = crashingOn("echo two");
    await expect(
      execute(graph, newRunState(graph, { runId, cwd: dir }), { store, log, registry: { command: crashing } }),
    ).rejects.toThrow(/SENTINEL/);

    expect(readFileSync(counter, "utf8").trim().split("\n")).toEqual(["one"]);
    const checkpoint = store.load(runId)!;
    expect(checkpoint.completed).toEqual(["one"]);
    expect(checkpoint.status).toBe("running");

    // Resume from the on-disk checkpoint with a healthy adapter.
    const final = await execute(graph, checkpoint, { store, log, registry: { command: new CommandAdapter() } });

    expect(final.status).toBe("succeeded");
    // Node "one" ran exactly once across both invocations.
    expect(readFileSync(counter, "utf8").trim().split("\n")).toEqual(["one", "two", "three"]);
    expect(final.nodes.one!.attempts).toBe(1);
    // The audit trail spans both invocations without restarting its numbering.
    const kinds = log.read(runId).map((e) => e.kind);
    expect(kinds.filter((k) => k === "run_started")).toHaveLength(2);
    expect(log.read(runId).map((e) => e.seq)).toEqual(log.read(runId).map((_, i) => i));
  });

  it("pauses at a human node and finishes once the answer is supplied", async () => {
    const graphSrc = `
name: gated
budget: { maxUsd: 0.01, maxWallClockSec: 120, maxNodeRuns: 9 }
nodes:
  before: { type: command, run: "echo before > gate.txt" }
  approve: { type: human, question: "Ship it?" }
  after: { type: command, run: "echo after >> gate.txt" }
edges:
  - { from: before, to: approve }
  - { from: approve, to: after }
  - { from: after, to: END }
`;
    const graph = parseGraph(graphSrc);
    const store = new CheckpointStore(join(dir, "runs"));
    const log = new EventLog(join(dir, "runs"));
    const runId = makeRunId(graph.name);
    const registry = { command: new CommandAdapter() };

    const paused = await execute(graph, newRunState(graph, { runId, cwd: dir }), { store, log, registry });
    expect(paused.status).toBe("paused");
    expect(readFileSync(join(dir, "gate.txt"), "utf8").trim()).toBe("before");

    const final = await execute(graph, store.load(runId)!, {
      store,
      log,
      registry,
      humanAnswers: { approve: "ship it" },
    });
    expect(final.status).toBe("succeeded");
    expect(readFileSync(join(dir, "gate.txt"), "utf8").trim().split("\n")).toEqual(["before", "after"]);
  });

  it("drives the same flow through the run and resume commands", async () => {
    process.chdir(dir);
    const logged: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => void logged.push(args.join(" "));

    try {
      const code = await runCommand(HELLO, { var: [] });
      expect(code).toBe(0);

      const runId = logged
        .map((line) => /^> run (\S+) \(new\)$/.exec(line)?.[1])
        .find((id): id is string => Boolean(id))!;
      expect(existsSync(join(dir, ".loomgraph", "runs", runId, "state.json"))).toBe(true);
      expect(existsSync(join(dir, ".loomgraph", "runs", runId, "events.jsonl"))).toBe(true);

      // A finished run cannot be resumed.
      const originalError = console.error;
      console.error = () => {};
      try {
        expect(await resumeCommand(runId, { answer: [] })).toBe(1);
      } finally {
        console.error = originalError;
      }
    } finally {
      console.log = original;
    }
  });
});
