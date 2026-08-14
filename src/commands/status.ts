import { openStore } from "./context.js";
import { renderRuns, renderStatus } from "./render.js";

export function statusCommand(runId: string): number {
  const store = openStore();
  const state = store.load(runId);
  if (!state) {
    console.error(`no checkpoint found for run "${runId}" - try: lg ls`);
    return 1;
  }
  console.log(renderStatus(state));
  return 0;
}

export function lsCommand(): number {
  const store = openStore();
  const states = store
    .list()
    .map((runId) => store.load(runId))
    .filter((s): s is NonNullable<typeof s> => s !== null)
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  console.log(renderRuns(states));
  return 0;
}
