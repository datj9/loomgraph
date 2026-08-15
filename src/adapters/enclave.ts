/**
 * Adapter for the external `enclave` CLI, which hosts a static directory and
 * returns a public URL. loomgraph never embeds enclave - it spawns the binary,
 * exactly as it spawns `claude`. The pure helpers below are unit-tested against
 * real captured stdout.
 */

export type EnclavePushResult =
  | {
      ok: true;
      artifactId: string;
      versionId: string;
      versionNo: number;
      viewUrl: string;
      uploaded: string[];
      skipped: string[];
    }
  | { ok: false; error: string };

/**
 * Build the enclave `push` argv, excluding the binary name. The order is fixed
 * and the title is passed as a single argv element so a title containing spaces
 * or quotes cannot be reinterpreted by a shell.
 */
export function buildEnclavePushArgs(
  dir: string,
  title: string,
  visibility: "private" | "org",
  opts?: { dryRun?: boolean },
): string[] {
  const args = ["push", dir, "--title", title, "--visibility", visibility, "--json"];
  if (opts?.dryRun === true) args.push("--dry-run");
  return args;
}

/** Parse `enclave push` stdout. Never throws; a bad reply becomes `ok: false`. */
export function parseEnclavePushJson(stdout: string): EnclavePushResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { ok: false, error: `could not parse enclave json output: ${stdout.slice(0, 200)}` };
  }

  if (parsed === null || typeof parsed !== "object") {
    return { ok: false, error: `could not parse enclave json output: ${stdout.slice(0, 200)}` };
  }

  const obj = parsed as Record<string, unknown>;
  if (obj.artifactId === undefined || obj.viewUrl === undefined) {
    return { ok: false, error: "enclave push returned no artifactId - was this a dry run?" };
  }

  return {
    ok: true,
    artifactId: String(obj.artifactId),
    versionId: typeof obj.versionId === "string" ? obj.versionId : "",
    versionNo: typeof obj.versionNo === "number" ? obj.versionNo : 0,
    viewUrl: String(obj.viewUrl),
    uploaded: Array.isArray(obj.uploaded) ? (obj.uploaded as string[]) : [],
    skipped: Array.isArray(obj.skipped) ? (obj.skipped as string[]) : [],
  };
}
