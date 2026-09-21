#!/usr/bin/env node
import { Command } from "commander";
import { VERSION } from "./index.js";
import { enrollCommand } from "./commands/enroll.js";
import { syncCommand } from "./commands/sync.js";
import { eventsCommand } from "./commands/events.js";
import { reportCommand } from "./commands/report.js";
import { resumeCommand } from "./commands/resume.js";
import { runCommand } from "./commands/run.js";
import { lsCommand, statusCommand } from "./commands/status.js";
import { validateCommand } from "./commands/validate.js";

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/** 0 success, 1 validation/usage error, 2 run failed, 3 budget exceeded, 4 paused. */
async function finish(work: Promise<number> | number): Promise<void> {
  try {
    process.exitCode = await work;
  } catch (err) {
    console.error(`error: ${(err as Error).message}`);
    process.exitCode = 2;
  }
}

const program = new Command();

program
  .name("lg")
  .description("Compose agent CLI runs into a checkpointed, resumable graph")
  .version(VERSION);

program
  .command("run")
  .argument("<graph>", "path to a graph yaml file")
  .option("--var <key=value>", "set a graph variable (repeatable)", collect, [])
  .option("--max-usd <n>", "override the graph's usd ceiling")
  .option("--dry-run", "print the dispatch plan and exit without running anything")
  .description("execute a graph")
  .action((graph: string, options) => finish(runCommand(graph, options)));

program
  .command("resume")
  .argument("<runId>", "id of a previously started run")
  .option("--answer <nodeId=text>", "answer a paused human node (repeatable)", collect, [])
  .description("continue a run from its last checkpoint")
  .action((runId: string, options) => finish(resumeCommand(runId, options)));

program
  .command("status")
  .argument("<runId>")
  .description("show node and budget status for a run")
  .action((runId: string) => finish(statusCommand(runId)));

program
  .command("ls")
  .description("list all runs")
  .action(() => finish(lsCommand()));

program
  .command("validate")
  .argument("<graph>", "path to a graph yaml file")
  .description("validate a graph file")
  .action((graph: string) => finish(validateCommand(graph)));

program
  .command("events")
  .argument("<runId>")
  .option("--kind <kind>", "only print events of this kind")
  .description("print the jsonl audit trail for a run")
  .action((runId: string, options) => finish(eventsCommand(runId, options)));

program
  .command("report")
  .argument("<runId>")
  .option("--out <path>", "write the html here instead of the run directory")
  .option("--publish", "publish the report with the enclave cli")
  .option("--title <title>", "title for the published artifact")
  .option("--visibility <visibility>", "private or org", "private")
  .description("render a run to a self-contained html report")
  .action((runId: string, opts) => finish(reportCommand(runId, opts)));

program
  .command("enroll")
  .argument("<url>", "hub base url")
  .argument("<token>", "hub member token")
  .description("store the hub identity in ~/.config/loomgraph/hub.json (mode 0600)")
  .action((url: string, token: string) => finish(enrollCommand(url, token)));

program
  .command("sync")
  .argument("[runId]", "id of a run to sync")
  .option("--all", "sync every run under .loomgraph/runs/")
  .option("--enable", "opt this repository in to hub sync (writes .loomgraph/hub.json)")
  .description("push runs to the team hub")
  .action((runId: string | undefined, options) =>
    finish(syncCommand({ runId, all: options.all, enable: options.enable })),
  );

program.parse();
