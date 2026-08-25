// Every credential in this file is fabricated: fixed "FAKE"/"fake" filler in
// the shape of the real thing. Nothing here is or ever was a live secret.
//
// The near-miss cases are the point of this suite. A scanner that fires on the
// word "task-list" or on any base64 blob starting with `eyJ` gets ignored, and
// an ignored scanner is worse than none.

import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SCAN_RULES, UNREADABLE_RULE, rewritePaths, scanBundleDir, scanText, stripUrlCredentials } from "./scan.js";

function rules(text: string): string[] {
  return scanText(text, "f.md").map((f) => f.rule);
}

function fires(text: string, rule: string): boolean {
  return rules(text).includes(rule);
}

/**
 * Secret-shaped fixtures are assembled from split parts at runtime.
 *
 * Every value below is fabricated - the literal word FAKE, repeated. But a
 * provider's secret scanner matches on shape, not validity, so a complete
 * literal in the source trips GitHub secret scanning and files an alert against
 * this repo. It already did once, on the Google key in the gcp-api-key case.
 * Splitting the prefix from the body keeps these regexes honestly exercised
 * without handing a detector anything to match.
 */
const shaped = (prefix: string, body: string): string => prefix + body;

describe("SCAN_RULES", () => {
  it("has a unique name and a description for every rule", () => {
    const names = SCAN_RULES.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
    for (const rule of SCAN_RULES) {
      expect(rule.description.length).toBeGreaterThan(0);
      expect(rule.pattern.flags).not.toContain("g");
    }
  });

  it("covers every rule the bundle scanner promises", () => {
    expect(SCAN_RULES.map((r) => r.name)).toEqual([
      "anthropic-key",
      "generic-sk-key",
      "github-token",
      "slack-token",
      "aws-access-key",
      "gcp-api-key",
      "jwt",
      "private-key",
      "env-assignment",
      "url-credentials",
      "stripe-key",
      "gitlab-token",
      "npm-token",
      "sendgrid-key",
      "huggingface-token",
      "google-oauth-secret",
      "auth-header",
      "abs-home-path",
      "loomgraph-hub-token",
    ]);
  });
});

