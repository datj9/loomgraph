import { readFileSync } from "node:fs";
import { defaultRegistry } from "../adapters/registry.js";
import { execute, makeRunId, newRunState } from "../core/engine.js";
import { parseGraph } from "../core/graph.js";
import { formatEventLine, openLog, openStore } from "./context.js";
import { exitCodeFor, parseVars, renderPlan, renderStatus } from "./render.js";

export interface RunOptions {
  var: string[];
  maxUsd?: string;
  dryRun?: boolean;
}

export async function runCommand(file: string, options: RunOptions): Promise<number> {
  let source: string;
  try {
    source = readFileSync(file, "utf8");
  } catch (err) {
    console.error(`cannot read ${file}: ${(err as Error).message}`);
    return 1;
  }

  let graph;
  let vars: Record<string, string>;
  try {
    graph = parseGraph(source, file);
    vars = parseVars(options.var ?? []);
  } catch (err) {
    console.error(`${(err as Error).message}`);
    return 1;
  }

  if (options.dryRun) {
    console.log(renderPlan(graph));
    return 0;
  }

  const cwd = process.cwd();
  const store = openStore(cwd);
  const log = openLog(cwd);
  const runId = makeRunId(graph.name);
  const state = newRunState(graph, { runId, cwd, vars });

  if (options.maxUsd !== undefined) {
    const maxUsd = Number(options.maxUsd);
    if (!Number.isFinite(maxUsd) || maxUsd <= 0) {
      console.error(`--max-usd expects a positive number, got "${options.maxUsd}"`);
      return 1;
    }
    state.budget = { ...state.budget, maxUsd };
  }

  store.saveGraphSource(runId, source);

  const final = await execute(graph, state, {
    store,
    log,
    registry: defaultRegistry(),
    onEvent: (event) => {
      const line = formatEventLine(event);
      if (line) console.log(line);
    },
  });

  console.log("");
  console.log(renderStatus(final));
  return exitCodeFor(final, log.read(runId));
}
