import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export class GraphValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphValidationError";
  }
}

export class GraphCycleError extends GraphValidationError {
  constructor(public readonly cycle: string[]) {
    super(`graph has a cycle: ${cycle.join(" -> ")}`);
    this.name = "GraphCycleError";
  }
}

export const END = "END";
export const ADAPTER_NAMES = ["claude", "codex", "opencode"] as const;
export const NODE_TYPES = ["agent", "command", "verifier", "human"] as const;
export const EDGE_PREDICATES = ["always", "all_succeeded", "any_succeeded"] as const;

export type AdapterName = (typeof ADAPTER_NAMES)[number];
export type EdgePredicate = (typeof EDGE_PREDICATES)[number];

const common = {
  retries: z.number().int().min(0).default(0),
  timeoutSec: z.number().positive().default(900),
  cwd: z.string().optional(),
};

const agentNode = z.object({
  type: z.literal("agent"),
  adapter: z.enum(ADAPTER_NAMES),
  prompt: z.string().min(1),
  maxTurns: z.number().int().positive().default(20),
  model: z.string().min(1).optional(),
  ...common,
});

const verifierNode = z.object({
  type: z.literal("verifier"),
  adapter: z.enum(ADAPTER_NAMES),
  prompt: z.string().min(1),
  pass: z.string().min(1),
  maxTurns: z.number().int().positive().default(20),
  model: z.string().min(1).optional(),
  ...common,
});

const commandNode = z.object({
  type: z.literal("command"),
  run: z.string().min(1),
  expect: z.string().min(1).optional(),
  expectNonEmpty: z.boolean().optional(),
  ...common,
});

const humanNode = z.object({
  type: z.literal("human"),
  question: z.string().min(1),
  ...common,
});

const nodeSchema = z.discriminatedUnion("type", [agentNode, verifierNode, commandNode, humanNode]);

const budgetSchema = z.object({
  maxUsd: z.number().positive(),
  maxWallClockSec: z.number().positive(),
  maxNodeRuns: z.number().int().positive(),
});

export type AgentNodeDef = z.infer<typeof agentNode>;
export type VerifierNodeDef = z.infer<typeof verifierNode>;
export type CommandNodeDef = z.infer<typeof commandNode>;
export type HumanNodeDef = z.infer<typeof humanNode>;
export type NodeDef = z.infer<typeof nodeSchema>;

export interface Edge {
  from: string[];
  to: string[];
  when: EdgePredicate;
}

export interface Graph {
  name: string;
  budget: z.infer<typeof budgetSchema>;
  vars: Record<string, unknown>;
  nodes: Record<string, NodeDef>;
  edges: Edge[];
  entry: string;
}

function fail(message: string): never {
  throw new GraphValidationError(message);
}

function issuesToMessage(prefix: string, error: z.ZodError): string {
  const parts = error.issues.map((issue) => {
    const path = issue.path.join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });
  return `${prefix}: ${parts.join("; ")}`;
}

function asList(value: unknown, where: string): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value as string[];
  return fail(`${where} must be a node id or a list of node ids`);
}

/**
 * The same `{{...}}` grammar the engine's `interpolate` resolver accepts:
 * a bare shorthand `{{x}}` (meaning `{{vars.x}}`), `{{vars.x}}`, or
 * `{{nodes.<id>.output}}`. Anything else, or a `nodes.<id>.output` reference
 * to an undeclared node id, is a static validation error.
 *
 * Var references are deliberately NOT checked against the graph's `vars:`
 * block: `lg run --var name=value` injects vars at runtime that the block
 * never declares, so an undeclared var is not statically decidable. Only node
 * ids, which come exclusively from the graph itself, are load-time decidable.
 */
const templateRefPattern = /\{\{\s*([A-Za-z0-9_.\-]+)\s*\}\}/g;

function checkTemplateReferences(nodes: Record<string, NodeDef>): void {
  for (const [id, def] of Object.entries(nodes)) {
    const template =
      def.type === "command" ? def.run : def.type === "agent" || def.type === "verifier" ? def.prompt : null;
    if (template === null) continue;
    for (const match of template.matchAll(templateRefPattern)) {
      const ref = match[1]!;
      const parts = ref.split(".");
      let ok: boolean;
      if (parts.length === 1) {
        ok = true;
      } else if (parts[0] === "vars" && parts.length === 2) {
        ok = true;
      } else if (parts[0] === "nodes" && parts.length === 3 && parts[2] === "output") {
        ok = parts[1]! in nodes;
      } else {
        ok = false;
      }
      if (!ok) fail(`node "${id}": unknown template reference "{{${ref}}}"`);
    }
  }
}

