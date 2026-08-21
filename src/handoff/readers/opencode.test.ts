import { describe, it, expect } from "vitest";
import { parseOpencodeExportJson, buildOpencodeExportArgs } from "./opencode.js";

// Hand-written fixture. The shape of a real `opencode export --sanitize` payload
// is unverified (see the header comment in opencode.ts), so this fixture asserts
// the parser's contract, not the CLI's - it must be replaced once a real export
// has been captured.
const HAPPY = JSON.stringify({
  session: {
    id: "oc-42",
    directory: "/Users/alice/demo",
    modelID: "claude-sonnet-5",
  },
  messages: [
    {
      info: { role: "user" },
      parts: [{ type: "text", text: "split the reader in src/handoff/readers/opencode.ts" }],
    },
    {
      info: { role: "assistant" },
      parts: [
        { type: "text", text: "Split it; tests live in src/handoff/readers/opencode.test.ts." },
        { type: "tool", state: { output: "TOOL_OUTPUT_MUST_NOT_ESCAPE" } },
        { type: "file", url: "file:///Users/alice/secret.pem" },
      ],
    },
  ],
});

describe("parseOpencodeExportJson", () => {
  it("extracts turns, session id, cwd and model from the probed shape", () => {
    const s = parseOpencodeExportJson(HAPPY);

    expect(s.adapter).toBe("opencode");
    expect(s.sessionId).toBe("oc-42");
    expect(s.cwd).toBe("/Users/alice/demo");
    expect(s.model).toBe("claude-sonnet-5");
    expect(s.turns).toEqual([
      { role: "user", text: "split the reader in src/handoff/readers/opencode.ts" },
      {
        role: "assistant",
        text: "Split it; tests live in src/handoff/readers/opencode.test.ts.",
      },
    ]);
  });

  it("drops tool output and file attachments", () => {
    const s = parseOpencodeExportJson(HAPPY);
    const json = JSON.stringify(s);

    expect(json).not.toContain("TOOL_OUTPUT_MUST_NOT_ESCAPE");
    expect(json).not.toContain("secret.pem");
    expect(s.warnings).toContain("dropped 2 non-text part(s)");
  });

  it("always warns that the export shape is unverified", () => {
    expect(parseOpencodeExportJson(HAPPY).warnings).toContain(
      "opencode export shape is unverified; check the brief against the transcript",
    );
  });

  it("accepts a bare array of messages with role and text", () => {
    const json = JSON.stringify([
      { role: "user", text: "hello" },
      { role: "assistant", content: "hi" },
    ]);

    expect(parseOpencodeExportJson(json).turns).toEqual([
      { role: "user", text: "hello" },
      { role: "assistant", text: "hi" },
    ]);
  });

  it("skips messages with no recognisable role and warns", () => {
    const json = JSON.stringify({
      messages: [{ role: "system", text: "ignored" }, { text: "orphan" }, { role: "user", text: "kept" }],
    });

    const s = parseOpencodeExportJson(json);

    expect(s.turns).toEqual([{ role: "user", text: "kept" }]);
    expect(s.warnings).toContain("skipped 2 message(s) with no recognisable role");
  });

  it("names what it looked for when the shape is unrecognised", () => {
    const s = parseOpencodeExportJson(JSON.stringify({ conversation: { log: [] } }));

    expect(s.turns).toEqual([]);
    expect(s.warnings).toHaveLength(1);
    expect(s.warnings[0]).toContain("unrecognised opencode export shape");
    expect(s.warnings[0]).toContain("messages/turns/parts/entries");
    expect(s.warnings[0]).toContain("session/info/data/export");
  });

  it("warns instead of throwing on invalid JSON", () => {
    const s = parseOpencodeExportJson("{ not json");

    expect(s.turns).toEqual([]);
    expect(s.warnings).toEqual([
      "opencode export was not valid JSON; no turns extracted",
    ]);
  });

  it("returns an empty session for empty input", () => {
    expect(parseOpencodeExportJson("")).toEqual({
      adapter: "opencode",
      sessionId: null,
      cwd: null,
      model: null,
      turns: [],
      filesTouched: [],
      warnings: ["opencode export was not valid JSON; no turns extracted"],
    });
  });
});

describe("buildOpencodeExportArgs", () => {
  it("includes the session id when one is given", () => {
    expect(buildOpencodeExportArgs("oc-42")).toEqual(["export", "oc-42", "--sanitize"]);
  });

  it("omits the session id when none is given", () => {
    expect(buildOpencodeExportArgs()).toEqual(["export", "--sanitize"]);
  });
});
