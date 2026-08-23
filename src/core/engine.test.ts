import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseGraph } from "./graph.js";
import { CheckpointStore } from "./store.js";
import { EventLog } from "./events.js";
import { execute, newRunState, interpolate, readySet, containsPassToken, EngineError } from "./engine.js";
import * as engine from "./engine.js";
import type { EngineDeps } from "./engine.js";
import type { Adapter, AdapterInput, AdapterOutput } from "../adapters/types.js";
import { CommandAdapter } from "../adapters/command.js";
import type { RunState } from "./types.js";

function ok(text: string, costUsd = 0): AdapterOutput {
  return { ok: true, text, costUsd, raw: null, error: null };
}
function bad(error: string, costUsd = 0): AdapterOutput {
  return { ok: false, text: "", costUsd, raw: null, error };
}

/** A stub adapter. Tests never spawn a real agent CLI. */
function stub(name: string, fn: (input: AdapterInput) => Promise<AdapterOutput> | AdapterOutput): Adapter {
  return { name, run: async (input) => fn(input) };
}

let dir: string;
let store: CheckpointStore;
let log: EventLog;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lg-engine-"));
  store = new CheckpointStore(dir);
  log = new EventLog(dir);
});

function deps(registry: Record<string, Adapter>, extra: Partial<EngineDeps> = {}): EngineDeps {
  return { store, log, registry, sleep: async () => {}, ...extra };
}

function start(graphSrc: string, runId = "run1", vars: Record<string, unknown> = {}): RunState {
  const graph = parseGraph(graphSrc);
  return newRunState(graph, { runId, cwd: dir, vars });
}

const LINEAR = `
name: linear
budget: { maxUsd: 10, maxWallClockSec: 600, maxNodeRuns: 20 }
nodes:
  a: { type: command, run: "echo a" }
  b: { type: command, run: "echo b" }
  c: { type: command, run: "echo c" }
edges:
  - { from: a, to: b }
  - { from: b, to: c }
  - { from: c, to: END }
`;

const HYPHEN = `
name: hyphen
budget: { maxUsd: 10, maxWallClockSec: 600, maxNodeRuns: 20 }
nodes:
  my-node: { type: command, run: "echo HI" }
edges:
  - { from: my-node, to: END }
`;

