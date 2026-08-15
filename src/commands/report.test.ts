import { describe, it, expect } from "vitest";
import { escapeHtml, renderReportHtml } from "./render.js";
import type { LgEvent } from "../core/events.js";
import type { RunState } from "../core/types.js";

function makeState(overrides: Partial<RunState> = {}): RunState {
  return {
    runId: "demo-20260814-120000-ab12",
    graphName: "demo",
    status: "succeeded",
    createdAt: "2026-08-14T12:00:00.000Z",
    updatedAt: "2026-08-14T12:01:00.000Z",
    cwd: "/repo",
    vars: { ticket: "LG-1" },
    budget: { maxUsd: 2, maxWallClockSec: 1800, maxNodeRuns: 20 },
    spent: { usd: 0.25, wallClockSec: 60, nodeRuns: 2 },
    nodes: {
      greet: {
        nodeId: "greet", status: "succeeded",
        startedAt: "2026-08-14T12:00:00.000Z", endedAt: "2026-08-14T12:00:30.000Z",
        attempts: 1, output: "hello", error: null, costUsd: 0,
      },
    },
    completed: ["greet"],
    seq: 2,
    ...overrides,
  };
}

const noEvents: LgEvent[] = [];

describe("escapeHtml", () => {
  it("escapes ampersands, angle brackets and quotes", () => {
    expect(escapeHtml("a < b")).toBe("a &lt; b");
    expect(escapeHtml("</script>")).toBe("&lt;/script&gt;");
    expect(escapeHtml("Tom & \"Jerry\"")).toBe("Tom &amp; &quot;Jerry&quot;");
  });

  it("returns an empty string unchanged", () => {
    expect(escapeHtml("")).toBe("");
  });
});

describe("renderReportHtml", () => {
  it("renders a complete html document for a run", () => {
    const out = renderReportHtml(makeState(), noEvents);
    expect(out.startsWith("<!doctype html>")).toBe(true);
    expect(out).toContain("greet");
    expect(out).toContain("0.0000");
  });

  it("escapes a hostile graph name so no raw tag reaches the document", () => {
    const out = renderReportHtml(makeState({ graphName: "<img src=x onerror=alert(1)>" }), noEvents);
    expect(out).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(out).not.toContain("<img ");
  });

  it("escapes a node error string", () => {
    const state = makeState({
      nodes: {
        greet: {
          nodeId: "greet", status: "failed",
          startedAt: "2026-08-14T12:00:00.000Z", endedAt: "2026-08-14T12:00:30.000Z",
          attempts: 1, output: "", error: "boom </td>", costUsd: 0,
        },
      },
    });
    expect(renderReportHtml(state, noEvents)).toContain("boom &lt;/td&gt;");
  });

  it("renders the budget line and the cost note", () => {
    const out = renderReportHtml(makeState(), noEvents);
    expect(out).toContain("0.2500/2.0000 usd · 60s/1800s wall clock · 2/20 node runs");
    expect(out).toContain(
      "note: adapters that do not report a price (codex, opencode, command) record 0.0000 usd - the number is not estimated.",
    );
  });

  it("is deterministic for identical inputs", () => {
    const state = makeState();
    expect(renderReportHtml(state, noEvents)).toBe(renderReportHtml(state, noEvents));
  });

  it("renders a run with no nodes and no events", () => {
    const out = renderReportHtml(makeState({ nodes: {}, completed: [], status: "pending" }), noEvents);
    expect(out.startsWith("<!doctype html>")).toBe(true);
    expect(out).toContain(
      "note: adapters that do not report a price (codex, opencode, command) record 0.0000 usd - the number is not estimated.",
    );
  });

  it("embeds no external resource", () => {
    const out = renderReportHtml(makeState(), noEvents);
    expect(out).not.toContain("<link ");
    expect(out).not.toContain('src="http');
    expect(out).not.toContain("url(http");
  });

  it("renders one row per event", () => {
    const events: LgEvent[] = [
      { ts: "2026-08-14T12:00:00.000Z", runId: "demo-20260814-120000-ab12", seq: 0, kind: "node_started", nodeId: "greet", data: {} },
      { ts: "2026-08-14T12:00:30.000Z", runId: "demo-20260814-120000-ab12", seq: 1, kind: "node_finished", nodeId: "greet", data: { ok: true } },
      { ts: "2026-08-14T12:01:00.000Z", runId: "demo-20260814-120000-ab12", seq: 2, kind: "run_finished", data: {} },
    ];
    const out = renderReportHtml(makeState(), events);
    expect(out).toContain("node_started");
    expect(out).toContain("node_finished");
    expect(out).toContain("run_finished");
  });
});
