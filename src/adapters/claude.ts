import { execa } from "execa";
import type { Adapter, AdapterInput, AdapterOutput } from "./types.js";

/**
 * Verified against Claude Code 2.1.232:
 *
 *   claude -p <prompt> --output-format json --permission-mode acceptEdits --max-turns <n>
 *
 * stdout is a single JSON object with `subtype`, `result`, `session_id`,
 * `num_turns` and `total_cost_usd`.
 */
export function buildClaudeArgs(prompt: string, maxTurns?: number): string[] {
  const args = ["-p", prompt, "--output-format", "json", "--permission-mode", "acceptEdits"];
  if (maxTurns !== undefined) args.push("--max-turns", String(maxTurns));
  return args;
}

export function parseClaudeJson(stdout: string): AdapterOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return {
      ok: false,
      text: stdout,
      costUsd: 0,
      raw: stdout,
      error: `could not parse claude json output: ${stdout.slice(0, 200)}`,
    };
  }

  if (parsed === null || typeof parsed !== "object") {
    return { ok: false, text: stdout, costUsd: 0, raw: parsed, error: "could not parse claude json output: not an object" };
  }

  const obj = parsed as Record<string, unknown>;
  const cost = typeof obj.total_cost_usd === "number" ? obj.total_cost_usd : 0;
  const text = typeof obj.result === "string" ? obj.result : "";
  const subtype = typeof obj.subtype === "string" ? obj.subtype : "unknown";

  if (subtype !== "success") {
    return { ok: false, text, costUsd: cost, raw: parsed, error: `claude run ended with subtype ${subtype}` };
  }

  return { ok: true, text, costUsd: cost, raw: parsed, error: null };
}

export class ClaudeAdapter implements Adapter {
  readonly name = "claude";

  constructor(private readonly bin = "claude") {}

  async run(input: AdapterInput): Promise<AdapterOutput> {
    const args = buildClaudeArgs(input.prompt, input.maxTurns);
    const result = await execa(this.bin, args, {
      cwd: input.cwd,
      timeout: input.timeoutSec * 1000,
      reject: false,
    });

    const stdout = typeof result.stdout === "string" ? result.stdout : "";
    const stderr = typeof result.stderr === "string" ? result.stderr : "";

    if (result.timedOut) {
      return { ok: false, text: stdout, costUsd: 0, raw: { stdout, stderr }, error: `timeout after ${input.timeoutSec}s` };
    }

    const parsed = parseClaudeJson(stdout);
    // Cost is recorded even on failure - budget accounting depends on it.
    if (!parsed.ok && result.exitCode !== 0 && stderr.trim()) {
      return { ...parsed, error: `${parsed.error} (exit ${result.exitCode}: ${stderr.trim()})` };
    }
    return parsed;
  }
}