const FANOUT = `
name: fanout
budget: { maxUsd: 10, maxWallClockSec: 600, maxNodeRuns: 20 }
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

describe("interpolate", () => {
  it("resolves vars by dotted and bare name and node outputs", () => {
    const state = start(LINEAR);
    state.vars = { ticket: "LG-1" };
    state.nodes.a = {
      nodeId: "a", status: "succeeded", startedAt: "", endedAt: null,
      attempts: 1, output: "repro notes", error: null, costUsd: 0,
    };
    expect(interpolate("t={{vars.ticket}} b={{ticket}} n={{nodes.a.output}}", state))
      .toBe("t=LG-1 b=LG-1 n=repro notes");
  });

  it("throws naming an unresolvable reference", () => {
    expect(() => interpolate("{{vars.nope}}", start(LINEAR))).toThrow(/nope/);
  });

  it("resolves a node output whose id contains a hyphen", () => {
    const state = start(HYPHEN);
    state.nodes["my-node"] = {
      nodeId: "my-node", status: "succeeded", startedAt: "", endedAt: null,
      attempts: 1, output: "HI", error: null, costUsd: 0,
    };
    expect(interpolate("[{{nodes.my-node.output}}]", state)).toBe("[HI]");
  });

  it("throws naming an unresolvable hyphenated reference", () => {
    expect(() => interpolate("{{nodes.no-such.output}}", start(LINEAR))).toThrow(
      new EngineError('unknown template reference "{{nodes.no-such.output}}"'),
    );
  });

  it("honours whitespace padding around a hyphenated reference", () => {
    const state = start(HYPHEN);
    state.nodes["my-node"] = {
      nodeId: "my-node", status: "succeeded", startedAt: "", endedAt: null,
      attempts: 1, output: "HI", error: null, costUsd: 0,
    };
    expect(interpolate("{{ nodes.my-node.output }}", state)).toBe("HI");
  });

  it("leaves hyphens in surrounding literal text untouched", () => {
    const state = start(HYPHEN);
    state.nodes["my-node"] = {
      nodeId: "my-node", status: "succeeded", startedAt: "", endedAt: null,
      attempts: 1, output: "HI", error: null, costUsd: 0,
    };
    expect(interpolate("a-b {{nodes.my-node.output}} c-d", state)).toBe("a-b HI c-d");
  });
});

describe("readySet", () => {
  it("starts with the entry node only, then advances as nodes complete", () => {
    const graph = parseGraph(FANOUT);
    const state = newRunState(graph, { runId: "r", cwd: dir, vars: {} });
    expect(readySet(graph, state)).toEqual(["a"]);

    state.completed = ["a"];
    state.nodes.a = { nodeId: "a", status: "succeeded", startedAt: "", endedAt: null, attempts: 1, output: "", error: null, costUsd: 0 };
    expect(readySet(graph, state).sort()).toEqual(["b", "c"]);
  });
});

describe("checkCommandExpectations", () => {
  const check = (engine as unknown as {
    checkCommandExpectations: (
      node: { expect?: string; expectNonEmpty?: boolean },
      text: string,
    ) => string | null;
  }).checkCommandExpectations;

  it("returns null when no expectations are declared", () => {
    expect(check({}, "anything")).toBeNull();
  });

  it("fails when expectNonEmpty is set and the output is blank", () => {
    expect(check({ expectNonEmpty: true }, "  \n ")).toBe("command produced no output but expectNonEmpty is set");
  });

  it("fails when the expect substring is absent", () => {
    expect(check({ expect: "PASS" }, "FAILED")).toBe("command output did not contain the expected string: PASS");
  });

  it("passes when the expect substring is present", () => {
    expect(check({ expect: "PASS" }, "the result is PASS today")).toBeNull();
  });

  it("prefers the blank-output message when both expectations fail", () => {
    expect(check({ expect: "PASS", expectNonEmpty: true }, "")).toBe("command produced no output but expectNonEmpty is set");
  });
});

describe("containsPassToken", () => {
  it("matches a whole word but not a substring of a longer word", () => {
    expect(containsPassToken("looks good - PASS", "PASS")).toBe(true);
    expect(containsPassToken("PASS", "PASS")).toBe(true);
    expect(containsPassToken("conclusion: PASS.", "PASS")).toBe(true);
    expect(containsPassToken("(PASS)", "PASS")).toBe(true);
    expect(containsPassToken("PASSWORD", "PASS")).toBe(false);
    expect(containsPassToken("BYPASS", "PASS")).toBe(false);
    expect(containsPassToken("xPASS", "PASS")).toBe(false);
    expect(containsPassToken("PASSx", "PASS")).toBe(false);
  });

  it("matches the pass string literally, including regex metacharacters", () => {
    expect(containsPassToken("status is ok? - done", "ok?")).toBe(true);
    expect(containsPassToken("okay?", "ok?")).toBe(false);
    expect(containsPassToken("[DONE]", "[DONE]")).toBe(true);
  });
});

describe("execute", () => {
  it("runs a linear graph in order and succeeds", async () => {
    const order: string[] = [];
    const registry = { command: stub("command", (i) => { order.push(i.prompt); return ok(i.prompt); }) };

    const final = await execute(parseGraph(LINEAR), start(LINEAR), deps(registry));

    expect(final.status).toBe("succeeded");
    expect(order).toEqual(["echo a", "echo b", "echo c"]);
    expect(final.completed).toEqual(["a", "b", "c"]);
    expect(Object.values(final.nodes).every((n) => n.status === "succeeded")).toBe(true);
    expect(log.read("run1").map((e) => e.kind)).toContain("run_finished");
  });

  it("checkpoints after every node, not just at the end", async () => {
    const seen: string[][] = [];
    const registry = {
      command: stub("command", (i) => {
        seen.push(store.load("run1")?.completed ?? []);
        return ok(i.prompt);
      }),
    };

    await execute(parseGraph(LINEAR), start(LINEAR), deps(registry));

    // Each node observes the checkpoint left by its predecessors.
    expect(seen).toEqual([[], ["a"], ["a", "b"]]);
    expect(store.load("run1")!.completed).toEqual(["a", "b", "c"]);
  });

  it("resumes after a crash without re-running completed nodes", async () => {
    const calls: Record<string, number> = { a: 0, b: 0, c: 0 };
    const crashing = {
      command: stub("command", (i) => {
        const id = i.prompt.split(" ")[1]!;
        calls[id] = (calls[id] ?? 0) + 1;
        if (id === "b") throw new Error("SENTINEL kill");
        return ok(i.prompt);
      }),
    };

    await expect(execute(parseGraph(LINEAR), start(LINEAR), deps(crashing))).rejects.toThrow(/SENTINEL/);

    const checkpoint = store.load("run1")!;
    expect(checkpoint.completed).toEqual(["a"]);

    const working = {
      command: stub("command", (i) => {
        const id = i.prompt.split(" ")[1]!;
        calls[id] = (calls[id] ?? 0) + 1;
        return ok(i.prompt);
      }),
    };
    const final = await execute(parseGraph(LINEAR), checkpoint, deps(working));

    expect(final.status).toBe("succeeded");
    expect(calls.a).toBe(1); // node a was not re-executed
    expect(calls.b).toBe(2);
    expect(calls.c).toBe(1);
  });

  it("dispatches a fan-out concurrently", async () => {
    let inFlight = 0;
    let peak = 0;
    const registry = {
      command: stub("command", async (i) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight -= 1;
        return ok(i.prompt);
      }),
    };

    const final = await execute(parseGraph(FANOUT), start(FANOUT), deps(registry));

    expect(final.status).toBe("succeeded");
    expect(peak).toBe(2);
  });

  it("waits for both branches of a fan-in with all_succeeded", async () => {
    const finished: string[] = [];
    const registry = {
      command: stub("command", async (i) => {
        const id = i.prompt.split(" ")[1]!;
        await new Promise((r) => setTimeout(r, id === "b" ? 30 : 1));
        finished.push(id);
        return ok(i.prompt);
      }),
    };

    const final = await execute(parseGraph(FANOUT), start(FANOUT), deps(registry));

    expect(final.status).toBe("succeeded");
    expect(finished.indexOf("d")).toBeGreaterThan(finished.indexOf("b"));
    expect(finished.indexOf("d")).toBeGreaterThan(finished.indexOf("c"));
  });

  it("stops at the budget ceiling and never dispatches the remaining nodes", async () => {
    const src = `
