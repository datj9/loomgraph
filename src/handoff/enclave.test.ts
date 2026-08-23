import { describe, expect, it } from "vitest";
import {
  buildEnclavePushArgs,
  buildEnclaveShareCreateArgs,
  isValidExpires,
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

describe("isValidExpires", () => {
  it("accepts the shapes enclave documents", () => {
    for (const value of [
      "7d",
      "12h",
      "2w",
      "30d",
      "2026-08-10",
      "2026-08-10T14:30",
      "2026-08-10T23:59:00Z",
      "2026-08-10T23:59:00+07:00",
    ]) {
      expect(isValidExpires(value)).toBe(true);
    }
  });

  it("rejects shapes enclave would refuse after publish", () => {
    for (const value of ["forever", "", "tomorrow", "7", "7days", "abc"]) {
      expect(isValidExpires(value)).toBe(false);
    }
  });

  it("rejects a well-shaped value that is not a real date", () => {
    // Shape validation alone let 2026-13-45 through the local gate and turned
    // it into an enclave error AFTER the artifact was already published - the
    // one moment the check exists to prevent.
    for (const value of [
      "2026-13-45",
      "2026-02-30",
      "2026-02-29", // 2026 is not a leap year
      "2026-00-10",
      "2026-01-32",
      "2026-08-10T25:00",
      "2026-08-10T14:60",
      "2026-02-30T10:00:00Z",
    ]) {
      expect(isValidExpires(value)).toBe(false);
    }
  });

  it("accepts real calendar edge dates", () => {
    for (const value of ["2026-02-28", "2028-02-29", "2026-12-31T23:59:59Z"]) {
      expect(isValidExpires(value)).toBe(true);
    }
  });

  it("rejects a zero or empty duration", () => {
    // `0d` expires the link the instant it is minted, which is never what the
    // author meant and is indistinguishable from a typo.
    for (const value of ["0d", "0h", "0w", "00d"]) {
      expect(isValidExpires(value)).toBe(false);
    }
    expect(isValidExpires("7d")).toBe(true);
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
