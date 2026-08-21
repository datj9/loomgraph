import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  packCommand,
  pushCommand,
  scanCommand,
  SHARE_URL_FILE,
  type Exec,
} from "./commands.js";
import { writeBundle } from "./bundle.js";

// Every spawn in these tests goes through this fake. No test may execute
// claude, codex, opencode, enclave or git (AGENTS.md), so a test that asserts
// "enclave was never invoked" is asserting on `calls` being empty.
interface Call {
  bin: string;
  args: string[];
  cwd?: string;
}

interface Fake {
  exec: Exec;
  calls: Call[];
}

type Reply = { exitCode?: number; stdout?: string; stderr?: string; code?: string };

function fakeExec(replies: (call: Call) => Reply): Fake {
  const calls: Call[] = [];
  const exec: Exec = async (bin, args, opts) => {
    const call: Call = { bin, args, cwd: opts?.cwd };
    calls.push(call);
    const reply = replies(call);
    const exitCode = reply.exitCode ?? 0;
    return {
      exitCode,
      stdout: reply.stdout ?? "",
      stderr: reply.stderr ?? "",
      failed: exitCode !== 0 || reply.code !== undefined,
      code: reply.code,
    };
  };
  return { exec, calls };
}

/** An exec that fails the test if it is ever reached. */
const forbiddenExec: Fake = (() => {
  const calls: Call[] = [];
  const exec: Exec = async (bin, args) => {
    calls.push({ bin, args });
    throw new Error(`exec must not be called, got ${bin}`);
  };
  return { exec, calls };
})();

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lg-handoff-"));
  dirs.push(dir);
  return dir;
}

function collector(): { log: (s: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { log: (s) => lines.push(s), lines };
}

/** A minimal, publishable bundle. */
function goodBundle(dir: string, extra?: string): void {
  writeBundle(dir, {
    "index.html": `<!doctype html><html><body><h1>handoff</h1>${extra ?? ""}</body></html>`,
    "handoff.md": "# handoff\n",
    "meta.json": JSON.stringify({ v: 1, title: "sess handoff" }),
    "files.txt": "src/a.ts\n",
  });
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
  forbiddenExec.calls.length = 0;
});

const PUSH_JSON = JSON.stringify({
  artifactId: "art_1",
  viewUrl: "https://enclave.example/a/art_1",
});
const SHARE_JSON = JSON.stringify({ url: "https://enclave.example/s/tok" });

function enclaveOk(): Fake {
  return fakeExec((call) => {
    if (call.args[0] === "push") return { stdout: PUSH_JSON };
    return { stdout: SHARE_JSON };
  });
}

/**
 * Assembled from split parts on purpose. The value is fabricated, but a
 * provider's secret scanner matches on shape rather than validity, so a whole
 * literal in the source files a false-positive alert against this repo.
 */
const FAKE_AWS_KEY = "AKIA" + "I0FAKE0FAKE0FAKE";

