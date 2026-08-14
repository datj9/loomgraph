import { execa } from "execa";
import type { Adapter, AdapterInput, AdapterOutput } from "./types.js";

/**
 * Verified against codex-cli 0.145.0:
 *
 *   codex exec <prompt> --json --skip-git-repo-check -C <cwd>
 *
 * `--json` emits a stream of JSONL events, not a single object, so the parser
 * walks every line and keeps the last agent message it can recognise.
 */
export function buildCodexArgs(prompt: string, cwd: string): string[] {
  return ["exec", prompt, "--json", "--skip-git-repo-check", "-C", cwd];
}

/** Pull agent message text out of the several event shapes codex has shipped. */
function messageTextOf(event: Record<string, unknown>): string | null {
  const candidates: unknown[] = [event, event.msg, event.item];
  for (const candidate of candidates) {
    if (candidate === null || typeof candidate !== "object") continue;
    const obj = candidate as Record<string, unknown>;
    if (obj.type !== "agent_message") continue;
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.text === "string") return obj.text;
  }
  return null;
}

function numberField(event: Record<string, unknown>, field: string): number | null {
  const candidates: unknown[] = [event, event.msg, event.item, event.usage];
  for (const candidate of candidates) {
    if (candidate === null || typeof candidate !== "object") continue;
    const value = (candidate as Record<string, unknown>)[field];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

export function parseCodexJsonl(stdout: string): AdapterOutput {
  const events: Record<string, unknown>[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed !== null && typeof parsed === "object") events.push(parsed as Record<string, unknown>);
    } catch {
      // Codex interleaves non-JSON diagnostics on stdout; ignore what we cannot read.
    }
  }

  let text: string | null = null;
  let cumulativeUsd: number | null = null;
  let deltaUsd = 0;

  for (const event of events) {
    const message = messageTextOf(event);
    if (message !== null) text = message;

    const total = numberField(event, "total_cost_usd");
    if (total !== null) cumulativeUsd = total;
    const delta = numberField(event, "cost_usd");
    if (delta !== null) deltaUsd += delta;
  }

  // Codex normally reports no price at all. Record 0 rather than estimating one.
  const costUsd = cumulativeUsd ?? deltaUsd;

  if (text === null) {
    return {
      ok: false,
      text: "",
      costUsd,
      raw: events,
      error: `no agent message event found in codex output (${events.length} events parsed)`,
    };
  }

  return { ok: true, text, costUsd, raw: events, error: null };
}

/**
 * Decide the final result once the process has exited. Kept separate from
 * `run` so the exit-code policy is unit-testable without spawning codex.
 */
export function decideCodexResult(parsed: AdapterOutput, exitCode: number | undefined, stderr: string): AdapterOutput {
  const trimmed = stderr.trim();
  const failed = exitCode !== 0 && exitCode !== undefined;

  // A non-zero exit means the run did not complete, even when a partial agent
  // message made it into the stream. Do not report that as success.
  if (parsed.ok && failed) {
    return { ...parsed, ok: false, error: `codex exited ${exitCode}${trimmed ? `: ${trimmed}` : ""}` };
  }
  if (!parsed.ok && failed && trimmed) {
    return { ...parsed, error: `${parsed.error} (exit ${exitCode}: ${trimmed})` };
  }
  return parsed;
}

export class CodexAdapter implements Adapter {
  readonly name = "codex";

  constructor(private readonly bin = "codex") {}

  async run(input: AdapterInput): Promise<AdapterOutput> {
    const result = await execa(this.bin, buildCodexArgs(input.prompt, input.cwd), {
      cwd: input.cwd,
      timeout: input.timeoutSec * 1000,
      reject: false,
    });

    const stdout = typeof result.stdout === "string" ? result.stdout : "";
    const stderr = typeof result.stderr === "string" ? result.stderr : "";

    if (result.timedOut) {
      return { ok: false, text: stdout, costUsd: 0, raw: { stdout, stderr }, error: `timeout after ${input.timeoutSec}s` };
    }

    return decideCodexResult(parseCodexJsonl(stdout), result.exitCode, stderr);
  }
}
