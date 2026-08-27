import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventLog } from "../core/events.js";
import type { RunState } from "../core/types.js";
import { HubStore } from "../hub/storage.js";
import { handle, type HandlerDeps, type WireRequest } from "../hub/handlers.js";
import {
  pendingLines,
  readCursor,
  syncRun,
  writeCursor,
  type ProjectionOpts,
} from "./sync.js";
import type { EventBatch } from "../hub/wire.js";
import type { Fetch, HubConfig } from "./transport.js";

const FROZEN = "2026-08-25T00:00:00.000Z";

const OPTS: ProjectionOpts = { home: "/home/alice", username: "alice", repoRoot: "/work/repo" };

const CFG: HubConfig = { url: "http://hub.test", token: "lgt_00000000.FAKEfake0000FAKEfake0000" };

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "loomgraph-sync-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makeState(runId: string): RunState {
  return {
    runId,
    streamId: "11111111-2222-3333-4444-555555555555",
    graphName: "g",
    status: "running",
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:01.000Z",
    cwd: "/work/repo",
    vars: {},
    budget: { maxUsd: 1, maxWallClockSec: 60, maxNodeRuns: 10 },
    spent: { usd: 0, wallClockSec: 0, nodeRuns: 0 },
    nodes: {},
    completed: [],
    seq: 1,
  };
}

function cursorFile(cwd: string, runId: string): string {
  return join(cwd, ".loomgraph", "sync", `${runId}.cursor`);
}

function writeEvents(eventRoot: string, runId: string, count: number): void {
  const log = new EventLog(eventRoot);
  for (let i = 0; i < count; i++) {
    log.append(runId, { kind: "run_started", data: {} });
  }
}

function setupRun(count: number, acked?: number): { cwd: string; eventRoot: string; runId: string } {
  const cwd = join(tmp, "repo");
  const eventRoot = join(cwd, ".loomgraph", "runs");
  const runId = "run-sync";
  writeEvents(eventRoot, runId, count);
  if (acked !== undefined) writeCursor(cwd, runId, acked);
  return { cwd, eventRoot, runId };
}

function hubSeam(
  store: HubStore,
  token: string,
  onRequest?: (n: number) => void,
): { fetch: Fetch; requests: Array<{ body: EventBatch; status: number }> } {
  const deps: HandlerDeps = { store, now: () => FROZEN, version: "test-v" };
  const requests: Array<{ body: EventBatch; status: number }> = [];
  const fetch: Fetch = async (url, init) => {
    onRequest?.(requests.length);
    const body = JSON.parse(init.body ?? "null") as EventBatch;
    const req: WireRequest = {
      method: init.method,
      path: new URL(url).pathname,
      query: {},
      headers: { authorization: init.headers.authorization },
      body,
    };
    const res = handle(req, deps);
    requests.push({ body, status: res.status });
    return { status: res.status, json: async () => res.body };
  };
  return { fetch, requests };
}

function realHub(): {
  fetch: Fetch;
  cfg: HubConfig;
  store: HubStore;
  requests: Array<{ body: EventBatch; status: number }>;
} {
  const store = HubStore.open(":memory:", { now: () => FROZEN });
  const token = store.addMember("alice", ["ingest"]).token;
  const { fetch, requests } = hubSeam(store, token);
  return { fetch, cfg: { url: "http://hub.test", token }, store, requests };
}