describe("pushCommand", () => {
  it("publishes, then mints a share link, in that order", async () => {
    const dir = tempDir();
    goodBundle(dir);
    const fake = enclaveOk();
    const { log, lines } = collector();

    const code = await pushCommand(
      dir,
      { expires: "7d", dryRun: false, visibility: "private" },
      fake.exec,
      log,
    );

    expect(code).toBe(0);
    expect(fake.calls.map((c) => `${c.bin} ${c.args[0]} ${c.args[1] ?? ""}`.trim())).toEqual([
      `enclave push ${dir}`,
      "enclave share create",
    ]);
    expect(fake.calls[0]!.args).toContain("--visibility");
    expect(fake.calls[0]!.args).toContain("private");
    expect(fake.calls[0]!.args).not.toContain("--dry-run");
    // Title is read back out of the bundle's meta.json when not given.
    expect(fake.calls[0]!.args[3]).toBe("sess handoff");
    expect(fake.calls[1]!.args).toEqual([
      "share",
      "create",
      "art_1",
      "--expires",
      "7d",
      "--json",
    ]);
    expect(lines).toContain("https://enclave.example/s/tok");
  });

  it("writes the print-once share url into the bundle", async () => {
    const dir = tempDir();
    goodBundle(dir);
    const { log } = collector();

    await pushCommand(
      dir,
      { expires: "30d", dryRun: false, visibility: "private" },
      enclaveOk().exec,
      log,
    );

    expect(readFileSync(join(dir, SHARE_URL_FILE), "utf8")).toBe(
      "https://enclave.example/s/tok\n",
    );
  });

  it("prefers an explicit --title over the bundle's meta.json", async () => {
    const dir = tempDir();
    goodBundle(dir);
    const fake = enclaveOk();
    const { log } = collector();

    await pushCommand(
      dir,
      { title: "override", expires: "7d", dryRun: false, visibility: "private" },
      fake.exec,
      log,
    );

    expect(fake.calls[0]!.args[3]).toBe("override");
  });

  it("refuses a bundle containing a secret without invoking enclave", async () => {
    const dir = tempDir();
    goodBundle(dir);
    // A fabricated key shape, planted so the scanner has something to catch.
    writeFileSync(
      join(dir, "handoff.md"),
      `the run exported AWS_SECRET_KEY=${FAKE_AWS_KEY}\n`,
      "utf8",
    );
    const { log, lines } = collector();

    const code = await pushCommand(
      dir,
      { expires: "7d", dryRun: false, visibility: "private" },
      forbiddenExec.exec,
      log,
    );

    expect(code).toBe(2);
    expect(forbiddenExec.calls).toEqual([]);
    expect(lines.some((l) => l.includes("refusing to push"))).toBe(true);
    expect(lines.some((l) => l.includes(FAKE_AWS_KEY))).toBe(false);
  });

  it("refuses a bundle that breaks the enclave contract without invoking enclave", async () => {
    const dir = tempDir();
    // No index.html, and a disallowed extension.
    writeFileSync(join(dir, "session.jsonl"), "{}\n", "utf8");
    const { log, lines } = collector();

    const code = await pushCommand(
      dir,
      { expires: "7d", dryRun: false, visibility: "private" },
      forbiddenExec.exec,
      log,
    );

    expect(code).toBe(2);
    expect(forbiddenExec.calls).toEqual([]);
    expect(lines.some((l) => l.includes("missing index.html"))).toBe(true);
    expect(lines.some((l) => l.includes("allowlist"))).toBe(true);
  });

  it("refuses a non-private visibility before any other work", async () => {
    const dir = tempDir();
    goodBundle(dir);
    const { log, lines } = collector();

    const code = await pushCommand(
      dir,
      { expires: "7d", dryRun: false, visibility: "org" },
      forbiddenExec.exec,
      log,
    );

    expect(code).toBe(1);
    expect(forbiddenExec.calls).toEqual([]);
    expect(lines.some((l) => l.includes("production data"))).toBe(true);
  });

  it("stops after push on --dry-run and never creates a share", async () => {
    const dir = tempDir();
    goodBundle(dir);
    const fake = fakeExec(() => ({ stdout: JSON.stringify({ dryRun: true }) }));
    const { log, lines } = collector();

    const code = await pushCommand(
      dir,
      { expires: "7d", dryRun: true, visibility: "private" },
      fake.exec,
      log,
    );

    expect(code).toBe(0);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.args).toContain("--dry-run");
    expect(lines.some((l) => l.includes("dry run"))).toBe(true);
  });

  it("reports a missing enclave binary and leaves the bundle on disk", async () => {
    const dir = tempDir();
    goodBundle(dir);
    const fake = fakeExec(() => ({ exitCode: 1, code: "ENOENT" }));
    const { log, lines } = collector();

    const code = await pushCommand(
      dir,
      { expires: "7d", dryRun: false, visibility: "private" },
      fake.exec,
      log,
    );

    expect(code).toBe(1);
    expect(lines.some((l) => l.includes("enclave not found on PATH"))).toBe(true);
    expect(lines.some((l) => l.includes(dir))).toBe(true);
  });

  it("returns 2 when enclave push exits non-zero", async () => {
    const dir = tempDir();
    goodBundle(dir);
    const fake = fakeExec(() => ({ exitCode: 3, stderr: "quota exceeded" }));
    const { log, lines } = collector();

    const code = await pushCommand(
      dir,
      { expires: "7d", dryRun: false, visibility: "private" },
      fake.exec,
      log,
    );

    expect(code).toBe(2);
    expect(lines).toContain("quota exceeded");
  });

  it("returns 2 when share create returns no url, after reporting the view url", async () => {
    const dir = tempDir();
    goodBundle(dir);
    const fake = fakeExec((call) =>
      call.args[0] === "push" ? { stdout: PUSH_JSON } : { stdout: "{}" },
    );
    const { log, lines } = collector();

    const code = await pushCommand(
      dir,
      { expires: "7d", dryRun: false, visibility: "private" },
      fake.exec,
      log,
    );

    expect(code).toBe(2);
    expect(lines).toContain("https://enclave.example/a/art_1");
    expect(lines.some((l) => l.includes("no share url"))).toBe(true);
  });
});

