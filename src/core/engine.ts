import { isAbsolute, resolve } from "node:path";
import type { Adapter, AdapterOutput } from "../adapters/types.js";
import type { AdapterRegistry } from "../adapters/registry.js";
import { checkBudget, recordSpend } from "./budget.js";
import { END, type Edge, type Graph, type NodeDef } from "./graph.js";
import { EventLog, type LgEvent, type LgEventInput } from "./events.js";
import { CheckpointStore } from "./store.js";
import type { NodeResult, RunState } from "./types.js";

export class EngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineError";
  }
}

/**
 * A template reference that cannot be resolved against the run state. Unlike
 * transient adapter failures the error is deterministic: retrying would only
 * burn attempts, so the engine fails the node instead of re-running it.
 * Deliberately no own constructor: instances inherit EngineError's name, so
 * code asserting the exact EngineError error keeps matching.
 */
export class TemplateError extends EngineError {}

export interface EngineDeps {
  store: CheckpointStore;
  log: EventLog;
  registry: AdapterRegistry;
  /** Injected in tests so retry backoff does not cost wall-clock time. */
  sleep?: (ms: number) => Promise<void>;
  /** Answers for human nodes, keyed by node id. Supplied by `lg resume --answer`. */
  humanAnswers?: Record<string, string>;
  onEvent?: (event: LgEvent) => void;
}

export function makeRunId(graphName: string, now = new Date(), rand = Math.random()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const suffix = rand.toString(36).slice(2, 6).padEnd(4, "0");
  return `${graphName}-${stamp}-${suffix}`;
}

export function newRunState(
  graph: Graph,
  opts: { runId: string; cwd: string; vars?: Record<string, unknown> },
): RunState {
  const now = new Date().toISOString();
  return {
    runId: opts.runId,
    graphName: graph.name,
    status: "pending",
    createdAt: now,
    updatedAt: now,
    cwd: opts.cwd,
    vars: { ...graph.vars, ...(opts.vars ?? {}) },
    budget: { ...graph.budget },
    spent: { usd: 0, wallClockSec: 0, nodeRuns: 0 },
    nodes: {},
    completed: [],
    seq: 0,
  };
}

/** Resolve `{{vars.x}}`, `{{x}}` and `{{nodes.<id>.output}}` against the run state. */
export function interpolate(template: string, state: RunState): string {
  return template.replace(/\{\{\s*([A-Za-z0-9_.\-]+)\s*\}\}/g, (_match, ref: string) => {
    const parts = ref.split(".");
    let value: unknown;

    if (parts.length === 1) {
      value = state.vars[parts[0]!];
    } else if (parts[0] === "vars" && parts.length === 2) {
      value = state.vars[parts[1]!];
    } else if (parts[0] === "nodes" && parts.length === 3 && parts[2] === "output") {
      value = state.nodes[parts[1]!]?.output;
    } else {
      throw new TemplateError(`unknown template reference "{{${ref}}}"`);
    }

    if (value === undefined) throw new TemplateError(`unknown template reference "{{${ref}}}"`);
    return typeof value === "string" ? value : JSON.stringify(value);
  });
}

function predicateHolds(edge: Edge, state: RunState): boolean {
  if (!edge.from.every((id) => state.completed.includes(id))) return false;
  switch (edge.when) {
    case "all_succeeded":
      return edge.from.every((id) => state.nodes[id]?.status === "succeeded");
    case "any_succeeded":
      return edge.from.some((id) => state.nodes[id]?.status === "succeeded");
    default:
      return true;
  }
}

function incomingEdges(graph: Graph): Map<string, Edge[]> {
  const incoming = new Map<string, Edge[]>();
  for (const id of Object.keys(graph.nodes)) incoming.set(id, []);
  for (const edge of graph.edges) {
    for (const to of edge.to) {
      if (to === END) continue;
      incoming.get(to)!.push(edge);
    }
  }
  return incoming;
}

