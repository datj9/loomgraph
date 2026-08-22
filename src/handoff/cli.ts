#!/usr/bin/env node
/**
 * `lg-handoff` - distil an agent CLI session into a publishable brief.
 *
 * A separate bin from `lg` on purpose: it shares no state with a loomgraph run,
 * and it owns its own exit-code namespace (see `finish`).
 */
import { Command } from "commander";
import { execa } from "execa";
import { packCommand, pushCommand, scanCommand, type Exec } from "./commands.js";
import type { HandoffAdapter } from "./types.js";

/** The one place this bin spawns anything. Never rejects; results carry the code. */
const exec: Exec = async (bin, args, opts) => {
  const result = await execa(bin, args, { reject: false, cwd: opts?.cwd });
  return {
    exitCode: result.exitCode ?? 1,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    failed: result.failed,
    code: (result as { code?: string }).code,
  };
};

function log(line: string): void {
  console.log(line);
}

/** 0 ok, 1 usage or not found, 2 local refusal or remote failure. */
async function finish(work: Promise<number>): Promise<void> {
  try {
    process.exitCode = await work;
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

const ADAPTERS: readonly string[] = ["claude", "codex", "opencode"];

/** Reject an unknown adapter as a usage error rather than a stack trace. */
function parseAdapter(value: string): HandoffAdapter | null {
  return ADAPTERS.includes(value) ? (value as HandoffAdapter) : null;
}

const program = new Command();

program
  .name("lg-handoff")
  .description(
    "Distil a claude/codex/opencode session into a self-contained brief, scan it " +
      "for secrets, and publish it privately with the enclave cli.\n\n" +
      "Hands over the understanding, not the transcript: a brief a colleague reads " +
      "in a minute, with the goal, the files, what was claimed done, what is open, " +
      "and the commit to start from.",
  )
  .addHelpText(
    "after",
    `
Typical run:
  lg-handoff pack claude --title "LT-8451 null bank_code crash"   # -> ./handoff-bundle
  lg-handoff push ./handoff-bundle                                # -> prints a share link

  Send the link. The recipient opens it in a browser - nothing to install.

Exit codes:
  0  done
  1  usage error, or the session / bundle was not found (usually: pass --session-file)
  2  local gate failed (nothing uploaded), or a remote enclave step failed (see stderr)

Notes:
  scan runs automatically inside both pack and push.
  The share url is printed once and also written to <bundleDir>/SHARE-URL.txt;
  enclave keeps only its hash, so it cannot be recovered later.
  Discovery of a session file is best-effort - pack prints which file it chose.
  The scanner is an allowlist of shapes, not a proof. Read the brief before sharing.
`,
  );

program
  .command("pack")
  .argument("<adapter>", "claude, codex or opencode")
  .argument("[sessionRef]", "session id, used by opencode export")
  .option("--cwd <dir>", "repo directory the session ran in", process.cwd())
  .option("--session-file <path>", "read this transcript instead of discovering one")
  .option("--out <dir>", "write the bundle here", "./handoff-bundle")
  .option("--title <t>", "title for the brief")
  .description("distil a session into a handoff bundle")
  .addHelpText(
    "after",
    `
  --session-file always wins and is the reliable option. Without it:
    claude    newest *.jsonl under ~/.claude/projects/<cwd, non-alphanumerics -> ->
    codex     newest *.jsonl under ~/.codex/sessions/
    opencode  runs: opencode export [sessionRef] --sanitize
`,
  )
  .action((adapter: string, sessionRef: string | undefined, opts) => {
    const parsed = parseAdapter(adapter);
    if (parsed === null) {
      console.error(`unknown adapter: ${adapter} (expected ${ADAPTERS.join(", ")})`);
      process.exitCode = 1;
      return;
    }
    void finish(
      packCommand(
        {
          adapter: parsed,
          sessionRef,
          cwd: opts.cwd as string,
          sessionFile: opts.sessionFile as string | undefined,
          out: opts.out as string,
          title: opts.title as string | undefined,
        },
        exec,
        log,
      ),
    );
  });

program
  .command("scan")
  .argument("<bundleDir>")
  .description("scan a bundle for secrets and residual absolute paths")
  .action((bundleDir: string) => finish(scanCommand(bundleDir, log)));

program
  .command("push")
  .argument("<bundleDir>")
  .option("--title <t>", "title for the published artifact")
  .option("--expires <duration>", "share link lifetime", "7d")
  .option("--visibility <visibility>", "private only - a transcript is production data", "private")
  .option("--dry-run", "let enclave validate the bundle without publishing", false)
  .description("publish a bundle privately and mint a time-boxed share link")
  .addHelpText(
    "after",
    `
  Refuses locally - before enclave is invoked at all - if the scanner finds
  anything, the bundle breaks an enclave limit, or --expires is not a duration
  / date / date-time / zoned ISO instant. Exit 2 at that local gate means
  nothing was uploaded. Exit 2 after enclave ran can mean a partial publish;
  see stderr. Use --dry-run to let enclave validate without publishing.
`,
  )
  .action((bundleDir: string, opts) =>
    finish(
      pushCommand(
        bundleDir,
        {
          title: opts.title as string | undefined,
          expires: opts.expires as string,
          dryRun: opts.dryRun === true,
          visibility: opts.visibility as string,
        },
        exec,
        log,
      ),
    ),
  );

program.parse();