name: pricey
budget: { maxUsd: 1, maxWallClockSec: 600, maxNodeRuns: 20 }
nodes:
  a: { type: agent, adapter: claude, prompt: "one" }
  b: { type: agent, adapter: claude, prompt: "two" }
edges:
  - { from: a, to: b }
  - { from: b, to: END }
`;
    const seen: string[] = [];
    const registry = { claude: stub("claude", (i) => { seen.push(i.prompt); return ok("spent it", 1.5); }) };

    const final = await execute(parseGraph(src), start(src), deps(registry));

    expect(final.status).toBe("failed");
    expect(seen).toEqual(["one"]);
    expect(final.spent.usd).toBe(1.5);
    const exceeded = log.read("run1").filter((e) => e.kind === "budget_exceeded");
    expect(exceeded).toHaveLength(1);
    expect(String(exceeded[0]!.data.reason)).toMatch(/maxUsd/);
  });

  it("retries a failing node and records the attempt count", async () => {
    const src = `
name: retry
budget: { maxUsd: 10, maxWallClockSec: 600, maxNodeRuns: 20 }
nodes:
  a: { type: command, run: "flaky", retries: 1 }
edges:
  - { from: a, to: END }
`;
    let n = 0;
    const registry = { command: stub("command", () => (++n === 1 ? bad("transient") : ok("recovered"))) };

    const final = await execute(parseGraph(src), start(src), deps(registry));

    expect(final.status).toBe("succeeded");
    expect(final.nodes.a!.attempts).toBe(2);
    expect(final.nodes.a!.output).toBe("recovered");
    expect(log.read("run1").filter((e) => e.kind === "node_started")).toHaveLength(2);
  });

  it("fails the run loudly when the retries are exhausted", async () => {
    const src = `
name: doomed
budget: { maxUsd: 10, maxWallClockSec: 600, maxNodeRuns: 20 }
nodes:
  a: { type: command, run: "always broken", retries: 1 }
  b: { type: command, run: "never reached" }