/** Nodes whose every incoming edge is satisfied and that have not completed yet. */
export function readySet(graph: Graph, state: RunState): string[] {
  const incoming = incomingEdges(graph);
  return Object.keys(graph.nodes).filter((id) => {
    if (state.completed.includes(id)) return false;
    return incoming.get(id)!.every((edge) => predicateHolds(edge, state));
  });
}

/**
 * Assert a command node's opt-in expectations against its stdout. Returns null
 * when the node satisfies them, otherwise the failure message. A shell command
 * that exits 0 having done nothing is not a passing check.
 */
export function checkCommandExpectations(
  node: { expect?: string; expectNonEmpty?: boolean },
  text: string,
): string | null {
  if (node.expectNonEmpty === true && text.trim() === "") {
    return "command produced no output but expectNonEmpty is set";
  }
  if (typeof node.expect === "string" && node.expect !== "" && text.includes(node.expect) === false) {
    return `command output did not contain the expected string: ${node.expect}`;
  }
  return null;
}

/** Escape a literal string so it can appear inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True when `pass` appears in `text` as a whole token, not as a raw substring.
 * The token must not be glued to word characters on either side, so "PASS"
 * matches "looks good - PASS" but not "PASSWORD" or "BYPASS". The pass string
 * itself is otherwise matched literally.
 */
export function containsPassToken(text: string, pass: string): boolean {
  const boundary = "(?:^|[^A-Za-z0-9_])";
  return new RegExp(`${boundary}${escapeRegExp(pass)}(?:$|[^A-Za-z0-9_])`).test(text);
}

/**
 * The batches the scheduler would dispatch, in order. Pure - used by
 * `lg run --dry-run`, which must not spawn anything.
 */
export function planLevels(graph: Graph): string[][] {
  const state = newRunState(graph, { runId: "plan", cwd: "." });
  const levels: string[][] = [];

  while (true) {
    const ready = readySet(graph, state);
    if (ready.length === 0) return levels;
    levels.push(ready);
    for (const id of ready) {
      state.nodes[id] = {
        nodeId: id, status: "succeeded", startedAt: "", endedAt: null,
        attempts: 1, output: "", error: null, costUsd: 0,
      };
    }
    state.completed = [...state.completed, ...ready];
  }
}

export function endReached(graph: Graph, state: RunState): boolean {
  return graph.edges.some((edge) => edge.to.includes(END) && predicateHolds(edge, state));
}

function nodeCwd(def: NodeDef, state: RunState): string {
  if (!def.cwd) return state.cwd;
  return isAbsolute(def.cwd) ? def.cwd : resolve(state.cwd, def.cwd);
}

function pickAdapter(def: NodeDef, registry: AdapterRegistry): Adapter {
  const name = def.type === "command" ? "command" : def.type === "human" ? "human" : def.adapter;
  const adapter = registry[name];
  if (!adapter) {
    throw new EngineError(`no adapter "${name}" available - registered adapters: ${Object.keys(registry).join(", ")}`);
  }
  return adapter;
}

