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
    pattern: /\b(?:gh[posur]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})/,
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
    // Case-insensitive: a .env line is upper-case by convention but a JSON key
    // or a lower-case shell export is the same secret. The name may also BE the
    // word (`password: x`), not just end in it. A bare `key` name counts too,
    // because an opencode / .netrc style config writes the credential under
    // exactly that name. The lookbehind anchors the name to a real word start,
    // so `monkey=x` is not a `key=x` assignment and the prefix never gets to
    // rescan to end-of-line at every offset - that was a quadratic blow-up: a
    // 64k line took 9 seconds. The value must be non-empty, and an unquoted
    // value must be at least 8 characters: `FOO_TOKEN=` and `FOO_TOKEN=""` are
    // placeholders, a quoted value is a config value, but a short bare word is
    // prose - `Standalone token: user` used to block a bundle.
    pattern:
      /(?<![A-Za-z0-9_-])(?:[A-Za-z0-9]+[_-])*(?:TOKEN|SECRET|PASSWD|PASSWORD|API[_-]?KEY|KEY)"?\s*[:=]\s*(?:"[^"\s]+"|'[^'\s]+'|[^\s"';,]{8,})/i,
    description: "Assignment to a token / secret / password / api-key name",
  },
  {
    name: "url-credentials",
    // scheme://user:password@host - the shape a git remote, a database URI and
    // a curl command all use. This is the rule that catches a credential-
    // bearing `git remote get-url` value, which no vendor-prefix rule can.
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i,
    description: "Credentials embedded in a URL (scheme://user:pass@host)",
  },
  {
    name: "stripe-key",
    // Underscore, not hyphen - so `generic-sk-key` cannot catch these.
    // Restricted keys (rk_) are the same family; sk_live_ is already covered.
    pattern: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/,
    description: "Stripe secret or restricted key",
  },
  {
    name: "gitlab-token",
    pattern: /\bglpat-[A-Za-z0-9_-]{16,}/,
    description: "GitLab personal access token",
  },
  {
    name: "npm-token",
    pattern: /\bnpm_[A-Za-z0-9]{30,}/,
    description: "npm access token",
  },
  {
    name: "sendgrid-key",
    pattern: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/,
    description: "SendGrid API key",
  },
  {
    name: "huggingface-token",
    pattern: /\bhf_[A-Za-z0-9]{16,}/,
    description: "HuggingFace access token",
  },
  {
    name: "google-oauth-secret",
    pattern: /\bGOCSPX-[A-Za-z0-9_-]{16,}/,
    description: "Google OAuth client secret",
  },
  {
    name: "auth-header",
    // Optional quotes around the name and the scheme cover the JSON-encoded
    // form of the same header, e.g. `{"Authorization":"Bearer ..."}`. The
    // scheme is not limited to Bearer/Basic - `token`, `ApiKey`, `Digest` and
    // `AWS4-HMAC-SHA256` are all real schemes seen in the wild - so the scheme
    // itself is any word-shaped token. Deliberately NOT case-insensitive
    // overall (only the `[Aa]uthorization` header name is): an `i` flag would
    // make the "must not be a plain lowercase word" check below meaningless,
    // since it would treat every letter as interchangeable and defeat the one
    // signal that tells a credential apart from prose ("Authorization: see
    // the docs" must not fire). The value lookahead requires the token to
    // contain something other than a lowercase letter or whitespace - a
    // digit, an underscore, a dash, an `=`, a quote, or an upper-case letter -
    // which every real credential shape here has (even the base64 Basic value
    // is mixed-case) but ordinary English continuation words do not.
    pattern:
      /\b[Aa]uthorization"?\s*:\s*"?[A-Za-z][A-Za-z0-9._-]{1,40}\s+(?=\S{6,})(?=\S*[^a-z\s])\S+/,
    description: "Authorization header carrying a credential, for any auth scheme",
  },
  {
    name: "netrc-credentials",
    // A .netrc row is space-separated with no `=` or `:`, so no assignment rule
    // can see it. Requiring all three keywords in order keeps prose out - this
    // covers the one-line form some tools emit. The real netrc(5) format is
    // one field per line, which `scanText`'s per-line matching can never see
    // as a single multi-line match, so the second alternative catches a bare
    // `login <value>` or `password <value>` line on its own. Anchoring to the
    // WHOLE line (leading/trailing `\s*`, exactly one token after the
    // keyword) is what keeps prose like "login to the dashboard first" or
    // "password reset instructions" out - those have more than one word after
    // the keyword, so the `$` anchor never lines up.
    pattern:
      /(?:\bmachine\s+\S+\s+login\s+\S+\s+password\s+\S+)|(?:^\s*(?:login|password)\s+\S+\s*$)/i,
    description: ".netrc machine/login/password row, one-line or netrc(5) multi-line form",
  },
  {
    name: "auth-json-credential",
    // The shapes an opencode auth.json uses for stored OAuth material. The key
    // must be JSON-quoted and the value non-empty, so prose cannot fire.
    pattern: /"(?:refresh|access|credential)"\s*:\s*"[^"\s]+"/i,
    description: "OAuth refresh/access/credential value in a JSON auth file",
  },
  {
    name: "abs-home-path",
    // Residual absolute home directory left after rewritePaths ran.
    pattern: /(?:\/Users\/[^/\s:"'\\]+\/|\/home\/[^/\s:"'\\]+\/|[a-zA-Z]:\\Users\\[^\\\s:"']+\\)/,
    description: "Absolute home path that path rewriting did not remove",
  },
  {
    name: "residual-local-hostname",
    // Backstop for a leftover machine hostname, the same role `abs-home-path`
    // plays for a leftover home directory. Unlike a home path, an arbitrary
    // hostname has no generic shape to anchor on - but the mDNS `.local`
    // suffix macOS/Bonjour hostnames use (`Dat-Laptop.local`) is specific
    // enough to flag without false-firing on ordinary prose. This exists
    // because `replaceHostnameToken` only removes the hostname it was told
    // about; a case-mismatched or unsupplied hostname would otherwise publish
    // with the CLI still reporting "scan clean".
    pattern: /\b[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.local\b/,
    description: "Residual mDNS-style (.local) machine hostname that rewriting did not remove",
  },
];

