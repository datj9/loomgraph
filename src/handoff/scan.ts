/**
 * Secret scanner and path rewriter for handoff bundles.
 *
 * Two independent jobs, deliberately in one module because they are the same
 * safety gate seen from both ends: `rewritePaths` removes what we know how to
 * remove, `scanText` reports what survived.
 *
 * The scanner only REPORTS. It never throws, never exits and never mutates a
 * file. Fail-closed policy (refusing to push a dirty bundle) belongs to the
 * CLI. Findings carry a masked excerpt: at most the first four characters of
 * the match, so a report can be pasted anywhere without leaking the secret it
 * is warning about.
 *
 * Import-clean: nothing here reaches into src/core/ or src/adapters/.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import type { ScanFinding } from "./types.js";

/**
 * One rule per credential shape. Every pattern carries a length tail or an
 * anchored prefix so it cannot fire on prose: a scanner that cries wolf on
 * the word "task-list" gets switched off, which is worse than no scanner.
 *
 * Patterns are stored without the `g` flag; `scanText` clones them per line so
 * no `lastIndex` state leaks between calls and the module stays pure.
 */
export const SCAN_RULES: ReadonlyArray<{
  name: string;
  pattern: RegExp;
  description: string;
}> = [
  {
    name: "anthropic-key",
    pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/,
    description: "Anthropic API key (sk-ant- prefix)",
  },
  {
    name: "generic-sk-key",
    // Excludes sk-ant- so an Anthropic key reports once, under its own rule.
    pattern: /\bsk-(?!ant-)[A-Za-z0-9_-]{16,}/,
    description: "OpenAI-style secret key (sk- prefix, long tail)",
  },
  {
    name: "github-token",
    pattern: /\b(?:gh[pos]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})/,
    description: "GitHub personal access / OAuth / server token",
  },
  {
    name: "slack-token",
    pattern: /\bxox[bpar]-[A-Za-z0-9-]{10,}/,
    description: "Slack bot/user/app/refresh token",
  },
  {
    name: "aws-access-key",
    pattern: /\bAKIA[0-9A-Z]{16}\b/,
    description: "AWS access key id",
  },
  {
    name: "gcp-api-key",
    pattern: /\bAIza[0-9A-Za-z_-]{35}/,
    description: "Google/GCP API key",
  },
  {
    name: "jwt",
    // Three dot-separated base64url segments. A bare `eyJ` is just base64 for
    // `{"` and shows up in harmless config blobs, so it must not fire.
    pattern: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/,
    description: "JWT (three base64url segments)",
  },
  {
    name: "private-key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    description: "PEM private key block",
  },
  {
    name: "env-assignment",
    // Uppercase env-var convention only, and the value must be non-empty:
    // `FOO_TOKEN=` and `FOO_TOKEN=""` are placeholders, not secrets.
    pattern: /\b[A-Z][A-Z0-9_]*_(?:TOKEN|SECRET|KEY|PASSWORD)\s*[:=]\s*(?:"[^"\s]+"|'[^'\s]+'|[^\s"';,]+)/,
    description: "Assignment to a *_TOKEN / *_SECRET / *_KEY / *_PASSWORD name",
  },
  {
    name: "abs-home-path",
    // Residual absolute home directory left after rewritePaths ran.
    pattern: /(?:\/Users\/[^/\s:"'\\]+\/|\/home\/[^/\s:"'\\]+\/|C:\\Users\\[^\\\s:"']+\\)/,
    description: "Absolute home path that path rewriting did not remove",
  },
];

/** Extensions never read as text by `scanBundleDir`. */
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".woff2",
  ".svg",
]);

/** Directory names never walked by `scanBundleDir`. */
const SKIPPED_DIRS = new Set(["node_modules", ".git"]);

/** Longest excerpt a finding may carry: 4 characters of match plus an ellipsis. */
const MASK_PREFIX_LENGTH = 4;

/** Reduce a match to a shape a human can locate without reproducing it. */
function mask(match: string): string {
  if (match.length <= MASK_PREFIX_LENGTH) return match;
  return `${match.slice(0, MASK_PREFIX_LENGTH)}...`;
}

