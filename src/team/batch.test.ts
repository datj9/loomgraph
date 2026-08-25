import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execute, newRunState } from "../core/engine.js";
import { EventLog, type LgEvent } from "../core/events.js";
import { parseGraph } from "../core/graph.js";
import { CheckpointStore } from "../core/store.js";
import type { RunState } from "../core/types.js";
import type { Adapter, AdapterInput, AdapterOutput } from "../adapters/types.js";
import type { EventBatch } from "../hub/wire.js";
import { formatEventLine } from "../commands/context.js";
import { exitCodeFor } from "../commands/render.js";
import { makeBatcher, makeRunBatcher, type BatchCtx, type Batcher } from "./batch.js";
import type { Fetch, HubConfig } from "./transport.js";

const CFG: HubConfig = { url: "http://hub.test", token: "lgt_00000000.FAKEfake0000FAKEfake0000" };

const SUCCEED_SRC = `
name: batch-succeed
budget: { maxUsd: 10, maxWallClockSec: 600, maxNodeRuns: 20 }
nodes:
  a: { type: command, run: "echo a" }
  b: { type: command, run: "echo b" }
edges:
  - { from: a, to: b }
  - { from: b, to: END }
`;

const FAIL_SRC = `
name: batch-fail
budget: { maxUsd: 10, maxWallClockSec: 600, maxNodeRuns: 20 }
nodes:
  a: { type: command, run: "boom" }
edges:
  - { from: a, to: END }
`;

/** The timing keys a run's wall clock varies in; normalizing them is the plan's mechanism. */
const TIMING_KEYS = new Set(["ts", "createdAt", "updatedAt", "startedAt", "endedAt", "wallClockSec"]);

function normalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normalize);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = TIMING_KEYS.has(k) ? 0 : normalize(val);
    }
    return out;
  }
  return v;
}

function ev(seq: number): LgEvent {
  return {
    ts: "2026-08-25T00:00:00.000Z",
    runId: "fixed-run",
    seq,
    kind: "node_started",
    nodeId: `n${seq}`,
    data: { seq },
  };
}

function okOutput(text: string): AdapterOutput {
  return { ok: true, text, costUsd: 0, raw: null, error: null };
}
function badOutput(error: string): AdapterOutput {
  return { ok: false, text: "", costUsd: 0, raw: null, error };
}
function stub(name: string, fn: (i: AdapterInput) => AdapterOutput): Adapter {
  return { name, run: async (i) => fn(i) };
}

const okRegistry: Record<string, Adapter> = { command: stub("command", (i) => okOutput(i.prompt)) };
const failRegistry: Record<string, Adapter> = { command: stub("command", () => badOutput("boom")) };

function seedRun(dir: string, runId: string): { store: CheckpointStore; log: EventLog } {
  const store = new CheckpointStore(dir);
  const log = new EventLog(dir);
  const state: RunState = {
    runId,
    streamId: "11111111-2222-3333-4444-555555555555",
    graphName: "g",
    status: "running",
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:01.000Z",
    cwd: dir,
    vars: {},
    budget: { maxUsd: 10, maxWallClockSec: 600, maxNodeRuns: 20 },
    spent: { usd: 0, wallClockSec: 0, nodeRuns: 0 },
    nodes: {},
    completed: [],
    seq: 0,
  };
  store.save(state);
  return { store, log };
}

function makeCtx(store: CheckpointStore, runId = "fixed-run"): BatchCtx {
  return { runId, store, opts: { home: "/home/alice", username: "alice", repoRoot: "/repo" } };
}

function okFetchCalls(): { f: Fetch; calls: { count: number; batches: EventBatch[] } } {
  const calls = { count: 0, batches: [] as EventBatch[] };
  const f: Fetch = async (_url, init) => {
    calls.count += 1;
    const batch = JSON.parse(init.body ?? "{}") as EventBatch;
    calls.batches.push(batch);
    return { status: 200, json: async () => ({ highWaterSeq: batch.events.length - 1 }) };
  };
  return { f, calls };
}

const rejectingFetch: Fetch = async () => {
  const err = new Error("connect ECONNREFUSED 127.0.0.1:8080");
  (err as NodeJS.ErrnoException).code = "ECONNREFUSED";
  throw err;
};

const neverSettling: Fetch = () =>
  new Promise<{ status: number; json(): Promise<unknown> }>(() => {});

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