describe("scanText — hits and near-misses per rule", () => {
  it("anthropic-key", () => {
    expect(fires(`key: ${shaped("sk-ant-", "api03-FAKEfake0000FAKEfake0000")}`, "anthropic-key")).toBe(true);
    // Prefix with no key body.
    expect(fires("keys look like sk-ant- plus a long tail", "anthropic-key")).toBe(false);
  });

  it("generic-sk-key", () => {
    expect(fires("OPENAI: sk-FAKEfake0000FAKEfake", "generic-sk-key")).toBe(true);
    // The near-miss that matters: ordinary hyphenated prose.
    expect(fires("see the task-list and the risk-register", "generic-sk-key")).toBe(false);
    expect(fires("a bare sk- prefix, then sk-short", "generic-sk-key")).toBe(false);
    // An Anthropic key reports once, under its own rule.
    expect(fires(shaped("sk-ant-", "api03-FAKEfake0000FAKEfake0000"), "generic-sk-key")).toBe(false);
  });

  it("github-token", () => {
    expect(fires(shaped("ghp", "_FAKEfake0000FAKEfake0000"), "github-token")).toBe(true);
    expect(fires(shaped("gho", "_FAKEfake0000FAKEfake0000"), "github-token")).toBe(true);
    expect(fires(shaped("ghs", "_FAKEfake0000FAKEfake0000"), "github-token")).toBe(true);
    expect(fires(shaped("github", "_pat_11FAKEfake0000FAKEfake0000"), "github-token")).toBe(true);
    expect(fires("ghp_short and the github_pattern_matcher module", "github-token")).toBe(false);
  });

  it("slack-token", () => {
    expect(fires(shaped("xoxb", "-000000000000-FAKEfake0000"), "slack-token")).toBe(true);
    expect(fires("a bare xoxb- prefix, and xoxo-hugs", "slack-token")).toBe(false);
  });

  it("aws-access-key", () => {
    expect(fires(shaped("AKIA", "FAKEFAKEFAKE0000"), "aws-access-key")).toBe(true);
    expect(fires("AKIAFAKE is too short to be a key id", "aws-access-key")).toBe(false);
  });

  it("gcp-api-key", () => {
    expect(fires(shaped("AIza", "FAKEfake0000FAKEfake0000FAKEfake000"), "gcp-api-key")).toBe(true);
    expect(fires("AIzaFAKEfake is too short", "gcp-api-key")).toBe(false);
  });

  it("jwt", () => {
    expect(
      fires(shaped("eyJ", "hbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.FAKEsignature0000"), "jwt"),
    ).toBe(true);
    // A bare `eyJ` is just base64 for `{"` and appears in harmless blobs.
    expect(fires("the blob starts with eyJ and is not a token", "jwt")).toBe(false);
    expect(fires("eyJhbGciOiJIUzI1NiJ9", "jwt")).toBe(false);
    expect(fires("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0", "jwt")).toBe(false);
  });

  it("url-credentials", () => {
    // The shape that leaks a credential-bearing git remote into a brief.
    expect(
      fires(`- remote: https://oauth2:${shaped("glpat", "-FAKEfake0000FAKEfake")}@gitlab.com/o/r.git`, "url-credentials"),
    ).toBe(true);
    expect(fires("postgres://admin:hunter2@db.internal:5432/app", "url-credentials")).toBe(true);
    // A url with no credentials, and a bare user@host with no password.
    expect(fires("https://github.com/datj9/loomgraph.git", "url-credentials")).toBe(false);
    expect(fires("git@github.com:datj9/loomgraph.git", "url-credentials")).toBe(false);
  });

  it("stripe-key", () => {
    expect(fires(shaped("sk_live", "_FAKEfake0000FAKEfake0000"), "stripe-key")).toBe(true);
    expect(fires(shaped("sk_test", "_FAKEfake0000FAKEfake0000"), "stripe-key")).toBe(true);
    expect(fires(shaped("rk_live", "_FAKEfake0000FAKEfake0000"), "stripe-key")).toBe(true);
    expect(fires(shaped("rk_test", "_FAKEfake0000FAKEfake0000"), "stripe-key")).toBe(true);
    // The hyphen rule must not claim it, and a short tail must not fire.
    expect(fires(shaped("sk_live", "_FAKEfake0000FAKEfake0000"), "generic-sk-key")).toBe(false);
    expect(fires("«redacted:sk_live_…»", "stripe-key")).toBe(false);
    expect(fires("rk_live_x is too short", "stripe-key")).toBe(false);
  });

  it("gitlab-token", () => {
    expect(fires(shaped("glpat", "-FAKEfake0000FAKEfake"), "gitlab-token")).toBe(true);
    expect(fires("glpat-short", "gitlab-token")).toBe(false);
  });

  it("npm-token", () => {
    expect(fires(shaped("npm", "_FAKEfake0000FAKEfake0000FAKEfake0000"), "npm-token")).toBe(true);
    expect(fires("npm_install is not a token", "npm-token")).toBe(false);
  });

  it("sendgrid-key", () => {
    expect(fires(shaped("SG", ".FAKEfake0000FAKE.FAKEfake0000FAKEfake"), "sendgrid-key")).toBe(true);
    expect(fires("SG.short.tail", "sendgrid-key")).toBe(false);
  });

  it("huggingface-token", () => {
    expect(fires(shaped("hf", "_FAKEfake0000FAKEfake"), "huggingface-token")).toBe(true);
    expect(fires("hf_hub is a library name", "huggingface-token")).toBe(false);
  });

  it("google-oauth-secret", () => {
    expect(fires(shaped("GOCSPX", "-FAKEfake0000FAKEfake"), "google-oauth-secret")).toBe(true);
    expect(fires("GOCSPX-short", "google-oauth-secret")).toBe(false);
  });

  it("auth-header", () => {
    const bearer = "Authorization: " + "Bearer " + shaped("n", "ot-a-real-token");
    const basic = "authorization: " + "Basic " + shaped("dXNl", "cjpwYXNz");
    expect(fires(bearer, "auth-header")).toBe(true);
    expect(fires(basic, "auth-header")).toBe(true);
    expect(fires("Authorization: " + "Bearer", "auth-header")).toBe(false);
  });

  it("env-assignment is case-insensitive and covers a json key", () => {
    expect(fires("database_password=hunter2xyz", "env-assignment")).toBe(true);
    expect(fires('"password": "hunter2xyz"', "env-assignment")).toBe(true);
    expect(fires("MY_SERVICE_TOKEN=fake-not-real", "env-assignment")).toBe(true);
    // Placeholders are not secrets.
    expect(fires("MY_SERVICE_TOKEN=", "env-assignment")).toBe(false);
    expect(fires('MY_SERVICE_TOKEN=""', "env-assignment")).toBe(false);
  });

  it("abs-home-path accepts a lower-case windows drive letter", () => {
    expect(fires("c:\\Users\\someone\\notes.md", "abs-home-path")).toBe(true);
    expect(fires("C:\\Users\\someone\\notes.md", "abs-home-path")).toBe(true);
  });

  it("private-key", () => {
    expect(fires("-----BEGIN RSA PRIVATE KEY-----", "private-key")).toBe(true);
    expect(fires("-----BEGIN OPENSSH PRIVATE KEY-----", "private-key")).toBe(true);
    expect(fires("-----BEGIN CERTIFICATE-----", "private-key")).toBe(false);
    expect(fires("the file starts with BEGIN PRIVATE KEY text", "private-key")).toBe(false);
  });

  it("env-assignment", () => {
    expect(fires("MY_SERVICE_TOKEN=fake-value-not-real", "env-assignment")).toBe(true);
    expect(fires('APP_SECRET: "fake-not-real"', "env-assignment")).toBe(true);
    expect(fires("DB_PASSWORD=fake-not-real", "env-assignment")).toBe(true);
    // Placeholders and prose.
    expect(fires("MY_SERVICE_TOKEN=", "env-assignment")).toBe(false);
    expect(fires('MY_SERVICE_TOKEN=""', "env-assignment")).toBe(false);
    expect(fires("rotate the ENCLAVE_TOKEN weekly", "env-assignment")).toBe(false);
  });

  it("abs-home-path", () => {
    expect(fires("/Users/someone/Documents/notes.md", "abs-home-path")).toBe(true);
    expect(fires("/home/someone/src/app.ts", "abs-home-path")).toBe(true);
    expect(fires("C:\\Users\\someone\\src\\app.ts", "abs-home-path")).toBe(true);
    // Already rewritten, or not a home path at all.
    expect(fires("${HOME}/Documents/notes.md", "abs-home-path")).toBe(false);
    expect(fires("${REPO_ROOT}/src/app.ts", "abs-home-path")).toBe(false);
    expect(fires("look under /Users for the account list", "abs-home-path")).toBe(false);
  });

  it("loomgraph-hub-token", () => {
    const token = shaped("lgt_", "1a2b3c4d.FAKEfake0000FAKEfake0000FAKEfake0000");
    expect(fires(`issued ${token} in prod`, "loomgraph-hub-token")).toBe(true);
    // Near-misses: the bare prefix, and a tail too short to be a secret.
    expect(fires("the lgt graph runner", "loomgraph-hub-token")).toBe(false);
    expect(fires("lgt_1a2b3c4d.abcdefghij", "loomgraph-hub-token")).toBe(false);
    // The finding never carries the whole secret.
    const hit = scanText(`token: ${token}`, "f.md").find((f) => f.rule === "loomgraph-hub-token");
    expect(hit).toBeDefined();
    expect(hit?.excerpt).toBe("lgt_...");
    expect(hit?.excerpt).not.toContain(token);
  });
});

