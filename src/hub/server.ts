import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { MAX_BODY_BYTES } from "./wire.js";
import { handle, type WireRequest, type WireResponse } from "./handlers.js";

export interface ServeDeps {
  handle(req: WireRequest): WireResponse;
}

/**
 * The HTTP binding, deliberately dumb. This file owns no routing, no auth and no
 * validation - those all live in handlers.ts and are tested there. Reading a request,
 * capping the body, calling handle() and writing the reply is all that happens here,
 * so "untested wiring" stays an honest claim (assumption A2).
 */
export function createHttpServer(deps: ServeDeps) {
  return createServer((req, res) => {
    void readBody(req, MAX_BODY_BYTES)
      .then((result) => {
        if (!result.ok) {
          writeResponse(res, { status: 413, body: { error: "body too large" } });
          return;
        }
        const wire: WireRequest = buildWireRequest(req, result.body);
        writeResponse(res, deps.handle(wire));
      })
      .catch(() => {
        writeResponse(res, { status: 400, body: { error: "bad request" } });
      });
  });
}

/**
 * Loopback, and therefore always allowed, is exactly: any IPv4 in 127.0.0.0/8,
 * `::1` (also written `[::1]`), and the literal string `localhost`. Everything else
 * is refused unless `behindTlsProxy` is true. A bearer token over plaintext
 * non-loopback HTTP is exactly the credential shape the scanner's `auth-header`
 * rule exists for, so the default refusal is the point - do not soften it.
 */
export function refuseBind(host: string, behindTlsProxy: boolean): string | null {
  if (isLoopback(host)) return null;
  if (behindTlsProxy) return null;
  return (
    `refusing to bind ${host}: a bearer token over plaintext non-loopback HTTP ` +
    `would expose the hub's credentials. Pass --behind-tls-proxy if a trusted TLS ` +
    `proxy terminates the connection in front of this address.`
  );
}

function isLoopback(host: string): boolean {
  if (host === "localhost") return true;
  const plain = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const ipv6 = plain.includes(":");
  if (ipv6) return plain === "::1";
  const octets = plain.split(".");
  return (
    octets.length === 4 &&
    octets.every((o) => /^\d{1,3}$/.test(o) && Number(o) >= 0 && Number(o) <= 255) &&
    Number(octets[0]) === 127
  );
}

function buildWireRequest(req: IncomingMessage, body: unknown): WireRequest {
  const url = new URL(req.url ?? "/", "http://localhost");
  const query: Record<string, string> = {};
  for (const [k, v] of url.searchParams.entries()) query[k] = v;
  const headers: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) headers[k] = v.join(", ");
    else headers[k] = v;
  }
  return { method: req.method ?? "GET", path: url.pathname, query, headers, body };
}

function readBody(
  req: IncomingMessage,
  cap: number,
): Promise<{ ok: true; body: unknown } | { ok: false }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > cap) {
        aborted = true;
        req.destroy();
        resolve({ ok: false });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (aborted) return;
      const raw = Buffer.concat(chunks);
      if (raw.length === 0) {
        resolve({ ok: true, body: raw.toString("utf8") });
        return;
      }
      try {
        resolve({ ok: true, body: JSON.parse(raw.toString("utf8")) });
      } catch {
        reject(new Error("bad json"));
      }
    });
    req.on("error", reject);
  });
}

function writeResponse(res: ServerResponse, wire: WireResponse): void {
  res.statusCode = wire.status;
  res.setHeader("content-type", "application/json");
  if (wire.headers !== undefined) {
    for (const [k, v] of Object.entries(wire.headers)) res.setHeader(k, v);
  }
  res.end(JSON.stringify(wire.body));
}
