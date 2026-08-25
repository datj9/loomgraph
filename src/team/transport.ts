import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EventBatch } from "../hub/wire.js";

/**
 * The single network seam for the client, shaped after the subset of the global
 * `fetch` we use. Tests inject a fake; the real global `fetch` is only ever
 * reached through this seam and no test in this repo uses it.
 *
 * Every request carries an `AbortSignal` so a caller can bound the request with
 * an `AbortController` without touching the seam's implementation.
 */
export type Fetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{ status: number; json(): Promise<unknown> }>;

/** Where to push and who we are. Never printed and never logged. */
export interface HubConfig {
  url: string;
  token: string;
}

const HUB_URL_KEY = "LOOMGRAPH_HUB_URL";
const HUB_TOKEN_KEY = "LOOMGRAPH_HUB_TOKEN";

/**
 * Resolve the hub identity config: env first, then `~/.config/loomgraph/hub.json`
 * (`{url, token}`), else null. BOTH parts must be present - a url with no token
 * is null, not a partial config, because a config that cannot authenticate is a
 * config that would be retried forever.
 *
 * NEVER throws. A missing file, an unreadable file, non-JSON content, or JSON
 * missing either field all mean null. Commit 1.13 calls this from inside a live
 * run, and a hub outage must not affect a run - an absent hub must read as "no
 * hub configured", never as an error.
 */
export function loadHubConfig(env: NodeJS.ProcessEnv, home: string): HubConfig | null {
  if (isNonEmptyString(env[HUB_URL_KEY]) && isNonEmptyString(env[HUB_TOKEN_KEY])) {
    return { url: env[HUB_URL_KEY] as string, token: env[HUB_TOKEN_KEY] as string };
  }
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(home, ".config", "loomgraph", "hub.json"), "utf8"),
    );
    if (parsed !== null && typeof parsed === "object") {
      const url = (parsed as Record<string, unknown>).url;
      const token = (parsed as Record<string, unknown>).token;
      if (isNonEmptyString(url) && isNonEmptyString(token)) {
        return { url, token };
      }
    }
  } catch {
    // Missing, unreadable or non-JSON identity file reads as "not configured".
  }
  return null;
}

/**
 * The repo-level opt-in flag. `<cwd>/.loomgraph/hub.json` holds only
 * `{"sync": true}` and NEVER contains a token - it is the repo's consent to
 * sync, while the identity (url + token) lives in `~/.config/loomgraph/hub.json`.
 * Two different files, two different jobs; keep them separate.
 *
 * NEVER throws. Missing, unreadable, non-JSON, or `sync` anything other than
 * `true` all read as disabled.
 */
export function repoSyncEnabled(cwd: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(cwd, ".loomgraph", "hub.json"), "utf8"));
    if (parsed !== null && typeof parsed === "object") {
      return (parsed as Record<string, unknown>).sync === true;
    }
  } catch {
    // No opt-in file reads as no opt-in.
  }
  return false;
}

/**
 * Push one batch to `POST {url}/v1/events`.
 *
 * NEVER REJECTS AND NEVER THROWS. Every failure becomes `{ok:false}` with a
 * useful message: a non-2xx status, the timeout firing, `f` itself rejecting
 * (connection refused / DNS failure - a dead hub is the most likely real
 * condition and must not surface as an unhandled rejection), `json()` rejecting,
 * or a 2xx whose body is not an object carrying a numeric `highWaterSeq`.
 *
 * The timer is cleared in a finally so a fast response cannot leave a dangling
 * timer behind.
 */
export async function postEvents(
  f: Fetch,
  cfg: HubConfig,
  batch: EventBatch,
  timeoutMs: number,
): Promise<{ ok: true; highWaterSeq: number } | { ok: false; error: string }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (timeoutMs > 0) {
      timer = setTimeout(() => controller.abort(), timeoutMs);
      timer.unref();
    }
    const res = await f(`${cfg.url}/v1/events`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${cfg.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(batch),
      signal: controller.signal,
    });
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, error: `hub rejected the batch: HTTP ${res.status}` };
    }
    const body: unknown = await res.json();
    if (body === null || typeof body !== "object") {
      return { ok: false, error: "hub returned a non-object body on 2xx" };
    }
    const highWaterSeq = (body as Record<string, unknown>).highWaterSeq;
    if (typeof highWaterSeq !== "number" || !Number.isInteger(highWaterSeq)) {
      return { ok: false, error: "hub 2xx response names no numeric highWaterSeq" };
    }
    return { ok: true, highWaterSeq };
  } catch (err) {
    if (isAbortError(err)) {
      return { ok: false, error: `hub request timed out after ${timeoutMs}ms` };
    }
    return { ok: false, error: `hub request failed: ${errorText(err)}` };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

function isAbortError(err: unknown): boolean {
  // Node surfaces timeout-driven aborts as an AbortError rejection, not a status.
  return err instanceof Error && err.name === "AbortError";
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}