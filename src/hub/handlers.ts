import { resolveMember } from "./auth.js";
import type { HubStore } from "./storage.js";
import { MAX_BODY_BYTES, eventBatchSchema } from "./wire.js";

export interface WireRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string | undefined>;
  body: unknown;
}

export interface WireResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface HandlerDeps {
  store: HubStore;
  now(): string;
  version: string;
}

function error(status: number, message: string, extra?: Record<string, unknown>): WireResponse {
  return { status, body: { error: message, ...extra } };
}

function segments(path: string): string[] {
  return path.split("/").filter((s) => s.length > 0);
}

const bearer = (req: WireRequest): string | undefined => req.headers.authorization;

/**
 * An identity disagreement between two places a batch names the same run. These
 * are the only zod refusals that report `run identity mismatch`; everything
 * else the schema refuses is a plain `bad request`. The `state`/`events` paths
 * and the event-line message come from `eventBatchSchema` in wire.ts - do not
 * reword them here or the distinguisher for the message-coupled case silently
 * degrades.
 */
function isIdentityMismatch(issues: readonly { path: readonly PropertyKey[]; message: string }[]): boolean {
  return issues.some(
    (issue) =>
      (issue.path.length === 2 &&
        issue.path[0] === "state" &&
        issue.path[1] === "runId") ||
      (issue.path.length === 2 &&
        issue.path[0] === "state" &&
        issue.path[1] === "graphName") ||
      (issue.path.length === 4 &&
        issue.path[0] === "state" &&
        issue.path[1] === "nodes" &&
        issue.path[3] === "nodeId") ||
      (issue.path.length === 2 &&
        issue.path[0] === "events" &&
        typeof issue.path[1] === "number" &&
        issue.message.includes("runId")),
  );
}

export function handle(req: WireRequest, deps: HandlerDeps): WireResponse {
  const seg = segments(req.path);

  if (req.method === "GET" && seg.length === 2 && seg[0] === "v1" && seg[1] === "health") {
    return { status: 200, body: { ok: true, version: deps.version } };
  }

  if (req.method === "POST" && seg.length === 2 && seg[0] === "v1" && seg[1] === "events") {
    const json = JSON.stringify(req.body ?? null);
    if (Buffer.byteLength(json, "utf8") > MAX_BODY_BYTES) {
      return error(413, "body too large");
    }
    const member = resolveMember(deps.store, bearer(req));
    if (member === null) return error(401, "unauthorized");
    if (!member.scopes.includes("ingest")) return error(403, "forbidden");
    const parsed = eventBatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return error(
        400,
        isIdentityMismatch(parsed.error.issues) ? "run identity mismatch" : "bad request",
      );
    }
    const result = deps.store.ingest(member.member, parsed.data);
    if (result.conflict) {
      return error(409, "seq conflict", { runId: result.runId, seq: result.seq });
    }
    return { status: 200, body: result };
  }

  if (req.method === "GET" && seg.length === 2 && seg[0] === "v1" && seg[1] === "feed") {
    const member = resolveMember(deps.store, bearer(req));
    if (member === null) return error(401, "unauthorized");
    if (!member.scopes.includes("read")) return error(403, "forbidden");
    let limit = 50;
    const raw = req.query["limit"];
    if (raw !== undefined) {
      const n = Number(raw);
      if (Number.isFinite(n) && Number.isInteger(n) && n >= 0) limit = n;
    }
    limit = Math.min(limit, 200);
    const after = req.query["after"] ?? null;
    let result;
    try {
      result = deps.store.feed(after, limit);
    } catch {
      return error(400, "bad request");
    }
    return { status: 200, body: { items: result.items, nextCursor: result.nextCursor } };
  }

  // List every run across members. The web UI's runs table reads this; the
  // per-run detail route below stays the drill-down.
  if (req.method === "GET" && seg.length === 2 && seg[0] === "v1" && seg[1] === "runs") {
    const member = resolveMember(deps.store, bearer(req));
    if (member === null) return error(401, "unauthorized");
    if (!member.scopes.includes("read")) return error(403, "forbidden");
    return { status: 200, body: { runs: deps.store.listRuns() } };
  }

  if (req.method === "GET" && seg.length === 4 && seg[0] === "v1" && seg[1] === "runs") {
    const member = resolveMember(deps.store, bearer(req));
    if (member === null) return error(401, "unauthorized");
    if (!member.scopes.includes("read")) return error(403, "forbidden");
    const targetMember = seg[2]!;
    const runId = seg[3]!;
    const runs = deps.store.listRuns(targetMember);
    const row = runs.find((r) => r.runId === runId);
    if (row === undefined) return error(404, "not found");
    return {
      status: 200,
      body: {
        state: deps.store.runState(targetMember, runId),
        events: deps.store.events(targetMember, row.streamId, runId),
      },
    };
  }

  // Member roster: read + create for the UI's admin screen. Creating a member is
  // exactly what `lg-hub member add` does; this exposes it to an admin-scoped
  // token so the roster is manageable from the browser. The minted token is
  // returned once, same contract as the CLI.
  if (seg.length === 2 && seg[0] === "v1" && seg[1] === "members") {
    const member = resolveMember(deps.store, bearer(req));
    if (member === null) return error(401, "unauthorized");
    if (!member.scopes.includes("admin")) return error(403, "forbidden");
    if (req.method === "GET") {
      return { status: 200, body: { members: deps.store.listMembers() } };
    }
    if (req.method === "POST") {
      const body = (req.body ?? {}) as { member?: unknown; scopes?: unknown };
      const name = typeof body.member === "string" ? body.member.trim() : "";
      if (name.length === 0) return error(400, "member name required");
      const scopes = Array.isArray(body.scopes)
        ? body.scopes.filter((s): s is string => typeof s === "string")
        : ["ingest", "read"];
      return { status: 200, body: deps.store.addMember(name, scopes) };
    }
    return error(405, "method not allowed");
  }

  if (
    req.method === "POST" &&
    seg.length === 4 &&
    seg[0] === "v1" &&
    seg[1] === "members" &&
    seg[3] === "revoke"
  ) {
    const member = resolveMember(deps.store, bearer(req));
    if (member === null) return error(401, "unauthorized");
    if (!member.scopes.includes("admin")) return error(403, "forbidden");
    return { status: 200, body: { revoked: deps.store.revokeMember(seg[2]!) } };
  }

  return error(404, "not found");
}
