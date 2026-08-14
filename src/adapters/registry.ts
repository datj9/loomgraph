import { ClaudeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";
import { CommandAdapter } from "./command.js";
import { OpenCodeAdapter } from "./opencode.js";
import type { Adapter } from "./types.js";

export type AdapterRegistry = Record<string, Adapter>;

/**
 * The adapters a real run uses. The engine takes a registry as an argument so
 * tests can inject stubs and never spawn a real agent CLI.
 */
export function defaultRegistry(): AdapterRegistry {
  return {
    claude: new ClaudeAdapter(),
    codex: new CodexAdapter(),
    opencode: new OpenCodeAdapter(),
    command: new CommandAdapter(),
  };
}

export function getAdapter(name: string, registry: AdapterRegistry = defaultRegistry()): Adapter {
  const adapter = registry[name];
  if (!adapter) {
    throw new Error(`unknown adapter "${name}" - valid adapters are ${Object.keys(registry).join(", ")}`);
  }
  return adapter;
}