/** Extensions never read as text by `scanBundleDir`. */
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".woff2",
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
 * Anything this function cannot read becomes a finding rather than a skip. That
 * matters: every caller treats an empty result as "clean, safe to publish", so a
 * file skipped because it was unreadable would report exactly the same as a file
 * that was read and found innocent. A gate that cannot look must not answer
 * "clean" - it fails closed instead.
 */
export function scanBundleDir(dir: string): ScanFinding[] {
  let stats;
  try {
    stats = statSync(dir);
  } catch (err: unknown) {
    return [unreadable(".", `bundle directory cannot be read: ${reason(err)}`)];
  }
  if (!stats.isDirectory()) return [unreadable(".", "bundle path is not a directory")];

  const rels: string[] = [];
  try {
    walk(dir, "", rels);
  } catch (err: unknown) {
    return [unreadable(".", `bundle directory cannot be listed: ${reason(err)}`)];
  }
  rels.sort();

  const findings: ScanFinding[] = [];
  for (const rel of rels) {
    let text: string;
    try {
      text = readFileSync(join(dir, ...rel.split("/")), "utf8");
    } catch (err: unknown) {
      findings.push(unreadable(rel, `file cannot be read, so it was never scanned: ${reason(err)}`));
      continue;
    }
    findings.push(...scanText(text, rel));
  }
  return findings;
}

/** Rule name reported when the scanner could not read what it was asked to scan. */
export const UNREADABLE_RULE = "unreadable-file";

