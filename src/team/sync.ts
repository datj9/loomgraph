import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EventLog } from "../core/events.js";
import type { RunState } from "../core/types.js";
import type { EventBatch } from "../hub/wire.js";
import { projectState } from "./project.js";
import { postEvents, type Fetch, type HubConfig } from "./transport.js";

/** At most this many event lines per request. */
const BATCH_LIMIT = 500;

/** The projection opts `projectState` requires; mirrored so callers name it once. */
export interface ProjectionOpts {
  home: string;
  username: string;
  repoRoot: string;
}

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
 * Assemble one push: `runId`, `streamId` and `graphName` come from the loaded
 * RunState, `state` is the projected projection, and `events` are the verbatim
 * lines chosen by `pendingLines`. The projection is recomputed per batch so the
 * `updatedAt`/`seq` the hub hears tracks the state that was current for that
 * window.
 */
export function buildBatch(state: RunState, opts: ProjectionOpts, lines: string[]): EventBatch {
  return {
    runId: state.runId,
    streamId: state.streamId,
    graphName: state.graphName,
    state: projectState(state, opts),
    events: lines,
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
 * read with `EventLog.read` - the only file sync writes is the cursor under
 * `.loomgraph/sync/`; nothing under `runs/` is ever touched.
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