import { describe, it, expect } from "vitest";
import { buildClaudeArgs, parseClaudeJson } from "./claude.js";

const SUCCESS = `{"type":"result","subtype":"success","result":"done","session_id":"abc","num_turns":3,"total_cost_usd":0.0787}`;
const MAX_TURNS = `{"type":"result","subtype":"error_max_turns","result":"","total_cost_usd":0.5}`;
// Captured verbatim from Claude Code 2.1.232 with an expired OAuth session.
// Note `subtype` is "success" while `is_error` is true - trusting subtype alone
// makes an auth failure look like a completed agent run.
const AUTH_FAILURE = `{"type":"result","subtype":"success","is_error":true,"result":"Failed to authenticate: OAuth session expired and could not be refreshed","terminal_reason":"api_error","total_cost_usd":0,"num_turns":1}`;

describe("buildClaudeArgs", () => {
  it("builds the verified non-interactive argv", () => {
    expect(buildClaudeArgs("do the thing", 8)).toEqual([
      "-p",
      "do the thing",
      "--output-format",
      "json",
      "--permission-mode",
      "acceptEdits",
      "--max-turns",
      "8",
    ]);
  });

  it("omits --max-turns when no turn limit is given", () => {
    expect(buildClaudeArgs("hi")).toEqual([
      "-p",
      "hi",
      "--output-format",
      "json",
      "--permission-mode",
      "acceptEdits",
    ]);
  });
});

describe("parseClaudeJson", () => {
  it("extracts text and cost from a success result", () => {
    const out = parseClaudeJson(SUCCESS);
    expect(out.ok).toBe(true);
    expect(out.text).toBe("done");
    expect(out.costUsd).toBe(0.0787);
    expect(out.error).toBeNull();
  });

  it("reports max-turns failure but still records the cost", () => {
    const out = parseClaudeJson(MAX_TURNS);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/max_turns/);
    expect(out.costUsd).toBe(0.5);
  });

  it("reports a parse failure for garbage stdout", () => {
    const out = parseClaudeJson("not json at all");
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/parse/i);
    expect(out.costUsd).toBe(0);
  });

  it("records zero cost when the result carries no cost field", () => {
    const out = parseClaudeJson(`{"type":"result","subtype":"success","result":"ok"}`);
    expect(out.ok).toBe(true);
    expect(out.costUsd).toBe(0);
  });

  it("keeps the parsed object as raw", () => {
    const out = parseClaudeJson(SUCCESS);
    expect((out.raw as { session_id: string }).session_id).toBe("abc");
  });

  it("fails when is_error is true even though subtype says success", () => {
    const out = parseClaudeJson(AUTH_FAILURE);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/authenticate|api_error|is_error/i);
  });

  it("surfaces the auth failure text rather than swallowing it", () => {
    const out = parseClaudeJson(AUTH_FAILURE);
    expect(out.text).toMatch(/Failed to authenticate/);
  });
});
