import { describe, it, expect } from "vitest";
import { getAdapter, defaultRegistry } from "./registry.js";

describe("getAdapter", () => {
  it("returns each built-in adapter by name", () => {
    expect(getAdapter("claude").name).toBe("claude");
    expect(getAdapter("codex").name).toBe("codex");
    expect(getAdapter("opencode").name).toBe("opencode");
    expect(getAdapter("command").name).toBe("command");
  });

  it("throws naming the valid adapters for an unknown name", () => {
    expect(() => getAdapter("gpt9")).toThrow(/gpt9/);
    expect(() => getAdapter("gpt9")).toThrow(/claude, codex, opencode, command/);
  });

  it("resolves from an injected registry so tests never spawn a real cli", () => {
    const stub = { name: "claude", run: async () => ({ ok: true, text: "", costUsd: 0, raw: null, error: null }) };
    expect(getAdapter("claude", { ...defaultRegistry(), claude: stub })).toBe(stub);
  });
});
