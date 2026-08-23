import { execa } from "execa";
import { basename, dirname, join, resolve } from "node:path";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { buildEnclavePushArgs, parseEnclavePushJson } from "../adapters/enclave.js";
import { openLog, openStore, runsDir } from "./context.js";
import { renderReportHtml } from "./render.js";

export interface ReportOptions {
  out?: string;
  publish?: boolean;
  title?: string;
  visibility?: "private" | "org";
}

export async function reportCommand(runId: string, opts: ReportOptions = {}): Promise<number> {
  const store = openStore();
  const state = store.load(runId);
  if (!state) {
    console.error(`run not found: ${runId}`);
    return 1;
  }

  const events = openLog().read(runId);
  const html = renderReportHtml(state, events);

  const htmlPath = resolve(opts.out ?? join(runsDir(), runId, "report", "index.html"));
  mkdirSync(dirname(htmlPath), { recursive: true });
  writeFileSync(htmlPath, html, "utf8");
  console.log(htmlPath);

  if (opts.publish !== true) return 0;

  // Publish ONLY the generated report. Stage a fresh directory we own under
  // os.tmpdir(), copy the single report file into it, and hand that directory
  // to enclave. Never pass the report's parent directory (which may contain
  // the whole working tree, .loomgraph state, other reports, notes...) to the
  // publisher. Enclave only ever sees the one file we put in the staging dir.
  let stagingDir: string | undefined;
  try {
    stagingDir = mkdtempSync(join(tmpdir(), "lg-report-"));
    copyFileSync(htmlPath, join(stagingDir, basename(htmlPath)));

    const args = buildEnclavePushArgs(
      stagingDir,
      opts.title ?? `loomgraph run ${runId}`,
      opts.visibility ?? "private",
    );

    const result = await execa("enclave", args, { reject: false });

    if (result.failed && result.code === "ENOENT") {
      console.error("enclave not found on PATH - the report was written but not published");
      return 0;
    }

    if (result.exitCode !== 0) {
      const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
      if (stderr) console.error(stderr);
      return 2;
    }

    const stdout = typeof result.stdout === "string" ? result.stdout : "";
    const parsed = parseEnclavePushJson(stdout);
    if (!parsed.ok) {
      console.error(parsed.error);
      return 2;
    }

    console.log(parsed.viewUrl);
    return 0;
  } finally {
    if (stagingDir) rmSync(stagingDir, { recursive: true, force: true });
  }
}
