/**
 * Command implementations for the `lg-handoff` bin.
 *
 * Every spawn - `git`, `opencode`, `enclave` - goes through the injected `Exec`
 * seam, so tests inject a fake and no test in this subtree can execute a real
 * binary or touch the network (AGENTS.md hard rule).
 *
 * The ordering in `pushCommand` is the security contract of this feature:
 * scan, then constraints, then spawn. Both gates are fail-closed, and a bundle
 * that trips either one must never reach `enclave`.
 *
 * Secret hygiene: nothing here reads or prints `ENCLAVE_TOKEN`, and no argv is
 * logged. Import-clean: no imports from src/core/ or src/adapters/.
 */

import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { SHARE_URL_FILE, checkEnclaveConstraints, writeBundle } from "./bundle.js";
import {
  buildEnclavePushArgs,
  buildEnclaveShareCreateArgs,
  parseEnclavePushJson,
  parseEnclaveShareCreateJson,
} from "./enclave.js";
import { parseClaudeSessionJsonl, encodeClaudeProjectDir } from "./readers/claude.js";
import { parseCodexSessionJsonl } from "./readers/codex.js";
import { buildOpencodeExportArgs, parseOpencodeExportJson } from "./readers/opencode.js";
import { renderFilesTxt, renderHandoffHtml, renderHandoffMd } from "./render.js";
import { rewritePaths, scanBundleDir, stripUrlCredentials } from "./scan.js";
import type { DistilledSession, HandoffAdapter, HandoffMeta, ScanFinding } from "./types.js";

/** The single spawn seam. Shaped after the subset of execa's result we use. */
export type Exec = (
  bin: string,
  args: string[],
  opts?: { cwd?: string },
) => Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  failed: boolean;
  code?: string;
}>;

export interface PackOptions {
  adapter: HandoffAdapter;
  sessionRef?: string;
  cwd: string;
  sessionFile?: string;
  out: string;
  title?: string;
}

export interface PushOptions {
  title?: string;
  expires: string;
  dryRun: boolean;
  visibility: string;
}

/**
 * Pack a transcript into a publishable bundle.
 *
 * Returns 0 clean, 1 when the transcript could not be found or read, 2 when the
 * bundle was written but the secret scanner found something. A 2 is
 * informational, not a rollback: the bundle stays on disk so the author can
 * inspect what tripped the scanner, it simply is not pushable.
 */
export async function packCommand(
  opts: PackOptions,
  exec: Exec,
  log: (s: string) => void,
): Promise<number> {
  const cwd = resolve(opts.cwd);
  const outDir = resolve(opts.out);

  const source = await resolveTranscript(opts, cwd, exec, log);
  if (source === null) return 1;

  const session = parseTranscript(opts.adapter, source.text);
  for (const warning of session.warnings) log(`warning: ${warning}`);

  const repo = await gatherRepoFacts(cwd, exec, log);

  const meta: HandoffMeta = {
    v: 1,
    adapter: opts.adapter,
    sessionId: session.sessionId,
    title: opts.title ?? defaultTitle(opts.adapter, session.sessionId),
    createdBy: userInfo().username,
    createdAt: new Date().toISOString(),
    repo,
  };

  const redacted = redactSession(session, cwd);
  const handoffMd = renderHandoffMd(redacted, meta);

  writeBundle(outDir, {
    "index.html": renderHandoffHtml(handoffMd, meta),
    "handoff.md": handoffMd,
    "meta.json": `${JSON.stringify(meta, null, 2)}\n`,
    "files.txt": renderFilesTxt(redacted),
  });
  log(`bundle written to ${outDir}`);

  const findings = scanBundleDir(outDir);
  if (findings.length > 0) {
    printFindings(findings, log);
    log(
      `the bundle is on disk at ${outDir} but will not be pushable until these are removed`,
    );
    return 2;
  }

  log("scan clean");
  return 0;
}

/** Scan an existing bundle. 2 if anything was found, else 0. */
export async function scanCommand(dir: string, log: (s: string) => void): Promise<number> {
  const target = resolve(dir);
  // A typo'd path must not read as "scan clean". Reported as a usage error
  // rather than a finding, so "cannot find it" and "found something in it" stay
  // distinguishable at the exit code.
  if (!existsSync(target)) {
    log(`no such bundle directory: ${target}`);
    return 1;
  }
  const findings = scanBundleDir(target);
  if (findings.length > 0) {
    printFindings(findings, log);
    return 2;
  }
  log("scan clean");
  return 0;
}

/**
 * Publish a bundle and mint a time-boxed share link.
 *
 * Order is load-bearing and each step is fail-closed: a refused visibility, a
 * scan finding or a constraint violation all return before `enclave` is spawned
 * even once.
 */
