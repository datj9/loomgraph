import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { RunState } from "./types.js";

/**
 * Crash-safe checkpoint storage. One directory per run:
 *
 *   <rootDir>/<runId>/state.json
 *
 * Writes go to `state.json.tmp` first and are then renamed over the real file,
 * so a process killed mid-write never leaves a half-written checkpoint behind.
 */
export class CheckpointStore {
  constructor(private readonly rootDir: string) {}

  runDir(runId: string): string {
    return join(this.rootDir, runId);
  }

  private statePath(runId: string): string {
    return join(this.runDir(runId), "state.json");
  }

  /**
   * Persist a checkpoint. `seq` is the on-disk checkpoint generation: it
   * continues from whatever was last persisted for this run, so a resumed run
   * keeps counting up instead of restarting. `updatedAt` is stamped on both the
   * persisted copy and the caller's object so the two stay in sync.
   *
   * Returns the state as it was written.
   */
  save(state: RunState): RunState {
    const prev = this.load(state.runId);
    const now = new Date().toISOString();
    state.updatedAt = now;
    const next: RunState = { ...state, updatedAt: now, seq: prev ? prev.seq + 1 : state.seq };

    const dir = this.runDir(state.runId);
    mkdirSync(dir, { recursive: true });
    const target = this.statePath(state.runId);
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    renameSync(tmp, target);
    return next;
  }

  load(runId: string): RunState | null {
    const path = this.statePath(runId);
    if (!existsSync(path)) return null;
    const state = JSON.parse(readFileSync(path, "utf8")) as RunState;

    // A legacy checkpoint has no `streamId`. Derive a stable one in memory and
    // WRITE NOTHING. Re-saving here would be wrong three ways:
    //   1. `save` calls `this.load` (see above), so backfilling inside `load`
    //      by calling `save` is mutual recursion between load and save.
    //   2. `save` sets `seq: prev.seq + 1`, so a READ would advance the
    //      checkpoint generation counter - and since `ProjectedState.seq` is
    //      that same counter, the hub would see a generation increment no run
    //      produced.
    //   3. `save` stamps `updatedAt = now`, so merely running `lg status` or
    //      `lg ls` would mark an untouched run as modified.
    // The derivation is a uuid-formatted rendering of sha256("legacy:" + runId),
    // so every load of the same legacy run agrees. The next legitimate `save()`
    // persists it as a side effect of ordinary work.
    if (!state.streamId) {
      const digest = createHash("sha256").update(`legacy:${runId}`).digest("hex").slice(0, 32);
      state.streamId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20)}`;
    }
    return state;
  }

  /**
   * The graph is copied into the run directory when the run starts, so `lg
   * resume` continues against the exact graph the run began with even if the
   * source file has since changed.
   */
  saveGraphSource(runId: string, source: string): void {
    mkdirSync(this.runDir(runId), { recursive: true });
    writeFileSync(join(this.runDir(runId), "graph.yaml"), source, "utf8");
  }

  loadGraphSource(runId: string): string | null {
    const path = join(this.runDir(runId), "graph.yaml");
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf8");
  }

  list(): string[] {
    if (!existsSync(this.rootDir)) return [];
    return readdirSync(this.rootDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  }
}
