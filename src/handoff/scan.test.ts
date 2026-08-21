// Every credential in this file is fabricated: fixed "FAKE"/"fake" filler in
// the shape of the real thing. Nothing here is or ever was a live secret.
//
// The near-miss cases are the point of this suite. A scanner that fires on the
// word "task-list" or on any base64 blob starting with `eyJ` gets ignored, and
// an ignored scanner is worse than none.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SCAN_RULES, rewritePaths, scanBundleDir, scanText } from "./scan.js";

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
      "abs-home-path",
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
    expect(out).toBe("author user pushed from user-laptop");
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
    // Binary-ish extension: skipped even though the bytes look like a key.
    writeFileSync(join(dir, "logo.svg"), shaped("AKIA", "FAKEFAKEFAKE0000"), "utf8");
    writeFileSync(join(dir, ".env"), "MY_SERVICE_TOKEN=fake-not-real", "utf8");
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "node_modules", "dep.md"), shaped("AKIA", "FAKEFAKEFAKE0000"), "utf8");
    mkdirSync(join(dir, "nested"));
    writeFileSync(join(dir, "nested", "deep.md"), shaped("ghp", "_FAKEfake0000FAKEfake0000"), "utf8");

    const findings = scanBundleDir(dir);
    expect(findings).toEqual([
      { rule: "aws-access-key", file: "dirty.md", line: 2, excerpt: "AKIA..." },
      { rule: "github-token", file: "nested/deep.md", line: 1, excerpt: "ghp_..." },
    ]);
  });

  it("returns nothing for a missing path or a file", () => {
    const dir = makeDir();
    const file = join(dir, "handoff.md");
    writeFileSync(file, shaped("AKIA", "FAKEFAKEFAKE0000"), "utf8");
    expect(scanBundleDir(join(dir, "does-not-exist"))).toEqual([]);
    expect(scanBundleDir(file)).toEqual([]);
  });
});
