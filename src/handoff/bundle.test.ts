import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeBundle, sanitizeFilesTxt, checkEnclaveConstraints, SHARE_URL_FILE, type BundleFiles } from "./bundle.js";
import { ENCLAVE_MAX_FILES, ENCLAVE_MAX_FILE_BYTES, ENCLAVE_MAX_TOTAL_BYTES } from "./types.js";

function makeFiles(): BundleFiles {
  return {
    "index.html": "<!doctype html><title>handoff</title>",
    "handoff.md": "# Handoff\n\nGoal: ship it.\n",
    "meta.json": JSON.stringify({ v: 1 }),
    "files.txt": "src/a.ts\nsrc/b.ts\n",
  };
}

describe("writeBundle", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lg-bundle-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("round-trips every bundle file", () => {
    const files = makeFiles();
    const out = join(dir, "bundle");
    writeBundle(out, files);
    for (const [name, body] of Object.entries(files)) {
      expect(readFileSync(join(out, name), "utf8")).toBe(body);
    }
  });

  it("creates missing parent directories", () => {
    const out = join(dir, "nested", "deeper", "bundle");
    writeBundle(out, makeFiles());
    expect(readFileSync(join(out, "index.html"), "utf8")).toContain("handoff");
  });

  it("overwrites an existing bundle in place", () => {
    const out = join(dir, "bundle");
    writeBundle(out, makeFiles());
    writeBundle(out, { ...makeFiles(), "handoff.md": "# Second\n" });
    expect(readFileSync(join(out, "handoff.md"), "utf8")).toBe("# Second\n");
  });
});

describe("checkEnclaveConstraints", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lg-enclave-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("accepts a valid bundle", () => {
    writeBundle(dir, makeFiles());
    expect(checkEnclaveConstraints(dir)).toEqual([]);
  });

  it("ignores dotfiles, node_modules and .git the way enclave does", () => {
    writeBundle(dir, makeFiles());
    writeFileSync(join(dir, ".enclave.json"), "{}");
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "junk.jsonl"), "{}");
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main");
    expect(checkEnclaveConstraints(dir)).toEqual([]);
  });

  it("flags a missing index.html", () => {
    writeFileSync(join(dir, "handoff.md"), "# nope\n");
    const v = checkEnclaveConstraints(dir);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("index.html");
  });

  it("flags a disallowed extension", () => {
    writeBundle(dir, makeFiles());
    writeFileSync(join(dir, "session.jsonl"), "{}\n");
    const v = checkEnclaveConstraints(dir);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("session.jsonl");
    expect(v[0]).toContain("allowlist");
  });

  it("flags a file with no extension", () => {
    writeBundle(dir, makeFiles());
    writeFileSync(join(dir, "LICENSE"), "MIT\n");
    expect(checkEnclaveConstraints(dir).join("\n")).toContain("LICENSE");
  });

  it("flags a file over the per-file byte limit", () => {
    writeBundle(dir, makeFiles());
    writeFileSync(join(dir, "big.txt"), Buffer.alloc(ENCLAVE_MAX_FILE_BYTES + 1, 0x61));
    const v = checkEnclaveConstraints(dir);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("big.txt");
    expect(v[0]).toContain(String(ENCLAVE_MAX_FILE_BYTES));
  });

  it("flags more than the allowed file count", () => {
    writeBundle(dir, makeFiles());
    for (let i = 0; i < ENCLAVE_MAX_FILES; i++) {
      writeFileSync(join(dir, `pad-${i}.txt`), "x");
    }
    const v = checkEnclaveConstraints(dir);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain(`limit of ${ENCLAVE_MAX_FILES}`);
  });

  it("flags a bundle over the total byte limit", () => {
    writeBundle(dir, makeFiles());
    // Six 2 MB files: each is within the per-file limit, the sum is not.
    for (let i = 0; i < 6; i++) {
      writeFileSync(join(dir, `chunk-${i}.txt`), Buffer.alloc(ENCLAVE_MAX_FILE_BYTES, 0x61));
    }
    const v = checkEnclaveConstraints(dir);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain(`limit of ${ENCLAVE_MAX_TOTAL_BYTES}`);
  });

  it("walks subdirectories and reports nested paths with forward slashes", () => {
    writeBundle(dir, makeFiles());
    mkdirSync(join(dir, "assets"), { recursive: true });
    writeFileSync(join(dir, "assets", "notes.jsonl"), "{}\n");
    expect(checkEnclaveConstraints(dir).join("\n")).toContain("assets/notes.jsonl");
  });

  it("reports several violations at once", () => {
    writeFileSync(join(dir, "session.jsonl"), "{}\n");
    const v = checkEnclaveConstraints(dir);
    expect(v).toHaveLength(2);
    expect(v.join("\n")).toContain("index.html");
    expect(v.join("\n")).toContain("session.jsonl");
  });

  it("reports an unreadable directory instead of throwing", () => {
    const v = checkEnclaveConstraints(join(dir, "does-not-exist"));
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("cannot read bundle directory");
  });
});

