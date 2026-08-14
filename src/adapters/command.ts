import { execa } from "execa";
import type { Adapter, AdapterInput, AdapterOutput } from "./types.js";

/**
 * Runs a shell command. `prompt` carries the command line - a command node has
 * no model behind it, so cost is always exactly 0.
 */
export class CommandAdapter implements Adapter {
  readonly name = "command";

  async run(input: AdapterInput): Promise<AdapterOutput> {
    const result = await execa(input.prompt, {
      shell: true,
      cwd: input.cwd,
      timeout: input.timeoutSec * 1000,
      reject: false,
      all: false,
    });

    const stdout = typeof result.stdout === "string" ? result.stdout : "";
    const stderr = typeof result.stderr === "string" ? result.stderr : "";

    if (result.timedOut) {
      return {
        ok: false,
        text: stdout,
        costUsd: 0,
        raw: { stdout, stderr, timedOut: true },
        error: `timeout after ${input.timeoutSec}s: ${input.prompt}`,
      };
    }

    if (result.failed || result.exitCode !== 0) {
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
