import { describe, it, expect } from "vitest";
import { parseCodexSessionJsonl } from "./codex.js";

// Hand-written fixture in the shape of a codex rollout jsonl. Fabricated values
// only - the "instructions" text below is a marker string, not a real prompt,
// and no credential appears anywhere.
const BASE_INSTRUCTIONS_MARKER = "SYSTEM_PROMPT_MUST_NOT_ESCAPE";

const HAPPY = [
  `{"timestamp":"2026-08-21T10:00:00Z","type":"session_meta","payload":{"id":"cdx-9","cwd":"/Users/alice/demo","originator":"codex_cli_rs","cli_version":"0.145.0","model":"gpt-5.6","model_provider":"openai","base_instructions":"${BASE_INSTRUCTIONS_MARKER}","git":{"branch":"feat/handoff","repository_url":"git@example.invalid:alice/demo.git"}}}`,
  `{"timestamp":"2026-08-21T10:00:01Z","type":"turn_context","payload":{"cwd":"/Users/alice/demo","model":"gpt-5.6","approval_policy":"never"}}`,
  `{"timestamp":"2026-08-21T10:00:02Z","type":"event_msg","payload":{"type":"user_message","message":"rename the reader in src/handoff/readers/codex.ts"}}`,
  `{"timestamp":"2026-08-21T10:00:03Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"rename the reader in src/handoff/readers/codex.ts"}]}}`,
  `{"timestamp":"2026-08-21T10:00:04Z","type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{\\"command\\":[\\"cat\\",\\"TOOL_BLOB_MUST_NOT_ESCAPE\\"]}"}}`,
  `{"timestamp":"2026-08-21T10:00:05Z","type":"response_item","payload":{"type":"reasoning","summary":[{"type":"summary_text","text":"HIDDEN_REASONING"}]}}`,
  `{"timestamp":"2026-08-21T10:00:06Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Renamed it and updated src/handoff/readers/codex.test.ts."}]}}`,
  `{"timestamp":"2026-08-21T10:00:07Z","type":"world_state","payload":{"agents":{"bob":{"token":"OTHER_AGENT_STATE"}}}}`,
  `{"timestamp":"2026-08-21T10:00:08Z","type":"inter_agent_communication_v2","payload":{"to":"bob","body":"CROSS_AGENT_BLOB"}}`,
].join("\n");

describe("parseCodexSessionJsonl", () => {
  it("extracts turns, session id, cwd and model", () => {
    const s = parseCodexSessionJsonl(HAPPY);

    expect(s.adapter).toBe("codex");
    expect(s.sessionId).toBe("cdx-9");
    expect(s.cwd).toBe("/Users/alice/demo");
    expect(s.model).toBe("gpt-5.6");
    expect(s.turns).toEqual([
      { role: "user", text: "rename the reader in src/handoff/readers/codex.ts" },
      {
        role: "assistant",
        text: "Renamed it and updated src/handoff/readers/codex.test.ts.",
      },
    ]);
    expect(s.filesTouched).toEqual([
      "src/handoff/readers/codex.ts",
      "src/handoff/readers/codex.test.ts",
    ]);
  });

  it("never reproduces base_instructions anywhere in the output", () => {
    const json = JSON.stringify(parseCodexSessionJsonl(HAPPY));
    expect(json).not.toContain(BASE_INSTRUCTIONS_MARKER);
  });

  it("drops world_state, inter-agent records, tool calls and reasoning", () => {
    const s = parseCodexSessionJsonl(HAPPY);
    const json = JSON.stringify(s);

    expect(json).not.toContain("OTHER_AGENT_STATE");
    expect(json).not.toContain("CROSS_AGENT_BLOB");
    expect(json).not.toContain("TOOL_BLOB_MUST_NOT_ESCAPE");
    expect(json).not.toContain("HIDDEN_REASONING");
    expect(s.warnings).toContain(
      "dropped 2 world_state/inter_agent_communication record(s)",
    );
    expect(s.warnings).toContain("dropped 2 tool-call or reasoning payload(s)");
  });

  it("prefers response_item turns over the duplicate event_msg stream", () => {
    const s = parseCodexSessionJsonl(HAPPY);

    expect(s.turns.filter((t) => t.role === "user")).toHaveLength(1);
    expect(s.warnings).toContain(
      "event_msg turns dropped as duplicates of response_item turns",
    );
  });

  it("falls back to event_msg when the transcript has no response items", () => {
    const jsonl = [
      `{"timestamp":"t","type":"event_msg","payload":{"type":"user_message","message":"hello"}}`,
      `{"timestamp":"t","type":"event_msg","payload":{"type":"agent_message","message":"hi"}}`,
      `{"timestamp":"t","type":"event_msg","payload":{"type":"token_count","info":{"total":10}}}`,
    ].join("\n");

    expect(parseCodexSessionJsonl(jsonl).turns).toEqual([
      { role: "user", text: "hello" },
      { role: "assistant", text: "hi" },
    ]);
  });

  it("skips a malformed line and warns rather than throwing", () => {
    const jsonl = [
      `{"timestamp":"t","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"go"}]}}`,
      `{"timestamp":"t","type":"response_item","payload":`,
      `{"no_type_at_all":true}`,
    ].join("\n");

    const s = parseCodexSessionJsonl(jsonl);

    expect(s.turns).toEqual([{ role: "user", text: "go" }]);
    expect(s.warnings).toContain("skipped 2 malformed or unrecognised line(s)");
  });

  it("collects unknown record types into a single warning", () => {
    const jsonl = [
      `{"timestamp":"t","type":"telemetry_blip","payload":{}}`,
      `{"timestamp":"t","type":"telemetry_blip","payload":{}}`,
      `{"timestamp":"t","type":"astral_projection","payload":{}}`,
    ].join("\n");

    const s = parseCodexSessionJsonl(jsonl);
    const unknown = s.warnings.filter((w) => w.startsWith("unknown record types:"));

    expect(unknown).toEqual(["unknown record types: astral_projection, telemetry_blip"]);
  });

  it("returns an empty session for empty input", () => {
    expect(parseCodexSessionJsonl("")).toEqual({
      adapter: "codex",
      sessionId: null,
      cwd: null,
      model: null,
      turns: [],
      filesTouched: [],
      warnings: [],
    });
  });
});