export async function execute(graph: Graph, initial: RunState, deps: EngineDeps): Promise<RunState> {
  const { store, log, registry } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const answers = deps.humanAnswers ?? {};

  let state = initial;
  // Shared with the admission pass below: set by both the batch admission and
  // a retry refused inside executeNode, and always consumed by the budget
  // stop path (emit budget_exceeded + finish("failed", reason)).
  let budgetStopReason: string | null = null;
  if (state.status === "succeeded" || state.status === "failed") {
    throw new EngineError(`run ${state.runId} is already ${state.status} and cannot be executed again`);
  }

  const emit = (input: LgEventInput): void => {
    const event = log.append(state.runId, input);
    deps.onEvent?.(event);
  };

  const resumed = state.completed.length > 0 || state.status === "paused";
  state.status = "running";
  state = store.save(state);
  emit({ kind: "run_started", data: { graph: graph.name, resumed, cwd: state.cwd } });

  const finish = (status: "succeeded" | "failed", error: string | null): RunState => {
    state.status = status;
    state = store.save(state);
    emit({ kind: "run_finished", data: { status, error, spent: state.spent } });
    return state;
  };

  /** Run one node to completion, honouring its retry policy. */
  const executeNode = async (id: string, def: NodeDef): Promise<NodeResult> => {
    const startedAt = new Date().toISOString();
    const maxAttempts = def.retries + 1;
    let attempts = 0;
    let costUsd = 0;
    let lastError = "node did not run";
    let lastText = "";

    while (attempts < maxAttempts) {
      // C2 part B: a retry is a node run like any other, so one must never be
      // spent once the ceilings would be crossed. Check the budget before each
      // attempt and stop retrying the moment it refuses. The first attempt of
      // an admitted node always passes: part A already admitted it with a
      // projection of one run, and attempts + 1 equals 1 here.
      const projected = recordSpend(state, { usd: 0, nodeRuns: attempts + 1 });
      const admission = checkBudget(projected);
      if (!admission.ok) {
        budgetStopReason = admission.reason;
        lastError = admission.reason;
        break;
      }

      attempts += 1;
      emit({ kind: "node_started", nodeId: id, data: { attempt: attempts, type: def.type } });

      let out: AdapterOutput;
      try {
        out = await runOnce(id, def);
      } catch (err) {
        // M2: an unresolvable template reference is deterministic, so retrying
        // would only burn attempts. Fail the node through the engine's normal
        // failure path (commit emits node_finished; the batch branch below
        // emits run_finished and persists "failed") instead of stranding the
        // run. Anything else keeps propagating as it does today.
        if (err instanceof TemplateError) {
          return {
            nodeId: id, status: "failed", startedAt, endedAt: new Date().toISOString(),
            attempts, output: lastText, error: err.message, costUsd,
          };
        }
        throw err;
      }
      costUsd += out.costUsd;
      lastText = out.text;

      if (out.ok) {
        return { nodeId: id, status: "succeeded", startedAt, endedAt: new Date().toISOString(), attempts, output: out.text, error: null, costUsd };
      }
      lastError = out.error ?? "node failed without an error message";
      if (attempts < maxAttempts) await sleep(Math.min(2 ** attempts, 30) * 1000);
    }

    return { nodeId: id, status: "failed", startedAt, endedAt: new Date().toISOString(), attempts, output: lastText, error: lastError, costUsd };
  };

  const runOnce = async (id: string, def: NodeDef): Promise<AdapterOutput> => {
    const adapter = pickAdapter(def, registry);
    const cwd = nodeCwd(def, state);

    if (def.type === "command") {
      const out = await adapter.run({ prompt: interpolate(def.run, state), cwd, timeoutSec: def.timeoutSec });
      if (out.ok) {
        const expectationError = checkCommandExpectations(def, out.text);
        if (expectationError !== null) {
          return { ...out, ok: false, error: expectationError };
        }
      }
      return out;
    }
    if (def.type === "human") {
      throw new EngineError(`human node "${id}" cannot be dispatched to an adapter`);
    }

    const out = await adapter.run({
      prompt: interpolate(def.prompt, state),
      cwd,
      maxTurns: def.maxTurns,
      model: def.model,
      timeoutSec: def.timeoutSec,
    });

    if (def.type === "verifier" && out.ok && !containsPassToken(out.text, def.pass)) {
      return { ...out, ok: false, error: `verifier "${id}" did not report the pass string "${def.pass}"` };
    }
    return out;
  };

  /** Fold a finished node into the state, then checkpoint. */
  const commit = (result: NodeResult): void => {
    state.nodes[result.nodeId] = result;
    state = recordSpend(state, { usd: result.costUsd, nodeRuns: result.attempts });
    emit({ kind: "node_finished", nodeId: result.nodeId, data: { status: result.status, attempts: result.attempts, costUsd: result.costUsd, error: result.error } });

    if (result.status === "succeeded") {
      state.completed = [...state.completed, result.nodeId];
      for (const edge of graph.edges) {
        if (edge.from.includes(result.nodeId)) {
          emit({ kind: "edge_crossed", nodeId: result.nodeId, data: { from: edge.from, to: edge.to, when: edge.when } });
        }
      }
    }
    // Checkpoint after every edge crossing, never only at the end.
    state = store.save(state);
  };

  while (true) {
    if (endReached(graph, state)) {
      const check = checkBudget(state);
      if (!check.ok) {
        emit({ kind: "budget_exceeded", data: { reason: check.reason, spent: state.spent, budget: state.budget } });
        return finish("failed", check.reason);
      }
      return finish("succeeded", null);
    }

    const ready = readySet(graph, state);
    if (ready.length === 0) {
      return finish("failed", `deadlock: no node is ready and ${END} was never reached`);
    }

    const check = checkBudget(state);
    if (!check.ok) {
      emit({ kind: "budget_exceeded", data: { reason: check.reason, spent: state.spent, budget: state.budget } });
      return finish("failed", check.reason);
    }
    emit({ kind: "budget_checked", data: { spent: state.spent, budget: state.budget, ready } });

    const humans = ready.filter((id) => graph.nodes[id]!.type === "human");
    const unanswered = humans.filter((id) => answers[id] === undefined);
    if (unanswered.length > 0) {
      for (const id of unanswered) {
        const def = graph.nodes[id]!;
        let question: string;
        try {
          // M5: the question shown to a reviewer is a template like any other -
          // resolve {{vars.*}} and {{nodes.*.output}} exactly like agent prompts.
          question = interpolate(def.type === "human" ? def.question : "", state);
        } catch (err) {
          // M2: an unresolvable reference is deterministic, so pausing with a
          // broken question would strand the run. Fail through the normal path.
          if (err instanceof TemplateError) return finish("failed", err.message);
          throw err;
        }
        emit({ kind: "human_requested", nodeId: id, data: { question } });
      }
      state.status = "paused";
      state = store.save(state);
      return state;
    }

    for (const id of humans) {
      const answer = answers[id]!;
      const now = new Date().toISOString();
      emit({ kind: "human_resolved", nodeId: id, data: { answer } });
      commit({ nodeId: id, status: "succeeded", startedAt: now, endedAt: now, attempts: 1, output: answer, error: null, costUsd: 0 });
    }

    const batch = ready.filter((id) => graph.nodes[id]!.type !== "human");
    if (batch.length > 0) {
      // Admission pass: maxNodeRuns must bound work, not just batch boundaries.
      // Project the spend one node at a time and ask checkBudget before each
      // dispatch, so a node whose run would push the spent node-run count over
      // the ceiling is never dispatched and leaves no side effect. Everything
      // admitted still runs concurrently, checkpointing as each lands.
      let projection = state;
      const admitted: string[] = [];
      for (const id of batch) {
        projection = recordSpend(projection, { usd: 0, nodeRuns: 1 });
        const admission = checkBudget(projection);
        if (!admission.ok) {
          budgetStopReason = admission.reason;
          break;
        }
        admitted.push(id);
      }

      const results = await Promise.all(
        admitted.map(async (id) => {
          const result = await executeNode(id, graph.nodes[id]!);
          commit(result);
          return result;
        }),
      );

      const failed = results.filter((r) => r.status === "failed");
      // C2 part B: a retry refused by the budget must surface as budget_exceeded,
      // exactly like the part A admission stop, not as a generic node failure.
      if (budgetStopReason !== null) {
        emit({ kind: "budget_exceeded", data: { reason: budgetStopReason, spent: state.spent, budget: state.budget } });
        return finish("failed", budgetStopReason);
      }
      if (failed.length > 0) {
        const detail = failed.map((r) => `${r.nodeId}: ${r.error}`).join("; ");
        return finish("failed", `node failed after ${failed[0]!.attempts} attempt(s) - ${detail}`);
      }
    }
  }
}
