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

  it("fails at the timeout even when a grandchild outlives the shell", async () => {
    // `sleep 30 &` leaves an orphan holding the stdout pipe. The shell exits 0
    // immediately, but the pipe stays open, so the node used to stay blocked for
    // the command's full 30s and only then relabel the result as a timeout.
    const started = Date.now();
    const out = await adapter.run({ prompt: "sleep 30 & echo started", cwd: tmpdir(), timeoutSec: 2 });
    const elapsed = Date.now() - started;
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/timeout/i);
    expect(elapsed).toBeLessThan(3500);
  }, 20000);

  it("runs the command in the requested cwd", async () => {
    const out = await adapter.run({ prompt: "pwd", cwd: tmpdir(), timeoutSec: 10 });
    expect(out.ok).toBe(true);
    expect(out.text).toContain(tmpdir().replace(/\/$/, ""));
  });
});
