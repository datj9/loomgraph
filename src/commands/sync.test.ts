import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../core/events.js";
import { CheckpointStore } from "../core/store.js";
import type { RunState } from "../core/types.js";
import type { EventBatch } from "../hub/wire.js";
import type { Fetch } from "../team/transport.js";
import { runsDir } from "./context.js";
import { syncCommand } from "./sync.js";

const ENV: NodeJS.ProcessEnv = {
  LOOMGRAPH_HUB_URL: "http://hub.test",
  LOOMGRAPH_HUB_TOKEN: "lgt_00000000.FAKEfake0000FAKEfake0000",
};

let tmp: string;
let cwd: string;
let home: string;

function makeState(runId: string): RunState {
  return {
    runId,
    streamId: "11111111-2222-3333-4444-555555555555",
    graphName: "g",
    status: "running",
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:01.000Z",
    cwd,
    vars: {},
    budget: { maxUsd: 1, maxWallClockSec: 60, maxNodeRuns: 10 },
    spent: { usd: 0, wallClockSec: 0, nodeRuns: 0 },
    nodes: {},
    completed: [],
    seq: 1,
  };
}

function seedRun(runId: string): void {
  const store = new CheckpointStore(runsDir(cwd));
  store.save(makeState(runId));
  const log = new EventLog(runsDir(cwd));
  log.append(runId, { kind: "run_started", data: {} });
}

function optInPath(): string {
  return join(cwd, ".loomgraph", "hub.json");
}

/** Opt the temp repo in, the same way `lg sync --enable` does. */
function seedOptIn(): void {
  mkdirSync(join(cwd, ".loomgraph"), { recursive: true });
  writeFileSync(optInPath(), '{"sync":true}\n', { encoding: "utf8" });
}

function runAwareFetch(failRun?: string): { fetch: Fetch; calls: { count: number } } {
  const calls = { count: 0 };
  const fetch: Fetch = async (_url, init) => {
    calls.count += 1;
    const body = JSON.parse(init.body ?? "{}") as EventBatch;
    if (body.runId === failRun) {
      return { status: 500, json: async () => ({ error: "boom" }) };
    }
    return { status: 200, json: async () => ({ highWaterSeq: 0 }) };
  };
  return { fetch, calls };
}

function captureConsole(): { outs: string[]; errs: string[] } {
  const outs: string[] = [];
  const errs: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    outs.push(a.join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    errs.push(a.join(" "));
  });
  return { outs, errs };
}

const base = () => ({ env: ENV, home, cwd, username: "alice" });

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "loomgraph-sync-cmd-"));
  cwd = join(tmp, "repo");
  home = join(tmp, "home");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("lg sync --enable", () => {
  it("6. writes {\"sync\":true} and returns 0", async () => {
    const code = await syncCommand({ enable: true, cwd });
    expect(code).toBe(0);
    expect(readFileSync(optInPath(), "utf8")).toBe('{"sync":true}\n');
  });

  it("7. running it twice is idempotent: same file content, still 0", async () => {
    expect(await syncCommand({ enable: true, cwd })).toBe(0);
    const first = readFileSync(optInPath(), "utf8");
    expect(await syncCommand({ enable: true, cwd })).toBe(0);
    expect(readFileSync(optInPath(), "utf8")).toBe(first);
  });
});

describe("lg sync usage errors", () => {
  it("8. no runId, no --all, no --enable -> 1", async () => {
    const code = await syncCommand(base());
    expect(code).toBe(1);
  });

  it("9. both a runId and --all -> 1", async () => {
    seedRun("run-a");
    const code = await syncCommand({ ...base(), runId: "run-a", all: true });
    expect(code).toBe(1);
  });

  it("10. hub not configured -> 1", async () => {
    seedRun("run-a");
    seedOptIn();
    const code = await syncCommand({ ...base(), env: {}, home: join(tmp, "absent-home") });
    expect(code).toBe(1);
  });

  it("11. an unknown runId -> 1", async () => {
    seedRun("run-a");
    seedOptIn();
    const code = await syncCommand({ ...base(), runId: "ghost" });
    expect(code).toBe(1);
  });
});

describe("lg sync <runId>", () => {
  it("12. a successful single-run sync -> 0", async () => {
    seedRun("run-a");
    seedOptIn();
    const { fetch, calls } = runAwareFetch();
    const code = await syncCommand({ ...base(), runId: "run-a", f: fetch });
    expect(code).toBe(0);
    expect(calls.count).toBe(1);
  });

  it("13. a failing single-run sync -> 2", async () => {
    seedRun("run-a");
    seedOptIn();
    const { fetch, calls } = runAwareFetch("run-a");
    const code = await syncCommand({ ...base(), runId: "run-a", f: fetch });
    expect(code).toBe(2);
    expect(calls.count).toBe(1);
  });
});