describe("scanText — shape of a finding", () => {
  it("masks the excerpt to at most four characters plus an ellipsis", () => {
    const secret = shaped("sk-ant-", "api03-FAKEfake0000FAKEfake0000");
    const findings = scanText(`line one\nkey = ${secret}\n`, "handoff.md");
    const hit = findings.find((f) => f.rule === "anthropic-key");
    expect(hit).toBeDefined();
    expect(hit?.excerpt).toBe("sk-a...");
    for (const finding of findings) {
      expect(finding.excerpt.length).toBeLessThanOrEqual(7);
      expect(secret).not.toBe(finding.excerpt);
      expect(finding.excerpt).not.toContain("FAKEfake");
    }
    expect(JSON.stringify(findings)).not.toContain("FAKEfake");
  });

  it("reports 1-based line numbers and echoes the file back", () => {
    const text = ["clean", "clean", shaped("AKIA", "FAKEFAKEFAKE0000")].join("\n");
    expect(scanText(text, "nested/dirty.md")).toEqual([
      { rule: "aws-access-key", file: "nested/dirty.md", line: 3, excerpt: "AKIA..." },
    ]);
  });

  it("returns nothing for clean text and for empty text", () => {
    expect(scanText("", "f.md")).toEqual([]);
    expect(scanText("A normal handoff brief about the task-list.\n", "f.md")).toEqual([]);
  });

  it("is pure across repeated calls (no leaked regex state)", () => {
    const text = `${shaped("AKIA", "FAKEFAKEFAKE0000")}\n${shaped("ghp", "_FAKEfake0000FAKEfake0000")}`;
    const first = scanText(text, "f.md");
    expect(first).toHaveLength(2);
    expect(scanText(text, "f.md")).toEqual(first);
  });

  it("deduplicates an identical match repeated on one line", () => {
    const key = shaped("AKIA", "FAKEFAKEFAKE0000");
    const line = `${key} ${key}`;
    expect(scanText(line, "f.md")).toHaveLength(1);
  });
});

