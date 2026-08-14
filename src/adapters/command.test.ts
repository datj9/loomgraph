import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { CommandAdapter } from "./command.js";

const adapter = new CommandAdapter();

describe("CommandAdapter", () => {
  it("returns ok with stdout for a successful command", async () => {
    const out = await adapter.run({ prompt: "echo hi", cwd: tmpdir(), timeoutSec: 10 });
    expect(out.ok).toBe(true);
    expect(out.text.trim()).toBe("hi");
    expect(out.error).toBeNull();
    expect(out.costUsd).toBe(0);
  });

  it("returns not-ok with the exit code and stderr for a failing command", async () => {
    const out = await adapter.run({ prompt: "echo boom >&2; exit 3", cwd: tmpdir(), timeoutSec: 10 });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/3/);
    expect(out.error).toMatch(/boom/);
    expect(out.costUsd).toBe(0);
  });

  it("returns not-ok mentioning timeout when the command overruns", async () => {
    const out = await adapter.run({ prompt: "sleep 5", cwd: tmpdir(), timeoutSec: 1 });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/timeout/i);
  });

  it("runs the command in the requested cwd", async () => {
    const out = await adapter.run({ prompt: "pwd", cwd: tmpdir(), timeoutSec: 10 });
    expect(out.ok).toBe(true);
    expect(out.text).toContain(tmpdir().replace(/\/$/, ""));
  });
});
