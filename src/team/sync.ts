import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EventLog, type LgEventKind } from "../core/events.js";
import type { RunState } from "../core/types.js";
import type { EventBatch } from "../hub/wire.js";
import { projectState, safeText, type ProjectionIdentity } from "./project.js";
import { postEvents, type Fetch, type HubConfig } from "./transport.js";

/** At most this many event lines per request. */
const BATCH_LIMIT = 500;

/**
 * The identity `projectState` and `sanitizeEventLine` both need. An alias, not
 * a second declaration: two copies would let one gain a field the other lacks,
 * which is precisely how `hostname` came to be missing here while
 * `rewritePaths` had accepted it all along.
 */
export type ProjectionOpts = ProjectionIdentity;

/** What `readCursor` returns: the highest event seq the hub has acked. */
export interface Cursor {
  ackedSeq: number;
}

function cursorPath(cwd: string, runId: string): string {
  return join(cwd, ".loomgraph", "sync", `${runId}.cursor`);
}

/**
 * A CORRUPT CURSOR MEANS ABSENT. Truncated, empty, non-JSON, a string
 * `ackedSeq`, or a negative / non-integer value all read as null, and sync
 * resends from the start. The server is idempotent by primary key, so resending
 * is free, whereas trusting a garbage value would skip events permanently.
 *
 * NEVER throws - one bad byte must not break a sync.
 */
export function readCursor(cwd: string, runId: string): Cursor | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(cursorPath(cwd, runId), "utf8"));
    if (parsed === null || typeof parsed !== "object") return null;
    const n = (parsed as Record<string, unknown>).ackedSeq;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) return null;
    return { ackedSeq: n };
  } catch {
    return null;
  }
}

/**
 * Temp-then-rename, exactly as CheckpointStore.save does it: write
 * `<path>.tmp`, then rename over the target, so a process killed between the
 * write and the rename leaves only a stray `.tmp`, never a torn cursor.
 *
 * NO LOCK FILES. Concurrent writers are safe by temp-then-rename plus server
 * idempotency - the last writer wins and either batch covers the same run.
 * Do not add locking here.
 */