describe("writeBundle purges a stale share url", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lg-share-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("removes SHARE-URL.txt so a re-pack cannot republish the old link", () => {
    writeBundle(dir, makeFiles());
    writeFileSync(join(dir, SHARE_URL_FILE), "https://host/s/OLDTOKEN\n", "utf8");
    // A second pack into the same --out directory.
    writeBundle(dir, makeFiles());
    expect(existsSync(join(dir, SHARE_URL_FILE))).toBe(false);
    // Nothing else would have caught it: .txt is an allowed extension, so the
    // stale link would have been uploaded alongside the new artifact.
    expect(checkEnclaveConstraints(dir)).toEqual([]);
  });
});

describe("files.txt repo-relative enforcement", () => {
  let dir: string;
  let repoRoot: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lg-files-"));
    repoRoot = mkdtempSync(join(tmpdir(), "lg-files-root-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const bundleWith = (filesTxt: string): BundleFiles => ({
    ...makeFiles(),
    "files.txt": filesTxt,
  });
  const written = (): string => readFileSync(join(dir, "files.txt"), "utf8");

  it("emits an absolute in-repo path as a repo-relative path", () => {
    writeBundle(dir, bundleWith(`${join(repoRoot, "src/app.ts")}\n`), repoRoot);
    expect(written()).toBe("src/app.ts\n");
  });

  it("emits a ./ -prefixed relative path without the ./", () => {
    writeBundle(dir, bundleWith("./rel/thing.ts\n"), repoRoot);
    expect(written()).toBe("rel/thing.ts\n");
  });

  it("drops and flags a bare absolute out-of-repo POSIX path", () => {
    const excluded = writeBundle(dir, bundleWith("/opt/vendor/data/config.json\n"), repoRoot);
    expect(written()).not.toContain("/opt/vendor/data/config.json");
    expect(excluded).toContain("/opt/vendor/data/config.json");
  });

  it("drops and flags a Windows absolute path", () => {
    const excluded = writeBundle(
      dir,
      bundleWith("C:\\Users\\alice\\AppData\\secrets.txt\n"),
      repoRoot,
    );
    expect(written()).not.toContain("secrets.txt");
    expect(excluded).toContain("C:\\Users\\alice\\AppData\\secrets.txt");
  });

  it("drops a ../ escape so it never reaches files.txt", () => {
    const excluded = writeBundle(dir, bundleWith("../outside/x.ts\n"), repoRoot);
    expect(written()).not.toContain("x.ts");
    expect(excluded).toContain("../outside/x.ts");
  });

  it("drops a ../ escape nested after a valid prefix", () => {
    const excluded = writeBundle(dir, bundleWith("src/../../../etc/passwd\n"), repoRoot);
    expect(written()).not.toContain("etc/passwd");
    expect(excluded).toContain("src/../../../etc/passwd");
  });

  it("matches the worked example", () => {
    const excluded = writeBundle(
      dir,
      bundleWith(
        [
          join(repoRoot, "src/app.ts"),
          "./rel/thing.ts",
          "/opt/vendor/data/config.json",
          "C:\\Users\\alice\\AppData\\secrets.txt",
          "../outside/x.ts",
        ].join("\n") + "\n",
      ),
      repoRoot,
    );
    expect(written()).toBe("src/app.ts\nrel/thing.ts\n");
    expect(excluded.sort()).toEqual(
      [
        "/opt/vendor/data/config.json",
        "C:\\Users\\alice\\AppData\\secrets.txt",
        "../outside/x.ts",
      ].sort(),
    );
  });

  it("normalises the pipeline's ${REPO_ROOT} placeholder for in-repo paths", () => {
    const excluded = writeBundle(dir, bundleWith("${REPO_ROOT}/src/app.ts\n"), repoRoot);
    expect(written()).toBe("src/app.ts\n");
    expect(excluded).toEqual([]);
  });

  it("sanitizeFilesTxt flags what it drops instead of swallowing it", () => {
    const out = sanitizeFilesTxt(
      [
        join(repoRoot, "src/app.ts"),
        "./rel/thing.ts",
        "/opt/vendor/data/config.json",
        "C:\\Users\\alice\\AppData\\secrets.txt",
        "../outside/x.ts",
      ].join("\n") + "\n",
      repoRoot,
    );
    expect(out.content).toBe("src/app.ts\nrel/thing.ts\n");
    expect(out.excluded).toHaveLength(3);
    expect(out.excluded).toContain("/opt/vendor/data/config.json");
  });
});