export async function pushCommand(
  dir: string,
  opts: PushOptions,
  exec: Exec,
  log: (s: string) => void,
): Promise<number> {
  const bundleDir = resolve(dir);

  if (opts.visibility !== "private") {
    log(
      `refusing --visibility ${opts.visibility}: a handoff bundle quotes a real ` +
        "session, which is production data. Only private is allowed.",
    );
    return 1;
  }

  // Same reason writeBundle scrubs this file: .txt is allowlisted and no scan
  // rule matches an enclave /s/… URL, so a leftover print-once link would be
  // uploaded as a served page on the next push.
  rmSync(join(bundleDir, SHARE_URL_FILE), { force: true });

  const findings = scanBundleDir(bundleDir);
  if (findings.length > 0) {
    printFindings(findings, log);
    log("refusing to push: fix the findings above, then push again");
    return 2;
  }

  const violations = checkEnclaveConstraints(bundleDir);
  if (violations.length > 0) {
    for (const violation of violations) log(`enclave constraint: ${violation}`);
    log("refusing to push: the bundle does not satisfy the enclave push contract");
    return 2;
  }

  const title = opts.title ?? readBundleTitle(bundleDir);
  const push = await exec("enclave", buildEnclavePushArgs(bundleDir, title, { dryRun: opts.dryRun }));

  if (push.failed && push.code === "ENOENT") {
    log(`enclave not found on PATH - the bundle is still on disk at ${bundleDir}`);
    return 1;
  }
  if (push.exitCode !== 0) {
    const stderr = push.stderr.trim();
    if (stderr !== "") log(stderr);
    log("enclave push failed");
    return 2;
  }

  if (opts.dryRun) {
    log("dry run: enclave accepted the bundle, nothing was published");
    return 0;
  }

  const pushed = parseEnclavePushJson(push.stdout);
  if (!pushed.ok) {
    log(pushed.error);
    return 2;
  }
  log(pushed.viewUrl);

  const share = await exec(
    "enclave",
    buildEnclaveShareCreateArgs(pushed.artifactId, opts.expires),
  );
  if (share.failed && share.code === "ENOENT") {
    log(`enclave not found on PATH - the artifact is published at ${pushed.viewUrl}`);
    return 1;
  }
  if (share.exitCode !== 0) {
    const stderr = share.stderr.trim();
    if (stderr !== "") log(stderr);
    log(`enclave share create failed - the artifact is published at ${pushed.viewUrl}`);
    return 2;
  }

  const parsedShare = parseEnclaveShareCreateJson(share.stdout);
  if (!parsedShare.ok) {
    log(parsedShare.error);
    return 2;
  }

  // The share URL is printed once and never again - the server keeps only its
  // hash. Persist it before anything else can fail or scroll it away.
  const urlPath = join(bundleDir, SHARE_URL_FILE);
  writeFileSync(urlPath, `${parsedShare.url}\n`, "utf8");
  log(parsedShare.url);
  log(`share url saved to ${urlPath} (it cannot be recovered from the server later)`);

  return 0;
}

function defaultTitle(adapter: HandoffAdapter, sessionId: string | null): string {
  return sessionId === null ? `${adapter} handoff` : `${adapter} handoff ${sessionId}`;
}

function printFindings(findings: ScanFinding[], log: (s: string) => void): void {
  log(`${findings.length} scan finding${findings.length === 1 ? "" : "s"}:`);
  for (const f of findings) {
    log(`  ${f.rule} ${f.file}:${f.line} ${f.excerpt}`);
  }
}

/** Read the title back out of a bundle's meta.json, falling back to a constant. */
function readBundleTitle(dir: string): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
    if (parsed !== null && typeof parsed === "object") {
      const title = (parsed as Record<string, unknown>).title;
      if (typeof title === "string" && title !== "") return title;
    }
  } catch {
    // A bundle without a readable meta.json still pushes; it just gets a
    // generic title.
  }
  return "loomgraph handoff";
}

function parseTranscript(adapter: HandoffAdapter, text: string): DistilledSession {
  if (adapter === "claude") return parseClaudeSessionJsonl(text);
  if (adapter === "codex") return parseCodexSessionJsonl(text);
  return parseOpencodeExportJson(text);
}

/**
 * Rewrite every machine-specific path out of the session before it is rendered.
 * Returns a new session; the input is never mutated.
 */
