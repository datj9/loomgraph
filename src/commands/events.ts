import { openLog, openStore } from "./context.js";

/**
 * The complete, documented set of event kinds. `lg events --kind` accepts
 * exactly these strings; anything else is a typo, not an empty result.
 */
export const EVENT_KINDS = [
  "run_started",
  "node_started",
  "node_finished",
  "edge_crossed",
  "budget_checked",
  "budget_exceeded",
  "human_requested",
  "human_resolved",
  "run_finished",
] as const;

export interface EventsOptions {
  kind?: string;
}

export function eventsCommand(runId: string, options: EventsOptions): number {
  if (options.kind !== undefined && !(EVENT_KINDS as readonly string[]).includes(options.kind)) {
    console.error(
      `unknown event kind "${options.kind}" - valid kinds: ${EVENT_KINDS.join(", ")}`,
    );
    return 1;
  }

  if (!openStore().load(runId)) {
    console.error(`no checkpoint found for run "${runId}" - try: lg ls`);
    return 1;
  }

  const events = openLog()
    .read(runId)
    .filter((e) => options.kind === undefined || e.kind === options.kind);

  for (const event of events) console.log(JSON.stringify(event));
  return 0;
}
