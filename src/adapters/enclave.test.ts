import { describe, it, expect } from "vitest";
import { buildEnclavePushArgs, parseEnclavePushJson } from "./enclave.js";

const PUSH_SUCCESS =
  '{"artifactId":"9a7ad03c-fb5d-4a33-9ba0-7ab615aca938","versionId":"90bcc070-ea84-436b-9067-372da0947525","versionNo":1,"viewUrl":"https://9a7ad03c-fb5d-4a33-9ba0-7ab615aca938.dat-nguyen.me/","uploaded":["index.html"],"skipped":[]}';

const PUSH_DRY_RUN = '{"uploaded":["index.html"],"skipped":[]}';

describe("buildEnclavePushArgs", () => {
  it("builds the push argv in a fixed order", () => {
    expect(buildEnclavePushArgs("/tmp/r", "loomgraph run x", "private")).toEqual([
      "push", "/tmp/r", "--title", "loomgraph run x", "--visibility", "private", "--json",
    ]);
  });

  it("appends the dry-run flag last", () => {
    expect(buildEnclavePushArgs("/tmp/r", "t", "org", { dryRun: true })).toEqual([
      "push", "/tmp/r", "--title", "t", "--visibility", "org", "--json", "--dry-run",
    ]);
  });
});

describe("parseEnclavePushJson", () => {
  it("parses a real push response", () => {
    const result = parseEnclavePushJson(PUSH_SUCCESS);
    expect(result).toEqual({
      ok: true,
      artifactId: "9a7ad03c-fb5d-4a33-9ba0-7ab615aca938",
      versionId: "90bcc070-ea84-436b-9067-372da0947525",
      versionNo: 1,
      viewUrl: "https://9a7ad03c-fb5d-4a33-9ba0-7ab615aca938.dat-nguyen.me/",
      uploaded: ["index.html"],
      skipped: [],
    });
  });

  it("rejects a dry-run response that carries no artifact id", () => {
    expect(parseEnclavePushJson(PUSH_DRY_RUN)).toEqual({
      ok: false,
      error: "enclave push returned no artifactId - was this a dry run?",
    });
  });

  it("reports a parse failure for garbage stdout", () => {
    const result = parseEnclavePushJson("boom");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a failure");
    expect(result.error.startsWith("could not parse enclave json output: ")).toBe(true);
  });
});
