/**
 * Bundle writer and the local half of the enclave push contract.
 *
 * A handoff bundle is a flat directory of four files. Writing it is trivial;
 * the value here is `checkEnclaveConstraints`, which enforces the published
 * `enclave push` limits locally so a bad bundle fails with a named limit
 * instead of an opaque server refusal after an upload attempt.
 *
 * Import-clean: nothing here reaches into src/core/ or src/adapters/.
 */

import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, join, posix } from "node:path";
import {
  ENCLAVE_ALLOWED_EXTENSIONS,
  ENCLAVE_MAX_FILES,
  ENCLAVE_MAX_FILE_BYTES,
  ENCLAVE_MAX_TOTAL_BYTES,
} from "./types.js";

/** The exact file set of a v1 bundle. `index.html` is what enclave serves. */
export interface BundleFiles {
  "index.html": string;
  "handoff.md": string;
  "meta.json": string;
  "files.txt": string;
}

/** Names enclave always skips when walking a push directory. */
const SKIPPED_DIRS = new Set(["node_modules", ".git"]);

/** Where `push` records the print-once share url. Never part of a bundle. */
export const SHARE_URL_FILE = "SHARE-URL.txt";

/** Result of enforcing files.txt's repo-relative contract. */
export interface SanitizedFilesTxt {
  /** Every surviving line normalised to a repo-relative path, forward slashes. */
  content: string;
  /** Entries dropped because they could not be made repo-relative; never silent. */
  excluded: string[];
}

/**
 * Enforce files.txt's repo-relative contract: every line written must be a
 * path relative to the repo root. Absolute in-repo paths (literal or the
 * `rewritePaths` `${REPO_ROOT}` placeholder) are normalised to repo-relative;
 * everything else - bare absolute POSIX paths outside the repo, Windows
 * absolute paths, `${HOME}` escapes and any `..` that climbs above the root -
 * is dropped and returned as `excluded` so the operator is told, exactly the
 * way `checkEnclaveConstraints` surfaces violations.
 */
export function sanitizeFilesTxt(filesTxt: string, repoRoot?: string): SanitizedFilesTxt {
  const kept: string[] = [];
  const excluded: string[] = [];
  for (const raw of filesTxt.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    const rel = toRepoRelative(line, repoRoot);
    if (rel === null) excluded.push(line);
    else kept.push(rel);
  }
  return {
    content: kept.length === 0 ? "" : `${kept.join("\n")}\n`,
    excluded,
  };
}

/**
 * Reduce `line` to a repo-relative path, or `null` when it cannot be made
 * repo-relative. Backslashes are treated as separators everywhere (Windows
 * style), and the emitted path always uses forward slashes.
 */
function toRepoRelative(line: string, repoRoot?: string): string | null {
  // Windows absolute path (`C:\...` or `C:/...`) and UNC shares (`\\...`):
  // a drive letter can never be repo-relative.
  if (/^[A-Za-z]:[\\/]/.test(line) || line.startsWith("\\\\")) return null;
  // Home-directory placeholder from rewritePaths: outside the repo by design.
  if (line === "${HOME}" || line.startsWith("${HOME}/")) return null;

  // The pipeline's own repo-root placeholder: `${REPO_ROOT}/src/app.ts`.
  const marker = "${REPO_ROOT}";
  if (line.startsWith(marker + "/") || line.startsWith(marker + "\\")) {
    return normaliseRepoRelative(line.slice(marker.length).replace(/^[\\/]+/, ""));
  }
  if (line === marker) return null;

  // A literal absolute POSIX path: repo-relative only when under the repo root.
  if (line.startsWith("/")) {
    if (repoRoot !== undefined) {
      const root = repoRoot.replace(/[\\/]+$/, "");
      if (line.startsWith(root + "/")) {
        return normaliseRepoRelative(line.slice(root.length).replace(/^[\\/]+/, ""));
      }
    }
    return null;
  }

  return normaliseRepoRelative(line);
}