describe("cursor", () => {
  it("9. writeCursor then readCursor round-trips", () => {
    const cwd = join(tmp, "repo");
    writeCursor(cwd, "run-1", 42);
    expect(readCursor(cwd, "run-1")).toEqual({ ackedSeq: 42 });
    writeCursor(cwd, "run-1", 0);
    expect(readCursor(cwd, "run-1")).toEqual({ ackedSeq: 0 });
  });

  it("10. a corrupt cursor reads as null, never throws", () => {
    const cwd = join(tmp, "repo");
    const path = cursorFile(cwd, "run-1");
    const corruptions = [
      '{"ackedSe', // truncated mid-JSON
      "", // empty file
      "not json at all", // plain text
      '{"ackedSeq":"seven"}', // string value, not a number
      '{"ackedSeq":-1}', // negative : a real ack is never negative
      '{"ackedSeq":2.5}', // non-integer
      '{"ackedSeq":null}', // null value
      "[1,2,3]", // valid JSON, not the object we expect
    ];
    for (const content of corruptions) {
      mkdirSync(join(cwd, ".loomgraph", "sync"), { recursive: true });
      writeFileSync(path, content, "utf8");
      expect(readCursor(cwd, "run-1")).toBeNull();
    }
    expect(() => readCursor(cwd, "run-1")).not.toThrow();
  });
});

describe("pendingLines", () => {
  it("11. returns only lines whose seq is above ackedSeq, preserving order", () => {
    const lines = [0, 1, 2, 3, 4].map((seq) =>
      JSON.stringify({ ts: "2026-08-25T00:00:00.000Z", runId: "r", seq, kind: "run_started", data: {} }),
    );
    expect(pendingLines(lines, 2)).toEqual([lines[3], lines[4]]);
    expect(pendingLines(lines, -1)).toEqual(lines);
    expect(pendingLines(lines, 4)).toEqual([]);
    const late = JSON.stringify({
      ts: "2026-08-25T00:01:00.000Z",
      runId: "r",
      seq: 7,
      kind: "run_started",
      data: {},
    });
    expect(pendingLines([...lines, late], 5)).toEqual([late]);
  });

  it("an unreadable line is never treated as pending", () => {
    expect(pendingLines(["this is not json"], 0)).toEqual([]);
  });
});