const FIXED_STREAM_ID = "11111111-2222-3333-4444-555555555555";

interface RunRequest {
  dir: string;
  src: string;
  registry: Record<string, Adapter>;
  makeBatcherFor: ((store: CheckpointStore) => Batcher) | null;
  printed: string[];
  events: LgEvent[];
  /** State.cwd; defaults to `dir`. Fixed across a compared pair so the runs' state is comparable. */
  cwd?: string;
}

async function runOnce(request: RunRequest): Promise<{ final: RunState; code: number }> {
  const store = new CheckpointStore(request.dir);
  const log = new EventLog(request.dir);
  const runId = "fixed-run";
  const graph = parseGraph(request.src);
  const state = newRunState(graph, { runId, cwd: request.cwd ?? request.dir, vars: {} });
  state.streamId = FIXED_STREAM_ID;
  const batcher = request.makeBatcherFor === null ? null : request.makeBatcherFor(store);
  const final = await execute(graph, state, {
    store,
    log,
    registry: request.registry,
    sleep: async () => {},
    onEvent: (event) => {
      const line = formatEventLine(event);
      if (line) {
        request.printed.push(line);
        console.log(line);
      }
      request.events.push(event);
      batcher?.onEvent(event);
    },
  });
  await batcher?.flush();
  batcher?.stop();
  return { final, code: exitCodeFor(final, log.read(runId)) };
}

