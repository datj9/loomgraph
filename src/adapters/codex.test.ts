import { describe, it, expect } from "vitest";
import { buildCodexArgs, parseCodexJsonl } from "./codex.js";

const EVENTS = [
  `{"id":"0","msg":{"type":"task_started"}}`,
  `{"id":"1","msg":{"type":"agent_message","message":"first pass"}}`,
  `{"id":"2","msg":{"type":"agent_message","message":"final answer"}}`,
  `{"id":"3","msg":{"type":"task_complete"}}`,
].join("\n");

describe("buildCodexArgs", () => {
  it("builds the verified non-interactive argv", () => {
    expect(buildCodexArgs("review the diff", "/repo")).toEqual([
      "exec",
      "review the diff",
      "--json",
      "--skip-git-repo-check",
      "-C",
      "/repo",
    ]);
  });
});

describe("parseCodexJsonl", () => {
  it("takes the last agent message as the output text", () => {
    const out = parseCodexJsonl(EVENTS);
    expect(out.ok).toBe(true);
    expect(out.text).toBe("final answer");
    expect(out.error).toBeNull();
  });

  it("ignores unparseable lines instead of throwing", () => {
    const out = parseCodexJsonl(`garbage\n${EVENTS}\nalso not json`);
    expect(out.ok).toBe(true);
    expect(out.text).toBe("final answer");
  });

  it("understands the item-shaped event form", () => {
    const out = parseCodexJsonl(`{"type":"item.completed","item":{"type":"agent_message","text":"hello"}}`);
    expect(out.ok).toBe(true);
    expect(out.text).toBe("hello");
  });

  it("fails when no agent message event is present", () => {
    const out = parseCodexJsonl(`{"id":"0","msg":{"type":"task_started"}}`);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/no agent message/i);
  });

  it("records zero cost when no usd field is reported", () => {
    // Codex does not report a price for the run - never invent one.
    expect(parseCodexJsonl(EVENTS).costUsd).toBe(0);
  });

  it("records a reported cumulative cost verbatim", () => {
    const src = `{"msg":{"type":"agent_message","message":"x"}}\n{"msg":{"type":"token_count","total_cost_usd":0.25}}`;
    expect(parseCodexJsonl(src).costUsd).toBe(0.25);
  });

  it("sums incremental cost_usd deltas when no cumulative total is reported", () => {
    const src = `{"msg":{"type":"agent_message","message":"x","cost_usd":0.1}}\n{"msg":{"type":"turn","cost_usd":0.2}}`;
    expect(parseCodexJsonl(src).costUsd).toBeCloseTo(0.3, 10);
  });

  it("keeps all parsed events as raw", () => {
    const out = parseCodexJsonl(EVENTS);
    expect(Array.isArray(out.raw)).toBe(true);
    expect((out.raw as unknown[]).length).toBe(4);
  });
});
