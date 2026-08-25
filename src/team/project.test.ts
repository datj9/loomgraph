// Every credential in this file is fabricated: fixed "FAKE"/"fake" filler in
// the shape of the real thing. Nothing here is or ever was a live secret.
//
// Secret-shaped fixtures are assembled from split parts at runtime. A provider's
// secret scanner matches on shape, not validity, so a complete literal in the
// source trips GitHub secret scanning and files an alert against this repo.
// Splitting the prefix from the body keeps the assertion honest without handing
// a detector anything to match.
const shaped = (prefix: string, body: string): string => prefix + body;

import { describe, expect, it } from "vitest";
import type { NodeResult, RunState } from "../core/types.js";
import { eventBatchSchema, type EventBatch } from "../hub/wire.js";
import { projectState } from "./project.js";

const OPTS = { home: "/home/alice", username: "alice", repoRoot: "/home/alice/work/repo" };

function baseState(): RunState {
  return {
    runId: "run-1",
    streamId: "11111111-2222-3333-4444-555555555555",
    graphName: "g",
    status: "running",
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:01.000Z",
    cwd: "/home/alice/work/repo",
    vars: {},
    budget: { maxUsd: 1, maxWallClockSec: 60, maxNodeRuns: 10 },
    spent: { usd: 0, wallClockSec: 0, nodeRuns: 0 },
    nodes: {},
    completed: [],
    seq: 1,
  };
}

function node(
  nodeId: string,
  status: NodeResult["status"],
  overrides: Partial<NodeResult> = {},
): NodeResult {
  const terminal = status === "succeeded" || status === "failed" || status === "skipped";
  return {
    nodeId,
    status,
    startedAt: "2026-08-25T00:00:02.000Z",
    endedAt: terminal ? "2026-08-25T00:00:03.000Z" : null,
    attempts: 1,
    output: null,
    error: null,
    costUsd: 0,
    ...overrides,
  };
}

