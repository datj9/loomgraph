import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { EventBatch } from "../hub/wire.js";
import { loadHubConfig, postEvents, repoSyncEnabled, type Fetch, type HubConfig } from "./transport.js";

function batch(): EventBatch {
  return {
    runId: "run-1",
    streamId: "s-1",
    graphName: "g",
    state: {
      runId: "run-1",
      graphName: "g",
      status: "running",
      createdAt: "2026-08-25T00:00:00.000Z",
      updatedAt: "2026-08-25T00:00:01.000Z",
      cwd: "${REPO_ROOT}",
      varKeys: [],
      budget: { maxUsd: 1, maxWallClockSec: 60, maxNodeRuns: 10 },
      spent: { usd: 0, wallClockSec: 0, nodeRuns: 0 },
      nodes: {},
      completed: [],
      seq: 1,
    },
    events: [],
  };
}

const cfg: HubConfig = { url: "http://hub.test", token: "lgt_00000000.FAKEfake0000FAKEfake0000" };

function okFetch(status: number, body: unknown): Fetch {
  return async () => ({ status, json: async () => body });
}

describe("postEvents", () => {
  it("1. returns ok with the highWaterSeq on a 200", async () => {
    const f = okFetch(200, { highWaterSeq: 7, accepted: 2, duplicates: 0 });
    const result = await postEvents(f, cfg, batch(), 1000);
    expect(result).toEqual({ ok: true, highWaterSeq: 7 });
  });

  it("2. a non-2xx status becomes {ok:false}", async () => {
    const f = okFetch(500, { error: "boom" });
    const result = await postEvents(f, cfg, batch(), 1000);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("500");
  });

  it("3. f rejecting (ECONNREFUSED) becomes {ok:false} and the call does not reject", async () => {
    const f: Fetch = async () => {
      const err = new Error("connect ECONNREFUSED 127.0.0.1:8080");
      (err as NodeJS.ErrnoException).code = "ECONNREFUSED";
      throw err;
    };
    const result = await postEvents(f, cfg, batch(), 1000);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("ECONNREFUSED");
  });

  it("4. the timeout firing becomes {ok:false} - no hang, no rejection", async () => {
    const f: Fetch = (_url, init) =>
      new Promise<{ status: number; json(): Promise<unknown> }>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const err = new Error("signal aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    const started = Date.now();
    const result = await postEvents(f, cfg, batch(), 25);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("timed out");
  });

  it("4a. a transport that ignores the abort signal is still bounded", async () => {
    const f: Fetch = () => new Promise(() => {}); // never settles, ignores the signal
    const started = Date.now();
    const result = await postEvents(f, cfg, batch(), 25);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("hub request timed out after 25ms");
  });

  it("4b. with a timeout of 0, a cooperative transport still resolves normally", async () => {
    const f = okFetch(200, { highWaterSeq: 7, accepted: 2, duplicates: 0 });
    const result = await postEvents(f, cfg, batch(), 0);
    expect(result).toEqual({ ok: true, highWaterSeq: 7 });
  });

  it("5. json() rejecting becomes {ok:false}", async () => {
    const f: Fetch = async () => ({
      status: 200,
      json: async () => {
        throw new Error("Unexpected token < in JSON");
      },
    });
    const result = await postEvents(f, cfg, batch(), 1000);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Unexpected token");
  });

  it("6. a 200 whose body has no numeric highWaterSeq becomes {ok:false}", async () => {
    const nonNumeric: unknown[] = [
      { error: "something else" },
      { highWaterSeq: "3" },
      { highWaterSeq: null },
      null,
      "plain text",
      42,
    ];
    for (const body of nonNumeric) {
      const result = await postEvents(okFetch(200, body), cfg, batch(), 1000);
      expect(result.ok).toBe(false);
    }
  });
});

describe("loadHubConfig", () => {
  let tmp: string;
  let home: string;

  const writeHub = (content: string): void => {
    mkdirSync(join(home, ".config", "loomgraph"), { recursive: true });
    writeFileSync(join(home, ".config", "loomgraph", "hub.json"), content, "utf8");
  };

  const env = (url: string | undefined, token: string | undefined): NodeJS.ProcessEnv => ({
    ...(url === undefined ? {} : { LOOMGRAPH_HUB_URL: url }),
    ...(token === undefined ? {} : { LOOMGRAPH_HUB_TOKEN: token }),
  });

  it("7a. env wins over the config file", () => {
    writeHub(JSON.stringify({ url: "http://file", token: "file-token" }));
    const result = loadHubConfig(env("http://env", "env-token"), home);
    expect(result).toEqual({ url: "http://env", token: "env-token" });
  });

  it("7b. the config file is used when env vars are absent", () => {
    writeHub(JSON.stringify({ url: "http://file", token: "file-token" }));
    const result = loadHubConfig({}, home);
    expect(result).toEqual({ url: "http://file", token: "file-token" });
  });

  it("7c. only a url set -> null (no usable file either)", () => {
    expect(loadHubConfig(env("http://env", undefined), home)).toBeNull();
  });

  it("7d. only a token set -> null (no usable file either)", () => {
    expect(loadHubConfig(env(undefined, "env-token"), home)).toBeNull();
  });

  it("7e. a missing config file -> null", () => {
    expect(loadHubConfig({}, home)).toBeNull();
  });

  it("7f. a non-JSON config file -> null", () => {
    writeHub("this is {not json]");
    expect(loadHubConfig({}, home)).toBeNull();
  });

  it("7g. JSON missing a field -> null", () => {
    writeHub(JSON.stringify({ url: "http://file" }));
    expect(loadHubConfig({}, home)).toBeNull();
    writeHub(JSON.stringify({ token: "file-token" }));
    expect(loadHubConfig({}, home)).toBeNull();
  });

  it("7h. whitespace-only env credentials are treated as absent, so the file is consulted", () => {
    writeHub(JSON.stringify({ url: "http://file", token: "file-token" }));
    expect(loadHubConfig(env("   ", "env-token"), home)).toEqual({
      url: "http://file",
      token: "file-token",
    });
    expect(loadHubConfig(env("http://env", "   "), home)).toEqual({
      url: "http://file",
      token: "file-token",
    });
    // Without a usable file, whitespace-only credentials mean no config at all.
    expect(loadHubConfig(env("   ", "env-token"), join(tmp, "empty"))).toBeNull();
  });

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "loomgraph-transport-"));
    home = join(tmp, "home");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });
});

describe("repoSyncEnabled", () => {
  let tmp: string;
  let cwd: string;

  const writeOptIn = (content: string): void => {
    mkdirSync(join(cwd, ".loomgraph"), { recursive: true });
    writeFileSync(join(cwd, ".loomgraph", "hub.json"), content, "utf8");
  };

  it("8a. true only for {\"sync\":true}", () => {
    writeOptIn(JSON.stringify({ sync: true }));
    expect(repoSyncEnabled(cwd)).toBe(true);
  });

  it("8b. a missing opt-in file -> false", () => {
    expect(repoSyncEnabled(cwd)).toBe(false);
  });

  it("8c. a non-JSON opt-in file -> false", () => {
    writeOptIn("sync=true oops");
    expect(repoSyncEnabled(cwd)).toBe(false);
  });

  it("8d. {\"sync\":\"yes\"} -> false", () => {
    writeOptIn(JSON.stringify({ sync: "yes" }));
    expect(repoSyncEnabled(cwd)).toBe(false);
  });

  it("8e. {} -> false", () => {
    writeOptIn(JSON.stringify({}));
    expect(repoSyncEnabled(cwd)).toBe(false);
  });

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "loomgraph-optin-"));
    cwd = join(tmp, "repo");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });
});