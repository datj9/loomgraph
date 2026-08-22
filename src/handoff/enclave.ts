/**
 * The `enclave` CLI seen from the handoff subtree: pure argv builders and pure
 * stdout parsers, nothing else. Spawning is the caller's job, behind the `Exec`
 * seam in `commands.ts`, so no test in this subtree can reach the real binary.
 *
 * This duplicates two helpers that also exist in `src/adapters/enclave.ts`. That
 * is deliberate: `src/handoff/**` imports nothing from `src/core/**` or
 * `src/adapters/**`, so the whole subtree can be extracted into a sibling
 * package with a `git mv`.
 *
 * Never log the argv these builders return alongside environment state. The
 * enclave token lives in `ENCLAVE_TOKEN` and in the CLI's own credentials file;
 * nothing here reads either, and nothing here should start.
 */

/** Handoff pushes are private-only, so visibility is not a parameter. */
export function buildEnclavePushArgs(
  dir: string,
  title: string,
  opts?: { dryRun?: boolean },
): string[] {
  const args = ["push", dir, "--title", title, "--visibility", "private", "--json"];
  if (opts?.dryRun === true) args.push("--dry-run");
  return args;
}

export type EnclavePushResult =
  | { ok: true; artifactId: string; viewUrl: string }
  | { ok: false; error: string };

/** Parse `enclave push --json` stdout. Never throws; a bad reply is `ok: false`. */
export function parseEnclavePushJson(stdout: string): EnclavePushResult {
  const obj = parseObject(stdout);
  if (obj === null) {
    return { ok: false, error: `could not parse enclave json output: ${stdout.slice(0, 200)}` };
  }

  if (obj.artifactId === undefined || obj.viewUrl === undefined) {
    return { ok: false, error: "enclave push returned no artifactId - was this a dry run?" };
  }

  return { ok: true, artifactId: String(obj.artifactId), viewUrl: String(obj.viewUrl) };
}

export function buildEnclaveShareCreateArgs(artifactId: string, expires: string): string[] {
  return ["share", "create", artifactId, "--expires", expires, "--json"];
}

/**
 * Shapes `enclave share create --expires` accepts. Anything else is an
 * InvalidInputError after the artifact is already published, so push must
 * reject these locally first.
 */
export function isValidExpires(value: string): boolean {
  if (/^\d+[dhw]$/.test(value)) return true;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return true;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return true;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return true;
  return false;
}

export type EnclaveShareResult = { ok: true; url: string } | { ok: false; error: string };

/**
 * Field names `share create --json` may use for the share URL.
 *
 * UNVERIFIED SHAPE. The real stdout of `enclave share create --json` has not
 * been captured on this machine - AGENTS.md requires fixtures from a real
 * invocation, and no push was performed while writing this. The parser is
 * therefore lenient: it accepts any of these top-level string fields. Capture a
 * real invocation, commit that fixture, and tighten this to the one true field.
 */
const SHARE_URL_FIELDS: readonly string[] = ["url", "shareUrl", "link", "share_url"];

/** Parse `enclave share create --json` stdout. Never throws. */
export function parseEnclaveShareCreateJson(stdout: string): EnclaveShareResult {
  const obj = parseObject(stdout);
  if (obj === null) {
    return { ok: false, error: `could not parse enclave json output: ${stdout.slice(0, 200)}` };
  }

  for (const field of SHARE_URL_FIELDS) {
    const value = obj[field];
    if (typeof value === "string" && value !== "") return { ok: true, url: value };
  }

  return {
    ok: false,
    error:
      "enclave share create returned no share url " +
      `(looked for ${SHARE_URL_FIELDS.join(", ")}): ${stdout.slice(0, 200)}`,
  };
}

/** JSON.parse restricted to plain objects. Returns null instead of throwing. */
function parseObject(stdout: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}
