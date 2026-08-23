import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { runProcess } from "./types.js";

describe("runProcess", () => {
  it("returns stdout, stderr and the exit code for a normal run", async () => {
    const result = await runProcess("echo hi; echo bad >&2", [], {
      cwd: tmpdir(),
      timeoutSec: 10,
      shell: true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hi");
    expect(result.stderr.trim()).toBe("bad");
    expect(result.timedOut).toBe(false);
    expect(result.spawnErrorCode).toBeNull();
  });

  it("reports ENOENT rather than an empty stdout when the binary is missing", async () => {
    const result = await runProcess("/nonexistent/loomgraph-not-a-real-binary", ["--version"], {
      cwd: tmpdir(),
      timeoutSec: 10,
    });
    expect(result.spawnErrorCode).toBe("ENOENT");
    expect(result.timedOut).toBe(false);
  });

  it("kills the whole process group so a grandchild holding stdout cannot outlive the timeout", async () => {
    // The regression: `sleep 30 &` leaves an orphan holding the stdout pipe. The
    // direct child exits immediately with code 0, but the pipe never closes, so
    // the run stayed blocked for the full 30s no matter what timeoutSec said.
    const started = Date.now();
    const result = await runProcess("sleep 30 & echo started", [], {
      cwd: tmpdir(),
      timeoutSec: 2,
      shell: true,
    });
    const elapsed = Date.now() - started;
    expect(result.timedOut).toBe(true);
    expect(elapsed).toBeLessThan(3500);
  }, 20000);

  it("kills a grandchild the direct child is waiting on", async () => {
    const started = Date.now();
    const result = await runProcess("sleep 30 & wait", [], {
      cwd: tmpdir(),
      timeoutSec: 2,
      shell: true,
    });
    const elapsed = Date.now() - started;
    expect(result.timedOut).toBe(true);
    expect(elapsed).toBeLessThan(3500);
  }, 20000);
});
