// Untested against a real opencode binary - not installed in the development environment.
import { execa } from "execa";
import type { Adapter, AdapterInput, AdapterOutput } from "./types.js";

/** `opencode run <prompt>`, executed in the node's cwd. */
export function buildOpencodeArgs(prompt: string): string[] {
  return ["run", prompt];
}

/**
 * OpenCode prints plain text and reports no price, so cost is always 0. Do not
 * substitute an estimate.
 */
export function parseOpencodeStdout(stdout: string, exitCode: number | null): AdapterOutput {
  const text = stdout.trim();

  if (exitCode !== 0) {
    return { ok: false, text, costUsd: 0, raw: stdout, error: `opencode exited with code ${exitCode ?? "unknown"}` };
  }
  if (text.length === 0) {
    return { ok: false, text, costUsd: 0, raw: stdout, error: "opencode produced no output" };
  }
  return { ok: true, text, costUsd: 0, raw: stdout, error: null };
}

export class OpenCodeAdapter implements Adapter {
  readonly name = "opencode";

  constructor(private readonly bin = "opencode") {}

  async run(input: AdapterInput): Promise<AdapterOutput> {
    const result = await execa(this.bin, buildOpencodeArgs(input.prompt), {
      cwd: input.cwd,
      timeout: input.timeoutSec * 1000,
      reject: false,
      // Keep the run non-interactive - an open stdin can stall the CLI.
      input: "",
    });

    const stdout = typeof result.stdout === "string" ? result.stdout : "";
    const stderr = typeof result.stderr === "string" ? result.stderr : "";

    if (result.timedOut) {
      return { ok: false, text: stdout, costUsd: 0, raw: { stdout, stderr }, error: `timeout after ${input.timeoutSec}s` };
    }

    const parsed = parseOpencodeStdout(stdout, result.exitCode ?? null);
    if (!parsed.ok && stderr.trim()) return { ...parsed, error: `${parsed.error}: ${stderr.trim()}` };
    return parsed;
  }
}
