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

  it("accepts an agent node with an explicit model", () => {
    const src = graph(`nodes:
  a:
    type: agent
    adapter: opencode
    prompt: "hi"
    model: "opencode-go/deepseek-v4-flash"
edges:
  - from: a
    to: END
`);
    const parsed = parseGraph(src);
    const node = parsed.nodes["a"];
    expect(node?.type).toBe("agent");
    if (node?.type === "agent") expect(node.model).toBe("opencode-go/deepseek-v4-flash");
  });

  it("accepts a verifier node with an explicit model", () => {
    const src = graph(`nodes:
  a:
    type: verifier
    adapter: codex
    prompt: "hi"
    pass: "PASS"
    model: "gpt-5.6-sol"
edges:
  - from: a
    to: END
`);
    const node = parseGraph(src).nodes["a"];
    if (node?.type === "verifier") expect(node.model).toBe("gpt-5.6-sol");
    else throw new Error("expected a verifier node");
  });

  it("leaves model undefined when a node does not declare one", () => {
    const node = parseGraph(FULL_EXAMPLE).nodes["reproduce"];
    if (node?.type === "agent") expect(node.model).toBeUndefined();
    else throw new Error("expected an agent node");
  });

  it("rejects an agent node whose model is an empty string", () => {
    const src = graph(`nodes:
  a:
    type: agent
    adapter: claude
    prompt: "hi"
    model: ""
edges:
  - from: a
    to: END
`);
    expect(() => parseGraph(src)).toThrow(/a/);
  });

  it("rejects a command node that declares a model", () => {
    const src = graph(`nodes:
  a:
    type: command
    run: "echo hi"
    model: "claude-opus-5"
edges:
  - from: a
    to: END
`);
    expect(() => parseGraph(src)).toThrow(/a/);
    expect(() => parseGraph(src)).toThrow(/model/);
  });

  it("rejects a command node that declares an adapter", () => {
    const src = graph(`nodes:
  a:
    type: command
    run: "echo hi"
    adapter: claude
edges:
  - from: a
    to: END
`);
    expect(() => parseGraph(src)).toThrow(/a/);
    expect(() => parseGraph(src)).toThrow(/adapter/);
  });

  it("rejects a human node that declares an adapter", () => {
    const src = graph(`nodes:
  a:
    type: human
    question: "ok?"
    adapter: claude
edges:
  - from: a
    to: END
`);
    expect(() => parseGraph(src)).toThrow(/a/);
    expect(() => parseGraph(src)).toThrow(/adapter/);
  });

  it("accepts an agent node with an explicit adapter", () => {
    const src = graph(`nodes:
  a:
    type: agent
    adapter: claude
    prompt: "hi"
edges:
  - from: a
    to: END
`);
    const parsed = parseGraph(src);
    const node = parsed.nodes["a"];
    expect(node?.type).toBe("agent");
    if (node?.type === "agent") expect(node.adapter).toBe("claude");
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

  it("accepts a node id containing a hyphen", () => {
    const src = graph(`nodes:
  my-node:
    type: command
    run: "true"
edges:
  - from: my-node
    to: END
`);
    expect(parseGraph(src).nodes["my-node"]).toMatchObject({ type: "command", run: "true" });
  });

  it("rejects a node id containing a dot", () => {
    const src = graph(`nodes:
  "my.node":
    type: command
    run: "true"
edges:
  - from: "my.node"
    to: END
`);
    expect(() => parseGraph(src)).toThrow(/my\.node/);
  });

  it("rejects a node id containing a space", () => {
    const src = graph(`nodes:
  "my node":
    type: command
    run: "true"
edges:
  - from: "my node"
    to: END
`);
    expect(() => parseGraph(src)).toThrow(/must match/);
  });

  it("rejects a node id longer than 64 characters", () => {
    const long = "a".repeat(65);
    const src = graph(`nodes:
  ${long}:
    type: command
    run: "true"
edges:
  - from: ${long}
    to: END
`);
    expect(() => parseGraph(src)).toThrow(/must match/);
  });

  it("rejects a node id containing a path separator", () => {
    const src = graph(`nodes:
  "../escape":
    type: command
    run: "true"
edges:
  - from: "../escape"
    to: END
`);
    expect(() => parseGraph(src)).toThrow(/must match/);
  });

  it("still reports END as reserved rather than as a bad character", () => {
    const src = graph(`nodes:
  END:
    type: command
    run: "true"
edges:
  - from: END
    to: END
`);
    expect(() => parseGraph(src)).toThrow(/reserved/);
  });
});

