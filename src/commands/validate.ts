import { readFileSync } from "node:fs";
import { parseGraph } from "../core/graph.js";
import { planLevels } from "../core/engine.js";

export function validateCommand(file: string): number {
  let source: string;
  try {
    source = readFileSync(file, "utf8");
  } catch (err) {
    console.error(`cannot read ${file}: ${(err as Error).message}`);
    return 1;
  }

  try {
    const graph = parseGraph(source, file);
    const levels = planLevels(graph);
    console.log(`${file}: ok - graph "${graph.name}", ${Object.keys(graph.nodes).length} nodes, ${levels.length} batches`);
    return 0;
  } catch (err) {
    console.error(`${file}: ${(err as Error).message}`);
    return 1;
  }
}
