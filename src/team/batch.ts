import type { LgEvent } from "../core/events.js";
import type { CheckpointStore } from "../core/store.js";
import { buildBatch, type ProjectionOpts } from "./sync.js";
import { postEvents, repoSyncEnabled, type Fetch, type HubConfig } from "./transport.js";

/** The live-push seam a command drives alongside its console progress output. */
export interface Batcher {
  /** Synchronous and fire-and-forget; called from inside the engine's commit(). */
  onEvent(event: LgEvent): void;
  /** Push whatever is buffered, bounded by a ceiling, resolving within it. */
  flush(): Promise<void>;
  /** Clear the periodic timer; the last chance to emit the single failure line. */
  stop(): void;
}

/**
 * Everything the batcher needs to assemble and send a push. `store` is loaded
 * per batch (never cached) so the projected state tracks whatever checkpoint
 * the engine most recently saved, exactly as `lg sync` recomputes it per batch.
 */
export interface BatchCtx {
  runId: string;
  store: CheckpointStore;
  opts: ProjectionOpts;
  /** Per-request bound handed to postEvents (default 10s). */
  timeoutMs?: number;
  /** flush()'s own ceiling (default 10s); kept small in tests. */
  flushCeilingMs?: number;
}

/** Dispatch once a batch reaches this many buffered events. */
const FLUSH_EVENT_COUNT = 10;
/** ...or on this cadence, whichever comes first. */
const PERIOD_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_FLUSH_CEILING_MS = 10_000;

function noopBatcher(): Batcher {
  return {
    onEvent: () => {},
    flush: async () => {},
    stop: () => {},
  };
}

/**
 * Assumption A1 is enforced HERE or it is not enforced anywhere: a live batcher
 * exists only when the hub is configured (loadHubConfig is non-null) AND the
 * repo has opted in (repoSyncEnabled is true). Either gate failing yields a
 * no-op batcher that never touches the Fetch, so a run on an unenrolled machine
 * cannot hang on a hub address that does not exist.
 */
export function makeRunBatcher(opts: {
  cfg: HubConfig | null;
  cwd: string;
  f: Fetch;
  ctx: BatchCtx;
}): Batcher {
  if (opts.cfg === null || !repoSyncEnabled(opts.cwd)) return noopBatcher();
  return makeBatcher(opts.cfg, opts.f, opts.ctx);
}

export function makeBatcher(cfg: HubConfig, f: Fetch, ctx: BatchCtx): Batcher {
  return new LiveBatcher(cfg, f, ctx);
}

class LiveBatcher implements Batcher {
  private buffer: string[] = [];
  private flushChain: Promise<void> = Promise.resolve();
  private failures = 0;
  private failureReported = false;
  private periodicTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly cfg: HubConfig,
    private readonly f: Fetch,
    private readonly ctx: BatchCtx,
  ) {
    // THE PERIODIC TIMER IS unref()d AND CLEARED IN stop(). Without the unref,
    // `lg run` would appear to hang for up to 5 seconds after every run: the
    // run's real work ends, nothing else keeps the loop alive, but the interval
    // would. stop() also must clear it so the timer never fires after its run
    // is over.
    this.periodicTimer = setInterval(() => this.scheduleDispatch(), PERIOD_MS);
    this.periodicTimer.unref();
  }

  onEvent(event: LgEvent): void {
    // SYNCHRONOUS and fire-and-forget. This runs inside the engine's commit(),
    // on the checkpoint path, so no `await` may precede the dispatch - putting
    // network latency here would put it on every edge crossing.
    this.buffer.push(JSON.stringify(event));
    if (this.buffer.length >= FLUSH_EVENT_COUNT) this.scheduleDispatch();
  }

  private scheduleDispatch(): void {
    // Every dispatched promise carries its own .catch: an unhandled rejection
    // changes the process exit path and vitest results. pushBuffered never
    // rejects, so the catch is belt-and-braces that must stay.
    this.flushChain = this.flushChain.then(() => this.pushBuffered()).catch(() => {});
  }

  flush(): Promise<void> {
    // flush()'s OWN CEILING TIMER IS DELIBERATELY NOT unref()d - unlike the
    // periodic timer above and unlike postEvents' internal request timeout.
    // postEvents bounds a hung transport by racing it against an unref()d
    // timer, which means when this flush is the only pending work in the
    // process (exactly the state at end of run) Node is free to exit before
    // that timer fires and the transport promise never settles. So flush()
    // imposes its own ceiling with a timer that DOES keep the loop alive: it
    // always fires, flush() always resolves, never rejects and never hangs.
    // Hitting the ceiling is a failure, like any other failed push.
    return new Promise<void>((resolve) => {
      const ceilingMs = this.ctx.flushCeilingMs ?? DEFAULT_FLUSH_CEILING_MS;
      const ceiling = setTimeout(() => {
        this.failures += 1;
        this.emitFailureOnce();
        resolve();
      }, ceilingMs);
      this.flushChain
        .then(() => this.pushBuffered())
        .then(
          () => {
            clearTimeout(ceiling);
            this.emitFailureOnce();
            resolve();
          },
          () => {
            this.failures += 1;
            clearTimeout(ceiling);
            this.emitFailureOnce();
            resolve();
          },
        );
    });
  }

  stop(): void {
    if (this.periodicTimer !== undefined) {
      clearInterval(this.periodicTimer);
      this.periodicTimer = undefined;
    }
    this.emitFailureOnce();
  }

  private async pushBuffered(): Promise<void> {
    const lines = this.buffer;
    this.buffer = [];
    if (lines.length === 0) return;

    const state = this.ctx.store.load(this.ctx.runId);
    // The engine checkpoints before the first event, so a missing state here
    // means the run never really started - count it as an unpushable batch.
    if (state === null) {
      this.failures += 1;
      return;
    }

    // The try wraps ONLY the push pipeline - the batch build and the fetch
    // promise chain. The engine, the checkpoint and the console printing are
    // all untouched, so a hub failure can surface here and nowhere else.
    try {
      const batch = buildBatch(state, this.ctx.opts, lines);
      const result = await postEvents(
        this.f,
        this.cfg,
        batch,
        this.ctx.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      );
      if (!result.ok) this.failures += 1;
    } catch {
      this.failures += 1;
    }
    // A failed batch is dropped, not re-buffered: the events are already
    // durable in events.jsonl, so the live stream losing them costs nothing
    // and `lg sync` re-pushes anything it missed once the hub is back.
  }

  /** At most one stderr line for the whole run, however many batches fail. */
  private emitFailureOnce(): void {
    if (this.failures > 0 && !this.failureReported) {
      this.failureReported = true;
      const unit = this.failures === 1 ? "batch" : "batches";
      console.error(
        `hub sync unavailable: ${this.failures} ${unit} not pushed (run ${this.ctx.runId})`,
      );
    }
  }
}