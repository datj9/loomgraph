import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCodexArgs,
  decideCodexResult,
  detectSandboxFailure,
  parseCodexJsonl,
  resolveCodexSandbox,
  CodexAdapter,
} from "./codex.js";

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
      "--sandbox",
      "read-only",
      "-C",
      "/repo",
    ]);
  });

  it("swaps in the bypass flag when the sandbox cannot start", () => {
    // Some containers cannot run codex's bwrap sandbox at all - it fails with
    // "bwrap: loopback: Failed RTM_NEWADDR". The escape hatch replaces
    // --sandbox entirely rather than adding to it.
    const args = buildCodexArgs("review the diff", "/repo", "bypass");
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args).not.toContain("--sandbox");
    expect(args).not.toContain("read-only");
  });

  it("keeps read-only as the default policy", () => {
    expect(buildCodexArgs("x", "/repo")).toEqual(buildCodexArgs("x", "/repo", "read-only"));
  });

  it("appends --model when a model is given", () => {
    const args = buildCodexArgs("x", "/repo", "read-only", "gpt-5.6-sol");
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("gpt-5.6-sol");
  });

  it("omits --model when no model is given", () => {
    expect(buildCodexArgs("x", "/repo")).not.toContain("--model");
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

describe("decideCodexResult", () => {
  it("fails a non-zero exit even when an agent message was streamed", () => {
    // A partial message plus a crash is not a successful run.
    const parsed = parseCodexJsonl(EVENTS);
    expect(parsed.ok).toBe(true); // the parser alone sees a valid message
    const decided = decideCodexResult(parsed, 1, "boom");
    expect(decided.ok).toBe(false);
    expect(decided.error).toMatch(/exited 1/);
    expect(decided.error).toMatch(/boom/);
  });

  it("keeps a successful parse successful on exit 0", () => {
    const decided = decideCodexResult(parseCodexJsonl(EVENTS), 0, "");
    expect(decided.ok).toBe(true);
    expect(decided.text).toBe("final answer");
  });

  it("annotates an already-failed parse with the exit code and stderr", () => {
    const parsed = parseCodexJsonl(`{"msg":{"type":"task_started"}}`);
    const decided = decideCodexResult(parsed, 2, "auth expired");
    expect(decided.ok).toBe(false);
    expect(decided.error).toMatch(/no agent message/i);
    expect(decided.error).toMatch(/auth expired/);
  });

  it("fails a verifier whose sandbox is broken even when the pass string appears and codex exits 0", () => {
    // A verifier that could not read the tree must not pass: codex keeps
    // talking and exits 0, and the agent message can still contain the pass
    // string the engine is looking for.
    const parsed = parseCodexJsonl(`{"msg":{"type":"agent_message","message":"looks good - PASS"}}`);
    const decided = decideCodexResult(parsed, 0, "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted");
    expect(decided.ok).toBe(false);
    expect(decided.error).toMatch(/sandbox/i);
    expect(decided.error).toMatch(/bwrap/i);
  });

  it("explains the bypass escape hatch when the sandbox failed", () => {
    const parsed = parseCodexJsonl(`{"msg":{"type":"agent_message","message":"PASS"}}`);
    const decided = decideCodexResult(parsed, 0, "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted");
    expect(decided.error).toMatch(/LOOMGRAPH_CODEX_SANDBOX=bypass/);
  });

  it("reports the sandbox failure instead of a missing-message error", () => {
    const parsed = parseCodexJsonl(`{"msg":{"type":"task_started"}}`);
    const decided = decideCodexResult(parsed, 0, "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted");
    expect(decided.ok).toBe(false);
    expect(decided.error).toMatch(/sandbox failed/i);
    expect(decided.error).not.toMatch(/no agent message/i);
  });

  it("does not flag a clean run whose stderr merely mentions the word pass", () => {
    const decided = decideCodexResult(parseCodexJsonl(EVENTS), 0, "all checks pass");
    expect(decided.ok).toBe(true);
    expect(decided.text).toBe("final answer");
  });

  it("catches the bwrap diagnostic when codex writes it to stdout instead", () => {
    const stdout = [
      "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted",
      `{"msg":{"type":"agent_message","message":"I could not read any files, but nothing looks wrong. PASS"}}`,
    ].join("\n");
    const decided = decideCodexResult(parseCodexJsonl(stdout), 0, "", stdout);
    expect(decided.ok).toBe(false);
    expect(decided.error).toMatch(/sandbox failed/i);
  });

  it("does not flag an agent message that merely discusses bwrap", () => {
    const stdout = `{"msg":{"type":"agent_message","message":"the script calls bwrap for isolation - looks fine, PASS"}}`;
    const decided = decideCodexResult(parseCodexJsonl(stdout), 0, "", stdout);
    expect(decided.ok).toBe(true);
    expect(decided.error).toBeNull();
  });
});

describe("detectSandboxFailure", () => {
  it("returns null for ordinary output", () => {
    expect(detectSandboxFailure("warning: something harmless\nall good\n")).toBeNull();
  });

  it("returns the offending line", () => {
    const line = "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted";
    expect(detectSandboxFailure(`noise\n  ${line}  \nmore noise`)).toBe(line);
  });
});

describe("resolveCodexSandbox", () => {
  it("defaults to read-only when unset or empty", () => {
    expect(resolveCodexSandbox(undefined)).toBe("read-only");
    expect(resolveCodexSandbox("")).toBe("read-only");
    expect(resolveCodexSandbox("   ")).toBe("read-only");
  });

  it("accepts each documented value", () => {
    expect(resolveCodexSandbox("read-only")).toBe("read-only");
    expect(resolveCodexSandbox("workspace-write")).toBe("workspace-write");
    expect(resolveCodexSandbox("bypass")).toBe("bypass");
  });

  it("rejects an undocumented value and names the valid ones", () => {
    expect(() => resolveCodexSandbox("danger-full-access")).toThrow(/LOOMGRAPH_CODEX_SANDBOX/);
    expect(() => resolveCodexSandbox("danger-full-access")).toThrow(/read-only, workspace-write, bypass/);
  });

  it("rejects a wrong-case value rather than passing it through to codex", () => {
    expect(() => resolveCodexSandbox("READ-ONLY")).toThrow(/LOOMGRAPH_CODEX_SANDBOX/);
  });
});

describe("CodexAdapter process handling", () => {
  // Stub scripts only, invoked by absolute path. No real agent CLI is spawned
  // and PATH is never touched.
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "lg-codex-stub-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("names the binary when it is missing", async () => {
    const bin = join(dir, "definitely-not-installed");
    const out = await new CodexAdapter(bin).run({ prompt: "hi", cwd: dir, timeoutSec: 10 });
    expect(out.ok).toBe(false);
    expect(out.error).toContain(bin);
    expect(out.error).toMatch(/not found on PATH/);
  });

  it("times out when a grandchild outlives the CLI", async () => {
    const bin = join(dir, "slow-stub.sh");
    await writeFile(bin, `#!/bin/sh\nsleep 30 &\necho '{"msg":{"type":"agent_message","message":"ok"}}'\n`, {
      mode: 0o755,
    });
    const started = Date.now();
    const out = await new CodexAdapter(bin).run({ prompt: "hi", cwd: dir, timeoutSec: 2 });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/timeout after 2s/);
    expect(Date.now() - started).toBeLessThan(3500);
  }, 20000);
});