describe("syncRun", () => {
  it("the cursor never passes the last ack: every call fails and the cursor sits exactly where it started", async () => {
    const { cwd, eventRoot, runId } = setupRun(8, 5);
    const path = cursorFile(cwd, runId);
    const before = readFileSync(path, "utf8");
    const fetch: Fetch = async () => {
      throw new Error("connect ECONNRESET");
    };
    const result = await syncRun({
      f: fetch,
      cfg: CFG,
      cwd,
      eventRoot,
      runId,
      state: makeState(runId),
      opts: OPTS,
      timeoutMs: 1000,
    });
    expect(result.ok).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(readCursor(cwd, runId)).toEqual({ ackedSeq: 5 });
  });

  it("12. a successful sync advances the cursor to the returned highWaterSeq", async () => {
    const { cwd, eventRoot, runId } = setupRun(4);
    const fetch: Fetch = async () => ({ status: 200, json: async () => ({ highWaterSeq: 3 }) });
    const result = await syncRun({
      f: fetch,
      cfg: CFG,
      cwd,
      eventRoot,
      runId,
      state: makeState(runId),
      opts: OPTS,
      timeoutMs: 1000,
    });
    expect(result).toEqual({ ok: true, ackedSeq: 3 });
    expect(readCursor(cwd, runId)).toEqual({ ackedSeq: 3 });
    expect(readFileSync(cursorFile(cwd, runId), "utf8")).toBe('{"ackedSeq":3}\n');
  });

  it("13. a failed sync leaves the cursor byte-identical", async () => {
    const { cwd, eventRoot, runId } = setupRun(6, 1);
    const path = cursorFile(cwd, runId);
    const before = readFileSync(path, "utf8");
    const fetch: Fetch = async () => ({ status: 500, json: async () => ({ error: "boom" }) });
    const result = await syncRun({
      f: fetch,
      cfg: CFG,
      cwd,
      eventRoot,
      runId,
      state: makeState(runId),
      opts: OPTS,
      timeoutMs: 1000,
    });
    expect(result.ok).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(readCursor(cwd, runId)).toEqual({ ackedSeq: 1 });
  });

  it("a timeout leaves the cursor unchanged", async () => {
    const { cwd, eventRoot, runId } = setupRun(6, 1);
    const path = cursorFile(cwd, runId);
    const before = readFileSync(path, "utf8");
    const fetch: Fetch = (_url, init) =>
      new Promise<{ status: number; json(): Promise<unknown> }>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const err = new Error("signal aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    const result = await syncRun({
      f: fetch,
      cfg: CFG,
      cwd,
      eventRoot,
      runId,
      state: makeState(runId),
      opts: OPTS,
      timeoutMs: 25,
    });
    expect(result.ok).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("a malformed 2xx body leaves the cursor unchanged", async () => {
    const { cwd, eventRoot, runId } = setupRun(6, 1);
    const path = cursorFile(cwd, runId);
    const before = readFileSync(path, "utf8");
    const fetch: Fetch = async () => ({ status: 200, json: async () => ({ nope: 1 }) });
    const result = await syncRun({
      f: fetch,
      cfg: CFG,
      cwd,
      eventRoot,
      runId,
      state: makeState(runId),
      opts: OPTS,
      timeoutMs: 1000,
    });
    expect(result.ok).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("json() rejecting leaves the cursor unchanged", async () => {
    const { cwd, eventRoot, runId } = setupRun(6, 1);
    const path = cursorFile(cwd, runId);
    const before = readFileSync(path, "utf8");
    const fetch: Fetch = async () => ({
      status: 200,
      json: async () => {
        throw new Error("bad json");
      },
    });
    const result = await syncRun({
      f: fetch,
      cfg: CFG,
      cwd,
      eventRoot,
      runId,
      state: makeState(runId),
      opts: OPTS,
      timeoutMs: 1000,
    });
    expect(result.ok).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("14. windowing: first batch carries 500, the cursor advances, and a mid-run second batch is accepted by the real handler", async () => {
    const { cwd, eventRoot, runId } = setupRun(600);
    const store = HubStore.open(":memory:", { now: () => FROZEN });
    const token = store.addMember("alice", ["ingest"]).token;
    const { fetch, requests } = hubSeam(store, token, (n) => {
      if (n === 1) {
        // Between batch 1 and batch 2 the cursor must already name the first high-water mark.
        expect(readCursor(cwd, runId)).toEqual({ ackedSeq: 499 });
      }
    });
    const cfg: HubConfig = { url: "http://hub.test", token };

    const result = await syncRun({
      f: fetch,
      cfg,
      cwd,
      eventRoot,
      runId,
      state: makeState(runId),
      opts: OPTS,
      timeoutMs: 5000,
    });

    expect(result.ok).toBe(true);
    expect(requests).toHaveLength(2);

    const first = requests[0]!.body;
    expect(first.events).toHaveLength(500);
    expect((JSON.parse(first.events[0]!) as { seq: number }).seq).toBe(0);
    expect(requests[0]!.status).toBe(200);

    const second = requests[1]!.body;
    expect(second.events).toHaveLength(100);
    expect((JSON.parse(second.events[0]!) as { seq: number }).seq).toBe(500);
    expect(requests[1]!.status).toBe(200);

    expect(readCursor(cwd, runId)).toEqual({ ackedSeq: 599 });
    const stored = store.events("alice", makeState(runId).streamId, runId);
    expect(stored).toHaveLength(600);
    expect(store.listRuns("alice")).toHaveLength(1);
  });

  it("15. sync writes nothing under runs/", async () => {
    const cwd = join(tmp, "repo");
    const eventRoot = join(cwd, ".loomgraph", "runs");
    const runId = "run-ro";
    writeEvents(eventRoot, runId, 4);

    const snapshot = (): Array<{ path: string; mtimeMs: number; bytes: number }> => {
      const out: Array<{ path: string; mtimeMs: number; bytes: number }> = [];
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const p = join(dir, entry.name);
          if (entry.isDirectory()) walk(p);
          else out.push({ path: p, mtimeMs: statSync(p).mtimeMs, bytes: statSync(p).size });
        }
      };
      walk(eventRoot);
      return out.sort((a, b) => a.path.localeCompare(b.path));
    };

    const before = snapshot();
    const { fetch, cfg } = realHub();
    const result = await syncRun({
      f: fetch,
      cfg,
      cwd,
      eventRoot,
      runId,
      state: makeState(runId),
      opts: OPTS,
      timeoutMs: 5000,
    });
    expect(result.ok).toBe(true);
    expect(snapshot()).toEqual(before);
  });

  it("16. a cut mid-batch resends the identical events array", async () => {
    const { cwd, eventRoot, runId } = setupRun(6);
    const store = HubStore.open(":memory:", { now: () => FROZEN });
    const token = store.addMember("alice", ["ingest"]).token;
    const deps: HandlerDeps = { store, now: () => FROZEN, version: "test-v" };
    const bodies: string[] = [];
    let calls = 0;
    const fetch: Fetch = async (url, init) => {
      bodies.push(init.body ?? "");
      calls += 1;
      if (calls === 1) {
        // The hub is off: connection refused, so this attempt stores nothing.
        const err = new Error("connect ECONNREFUSED 127.0.0.1:8080");
        (err as NodeJS.ErrnoException).code = "ECONNREFUSED";
        throw err;
      }
      const body = JSON.parse(init.body ?? "null") as EventBatch;
      const res = handle(
        {
          method: init.method,
          path: new URL(url).pathname,
          query: {},
          headers: { authorization: init.headers.authorization },
          body,
        },
        deps,
      );
      return { status: res.status, json: async () => res.body };
    };
    const cfg: HubConfig = { url: "http://hub.test", token };

    const firstAttempt = await syncRun({
      f: fetch,
      cfg,
      cwd,
      eventRoot,
      runId,
      state: makeState(runId),
      opts: OPTS,
      timeoutMs: 5000,
    });
    expect(firstAttempt.ok).toBe(false);

    const secondAttempt = await syncRun({
      f: fetch,
      cfg,
      cwd,
      eventRoot,
      runId,
      state: makeState(runId),
      opts: OPTS,
      timeoutMs: 5000,
    });
    expect(secondAttempt.ok).toBe(true);

    expect(bodies).toHaveLength(2);
    const firstBatch = JSON.parse(bodies[0]!) as EventBatch;
    const secondBatch = JSON.parse(bodies[1]!) as EventBatch;
    expect(firstBatch.events).toHaveLength(6);
    expect(secondBatch.events).toEqual(firstBatch.events);
    expect(secondBatch.runId).toBe(runId);
  });

  it("17. a kill between windows leaves the cursor on the first window's ack, and the retry resends from exactly that point", async () => {
    const { cwd, eventRoot, runId } = setupRun(600);
    let calls = 0;
    const failingFetch: Fetch = async (_url, _init) => {
      calls += 1;
      if (calls === 1) return { status: 200, json: async () => ({ highWaterSeq: 499 }) };
      throw new Error("socket hang up mid-sync");
    };
    const first = await syncRun({
      f: failingFetch,
      cfg: CFG,
      cwd,
      eventRoot,
      runId,
      state: makeState(runId),
      opts: OPTS,
      timeoutMs: 5000,
    });
    expect(first.ok).toBe(false);
    expect(readCursor(cwd, runId)).toEqual({ ackedSeq: 499 });
    expect(readFileSync(cursorFile(cwd, runId), "utf8")).toBe('{"ackedSeq":499}\n');

    let resend: EventBatch | null = null;
    const workingFetch: Fetch = async (_url, init) => {
      resend = JSON.parse(init.body ?? "null") as EventBatch;
      return { status: 200, json: async () => ({ highWaterSeq: 599 }) };
    };
    const second = await syncRun({
      f: workingFetch,
      cfg: CFG,
      cwd,
      eventRoot,
      runId,
      state: makeState(runId),
      opts: OPTS,
      timeoutMs: 5000,
    });
    expect(second).toEqual({ ok: true, ackedSeq: 599 });

    const seqs = resend!.events.map((line) => (JSON.parse(line) as { seq: number }).seq);
    expect(seqs).toEqual(Array.from({ length: 100 }, (_, i) => 500 + i));
  });

  it("18. a window that never settles still fails the sync, bounded by the timer, leaving the cursor on the first ack", async () => {
    const { cwd, eventRoot, runId } = setupRun(600);
    let calls = 0;
    const hangFetch: Fetch = (_url, _init) => {
      calls += 1;
      if (calls === 1) return Promise.resolve({ status: 200, json: async () => ({ highWaterSeq: 499 }) });
      return new Promise<{ status: number; json(): Promise<unknown> }>(() => {});
    };
    const result = await syncRun({
      f: hangFetch,
      cfg: CFG,
      cwd,
      eventRoot,
      runId,
      state: makeState(runId),
      opts: OPTS,
      timeoutMs: 25,
    });
    expect(result.ok).toBe(false);
    expect(readCursor(cwd, runId)).toEqual({ ackedSeq: 499 });
  });

  it("19. a failure on the very first window, with no existing cursor, writes no cursor file at all", async () => {
    const { cwd, eventRoot, runId } = setupRun(4);
    const fetch: Fetch = async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:8080");
    };
    const result = await syncRun({
      f: fetch,
      cfg: CFG,
      cwd,
      eventRoot,
      runId,
      state: makeState(runId),
      opts: OPTS,
      timeoutMs: 1000,
    });
    expect(result.ok).toBe(false);
    expect(existsSync(cursorFile(cwd, runId))).toBe(false);
  });

  it("20. a 2xx high-water below the cursor rewinds it on purpose, and a healthy retry resends the recovered range", async () => {
    // The downward move is DELIBERATE. When the hub reports a high-water BELOW the on-disk
    // cursor - a hub restored from backup, or a different hub at the same URL - the rewind is
    // the recovery path: pendingLines only ever sends events above the cursor, so a cursor
    // pinned above the hub would silently drop everything below it and nothing self-heals.
    // A max(cursor, highWaterSeq) guard would pin the cursor above the hub forever and make
    // the gap permanent. Do not add such a guard.
    const { cwd, eventRoot, runId } = setupRun(8, 5);
    const rewindFetch: Fetch = async () => ({ status: 200, json: async () => ({ highWaterSeq: 3 }) });
    const first = await syncRun({
      f: rewindFetch,
      cfg: CFG,
      cwd,
      eventRoot,
      runId,
      state: makeState(runId),
      opts: OPTS,
      timeoutMs: 1000,
    });
    expect(first).toEqual({ ok: true, ackedSeq: 3 });
    expect(readCursor(cwd, runId)).toEqual({ ackedSeq: 3 });
    expect(readFileSync(cursorFile(cwd, runId), "utf8")).toBe('{"ackedSeq":3}\n');

    let resend: EventBatch | null = null;
    const healthyFetch: Fetch = async (_url, init) => {
      resend = JSON.parse(init.body ?? "null") as EventBatch;
      return { status: 200, json: async () => ({ highWaterSeq: 7 }) };
    };
    const second = await syncRun({
      f: healthyFetch,
      cfg: CFG,
      cwd,
      eventRoot,
      runId,
      state: makeState(runId),
      opts: OPTS,
      timeoutMs: 1000,
    });
    expect(second).toEqual({ ok: true, ackedSeq: 7 });

    const seqs = resend!.events.map((line) => (JSON.parse(line) as { seq: number }).seq);
    expect(seqs).toEqual([4, 5, 6, 7]);
  });

  it("21. a failed sync leaves the cursor file byte-identical", async () => {
    const { cwd, eventRoot, runId } = setupRun(6, 1);
    const path = cursorFile(cwd, runId);
    const before = readFileSync(path, "utf8");
    const fetch: Fetch = async () => {
      throw new Error("connect ECONNRESET");
    };
    const result = await syncRun({
      f: fetch,
      cfg: CFG,
      cwd,
      eventRoot,
      runId,
      state: makeState(runId),
      opts: OPTS,
      timeoutMs: 1000,
    });
    expect(result.ok).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});