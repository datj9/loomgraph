import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import type {
  EventBatch,
  FeedItem,
  IngestConflict,
  IngestResult,
  ProjectedState,
  RunRow,
} from "./wire.js";
import { NO_EVENTS_YET } from "./wire.js";

/**
 * The schema from docs/hub-design.md section 6.3, copied verbatim: every table,
 * index, trigger and PRAGMA, including the tables phases 2-4 will use and the
 * fts5 `search` virtual table. `events` stays an ordinary rowid table - the
 * keyset feed cursor depends on `rowid` existing.
 */
const SCHEMA = `
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
PRAGMA user_version=1;

CREATE TABLE events (
  member TEXT NOT NULL, stream_id TEXT NOT NULL, run_id TEXT NOT NULL, seq INTEGER NOT NULL,
  received_at TEXT NOT NULL, kind TEXT NOT NULL, node_id TEXT,
  json TEXT NOT NULL CHECK (json_valid(json)),
  prev_hash BLOB, row_hash BLOB NOT NULL,
  UNIQUE (member, stream_id, run_id, seq)
);
-- design 6.3 writes ON events(received_at, rowid); SQLite rejects an explicit
-- rowid column in an index ("no such column: rowid"), but every index ends with
-- the rowid implicitly, so ON events(received_at) serves the same (received_at,
-- rowid) keyset ordering. Verified against this machine's SQLite.
CREATE INDEX events_feed ON events(received_at);

CREATE TABLE chain_head (id INTEGER PRIMARY KEY CHECK (id = 1), head BLOB NOT NULL);

CREATE TABLE runs (
  member TEXT NOT NULL, run_id TEXT NOT NULL, stream_id TEXT NOT NULL,
  graph_name TEXT, state_json TEXT, high_water_seq INTEGER NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (member, run_id));

CREATE TABLE briefs (
  brief_id TEXT PRIMARY KEY, member TEXT NOT NULL, sha256 TEXT UNIQUE NOT NULL,
  received_at TEXT NOT NULL, expires_at TEXT, revoked_at TEXT,
  key_id TEXT REFERENCES item_keys(key_id),
  handoff_md BLOB, meta_json BLOB, html BLOB);
CREATE TABLE brief_files (brief_id TEXT, path TEXT, PRIMARY KEY (brief_id, path));
CREATE TABLE brief_shares (brief_id TEXT, grantee TEXT, granted_at TEXT, revoked_at TEXT,
  PRIMARY KEY (brief_id, grantee));

CREATE TABLE inbox (
  id TEXT PRIMARY KEY, from_member TEXT NOT NULL, to_member TEXT NOT NULL,
  subject TEXT, body TEXT, re_json TEXT, proposed_graph TEXT,
  state TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE inbox_history (id TEXT, to_state TEXT, ts TEXT, by TEXT, run_id TEXT);

CREATE TABLE members (
  key_id TEXT PRIMARY KEY, member TEXT NOT NULL, token_hash TEXT NOT NULL,
  scopes TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT);
CREATE TABLE sessions (sid TEXT PRIMARY KEY, member TEXT, expires_at TEXT);
CREATE TABLE read_marks (member TEXT, kind TEXT, ref TEXT, read_at TEXT,
  PRIMARY KEY (member, kind, ref));
CREATE TABLE access_log (ts TEXT, member TEXT, action TEXT, ref TEXT);
CREATE TABLE item_keys (key_id TEXT PRIMARY KEY, wrapped_key BLOB NOT NULL);

CREATE VIRTUAL TABLE search USING fts5(member, kind, ref, text);

CREATE TRIGGER events_no_update BEFORE UPDATE ON events
  BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events
  BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;
`;

const GENESIS = Buffer.alloc(32);

export interface HubStoreDeps {
  now(): string;
}

function defaultNow(): string {
  return new Date(Date.now()).toISOString();
}

/**
 * commit 1.6's auth.ts MUST import these rather than reimplement them; a second
 * copy of token minting or hashing is a security defect.
 */
