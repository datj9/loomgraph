import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enrollCommand } from "./enroll.js";

let tmp: string;
let home: string;

function hubPath(): string {
  return join(home, ".config", "loomgraph", "hub.json");
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "loomgraph-enroll-"));
  home = join(tmp, "home");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("enrollCommand", () => {
  it("1. writes the expected JSON at a temp home", async () => {
    const code = await enrollCommand("http://hub.test", "lgt_token", { home });
    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(hubPath(), "utf8"))).toEqual({
      url: "http://hub.test",
      token: "lgt_token",
    });
  });

  it("2. the file mode is 0600", async () => {
    await enrollCommand("https://hub.test", "lgt_token", { home });
    expect(statSync(hubPath()).mode & 0o777).toBe(0o600);
  });

  it("3. creates the .config/loomgraph directory when absent", async () => {
    await enrollCommand("http://hub.test", "lgt_token", { home });
    expect(existsSync(join(home, ".config", "loomgraph"))).toBe(true);
  });

  it("4. an empty url, an empty token, and a non-http url each return 1 and write nothing", async () => {
    const bad: Array<[string, string, string]> = [
      ["", "lgt_token", "empty url"],
      ["   ", "lgt_token", "whitespace-only url"],
      ["http://hub.test", "", "empty token"],
      ["http://hub.test", "   ", "whitespace-only token"],
      ["ftp://hub.test", "lgt_token", "non-http protocol"],
      ["file:///tmp/hub", "lgt_token", "file url"],
      ["not a url", "lgt_token", "unparseable url"],
    ];
    for (const [url, token, label] of bad) {
      const code = await enrollCommand(url, token, { home });
      expect(code, label).toBe(1);
      expect(existsSync(hubPath()), label).toBe(false);
    }
    expect(existsSync(join(home, ".config"))).toBe(false);
  });

  it("5. re-enrolling overwrites cleanly and the mode is still 0600", async () => {
    await enrollCommand("http://one.test", "token-one", { home });
    const code = await enrollCommand("http://two.test", "token-two", { home });
    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(hubPath(), "utf8"))).toEqual({
      url: "http://two.test",
      token: "token-two",
    });
    expect(statSync(hubPath()).mode & 0o777).toBe(0o600);
  });
});