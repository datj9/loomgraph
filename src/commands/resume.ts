import { defaultRegistry } from "../adapters/registry.js";
import { execute, readySet } from "../core/engine.js";
import { parseGraph } from "../core/graph.js";
import { formatEventLine, openLog, openStore } from "./context.js";
import { exitCodeFor, renderStatus } from "./render.js";

export interface ResumeOptions {
  answer: string[];
}

export async function resumeCommand(runId: string, options: ResumeOptions): Promise<number> {
  const store = openStore();
  const log = openLog();

  const state = store.load(runId);
  if (!state) {
    console.error(`no checkpoint found for run "${runId}" - try: lg ls`);
    return 1;
  }
  if (state.status === "succeeded" || state.status === "failed") {
    console.error(`run "${runId}" is already ${state.status} and cannot be resumed`);
    return 1;
  }

  const source = store.loadGraphSource(runId);
  if (!source) {
    console.error(`run "${runId}" has no stored graph - cannot resume`);
    return 1;
  }

  let humanAnswers: Record<string, string>;
  try {
    humanAnswers = {};
    for (const pair of options.answer ?? []) {
      const eq = pair.indexOf("=");
      if (eq <= 0) throw new Error(`--answer expects nodeId=text, got "${pair}"`);
      humanAnswers[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }

  const graph = parseGraph(source, `${runId}/graph.yaml`);

  const awaiting = readySet(graph, state).filter((id) => graph.nodes[id]!.type === "human");
  for (const nodeId of Object.keys(humanAnswers)) {
    if (graph.nodes[nodeId] === undefined) {
      console.error(`--answer: no node "${nodeId}" in this run`);
      return 1;
    }
    if (!awaiting.includes(nodeId)) {
      console.error(`--answer: node "${nodeId}" is not awaiting an answer`);
      return 1;
    }
  }

  const final = await execute(graph, state, {
    store,
    log,
    registry: defaultRegistry(),
    humanAnswers,
    onEvent: (event) => {
      const line = formatEventLine(event);
      if (line) console.log(line);
    },
  });

  console.log("");
  console.log(renderStatus(final));
  return exitCodeFor(final, log.read(runId));
}