export function mintKeyId(): string {
  return randomBytes(4).toString("hex");
}

/**
 * commit 1.6's auth.ts MUST import these rather than reimplement them; a second
 * copy of token minting or hashing is a security defect.
 */
export function mintSecret(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * commit 1.6's auth.ts MUST import these rather than reimplement them; a second
 * copy of token minting or hashing is a security defect. Hashes the base64url
 * secret string only, never the whole token, and returns lowercase hex.
 */
export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/**
 * commit 1.6's auth.ts MUST import these rather than reimplement them; a second
 * copy of token minting or hashing is a security defect.
 */
export function formatToken(keyId: string, secret: string): string {
  return `lgt_${keyId}.${secret}`;
}

interface CursorPayload {
  receivedAt: string;
  rowid: number;
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

function decodeCursor(cursor: string): CursorPayload {
  let text: string;
  try {
    text = Buffer.from(cursor, "base64").toString("utf8");
  } catch (err) {
    throw new Error(`invalid feed cursor: ${String(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("invalid feed cursor: not a JSON payload");
  }
  const obj = parsed as { receivedAt?: unknown; rowid?: unknown };
  if (typeof obj.receivedAt !== "string" || typeof obj.rowid !== "number" || !Number.isInteger(obj.rowid) || obj.rowid < 1) {
    throw new Error("invalid feed cursor: expected {receivedAt: string, rowid: integer}");
  }
  return { receivedAt: obj.receivedAt, rowid: obj.rowid };
}

export class HubStore {
  static open(path: string, deps?: HubStoreDeps): HubStore {
    return new HubStore(path, deps ?? { now: defaultNow });
  }

  private readonly db: DatabaseSync;
  private readonly now: () => string;

  private constructor(path: string, deps: HubStoreDeps) {
    this.db = new DatabaseSync(path);
    this.now = deps.now;
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
    const version = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    if (version.user_version === 0) {
      this.db.exec(SCHEMA);
    }
    this.db
      .prepare("INSERT INTO chain_head(id, head) VALUES (1, ?) ON CONFLICT(id) DO NOTHING")
      .run(GENESIS);
  }

  close(): void {
    this.db.close();
  }

  /**
   * One transaction for the whole call. The `json` column is the client line
   * byte-for-byte - never re-serialized. A divergent seq at or below the
   * high-water mark aborts the whole transaction: nothing is written.
   */
  ingest(member: string, batch: EventBatch): IngestResult | IngestConflict {
    this.db.exec("BEGIN");
    try {
      const receivedAt = this.now();
      let prevHash = this.chainHeadBuffer();
      let accepted = 0;
      let duplicates = 0;
      let conflict: IngestConflict | null = null;

      const compareStmt = this.db.prepare(
        "SELECT json FROM events WHERE member=? AND stream_id=? AND run_id=? AND seq=?",
      );
      const insertStmt = this.db.prepare(
        `INSERT INTO events
          (member, stream_id, run_id, seq, received_at, kind, node_id, json, prev_hash, row_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(member, stream_id, run_id, seq) DO NOTHING`,
      );

      for (const line of batch.events) {
        const parsed = JSON.parse(line) as { seq?: unknown; kind?: unknown; nodeId?: unknown };
        if (typeof parsed.seq !== "number") {
          throw new Error(`event line is missing a numeric seq: ${line.slice(0, 80)}`);
        }
        const stored = compareStmt.get(member, batch.streamId, batch.runId, parsed.seq) as
          | { json: string }
          | undefined;
        if (stored !== undefined) {
          if (stored.json !== line) {
            conflict = { conflict: true, runId: batch.runId, seq: parsed.seq };
            break;
          }
          duplicates += 1;
          continue;
        }
        const kind = typeof parsed.kind === "string" ? parsed.kind : "";
        const nodeId = typeof parsed.nodeId === "string" ? parsed.nodeId : null;
        const rowHash = createHash("sha256").update(prevHash).update(line, "utf8").digest();
        const inserted = Number(
          insertStmt.run(
            member, batch.streamId, batch.runId, parsed.seq, receivedAt, kind, nodeId,
            line, prevHash, rowHash,
          ).changes,
        );
        prevHash = rowHash;
        accepted += inserted;
      }

      if (conflict !== null) {
        this.db.exec("ROLLBACK");
        return conflict;
      }

      const highWater = this.db.prepare(
        "SELECT MAX(seq) AS m FROM events WHERE member=? AND stream_id=? AND run_id=?",
      ).get(member, batch.streamId, batch.runId) as { m: number | null };
      const highWaterSeq = highWater.m === null ? NO_EVENTS_YET : highWater.m;

      if (accepted > 0) {
        this.db.prepare("UPDATE chain_head SET head=? WHERE id=1").run(prevHash);
      }

      this.db.prepare(
        `INSERT INTO runs (member, run_id, stream_id, graph_name, state_json, high_water_seq, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(member, run_id) DO UPDATE SET
           stream_id = excluded.stream_id,
           graph_name = excluded.graph_name,
           state_json = excluded.state_json,
           high_water_seq = excluded.high_water_seq,
           updated_at = excluded.updated_at`,
      ).run(
        member, batch.runId, batch.streamId, batch.graphName,
        JSON.stringify(batch.state), highWaterSeq, receivedAt,
      );

      this.db.exec("COMMIT");
      return { conflict: false, highWaterSeq, accepted, duplicates };
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // no active transaction left to roll back
      }
      throw err;
    }
  }

  highWater(member: string, streamId: string, runId: string): number {
    const row = this.db.prepare(
      "SELECT MAX(seq) AS m FROM events WHERE member=? AND stream_id=? AND run_id=?",
    ).get(member, streamId, runId) as { m: number | null };
    return row.m === null ? NO_EVENTS_YET : row.m;
  }

  runState(member: string, runId: string): ProjectedState | null {
    const row = this.db.prepare(
      "SELECT state_json FROM runs WHERE member=? AND run_id=?",
    ).get(member, runId) as { state_json: string | null } | undefined;
    if (row === undefined || row.state_json === null) return null;
    return JSON.parse(row.state_json) as ProjectedState;
  }

  events(member: string, streamId: string, runId: string): string[] {
    const rows = this.db.prepare(
      "SELECT json FROM events WHERE member=? AND stream_id=? AND run_id=? ORDER BY seq",
    ).all(member, streamId, runId) as Array<{ json: string }>;
    return rows.map((r) => r.json);
  }

  listRuns(member?: string): RunRow[] {
    const sql = `
      SELECT r.member, r.run_id, r.stream_id, r.graph_name, r.state_json, r.updated_at,
        COALESCE(
          (SELECT MAX(e.received_at) FROM events e
            WHERE e.member = r.member AND e.run_id = r.run_id),
          r.updated_at
        ) AS received_at
      FROM runs r
      ${member !== undefined ? "WHERE r.member = ?" : ""}
      ORDER BY r.updated_at DESC
    `;
    const rows = (
      member !== undefined
        ? this.db.prepare(sql).all(member)
        : this.db.prepare(sql).all()
    ) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      member: r.member as string,
      runId: r.run_id as string,
      streamId: r.stream_id as string,
      graphName: r.graph_name as string,
      status: this.statusOf(r.state_json),
      updatedAt: r.updated_at as string,
      receivedAt: r.received_at as string,
    }));
  }

  *allEvents(): Iterable<{ member: string; runId: string; json: string }> {
    const stmt = this.db.prepare(
      "SELECT member, run_id, json FROM events ORDER BY member, run_id, seq",
    );
    for (const row of stmt.iterate()) {
      yield {
        member: row.member as string,
        runId: row.run_id as string,
        json: row.json as string,
      };
    }
  }

  chainHead(): string {
    return this.chainHeadBuffer().toString("hex");
  }

  addMember(member: string, scopes: string[]): { keyId: string; token: string } {
    const scopesList = scopes.length > 0 ? scopes : ["ingest", "read"];
    const keyId = mintKeyId();
    const secret = mintSecret();
    const tokenHash = hashSecret(secret);
    this.db.prepare(
      "INSERT INTO members (key_id, member, token_hash, scopes, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(keyId, member, tokenHash, JSON.stringify(scopesList), this.now());
    return { keyId, token: formatToken(keyId, secret) };
  }

  memberByKeyId(
    keyId: string,
  ): { member: string; tokenHash: string; scopes: string[]; revokedAt: string | null } | null {
    const row = this.db.prepare(
      "SELECT member, token_hash, scopes, revoked_at FROM members WHERE key_id=?",
    ).get(keyId) as
      | { member: string; token_hash: string; scopes: string; revoked_at: string | null }
      | undefined;
    if (row === undefined) return null;
    return {
      member: row.member,
      tokenHash: row.token_hash,
      scopes: JSON.parse(row.scopes) as string[],
      revokedAt: row.revoked_at,
    };
  }

  revokeMember(keyId: string): boolean {
    const existing = this.db.prepare(
      "SELECT revoked_at FROM members WHERE key_id=?",
    ).get(keyId) as { revoked_at: string | null } | undefined;
    if (existing === undefined || existing.revoked_at !== null) return false;
    this.db.prepare("UPDATE members SET revoked_at=? WHERE key_id=?").run(this.now(), keyId);
    return true;
  }

  listMembers(): Array<{ keyId: string; member: string; revokedAt: string | null }> {
    const rows = this.db.prepare(
      "SELECT key_id, member, revoked_at FROM members ORDER BY created_at",
    ).all() as Array<{ key_id: string; member: string; revoked_at: string | null }>;
    return rows.map((r) => ({ keyId: r.key_id, member: r.member, revokedAt: r.revoked_at }));
  }

  feed(cursor: string | null, limit: number): { items: FeedItem[]; nextCursor: string | null } {
    const pageLimit = Math.max(1, Math.floor(limit));
    const decoded = cursor === null ? null : decodeCursor(cursor);

    let sql = `
      SELECT received_at, rowid, member, kind, run_id FROM events
      WHERE kind IN ('run_started', 'run_finished')
    `;
    const params: Array<string | number> = [];
    if (decoded !== null) {
      sql += "AND (received_at < ? OR (received_at = ? AND rowid < ?))";
      params.push(decoded.receivedAt, decoded.receivedAt, decoded.rowid);
    }
    sql += " ORDER BY received_at DESC, rowid DESC LIMIT ?";
    params.push(pageLimit + 1);

    const rows = this.db.prepare(sql).all(...params) as Array<{
      received_at: string;
      rowid: number;
      member: string;
      kind: string;
      run_id: string;
    }>;
    const hasMore = rows.length > pageLimit;
    const pageRows = hasMore ? rows.slice(0, pageLimit) : rows;
    const items: FeedItem[] = pageRows.map((r) => ({
      ts: r.received_at,
      member: r.member,
      kind: r.kind as FeedItem["kind"],
      ref: r.run_id,
    }));
    const last = pageRows[pageRows.length - 1];
    const nextCursor =
      hasMore && last !== undefined
        ? encodeCursor({ receivedAt: last.received_at, rowid: last.rowid })
        : null;
    return { items, nextCursor };
  }

  private chainHeadBuffer(): Buffer {
    const row = this.db.prepare("SELECT head FROM chain_head WHERE id=1").get() as
      | { head: Uint8Array }
      | undefined;
    return row === undefined ? Buffer.alloc(32) : Buffer.from(row.head);
  }

  private statusOf(stateJson: unknown): RunRow["status"] {
    if (typeof stateJson !== "string") {
      throw new Error("runs row has no state_json, cannot produce RunRow.status");
    }
    const parsed = JSON.parse(stateJson) as { status?: unknown };
    const status = parsed.status;
    if (
      status !== "pending" && status !== "running" && status !== "paused" &&
      status !== "succeeded" && status !== "failed"
    ) {
      throw new Error(`runs row carries an unknown status: ${String(status)}`);
    }
    return status;
  }
}
