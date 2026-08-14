import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
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
    return JSON.parse(readFileSync(path, "utf8")) as RunState;
  }

  list(): string[] {
    if (!existsSync(this.rootDir)) return [];
    return readdirSync(this.rootDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  }
}