export function writeCursor(cwd: string, runId: string, ackedSeq: number): void {
  const dir = join(cwd, ".loomgraph", "sync");
  mkdirSync(dir, { recursive: true });
  const target = cursorPath(cwd, runId);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ ackedSeq })}\n`, "utf8");
  renameSync(tmp, target);
}

/**
 * The lines that still need pushing: those whose seq is strictly above
 * `ackedSeq`. An unreadable line is not one we can ack, so it is left out of
 * the batch rather than risking a stale ack over something we could not parse.
 */
export function pendingLines(lines: string[], ackedSeq: number): string[] {
  const pending: string[] = [];
  for (const line of lines) {
    try {
      const parsed: unknown = JSON.parse(line);
      const seq = (parsed as { seq?: unknown }).seq;
      if (typeof seq === "number" && seq > ackedSeq) pending.push(line);
    } catch {
      // Not a line we can ack; never trust an unparsed line to skip anything.
    }
  }
  return pending;
}

/**
 * WHICH `data` FIELDS EACH EVENT KIND MAY PUBLISH, AND HOW.
 *
 * The same hand-written allowlist discipline `projectState` uses, for the same
 * reason and with the same rule: a future content-carrying field must not
 * silently start publishing itself. Every field is named here; anything not
 * named is DROPPED from the pushed line. Never replace this with a generic walk
 * over `data`, and never add a field without deciding which column it belongs
 * in.
 *
 *   "pass"  the value is an engine- or graph-derived identifier, enum, number
 *           or boolean. It carries no operator content, and the projection
 *           already publishes the same class of fact (node ids, graph name,
 *           costs, budgets). Copied as-is.
 *   "text"  the value is operator- or environment-derived text: an adapter
 *           error (which can be a whole agent result or a raw stderr dump), an
 *           absolute cwd, an INTERPOLATED human question (`{{vars.x}}` and
 *           `{{nodes.x.output}}` already substituted), or a typed answer. Run
 *           through `safeText` - the same rewrite/mask/cap the projection
 *           applies to a node error.
 *
 * `budget_exceeded.reason` is engine-generated and could be "pass"; it is
 * "text" because it costs nothing and a string that reaches the wire should
 * have gone through the sanitiser unless there is a reason it cannot.
 */
const EVENT_DATA_ALLOWLIST: Record<LgEventKind, Record<string, "pass" | "text">> = {
  run_started: { graph: "pass", resumed: "pass", cwd: "text", streamId: "pass" },
  node_started: { attempt: "pass", type: "pass" },
  node_finished: { status: "pass", attempts: "pass", costUsd: "pass", error: "text" },
  edge_crossed: { from: "pass", to: "pass", when: "pass" },
  budget_checked: { spent: "pass", budget: "pass", ready: "pass" },
  budget_exceeded: { reason: "text", spent: "pass", budget: "pass" },
  human_requested: { question: "text" },
  human_resolved: { answer: "text" },
  run_finished: { status: "pass", error: "text", spent: "pass" },
};

function isEventKind(value: unknown): value is LgEventKind {
  return typeof value === "string" && value in EVENT_DATA_ALLOWLIST;
}

/**
 * SANITISE ONE EVENT LINE FOR THE WIRE. THE LOCAL LOG IS NEVER TOUCHED.
 *
 * `.loomgraph/runs/<id>/events.jsonl` stays raw and complete - that is the
 * author's own debugging record and it must keep full fidelity. This transform
 * runs at PUSH time, on the copy that crosses to the hub, so `lg-hub export`
 * still reproduces the INGESTED lines byte for byte; those lines simply stop
 * carrying secrets.
 *
 * The event object is rebuilt field by field rather than mutated, for the same
 * reason `projectState` is: no spread, no delete, no unknown key riding along.
 *
 * Returns null when the line cannot be classified - unparseable, not an object,
 * or an unrecognised kind. An unclassifiable line is DROPPED, never passed
 * through: a kind this function does not know is a kind whose `data` nobody has
 * reviewed. Dropping costs an audit line; passing through costs a leak.
 */
export function sanitizeEventLine(line: string, opts: ProjectionOpts): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const event = parsed as Record<string, unknown>;
  if (!isEventKind(event.kind)) return null;

  const fields = EVENT_DATA_ALLOWLIST[event.kind];
  const raw = event.data;
  const source: Record<string, unknown> =
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  const data: Record<string, unknown> = {};
  for (const [key, handling] of Object.entries(fields)) {
    if (!(key in source)) continue;
    const value = source[key];
    if (handling === "pass") {
      data[key] = value;
      continue;
    }
    // "text": a value that is neither a string nor null is a field whose shape
    // changed under us, so it is dropped rather than published unsanitised.
    if (value === null) data[key] = null;
    else if (typeof value === "string") data[key] = safeText(value, opts);
  }

  // Same key order the engine writes (`src/core/events.ts`), so an event with
  // nothing to sanitise serialises byte-identically to its local log line.
  return JSON.stringify({
    ts: event.ts,
    runId: event.runId,
    seq: event.seq,
    kind: event.kind,
    ...(typeof event.nodeId === "string" ? { nodeId: event.nodeId } : {}),
    data,
  });
}

/**
 * Assemble one push: `runId`, `streamId` and `graphName` come from the loaded
 * RunState, `state` is the projected projection, and `events` are the lines
 * chosen by `pendingLines`, each sanitised for the wire. The projection is
 * recomputed per batch so the `updatedAt`/`seq` the hub hears tracks the state
 * that was current for that window.
 *
 * SANITISING HAPPENS HERE, not in `syncRun`, because `buildBatch` is the single
 * choke point both push paths go through: `lg sync` and the live `LiveBatcher`
 * in `./batch.ts`. Moving it up into `syncRun` would leave the live stream
 * publishing raw lines.
 */
export function buildBatch(state: RunState, opts: ProjectionOpts, lines: string[]): EventBatch {
  const events: string[] = [];
  for (const line of lines) {
    const safe = sanitizeEventLine(line, opts);
    if (safe !== null) events.push(safe);
  }

  return {
    runId: state.runId,
    streamId: state.streamId,
    graphName: state.graphName,
    state: projectState(state, opts),
    events,
  };
}

export interface SyncDeps {
  f: Fetch;
  cfg: HubConfig;
  /** Repo root; holds `.loomgraph/sync/<runId>.cursor`. */
  cwd: string;
  /** EventLog root; production passes `<cwd>/.loomgraph/runs/`. */
  eventRoot: string;
  runId: string;
  state: RunState;
  opts: ProjectionOpts;
  timeoutMs?: number;
}

export type SyncResult = { ok: true; ackedSeq: number } | { ok: false; error: string };

/**
 * Push a whole run to the hub in windows of at most 500 lines. Local events are
 * read with `EventLog.read` and sanitised by `buildBatch` on the way out - the
 * only file sync writes is the cursor under `.loomgraph/sync/`; nothing under
 * `runs/` is ever touched, and the log on disk keeps its raw values.
 *
 * The cursor advances ONLY on a 2xx naming `highWaterSeq`. Any `{ok:false}`
 * leaves the cursor exactly as it was, so a cut mid-batch resends the same
 * lines next time - resending is free because the server is idempotent by
 * primary key.
 */
export async function syncRun(deps: SyncDeps): Promise<SyncResult> {
  const lines = new EventLog(deps.eventRoot).read(deps.runId).map((e) => JSON.stringify(e));
  const cursor = readCursor(deps.cwd, deps.runId);
  const acked = cursor === null ? -1 : cursor.ackedSeq;
  const pending = pendingLines(lines, acked);

  let lastAcked = acked;
  for (let i = 0; i < pending.length; i += BATCH_LIMIT) {
    const chunk = pending.slice(i, i + BATCH_LIMIT);
    const batch = buildBatch(deps.state, deps.opts, chunk);
    const result = await postEvents(deps.f, deps.cfg, batch, deps.timeoutMs ?? 10_000);
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    lastAcked = result.highWaterSeq;
    writeCursor(deps.cwd, deps.runId, result.highWaterSeq);
  }

  return { ok: true, ackedSeq: lastAcked };
}