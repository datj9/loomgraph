import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { CheckpointStore } from "../core/store.js";
import { escapeHtml, renderReportHtml } from "./render.js";
import { reportCommand } from "./report.js";
import type { LgEvent } from "../core/events.js";
import type { RunState } from "../core/types.js";

function makeState(overrides: Partial<RunState> = {}): RunState {
  return {
    runId: "demo-20260814-120000-ab12",
    streamId: "stream-1",
    graphName: "demo",
    status: "succeeded",
    createdAt: "2026-08-14T12:00:00.000Z",
    updatedAt: "2026-08-14T12:01:00.000Z",
    cwd: "/repo",
    vars: { ticket: "LG-1" },
    budget: { maxUsd: 2, maxWallClockSec: 1800, maxNodeRuns: 20 },
    spent: { usd: 0.25, wallClockSec: 60, nodeRuns: 2 },
    nodes: {
      greet: {
        nodeId: "greet", status: "succeeded",
        startedAt: "2026-08-14T12:00:00.000Z", endedAt: "2026-08-14T12:00:30.000Z",
        attempts: 1, output: "hello", error: null, costUsd: 0,
      },
    },
    completed: ["greet"],
    seq: 2,
    ...overrides,
  };
}

const noEvents: LgEvent[] = [];

describe("escapeHtml", () => {
  it("escapes ampersands, angle brackets and quotes", () => {
    expect(escapeHtml("a < b")).toBe("a &lt; b");
    expect(escapeHtml("</script>")).toBe("&lt;/script&gt;");
    expect(escapeHtml("Tom & \"Jerry\"")).toBe("Tom &amp; &quot;Jerry&quot;");
  });

  it("returns an empty string unchanged", () => {
    expect(escapeHtml("")).toBe("");
  });
});