describe("template references", () => {
  it("accepts declared bare, dotted and node-output references", () => {
    const src = graph(`vars:
  ticket: ABC-1
nodes:
  a:
    type: command
    run: "echo {{ticket}} {{vars.ticket}}"
  b:
    type: agent
    adapter: claude
    prompt: "Use {{nodes.a.output}}"
edges:
  - from: a
    to: b
  - from: b
    to: END
`);
    expect(parseGraph(src).nodes.a).toMatchObject({ type: "command" });
    expect(parseGraph(src).nodes.b).toMatchObject({ type: "agent" });
  });

  it("rejects a reference to an undeclared node, naming node and reference", () => {
    const src = graph(`vars:
  ticket: ABC-1
nodes:
  a:
    type: command
    run: "echo {{ticket}}"
  b:
    type: command
    run: "echo {{nodes.nope.output}}"
edges:
  - from: a
    to: b
  - from: b
    to: END
`);
    expect(() => parseGraph(src)).toThrow(GraphValidationError);
    expect(() => parseGraph(src)).toThrow(/node "b"/);
    expect(() => parseGraph(src)).toThrow(/nodes\.nope\.output/);
  });

  it("accepts a dotted var reference to an undeclared var (--var supplies it at runtime)", () => {
    const src = graph(`nodes:
  a:
    type: command
    run: "echo {{vars.nosuchvar}}"
edges:
  - from: a
    to: END
`);
    expect(parseGraph(src).nodes.a).toMatchObject({ type: "command", run: "echo {{vars.nosuchvar}}" });
  });

  it("accepts a bare reference that is not a declared var (--var supplies it at runtime)", () => {
    const src = graph(`nodes:
  a:
    type: command
    run: "echo {{nosuchvar}}"
edges:
  - from: a
    to: END
`);
    expect(parseGraph(src).nodes.a).toMatchObject({ type: "command", run: "echo {{nosuchvar}}" });
  });

  it("rejects a reference shape the runtime resolver would reject", () => {
    const src = graph(`nodes:
  a:
    type: command
    run: "echo {{vars.ticket.extra}}"
edges:
  - from: a
    to: END
`);
    expect(() => parseGraph(src)).toThrow(/vars\.ticket\.extra/);
  });

  it("validates verifier prompts too", () => {
    const src = graph(`nodes:
  a:
    type: verifier
    adapter: codex
    prompt: "Check {{nodes.ghost.output}}"
    pass: "PASS"
edges:
  - from: a
    to: END
`);
    expect(() => parseGraph(src)).toThrow(/node "a"/);
    expect(() => parseGraph(src)).toThrow(/ghost/);
  });

  it("rejects an inherited Object.prototype key as a node-output reference", () => {
    // CORE-3: `in` walks the prototype chain, so `constructor`, `toString`,
    // `valueOf` and `__proto__` used to pass load-time validation and then
    // throw TemplateError mid-run - exactly what this pass exists to prevent.
    for (const ghost of ["constructor", "toString", "valueOf", "__proto__", "hasOwnProperty"]) {
      const src = graph(`nodes:
  a:
    type: command
    run: "echo {{nodes.${ghost}.output}}"
edges:
  - from: a
    to: END
`);
      expect(() => parseGraph(src)).toThrow(GraphValidationError);
      expect(() => parseGraph(src)).toThrow(new RegExp(`nodes\\.${ghost.replace("__", "__")}\\.output`));
    }
  });

  it("validates a human node's question, which the engine interpolates too", () => {
    // CORE-4: the question is interpolated at run time, so an unknown
    // reference in it must fail at load time, not after the upstream agent
    // nodes have already burned real spend.
    const src = graph(`nodes:
  a:
    type: command
    run: "echo a"
  approve:
    type: human
    question: "Approve {{nodes.reviw.output}}?"
edges:
  - from: a
    to: approve
  - from: approve
    to: END
`);
    expect(() => parseGraph(src)).toThrow(GraphValidationError);
    expect(() => parseGraph(src)).toThrow(/node "approve"/);
    expect(() => parseGraph(src)).toThrow(/reviw/);
  });

  it("accepts a human question that references a declared node", () => {
    const src = graph(`nodes:
  a:
    type: command
    run: "echo a"
  approve:
    type: human
    question: "Approve {{nodes.a.output}} for {{vars.ticket}}?"
edges:
  - from: a
    to: approve
  - from: approve
    to: END
`);
    expect(parseGraph(src).nodes.approve).toMatchObject({ type: "human" });
  });
});
