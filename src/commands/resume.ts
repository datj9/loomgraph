import { defaultRegistry } from "../adapters/registry.js";
import { execute } from "../core/engine.js";
import { parseGraph } from "../core/graph.js";
import { formatEventLine, openLog, openStore } from "./context.js";
import { exitCodeFor, parseVars, renderStatus } from "./render.js";

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
    humanAnswers = parseVars(options.answer ?? []);
  } catch (err) {
    console.error(`--answer expects nodeId=text: ${(err as Error).message}`);
    return 1;
  }

  const graph = parseGraph(source, `${runId}/graph.yaml`);
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