describe("rewritePaths", () => {
  it("rewrites macOS paths, repoRoot winning inside home", () => {
    const out = rewritePaths(
      "edited /Users/dat/Projects/app/src/x.ts, config at /Users/dat/.zshrc",
      { home: "/Users/dat", username: "dat", repoRoot: "/Users/dat/Projects/app" },
    );
    expect(out).toBe("edited ${REPO_ROOT}/src/x.ts, config at ${HOME}/.zshrc");
    expect(out).not.toContain("/Users/dat");
  });

  it("rewrites Linux paths", () => {
    const out = rewritePaths("cd /home/dat/app && cat /home/dat/.bashrc", {
      home: "/home/dat",
      username: "dat",
      repoRoot: "/home/dat/app",
    });
    expect(out).toBe("cd ${REPO_ROOT} && cat ${HOME}/.bashrc");
  });

  it("rewrites Windows paths", () => {
    const out = rewritePaths(
      "C:\\Users\\dat\\app\\src\\x.ts and C:\\Users\\dat\\AppData",
      {
        home: "C:\\Users\\dat",
        username: "dat",
        repoRoot: "C:\\Users\\dat\\app",
      },
    );
    expect(out).toBe("${REPO_ROOT}\\src\\x.ts and ${HOME}\\AppData");
  });

  it("rewrites the other platforms' home shapes for the same username", () => {
    const out = rewritePaths(
      "/home/dat/notes.md and C:\\Users\\dat\\notes.md",
      { home: "/Users/dat", username: "dat", repoRoot: "/Users/dat/app" },
    );
    expect(out).toBe("${HOME}/notes.md and ${HOME}\\notes.md");
  });

  it("replaces a bare username with 'user'", () => {
    const out = rewritePaths("author dat pushed from dat-laptop", {
      home: "/Users/dat",
      username: "dat",
      repoRoot: "/Users/dat/app",
    });
    expect(out).toBe("author user pushed from dat-laptop");
  });

  it("does not rewrite the username inside ordinary words", () => {
    const input = "the dataset in /srv/data was validated; datadog alerts fired";
    const out = rewritePaths(input, {
      home: "/Users/dat",
      username: "dat",
      repoRoot: "/Users/dat/app",
    });
    expect(out).toBe(input);
    expect(out).toContain("dataset");
    expect(out).toContain("datadog");
    expect(out).not.toContain("useraset");
    expect(out).not.toContain("useradog");
  });

  it("does not rewrite a short username inside identifiers", () => {
    const input = "ec2 instance ready, second attempt";
    const out = rewritePaths(input, {
      home: "/home/ec",
      username: "ec",
      repoRoot: "/opt/app",
    });
    expect(out).toBe(input);
    expect(out).toContain("ec2");
    expect(out).toContain("second");
  });

  it("tolerates trailing separators and empty roots", () => {
    expect(
      rewritePaths("/Users/dat/app/x", {
        home: "/Users/dat/",
        username: "dat",
        repoRoot: "/Users/dat/app/",
      }),
    ).toBe("${REPO_ROOT}/x");
    expect(rewritePaths("nothing to do", { home: "", username: "", repoRoot: "" })).toBe(
      "nothing to do",
    );
  });

  it("leaves rewritten text clean of abs-home-path findings", () => {
    const out = rewritePaths("/Users/dat/Projects/app/src/x.ts", {
      home: "/Users/dat",
      username: "dat",
      repoRoot: "/Users/dat/Projects/app",
    });
    expect(fires(out, "abs-home-path")).toBe(false);
  });
});

