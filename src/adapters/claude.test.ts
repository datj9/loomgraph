import { describe, it, expect } from "vitest";
import { buildClaudeArgs, parseClaudeJson } from "./claude.js";

const SUCCESS = `{"type":"result","subtype":"success","result":"done","session_id":"abc","num_turns":3,"total_cost_usd":0.0787}`;
const MAX_TURNS = `{"type":"result","subtype":"error_max_turns","result":"","total_cost_usd":0.5}`;
// Captured verbatim from Claude Code 2.1.232 with an expired OAuth session.
// Note `subtype` is "success" while `is_error` is true - trusting subtype alone
// makes an auth failure look like a completed agent run.
const AUTH_FAILURE = `{"type":"result","subtype":"success","is_error":true,"result":"Failed to authenticate: OAuth session expired and could not be refreshed","terminal_reason":"api_error","total_cost_usd":0,"num_turns":1}`;
// Captured from Claude Code 3.x: stdout is now a JSON array of message
// objects whose last element carries the run result.
const SUCCESS_ARRAY = `[
  {"type":"system","subtype":"init","cwd":"/tmp/x","session_id":"SID"},
  {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"BANANA"}]}},
  {"type":"rate_limit_event","session_id":"SID"},
  {"type":"result","subtype":"success","is_error":false,"num_turns":1,"stop_reason":"end_turn","total_cost_usd":0.2642395,"result":"BANANA","usage":{"input_tokens":4,"output_tokens":5}}
]`;

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

  it("extracts text and cost from the array-form result element", () => {
    const out = parseClaudeJson(SUCCESS_ARRAY);
    expect(out.ok).toBe(true);
    expect(out.text).toBe("BANANA");
    expect(out.costUsd).toBe(0.2642395);
    expect(out.error).toBeNull();
  });

  it("records the cost from the array even when the result reports an error", () => {
    const out = parseClaudeJson(`[
      {"type":"system","subtype":"init","cwd":"/tmp/x","session_id":"SID"},
      {"type":"result","subtype":"error_max_turns","is_error":false,"total_cost_usd":0.11,"result":""}
    ]`);
    expect(out.ok).toBe(false);
    expect(out.text).toBe("");
    expect(out.costUsd).toBe(0.11);
    expect(out.error).toBe("claude run ended with subtype error_max_turns");
  });

  it("fails with a named error when the array carries no result element", () => {
    const out = parseClaudeJson('[{"type":"system","subtype":"init"},{"type":"assistant"}]');
    expect(out.ok).toBe(false);
    expect(out.text).toBe("");
    expect(out.costUsd).toBe(0);
    expect(out.error).toBe("could not parse claude json output: no result element in array");
  });

  it("takes the last result element when an array carries more than one", () => {
    const out = parseClaudeJson(`[
      {"type":"system","subtype":"init"},
      {"type":"result","subtype":"error_max_turns","is_error":false,"total_cost_usd":0.01,"result":""},
      {"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.99,"result":"second"}
    ]`);
    expect(out.ok).toBe(true);
    expect(out.text).toBe("second");
    expect(out.costUsd).toBe(0.99);
  });

  it("keeps the whole array as raw", () => {
    const out = parseClaudeJson(SUCCESS_ARRAY);
    expect(Array.isArray(out.raw)).toBe(true);
    expect((out.raw as unknown[]).length).toBe(4);
  });
});
