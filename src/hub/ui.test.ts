import { describe, expect, it } from "vitest";
import { UI_HTML } from "./ui.js";

describe("UI_HTML", () => {
  it("is a single self-contained html document", () => {
    expect(UI_HTML.startsWith("<!doctype html>")).toBe(true);
    expect(UI_HTML).toContain('<main id="view">');
    expect(UI_HTML).toContain("loomgraph hub");
  });

  it("makes no external requests: only same-origin /v1 API paths", () => {
    expect(UI_HTML).not.toMatch(/src\s*=\s*["']https?:/i);
    expect(UI_HTML).not.toMatch(/href\s*=\s*["']https?:/i);
    expect(UI_HTML).toContain("/v1/runs");
    expect(UI_HTML).toContain("/v1/feed");
    expect(UI_HTML).toContain("/v1/members");
  });

  it("authenticates with a bearer token held in localStorage", () => {
    expect(UI_HTML).toContain("Bearer");
    expect(UI_HTML).toContain("localStorage");
  });

  it("renders untrusted data via textContent, never innerHTML", () => {
    expect(UI_HTML).not.toContain("innerHTML");
  });
});