/** Strip `./`, collapse `.`/`..` segments, and reject anything above the root. */
function normaliseRepoRelative(rel: string): string | null {
  const withSlashes = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  if (withSlashes === "") return null;
  const normalized = posix.normalize(withSlashes);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) return null;
  return normalized;
}

/**
 * Write every bundle file into `dir`, creating it (and parents) if missing.
 * `files.txt` is passed through `sanitizeFilesTxt` first so the manifest can
 * never leak a host filesystem layout; the excluded entries are returned as
 * the visible flag for the operator, mirroring how `checkEnclaveConstraints`
 * returns violations instead of throwing.
 */
export function writeBundle(dir: string, files: BundleFiles, repoRoot?: string): string[] {
  mkdirSync(dir, { recursive: true });
  // A share url from a previous push must not survive into the next bundle.
  // enclave would upload it as an ordinary .txt file, so the new artifact would
  // serve the old link - widening the exposure of a link the sender believes is
  // separately scoped. Nothing else in the pipeline would catch it: `.txt` is an
  // allowed extension and no scanner rule matches an enclave share url.
  rmSync(join(dir, SHARE_URL_FILE), { force: true });
  let excluded: string[] = [];
  for (const name of Object.keys(files) as Array<keyof BundleFiles>) {
    let body = files[name];
    if (name === "files.txt") {
      const sanitized = sanitizeFilesTxt(body, repoRoot);
      body = sanitized.content;
      excluded = sanitized.excluded;
    }
    writeFileSync(join(dir, name), body, "utf8");
  }
  return excluded;
}


interface WalkedFile {
  /** Bundle-relative path, always with forward slashes. */
  rel: string;
  bytes: number;
}

/**
 * Collect the files enclave would actually upload: recursive, skipping
 * dotfiles/dotdirs, `node_modules` and `.git`, exactly as the CLI does.
 */
function walk(dir: string, prefix: string, out: WalkedFile[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const name = entry.name;
    if (name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(name)) continue;
      walk(join(dir, name), prefix === "" ? name : posix.join(prefix, name), out);
      continue;
    }
    if (!entry.isFile()) continue;
    const rel = prefix === "" ? name : posix.join(prefix, name);
    out.push({ rel, bytes: statSync(join(dir, name)).size });
  }
}

/**
 * Check `dir` against the enclave push contract. Returns one human-readable
 * violation per problem, each naming the limit it broke. An empty array means
 * the directory is publishable.
 */
export function checkEnclaveConstraints(dir: string): string[] {
  const violations: string[] = [];

  let files: WalkedFile[];
  try {
    files = [];
    walk(dir, "", files);
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    return [`cannot read bundle directory ${dir}: ${reason}`];
  }

  if (!files.some((f) => f.rel === "index.html")) {
    violations.push("missing index.html at the bundle root (enclave requires it)");
  }

  for (const f of files) {
    const ext = extname(f.rel).replace(/^\./, "").toLowerCase();
    if (ext === "" || !ENCLAVE_ALLOWED_EXTENSIONS.includes(ext)) {
      violations.push(
        `${f.rel}: extension ${ext === "" ? "(none)" : `.${ext}`} is not in the enclave allowlist ` +
          `(${ENCLAVE_ALLOWED_EXTENSIONS.join(", ")})`,
      );
    }
    if (f.bytes > ENCLAVE_MAX_FILE_BYTES) {
      violations.push(
        `${f.rel}: ${f.bytes} bytes exceeds the per-file limit of ${ENCLAVE_MAX_FILE_BYTES} bytes`,
      );
    }
  }

  if (files.length > ENCLAVE_MAX_FILES) {
    violations.push(`${files.length} files exceeds the file-count limit of ${ENCLAVE_MAX_FILES}`);
  }

  const total = files.reduce((sum, f) => sum + f.bytes, 0);
  if (total > ENCLAVE_MAX_TOTAL_BYTES) {
    violations.push(`${total} bytes total exceeds the bundle limit of ${ENCLAVE_MAX_TOTAL_BYTES} bytes`);
  }

  return violations;
}
