import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type LgEventKind =
  | "run_started"
  | "node_started"
  | "node_finished"
  | "edge_crossed"
  | "budget_checked"
  | "budget_exceeded"
  | "human_requested"
  | "human_resolved"
  | "run_finished";

export interface LgEvent {
  ts: string; // ISO
  runId: string;
  seq: number;
  kind: LgEventKind;
  nodeId?: string;
  data: Record<string, unknown>;
}

/** The parts of an event a caller supplies; ts/runId/seq are stamped by the log. */
export interface LgEventInput {
  kind: LgEventKind;
  nodeId?: string;
  data: Record<string, unknown>;
}

/**
 * Append-only JSONL audit trail, one file per run:
 *
 *   <rootDir>/<runId>/events.jsonl
 *
 * Writes are unbuffered `appendFileSync` calls so a killed process still leaves
 * a complete, readable log behind. `seq` continues from whatever is already on
 * disk, so a resumed run does not restart the numbering.
 */
export class EventLog {
  private readonly nextSeq = new Map<string, number>();

  constructor(private readonly rootDir: string) {}

  private logPath(runId: string): string {
    return join(this.rootDir, runId, "events.jsonl");
  }

  append(runId: string, input: LgEventInput): LgEvent {
    let seq = this.nextSeq.get(runId);
    if (seq === undefined) seq = this.read(runId).length;

    const event: LgEvent = {
      ts: new Date().toISOString(),
      runId,
      seq,
      kind: input.kind,
      ...(input.nodeId === undefined ? {} : { nodeId: input.nodeId }),
      data: input.data,
    };

    mkdirSync(join(this.rootDir, runId), { recursive: true });
    appendFileSync(this.logPath(runId), `${JSON.stringify(event)}\n`, "utf8");
    this.nextSeq.set(runId, seq + 1);
    return event;
  }

  /** Parse the log back. Unparseable lines are skipped, never thrown on. */
  read(runId: string): LgEvent[] {
    const path = this.logPath(runId);
    if (!existsSync(path)) return [];

    const events: LgEvent[] = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as LgEvent);
      } catch {
        // A torn or corrupt line must not take down the audit trail.
      }
    }
    return events;
  }
}
