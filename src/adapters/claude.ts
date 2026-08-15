import { execa } from "execa";
import type { Adapter, AdapterInput, AdapterOutput } from "./types.js";

/**
 * Verified against Claude Code 2.1.232:
 *
 *   claude -p <prompt> --output-format json --permission-mode acceptEdits --max-turns <n>
 *
 * stdout is a single JSON object with `subtype`, `result`, `session_id`,
 * `num_turns` and `total_cost_usd`.
 *
 * Claude Code 3.x emits a JSON *array* of message objects whose last
 * `type: "result"` element carries the run result, so the parser finds that
 * element before reading `subtype` and `total_cost_usd`.
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
      text: "",
      costUsd: 0,
      raw: null,
      error: `could not parse claude json output: ${stdout.slice(0, 200)}`,
    };
  }

  if (parsed === null || typeof parsed !== "object") {
    return { ok: false, text: stdout, costUsd: 0, raw: parsed, error: "could not parse claude json output: not an object" };
  }

  // Claude Code 3.x emits an array of messages; the run result is the last
  // element with `type: "result"`. The legacy single-object form is `result`
  // itself.
  let result: Record<string, unknown>;
  if (Array.isArray(parsed)) {
    const items = parsed as unknown[];
    let found: Record<string, unknown> | undefined;
    for (const item of items) {
      if (typeof item === "object" && item !== null && (item as Record<string, unknown>).type === "result") {
        found = item as Record<string, unknown>;
      }
    }
    if (found === undefined) {
      return { ok: false, text: "", costUsd: 0, raw: parsed, error: "could not parse claude json output: no result element in array" };
    }
    result = found;
  } else {
    result = parsed as Record<string, unknown>;
  }

  // Cost is harvested even on failure - budget accounting depends on it.
  const costUsd = typeof result.total_cost_usd === "number" ? result.total_cost_usd : 0;
  const text = typeof result.result === "string" ? result.result : "";

  // Claude Code can report `subtype: "success"` while `is_error` is true - an
  // expired OAuth session comes back exactly that way. Trusting subtype alone
  // makes an auth failure look like a completed agent run, so check both.
  if (result.is_error === true) {
    const reason = typeof result.subtype === "string" ? result.subtype : "is_error";
    return {
      ok: false,
      text,
      costUsd,
      raw: parsed,
      error: `claude run reported is_error (${reason}): ${text || "no message"}`,
    };
  }

  const subtype = typeof result.subtype === "string" ? result.subtype : "unknown";
  if (subtype !== "success") {
    return { ok: false, text, costUsd, raw: parsed, error: `claude run ended with subtype ${subtype}` };
  }

  return { ok: true, text, costUsd, raw: parsed, error: null };
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
      // Keep the run non-interactive: an open stdin can stall the CLI until the
      // node's timeout fires, which is indistinguishable from a hung model call.
      input: "",
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