edges:
  - { from: a, to: b }
  - { from: b, to: END }
`;
    const seen: string[] = [];
    const registry = { command: stub("command", (i) => { seen.push(i.prompt); return bad("still broken"); }) };

    const final = await execute(parseGraph(src), start(src), deps(registry));

    expect(final.status).toBe("failed");
    expect(final.nodes.a!.status).toBe("failed");
    expect(final.nodes.a!.attempts).toBe(2);
    expect(final.nodes.a!.error).toMatch(/still broken/);
    expect(seen).toHaveLength(2); // b was never dispatched
  });

  it("pauses at a human node and returns with zero work in flight", async () => {
    const src = `
name: gated
budget: { maxUsd: 10, maxWallClockSec: 600, maxNodeRuns: 20 }
nodes:
  a: { type: command, run: "echo a" }
  h: { type: human, question: "Ship it?" }
  b: { type: command, run: "echo b" }
edges:
  - { from: a, to: h }
  - { from: h, to: b }
  - { from: b, to: END }
`;
    const seen: string[] = [];
    const registry = { command: stub("command", (i) => { seen.push(i.prompt); return ok(i.prompt); }) };

    const paused = await execute(parseGraph(src), start(src), deps(registry));

    expect(paused.status).toBe("paused");
    expect(seen).toEqual(["echo a"]);
    const requested = log.read("run1").filter((e) => e.kind === "human_requested");
    expect(requested).toHaveLength(1);
    expect(requested[0]!.nodeId).toBe("h");

    // Answering the question lets the run finish from the checkpoint.
    const final = await execute(parseGraph(src), store.load("run1")!, deps(registry, { humanAnswers: { h: "yes" } }));
    expect(final.status).toBe("succeeded");
    expect(final.nodes.h!.output).toBe("yes");
    expect(seen).toEqual(["echo a", "echo b"]);
    expect(log.read("run1").filter((e) => e.kind === "human_resolved")).toHaveLength(1);
  });

  it("fails with a deadlock when nothing is ready and END was never reached", async () => {
    const src = `
name: stuck
budget: { maxUsd: 10, maxWallClockSec: 600, maxNodeRuns: 20 }
nodes:
  a: { type: command, run: "echo a" }
  b: { type: command, run: "echo b" }
edges:
  - { from: a, to: b }
`;
    const registry = { command: stub("command", (i) => ok(i.prompt)) };

    const final = await execute(parseGraph(src), start(src), deps(registry));

    expect(final.status).toBe("failed");
    expect(log.read("run1").find((e) => e.kind === "run_finished")!.data.error).toMatch(/deadlock/);
  });

  it("passes a verifier only when the output contains the pass string", async () => {
    const src = `
name: verify
budget: { maxUsd: 10, maxWallClockSec: 600, maxNodeRuns: 20 }
nodes:
  v: { type: verifier, adapter: codex, prompt: "review", pass: "PASS" }
edges:
  - { from: v, to: END }
`;
    const passing = { codex: stub("codex", () => ok("looks good - PASS")) };
    expect((await execute(parseGraph(src), start(src, "pass-run"), deps(passing))).status).toBe("succeeded");

    const failing = { codex: stub("codex", () => ok("FAIL: missing tests")) };
    const final = await execute(parseGraph(src), start(src, "fail-run"), deps(failing));
    expect(final.status).toBe("failed");
    expect(final.nodes.v!.error).toMatch(/PASS/);
  });

  it("does not let a substring of a longer word satisfy a verifier's pass string", async () => {
    const src = `
name: verify
budget: { maxUsd: 10, maxWallClockSec: 600, maxNodeRuns: 20 }
nodes:
  v: { type: verifier, adapter: codex, prompt: "review", pass: "PASS" }
edges:
  - { from: v, to: END }