function expectIdentical(
  a: { final: RunState; code: number },
  evA: LgEvent[],
  b: { final: RunState; code: number },
  evB: LgEvent[],
): void {
  const seqA = evA.map((e) => `${e.kind}:${e.seq}`);
  const seqB = evB.map((e) => `${e.kind}:${e.seq}`);
  expect(seqA).toEqual(seqB);
  expect(normalize(evA)).toEqual(normalize(evB));
  expect(normalize(a.final)).toEqual(normalize(b.final));
  expect(a.code).toBe(b.code);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a hub outage cannot change a run", () => {
  it("succeeding run: outcome identical with a rejecting hub, one stderr line, no pending timer", async () => {
    vi.useFakeTimers();
    try {
      const { errs } = captureConsole();
      const dirA = mkdtempSync(join(tmpdir(), "lg-batch-ok-a-"));
      const dirB = mkdtempSync(join(tmpdir(), "lg-batch-ok-b-"));
      try {
        const evA: LgEvent[] = [];
        const evB: LgEvent[] = [];
        const pA: string[] = [];
        const pB: string[] = [];
        const withB = await runOnce({
          dir: dirA,
          src: SUCCEED_SRC,
          registry: okRegistry,
          makeBatcherFor: (store) => makeBatcher(CFG, rejectingFetch, makeCtx(store)),
          printed: pA,
          events: evA,
          cwd: "/fixed-cwd",
        });
        expect(errs.filter((l) => l.includes("hub sync"))).toHaveLength(1);

        errs.length = 0;
        const withoutB = await runOnce({
          dir: dirB,
          src: SUCCEED_SRC,
          registry: okRegistry,
          makeBatcherFor: null,
          printed: pB,
          events: evB,
          cwd: "/fixed-cwd",
        });
        expect(errs).toHaveLength(0);

        expectIdentical(withB, evA, withoutB, evB);
        expect(pA).toEqual(pB);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        rmSync(dirA, { recursive: true, force: true });
        rmSync(dirB, { recursive: true, force: true });
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("failing run: outcome identical with a rejecting hub, one stderr line, no pending timer", async () => {
    vi.useFakeTimers();
    try {
      const { errs } = captureConsole();
      const dirA = mkdtempSync(join(tmpdir(), "lg-batch-fail-a-"));
      const dirB = mkdtempSync(join(tmpdir(), "lg-batch-fail-b-"));
      try {
        const evA: LgEvent[] = [];
        const evB: LgEvent[] = [];
        const pA: string[] = [];
        const pB: string[] = [];
        const withB = await runOnce({
          dir: dirA,
          src: FAIL_SRC,
          registry: failRegistry,
          makeBatcherFor: (store) => makeBatcher(CFG, rejectingFetch, makeCtx(store)),
          printed: pA,
          events: evA,
          cwd: "/fixed-cwd",
        });
        expect(errs.filter((l) => l.includes("hub sync"))).toHaveLength(1);

        errs.length = 0;
        const withoutB = await runOnce({
          dir: dirB,
          src: FAIL_SRC,
          registry: failRegistry,
          makeBatcherFor: null,
          printed: pB,
          events: evB,
          cwd: "/fixed-cwd",
        });
        expect(errs).toHaveLength(0);

        expectIdentical(withB, evA, withoutB, evB);
        expect(pA).toEqual(pB);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        rmSync(dirA, { recursive: true, force: true });
        rmSync(dirB, { recursive: true, force: true });
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("batcher buffering and timing", () => {
  it("1. nine events dispatch nothing; the tenth triggers one flush carrying all ten", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lg-batch-buffer-"));
    try {
      const { store } = seedRun(dir, "fixed-run");
      const { f, calls } = okFetchCalls();
      const batcher = makeBatcher(CFG, f, makeCtx(store));
      for (let i = 0; i < 9; i++) batcher.onEvent(ev(i));
      expect(calls.count).toBe(0);

      batcher.onEvent(ev(9));
      await batcher.flush();

      expect(calls.count).toBe(1);
      expect(calls.batches[0]!.events).toHaveLength(10);
      batcher.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("2. the 5-second periodic timer flushes a partial buffer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lg-batch-periodic-"));
    try {
      const { store } = seedRun(dir, "fixed-run");
      const { f, calls } = okFetchCalls();
      vi.useFakeTimers();
      try {
        const batcher = makeBatcher(CFG, f, makeCtx(store));
        for (let i = 0; i < 3; i++) batcher.onEvent(ev(i));
        expect(calls.count).toBe(0);

        await vi.advanceTimersByTimeAsync(5000);

        expect(calls.count).toBe(1);
        expect(calls.batches[0]!.events).toHaveLength(3);
        batcher.stop();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("3. the periodic timer is unref'd and stop() clears it", () => {
    const dir = mkdtempSync(join(tmpdir(), "lg-batch-unref-"));
    try {
      const { store } = seedRun(dir, "fixed-run");
      const { f } = okFetchCalls();

      // Real timers: the interval makeBatcher created carries no ref back.
      let captured: ReturnType<typeof setInterval> | undefined;
      const originalSetInterval = globalThis.setInterval.bind(globalThis);
      const spy = vi
        .spyOn(globalThis, "setInterval")
        .mockImplementation(
          ((handler: (...args: unknown[]) => void, timeout?: number, ...args: unknown[]) => {
            const t = originalSetInterval(handler, timeout, ...args);
            captured = t;
            return t;
          }) as typeof globalThis.setInterval,
        );
      const batcher = makeBatcher(CFG, f, makeCtx(store));
      expect(captured).toBeDefined();
      expect(captured!.hasRef()).toBe(false);
      spy.mockRestore();
      batcher.stop();

      // Fake timers: stop() removes the only pending periodic timer.
      vi.useFakeTimers();
      try {
        const b2 = makeBatcher(CFG, f, makeCtx(store));
        expect(vi.getTimerCount()).toBe(1);
        b2.stop();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("4. flush() resolves inside its ceiling when the transport never settles and ignores the abort signal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lg-batch-ceiling-"));
    try {
      const { store } = seedRun(dir, "fixed-run");
      const batcher = makeBatcher(CFG, neverSettling, {
        ...makeCtx(store),
        flushCeilingMs: 30,
        timeoutMs: 50,
      });
      for (let i = 0; i < 5; i++) batcher.onEvent(ev(i));

      const started = Date.now();
      await batcher.flush();
      const elapsed = Date.now() - started;

      expect(elapsed).toBeLessThan(1000);
      batcher.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("5. flush() never rejects: a rejecting transport, a non-2xx response, and a never-settling transport", async () => {
    const non2xx: Fetch = async () => ({ status: 500, json: async () => ({ error: "boom" }) });
    const cases: Array<{ f: Fetch; ceilingMs: number }> = [
      { f: rejectingFetch, ceilingMs: 200 },
      { f: non2xx, ceilingMs: 200 },
      { f: neverSettling, ceilingMs: 30 },
    ];
    for (const [i, c] of cases.entries()) {
      const dir = mkdtempSync(join(tmpdir(), "lg-batch-neverreject-"));
      try {
        const { store } = seedRun(dir, `run-${i}`);
        const batcher = makeBatcher(CFG, c.f, {
          ...makeCtx(store, `run-${i}`),
          flushCeilingMs: c.ceilingMs,
          timeoutMs: 50,
        });
        batcher.onEvent(ev(0));
        await expect(batcher.flush()).resolves.toBeUndefined();
        batcher.stop();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});

describe("no-op gate and failure accounting", () => {
  it("6. no-op batcher when loadHubConfig is null or repoSyncEnabled is false; the Fetch is never called", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lg-batch-gates-"));
    try {
      // repo opted in, but no hub config
      const optIn = join(dir, "optin");
      mkdirSync(join(optIn, ".loomgraph"), { recursive: true });
      writeFileSync(join(optIn, ".loomgraph", "hub.json"), '{"sync":true}\n', "utf8");
      const { store: storeA } = seedRun(join(dir, "store-a"), "fixed-run");
      const callsA = { count: 0 };
      const fA: Fetch = async () => {
        callsA.count += 1;
        return { status: 200, json: async () => ({ highWaterSeq: 0 }) };
      };
      const b1 = makeRunBatcher({ cfg: null, cwd: optIn, f: fA, ctx: makeCtx(storeA) });
      for (let i = 0; i < 25; i++) b1.onEvent(ev(i));
      await b1.flush();
      b1.stop();
      expect(callsA.count).toBe(0);

      // hub configured, but the repo has not opted in
      const noOptIn = join(dir, "nooptin");
      mkdirSync(noOptIn, { recursive: true });
      const { store: storeB } = seedRun(join(dir, "store-b"), "fixed-run");
      const callsB = { count: 0 };
      const fB: Fetch = async () => {
        callsB.count += 1;
        return { status: 200, json: async () => ({ highWaterSeq: 0 }) };
      };
      const b2 = makeRunBatcher({ cfg: CFG, cwd: noOptIn, f: fB, ctx: makeCtx(storeB) });
      for (let i = 0; i < 25; i++) b2.onEvent(ev(i));
      await b2.flush();
      b2.stop();
      expect(callsB.count).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("7. every dispatched promise is caught: a process-level unhandledRejection listener never fires", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lg-batch-rej-"));
    try {
      const rejections: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        rejections.push(reason);
      };
      process.on("unhandledRejection", onUnhandled);
      try {
        const { store } = seedRun(dir, "fixed-run");
        const b1 = makeBatcher(CFG, rejectingFetch, {
          ...makeCtx(store),
          flushCeilingMs: 25,
          timeoutMs: 25,
        });
        for (let i = 0; i < 28; i++) b1.onEvent(ev(i));
        await b1.flush();
        b1.stop();

        const b2 = makeBatcher(CFG, neverSettling, {
          ...makeCtx(store),
          flushCeilingMs: 25,
          timeoutMs: 25,
        });
        b2.onEvent(ev(0));
        await b2.flush();
        b2.stop();

        // Give any dangling postEvents chain time to settle and surface a rejection.
        await new Promise((r) => setTimeout(r, 60));
        expect(rejections).toEqual([]);
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("8. five separate failing flushes print exactly one stderr line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lg-batch-oneline-"));
    try {
      const { errs } = captureConsole();
      const { store } = seedRun(dir, "fixed-run");
      const batcher = makeBatcher(CFG, rejectingFetch, makeCtx(store));
      for (let round = 0; round < 5; round++) {
        batcher.onEvent(ev(round));
        await batcher.flush();
      }
      batcher.stop();
      expect(errs).toHaveLength(1);
      expect(errs[0]).toContain("hub sync unavailable");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("9. live console progress output is unchanged when the batcher is active", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lg-batch-progress-"));
    try {
      const { outs } = captureConsole();
      const printedWith: string[] = [];
      const printedWithout: string[] = [];
      await runOnce({
        dir: join(dir, "a"),
        src: SUCCEED_SRC,
        registry: okRegistry,
        makeBatcherFor: (store) => makeBatcher(CFG, rejectingFetch, makeCtx(store)),
        printed: printedWith,
        events: [],
        cwd: "/fixed-cwd",
      });
      const withLines = outs.slice();
      outs.length = 0;

      await runOnce({
        dir: join(dir, "b"),
        src: SUCCEED_SRC,
        registry: okRegistry,
        makeBatcherFor: null,
        printed: printedWithout,
        events: [],
        cwd: "/fixed-cwd",
      });

      expect(printedWith).toEqual(printedWithout);
      expect(outs).toEqual(withLines);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});