import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckpointStore } from "./store.js";
import type { RunState } from "./types.js";

function makeState(runId: string): RunState {
  return {
    runId, streamId: "stream-1", graphName: "t", status: "running",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    cwd: "/tmp", vars: {}, budget: { maxUsd: 1, maxWallClockSec: 60, maxNodeRuns: 5 },
    spent: { usd: 0, wallClockSec: 0, nodeRuns: 0 },
    nodes: {}, completed: [], seq: 0,
  };
}

describe("CheckpointStore", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lg-")); });

  it("round-trips a run state", () => {
    const s = new CheckpointStore(dir);
    const st = makeState("r1");
    s.save(st);
    expect(s.load("r1")).toEqual(st);
  });

  it("returns null for an unknown run", () => {
    expect(new CheckpointStore(dir).load("nope")).toBeNull();
  });

  it("bumps seq and updatedAt on every save", () => {
    const s = new CheckpointStore(dir);
    const st = makeState("r2");
    s.save(st); const a = s.load("r2")!;
    s.save(a);  const b = s.load("r2")!;
    expect(b.seq).toBe(a.seq + 1);
  });

  it("lists saved runs", () => {
    const s = new CheckpointStore(dir);
    s.save(makeState("r3")); s.save(makeState("r4"));
    expect(s.list().sort()).toEqual(["r3", "r4"]);
  });

  it("resume preserves the streamId across save and load", () => {
    const s = new CheckpointStore(dir);
    const st = makeState("rresume");
    s.save(st);
    const loaded = s.load("rresume")!;
    expect(loaded.streamId).toBe(st.streamId);
  });

  it("a checkpoint written without a streamId loads with a derived one, the same value on every load", () => {
    const s = new CheckpointStore(dir);
    const dir2 = s.runDir("rlegacy");
    mkdirSync(dir2, { recursive: true });
    const { streamId: _drop, ...legacy } = makeState("rlegacy");
    writeFileSync(join(dir2, "state.json"), `${JSON.stringify(legacy, null, 2)}\n`, "utf8");

    const a = s.load("rlegacy")!;
    const b = s.load("rlegacy")!;
    expect(a.streamId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(a.streamId).toBe(b.streamId);
  });

  it("loading a legacy checkpoint does not write to disk", () => {
    const s = new CheckpointStore(dir);
    const dir2 = s.runDir("rnowrite");
    mkdirSync(dir2, { recursive: true });
    const { streamId: _drop, ...legacy } = makeState("rnowrite");
    const path = join(dir2, "state.json");
    const body = `${JSON.stringify(legacy, null, 2)}\n`;
    writeFileSync(path, body, "utf8");
    const before = { mtimeMs: statSync(path).mtimeMs, body: readFileSync(path, "utf8") };

    s.load("rnowrite");

    expect(statSync(path).mtimeMs).toBe(before.mtimeMs);
    expect(readFileSync(path, "utf8")).toBe(before.body);
  });

  it("loading a legacy checkpoint does not change seq or updatedAt from disk", () => {
    const s = new CheckpointStore(dir);
    const dir2 = s.runDir("rseq");
    mkdirSync(dir2, { recursive: true });
    const { streamId: _drop, ...legacy } = makeState("rseq");
    legacy.seq = 41;
    legacy.updatedAt = "2000-01-01T00:00:00.000Z";
    writeFileSync(join(dir2, "state.json"), `${JSON.stringify(legacy, null, 2)}\n`, "utf8");

    const loaded = s.load("rseq")!;
    expect(loaded.seq).toBe(41);
    expect(loaded.updatedAt).toBe("2000-01-01T00:00:00.000Z");
  });
});