`;
    for (const output of ["password confirmed", "BYPASS every check", "xPASS", "PASSx", "mismatch: password"]) {
      const registry = { codex: stub("codex", () => ok(output)) };
      const final = await execute(parseGraph(src), start(src, `run-${output}`), deps(registry));
      expect(final.status, `output "${output}" must fail`).toBe("failed");
      expect(final.nodes.v!.error).toMatch(/did not report the pass string/);
    }

    const boundary = { codex: stub("codex", () => ok("PASS")) };
    expect((await execute(parseGraph(src), start(src, "boundary-run"), deps(boundary))).status).toBe("succeeded");
    const ending = { codex: stub("codex", () => ok("conclusion: PASS.")) };
    expect((await execute(parseGraph(src), start(src, "ending-run"), deps(ending))).status).toBe("succeeded");
  });

  it("fails a command node whose output does not meet its expectations", async () => {
    const src = `
name: expect
budget: { maxUsd: 10, maxWallClockSec: 600, maxNodeRuns: 20 }
nodes:
  a: { type: command, run: "npm run lint --if-present", expectNonEmpty: true }
edges:
  - { from: a, to: END }
`;
    const registry = { command: stub("command", () => ok("")) };

    const final = await execute(parseGraph(src), start(src), deps(registry));

    expect(final.status).toBe("failed");
    expect(final.nodes.a!.status).toBe("failed");
    expect(final.nodes.a!.error).toBe("command produced no output but expectNonEmpty is set");
  });

  it("interpolates vars and upstream node output into an agent prompt", async () => {
    const src = `
name: templated
budget: { maxUsd: 10, maxWallClockSec: 600, maxNodeRuns: 20 }
nodes:
  a: { type: agent, adapter: claude, prompt: "Reproduce {{vars.ticket}}" }
  b: { type: agent, adapter: claude, prompt: "Fix using {{nodes.a.output}}" }
edges:
  - { from: a, to: b }
  - { from: b, to: END }
`;
    const prompts: string[] = [];
    const registry = {
      claude: stub("claude", (i) => { prompts.push(i.prompt); return ok(`out:${prompts.length}`); }),
    };

    await execute(parseGraph(src), start(src, "run1", { ticket: "LG-42" }), deps(registry));

    expect(prompts).toEqual(["Reproduce LG-42", "Fix using out:1"]);
  });

  it("refuses to execute a run that is already terminal", async () => {
    const state = start(LINEAR);
    state.status = "succeeded";
    await expect(execute(parseGraph(LINEAR), state, deps({}))).rejects.toThrow(EngineError);
  });

  it("counts every attempt against the node-run ceiling", async () => {
    const src = `
name: counted
budget: { maxUsd: 10, maxWallClockSec: 600, maxNodeRuns: 2 }
nodes:
  a: { type: command, run: "echo a" }
  b: { type: command, run: "echo b" }
  c: { type: command, run: "echo c" }
edges:
  - { from: a, to: b }
  - { from: b, to: c }
  - { from: c, to: END }
`;
    const registry = { command: stub("command", (i) => ok(i.prompt)) };
    const final = await execute(parseGraph(src), start(src), deps(registry));

    // H3: ceilings are exclusive, so maxNodeRuns 2 permits runs 1 and 2. C2
    // goes further and refuses to dispatch node c at all, so the recorded
    // spend stays exactly at the ceiling instead of overshooting to 3.
    expect(final.spent.nodeRuns).toBe(2);
    expect(final.nodes.c).toBeUndefined();
    expect(final.status).toBe("failed");
    const exceeded = log.read("run1").filter((e) => e.kind === "budget_exceeded");
    expect(exceeded).toHaveLength(1);
    expect(String(exceeded[0]!.data.reason)).toMatch(/maxNodeRuns/);
  });

  it("refuses to dispatch the fan-out nodes that would exceed maxNodeRuns, leaving no side effects (C2)", async () => {
    const sent = join(dir, "sent");
    mkdirSync(sent);

    const src = `
name: c2-admission
budget: { maxUsd: 999, maxWallClockSec: 999999, maxNodeRuns: 2 }
nodes:
  root: { type: command, run: "touch sent/root" }
  a: { type: command, run: "touch sent/a" }
  b: { type: command, run: "touch sent/b" }
  c: { type: command, run: "touch sent/c" }
  d: { type: command, run: "touch sent/d" }
edges:
  - { from: root, to: [a, b, c, d] }
  - { from: [a, b, c, d], to: END }
