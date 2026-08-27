import { readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { defaultRegistry } from "../adapters/registry.js";
import { execute, makeRunId, newRunState } from "../core/engine.js";
import { parseGraph } from "../core/graph.js";
import { makeRunBatcher, type BatchCtx } from "../team/batch.js";
import { loadHubConfig, type Fetch } from "../team/transport.js";
import { formatEventLine, openLog, openStore } from "./context.js";
import { exitCodeFor, parseVars, renderPlan, renderStatus } from "./render.js";

export interface RunOptions {
  var: string[];
  maxUsd?: string;
  dryRun?: boolean;
}

/** Injectable deps. Production leaves `f` unset so the global fetch is used. */
export interface RunCommandDeps {
  f?: Fetch;
}

export async function runCommand(file: string, options: RunOptions, deps: RunCommandDeps = {}): Promise<number> {
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
  const home = homedir();
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

  // A1 is enforced by makeRunBatcher: when the hub is unconfigured or the repo
  // has not opted in, this is a no-op that never touches the Fetch, so an
  // unenrolled machine cannot hang on a hub address. An active batcher can
  // still neither throw into the engine nor change a checkpoint: onEvent stays
  // synchronous, and flush() is bounded and never rejects.
  const batcher = makeRunBatcher({
    cfg: loadHubConfig(process.env, home),
    cwd,
    f: deps.f ?? (globalThis.fetch as Fetch),
    ctx: {
      runId,
      store,
      opts: { home, username: userInfo().username, repoRoot: cwd },
    } satisfies BatchCtx,
  });

  const final = await execute(graph, state, {
    store,
    log,
    registry: defaultRegistry(),
    onEvent: (event) => {
      const line = formatEventLine(event);
      if (line) console.log(line);
      batcher.onEvent(event);
    },
  });

  // The final flush is bounded and never rejects, so a hung hub can delay the
  // run by at most the flush ceiling and can never change its outcome.
  await batcher.flush();
  batcher.stop();

  console.log("");
  console.log(renderStatus(final));
  return exitCodeFor(final, log.read(runId));
}
