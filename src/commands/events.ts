import { openLog, openStore } from "./context.js";

export interface EventsOptions {
  kind?: string;
}

export function eventsCommand(runId: string, options: EventsOptions): number {
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