`;
    // Real command adapter: command nodes spawn `touch` inside the temporary
    // directory (never an agent CLI), so side effects really land on disk.
    const registry = { command: new CommandAdapter() };

    const final = await execute(parseGraph(src), start(src, "c2-run"), deps(registry));

    expect(final.status).toBe("failed");
    expect(final.spent.nodeRuns).toBe(2);
    expect(existsSync(join(sent, "root"))).toBe(true);

    // Proof that three of the four fan-out nodes were never dispatched: the
    // sent directory holds exactly two entries, and only one of a/d-d exists.
    const entries = readdirSync(sent);
    expect(entries).toHaveLength(2);
    expect(entries).toContain("root");
    const survivor = entries.find((f) => f !== "root");
    expect(survivor).toBeDefined();
    expect(["a", "b", "c", "d"]).toContain(survivor);
    for (const name of ["a", "b", "c", "d"]) {
      expect(existsSync(join(sent, name))).toBe(name === survivor);
    }

    const exceeded = log.read("c2-run").filter((e) => e.kind === "budget_exceeded");
    expect(exceeded).toHaveLength(1);
    expect(String(exceeded[0]!.data.reason)).toMatch(/maxNodeRuns/);
    expect((exceeded[0]!.data.spent as { nodeRuns: number }).nodeRuns).toBe(2);
  });

  it("refuses a retry attempt that would exceed maxNodeRuns, reporting budget_exceeded (C2 part B)", async () => {
    const src = `
name: c2b-retry
budget: { maxUsd: 999, maxWallClockSec: 999999, maxNodeRuns: 2 }
nodes:
  a: { type: command, run: "always broken", retries: 2 }
edges:
  - { from: a, to: END }
`;
    // The node always fails, so with retries 2 it would normally make 3 attempts.
    const registry = { command: stub("command", () => bad("still broken")) };
    const final = await execute(parseGraph(src), start(src, "c2b-run"), deps(registry));

    expect(final.status).toBe("failed");
    expect(final.nodes.a!.status).toBe("failed");
    // The second attempt is the last one the budget permits; the third is refused.
    expect(final.nodes.a!.attempts).toBe(2);
    expect(final.nodes.a!.attempts).not.toBe(3);
    expect(final.nodes.a!.attempts).not.toBe(4);
    const started = log.read("c2b-run").filter((e) => e.kind === "node_started" && e.nodeId === "a");
    expect(started).toHaveLength(2);
    expect(final.spent.nodeRuns).toBe(2);

    const exceeded = log.read("c2b-run").filter((e) => e.kind === "budget_exceeded");
    expect(exceeded).toHaveLength(1);
    expect(String(exceeded[0]!.data.reason)).toMatch(/maxNodeRuns/);
  });

  it("fails a run whose final spend exceeds the usd ceiling", async () => {
    const src = `
name: overshoot
budget: { maxUsd: 0.30, maxWallClockSec: 600, maxNodeRuns: 20 }
nodes:
  a: { type: command, run: "echo a" }
  b: { type: command, run: "echo b" }
edges:
  - { from: a, to: b }
  - { from: b, to: END }
`;
    const registry = {
      command: stub("command", (i) => (i.prompt === "echo a" ? ok("a", 0.2726) : ok("b", 0.2645))),
    };

    const final = await execute(parseGraph(src), start(src), deps(registry));

    expect(final.status).toBe("failed");
  });

  it("emits budget_exceeded naming the ceiling when the last batch overshoots", async () => {
    const src = `
name: overshoot-event
budget: { maxUsd: 0.30, maxWallClockSec: 600, maxNodeRuns: 20 }
nodes:
  a: { type: command, run: "echo a" }
  b: { type: command, run: "echo b" }
edges:
  - { from: a, to: b }
  - { from: b, to: END }
`;
    const registry = {
      command: stub("command", (i) => (i.prompt === "echo a" ? ok("a", 0.2726) : ok("b", 0.2645))),
    };

    await execute(parseGraph(src), start(src), deps(registry));

    const exceeded = log.read("run1").filter((e) => e.kind === "budget_exceeded");
    expect(exceeded).toHaveLength(1);
    expect(String(exceeded[0]!.data.reason)).toMatch(/maxUsd/);
  });

  it("keeps every completed node result when the final budget check fails", async () => {
    const src = `
name: overshoot-keep
budget: { maxUsd: 0.30, maxWallClockSec: 600, maxNodeRuns: 20 }
nodes:
  a: { type: command, run: "echo a" }
  b: { type: command, run: "echo b" }
