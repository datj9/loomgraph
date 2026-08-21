import { describe, it, expect } from "vitest";
import { parseClaudeSessionJsonl, encodeClaudeProjectDir } from "./claude.js";

// Hand-written fixture in the shape of a Claude Code session jsonl. Every value
// is fabricated: the paths live under a made-up /Users/alice tree and the
// "secret" strings are not real credentials.
const HAPPY = [
  `{"type":"system","subtype":"init","sessionId":"sess-1","cwd":"/Users/alice/demo","gitBranch":"feat/handoff","version":"2.1.0"}`,
  `{"type":"user","sessionId":"sess-1","cwd":"/Users/alice/demo","message":{"role":"user","content":"fix the parser in src/handoff/readers/claude.ts"}}`,
  `{"type":"assistant","sessionId":"sess-1","message":{"role":"assistant","model":"claude-opus-5","content":[{"type":"text","text":"Patched src/handoff/readers/claude.ts and added a test."},{"type":"tool_use","id":"tu_1","name":"Edit","input":{"file_path":"/Users/alice/demo/src/x.ts","new_string":"NEVER_SHOW_ME"}}]}}`,
  `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu_1","content":"BLOB_THAT_MUST_NOT_LEAK"}]}}`,
  `{"type":"file-history-snapshot","messageId":"m1","snapshot":{"trackedFileBackups":{"/Users/alice/demo/src/x.ts":"SNAPSHOT_BLOB"}}}`,
  `{"type":"permission-mode","mode":"acceptEdits"}`,
].join("\n");

describe("parseClaudeSessionJsonl", () => {
  it("extracts turns, session id, cwd and model from a well-formed transcript", () => {
    const s = parseClaudeSessionJsonl(HAPPY);

    expect(s.adapter).toBe("claude");
    expect(s.sessionId).toBe("sess-1");
    expect(s.cwd).toBe("/Users/alice/demo");
    expect(s.model).toBe("claude-opus-5");
    expect(s.turns).toEqual([
      { role: "user", text: "fix the parser in src/handoff/readers/claude.ts" },
      {
        role: "assistant",
        text: "Patched src/handoff/readers/claude.ts and added a test.",
      },
    ]);
    expect(s.filesTouched).toEqual(["src/handoff/readers/claude.ts"]);
  });

  it("never copies tool results, snapshots or permission modes into the output", () => {
    const json = JSON.stringify(parseClaudeSessionJsonl(HAPPY));

    expect(json).not.toContain("BLOB_THAT_MUST_NOT_LEAK");
    expect(json).not.toContain("SNAPSHOT_BLOB");
    expect(json).not.toContain("NEVER_SHOW_ME");
    expect(json).not.toContain("acceptEdits");
  });

  it("reports the transcript branch as a warning instead of dropping it silently", () => {
    const s = parseClaudeSessionJsonl(HAPPY);
    expect(s.warnings.some((w) => w.includes("feat/handoff"))).toBe(true);
  });

  it("skips a malformed line and warns rather than throwing", () => {
    const jsonl = [
      `{"type":"user","message":{"role":"user","content":"hello"}}`,
      `{"type":"assistant","message":`,
      `not json at all`,
      `{"type":"assistant","message":{"role":"assistant","content":"hi"}}`,
    ].join("\n");

    const s = parseClaudeSessionJsonl(jsonl);

    expect(s.turns.map((t) => t.text)).toEqual(["hello", "hi"]);
    expect(s.warnings).toContain("skipped 2 malformed or unrecognised line(s)");
  });

  it("collects unknown record types into a single warning", () => {
    const jsonl = [
      `{"type":"quantum-entanglement","x":1}`,
      `{"type":"telepathy","x":2}`,
      `{"type":"quantum-entanglement","x":3}`,
      `{"type":"user","message":{"role":"user","content":"go"}}`,
    ].join("\n");

    const s = parseClaudeSessionJsonl(jsonl);
    const unknown = s.warnings.filter((w) => w.startsWith("unknown record types:"));

    expect(unknown).toEqual(["unknown record types: quantum-entanglement, telepathy"]);
  });

  it("returns an empty session for empty input", () => {
    expect(parseClaudeSessionJsonl("")).toEqual({
      adapter: "claude",
      sessionId: null,
      cwd: null,
      model: null,
      turns: [],
      filesTouched: [],
      warnings: [],
    });
    expect(parseClaudeSessionJsonl("\n\n  \n").turns).toEqual([]);
  });
});

describe("encodeClaudeProjectDir", () => {
  it("encodes a posix cwd the way the projects directory appears to", () => {
    expect(encodeClaudeProjectDir("/Users/alice/Documents/demo")).toBe(
      "-Users-alice-Documents-demo",
    );
  });

  it("flattens dots and spaces so the result is a single path segment", () => {
    expect(encodeClaudeProjectDir("/Users/alice/my proj/.config")).toBe(
      "-Users-alice-my-proj--config",
    );
  });
});
