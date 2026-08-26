import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runProcess } from "./types.js";

/** True while `pid` still exists, false once it is gone (ESRCH). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

  it("SIGKILLs a grandchild that ignores SIGTERM instead of letting it survive forever", async () => {
    // The regression: killGroup(-pid, SIGTERM) reaches a `sh` that is holding
    // the pipe execa is waiting on, so that `sh` dies and `await child`
    // resolves - but a grandchild with `trap '' TERM` (a real-world deploy
    // script pattern) ignores the same signal and is not tracked by anything
    // once the promise settles. The escalation timer that would SIGKILL it was
    // being cleared in `finally` the moment `await child` resolved, before it
    // ever got to fire, so the grandchild ran forever despite `timedOut: true`.
    const dir = mkdtempSync(join(tmpdir(), "loomgraph-proc2-"));
    const pidFile = join(dir, "grandchild.pid");
    const logFile = join(dir, "grandchild.log");

    // Backgrounds a shell that ignores SIGTERM and re-spawns `sleep 1` forever,
    // records its own pid, then the outer shell (the direct child execa waits
    // on) blocks past the deadline so the timeout path actually triggers.
    const cmd = `sh -c 'trap "" TERM; while true; do sleep 1; done' > ${logFile} 2>&1 & echo $! > ${pidFile}; sleep 5`;

    let grandchildPid: number | undefined;
    try {
      const started = Date.now();
      const result = await runProcess(cmd, [], {
        cwd: dir,
        timeoutSec: 1,
        shell: true,
      });
      const elapsed = Date.now() - started;

      expect(result.timedOut).toBe(true);
      // The fix must not make the normal timeout path slower: runProcess
      // returns as soon as the direct child's pipes close, it does not block
      // on the escalation timer.
      expect(elapsed).toBeLessThan(3500);

      grandchildPid = Number(readFileSync(pidFile, "utf8").trim());
      expect(Number.isInteger(grandchildPid)).toBe(true);

      // Right after return the SIGKILL escalation has not fired yet - the
      // grandchild is still alive despite `timedOut: true`.
      expect(isAlive(grandchildPid)).toBe(true);

      // Once the SIGKILL_GRACE_MS window (2s) has elapsed since the SIGTERM
      // was sent, the escalation timer must have force-killed it.
      await sleep(2500);
      expect(isAlive(grandchildPid)).toBe(false);
    } finally {
      // Best-effort cleanup in case an assertion above failed before the
      // escalation had a chance to run.
      if (grandchildPid !== undefined && isAlive(grandchildPid)) {
        try {
          process.kill(grandchildPid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
  }, 20000);
});