edges:
  - { from: a, to: b }
  - { from: b, to: END }
`;
    const registry = {
      command: stub("command", (i) => (i.prompt === "echo a" ? ok("a", 0.2726) : ok("b", 0.2645))),
    };

    const final = await execute(parseGraph(src), start(src), deps(registry));

    expect(final.status).toBe("failed");
    expect(final.nodes.a!.status).toBe("succeeded");
    expect(final.nodes.a!.costUsd).toBe(0.2726);
    expect(final.nodes.b!.status).toBe("succeeded");
    expect(final.nodes.b!.costUsd).toBe(0.2645);
  });

  it("succeeds when the final spend stays under the ceiling", async () => {
    const src = `
name: under
budget: { maxUsd: 0.30, maxWallClockSec: 600, maxNodeRuns: 20 }
nodes:
  a: { type: command, run: "echo a" }
  b: { type: command, run: "echo b" }
edges:
  - { from: a, to: b }
  - { from: b, to: END }
`;
    const registry = {
      command: stub("command", (i) => (i.prompt === "echo a" ? ok("a", 0.2) : ok("b", 0.0999))),
    };

    const final = await execute(parseGraph(src), start(src), deps(registry));

    expect(final.status).toBe("succeeded");
    expect(log.read("run1").filter((e) => e.kind === "budget_exceeded")).toHaveLength(0);
  });

  it("treats a final spend exactly at the usd ceiling as within budget", async () => {
    const src = `
name: exactly
budget: { maxUsd: 0.30, maxWallClockSec: 600, maxNodeRuns: 20 }
nodes:
  a: { type: command, run: "echo a" }
  b: { type: command, run: "echo b" }
edges:
  - { from: a, to: b }
  - { from: b, to: END }
`;
    const registry = {
      command: stub("command", (i) => (i.prompt === "echo a" ? ok("a", 0.15) : ok("b", 0.15))),
    };

    const final = await execute(parseGraph(src), start(src), deps(registry));

    // H3: ceilings are exclusive. Spending exactly maxUsd is permitted.
    expect(final.status).toBe("succeeded");
    expect(log.read("run1").filter((e) => e.kind === "budget_exceeded")).toHaveLength(0);
  });

  it("fails a run whose final spend is a cent over the usd ceiling", async () => {
    const src = `
name: overby
budget: { maxUsd: 0.30, maxWallClockSec: 600, maxNodeRuns: 20 }
nodes:
  a: { type: command, run: "echo a" }
  b: { type: command, run: "echo b" }
edges:
  - { from: a, to: b }
  - { from: b, to: END }
`;
    const registry = {
      command: stub("command", (i) => (i.prompt === "echo a" ? ok("a", 0.15) : ok("b", 0.16))),
    };

    const final = await execute(parseGraph(src), start(src), deps(registry));

    expect(final.status).toBe("failed");
    const exceeded = log.read("run1").filter((e) => e.kind === "budget_exceeded");
    expect(String(exceeded[0]!.data.reason)).toMatch(/maxUsd/);
  });

  it("allows a run whose final node-run count is exactly maxNodeRuns", async () => {
    const src = `
name: runcap
budget: { maxUsd: 10, maxWallClockSec: 600, maxNodeRuns: 2 }
nodes:
  a: { type: command, run: "echo a" }
  b: { type: command, run: "echo b" }
edges:
  - { from: a, to: b }
  - { from: b, to: END }
`;
    const registry = { command: stub("command", (i) => ok(i.prompt)) };

    const final = await execute(parseGraph(src), start(src), deps(registry));

    // H3: ceilings are exclusive, so maxNodeRuns 2 permits exactly 2 runs.
    expect(final.status).toBe("succeeded");
    expect(final.spent.nodeRuns).toBe(2);
    expect(log.read("run1").filter((e) => e.kind === "budget_exceeded")).toHaveLength(0);
  });

  it("permits exactly maxNodeRuns node runs across a chain", async () => {
    const src = `
name: runcap-exact
budget: { maxUsd: 10, maxWallClockSec: 600, maxNodeRuns: 3 }
nodes:
  a: { type: command, run: "echo a" }
  b: { type: command, run: "echo b" }
  c: { type: command, run: "echo c" }
