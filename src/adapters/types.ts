import { execa } from "execa";

export interface AdapterInput {
  prompt: string;
  cwd: string;
  maxTurns?: number;
  /** Model id passed straight to the CLI. Undefined leaves the CLI's own resolution alone. */
  model?: string;
  timeoutSec: number;
}

export interface AdapterOutput {
  ok: boolean;
  text: string;
  costUsd: number;
  raw: unknown;
  error: string | null;
}

export interface Adapter {
  name: string;
  run(input: AdapterInput): Promise<AdapterOutput>;
}

/**
 * A reported price is only usable if it is a finite, non-negative number. A
 * negative report would drive the run budget backwards and let a run outlive
 * its ceiling, so it is treated as 0 rather than trusted.
 */
export function clampCostUsd(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return value;
}

export interface ProcessRunOptions {
  cwd: string;
  timeoutSec: number;
  /** Run the command line through a shell. Used by the command adapter only. */
  shell?: boolean;
  /** Written to the child's stdin, then stdin is closed. Defaults to "". */
  input?: string;
}

export interface ProcessRunResult {
  stdout: string;
  stderr: string;
  /** Undefined when the child was killed by a signal or never started. */
  exitCode: number | undefined;
  /** True when this helper killed the process group because timeoutSec elapsed. */
  timedOut: boolean;
  /**
   * The errno code when the binary itself could not be spawned - "ENOENT" for a
   * missing binary. Null on any run that actually started.
   */
  spawnErrorCode: string | null;
}

/** How long a SIGTERM'd process group gets before it is SIGKILLed. */
const SIGKILL_GRACE_MS = 2_000;

function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    // Negative pid = the whole process group. `detached: true` below made the
    // child the group leader, so this reaches every descendant.
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone. Nothing to do.
    }
  }
}

// -- Parent-exit cleanup ----------------------------------------------------
//
// `detached: true` (see runProcess below) makes each child its own
// process-group leader. That is required for killGroup to reach grandchildren,
// but it comes at a cost documented by execa: `cleanup` (which would normally
// kill the child when this process exits) does not apply to detached
// children, and the child is no longer in this terminal's foreground process
// group, so a Ctrl-C here no longer reaches it either. Both mechanisms that
// used to stop a run when the parent went away are gone, so this module tracks
// every live child itself and kills its group on the parent's own exit,
// SIGINT, or SIGTERM.
const liveChildPids = new Set<number>();
let lifecycleHandlersInstalled = false;

function installLifecycleHandlersOnce(): void {
  if (lifecycleHandlersInstalled) return;
  lifecycleHandlersInstalled = true;

  const killAllLiveChildren = (signal: NodeJS.Signals): void => {
    for (const pid of liveChildPids) killGroup(pid, signal);
  };

  // Synchronous last resort: whatever caused this process to exit, nothing
  // tracked here should be left running. No time for a graceful SIGTERM here
  // - `exit` handlers cannot do async work - so this goes straight to SIGKILL.
  process.on("exit", () => killAllLiveChildren("SIGKILL"));

  // SIGINT/SIGTERM get a real handler so the signal is still acted on rather
  // than swallowed: clean up tracked children, then terminate this process
  // with the conventional exit code for the signal that arrived.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      killAllLiveChildren("SIGTERM");
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  }
}

/**
 * Spawn a child process with a timeout that actually aborts the run.
 *
 * execa's own `timeout` option signals the direct child only. That is not
 * enough: a grandchild inherits the stdout pipe, the pipe never closes, and
 * execa stays unresolved for the command's full duration. `timeoutSec: 2` on
 * something that backgrounds `sleep 30` finished at +30s and merely relabelled
 * the result as a timeout after the fact.
 *
 * So the child is spawned detached - making it a process-group leader - and on
 * timeout the whole group is SIGTERMed, then SIGKILLed if it is still alive.
 * Killing the group closes the inherited pipes, which is what lets the await
 * resolve at the deadline instead of at the command's natural end.
 *
 * `timedOut` is this helper's own flag, not execa's: the direct child often
 * exits 0 well before the deadline while an orphan keeps the run alive, so an
 * exit code of 0 says nothing about whether the run completed. Callers must
 * check `timedOut` before they interpret `exitCode`.
 */
export async function runProcess(
  file: string,
  args: string[],
  options: ProcessRunOptions,
): Promise<ProcessRunResult> {
  installLifecycleHandlersOnce();

  const child = execa(file, args, {
    cwd: options.cwd,
    reject: false,
    all: false,
    shell: options.shell ?? false,
    // Keep every run non-interactive: an open stdin can stall a CLI until the
    // timeout fires, which is indistinguishable from a hung model call.
    input: options.input ?? "",
    detached: true,
  });

  if (child.pid !== undefined) liveChildPids.add(child.pid);

  let timedOut = false;
  let escalation: NodeJS.Timeout | undefined;

  const deadline = setTimeout(
    () => {
      timedOut = true;
      killGroup(child.pid, "SIGTERM");
      escalation = setTimeout(() => killGroup(child.pid, "SIGKILL"), SIGKILL_GRACE_MS);
      escalation.unref();
    },
    Math.max(1, Math.round(options.timeoutSec * 1000)),
  );
  deadline.unref();

  try {
    const result = await child;
    const stdout = typeof result.stdout === "string" ? result.stdout : "";
    const stderr = typeof result.stderr === "string" ? result.stderr : "";
    const errno = (result as { code?: unknown }).code;
    const signal = (result as { signal?: unknown }).signal;
    // A spawn failure is the only case with no exit code, no signal and an
    // errno string - a timeout kill produces a signal instead.
    const spawnErrorCode =
      !timedOut && result.exitCode === undefined && signal === undefined && typeof errno === "string"
        ? errno
        : null;

    return { stdout, stderr, exitCode: result.exitCode, timedOut, spawnErrorCode };
  } finally {
    // `await child` only needs the direct child's pipes to close, which a
    // grandchild that ignores SIGTERM (and does not hold those pipes) has no
    // effect on. Clearing `deadline` is always safe - the run is over either
    // way - but `escalation`, when scheduled, must NOT be cleared here: it is
    // the only thing left that will still SIGKILL a stubborn grandchild after
    // this promise settles. It is unref'd and one-shot, so leaving it armed
    // costs nothing when the group already died from the SIGTERM.
    clearTimeout(deadline);
    if (child.pid !== undefined) liveChildPids.delete(child.pid);
  }
}