describe("scanCommand", () => {
  it("returns 0 for a clean bundle", async () => {
    const dir = tempDir();
    goodBundle(dir);
    const { log, lines } = collector();

    expect(await scanCommand(dir, log)).toBe(0);
    expect(lines).toContain("scan clean");
  });

  it("returns 2 and reports masked findings for a dirty bundle", async () => {
    const dir = tempDir();
    goodBundle(dir);
    writeFileSync(join(dir, "handoff.md"), `key: ${FAKE_AWS_KEY}\n`, "utf8");
    const { log, lines } = collector();

    expect(await scanCommand(dir, log)).toBe(2);
    expect(lines.some((l) => l.includes("aws-access-key") && l.includes("handoff.md:1"))).toBe(
      true,
    );
    expect(lines.some((l) => l.includes(FAKE_AWS_KEY))).toBe(false);
  });
});

// Fabricated transcript. Deliberately free of absolute home paths so the pack
// happy path stays scan-clean; path redaction has its own tests in scan.test.ts.
const CLAUDE_JSONL = [
  `{"type":"user","sessionId":"sess-9","cwd":"/repo/demo","message":{"role":"user","content":"add a parser for src/handoff/readers/codex.ts"}}`,
  `{"type":"assistant","sessionId":"sess-9","message":{"role":"assistant","model":"claude-opus-5","content":[{"type":"text","text":"Added src/handoff/readers/codex.ts and a test."}]}}`,
].join("\n");

function gitExec(): Fake {
  return fakeExec((call) => {
    if (call.bin !== "git") return { exitCode: 1 };
    if (call.args[1] === "get-url") return { stdout: "git@example.com:acme/demo.git" };
    if (call.args.includes("--abbrev-ref")) return { stdout: "feat/handoff" };
    return { stdout: "a".repeat(40) };
  });
}

