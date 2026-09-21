/**
 * Shared types for the handoff subtree.
 *
 * This subtree is deliberately import-clean: nothing under `src/handoff/`
 * imports from `src/core/` or `src/adapters/`, so it can be extracted into a
 * sibling package with a `git mv`; once extracted, the hub depends on that
 * sibling package, not on this repo.
 */

export type HandoffAdapter = "claude" | "codex" | "opencode";

/** A transcript reduced to the only parts that are safe and useful to hand over. */
export interface DistilledSession {
  adapter: HandoffAdapter;
  sessionId: string | null;
  /** Original absolute cwd as recorded by the CLI. Rewritten before rendering. */
  cwd: string | null;
  model: string | null;
  turns: Array<{ role: "user" | "assistant"; text: string }>;
  /** Paths as found in the transcript; rewritten to repo-relative before rendering. */
  filesTouched: string[];
  /** Anything dropped or unparsed, surfaced to the reader rather than hidden. */
  warnings: string[];
}

export interface HandoffMeta {
  v: 1;
  adapter: HandoffAdapter;
  sessionId: string | null;
  title: string;
  createdBy: string;
  /** ISO-8601. */
  createdAt: string;
  repo: { remote: string | null; sha: string | null; branch: string | null };
}

export interface ScanFinding {
  rule: string;
  /** Bundle-relative path. */
  file: string;
  /** 1-based. `0` means the finding is about the file itself, not a line in it. */
  line: number;
  /** Masked. A finding must never reproduce the secret it found. */
  excerpt: string;
}

/**
 * The enclave push contract, enforced locally so a bad bundle fails with a
 * named limit instead of an opaque server refusal. Source: `enclave push --help`.
 */
export const ENCLAVE_ALLOWED_EXTENSIONS: readonly string[] = [
  "html",
  "css",
  "js",
  "mjs",
  "json",
  "svg",
  "png",
  "jpg",
  "jpeg",
  "webp",
  "woff2",
  "txt",
  "md",
];

export const ENCLAVE_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const ENCLAVE_MAX_FILES = 50;
export const ENCLAVE_MAX_TOTAL_BYTES = 10 * 1024 * 1024;
