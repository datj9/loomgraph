import { describe, expect, it } from "vitest";
import {
  buildEnclavePushArgs,
  buildEnclaveShareCreateArgs,
  parseEnclavePushJson,
  parseEnclaveShareCreateJson,
} from "./enclave.js";

describe("buildEnclavePushArgs", () => {
  it("always pins visibility to private and asks for json", () => {
    expect(buildEnclavePushArgs("/tmp/bundle", "handoff")).toEqual([
      "push",
      "/tmp/bundle",
      "--title",
      "handoff",
      "--visibility",
      "private",
      "--json",
    ]);
  });

  it("appends --dry-run last", () => {
    expect(buildEnclavePushArgs("/tmp/bundle", "handoff", { dryRun: true })).toEqual([
      "push",
      "/tmp/bundle",
      "--title",
      "handoff",
      "--visibility",
      "private",
      "--json",
      "--dry-run",
    ]);
  });

  it("keeps a title with spaces and quotes as one argv element", () => {
    const args = buildEnclavePushArgs("/tmp/b", 'a "risky" title; rm -rf /');
    expect(args[3]).toBe('a "risky" title; rm -rf /');
    expect(args).toHaveLength(7);
  });
});

describe("parseEnclavePushJson", () => {
  it("reads artifactId and viewUrl", () => {
    const stdout = JSON.stringify({
      artifactId: "art_123",
      versionId: "ver_1",
      versionNo: 1,
      viewUrl: "https://enclave.example/a/art_123",
      uploaded: ["index.html"],
      skipped: [],
    });
    expect(parseEnclavePushJson(stdout)).toEqual({
      ok: true,
      artifactId: "art_123",
      viewUrl: "https://enclave.example/a/art_123",
    });
  });

  it("fails on malformed json", () => {
    const result = parseEnclavePushJson("not json at all");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("could not parse");
  });

  it("fails on a json array", () => {
    expect(parseEnclavePushJson("[]").ok).toBe(false);
  });

  it("fails when artifactId is absent", () => {
    const result = parseEnclavePushJson(JSON.stringify({ dryRun: true }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("no artifactId");
  });
});

describe("buildEnclaveShareCreateArgs", () => {
  it("builds share create argv", () => {
    expect(buildEnclaveShareCreateArgs("art_123", "7d")).toEqual([
      "share",
      "create",
      "art_123",
      "--expires",
      "7d",
      "--json",
    ]);
  });
});

describe("parseEnclaveShareCreateJson", () => {
  // The real --json shape is not captured yet, so every accepted field name is
  // exercised here. Tighten this to one case once a real fixture exists.
  for (const field of ["url", "shareUrl", "link", "share_url"]) {
    it(`accepts a top-level ${field} field`, () => {
      const stdout = JSON.stringify({ [field]: "https://enclave.example/s/tok" });
      expect(parseEnclaveShareCreateJson(stdout)).toEqual({
        ok: true,
        url: "https://enclave.example/s/tok",
      });
    });
  }

  it("prefers url when several fields are present", () => {
    const stdout = JSON.stringify({ link: "https://b", url: "https://a" });
    expect(parseEnclaveShareCreateJson(stdout)).toEqual({ ok: true, url: "https://a" });
  });

  it("fails on malformed json", () => {
    const result = parseEnclaveShareCreateJson("{oops");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("could not parse");
  });

  it("fails when no known url field is present", () => {
    const result = parseEnclaveShareCreateJson(JSON.stringify({ shareId: "s_1", expiresAt: "x" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("no share url");
  });

  it("rejects a non-string or empty url", () => {
    expect(parseEnclaveShareCreateJson(JSON.stringify({ url: 42 })).ok).toBe(false);
    expect(parseEnclaveShareCreateJson(JSON.stringify({ url: "" })).ok).toBe(false);
  });
});