describe("packCommand", () => {
  it("writes a bundle from an explicit session file and records repo facts", async () => {
    const work = tempDir();
    const sessionFile = join(work, "session.jsonl");
    writeFileSync(sessionFile, CLAUDE_JSONL, "utf8");
    const out = join(work, "bundle");
    const fake = gitExec();
    const { log, lines } = collector();

    const code = await packCommand(
      { adapter: "claude", cwd: work, sessionFile, out, title: "demo handoff" },
      fake.exec,
      log,
    );

    expect(code).toBe(0);
    expect(lines.some((l) => l.includes(`using session file ${sessionFile}`))).toBe(true);
    expect(lines).toContain("scan clean");

    const meta = JSON.parse(readFileSync(join(out, "meta.json"), "utf8"));
    expect(meta.v).toBe(1);
    expect(meta.adapter).toBe("claude");
    expect(meta.sessionId).toBe("sess-9");
    expect(meta.title).toBe("demo handoff");
    expect(meta.repo).toEqual({
      remote: "git@example.com:acme/demo.git",
      sha: "a".repeat(40),
      branch: "feat/handoff",
    });

    const html = readFileSync(join(out, "index.html"), "utf8");
    expect(html).toContain("demo handoff");
    expect(readFileSync(join(out, "handoff.md"), "utf8")).toContain("## Next action");
    expect(readFileSync(join(out, "files.txt"), "utf8")).toContain(
      "src/handoff/readers/codex.ts",
    );

    // Only git was spawned; packing never touches enclave.
    expect(new Set(fake.calls.map((c) => c.bin))).toEqual(new Set(["git"]));
  });

  it("records null repo fields and warns when git fails", async () => {
    const work = tempDir();
    const sessionFile = join(work, "session.jsonl");
    writeFileSync(sessionFile, CLAUDE_JSONL, "utf8");
    const out = join(work, "bundle");
    const fake = fakeExec(() => ({ exitCode: 128, stderr: "not a git repository" }));
    const { log, lines } = collector();

    const code = await packCommand({ adapter: "claude", cwd: work, sessionFile, out }, fake.exec, log);

    expect(code).toBe(0);
    const meta = JSON.parse(readFileSync(join(out, "meta.json"), "utf8"));
    expect(meta.repo).toEqual({ remote: null, sha: null, branch: null });
    expect(lines.filter((l) => l.startsWith("warning: could not read repo"))).toHaveLength(3);
  });

  it("survives a git seam that rejects", async () => {
    const work = tempDir();
    const sessionFile = join(work, "session.jsonl");
    writeFileSync(sessionFile, CLAUDE_JSONL, "utf8");
    const out = join(work, "bundle");
    const exec: Exec = async () => {
      throw new Error("spawn refused");
    };
    const { log } = collector();

    expect(
      await packCommand({ adapter: "claude", cwd: work, sessionFile, out }, exec, log),
    ).toBe(0);
  });

  it("returns 1 when the session file cannot be read", async () => {
    const work = tempDir();
    const { log, lines } = collector();

    const code = await packCommand(
      { adapter: "claude", cwd: work, sessionFile: join(work, "nope.jsonl"), out: join(work, "b") },
      forbiddenExec.exec,
      log,
    );

    expect(code).toBe(1);
    expect(forbiddenExec.calls).toEqual([]);
    expect(lines.some((l) => l.includes("cannot read session file"))).toBe(true);
  });

  it("keeps a dirty bundle on disk but returns 2", async () => {
    const work = tempDir();
    const sessionFile = join(work, "session.jsonl");
    // A fabricated AWS key id inside a user turn: nothing rewrites this away,
    // so the post-render scan must catch it.
    writeFileSync(
      sessionFile,
      `{"type":"user","sessionId":"s","message":{"role":"user","content":"use ${FAKE_AWS_KEY} for the upload"}}`,
      "utf8",
    );
    const out = join(work, "bundle");
    const { log, lines } = collector();

    const code = await packCommand(
      { adapter: "claude", cwd: work, sessionFile, out },
      gitExec().exec,
      log,
    );

    expect(code).toBe(2);
    expect(readFileSync(join(out, "index.html"), "utf8")).toContain("<h1>");
    expect(lines.some((l) => l.includes("aws-access-key"))).toBe(true);
    expect(lines.some((l) => l.includes("will not be pushable"))).toBe(true);
  });

  it("exports an opencode session through the exec seam", async () => {
    const work = tempDir();
    const out = join(work, "bundle");
    const exportJson = JSON.stringify({
      id: "oc-1",
      messages: [
        { role: "user", parts: [{ type: "text", text: "rename the module" }] },
        { role: "assistant", parts: [{ type: "text", text: "renamed it" }] },
      ],
    });
    const fake = fakeExec((call) =>
      call.bin === "opencode" ? { stdout: exportJson } : { stdout: "" },
    );
    const { log, lines } = collector();

    const code = await packCommand(
      { adapter: "opencode", sessionRef: "oc-1", cwd: work, out },
      fake.exec,
      log,
    );

    expect(code).toBe(0);
    expect(fake.calls[0]).toEqual({
      bin: "opencode",
      args: ["export", "oc-1", "--sanitize"],
      cwd: work,
    });
    expect(lines.some((l) => l.includes("opencode export oc-1 --sanitize"))).toBe(true);
  });

  it("returns 1 when opencode is not installed", async () => {
    const work = tempDir();
    const fake = fakeExec(() => ({ exitCode: 1, code: "ENOENT" }));
    const { log, lines } = collector();

    const code = await packCommand(
      { adapter: "opencode", cwd: work, out: join(work, "bundle") },
      fake.exec,
      log,
    );

    expect(code).toBe(1);
    expect(lines.some((l) => l.includes("opencode not found on PATH"))).toBe(true);
  });

  it("returns 1 when the opencode export fails", async () => {
    const work = tempDir();
    const fake = fakeExec(() => ({ exitCode: 1, stderr: "no such session" }));
    const { log, lines } = collector();

    const code = await packCommand(
      { adapter: "opencode", cwd: work, out: join(work, "bundle") },
      fake.exec,
      log,
    );

    expect(code).toBe(1);
    expect(lines).toContain("no such session");
  });
});
