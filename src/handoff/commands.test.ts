import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, hostname, tmpdir, userInfo } from "node:os";
import { packCommand, pushCommand, scanCommand, type Exec } from "./commands.js";
import { SHARE_URL_FILE, writeBundle } from "./bundle.js";

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

  it("scrubs a leftover SHARE-URL.txt before invoking enclave so a second push cannot republish it", async () => {
    const dir = tempDir();
    goodBundle(dir);
    writeFileSync(join(dir, SHARE_URL_FILE), "https://enclave.example/s/OLDTOKEN\n", "utf8");
    const fake = fakeExec((call) => {
      if (call.args[0] === "push") {
        expect(existsSync(join(dir, SHARE_URL_FILE))).toBe(false);
        return { stdout: PUSH_JSON };
      }
      return { stdout: SHARE_JSON };
    });
    const { log } = collector();

    const code = await pushCommand(
      dir,
      { expires: "7d", dryRun: false, visibility: "private" },
      fake.exec,
      log,
    );

    expect(code).toBe(0);
    expect(fake.calls.map((c) => c.args[0])).toEqual(["push", "share"]);
    expect(readFileSync(join(dir, SHARE_URL_FILE), "utf8")).toBe(
      "https://enclave.example/s/tok\n",
    );
    expect(readFileSync(join(dir, SHARE_URL_FILE), "utf8")).not.toContain("OLDTOKEN");
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

  it("refuses an invalid --expires before invoking enclave", async () => {
    const dir = tempDir();
    goodBundle(dir);
    const { log, lines } = collector();

    const code = await pushCommand(
      dir,
      { expires: "forever", dryRun: false, visibility: "private" },
      forbiddenExec.exec,
      log,
    );

    expect(code).toBe(1);
    expect(forbiddenExec.calls).toEqual([]);
    expect(lines.some((l) => l.includes("invalid --expires"))).toBe(true);
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

  it("refuses an impossible date for --expires before publishing", async () => {
    // 2026-13-45 is well-shaped and completely unreal. Before this gate it
    // reached enclave and became an error only AFTER the artifact was live.
    const dir = tempDir();
    goodBundle(dir);
    const { log, lines } = collector();

    const code = await pushCommand(
      dir,
      { expires: "2026-13-45", dryRun: false, visibility: "private" },
      forbiddenExec.exec,
      log,
    );

    expect(code).toBe(1);
    expect(lines.some((l) => l.includes("2026-13-45"))).toBe(true);
    expect(forbiddenExec.calls).toHaveLength(0);
  });

  it("returns 1 for a bundle directory that does not exist, matching scan", async () => {
    // A typo'd path is a usage error, not an unexpected failure. scan already
    // answers 1 for exactly this; push answering 2 made the same mistake read
    // as two different classes of problem depending on which verb you typed.
    const { log, lines } = collector();
    const missing = join(tempDir(), "nope");

    const code = await pushCommand(
      missing,
      { expires: "7d", dryRun: false, visibility: "private" },
      forbiddenExec.exec,
      log,
    );

    expect(code).toBe(1);
    expect(lines.some((l) => l.includes("no such bundle directory"))).toBe(true);
    // Nothing was published: the missing directory is caught before enclave.
    expect(forbiddenExec.calls).toHaveLength(0);
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

  it("returns 1 for a bundle directory that does not exist, not 0", async () => {
    // "scan clean" on a typo'd path is the worst possible answer: the user reads
    // it as "verified safe" when nothing was scanned at all.
    const { log, lines } = collector();
    const missing = join(tempDir(), "nope");
    expect(await scanCommand(missing, log)).toBe(1);
    expect(lines.some((l) => l.includes("no such bundle directory"))).toBe(true);
    expect(lines).not.toContain("scan clean");
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

  it("rewrites the machine hostname out of a packed bundle", async () => {
    // S1 added hostname rewriting to rewritePaths behind an optional parameter, but nothing
    // passed one, so the fix was inert and hostnames still reached a published brief. This
    // pins the wiring, not just the helper.
    const host = hostname();
    const short = host.split(".")[0]!;
    const work = tempDir();
    const sessionFile = join(work, "session.jsonl");
    const turns = [
      { type: "user", message: { role: "user", content: "why does it fail" } },
      {
        type: "assistant",
        message: {
          role: "assistant",
          // Long form, then the bare short form. `${short}-ci` is a DIFFERENT host, so the
          // bounded rewrite must leave it alone - that boundary is the point of the helper.
          content: `fails on ${host} and on ${short} but never on ${short}-ci`,
        },
      },
    ];
    writeFileSync(sessionFile, turns.map((t) => JSON.stringify(t)).join("\n"), "utf8");
    const out = join(work, "bundle");
    const fake = gitExec();
    const { log } = collector();

    expect(await packCommand({ adapter: "claude", cwd: work, sessionFile, out }, fake.exec, log)).toBe(0);

    const md = readFileSync(join(out, "handoff.md"), "utf8");
    // Both the long and the short form are gone, replaced by the placeholder.
    expect(md).toContain("${HOSTNAME}");
    expect(md).not.toContain(`on ${host}`);
    expect(md).not.toContain(`on ${short} `);
    // A longer host that merely starts with the short form is untouched.
    expect(md).toContain(`${short}-ci`);
  });

  it("redacts the --title before it is written into the bundle", async () => {
    // meta was built after redactSession and written straight out, so an author
    // whose --title quoted a home path, the machine hostname or their account
    // name published all three verbatim in meta.json, handoff.md and index.html.
    const work = tempDir();
    const sessionFile = join(work, "session.jsonl");
    writeFileSync(sessionFile, CLAUDE_JSONL, "utf8");
    const out = join(work, "bundle");
    const host = hostname();
    const home = homedir();
    const username = userInfo().username;
    const title = `fix ${home}/notes on ${host} for ${username} today`;
    const fake = gitExec();
    const { log } = collector();

    expect(
      await packCommand({ adapter: "claude", cwd: work, sessionFile, out, title }, fake.exec, log),
    ).toBe(0);

    const meta = JSON.parse(readFileSync(join(out, "meta.json"), "utf8"));
    expect(meta.title).toBe("fix ${HOME}/notes on ${HOSTNAME} for user today");
    for (const f of ["meta.json", "handoff.md", "index.html"]) {
      const text = readFileSync(join(out, f), "utf8");
      expect(text).not.toContain(home);
      expect(text).not.toContain(host);
      expect(text).not.toContain(` ${username} `);
    }
  });

  it("redacts the created-by account name out of meta and the rendered brief", async () => {
    // createdBy is userInfo().username - the exact token replaceUsernameToken
    // scrubs everywhere else in the bundle. Rendering it in plaintext published
    // the account name the rest of the pipeline is careful to remove.
    const work = tempDir();
    const sessionFile = join(work, "session.jsonl");
    writeFileSync(sessionFile, CLAUDE_JSONL, "utf8");
    const out = join(work, "bundle");
    const username = userInfo().username;
    const fake = gitExec();
    const { log } = collector();

    expect(
      await packCommand({ adapter: "claude", cwd: work, sessionFile, out }, fake.exec, log),
    ).toBe(0);

    const meta = JSON.parse(readFileSync(join(out, "meta.json"), "utf8"));
    expect(meta.createdBy).toBe("user");
    expect(readFileSync(join(out, "handoff.md"), "utf8")).toContain("- created by: user");
    for (const f of ["meta.json", "handoff.md", "index.html"]) {
      const text = readFileSync(join(out, f), "utf8");
      expect(new RegExp(`(^|[/\\\\@:\\s"'])${username}([/\\\\@:\\s"']|$)`).test(text)).toBe(
        false,
      );
    }
  });

  it("redacts parser warnings, which quote transcript-derived values", async () => {
    // Warnings are rendered into handoff.md verbatim and several of them quote
    // transcript content (the git branch, unknown record type names), so they
    // were a third path around redactSession.
    const work = tempDir();
    const sessionFile = join(work, "session.jsonl");
    const home = homedir();
    const records = [
      { type: "user", gitBranch: `${home}/wip`, message: { role: "user", content: "go" } },
      { type: "assistant", message: { role: "assistant", content: "done" } },
    ];
    writeFileSync(sessionFile, records.map((r) => JSON.stringify(r)).join("\n"), "utf8");
    const out = join(work, "bundle");
    const fake = gitExec();
    const { log } = collector();

    expect(
      await packCommand({ adapter: "claude", cwd: work, sessionFile, out }, fake.exec, log),
    ).toBe(0);

    const md = readFileSync(join(out, "handoff.md"), "utf8");
    expect(md).toContain('transcript git branch "${HOME}/wip" not carried');
    expect(md).not.toContain(home);
  });

  it("strips credentials out of a remote url before publishing it", async () => {
    // A remote is published verbatim in the brief and never passes through
    // redactSession, so it is the one field that could carry a live token into
    // a shared artifact with nothing else in the pipeline to stop it.
    const work = tempDir();
    const sessionFile = join(work, "session.jsonl");
    writeFileSync(sessionFile, CLAUDE_JSONL, "utf8");
    const out = join(work, "bundle");
    const token = "glpat" + "-FAKEfake0000FAKEfake";
    const fake = fakeExec((call) => {
      if (call.bin !== "git") return { exitCode: 1 };
      if (call.args[1] === "get-url") {
        return { stdout: `https://oauth2:${token}@gitlab.com/acme/demo.git` };
      }
      if (call.args.includes("--abbrev-ref")) return { stdout: "feat/handoff" };
      return { stdout: "a".repeat(40) };
    });
    const { log, lines } = collector();

    const code = await packCommand({ adapter: "claude", cwd: work, sessionFile, out }, fake.exec, log);

    expect(code).toBe(0);
    expect(lines).toContain("warning: credentials stripped out of the git remote url");
    const meta = JSON.parse(readFileSync(join(out, "meta.json"), "utf8"));
    expect(meta.repo.remote).toBe("https://${CREDENTIALS_REMOVED}@gitlab.com/acme/demo.git");
    // The token must not survive anywhere in the bundle.
    for (const f of ["meta.json", "handoff.md", "index.html", "files.txt"]) {
      expect(readFileSync(join(out, f), "utf8")).not.toContain(token);
    }
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

  it("drops a non-repo-relative path from files.txt and says so", async () => {
    // files.txt is a repo-relative manifest. A bare absolute path outside the
    // repo leaks the host filesystem layout, so it must not survive into the
    // bundle - and dropping it silently is just as bad, because the author
    // cannot tell the manifest is incomplete.
    const work = tempDir();
    const sessionFile = join(work, "session.jsonl");
    writeFileSync(
      sessionFile,
      [
        `{"type":"user","sessionId":"sess-9","cwd":"/repo/demo","message":{"role":"user","content":"read /opt/vendor/data/config.json then patch src/app.ts"}}`,
      ].join("\n"),
      "utf8",
    );
    const out = join(work, "bundle");
    const fake = gitExec();
    const { log, lines } = collector();

    const code = await packCommand({ adapter: "claude", cwd: work, sessionFile, out }, fake.exec, log);

    expect(code).toBe(0);
    const filesTxt = readFileSync(join(out, "files.txt"), "utf8");
    expect(filesTxt).not.toContain("/opt/vendor/data/config.json");
    expect(filesTxt).toContain("src/app.ts");
    expect(lines.some((l) => l.includes("/opt/vendor/data/config.json"))).toBe(true);
  });
});