describe("scanBundleDir", () => {
  const dirs: string[] = [];

  function makeDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "lg-scan-"));
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    while (dirs.length > 0) {
      const dir = dirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scans text files, skips binaries, dotfiles and node_modules", () => {
    const dir = makeDir();
    writeFileSync(join(dir, "clean.md"), "A clean brief about the task-list.\n", "utf8");
    writeFileSync(join(dir, "dirty.md"), `line one\n${shaped("AKIA", "FAKEFAKEFAKE0000")}\n`, "utf8");
    // svg is text and on the enclave allowlist, so it must be scanned.
    writeFileSync(join(dir, "logo.svg"), shaped("AKIA", "FAKEFAKEFAKE0000"), "utf8");
    // Binary extension: skipped even though the bytes look like a key.
    writeFileSync(join(dir, "logo.png"), shaped("AKIA", "FAKEFAKEFAKE0000"));
    writeFileSync(join(dir, ".env"), "MY_SERVICE_TOKEN=fake-not-real", "utf8");
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "node_modules", "dep.md"), shaped("AKIA", "FAKEFAKEFAKE0000"), "utf8");
    mkdirSync(join(dir, "nested"));
    writeFileSync(join(dir, "nested", "deep.md"), shaped("ghp", "_FAKEfake0000FAKEfake0000"), "utf8");

    const findings = scanBundleDir(dir);
    expect(findings).toEqual([
      { rule: "aws-access-key", file: "dirty.md", line: 2, excerpt: "AKIA..." },
      { rule: "aws-access-key", file: "logo.svg", line: 1, excerpt: "AKIA..." },
      { rule: "github-token", file: "nested/deep.md", line: 1, excerpt: "ghp_..." },
    ]);
  });

  it("fails closed on a missing path or a plain file, never reporting clean", () => {
    // An empty result means "clean, safe to publish" to every caller, so a path
    // the scanner could not read must never produce one.
    const dir = makeDir();
    const file = join(dir, "handoff.md");
    writeFileSync(file, shaped("AKIA", "FAKEFAKEFAKE0000"), "utf8");

    const missing = scanBundleDir(join(dir, "does-not-exist"));
    expect(missing.map((f) => f.rule)).toEqual([UNREADABLE_RULE]);

    const notADir = scanBundleDir(file);
    expect(notADir.map((f) => f.rule)).toEqual([UNREADABLE_RULE]);
  });

  it("reports an unreadable file instead of silently skipping it", () => {
    const dir = makeDir();
    writeFileSync(join(dir, "clean.md"), "nothing to see\n", "utf8");
    const secret = join(dir, "leak.md");
    writeFileSync(secret, shaped("AKIA", "FAKEFAKEFAKE0000"), "utf8");
    chmodSync(secret, 0o000);
    let stillReadable = false;
    try {
      readFileSync(secret, "utf8");
      stillReadable = true;
    } catch {
      // expected: the point of the test
    }
    if (stillReadable) {
      // Running as a user that ignores the mode (e.g. root). The assertion below
      // would be meaningless, so skip rather than pass vacuously.
      chmodSync(secret, 0o644);
      return;
    }

    const findings = scanBundleDir(dir);
    chmodSync(secret, 0o644);
    // The old behaviour was `continue`, which reported this bundle as clean -
    // identical output to a bundle that was read and found innocent.
    expect(findings.map((f) => f.rule)).toContain(UNREADABLE_RULE);
    expect(findings.find((f) => f.rule === UNREADABLE_RULE)?.file).toBe("leak.md");
  });
});

describe("stripUrlCredentials", () => {
  it("removes a user:password pair but keeps the repo identifiable", () => {
    const out = stripUrlCredentials(
      `https://oauth2:${shaped("glpat", "-FAKEfake0000FAKEfake")}@gitlab.com/org/repo.git`,
    );
    expect(out).toBe("https://${CREDENTIALS_REMOVED}@gitlab.com/org/repo.git");
    expect(scanText(out, "meta.json")).toEqual([]);
  });

  it("leaves a credential-free url untouched", () => {
    for (const url of [
      "https://github.com/datj9/loomgraph.git",
      "git@github.com:datj9/loomgraph.git",
      "ssh://git@host:22/org/repo.git",
    ]) {
      expect(stripUrlCredentials(url)).toBe(url);
    }
  });

  it("leaves a bare user@host alone - a username is not a credential", () => {
    // ssh://git@host is the commonest remote there is; mangling it would lose
    // the only fact the reader needs. A token used AS the username is caught by
    // the vendor rules instead.
    expect(stripUrlCredentials("https://alice@host/repo.git")).toBe("https://alice@host/repo.git");
    const tokenAsUser = `https://${shaped("ghp", "_FAKEfake0000FAKEfake0000")}@github.com/o/r.git`;
    expect(stripUrlCredentials(tokenAsUser)).toBe(tokenAsUser);
    expect(scanText(tokenAsUser, "meta.json").map((f) => f.rule)).toContain("github-token");
  });
});
