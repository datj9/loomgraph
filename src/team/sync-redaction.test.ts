import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventLog } from "../core/events.js";
import { CheckpointStore } from "../core/store.js";
import { execute, newRunState } from "../core/engine.js";
import { parseGraph } from "../core/graph.js";
import type { Adapter, AdapterInput, AdapterOutput } from "../adapters/types.js";
import type { RunState } from "../core/types.js";
import { HubStore } from "../hub/storage.js";
import { handle, type HandlerDeps, type WireRequest } from "../hub/handlers.js";
import type { EventBatch } from "../hub/wire.js";
import { buildBatch, sanitizeEventLine, syncRun, type ProjectionOpts } from "./sync.js";
import type { Fetch, HubConfig } from "./transport.js";

/**
 * THE EVENT STREAM IS A PUBLISHED CHANNEL. `src/team/project.test.ts` proves the
 * *projection* is an allowlist; nothing proved anything about the raw event
 * lines that ride alongside it in the same push, which is exactly how they came
 * to carry unmasked errors, un-rewritten paths and interpolated var values.
 * These tests pin the push, not the projection: the local log stays raw and the
 * wire does not.
 */

const FROZEN = "2026-08-25T00:00:00.000Z";

/** An anthropic-key shape, so `SCAN_RULES` has a rule that must fire on it. */
const SECRET = "sk-ant-api03-LEAKLEAKLEAKLEAK1234";
const HOME = "/home/alice";
const HOME_PATH = `${HOME}/.config/loomgraph/hub.json`;
const HOSTNAME = "alice-laptop.local";

let tmp: string;
let cwd: string;
let eventRoot: string;
let store: CheckpointStore;
let log: EventLog;
let opts: ProjectionOpts;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "loomgraph-redact-"));
  cwd = join(tmp, "repo");
  eventRoot = join(cwd, ".loomgraph", "runs");
  store = new CheckpointStore(eventRoot);
  log = new EventLog(eventRoot);
  opts = { home: HOME, username: "alice", repoRoot: cwd, hostname: HOSTNAME };
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function stub(name: string, out: AdapterOutput): Adapter {
  return { name, run: async (_input: AdapterInput) => out };
}

/** The real ingest handler, so a sanitized line still has to pass the wire schema. */
function hub(): { f: Fetch; cfg: HubConfig; pushed: EventBatch[]; statuses: number[] } {
  const hubStore = HubStore.open(":memory:", { now: () => FROZEN });
  const token = hubStore.addMember("alice", ["ingest"]).token;
  const deps: HandlerDeps = { store: hubStore, now: () => FROZEN, version: "test-v" };
  const pushed: EventBatch[] = [];
  const statuses: number[] = [];
  const f: Fetch = async (url, init) => {
    const body = JSON.parse(init.body ?? "null") as EventBatch;
    const req: WireRequest = {
      method: init.method,
      path: new URL(url).pathname,
      query: {},
      headers: { authorization: init.headers.authorization },
      body,
    };
    const res = handle(req, deps);
    pushed.push(body);
    statuses.push(res.status);
    return { status: res.status, json: async () => res.body };
  };
  return { f, cfg: { url: "http://hub.test", token }, pushed, statuses };
}

async function push(runId: string, state: RunState): Promise<{ wire: string; statuses: number[] }> {
  const { f, cfg, pushed, statuses } = hub();
  const result = await syncRun({ f, cfg, cwd, eventRoot, runId, state, opts, timeoutMs: 5000 });
  expect(result.ok).toBe(true);
  return { wire: JSON.stringify(pushed), statuses };
}

function localLog(runId: string): string {
  return readFileSync(join(eventRoot, runId, "events.jsonl"), "utf8");
}

const FAILING_GRAPH = `
name: leaky
budget: { maxUsd: 10, maxWallClockSec: 600, maxNodeRuns: 20 }
nodes:
  boom: { type: command, run: "true" }
edges:
  - { from: boom, to: END }
`;

const HUMAN_GRAPH = `
name: ask
budget: { maxUsd: 10, maxWallClockSec: 600, maxNodeRuns: 20 }
nodes:
  ask: { type: human, question: "ship with {{vars.token}}?" }
edges:
  - { from: ask, to: END }
`;