function redactSession(session: DistilledSession, repoRoot: string): DistilledSession {
  const opts = { home: homedir(), username: userInfo().username, repoRoot };
  return {
    ...session,
    cwd: session.cwd === null ? null : rewritePaths(session.cwd, opts),
    turns: session.turns.map((turn) => ({ ...turn, text: rewritePaths(turn.text, opts) })),
    filesTouched: session.filesTouched.map((path) => rewritePaths(path, opts)),
  };
}

interface TranscriptSource {
  text: string;
}

/**
 * Find and read the transcript. `--session-file` always wins; otherwise the
 * adapter's default location is searched. The chosen path is always logged,
 * because the discovery encodings are undocumented and a wrong pick must be
 * visible rather than silent.
 */
async function resolveTranscript(
  opts: PackOptions,
  cwd: string,
  exec: Exec,
  log: (s: string) => void,
): Promise<TranscriptSource | null> {
  if (opts.sessionFile !== undefined) {
    const path = resolve(opts.sessionFile);
    const text = readTextFile(path);
    if (text === null) {
      log(`cannot read session file: ${path}`);
      return null;
    }
    log(`using session file ${path}`);
    return { text };
  }

  if (opts.adapter === "opencode") {
    const args = buildOpencodeExportArgs(opts.sessionRef);
    log(`exporting session with: opencode ${args.join(" ")}`);
    const result = await exec("opencode", args, { cwd });
    if (result.failed && result.code === "ENOENT") {
      log("opencode not found on PATH - pass --session-file with an exported json instead");
      return null;
    }
    if (result.exitCode !== 0) {
      const stderr = result.stderr.trim();
      if (stderr !== "") log(stderr);
      log("opencode export failed");
      return null;
    }
    return { text: result.stdout };
  }

  const found = discoverSessionFile(opts.adapter, cwd);
  if (found === null) {
    log(
      `no ${opts.adapter} session file found for ${cwd} - pass --session-file <path> explicitly`,
    );
    return null;
  }
  const text = readTextFile(found);
  if (text === null) {
    log(`cannot read session file: ${found}`);
    return null;
  }
  log(`using discovered session file ${found} (discovery is best-effort - check this is right)`);
  return { text };
}

function readTextFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Best-effort discovery of the most recently modified transcript.
 *
 * Both layouts are undocumented and version-dependent, which is why the caller
 * logs the result and `--session-file` exists.
 */
function discoverSessionFile(adapter: "claude" | "codex", cwd: string): string | null {
  const root =
    adapter === "claude"
      ? join(homedir(), ".claude", "projects", encodeClaudeProjectDir(cwd))
      : join(homedir(), ".codex", "sessions");
  if (!existsSync(root)) return null;

  const candidates: Array<{ path: string; mtimeMs: number }> = [];
  collectJsonl(root, candidates, adapter === "codex" ? 6 : 1);
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]!.path;
}

/** Collect `*.jsonl` under `dir`, descending at most `depth` levels. */
function collectJsonl(
  dir: string,
  out: Array<{ path: string; mtimeMs: number }>,
  depth: number,
): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth > 1) collectJsonl(path, out, depth - 1);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    try {
      out.push({ path, mtimeMs: statSync(path).mtimeMs });
    } catch {
      // A file that vanished between readdir and stat is simply not a candidate.
    }
  }
}

/**
 * Read remote, sha and branch from git. Never throws: any failing field becomes
 * null with a warning, because a handoff from a directory that is not a repo is
 * still worth producing.
 */
async function gatherRepoFacts(
  cwd: string,
  exec: Exec,
  log: (s: string) => void,
): Promise<HandoffMeta["repo"]> {
  const [remote, sha, branch] = await Promise.all([
    gitField(cwd, ["remote", "get-url", "origin"], exec, log, "remote"),
    gitField(cwd, ["rev-parse", "HEAD"], exec, log, "sha"),
    gitField(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], exec, log, "branch"),
  ]);
  // A remote can carry credentials (https://oauth2:<token>@host/repo.git). It is
  // published verbatim in the brief, and unlike transcript text it never passes
  // through redactSession, so it is stripped here at the source.
  const safeRemote = remote === null ? null : stripUrlCredentials(remote);
  if (safeRemote !== remote) {
    log("warning: credentials stripped out of the git remote url");
  }
  return { remote: safeRemote, sha, branch };
}

async function gitField(
  cwd: string,
  args: string[],
  exec: Exec,
  log: (s: string) => void,
  field: string,
): Promise<string | null> {
  try {
    const result = await exec("git", args, { cwd });
    if (result.exitCode !== 0 || result.stdout.trim() === "") {
      log(`warning: could not read repo ${field} from git`);
      return null;
    }
    return result.stdout.trim();
  } catch {
    log(`warning: could not read repo ${field} from git`);
    return null;
  }
}