/**
 * Scan `text` for every rule and return findings with 1-based line numbers.
 *
 * Pure: no filesystem, no throwing, no shared regex state. `file` is echoed
 * into each finding untouched, so the caller decides what path shape to report.
 */
export function scanText(text: string, file: string): ScanFinding[] {
  const findings: ScanFinding[] = [];
  const seen = new Set<string>();
  const lines = text.split(/\r?\n/);

  for (const rule of SCAN_RULES) {
    const global = new RegExp(rule.pattern.source, `${rule.pattern.flags}g`);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      global.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = global.exec(line)) !== null) {
        // Zero-length matches cannot happen with these patterns, but a guard
        // here is cheaper than an infinite loop if a rule is edited later.
        if (m[0].length === 0) break;
        const excerpt = mask(m[0]);
        const key = `${rule.name}\u0000${i}\u0000${excerpt}`;
        if (!seen.has(key)) {
          seen.add(key);
          findings.push({ rule: rule.name, file, line: i + 1, excerpt });
        }
      }
    }
  }

  return findings;
}

function walk(dir: string, prefix: string, out: string[]): void {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name), rel, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (BINARY_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
    out.push(rel);
  }
}

/**
 * Walk `dir` recursively and scan every text file, reporting bundle-relative
 * paths with forward slashes. The only filesystem toucher in this module.
 *
 * Unreadable files are skipped rather than thrown on: a scan that dies halfway
 * reports fewer secrets than a scan that finishes.
 */
export function scanBundleDir(dir: string): ScanFinding[] {
  let stats;
  try {
    stats = statSync(dir);
  } catch {
    return [];
  }
  if (!stats.isDirectory()) return [];

  const rels: string[] = [];
  walk(dir, "", rels);
  rels.sort();

  const findings: ScanFinding[] = [];
  for (const rel of rels) {
    let text: string;
    try {
      text = readFileSync(join(dir, ...rel.split("/")), "utf8");
    } catch {
      continue;
    }
    findings.push(...scanText(text, rel));
  }
  return findings;
}

/** Literal (non-regex) replacement of every occurrence of `needle`. */
function replaceLiteral(text: string, needle: string, replacement: string): string {
  if (needle.length === 0) return text;
  return text.split(needle).join(replacement);
}

/**
 * Rewrite machine-specific absolute paths into placeholders.
 *
 * `repoRoot` is applied before `home` when it is the longer string, so a repo
 * inside the home directory becomes `${REPO_ROOT}/...` rather than
 * `${HOME}/projects/...`. The Linux and Windows home shapes for the same
 * username are rewritten too, because a transcript can quote a path from
 * another machine. Finally the bare username becomes `user`; that replacement
 * is intentionally unbounded (it also catches `dat-laptop`) since
 * over-redaction is the safe direction here.
 */
export function rewritePaths(
  text: string,
  opts: { home: string; username: string; repoRoot: string },
): string {
  const roots: Array<{ from: string; to: string }> = [
    { from: normalizeRoot(opts.repoRoot), to: "${REPO_ROOT}" },
    { from: normalizeRoot(opts.home), to: "${HOME}" },
  ]
    .filter((r) => r.from.length > 1)
    // Longer/more specific root first: a repoRoot inside home must win.
    .sort((a, b) => b.from.length - a.from.length);

  let out = text;
  for (const root of roots) {
    out = replaceLiteral(out, root.from, root.to);
  }

  if (opts.username.length > 0) {
    for (const shape of [
      `/home/${opts.username}`,
      `/Users/${opts.username}`,
      `C:\\Users\\${opts.username}`,
    ]) {
      out = replaceLiteral(out, shape, "${HOME}");
    }
    out = replaceLiteral(out, opts.username, "user");
  }

  return out;
}

/** Drop a trailing separator so `/repo` and `/repo/` behave identically. */
function normalizeRoot(root: string): string {
  if (root.length > 1 && (root.endsWith("/") || root.endsWith("\\"))) {
    return root.slice(0, -1);
  }
  return root;
}