describe("lg sync --all", () => {
  it("14. with three runs where the MIDDLE one fails: all three are attempted, the exit code is 2, and the printed output names one failure", async () => {
    seedRun("run-a");
    seedRun("run-b");
    seedRun("run-c");
    seedOptIn();
    const { fetch, calls } = runAwareFetch("run-b");
    const { outs, errs } = captureConsole();

    const code = await syncCommand({ ...base(), all: true, f: fetch });

    expect(code).toBe(2);
    expect(calls.count).toBe(3);
    expect(errs.filter((e) => e.includes("run-b") && e.includes("failed"))).toHaveLength(1);
    expect(errs).toContain("1 of 3 runs failed to sync");
    expect(outs.filter((o) => o.startsWith("synced run-"))).toHaveLength(2);
  });

  it("15. --all where every run succeeds -> 0", async () => {
    seedRun("run-a");
    seedRun("run-b");
    seedRun("run-c");
    seedOptIn();
    const { fetch, calls } = runAwareFetch();
    const { outs } = captureConsole();

    const code = await syncCommand({ ...base(), all: true, f: fetch });

    expect(code).toBe(0);
    expect(calls.count).toBe(3);
    expect(outs).toContain("synced 3 runs");
    expect(outs.filter((o) => o.startsWith("synced run-"))).toHaveLength(3);
  });
});
describe("lg sync supplies the machine identity", () => {
  it("16. the command threads os.hostname() through, so the hostname is rewritten out of a published error", async () => {
    // BUG 1: `rewritePaths` had always accepted a `hostname`, but nothing on
    // the sync path could supply one - `ProjectionOpts` had no such field - so
    // the machine hostname published untouched out of the ONE channel that is
    // otherwise a real allowlist. This test uses the real `hostname()` and
    // passes NO hostname option, so it fails again the moment the production
    // call site stops supplying it.
    const host = hostname();
    const runId = "run-host";
    const state = makeState(runId);
    state.nodes.a = {
      nodeId: "a",
      status: "failed",
      startedAt: "2026-08-25T00:00:00.000Z",
      endedAt: "2026-08-25T00:00:01.000Z",
      attempts: 1,
      output: null,
      error: `ssh ${host}: connection refused`,
      costUsd: 0,
    };
    new CheckpointStore(runsDir(cwd)).save(state);
    new EventLog(runsDir(cwd)).append(runId, { kind: "run_started", data: {} });
    seedOptIn();

    let pushed: EventBatch | null = null;
    const fetch: Fetch = async (_url, init) => {
      pushed = JSON.parse(init.body ?? "null") as EventBatch;
      return { status: 200, json: async () => ({ highWaterSeq: 0 }) };
    };

    const code = await syncCommand({ env: ENV, home, cwd, username: "alice", runId, f: fetch });

    expect(code).toBe(0);
    const error = pushed!.state.nodes.a!.error;
    expect(error).not.toContain(host);
    expect(error).toContain("${HOSTNAME}");
  });
});

describe("lg sync honours the repo opt-in", () => {
  // BUG 5: `repoSyncEnabled` gated only the live batcher (`src/team/batch.ts`).
  // `lg sync <runId>` and `lg sync --all` never consulted it, so a repo that
  // had never run `lg sync --enable` could still push every run it had. The
  // hub's `events` table has no-update/no-delete triggers, which makes "I
  // forgot this repo was not opted in" permanent and visible to every
  // read-scoped member. The opt-in must gate every push path, not one of them.

  it("17. a run id in a repo that never opted in -> 1, nothing is pushed, and the message names --enable", async () => {
    seedRun("run-a");
    const { fetch, calls } = runAwareFetch();
    const { errs } = captureConsole();

    const code = await syncCommand({ ...base(), runId: "run-a", f: fetch });

    expect(code).toBe(1);
    expect(calls.count).toBe(0);
    expect(errs.some((e) => e.includes("lg sync --enable"))).toBe(true);
  });

  it("18. --all in a repo that never opted in -> 1 and pushes nothing, even with runs present", async () => {
    seedRun("run-a");
    seedRun("run-b");
    const { fetch, calls } = runAwareFetch();
    captureConsole();

    const code = await syncCommand({ ...base(), all: true, f: fetch });

    expect(code).toBe(1);
    expect(calls.count).toBe(0);
  });

  it("19. the gate is checked BEFORE the hub config, so an un-opted repo reports the opt-in rather than the enrollment", async () => {
    // Both conditions hold at once. The opt-in is the local consent decision
    // and the more specific fix, so it is what the operator is told about.
    seedRun("run-a");
    const { errs } = captureConsole();

    const code = await syncCommand({ ...base(), env: {}, home: join(tmp, "absent-home"), runId: "run-a" });

    expect(code).toBe(1);
    expect(errs.some((e) => e.includes("lg sync --enable"))).toBe(true);
    expect(errs.some((e) => e.includes("lg enroll"))).toBe(false);
  });

  it("20. a hub.json whose sync flag is not exactly true does not count as opting in", async () => {
    seedRun("run-a");
    mkdirSync(join(cwd, ".loomgraph"), { recursive: true });
    writeFileSync(optInPath(), '{"sync":"true"}\n', { encoding: "utf8" });
    const { fetch, calls } = runAwareFetch();
    captureConsole();

    expect(await syncCommand({ ...base(), runId: "run-a", f: fetch })).toBe(1);
    expect(calls.count).toBe(0);
  });

  it("21. --enable then sync works in one sequence", async () => {
    seedRun("run-a");
    const { fetch, calls } = runAwareFetch();
    captureConsole();

    expect(await syncCommand({ ...base(), enable: true })).toBe(0);
    expect(await syncCommand({ ...base(), runId: "run-a", f: fetch })).toBe(0);
    expect(calls.count).toBe(1);
  });
});
