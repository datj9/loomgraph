import { mkdirSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import type { CheckpointStore } from "../core/store.js";
import { syncRun, type ProjectionOpts } from "../team/sync.js";
import { loadHubConfig, type Fetch, type HubConfig } from "../team/transport.js";
import { openStore, runsDir } from "./context.js";

/**
 * EXIT CODES - `lg sync` owns 0, 1 and 2, and nothing else:
 *   0  everything synced (or `--enable` succeeded)
 *   1  usage error: no runId and no --all and no --enable, a runId and --all
 *      together, an unknown runId, or the hub is not configured
 *   2  at least one sync failed
 * Never 3 or 4 - those are budget-exceeded and paused, and they belong to
 * `lg run`.
 */
export interface SyncOptions {
  runId?: string;
  all?: boolean;
  enable?: boolean;
  /** Injectable in tests; production leaves these unset. */
  cwd?: string;
  home?: string;
  username?: string;
  env?: NodeJS.ProcessEnv;
  f?: Fetch;
}

const SYNC_TIMEOUT_MS = 10_000;

interface RunSyncContext {
  f: Fetch;
  cfg: HubConfig;
  eventRoot: string;
  store: CheckpointStore;
  cwd: string;
  projection: ProjectionOpts;
}

export async function syncCommand(opts: SyncOptions = {}): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();

  if (opts.enable) {
    // The repo opt-in is `<cwd>/.loomgraph/hub.json`, holding only
    // `{"sync": true}` and never a token - the identity is enrolled in the
    // user's home. Rewriting the same constant bytes is idempotent: running
    // it twice leaves the exact same file and still returns 0.
    mkdirSync(join(cwd, ".loomgraph"), { recursive: true });
    writeFileSync(join(cwd, ".loomgraph", "hub.json"), '{"sync":true}\n', { encoding: "utf8" });
    console.log(`hub sync enabled for ${cwd}`);
    return 0;
  }

  if (opts.runId !== undefined && opts.all) {
    console.error("lg sync accepts a run id or --all, not both");
    return 1;
  }
  if (opts.runId === undefined && !opts.all) {
    console.error("nothing to sync - pass a run id, or --all (and --enable to opt a repo in first)");
    return 1;
  }

  const home = opts.home ?? homedir();
  const cfg = loadHubConfig(opts.env ?? process.env, home);
  if (cfg === null) {
    console.error("hub not configured - run: lg enroll <url> <token>");
    return 1;
  }

  const store = openStore(cwd);
  const context: RunSyncContext = {
    f: opts.f ?? (globalThis.fetch as Fetch),
    cfg,
    eventRoot: runsDir(cwd),
    store,
    cwd,
    projection: {
      home,
      username: opts.username ?? userInfo().username,
      repoRoot: cwd,
    },
  };

  if (opts.runId !== undefined) {
    return syncOneRun({ ...context, runId: opts.runId });
  }
  return syncAllRuns(context);
}

async function syncOneRun(ctx: RunSyncContext & { runId: string }): Promise<number> {
  const state = ctx.store.load(ctx.runId);
  if (state === null) {
    console.error(`no checkpoint found for run "${ctx.runId}" - try: lg ls`);
    return 1;
  }
  const result = await syncRun({
    f: ctx.f,
    cfg: ctx.cfg,
    cwd: ctx.cwd,
    eventRoot: ctx.eventRoot,
    runId: ctx.runId,
    state,
    opts: ctx.projection,
    timeoutMs: SYNC_TIMEOUT_MS,
  });
  if (!result.ok) {
    console.error(`failed to sync ${ctx.runId}: ${result.error}`);
    return 2;
  }
  console.log(`synced ${ctx.runId} (acked seq ${result.ackedSeq})`);
  return 0;
}

async function syncAllRuns(ctx: RunSyncContext): Promise<number> {
  const runIds = ctx.store.list().sort();

  // --all CONTINUES PAST A FAILURE. Every run is attempted before anything is
  // reported, because aborting on the first failure would let one unreachable
  // run hide thirty-nine healthy ones. The natural implementation throws on
  // the first failure - that is exactly the behaviour being refused here - so
  // a single dead hub cannot change what the rest of the run list did.
  let failed = 0;
  for (const runId of runIds) {
    // An unloadable run's 1 (unknown runId) is still a run that did not sync,
    // so --all counts it as a failure rather than aborting the sweep.
    const code = await syncOneRun({ ...ctx, runId });
    if (code !== 0) failed += 1;
  }

  if (runIds.length === 0) {
    console.log("no runs to sync");
  } else if (runIds.length > 1) {
    if (failed === 0) {
      console.log(`synced ${runIds.length} runs`);
    } else {
      console.error(`${failed} of ${runIds.length} runs failed to sync`);
    }
  }

  return failed === 0 ? 0 : 2;
}