edges:
  - { from: a, to: b }
  - { from: b, to: c }
  - { from: c, to: END }
`;
    const registry = { command: stub("command", (i) => ok(i.prompt)) };

    const final = await execute(parseGraph(src), start(src), deps(registry));

    expect(final.status).toBe("succeeded");
    expect(final.spent.nodeRuns).toBe(3);
    expect(final.nodes.c!.status).toBe("succeeded");
  });

  it("fails a run whose final node-run count exceeds maxNodeRuns", async () => {
    const src = `
name: runcap-over
budget: { maxUsd: 10, maxWallClockSec: 600, maxNodeRuns: 2 }
nodes:
  a: { type: command, run: "echo a" }
  b: { type: command, run: "echo b" }
  c: { type: command, run: "echo c" }
edges:
  - { from: a, to: b }
  - { from: b, to: c }
  - { from: c, to: END }
`;
    const registry = { command: stub("command", (i) => ok(i.prompt)) };

    const final = await execute(parseGraph(src), start(src), deps(registry));

    expect(final.status).toBe("failed");
    const exceeded = log.read("run1").filter((e) => e.kind === "budget_exceeded");
    expect(exceeded).toHaveLength(1);
    expect(String(exceeded[0]!.data.reason)).toMatch(/maxNodeRuns/);
  });

  it("does not emit budget_exceeded when a run fails because a node failed", async () => {
    const src = `
name: nodefail
budget: { maxUsd: 10, maxWallClockSec: 600, maxNodeRuns: 20 }
nodes:
  a: { type: command, run: "echo a" }
  b: { type: command, run: "echo b" }
edges:
  - { from: a, to: b }
  - { from: b, to: END }
`;
    const registry = {
      command: stub("command", (i) => (i.prompt === "echo a" ? ok("a") : bad("boom"))),
    };

    const final = await execute(parseGraph(src), start(src), deps(registry));

    expect(final.status).toBe("failed");
    expect(log.read("run1").filter((e) => e.kind === "budget_exceeded")).toHaveLength(0);
  });

  it("does not emit budget_exceeded when a run pauses on a human node", async () => {
    const src = `
name: pause
budget: { maxUsd: 10, maxWallClockSec: 600, maxNodeRuns: 20 }
nodes:
  a: { type: command, run: "echo a" }
  h: { type: human, question: "Ship it?" }
edges:
  - { from: a, to: h }
  - { from: h, to: END }
`;
    const registry = { command: stub("command", (i) => ok(i.prompt)) };

    const final = await execute(parseGraph(src), start(src), deps(registry));

    expect(final.status).toBe("paused");
    expect(log.read("run1").filter((e) => e.kind === "budget_exceeded")).toHaveLength(0);
  });
});

describe("model passthrough", () => {
  const WITH_MODEL = `
name: m
budget:
  maxUsd: 1
  maxWallClockSec: 60
  maxNodeRuns: 5
nodes:
  a:
    type: agent
    adapter: claude
    prompt: "hi"
    model: "claude-opus-5"
edges:
  - from: a
    to: END
`;

  const WITHOUT_MODEL = `
name: m
budget:
  maxUsd: 1
  maxWallClockSec: 60
  maxNodeRuns: 5
nodes:
  a:
    type: agent
    adapter: claude
    prompt: "hi"
edges:
  - from: a
    to: END
`;

  it("passes a node's model through to the adapter", async () => {
    let seen: AdapterInput | null = null;
    const registry = {
      claude: stub("claude", (input) => {
        seen = input;
        return ok("done");
      }),
    };
    await execute(parseGraph(WITH_MODEL), start(WITH_MODEL), deps(registry));
    expect(seen).not.toBeNull();
    expect(seen!.model).toBe("claude-opus-5");
  });

  it("leaves model undefined on the adapter input when the node declares none", async () => {
    let seen: AdapterInput | null = null;
    const registry = {
      claude: stub("claude", (input) => {
        seen = input;
        return ok("done");
      }),
    };
    await execute(parseGraph(WITHOUT_MODEL), start(WITHOUT_MODEL), deps(registry));
    expect(seen).not.toBeNull();
    expect(seen!.model).toBeUndefined();
  });
});
