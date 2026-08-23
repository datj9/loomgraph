import { clampCostUsd, runProcess } from "./types.js";
import type { Adapter, AdapterInput, AdapterOutput } from "./types.js";

/**
 * Verified against codex-cli 0.145.0:
 *
 *   codex exec <prompt> --json --skip-git-repo-check --sandbox read-only -C <cwd>
 *
 * `--json` emits a stream of JSONL events, not a single object, so the parser
 * walks every line and keeps the last agent message it can recognise.
 *
 * `--sandbox read-only` matters: without an explicit sandbox policy codex can
 * block on an approval prompt it cannot show in a non-interactive run. A
 * verifier node only ever needs to read the tree, so read-only is both the safe
 * and the correct policy here.
 *
 * The caller must also close stdin - codex prints "Reading additional input
 * from stdin..." and waits forever when stdin stays open, which looks exactly
 * like a hung model call.
 */
/**
 * How codex should sandbox the commands it runs.
 *
 * `read-only` is the default and the right policy for a verifier node. Use
 * `bypass` only where the host is already isolated - some containers cannot
 * start codex's bwrap sandbox at all and fail with
 * "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted", which makes
 * every repository read fail and the review useless.
 */
const CODEX_SANDBOXES = ["read-only", "workspace-write", "bypass"] as const;

export type CodexSandbox = (typeof CODEX_SANDBOXES)[number];

/**
 * Validate the LOOMGRAPH_CODEX_SANDBOX override rather than casting it.
 * An unvalidated cast lets a typo through in both directions: an invented
 * value like "danger-full-access" reads as a wider policy that is never
 * applied, and "READ-ONLY" reaches codex verbatim and fails inside it. Fail
 * here instead, naming the three values that work.
 */
export function resolveCodexSandbox(raw: string | undefined | null): CodexSandbox {
  const value = (raw ?? "").trim();
  if (value.length === 0) return "read-only";
  const match = CODEX_SANDBOXES.find((candidate) => candidate === value);
  if (match === undefined) {
    throw new Error(
      `invalid LOOMGRAPH_CODEX_SANDBOX "${raw}" - valid values are ${CODEX_SANDBOXES.join(", ")}`,
    );
  }
  return match;
}

export function buildCodexArgs(
  prompt: string,
  cwd: string,
  sandbox: CodexSandbox = "read-only",
  model?: string,
): string[] {
  const policy =
    sandbox === "bypass" ? ["--dangerously-bypass-approvals-and-sandbox"] : ["--sandbox", sandbox];
  const chosen = model === undefined ? [] : ["--model", model];
  return ["exec", prompt, "--json", "--skip-git-repo-check", ...policy, ...chosen, "-C", cwd];
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
  // A negative report is treated as 0 - it must never drive the budget back.
  const costUsd = clampCostUsd(cumulativeUsd ?? deltaUsd);

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
 * A broken codex sandbox makes every repository read fail with a bubblewrap
 * diagnostic like "bwrap: loopback: Failed RTM_NEWADDR: Operation not
 * permitted". bwrap fails per TOOL CALL rather than at startup, so codex keeps
 * talking, exits 0, and can hand back a confident "PASS" from a verifier that
 * read nothing at all. Trusting the exit code lets that through, so the
 * diagnostic is looked for explicitly on both streams.
 *
 * Matching is anchored to a line that starts with "bwrap:" - that is the shape
 * bubblewrap writes - so an agent message that merely discusses bwrap in prose
 * does not fail the node.
 */
export function detectSandboxFailure(text: string): string | null {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("bwrap:")) return trimmed;
  }
  return null;
}

function sandboxFailureMessage(stderr: string, stdout: string): string | null {
  const line = detectSandboxFailure(stderr) ?? detectSandboxFailure(stdout);
  if (line === null) return null;
  return (
    `codex sandbox failed (${line}) - the verifier could not read the tree, so its verdict means nothing; ` +
    `set LOOMGRAPH_CODEX_SANDBOX=bypass only on an already isolated host`
  );
}

/**
 * Decide the final result once the process has exited. Kept separate from
 * `run` so the exit-code policy is unit-testable without spawning codex.
 */
export function decideCodexResult(
  parsed: AdapterOutput,
  exitCode: number | undefined,
  stderr: string,
  stdout = "",
): AdapterOutput {
  // Check the sandbox before the exit code: a broken sandbox fails every read
  // even when codex exits 0 and the agent message contains the pass string.
  const sandbox = sandboxFailureMessage(stderr, stdout);
  if (sandbox !== null) {
    return { ...parsed, ok: false, error: sandbox };
  }

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

  constructor(
    private readonly bin = "codex",
    private readonly sandbox: CodexSandbox = resolveCodexSandbox(process.env.LOOMGRAPH_CODEX_SANDBOX),
  ) {}

  async run(input: AdapterInput): Promise<AdapterOutput> {
    const result = await runProcess(
      this.bin,
      buildCodexArgs(input.prompt, input.cwd, this.sandbox, input.model),
      { cwd: input.cwd, timeoutSec: input.timeoutSec },
    );

    const { stdout, stderr } = result;

    // Name the binary rather than letting an empty stdout surface as a parse
    // failure with no clue about what is missing.
    if (result.spawnErrorCode === "ENOENT") {
      return { ok: false, text: "", costUsd: 0, raw: { stdout, stderr }, error: `${this.bin} not found on PATH` };
    }

    if (result.timedOut) {
      return { ok: false, text: stdout, costUsd: 0, raw: { stdout, stderr }, error: `timeout after ${input.timeoutSec}s` };
    }

    return decideCodexResult(parseCodexJsonl(stdout), result.exitCode, stderr, stdout);
  }
}
