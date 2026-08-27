import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface EnrollOptions {
  /** Injectable in tests; production callers leave it unset and use the real home. */
  home?: string;
}

/**
 * Store the hub identity at `<home>/.config/loomgraph/hub.json`. The file holds
 * a bearer token, so mode 0600 is not decoration - anyone else who can read it
 * can impersonate this machine on the hub.
 *
 * This is a DIFFERENT file from `<cwd>/.loomgraph/hub.json`, which is the
 * per-repo opt-in flag (`{"sync": true}`) written by `lg sync --enable` and
 * never contains a token. The two are easy to conflate because they share a
 * name; they never share a job. The identity lives once, in the user's home;
 * each repo only consents to be synced.
 */
export async function enrollCommand(url: string, token: string, opts?: EnrollOptions): Promise<number> {
  if (url.trim() === "") {
    console.error("hub url must not be empty");
    return 1;
  }
  if (token.trim() === "") {
    console.error("hub token must not be empty");
    return 1;
  }
  if (!isHttpUrl(url)) {
    console.error(`hub url must be http or https, got: ${url}`);
    return 1;
  }

  const home = opts?.home ?? homedir();
  const dir = join(home, ".config", "loomgraph");
  const path = join(dir, "hub.json");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, `${JSON.stringify({ url, token })}\n`, { encoding: "utf8", mode: 0o600 });
  // writeFileSync's mode is masked by the umask and ignored once the file
  // exists; chmod pins 0600 on re-enroll too, so an overwrite can never widen
  // the mode a stale process left behind.
  chmodSync(path, 0o600);
  console.log(`enrolled hub at ${url}`);
  return 0;
}

function isHttpUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}