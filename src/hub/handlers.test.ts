import { describe, expect, it } from "vitest";
import { HubStore } from "./storage.js";
import { handle, type HandlerDeps, type WireRequest } from "./handlers.js";
import { MAX_BODY_BYTES, NO_EVENTS_YET } from "./wire.js";
import { VERSION } from "../index.js";
import type { ProjectedState } from "./wire.js";

const FROZEN = "2026-08-25T00:00:00.000Z";

function openStore(): HubStore {
  return HubStore.open(":memory:", { now: () => FROZEN });
}

function baseState(runId = "run-1"): ProjectedState {
  return {
    runId,
    graphName: "g",
    status: "running",
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:01.000Z",
    cwd: "/work",
    varKeys: [],
    budget: { maxUsd: 1, maxWallClockSec: 60, maxNodeRuns: 10 },
    spent: { usd: 0, wallClockSec: 0, nodeRuns: 0 },
    nodes: {},
    completed: [],
    seq: 1,
  };
}

function evLine(o: { seq: number; kind?: string; runId?: string; ts?: string }): string {
  const e: Record<string, unknown> = {
    ts: o.ts ?? "2026-08-25T00:00:00.000Z",
    runId: o.runId ?? "run-1",
    seq: o.seq,
    kind: o.kind ?? "run_started",
  };
  e.data = {};
  return JSON.stringify(e);
}

function batchBody(
  runId = "run-1",
  streamId = "s-1",
  events: string[] = [],
  state: ProjectedState = baseState(runId),
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { runId, streamId, graphName: "g", state, events, ...extra };
}

function makeDeps(store: HubStore): HandlerDeps {
  return { store, now: () => FROZEN, version: VERSION };
}

function authed(
  method: string,
  path: string,
  deps: HandlerDeps,
  token: string,
  query: Record<string, string> = {},
  body: unknown = undefined,
): ReturnType<typeof handle> {
  return handle(
    { method, path, query, headers: { authorization: `Bearer ${token}` }, body },
    deps,
  );
}

function mint(store: HubStore, member: string, scopes: string[]): string {
  return store.addMember(member, scopes).token;
}

