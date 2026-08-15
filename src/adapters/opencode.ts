import { execa } from "execa";
import type { Adapter, AdapterInput, AdapterOutput } from "./types.js";

/**
 * Verified against opencode 1.18.17 on 2026-08-15:
 *
 *   opencode run --format json [-m <model>] <prompt>
 *
 * `--format json` emits JSONL - one event object per line, shaped
 * `{type, timestamp, sessionID, part: {...}}`. A one-word reply produces
 * `step_start` -> `text` (text in `part.text`) -> `step_finish`
 * (price in `part.cost`, tokens in `part.tokens`).
 *
 * The default format is used by nothing here on purpose: it writes prose to
 * stdout, the model banner to stderr, and carries no price at all. Under
 * `--format json` opencode reports a real cost, which is what makes this
 * adapter budget-enforceable rather than a permanent 0 in every ceiling.
 *
 * A model can only be chosen with `-m`. `OPENCODE_MODEL` is ignored, and with
 * no flag opencode's own resolution order decides - which is neither stable
 * nor inspectable from here.
 */
export function buildOpencodeArgs(prompt: string, model?: string): string[] {
  const args = ["run", "--format", "json"];
  if (model !== undefined) args.push("-m", model);
  args.push(prompt);
  return args;
}

/** One JSONL event. Only the fields this adapter reads are named. */
interface OpencodeEvent {
  type?: unknown;
  part?: { text?: unknown; cost?: unknown } | null;
}

/**
 * Walk the JSONL stream, concatenating `text` events and summing the price
 * every `step_finish` reports.
 *
 * Cost is summed even when the run failed, because budget accounting depends
 * on it. It is never estimated: an event that reports no price contributes 0.
 */
export function parseOpencodeJsonl(stdout: string, exitCode: number | null): AdapterOutput {
  const events: OpencodeEvent[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      // A line opencode wrote that is not an event object is noise, not data.
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        events.push(parsed as OpencodeEvent);
      }
    } catch {
      // Non-JSON lines on stdout are ignored rather than fatal - but if every
      // line is noise the caller still gets a failure, below.
    }
  }

  let text = "";
  let costUsd = 0;
  for (const event of events) {
    const part = event.part;
    if (event.type === "text" && part && typeof part.text === "string") text += part.text;
    if (part && typeof part.cost === "number") costUsd += part.cost;
  }

  if (events.length === 0) {
    return { ok: false, text: "", costUsd: 0, raw: stdout, error: "could not parse opencode json output: no events found" };
  }
  if (exitCode !== 0) {
    return { ok: false, text, costUsd, raw: stdout, error: `opencode exited with code ${exitCode ?? "unknown"}` };
  }
  if (text.trim().length === 0) {
    return { ok: false, text, costUsd, raw: stdout, error: "opencode produced no output" };
  }
  return { ok: true, text, costUsd, raw: stdout, error: null };
}

export class OpenCodeAdapter implements Adapter {
  readonly name = "opencode";

  constructor(private readonly bin = "opencode") {}

  async run(input: AdapterInput): Promise<AdapterOutput> {
    const result = await execa(this.bin, buildOpencodeArgs(input.prompt, input.model), {
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

    const parsed = parseOpencodeJsonl(stdout, result.exitCode ?? null);
    if (!parsed.ok && stderr.trim()) return { ...parsed, error: `${parsed.error}: ${stderr.trim()}` };
    return parsed;
  }
}
