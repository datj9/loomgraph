import { describe, it, expect } from "vitest";
import { parseGraph, GraphCycleError, GraphValidationError } from "./graph.js";

const FULL_EXAMPLE = `
name: fix-failing-test
budget:
  maxUsd: 2.00
  maxWallClockSec: 1800
  maxNodeRuns: 20

vars:
  ticket: ""

nodes:
  reproduce:
    type: agent
    adapter: claude
    prompt: "Reproduce the failure described in: {{vars.ticket}}. Do not fix it."
    maxTurns: 8

  fix:
    type: agent
    adapter: claude
    prompt: "Fix the failure. Repro notes: {{nodes.reproduce.output}}"
    maxTurns: 20

  test:
    type: command
    run: "npm test"

  lint:
    type: command
    run: "npm run lint"

  review:
    type: verifier
    adapter: codex
    prompt: "Review the diff. Reply PASS or FAIL."
    pass: "PASS"

edges:
  - from: reproduce
    to: fix
  - from: fix
    to: [test, lint]
  - from: [test, lint]
    to: review
    when: "all_succeeded"
  - from: review
    to: END
`;

function graph(body: string): string {
  return `name: g\nbudget:\n  maxUsd: 1\n  maxWallClockSec: 60\n  maxNodeRuns: 5\n${body}`;
}

describe("parseGraph", () => {
  it("parses the full fix-failing-test example", () => {
    const g = parseGraph(FULL_EXAMPLE);
    expect(g.name).toBe("fix-failing-test");
    expect(g.budget).toEqual({ maxUsd: 2, maxWallClockSec: 1800, maxNodeRuns: 20 });
    expect(g.vars).toEqual({ ticket: "" });
    expect(Object.keys(g.nodes).sort()).toEqual(["fix", "lint", "reproduce", "review", "test"]);
    expect(g.nodes.review).toMatchObject({ type: "verifier", adapter: "codex", pass: "PASS" });
    expect(g.edges).toHaveLength(4);
    // from/to are normalised to arrays
    expect(g.edges[1]).toMatchObject({ from: ["fix"], to: ["test", "lint"] });
    expect(g.edges[2]).toMatchObject({ from: ["test", "lint"], to: ["review"], when: "all_succeeded" });
  });

  it("rejects an edge referencing an unknown node id", () => {
    const src = graph(`nodes:
  a:
    type: command
    run: "true"
edges:
  - from: a
    to: ghost
`);
    expect(() => parseGraph(src)).toThrow(/ghost/);
  });

  it("accepts END as an edge target without declaring it as a node", () => {
    const src = graph(`nodes:
  a:
    type: command
    run: "true"
edges:
  - from: a
    to: END
`);
    expect(parseGraph(src).edges[0]!.to).toEqual(["END"]);
  });

  it("rejects a graph with more than one entry node", () => {
    const src = graph(`nodes:
  a:
    type: command
    run: "true"
  b:
    type: command
    run: "true"
  c:
    type: command
    run: "true"
edges:
  - from: a
    to: c
  - from: b
    to: c
`);
    expect(() => parseGraph(src)).toThrow(/entry node/i);
  });

  it("rejects a graph with no entry node", () => {
    const src = graph(`nodes:
  a:
    type: command
    run: "true"
  b:
    type: command
    run: "true"
edges:
  - from: a
    to: b
  - from: b
    to: a
`);
    expect(() => parseGraph(src)).toThrow(GraphValidationError);
  });

  it("detects a cycle and names the cycle path", () => {
    const src = graph(`nodes:
  a:
    type: command
    run: "true"
  b:
    type: command
    run: "true"
  c:
    type: command
    run: "true"
edges:
  - from: a
    to: b
  - from: b
    to: c
  - from: c
    to: b
`);
    expect(() => parseGraph(src)).toThrow(GraphCycleError);
    expect(() => parseGraph(src)).toThrow(/b -> c -> b/);
  });

  it("requires a budget", () => {
    const src = `name: g
nodes:
  a:
    type: command
    run: "true"
edges:
  - from: a
    to: END
`;
    expect(() => parseGraph(src)).toThrow(/budget/i);
  });

  it("rejects a budget field that is not greater than zero", () => {
    const src = `name: g
budget:
  maxUsd: 0
  maxWallClockSec: 60
  maxNodeRuns: 5
nodes:
  a:
    type: command
    run: "true"
edges:
  - from: a
    to: END
`;
    expect(() => parseGraph(src)).toThrow(/maxUsd/);
  });

  it("rejects an agent node with an unknown adapter", () => {
    const src = graph(`nodes:
  a:
    type: agent
    adapter: gpt9
    prompt: "hi"
edges:
  - from: a
    to: END
`);
    expect(() => parseGraph(src)).toThrow(/a/);
    expect(() => parseGraph(src)).toThrow(/claude/);
  });

  it("rejects an agent node with an empty prompt", () => {
    const src = graph(`nodes:
  a:
    type: agent
    adapter: claude
    prompt: ""
edges:
  - from: a
    to: END
`);
    expect(() => parseGraph(src)).toThrow(/prompt/);
  });

  it("rejects a verifier node without a pass string", () => {
    const src = graph(`nodes:
  a:
    type: verifier
    adapter: codex
    prompt: "check"
edges:
  - from: a
    to: END
`);
    expect(() => parseGraph(src)).toThrow(/pass/);
  });

  it("rejects a command node without run", () => {
    const src = graph(`nodes:
  a:
    type: command
edges:
  - from: a
    to: END
`);
    expect(() => parseGraph(src)).toThrow(/run/);
  });

  it("accepts a command node with expect and expectNonEmpty", () => {
    const src = graph(`nodes:
  a:
    type: command
    run: "npm test"
    expect: "0 failed"
    expectNonEmpty: true
edges:
  - from: a
    to: END
`);
    expect(parseGraph(src).nodes.a).toMatchObject({
      type: "command",
      run: "npm test",
      expect: "0 failed",
      expectNonEmpty: true,
    });
  });

  it("rejects a command node whose expect is an empty string", () => {
    const src = graph(`nodes:
  a:
    type: command
    run: "npm test"
    expect: ""
edges:
  - from: a
    to: END
`);
    expect(() => parseGraph(src)).toThrow(/node "a"/);
  });

  it("rejects a human node without a question", () => {
    const src = graph(`nodes:
  a:
    type: human
edges:
  - from: a
    to: END
`);
    expect(() => parseGraph(src)).toThrow(/question/);
  });

  it("rejects an unknown node type and lists the valid types", () => {
    const src = graph(`nodes:
  a:
    type: wizard
edges:
  - from: a
    to: END
`);
    expect(() => parseGraph(src)).toThrow(/wizard/);
    expect(() => parseGraph(src)).toThrow(/agent, command, verifier, human/);
  });

  it("rejects an unknown edge predicate", () => {
    const src = graph(`nodes:
  a:
    type: command
    run: "true"
  b:
    type: command
    run: "true"
edges:
  - from: a
    to: b
    when: "when_the_stars_align"
`);
    expect(() => parseGraph(src)).toThrow(/when_the_stars_align/);
  });

  it("rejects END used as an edge source", () => {
    const src = graph(`nodes:
  a:
    type: command
    run: "true"
edges:
  - from: a
    to: END
  - from: END
    to: a
`);
    expect(() => parseGraph(src)).toThrow(/END/);
  });
});