describe("hub handlers", () => {
  it("1. health responds without a token", () => {
    const store = openStore();
    const res = handle({ method: "GET", path: "/v1/health", query: {}, headers: {}, body: undefined }, makeDeps(store));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, version: VERSION });
  });

  it("2. every other route 401s without a token", () => {
    const store = openStore();
    const deps = makeDeps(store);
    const noAuth = { method: "POST", path: "/v1/events", query: {}, headers: {}, body: undefined };
    expect(handle(noAuth, deps).status).toBe(401);
    expect(handle({ ...noAuth, method: "GET", path: "/v1/feed" }, deps).status).toBe(401);
    expect(handle({ ...noAuth, method: "GET", path: "/v1/runs/m/run-1" }, deps).status).toBe(401);
  });

  it("3. a good batch returns the high-water mark", () => {
    const store = openStore();
    const token = mint(store, "alice", ["ingest"]);
    const res = authed("POST", "/v1/events", makeDeps(store), token, {}, batchBody("run-1", "s-1", [evLine({ seq: 0 }), evLine({ seq: 1 })]));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ conflict: false, highWaterSeq: 1, accepted: 2, duplicates: 0 });
  });

  it("4. replaying the same batch returns the same mark with accepted: 0", () => {
    const store = openStore();
    const token = mint(store, "alice", ["ingest"]);
    const deps = makeDeps(store);
    const body = batchBody("run-1", "s-1", [evLine({ seq: 0 }), evLine({ seq: 1 })]);
    expect(authed("POST", "/v1/events", deps, token, {}, body).status).toBe(200);
    const second = authed("POST", "/v1/events", deps, token, {}, body);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ conflict: false, highWaterSeq: 1, accepted: 0, duplicates: 2 });
  });

  it("5. a divergent seq is 409 naming runId and seq", () => {
    const store = openStore();
    const token = mint(store, "alice", ["ingest"]);
    const deps = makeDeps(store);
    authed("POST", "/v1/events", deps, token, {}, batchBody("run-1", "s-1", [evLine({ seq: 0, kind: "run_started" })]));
    const res = authed("POST", "/v1/events", deps, token, {}, batchBody("run-1", "s-1", [evLine({ seq: 0, kind: "run_finished" })]));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "seq conflict", runId: "run-1", seq: 0 });
  });

  it("6. an over-cap body is 413 and is never parsed", () => {
    const store = openStore();
    const token = mint(store, "alice", ["ingest"]);
    const deps = makeDeps(store);
    const bad = batchBody("run-1", "s-1", [], baseState(), {
      extra: "x".repeat(MAX_BODY_BYTES + 1),
    });
    const badState = { ...baseState(), runId: "other" } as ProjectedState;
    const inconsistent = {
      ...bad,
      state: badState,
    } as { state: ProjectedState; runId: string };
    expect(inconsistent.state.runId).not.toBe(inconsistent.runId);
    const res = authed("POST", "/v1/events", deps, token, {}, inconsistent);
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: "body too large" });
    expect(store.listRuns()).toHaveLength(0);
  });

  it("7. a batch carrying member: someone-else in the body still stores under the token's member", () => {
    const store = openStore();
    const token = mint(store, "alice", ["ingest"]);
    const deps = makeDeps(store);
    const body = batchBody("run-1", "s-1", [evLine({ seq: 0 })], baseState(), { member: "someone-else" });
    const res = authed("POST", "/v1/events", deps, token, {}, body);
    expect(res.status).toBe(200);
    const runs = store.listRuns("alice");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.member).toBe("alice");
    expect(store.listRuns("someone-else")).toHaveLength(0);
  });

  it("8. reading another member's run returns their data unmodified", () => {
    const store = openStore();
    const aliceToken = mint(store, "alice", ["ingest", "read"]);
    const deps = makeDeps(store);
    authed("POST", "/v1/events", deps, aliceToken, {}, batchBody("run-1", "s-1", [evLine({ seq: 0 })], baseState("run-1")));
    const res = authed("GET", "/v1/runs/alice/run-1", deps, aliceToken);
    expect(res.status).toBe(200);
    const body = res.body as { state: ProjectedState; events: string[] };
    expect(body.state.runId).toBe("run-1");
    expect((body.state as unknown as Record<string, unknown>).member).toBeUndefined();
    expect(body.events.map((l) => JSON.parse(l).seq)).toEqual([0]);
  });

  it("9. a missing run is 404", () => {
    const store = openStore();
    const token = mint(store, "alice", ["read"]);
    const res = authed("GET", "/v1/runs/alice/nope", makeDeps(store), token);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not found" });
  });

  it("10. a garbage cursor is 400", () => {
    const store = openStore();
    const token = mint(store, "alice", ["read"]);
    const deps = makeDeps(store);
    mint(store, "alice", ["ingest"]);
    const res = authed("GET", "/v1/feed", deps, token, { after: "!!!not base64!!!" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "bad request" });
  });

  it("11. limit=9999 clamps to 200", () => {
    const store = openStore();
    const token = mint(store, "alice", ["read", "ingest"]);
    const deps = makeDeps(store);
    for (let i = 0; i < 250; i++) {
      authed("POST", "/v1/events", deps, token, {}, batchBody(`run-${i}`, "s-1", [evLine({ seq: 0, kind: "run_started", runId: `run-${i}` })], baseState(`run-${i}`)));
    }
    const res = authed("GET", "/v1/feed", deps, token, { limit: "9999" });
    expect(res.status).toBe(200);
    const body = res.body as { items: unknown[] };
    expect(body.items).toHaveLength(200);
  });

  it("12. a batch whose state.runId disagrees with its top-level runId is 400 and leaves the store empty", () => {
    const store = openStore();
    const token = mint(store, "alice", ["ingest"]);
    const deps = makeDeps(store);
    const body = batchBody("run-1", "s-1", [evLine({ seq: 0 })], baseState("run-2"));
    const res = authed("POST", "/v1/events", deps, token, {}, body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "run identity mismatch" });
    expect(store.listRuns()).toHaveLength(0);
  });

  it("13. an unknown route is 404", () => {
    const store = openStore();
    const deps = makeDeps(store);
    expect(handle({ method: "GET", path: "/v1/nope", query: {}, headers: {}, body: undefined }, deps).status).toBe(404);
    expect(handle({ method: "GET", path: "/", query: {}, headers: {}, body: undefined }, deps).status).toBe(404);
  });

  it("14. a token lacking ingest is 403 on POST events; lacking read is 403 on both GETs", () => {
    const store = openStore();
    const readToken = mint(store, "reader", ["read"]);
    const ingestToken = mint(store, "writer", ["ingest"]);
    const deps = makeDeps(store);
    expect(authed("POST", "/v1/events", deps, readToken, {}, batchBody()).status).toBe(403);
    expect(authed("GET", "/v1/feed", deps, ingestToken).status).toBe(403);
    expect(authed("GET", "/v1/runs/alice/run-1", deps, ingestToken).status).toBe(403);
  });

  it("15. a bad token AND a malformed body gives 401, not 400", () => {
    const store = openStore();
    const deps = makeDeps(store);
    const malformed = { runId: "run-1", youAreNotValid: true };
    const res = authed("POST", "/v1/events", deps, "lgt_00000000.invalidtoken", {}, malformed);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "unauthorized" });
  });

  it("16. a valid token without ingest AND a malformed body gives 403, not 400", () => {
    const store = openStore();
    const token = mint(store, "reader", ["read"]);
    const deps = makeDeps(store);
    const malformed = { runId: "run-1", youAreNotValid: true };
    const res = authed("POST", "/v1/events", deps, token, {}, malformed);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "forbidden" });
  });

  it("17. a revoked member's token gives 401", () => {
    const store = openStore();
    const { keyId, token } = store.addMember("alice", ["ingest"]);
    store.revokeMember(keyId);
    const res = authed("POST", "/v1/events", makeDeps(store), token, {}, batchBody());
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "unauthorized" });
  });

  it("18. an empty events array is 200 and carries NO_EVENTS_YET for a fresh run", () => {
    const store = openStore();
    const token = mint(store, "alice", ["ingest"]);
    const res = authed("POST", "/v1/events", makeDeps(store), token, {}, batchBody("run-1", "s-1", []));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ conflict: false, highWaterSeq: NO_EVENTS_YET, accepted: 0, duplicates: 0 });
  });

  it("19. health's body contains the VERSION imported from src/index.ts, not a literal", () => {
    const store = openStore();
    const res = handle({ method: "GET", path: "/v1/health", query: {}, headers: {}, body: undefined }, makeDeps(store));
    expect((res.body as { version: string }).version).toBe(VERSION);
    expect(VERSION).toBe("0.1.0");
  });

  it("20. a non-numeric limit falls back to 50", () => {
    const store = openStore();
    const token = mint(store, "alice", ["read", "ingest"]);
    const deps = makeDeps(store);
    for (let i = 0; i < 60; i++) {
      authed("POST", "/v1/events", deps, token, {}, batchBody(`run-${i}`, "s-1", [evLine({ seq: 0, kind: "run_started", runId: `run-${i}` })], baseState(`run-${i}`)));
    }
    const res = authed("GET", "/v1/feed", deps, token, { limit: "abc" });
    expect(res.status).toBe(200);
    expect((res.body as { items: unknown[] }).items).toHaveLength(50);
  });

  it("21. the 409 body carries both runId and seq, with the values from the conflict", () => {
    const store = openStore();
    const token = mint(store, "alice", ["ingest"]);
    const deps = makeDeps(store);
    authed("POST", "/v1/events", deps, token, {}, batchBody("run-7", "s-1", [evLine({ seq: 0, kind: "run_started", runId: "run-7" }), evLine({ seq: 1, runId: "run-7" })]));
    const res = authed("POST", "/v1/events", deps, token, {}, batchBody("run-7", "s-1", [evLine({ seq: 1, kind: "run_finished", runId: "run-7" })]));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "seq conflict", runId: "run-7", seq: 1 });
  });

  it("22. a GET to a route that only accepts POST (and vice versa) is 404", () => {
    const store = openStore();
    const token = mint(store, "alice", ["ingest", "read"]);
    const deps = makeDeps(store);
    expect(authed("GET", "/v1/events", deps, token, {}, batchBody()).status).toBe(404);
    expect(authed("POST", "/v1/feed", deps, token).status).toBe(404);
    expect(authed("POST", "/v1/runs/alice/run-1", deps, token).status).toBe(404);
    expect(authed("POST", "/v1/health", deps, token).status).toBe(404);
  });
});
