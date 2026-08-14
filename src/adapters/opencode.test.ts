import { describe, it, expect } from "vitest";
import { buildOpencodeArgs, parseOpencodeStdout } from "./opencode.js";

describe("buildOpencodeArgs", () => {
  it("builds the run argv", () => {
    expect(buildOpencodeArgs("summarise the repo")).toEqual(["run", "summarise the repo"]);
  });
});

describe("parseOpencodeStdout", () => {
  it("returns trimmed plain-text stdout with zero cost", () => {
    const out = parseOpencodeStdout("  the answer  \n", 0);
    expect(out.ok).toBe(true);
    expect(out.text).toBe("the answer");
    expect(out.costUsd).toBe(0);
    expect(out.error).toBeNull();
  });

  it("fails on a non-zero exit code", () => {
    const out = parseOpencodeStdout("", 1);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/exit/i);
  });

  it("fails on empty output even with a zero exit code", () => {
    const out = parseOpencodeStdout("   \n", 0);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/no output/i);
  });
});
