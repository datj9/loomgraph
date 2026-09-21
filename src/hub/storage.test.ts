import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  HubStore,
  formatToken,
  hashSecret,
  mintKeyId,
  mintSecret,
  type HubStoreDeps,
} from "./storage.js";
import { NO_EVENTS_YET } from "./wire.js";
import type { EventBatch, FeedItem, ProjectedState, RunRow } from "./wire.js";

const FROZEN = "2026-08-25T00:00:00.000Z";
const frozenClock: HubStoreDeps = { now: () => FROZEN };

function openStore(deps: HubStoreDeps = frozenClock): HubStore {
  return HubStore.open(":memory:", deps);
}

function dbOf(store: HubStore): DatabaseSync {
  return (store as unknown as { db: DatabaseSync }).db;
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

function evLine(o: {
  seq: number;
  kind?: string;
  nodeId?: string;
  runId?: string;
  ts?: string;
  raw?: string;
}): string {
  if (o.raw !== undefined) return o.raw;
  const e: Record<string, unknown> = {
    ts: o.ts ?? "2026-08-25T00:00:00.000Z",
    runId: o.runId ?? "run-1",
    seq: o.seq,
    kind: o.kind ?? "run_started",
  };
  if (o.nodeId !== undefined) e.nodeId = o.nodeId;
  e.data = {};
  return JSON.stringify(e);
}

function batch(
  runId = "run-1",
  streamId = "s-1",
  events: string[] = [],
  state: ProjectedState = baseState(runId),
): EventBatch {
  return { runId, streamId, graphName: "g", state, events };
}

describe("HubStore", () => {
  it("1. refuses an UPDATE on events through the append-only trigger", () => {
    const s = openStore();
    s.ingest("m", batch("run-1", "s-1", [evLine({ seq: 0 })]));
    expect(() =>
      dbOf(s).exec("UPDATE events SET kind = 'run_finished' WHERE seq = 0"),
    ).toThrow();
  });

  it("2. refuses a DELETE on events through the append-only trigger", () => {
    const s = openStore();
    s.ingest("m", batch("run-1", "s-1", [evLine({ seq: 0 })]));
    expect(() => dbOf(s).exec("DELETE FROM events")).toThrow();
  });

  it("3. keeps both append-only triggers after a successful ingest", () => {
    const s = openStore();
    s.ingest("m", batch("run-1", "s-1", [evLine({ seq: 0 })]));
    const triggers = dbOf(s)
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
      .all() as Array<{ name: string }>;
    expect(triggers.map((t) => t.name)).toEqual(["events_no_delete", "events_no_update"]);
  });

  it("4. ingesting the same batch twice stores one set of rows and reports duplicates", () => {
    const s = openStore();
    const b = batch("run-1", "s-1", [evLine({ seq: 0 }), evLine({ seq: 1 })]);
    const first = s.ingest("m", b);
    const second = s.ingest("m", b);
    expect(first).toEqual({ conflict: false, highWaterSeq: 1, accepted: 2, duplicates: 0 });
    expect(second).toEqual({ conflict: false, highWaterSeq: 1, accepted: 0, duplicates: 2 });
    expect(s.events("m", "s-1", "run-1")).toHaveLength(2);
  });

  it("5. the same key with a different payload conflicts and writes nothing", () => {
    const s = openStore();
    s.ingest("m", batch("run-1", "s-1", [evLine({ seq: 0, kind: "run_started" })]));
    const before = dbOf(s).prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number };
    expect(before.c).toBe(1);
    const result = s.ingest(
      "m",
      batch("run-1", "s-1", [evLine({ seq: 0, kind: "run_finished" })]),
    );
    expect(result).toEqual({ conflict: true, runId: "run-1", seq: 0 });
    const after = dbOf(s).prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number };
    expect(after.c).toBe(1);
  });

  it("6. chainHead matches a hand-computed chain over three events", () => {
    const s = openStore();
    const lines = [evLine({ seq: 0 }), evLine({ seq: 1 }), evLine({ seq: 2 })];
    s.ingest("m", batch("run-1", "s-1", lines));
    let prev = Buffer.alloc(32);
    for (const line of lines) {
      prev = createHash("sha256").update(prev).update(line, "utf8").digest();
    }
    expect(s.chainHead()).toBe(prev.toString("hex"));
  });

  it("7. keyset cursors page the feed without repeating or skipping, even on a received_at tie", () => {
    let tick = 0;
    const iso = (t: number) => new Date(Date.UTC(2026, 7, 25, 0, 0, t)).toISOString();
    const s = openStore({ now: () => iso(tick) });

    s.ingest("m", batch("run-1", "s-1", [evLine({ seq: 0, kind: "run_started", runId: "run-1" })]));
    s.ingest(
      "m",
      batch("run-2", "s-1", [
        evLine({ seq: 0, kind: "run_started", runId: "run-2" }),
        evLine({ seq: 1, kind: "run_finished", runId: "run-2" }),
      ]),
    );
    tick = 1;
    s.ingest("m", batch("run-3", "s-1", [evLine({ seq: 0, kind: "run_started", runId: "run-3" })]));
    tick = 2;
    s.ingest(
      "m",
      batch("run-4", "s-1", [
        evLine({ seq: 0, kind: "run_started", runId: "run-4" }),
        evLine({ seq: 1, kind: "run_finished", runId: "run-4" }),
      ]),
    );
    tick = 3;
    s.ingest("m", batch("run-5", "s-1", [evLine({ seq: 0, kind: "run_started", runId: "run-5" })]));

    const expected: FeedItem[] = [
      { ts: iso(3), member: "m", kind: "run_started", ref: "run-5" },
      { ts: iso(2), member: "m", kind: "run_finished", ref: "run-4" },
      { ts: iso(2), member: "m", kind: "run_started", ref: "run-4" },
      { ts: iso(1), member: "m", kind: "run_started", ref: "run-3" },
      { ts: iso(0), member: "m", kind: "run_finished", ref: "run-2" },
      { ts: iso(0), member: "m", kind: "run_started", ref: "run-2" },
      { ts: iso(0), member: "m", kind: "run_started", ref: "run-1" },
    ];

    const collected: FeedItem[] = [];
    let cursor: string | null = null;
    let pages = 0;
    for (;;) {
      const page = s.feed(cursor, 2);
      collected.push(...page.items);
      pages += 1;
      expect(pages).toBeLessThan(20);
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    expect(collected).toEqual(expected);
    const keys = collected.map((c) => `${c.ts}|${c.ref}|${c.kind}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("8. allEvents yields every ingested line byte-for-byte", () => {
    const s = openStore();
    const l0 = '{  "ts":"2026-08-25T00:00:00.000Z",  "runId":"run-1",  "seq":0,  "kind":"run_started",  "data":{}  }';
    const l1 = evLine({ seq: 1, kind: "run_finished", ts: "2026-08-25T00:00:02.000Z" });
    s.ingest("m", batch("run-1", "s-1", [l0, l1]));
    expect([...s.allEvents()]).toEqual([
      { member: "m", runId: "run-1", json: l0 },
      { member: "m", runId: "run-1", json: l1 },
    ]);
  });

  it("9. addMember then memberByKeyId round-trips scopes, including the default", () => {
    const s = openStore();
    const { keyId, token } = s.addMember("alice", ["ingest", "read", "admin"]);
    expect(token.startsWith(`lgt_${keyId}.`)).toBe(true);
    const rec = s.memberByKeyId(keyId);
    expect(rec).not.toBeNull();
    expect(rec!.member).toBe("alice");
    expect(rec!.scopes).toEqual(["ingest", "read", "admin"]);
    expect(rec!.revokedAt).toBeNull();
    expect(rec!.tokenHash).not.toContain(token);

    const { keyId: defaultKey } = s.addMember("bob", []);
    expect(s.memberByKeyId(defaultKey)!.scopes).toEqual(["ingest", "read"]);
  });

  it("10. revokeMember stamps revoked_at once and is idempotent", () => {
    const s = openStore();
    const { keyId } = s.addMember("alice", []);
    expect(s.revokeMember(keyId)).toBe(true);
    const revokedAt = s.memberByKeyId(keyId)!.revokedAt;
    expect(revokedAt).toBe(FROZEN);
    expect(s.revokeMember(keyId)).toBe(false);
    expect(s.memberByKeyId(keyId)!.revokedAt).toBe(revokedAt);
    expect(s.revokeMember("does-not-exist")).toBe(false);
  });

  it("11. an empty batch against a fresh run returns NO_EVENTS_YET", () => {
    const s = openStore();
    const result = s.ingest("m", batch("run-1", "s-1", []));
    expect(result).toEqual({
      conflict: false,
      highWaterSeq: NO_EVENTS_YET,
      accepted: 0,
      duplicates: 0,
    });
    expect(s.highWater("m", "s-1", "run-1")).toBe(NO_EVENTS_YET);
  });

  it("12. an empty batch returns 0 when seq 0 is already stored", () => {
    const s = openStore();
    s.ingest("m", batch("run-1", "s-1", [evLine({ seq: 0 })]));
    const result = s.ingest("m", batch("run-1", "s-1", []));
    expect(result).toEqual({ conflict: false, highWaterSeq: 0, accepted: 0, duplicates: 0 });
    expect(s.highWater("m", "s-1", "run-1")).toBe(0);
  });

  it("13. a minted token matches the commit-1.1 loomgraph-hub-token scan rule", () => {
    const token = formatToken(mintKeyId(), mintSecret());
    expect(token).toMatch(/\blgt_[0-9a-f]{8}\.[A-Za-z0-9_-]{32,}/);
    const { keyId, token: fromStore } = openStore().addMember("m", []);
    expect(fromStore).toMatch(/\blgt_[0-9a-f]{8}\.[A-Za-z0-9_-]{32,}/);
    expect(fromStore.startsWith(`lgt_${keyId}.`)).toBe(true);
  });

  it("14. hashSecret is stable and never contains the secret", () => {
    const secret = mintSecret();
    const a = hashSecret(secret);
    const b = hashSecret(secret);
    expect(a).toBe(b);
    expect(a).not.toContain(secret);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("15. runState returns the newest stream when two streams share a runId", () => {
    const s = openStore();
    s.ingest(
      "m",
      batch("run-1", "s-1", [evLine({ seq: 0 })], { ...baseState("run-1"), status: "running" }),
    );
    s.ingest(
      "m",
      batch("run-1", "s-2", [evLine({ seq: 0 })], { ...baseState("run-1"), status: "succeeded" }),
    );
    expect(s.runState("m", "run-1")!.status).toBe("succeeded");
  });

  it("16. events() returns raw lines in seq order", () => {
    const s = openStore();
    s.ingest("m", batch("run-1", "s-1", [evLine({ seq: 0 }), evLine({ seq: 1 }), evLine({ seq: 2 })]));
    s.ingest("m", batch("run-1", "s-1", [evLine({ seq: 3 }), evLine({ seq: 4 })]));
    const lines = s.events("m", "s-1", "run-1");
    expect(lines.map((l) => JSON.parse(l).seq)).toEqual([0, 1, 2, 3, 4]);
  });

  it("17. listRuns returns a RunRow whose status switches exhaustively as RunStatus", () => {
    const s = openStore();
    s.ingest(
      "m",
      batch("run-1", "s-1", [evLine({ seq: 0 })], { ...baseState("run-1"), status: "running" }),
    );
    const [row] = s.listRuns();
    expect(row).toBeDefined();
    function statusCode(status: RunRow["status"]): number {
      switch (status) {
        case "pending":
          return 0;
        case "running":
          return 1;
        case "paused":
          return 2;
        case "succeeded":
          return 3;
        case "failed":
          return 4;
      }
    }
    expect(statusCode(row!.status)).toBe(1);
    expect(row!.member).toBe("m");
    expect(row!.runId).toBe("run-1");
    expect(row!.streamId).toBe("s-1");
    expect(row!.graphName).toBe("g");
    expect(row!.updatedAt).toBe(FROZEN);
  });

  it("18. listRuns filters to a member and lists all without one", () => {
    const s = openStore();
    s.ingest("alice", batch("run-1", "s-1", [evLine({ seq: 0 })]));
    s.ingest("bob", batch("run-2", "s-1", [evLine({ seq: 0 })]));
    const aliceRuns = s.listRuns("alice");
    expect(aliceRuns).toHaveLength(1);
    expect(aliceRuns[0]!.member).toBe("alice");
    expect(s.listRuns()).toHaveLength(2);
  });

  it("19. a divergent-seq conflict leaves chain_head unchanged", () => {
    const s = openStore();
    s.ingest("m", batch("run-1", "s-1", [evLine({ seq: 0 }), evLine({ seq: 1 })]));
    const before = s.chainHead();
    s.ingest("m", batch("run-1", "s-1", [evLine({ seq: 0, kind: "run_finished" })]));
    expect(s.chainHead()).toBe(before);
    expect(s.highWater("m", "s-1", "run-1")).toBe(1);
  });

  it("20. two members pushing the same runId do not collide", () => {
    const s = openStore();
    s.ingest("alice", batch("run-1", "s-1", [evLine({ seq: 0 })]));
    s.ingest("bob", batch("run-1", "s-1", [evLine({ seq: 0 })]));
    const count = dbOf(s)
      .prepare("SELECT COUNT(*) AS c FROM events WHERE run_id = 'run-1'")
      .get() as { c: number };
    expect(count.c).toBe(2);
    expect(s.listRuns()).toHaveLength(2);
    expect(s.highWater("alice", "s-1", "run-1")).toBe(0);
    expect(s.highWater("bob", "s-1", "run-1")).toBe(0);
  });

  it("21. a malformed feed cursor throws instead of resetting to page one", () => {
    const s = openStore();
    s.ingest("m", batch("run-1", "s-1", [evLine({ seq: 0 })]));
    expect(() => s.feed("!!!not base64!!!", 10)).toThrow();
    expect(() => s.feed(Buffer.from("this is not a cursor payload").toString("base64"), 10)).toThrow();
    expect(() =>
      s.feed(Buffer.from(JSON.stringify({ receivedAt: FROZEN })).toString("base64"), 10),
    ).toThrow();
    expect(() =>
      s.feed(Buffer.from(JSON.stringify({ receivedAt: FROZEN, rowid: -1 })).toString("base64"), 10),
    ).toThrow();
  });

  it("22. PRAGMA user_version is 1 after open", () => {
    const s = openStore();
    const version = dbOf(s).prepare("PRAGMA user_version").get() as { user_version: number };
    expect(version.user_version).toBe(1);
  });

  it("23. chainHead is 64 zeros on a fresh store", () => {
    expect(openStore().chainHead()).toBe("0".repeat(64));
  });
});