function unreadable(file: string, detail: string): ScanFinding {
  return { rule: UNREADABLE_RULE, file, line: 0, excerpt: detail };
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Literal (non-regex) replacement of every occurrence of `needle`. */
function replaceLiteral(text: string, needle: string, replacement: string): string {
  if (needle.length === 0) return text;
  return text.split(needle).join(replacement);
}

/**
 * Replace `username` only when it sits on a path or word boundary.
 * An unanchored replace("dat","user") turns "dataset" into "useraset".
 */
function replaceUsernameToken(text: string, username: string): string {
  if (username.length === 0) return text;
  const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Case-insensitive: a transcript can quote the username exactly as the OS
  // capitalized it (`DAT`, `Dat`), not only in the case the caller supplied.
  const re = new RegExp(`(^|[/\\\\@:\\s"'])${escaped}(?=[/\\\\@:\\s"']|$)`, "gi");
  return text.replace(re, "$1user");
}

/**
 * Replace `host` only when it stands alone as a host token.
 *
 * Bounded the same way `replaceUsernameToken` is bounded, but with a host-shaped
 * character class: a hostname may legitimately contain `.` and `-`, so `web1`
 * must not be pulled out of `web10`, `web1a` or `xweb1`.
 */
function replaceHostnameToken(text: string, host: string): string {
  if (host.length === 0) return text;
  const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Case-insensitive: `hostname()` reports whatever case the OS stored, but a
  // transcript can quote the same machine in a different case (a log line, a
  // pasted prompt), and a case-mismatched leftover is a silent scan bypass.
  const re = new RegExp(`(^|[^A-Za-z0-9.-])${escaped}(?![A-Za-z0-9.-])`, "gi");
  return text.replace(re, (_match, prefix: string) => `${prefix}${HOSTNAME_PLACEHOLDER}`);
}

/**
 * Rewrite machine-specific absolute paths into placeholders.
 *
 * `repoRoot` is applied before `home` when it is the longer string, so a repo
 * inside the home directory becomes `${REPO_ROOT}/...` rather than
 * `${HOME}/projects/...`. The Linux and Windows home shapes for the same
 * username are rewritten too, because a transcript can quote a path from
 * another machine. A standalone username token becomes `user`, but only at
 * path / whitespace / quote / `@` / `:` boundaries so `dataset` and
 * `dat-laptop` stay intact. The machine hostname is rewritten to `${HOSTNAME}`
 * in both its long and short forms, bounded so it cannot be pulled out of a
 * longer token. Residual `/Users/<name>/` paths are still caught by the
 * `abs-home-path` scan rule.
 */
export function rewritePaths(
  text: string,
  opts: { home: string; username: string; repoRoot: string; hostname?: string },
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

  // The full form first: rewriting the short form first would leave a dangling
  // `.local` behind. `hostname` prints the long form, `hostname -s` the short one,
  // and a transcript can quote either.
  const host = opts.hostname ?? "";
  if (host.length > 0) {
    out = replaceHostnameToken(out, host);
    const short = host.split(".")[0] ?? "";
    if (short.length > 0 && short !== host) {
      out = replaceHostnameToken(out, short);
    }
  }

  if (opts.username.length > 0) {
    for (const shape of [
      `/home/${opts.username}`,
      `/Users/${opts.username}`,
      `C:\\Users\\${opts.username}`,
    ]) {
      out = replaceLiteral(out, shape, "${HOME}");
    }
    out = replaceUsernameToken(out, opts.username);
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

/**
 * Strip a `user:password@` block out of every URL in `text`, keeping the rest of
 * the URL readable. Used on values that are published but are not transcript
 * text - a git remote, most importantly - where dropping the whole string would
 * lose the one fact the reader needs (which repo this was).
 */
export function stripUrlCredentials(text: string): string {
  // Requires an actual `:password` part. A bare `user@host` is a username, not
  // a credential - `ssh://git@github.com/org/repo.git` is the single most common
  // remote there is, and rewriting it would destroy the one fact the reader
  // needs. A username that IS a token (`https://ghp_.../@github.com`) is caught
  // by the vendor-prefix rules instead, which fire wherever the token appears.
  return text.replace(
    /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]*@/gi,
    (_match, scheme: string) => `${scheme}${CREDENTIAL_PLACEHOLDER}@`,
  );
}

/** What replaces a stripped `user:pass` pair, so the removal is visible. */
const CREDENTIAL_PLACEHOLDER = "${CREDENTIALS_REMOVED}";

/** What replaces the machine hostname, so the removal is visible in a published bundle. */
const HOSTNAME_PLACEHOLDER = "${HOSTNAME}";