describe("renderReportHtml", () => {
  it("renders a complete html document for a run", () => {
    const out = renderReportHtml(makeState(), noEvents);
    expect(out.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(out).toContain("greet");
    expect(out).toContain("0.0000");
  });

  it("escapes a hostile graph name so no raw tag reaches the document", () => {
    const out = renderReportHtml(makeState({ graphName: "<img src=x onerror=alert(1)>" }), noEvents);
    expect(out).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(out).not.toContain("<img ");
  });

  it("escapes a node error string", () => {
    const state = makeState({
      nodes: {
        greet: {
          nodeId: "greet", status: "failed",
          startedAt: "2026-08-14T12:00:00.000Z", endedAt: "2026-08-14T12:00:30.000Z",
          attempts: 1, output: "", error: "boom </td>", costUsd: 0,
        },
      },
    });
    expect(renderReportHtml(state, noEvents)).toContain("boom &lt;/td&gt;");
  });

  it("renders the budget line and the cost note", () => {
    const out = renderReportHtml(makeState(), noEvents);
    expect(out).toContain("0.2500/2.0000 usd · 60s/1800s wall clock · 2/20 node runs");
    expect(out).toContain(
      "note: adapters that do not report a price (codex, command) record 0.0000 usd - the number is not estimated.",
    );
  });

  it("is deterministic for identical inputs", () => {
    const state = makeState();
    expect(renderReportHtml(state, noEvents)).toBe(renderReportHtml(state, noEvents));
  });

  it("renders a run with no nodes and no events", () => {
    const out = renderReportHtml(makeState({ nodes: {}, completed: [], status: "pending" }), noEvents);
    expect(out.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(out).toContain(
      "note: adapters that do not report a price (codex, command) record 0.0000 usd - the number is not estimated.",
    );
  });

  it("embeds no external resource", () => {
    const out = renderReportHtml(makeState(), noEvents);
    expect(out).not.toContain("<link ");
    expect(out).not.toContain('src="http');
    expect(out).not.toContain("url(http");
  });

  it("renders one row per event", () => {
    const events: LgEvent[] = [
      { ts: "2026-08-14T12:00:00.000Z", runId: "demo-20260814-120000-ab12", seq: 0, kind: "node_started", nodeId: "greet", data: {} },
      { ts: "2026-08-14T12:00:30.000Z", runId: "demo-20260814-120000-ab12", seq: 1, kind: "node_finished", nodeId: "greet", data: { ok: true } },
      { ts: "2026-08-14T12:01:00.000Z", runId: "demo-20260814-120000-ab12", seq: 2, kind: "run_finished", data: {} },
    ];
    const out = renderReportHtml(makeState(), events);
    expect(out).toContain("node_started");
    expect(out).toContain("node_finished");
    expect(out).toContain("run_finished");
  });
});

describe("renderReportHtml document contract", () => {
  it("declares the document language on the root <html> element", () => {
    const out = renderReportHtml(makeState(), noEvents);
    expect(out).toContain('<html lang="en"');
  });

  it("emits a utf-8 charset meta tag inside <head>", () => {
    const out = renderReportHtml(makeState(), noEvents);
    expect(out).toContain('<meta charset="utf-8">');
  });

  it("declares the charset before <title> and within the first 1024 characters", () => {
    const out = renderReportHtml(makeState(), noEvents);
    const meta = out.indexOf('<meta charset=');
    const title = out.indexOf("<title>");
    expect(meta).toBeGreaterThanOrEqual(0);
    expect(title).toBeGreaterThan(meta);
    expect(meta).toBeLessThan(1024);
  });

  it("starts the document with a <!DOCTYPE html> declaration", () => {
    const out = renderReportHtml(makeState(), noEvents);
    expect(out.startsWith("<!DOCTYPE html>")).toBe(true);
  });

  it("keeps non-ASCII characters intact while still escaping hostile markup", () => {
    const state = makeState({
      graphName: "café → <plan>",
      nodes: {
        greet: {
          nodeId: "greet", status: "failed",
          startedAt: "2026-08-14T12:00:00.000Z", endedAt: "2026-08-14T12:00:30.000Z",
          attempts: 1, output: "", error: "café → boom </td>", costUsd: 0,
        },
      },
    });
    const out = renderReportHtml(state, noEvents);
    expect(out).toContain("café → &lt;plan&gt;");
    expect(out).toContain("café → boom &lt;/td&gt;");
    expect(out).not.toContain("<plan>");
    expect(out).not.toContain("boom </td>");
  });
});

describe("reportCommand --publish", () => {
  const runId = "demo-20260814-120000-ab12";
  const title = `loomgraph run ${runId}`;
  const pushJson = JSON.stringify({
    artifactId: "art-1",
    versionId: "v1",
    versionNo: 1,
    viewUrl: "https://enclave.example/v/1",
    uploaded: [],
    skipped: [],
  });

  let work: string;
  let fakeBin: string;
  let capturedDir: string;
  let capturedListing: string;
  let originalCwd: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "lg-report-work-"));
    fakeBin = mkdtempSync(join(tmpdir(), "lg-report-bin-"));
    capturedDir = join(fakeBin, "dir.txt");
    capturedListing = join(fakeBin, "listing.txt");
    originalCwd = process.cwd();
    originalPath = process.env.PATH;
    process.chdir(work);

    // A real run record, so reportCommand can find the run.
    new CheckpointStore(join(work, ".loomgraph", "runs")).save(makeState());

    // Decoys sitting in the working directory: the exact files that must never
    // be uploaded when --publish is used.
    writeFileSync(join(work, "hello.yaml"), "graph: {}\n", "utf8");
    mkdirSync(join(work, ".loomgraph", "secrets"), { recursive: true });
    writeFileSync(join(work, ".loomgraph", "secrets", "token.txt"), "token", "utf8");
    writeFileSync(join(work, "other-report.html"), "<html>old</html>", "utf8");

    // FAKE enclave: a stub script that records the directory it is told to
    // publish and the listing of that directory, then answers like the real
    // binary would. The real enclave on the host PATH is never touched.
    const stub = join(fakeBin, "enclave");
    writeFileSync(
      stub,
      [
        "#!/bin/sh",
        `printf '%s\\n' "$2" > "${capturedDir}"`,
        `ls -A "$2" > "${capturedListing}"`,
        `printf '%s' '${pushJson}'`,
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(stub, 0o755);
    process.env.PATH = `${fakeBin}${delimiter}${originalPath}`;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    rmSync(work, { recursive: true, force: true });
    rmSync(fakeBin, { recursive: true, force: true });
  });

  it("publishes only the generated report, never the working directory", async () => {
    const out = join(work, "r1.html");
    const code = await reportCommand(runId, { out, publish: true, title });

    expect(code).toBe(0);
    expect(existsSync(out)).toBe(true);

    // The directory handed to the publisher must be neither the working
    // directory nor the report's own parent (they are the same dir here).
    const pushedDir = readFileSync(capturedDir, "utf8").trim();
    expect(pushedDir).not.toBe(work);
    expect(pushedDir).not.toBe(dirname(out));

    // And it must contain exactly one entry: the report itself, none of the
    // decoys (hello.yaml, .loomgraph/…, other-report.html).
    const listing = readFileSync(capturedListing, "utf8")
      .split("\n")
      .filter((l) => l !== "");
    expect(listing).toEqual(["r1.html"]);
  });

  it("removes the staging directory after publishing", async () => {
    const out = join(work, "r1.html");
    const code = await reportCommand(runId, { out, publish: true, title });

    expect(code).toBe(0);
    const pushedDir = readFileSync(capturedDir, "utf8").trim();
    expect(pushedDir).not.toBe(work);
    expect(existsSync(pushedDir)).toBe(false);
  });

  it("does not call the publisher at all without --publish", async () => {
    const out = join(work, "r1.html");
    const code = await reportCommand(runId, { out, title });

    expect(code).toBe(0);
    expect(existsSync(out)).toBe(true);
    // The fake stub records nothing: never invoked.
    expect(existsSync(capturedDir)).toBe(false);
  });

  it.each(["public", "hackerman"])(
    "refuses --visibility %s with exit code 1 and never spawns enclave",
    async (visibility) => {
      const out = join(work, "r1.html");
      const code = await reportCommand(runId, {
        out,
        publish: true,
        visibility: visibility as "private" | "org",
      });

      expect(code).toBe(1);
      expect(existsSync(out)).toBe(true);
      // The fake stub records nothing: never invoked.
      expect(existsSync(capturedDir)).toBe(false);
    },
  );

  it.each(["private", "org"])("still accepts --visibility %s", async (visibility) => {
    const out = join(work, "r1.html");
    const code = await reportCommand(runId, {
      out,
      publish: true,
      title,
      visibility: visibility as "private" | "org",
    });

    expect(code).toBe(0);
    expect(existsSync(out)).toBe(true);
    // The fake stub was invoked and recorded the pushed directory.
    expect(existsSync(capturedDir)).toBe(true);
  });
});
