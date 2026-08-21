import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeBundle, checkEnclaveConstraints, SHARE_URL_FILE, type BundleFiles } from "./bundle.js";
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