describe("projectState", () => {
  it("the whole serialized projection contains neither a vars value nor a node output", () => {
    const varsSecret = shaped("sk-ant-", "api03-VARSSECRET000000FAKEfake0000");
    const outputSecret = shaped("ghp", "_OUTPUTSECRET0000FAKEfake0000");
    const state = baseState();
    state.vars = { ticketId: "PLAT-4711", apiToken: varsSecret };
    state.nodes.a = node("a", "succeeded", { output: `pushed ${outputSecret}` });

    const projected = projectState(state, OPTS);
    const serialized = JSON.stringify(projected);

    expect(serialized).not.toContain(varsSecret);
    expect(serialized).not.toContain(outputSecret);
    expect(serialized).toContain("apiToken");
    expect(serialized).toContain("ticketId");
  });

  it("a vars value containing a shaped secret is absent while its key survives", () => {
    const secret = shaped("AIza", "FAKESECRET0000FAKEfake0000FAKEfake0000");
    const state = baseState();
    state.vars = { deployToken: secret };

    const projected = projectState(state, OPTS);
    const serialized = JSON.stringify(projected);

    expect(serialized).not.toContain(secret);
    expect(projected.varKeys).toContain("deployToken");
  });

  it("a node output containing a shaped secret is absent", () => {
    const secret = shaped("github", "_pat_11FAKEfake0000FAKEfake0000");
    const state = baseState();
    state.nodes.a = node("a", "failed", { output: `stdout:\n${secret}` });

    const projected = projectState(state, OPTS);
    const serialized = JSON.stringify(projected);

    expect(serialized).not.toContain(secret);
  });

  it("costUsd, status and attempts survive on each projected node", () => {
    const state = baseState();
    state.nodes.a = node("a", "failed", { attempts: 3, costUsd: 1.25, error: "boom" });
    state.nodes.b = node("b", "running", { attempts: 2, costUsd: 0.5 });

    const projected = projectState(state, OPTS);

    expect(projected.nodes.a).toEqual({
      nodeId: "a",
      status: "failed",
      startedAt: "2026-08-25T00:00:02.000Z",
      endedAt: "2026-08-25T00:00:03.000Z",
      attempts: 3,
      error: "boom",
      costUsd: 1.25,
    });
    expect(projected.nodes.b!.status).toBe("running");
    expect(projected.nodes.b!.attempts).toBe(2);
    expect(projected.nodes.b!.costUsd).toBe(0.5);
  });

  it("startedAt, endedAt and error survive the node projection", () => {
    const state = baseState();
    state.nodes.a = node("a", "succeeded", {
      startedAt: "2026-08-25T01:00:00.000Z",
      endedAt: "2026-08-25T01:02:00.000Z",
      error: "retried once, then passed",
    });

    const projected = projectState(state, OPTS);

    expect(projected.nodes.a!.startedAt).toBe("2026-08-25T01:00:00.000Z");
    expect(projected.nodes.a!.endedAt).toBe("2026-08-25T01:02:00.000Z");
    expect(projected.nodes.a!.error).toBe("retried once, then passed");
  });

  it("rewrites a cwd at the repo root to the repoRoot placeholder", () => {
    const state = baseState();
    state.cwd = "/home/alice/work/repo";

    const projected = projectState(state, OPTS);

    expect(projected.cwd).toBe("${REPO_ROOT}");
  });

  it("rewrites a cwd under home but outside the repo to the home placeholder", () => {
    const state = baseState();
    state.cwd = "/home/alice/downloads";

    const projected = projectState(state, OPTS);

    expect(projected.cwd).toBe("${HOME}/downloads");
  });

  it("rewrites a username-shaped path, proving username is threaded through", () => {
    const state = baseState();
    state.cwd = "/Users/alice/notes.md";

    const projected = projectState(state, OPTS);

    expect(projected.cwd).toBe("${HOME}/notes.md");
  });

  it("rewrites a standalone username token only at path boundaries", () => {
    const state = baseState();
    state.cwd = "alice/config/main.yaml";

    const projected = projectState(state, OPTS);

    expect(projected.cwd).toBe("user/config/main.yaml");
  });

  it("varKeys equals the vars keys exactly, including order", () => {
    const state = baseState();
    state.vars = {
      zeta: 1,
      alpha: "x",
      token: shaped("sk-", "Fakevalue0000"),
    };

    const projected = projectState(state, OPTS);

    expect(projected.varKeys).toEqual(["zeta", "alpha", "token"]);
    expect("vars" in projected).toBe(false);
  });

  it("empty vars gives an empty varKeys", () => {
    const projected = projectState(baseState(), OPTS);
    expect(projected.varKeys).toEqual([]);
  });

  it("the projection carries no streamId - EventBatch owns it at top level", () => {
    const projected = projectState(baseState(), OPTS);
    expect("streamId" in projected).toBe(false);
  });

  it("no projected node has an output property", () => {
    const state = baseState();
    state.nodes.a = node("a", "succeeded", { output: "irrelevant" });
    state.nodes.b = node("b", "running", { output: shaped("glpat", "Z-0000-not-real") });

    const projected = projectState(state, OPTS);

    for (const n of Object.values(projected.nodes)) {
      expect("output" in n).toBe(false);
    }
  });

  it("classifies every RunState key before anything leaves the machine", () => {
    // Adding a field to `RunState` fails typecheck here until someone classifies it:
    // `Record<keyof RunState, "projected" | "dropped">` is exhaustive by construction.
    // A classified "dropped" field appearing on the projection fails at runtime, and a
    // "projected" field going missing fails the key-set equality below. This is plan
    // §1.10's "a future field must be explicitly classified before it can be pushed".
    const classification: Record<keyof RunState, "projected" | "dropped"> = {
      runId: "projected",
      streamId: "dropped", // carried on EventBatch, never on ProjectedState
      graphName: "projected",
      status: "projected",
      createdAt: "projected",
      updatedAt: "projected",
      cwd: "projected",
      vars: "dropped", // the values are secrets; only key names survive as varKeys
      budget: "projected",
      spent: "projected",
      nodes: "projected", // per-node output is dropped inside the projection
      completed: "projected",
      seq: "projected",
    };

    const state = baseState();
    state.vars = { a: 1, b: 2 };
    state.nodes.c = node("c", "succeeded");
    const projection = projectState(state, OPTS);

    const expected = new Set([
      ...Object.entries(classification)
        .filter(([, kind]) => kind === "projected")
        .map(([key]) => key),
      // derived from the dropped `vars` field - the only derived key there is
      "varKeys",
    ]);
    expect(new Set(Object.keys(projection))).toEqual(expected);
  });

  it("round-trips through eventBatchSchema inside a valid EventBatch", () => {
    const state = baseState();
    state.nodes.a = node("a", "succeeded", { costUsd: 0.5 });
    state.completed = ["a"];
    state.status = "succeeded";

    const projected = projectState(state, OPTS);
    const batch: EventBatch = {
      runId: projected.runId,
      streamId: state.streamId,
      graphName: projected.graphName,
      state: projected,
      events: [],
    };

    const parsed = eventBatchSchema.safeParse(batch);
    expect(parsed.success).toBe(true);
  });

  it("a shaped secret planted in a node error is absent while the message survives", () => {
    const secret = shaped("sk-ant-", "api03-0000VERYFAKE0000VERYFAKE0000");
    const state = baseState();
    state.nodes.a = node("a", "failed", { error: `could not reach the agent: ${secret}` });

    const projected = projectState(state, OPTS);
    const serialized = JSON.stringify(projected);

    expect(serialized).not.toContain(secret);
    expect(serialized).toContain("could not reach the agent");
  });

  it("a masked secret appears as the first 4 characters of the match followed by ...", () => {
    const secret = shaped("sk-ant-", "api03-0000VERYFAKE0000VERYFAKE0000");
    const state = baseState();
    state.nodes.a = node("a", "failed", { error: `could not reach the agent: ${secret}` });

    const projected = projectState(state, OPTS);

    expect(projected.nodes.a!.error).toContain("sk-a...");
    expect(projected.nodes.a!.error).not.toContain("api03");
  });

  it("an absolute home path in a node error is rewritten to the HOME placeholder", () => {
    const state = baseState();
    state.nodes.a = node("a", "failed", {
      error: "missing /home/alice/.config/loomgraph/hub.json",
    });

    const projected = projectState(state, OPTS);

    expect(projected.nodes.a!.error).toBe("missing ${HOME}/.config/loomgraph/hub.json");
  });

  it("a repo-root path in a node error is rewritten to the REPO_ROOT placeholder", () => {
    const state = baseState();
    state.nodes.a = node("a", "failed", {
      error: "script at /home/alice/work/repo/scripts/deploy.sh blew up",
    });

    const projected = projectState(state, OPTS);

    expect(projected.nodes.a!.error).toBe("script at ${REPO_ROOT}/scripts/deploy.sh blew up");
  });

  it("a node error longer than 200 characters is truncated to 200 plus a single ellipsis", () => {
    const state = baseState();
    state.nodes.a = node("a", "failed", {
      error: `node failed after exhaustive retries: ${"retry-".repeat(50)}`,
    });

    const projected = projectState(state, OPTS);

    expect(projected.nodes.a!.error!.length).toBeLessThanOrEqual(201);
    expect(projected.nodes.a!.error!.endsWith("…")).toBe(true);
    expect(projected.nodes.a!.error!.startsWith("node failed after exhaustive retries")).toBe(true);
  });

  it("a null node error stays exactly null - never an empty string", () => {
    const state = baseState();
    state.nodes.a = node("a", "failed", { error: null });

    const projected = projectState(state, OPTS);
    const serialized = JSON.stringify(projected);

    expect(projected.nodes.a!.error).toBeNull();
    expect(serialized).toContain('"error":null');
    expect(serialized).not.toContain('"error":""');
  });

  it("a command-shaped error carrying a path and a secret comes out with both sanitised", () => {
    const secret = shaped("sk-ant-", "api03-0000VERYFAKE0000VERYFAKE0000");
    const state = baseState();
    state.nodes.a = node("a", "failed", {
      error: `command exited with code 1: /home/alice/work/repo/run.sh: error: token ${secret} rejected`,
    });

    const projected = projectState(state, OPTS);

    expect(projected.nodes.a!.error).toContain("${REPO_ROOT}/run.sh");
    expect(projected.nodes.a!.error).toContain("token sk-a... rejected");
    expect(projected.nodes.a!.error).not.toContain(secret);
    expect(projected.nodes.a!.error).not.toContain("/home/alice");
  });

  it("a short node error with no secret or path passes through unchanged", () => {
    const state = baseState();
    state.nodes.a = node("a", "failed", { error: "boom" });

    const projected = projectState(state, OPTS);

    expect(projected.nodes.a!.error).toBe("boom");
  });

  it("a projection with a masked error still passes eventBatchSchema", () => {
    const secret = shaped("sk-ant-", "api03-0000VERYFAKE0000VERYFAKE0000");
    const state = baseState();
    state.nodes.a = node("a", "failed", { error: `could not reach the agent: ${secret}` });

    const projected = projectState(state, OPTS);
    const batch: EventBatch = {
      runId: projected.runId,
      streamId: state.streamId,
      graphName: projected.graphName,
      state: projected,
      events: [],
    };

    const parsed = eventBatchSchema.safeParse(batch);
    expect(parsed.success).toBe(true);
  });
});