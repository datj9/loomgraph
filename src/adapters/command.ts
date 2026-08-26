import { runProcess } from "./types.js";
import type { Adapter, AdapterInput, AdapterOutput } from "./types.js";

/**
 * Runs a shell command. `prompt` carries the command line - a command node has
 * no model behind it, so cost is always exactly 0.
 */
export class CommandAdapter implements Adapter {
  readonly name = "command";

  async run(input: AdapterInput): Promise<AdapterOutput> {
    const result = await runProcess(input.prompt, [], {
      cwd: input.cwd,
      timeoutSec: input.timeoutSec,
      shell: true,
    });

    const { stdout, stderr } = result;

    // The timeout check comes first on purpose: the shell can exit 0 long
    // before the deadline while a backgrounded grandchild keeps the run alive,
    // so a zero exit code says nothing about whether the run completed.
    if (result.timedOut) {
      return {
        ok: false,
        text: stdout,
        costUsd: 0,
        raw: { stdout, stderr, timedOut: true },
        error: `timeout after ${input.timeoutSec}s: ${input.prompt}`,
      };
    }

    if (result.exitCode !== 0) {
      const code = result.exitCode ?? "unknown";
      return {
        ok: false,
        text: stdout,
        costUsd: 0,
        raw: { stdout, stderr, exitCode: result.exitCode },
        error: `command exited with code ${code}: ${stderr.trim() || stdout.trim() || input.prompt}`,
      };
    }

    return {
      ok: true,
      text: stdout,
      costUsd: 0,
      raw: { stdout, stderr, exitCode: result.exitCode },
      error: null,
    };
  }
}
