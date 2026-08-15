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
  ...common,
});

const verifierNode = z.object({
  type: z.literal("verifier"),
  adapter: z.enum(ADAPTER_NAMES),
  prompt: z.string().min(1),
  pass: z.string().min(1),
  maxTurns: z.number().int().positive().default(20),
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
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      fail(`node "${id}" must be a mapping`);
    }
    const type = (value as Record<string, unknown>).type;
    if (typeof type !== "string" || !(NODE_TYPES as readonly string[]).includes(type)) {
      fail(`node "${id}" has unknown type "${String(type)}" - valid types are ${NODE_TYPES.join(", ")}`);
    }
    const parsed = nodeSchema.safeParse(value);
    if (!parsed.success) fail(issuesToMessage(`node "${id}"`, parsed.error));
    nodes[id] = parsed.data;
  }
  if (Object.keys(nodes).length === 0) fail("graph has no nodes");

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