describe("what a sync publishes", () => {
  it("a. a node error carrying a secret and an absolute home path reaches the hub with neither", async () => {
    const runId = "run-leak";
    const graph = parseGraph(FAILING_GRAPH);
    const state = newRunState(graph, { runId, cwd });
    const failed = await execute(graph, state, {
      store,
      log,
      registry: {
        command: stub("command", {
          ok: false,
          text: "",
          costUsd: 0,
          raw: null,
          error: `command exited with code 1: could not read ${HOME_PATH}, key ${SECRET}`,
        }),
      },
      sleep: async () => {},
    });
    expect(failed.status).toBe("failed");

    const { wire, statuses } = await push(runId, failed);

    expect(statuses).toEqual([200]);
    expect(wire).not.toContain(SECRET);
    expect(wire).not.toContain("sk-ant-api03-LEAK");
    expect(wire).not.toContain(HOME_PATH);
    expect(wire).not.toContain("/home/alice");
    // The event is still published - sanitized, not dropped.
    expect(wire).toContain("node_finished");
    expect(wire).toContain("could not read ${HOME}/.config/loomgraph/hub.json");
    expect(wire).toContain("sk-a...");
  });

  it("b. a human question that interpolated a secret var does not reach the hub", async () => {
    const runId = "run-ask";
    const graph = parseGraph(HUMAN_GRAPH);
    const state = newRunState(graph, { runId, cwd, vars: { token: SECRET } });
    const paused = await execute(graph, state, { store, log, registry: {}, sleep: async () => {} });
    expect(paused.status).toBe("paused");

    const answered = await execute(graph, paused, {
      store,
      log,
      registry: {},
      sleep: async () => {},
      humanAnswers: { ask: `approved, reused ${SECRET}` },
    });

    const { wire, statuses } = await push(runId, answered);

    expect(statuses).toEqual([200]);
    expect(wire).not.toContain(SECRET);
    expect(wire).toContain("human_requested");
    expect(wire).toContain("human_resolved");
    // Both the interpolated question and the typed answer survive, masked.
    expect(wire).toContain("ship with sk-a...?");
    expect(wire).toContain("approved, reused sk-a...");
  });

  it("c. the local events.jsonl keeps the raw values - sanitising is a push-time transform only", async () => {
    const runId = "run-local";
    const graph = parseGraph(FAILING_GRAPH);
    const state = newRunState(graph, { runId, cwd });
    const failed = await execute(graph, state, {
      store,
      log,
      registry: {
        command: stub("command", {
          ok: false,
          text: "",
          costUsd: 0,
          raw: null,
          error: `could not read ${HOME_PATH}, key ${SECRET}`,
        }),
      },
      sleep: async () => {},
    });

    const before = localLog(runId);
    expect(before).toContain(SECRET);
    expect(before).toContain(HOME_PATH);

    await push(runId, failed);

    // Byte-identical after the push: sync writes only the cursor.
    expect(localLog(runId)).toBe(before);
    expect(localLog(runId)).toContain(SECRET);
    expect(localLog(runId)).toContain(HOME_PATH);
  });
});