/** Parse a graph from YAML text and validate it structurally. */
export function parseGraph(source: string, sourceName = "graph"): Graph {
  let raw: unknown;
  try {
    raw = parseYaml(source);
  } catch (err) {
    return fail(`${sourceName} is not valid YAML: ${(err as Error).message}`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return fail(`${sourceName} must be a YAML mapping`);
  }
  const doc = raw as Record<string, unknown>;

  const name = doc.name;
  if (typeof name !== "string" || name.length === 0) fail("name is required and must be a non-empty string");

  if (doc.budget === undefined || doc.budget === null) {
    fail("budget is required (maxUsd, maxWallClockSec, maxNodeRuns must all be > 0)");
  }
  const budgetParsed = budgetSchema.safeParse(doc.budget);
  if (!budgetParsed.success) fail(issuesToMessage("budget", budgetParsed.error));

  const vars = (doc.vars ?? {}) as Record<string, unknown>;
  if (typeof vars !== "object" || vars === null || Array.isArray(vars)) fail("vars must be a mapping");

  const rawNodes = doc.nodes;
  if (rawNodes === null || typeof rawNodes !== "object" || Array.isArray(rawNodes)) {
    fail("nodes is required and must be a mapping of node id to node definition");
  }

  const nodes: Record<string, NodeDef> = {};
  for (const [id, value] of Object.entries(rawNodes as Record<string, unknown>)) {
    if (id === END) fail(`node id "${END}" is reserved`);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
      fail(`node id "${id}" must match [A-Za-z0-9_-] and be 1-64 characters`);
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      fail(`node "${id}" must be a mapping`);
    }
    const type = (value as Record<string, unknown>).type;
    if (typeof type !== "string" || !(NODE_TYPES as readonly string[]).includes(type)) {
      fail(`node "${id}" has unknown type "${String(type)}" - valid types are ${NODE_TYPES.join(", ")}`);
    }
    // zod strips unknown keys, so a `model` or `adapter` on a command or human
    // node would vanish silently rather than fail. Only the two node types that
    // dispatch a prompt to an agent CLI can carry either.
    if ((value as Record<string, unknown>).model !== undefined && type !== "agent" && type !== "verifier") {
      fail(`node "${id}" of type "${type}" cannot declare a model - only agent and verifier nodes dispatch to an adapter`);
    }
    if ((value as Record<string, unknown>).adapter !== undefined && type !== "agent" && type !== "verifier") {
      fail(`node "${id}" of type "${type}" cannot declare an adapter - only agent and verifier nodes dispatch to an adapter`);
    }
    const parsed = nodeSchema.safeParse(value);
    if (!parsed.success) fail(issuesToMessage(`node "${id}"`, parsed.error));
    nodes[id] = parsed.data;
  }
  if (Object.keys(nodes).length === 0) fail("graph has no nodes");
  checkTemplateReferences(nodes);

  const rawEdges = doc.edges;
  if (!Array.isArray(rawEdges) || rawEdges.length === 0) fail("edges is required and must be a non-empty list");

  const edges: Edge[] = rawEdges.map((value, i) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`edges[${i}] must be a mapping`);
    const e = value as Record<string, unknown>;
    const from = asList(e.from, `edges[${i}].from`);
    const to = asList(e.to, `edges[${i}].to`);
    const when = e.when === undefined ? "always" : e.when;
    if (typeof when !== "string" || !(EDGE_PREDICATES as readonly string[]).includes(when)) {
      fail(`edges[${i}] has unknown predicate "${String(when)}" - valid predicates are ${EDGE_PREDICATES.join(", ")}`);
    }
    return { from, to, when: when as EdgePredicate };
  });

  const entry = validateStructure(nodes, edges);

  return { name, budget: budgetParsed.data, vars, nodes, edges, entry };
}

/**
 * Reference, entry and cycle checks. Returns the single entry node id.
 */
export function validateStructure(nodes: Record<string, NodeDef>, edges: Edge[]): string {
  for (const [i, edge] of edges.entries()) {
    for (const id of edge.from) {
      if (id === END) fail(`edges[${i}].from references "${END}", which can only be an edge target`);
      if (!(id in nodes)) fail(`edges[${i}].from references unknown node "${id}"`);
    }
    for (const id of edge.to) {
      if (id === END) continue;
      if (!(id in nodes)) fail(`edges[${i}].to references unknown node "${id}"`);
    }
  }

  const targets = new Set<string>();
  for (const edge of edges) for (const id of edge.to) targets.add(id);
  const entries = Object.keys(nodes).filter((id) => !targets.has(id));
  if (entries.length === 0) fail("graph has no entry node - every node is the target of an edge");
  if (entries.length > 1) fail(`graph must have exactly one entry node, found ${entries.length}: ${entries.join(", ")}`);

  detectCycle(nodes, edges);

  return entries[0]!;
}

function detectCycle(nodes: Record<string, NodeDef>, edges: Edge[]): void {
  const adj = new Map<string, string[]>();
  for (const id of Object.keys(nodes)) adj.set(id, []);
  for (const edge of edges) {
    for (const from of edge.from) {
      for (const to of edge.to) {
        if (to === END) continue;
        adj.get(from)!.push(to);
      }
    }
  }

  const visited = new Set<string>();
  const stack: string[] = [];
  const onStack = new Set<string>();

  const visit = (id: string): void => {
    visited.add(id);
    stack.push(id);
    onStack.add(id);
    for (const next of adj.get(id) ?? []) {
      if (onStack.has(next)) {
        const cycle = stack.slice(stack.indexOf(next));
        cycle.push(next);
        throw new GraphCycleError(cycle);
      }
      if (!visited.has(next)) visit(next);
    }
    stack.pop();
    onStack.delete(id);
  };

  for (const id of Object.keys(nodes)) if (!visited.has(id)) visit(id);
}

export function loadGraph(path: string): Graph {
  return parseGraph(readFileSync(path, "utf8"), path);
}
