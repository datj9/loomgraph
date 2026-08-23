import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOpencodeArgs, parseOpencodeJsonl, OpenCodeAdapter } from "./opencode.js";

/**
 * Captured by hand from opencode 1.18.17 on 2026-08-15:
 *
 *   opencode run --format json -m opencode-go/deepseek-v4-flash "Reply with exactly the word MANGO and nothing else."
 *
 * Session and part ids are replaced; every field name, nesting level and the
 * price are exactly as the binary emitted them.
 */
const SUCCESS_JSONL = [
  '{"type":"step_start","timestamp":1786788608757,"sessionID":"ses_TEST","part":{"id":"prt_0","messageID":"msg_TEST","sessionID":"ses_TEST","type":"step-start"}}',
  '{"type":"text","timestamp":1786788608758,"sessionID":"ses_TEST","part":{"id":"prt_1","messageID":"msg_TEST","sessionID":"ses_TEST","type":"text","text":"MANGO","time":{"start":1786788610731,"end":1786788610785}}}',
  '{"type":"step_finish","timestamp":1786788608759,"sessionID":"ses_TEST","part":{"id":"prt_2","reason":"stop","messageID":"msg_TEST","sessionID":"ses_TEST","type":"step-finish","tokens":{"total":58887,"input":56948,"output":3,"reasoning":16,"cache":{"write":0,"read":1920}},"cost":0.003991708}}',
].join("\n");

const TWO_STEPS = [
  '{"type":"text","timestamp":1,"sessionID":"s","part":{"type":"text","text":"first "}}',
  '{"type":"step_finish","timestamp":2,"sessionID":"s","part":{"type":"step-finish","cost":0.01}}',
  '{"type":"text","timestamp":3,"sessionID":"s","part":{"type":"text","text":"second"}}',
  '{"type":"step_finish","timestamp":4,"sessionID":"s","part":{"type":"step-finish","cost":0.02}}',
].join("\n");

describe("buildOpencodeArgs", () => {
  it("builds the json-format run argv", () => {
    expect(buildOpencodeArgs("do a thing")).toEqual(["run", "--format", "json", "do a thing"]);
  });

  it("appends the model flag when a model is given", () => {
    expect(buildOpencodeArgs("do a thing", "opencode-go/deepseek-v4-flash")).toEqual([
      "run",
      "--format",
      "json",
      "-m",
      "opencode-go/deepseek-v4-flash",
      "do a thing",
    ]);
  });

  it("omits the model flag when no model is given", () => {
    expect(buildOpencodeArgs("x")).not.toContain("-m");
  });
});

describe("parseOpencodeJsonl", () => {
  it("extracts text and the reported cost from the event stream", () => {
    const out = parseOpencodeJsonl(SUCCESS_JSONL, 0);
    expect(out.ok).toBe(true);
    expect(out.text).toBe("MANGO");
    expect(out.costUsd).toBe(0.003991708);
    expect(out.error).toBeNull();
  });

  it("concatenates text across every text event", () => {
    expect(parseOpencodeJsonl(TWO_STEPS, 0).text).toBe("first second");
  });

  it("sums cost across every step_finish event", () => {
    expect(parseOpencodeJsonl(TWO_STEPS, 0).costUsd).toBeCloseTo(0.03, 10);
  });

  it("records zero cost when no event reports a price", () => {
    const line = '{"type":"text","timestamp":1,"sessionID":"s","part":{"type":"text","text":"hi"}}';
    const out = parseOpencodeJsonl(line, 0);
    expect(out.ok).toBe(true);
    expect(out.costUsd).toBe(0);
  });

  it("fails on a non-zero exit code but still reports the cost already spent", () => {
    const out = parseOpencodeJsonl(SUCCESS_JSONL, 1);
    expect(out.ok).toBe(false);
    expect(out.costUsd).toBe(0.003991708);
    expect(out.error).toBe("opencode exited with code 1");
  });

  it("fails when the stream carries no recognisable event", () => {
    const out = parseOpencodeJsonl("not json at all", 0);
    expect(out.ok).toBe(false);
    expect(out.costUsd).toBe(0);
    expect(out.error).toBe("could not parse opencode json output: no events found");
  });

  it("ignores an unparseable line but keeps the events around it", () => {
    const mixed = [
      "warning: something on stdout that is not json",
      '{"type":"text","timestamp":1,"sessionID":"s","part":{"type":"text","text":"kept"}}',
      '{"type":"step_finish","timestamp":2,"sessionID":"s","part":{"type":"step-finish","cost":0.5}}',
    ].join("\n");
    const out = parseOpencodeJsonl(mixed, 0);
    expect(out.ok).toBe(true);
    expect(out.text).toBe("kept");
    expect(out.costUsd).toBe(0.5);
  });

  it("fails when events parse but produce no text", () => {
    const line = '{"type":"step_finish","timestamp":1,"sessionID":"s","part":{"type":"step-finish","cost":0.1}}';
    const out = parseOpencodeJsonl(line, 0);
    expect(out.ok).toBe(false);
    expect(out.costUsd).toBe(0.1);
    expect(out.error).toBe("opencode produced no output");
  });

  it("keeps the raw stdout so a run can be audited", () => {
    expect(parseOpencodeJsonl(SUCCESS_JSONL, 0).raw).toBe(SUCCESS_JSONL);
  });

  it("clamps a negative reported cost to 0", () => {
    const stdout = [
      JSON.stringify({ type: "text", part: { text: "hello" } }),
      JSON.stringify({ type: "step_finish", part: { cost: -0.25 } }),
    ].join("\n");
    const out = parseOpencodeJsonl(stdout, 0);
    expect(out.ok).toBe(true);
    expect(out.costUsd).toBe(0);
  });

  it("ignores a negative cost but still sums the positive ones", () => {
    const stdout = [
      JSON.stringify({ type: "text", part: { text: "hello" } }),
      JSON.stringify({ type: "step_finish", part: { cost: -0.25 } }),
      JSON.stringify({ type: "step_finish", part: { cost: 0.5 } }),
    ].join("\n");
    expect(parseOpencodeJsonl(stdout, 0).costUsd).toBeCloseTo(0.5, 10);
  });
});

describe("OpenCodeAdapter process handling", () => {
  // Stub scripts only, invoked by absolute path. No real agent CLI is spawned
  // and PATH is never touched.
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "lg-opencode-stub-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("names the binary when it is missing", async () => {
    const bin = join(dir, "definitely-not-installed");
    const out = await new OpenCodeAdapter(bin).run({ prompt: "hi", cwd: dir, timeoutSec: 10 });
    expect(out.ok).toBe(false);
    expect(out.error).toContain(bin);
    expect(out.error).toMatch(/not found on PATH/);
  });

  it("times out when a grandchild outlives the CLI", async () => {
    const bin = join(dir, "slow-stub.sh");
    await writeFile(bin, `#!/bin/sh\nsleep 30 &\necho '{"type":"text","part":{"text":"ok"}}'\n`, { mode: 0o755 });
    const started = Date.now();
    const out = await new OpenCodeAdapter(bin).run({ prompt: "hi", cwd: dir, timeoutSec: 2 });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/timeout after 2s/);
    expect(Date.now() - started).toBeLessThan(3500);
  }, 20000);
});
