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

/** Write every bundle file into `dir`, creating it (and parents) if missing. */
export function writeBundle(dir: string, files: BundleFiles): void {
  mkdirSync(dir, { recursive: true });
  // A share url from a previous push must not survive into the next bundle.
  // enclave would upload it as an ordinary .txt file, so the new artifact would
  // serve the old link - widening the exposure of a link the sender believes is
  // separately scoped. Nothing else in the pipeline would catch it: `.txt` is an
  // allowed extension and no scanner rule matches an enclave share url.
  rmSync(join(dir, SHARE_URL_FILE), { force: true });
  for (const name of Object.keys(files) as Array<keyof BundleFiles>) {
    writeFileSync(join(dir, name), files[name], "utf8");
  }
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
