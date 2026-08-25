import { resolveMember } from "./auth.js";
import type { HubStore } from "./storage.js";
import { MAX_BODY_BYTES, eventBatchSchema } from "./wire.js";
import { VERSION } from "../index.js";

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

/**
 * `member` is attributed server-side from the token, never honored from the
 * request body. The batch schema is strict and has no `member` field, so a body
 * that happens to carry one must have it removed before validation or the
 * whole batch is refused as an unknown key.
 */
function withoutMember(body: unknown): unknown {
  if (typeof body === "object" && body !== null && !Array.isArray(body)) {
    const copy = { ...(body as Record<string, unknown>) };
    delete copy.member;
    return copy;
  }
  return body;
}

const bearer = (req: WireRequest): string | undefined => req.headers.authorization;

export function handle(req: WireRequest, deps: HandlerDeps): WireResponse {
  const seg = segments(req.path);

  if (req.method === "GET" && seg.length === 2 && seg[0] === "v1" && seg[1] === "health") {
    return { status: 200, body: { ok: true, version: VERSION } };
  }

  if (req.method === "POST" && seg.length === 2 && seg[0] === "v1" && seg[1] === "events") {
    if (JSON.stringify(req.body ?? null).length > MAX_BODY_BYTES) {
      return error(413, "body too large");
    }
    const member = resolveMember(deps.store, bearer(req));
    if (member === null) return error(401, "unauthorized");
    if (!member.scopes.includes("ingest")) return error(403, "forbidden");
    const parsed = eventBatchSchema.safeParse(withoutMember(req.body));
    if (!parsed.success) return error(400, "run identity mismatch");
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

  return error(404, "not found");
}
