import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
    const code = await syncCommand({ ...base(), env: {}, home: join(tmp, "absent-home") });
    expect(code).toBe(1);
  });

  it("11. an unknown runId -> 1", async () => {
    seedRun("run-a");
    const code = await syncCommand({ ...base(), runId: "ghost" });
    expect(code).toBe(1);
  });
});

describe("lg sync <runId>", () => {
  it("12. a successful single-run sync -> 0", async () => {
    seedRun("run-a");
    const { fetch, calls } = runAwareFetch();
    const code = await syncCommand({ ...base(), runId: "run-a", f: fetch });
    expect(code).toBe(0);
    expect(calls.count).toBe(1);
  });

  it("13. a failing single-run sync -> 2", async () => {
    seedRun("run-a");
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
    const { fetch, calls } = runAwareFetch();
    const { outs } = captureConsole();

    const code = await syncCommand({ ...base(), all: true, f: fetch });

    expect(code).toBe(0);
    expect(calls.count).toBe(3);
    expect(outs).toContain("synced 3 runs");
    expect(outs.filter((o) => o.startsWith("synced run-"))).toHaveLength(3);
  });
});