describe("sanitizeEventLine", () => {
  const line = (kind: string, data: Record<string, unknown>, nodeId?: string): string =>
    JSON.stringify({
      ts: "2026-08-25T00:00:00.000Z",
      runId: "r",
      seq: 0,
      kind,
      ...(nodeId === undefined ? {} : { nodeId }),
      data,
    });

  it("rewrites the raw cwd run_started publishes, which the projection rewrote and this did not", () => {
    const out = sanitizeEventLine(
      line("run_started", { graph: "g", resumed: false, cwd: `${HOME}/work/repo`, streamId: "s" }),
      { ...opts, repoRoot: "/nowhere" },
    );
    const data = (JSON.parse(out!) as { data: Record<string, unknown> }).data;
    expect(data.cwd).toBe("${HOME}/work/repo");
    expect(data).toEqual({ graph: "g", resumed: false, cwd: "${HOME}/work/repo", streamId: "s" });
  });

  it("drops a data field nobody classified, rather than publishing it", () => {
    // The whole point of the allowlist: a field added to an event's `data`
    // upstream must NOT start publishing itself just because it exists.
    const out = sanitizeEventLine(
      line("node_finished", { status: "failed", attempts: 1, costUsd: 0, error: null, stdout: SECRET }),
      opts,
    );
    expect(out).not.toContain(SECRET);
    expect(JSON.parse(out!)).toEqual({
      ts: "2026-08-25T00:00:00.000Z",
      runId: "r",
      seq: 0,
      kind: "node_finished",
      data: { status: "failed", attempts: 1, costUsd: 0, error: null },
    });
  });

  it("drops an unclassifiable line entirely: bad JSON, a non-object, or an unknown kind", () => {
    expect(sanitizeEventLine("not json", opts)).toBeNull();
    expect(sanitizeEventLine("[1,2,3]", opts)).toBeNull();
    expect(sanitizeEventLine("null", opts)).toBeNull();
    expect(sanitizeEventLine(line("teleported", { secret: SECRET }), opts)).toBeNull();
  });

  it("drops a text field whose type changed under us instead of publishing it unsanitised", () => {
    const out = sanitizeEventLine(line("human_requested", { question: { raw: SECRET } }, "ask"), opts);
    expect(out).not.toContain(SECRET);
    expect((JSON.parse(out!) as { data: Record<string, unknown> }).data).toEqual({});
  });

  it("leaves a line with nothing to sanitise byte-identical to its local log line", () => {
    const source = line("node_started", { attempt: 1, type: "command" }, "boom");
    expect(sanitizeEventLine(source, opts)).toBe(source);
  });

  it("buildBatch is the choke point: the lines it emits are the sanitised ones", () => {
    const graph = parseGraph(FAILING_GRAPH);
    const state = newRunState(graph, { runId: "run-b", cwd });
    const batch = buildBatch(state, opts, [
      line("node_finished", { status: "failed", attempts: 1, costUsd: 0, error: SECRET }, "boom"),
      "this line cannot be classified",
    ]);
    expect(batch.events).toHaveLength(1);
    expect(batch.events[0]).not.toContain(SECRET);
    expect(batch.events[0]).toContain("sk-a...");
  });
});

describe("control characters on the event path", () => {
  it("an ANSI-coloured node error goes out clean on the EVENT line too, and the hub accepts the batch", async () => {
    // The event path reuses `safeText`, so it inherits control stripping. This
    // pins that: an ESC on an event line is not schema-checked by the hub (the
    // event `data` record is deliberately permissive), so nothing else would
    // catch a regression here - the colour codes would just silently publish.
    const runId = "run-ansi";
    const graph = parseGraph(FAILING_GRAPH);
    const state = newRunState(graph, { runId, cwd });
    const failed = await execute(graph, state, {
      store,
      log,
      registry: {
        command: stub("command", {
          ok: false,
          text: "",
          costUsd: 0,
          raw: null,
          error: `\u001b[31mbuild failed\u001b[0m reading ${HOME_PATH}\n\tkey ${SECRET}`,
        }),
      },
      sleep: async () => {},
    });

    const { wire, statuses } = await push(runId, failed);

    expect(statuses).toEqual([200]);
    // Both forms: a raw ESC, and the `\\u001b` text JSON.stringify would escape
    // it to. Asserting only the raw char would pass vacuously.
    expect(wire).not.toContain("\u001b");
    expect(wire).not.toContain("\\u001b");
    expect(wire).not.toContain("[31m");
    expect(wire).not.toContain(SECRET);
    expect(wire).not.toContain(HOME_PATH);
    // The newline is legitimate and survives, JSON-escaped, on the event line.
    expect(wire).toContain("build failed reading ${HOME}/.config/loomgraph/hub.json");
    expect(wire).toContain("sk-a...");

    // ...and the escape is still in the local log, where JSON.stringify wrote
    // it as the six characters `\\u001b`.
    expect(localLog(runId)).toContain("\\u001b[31m");
    expect(localLog(runId)).toContain(SECRET);
  });
});
