import { Command } from "commander";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { VERSION } from "../index.js";
import { HubStore } from "./storage.js";
import { handle, type HandlerDeps } from "./handlers.js";
import { createHttpServer, refuseBind } from "./server.js";

/*
 * Why this file exists separately from cli.ts: node:sqlite prints an
 * `ExperimentalWarning` to stderr when it is first imported, and the filter that
 * swallows it must be installed BEFORE the static import graph that pulls in
 * node:sqlite is evaluated. cli.ts installs the filter, then dynamically imports
 * this module. If you merge this back into cli.ts, the static import of
 * storage.js would be hoisted and evaluated before the filter runs, and the
 * warning silently returns. Keep the split.
 */

function resolveDataDir(explicit: string | undefined): string {
  if (explicit !== undefined && explicit.length > 0) return resolve(explicit);
  const env = process.env.LOOMGRAPH_HUB_DIR;
  if (env !== undefined && env.length > 0) return resolve(env);
  return join(homedir(), ".local", "share", "loomgraph-hub");
}

function openStore(dataDir: string | undefined): HubStore {
  const resolved = resolveDataDir(dataDir);
  mkdirSync(resolved, { recursive: true, mode: 0o700 });
  return HubStore.open(join(resolved, "hub.db"));
}

/** 0 done, 1 config/usage, 2 fatal runtime. */
export function main(): Promise<Command> {
  const program = new Command();
  program
    .name("lg-hub")
    .description("Run the loomgraph team hub: an HTTP API and SQLite store for member runs");

  program
    .command("init")
    .option("--data-dir <d>", "hub data directory")
    .description("create the data directory and the database")
    .action((opts) => {
      const store = openStore(opts.dataDir as string | undefined);
      store.close();
      process.exitCode = 0;
    });

  program
    .command("serve")
    .option("--port <n>", "port to bind", "8369")
    .option("--host <h>", "host to bind", "127.0.0.1")
    .option("--data-dir <d>", "hub data directory")
    .option("--behind-tls-proxy", "trust a terminated TLS proxy in front of this bind", false)
    .description("start the hub http server")
    .action((opts) => {
      try {
        const host = opts.host as string;
        const refused = refuseBind(host, opts.behindTlsProxy === true);
        if (refused !== null) {
          console.error(refused);
          process.exitCode = 1;
          return;
        }
        const port = Number(opts.port);
        if (!Number.isInteger(port) || port < 0 || port > 65535) {
          console.error(`invalid --port: ${opts.port}`);
          process.exitCode = 1;
          return;
        }
        const store = openStore(opts.dataDir as string | undefined);
        const deps: HandlerDeps = { store, now: () => new Date().toISOString(), version: VERSION };
        const server = createHttpServer({ handle: (req) => handle(req, deps) });
        server.listen(port, host, () => {
          console.log(`lg-hub serving on http://${host}:${port}`);
        });
        server.on("error", (err) => {
          console.error(`lg-hub fatal: ${err.message}`);
          process.exitCode = 2;
        });
      } catch (err) {
        console.error(`lg-hub fatal: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 2;
      }
    });

  const member = program
    .command("member")
    .description("manage hub members");

  member
    .command("add")
    .argument("<name>", "member display name")
    .option("--scopes <csv>", "comma-separated scopes", "ingest,read")
    .option("--data-dir <d>", "hub data directory")
    .description("create a member and print its token once")
    .action((name: string, opts) => {
      try {
        const store = openStore(opts.dataDir as string | undefined);
        const scopes = String(opts.scopes)
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        const { token } = store.addMember(name, scopes);
        console.log(token);
        console.error(
          "The token above is shown once and cannot be recovered. Store it somewhere safe.",
        );
        store.close();
      } catch (err) {
        console.error(`lg-hub fatal: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 2;
      }
    });

  member
    .command("revoke")
    .argument("<keyId>")
    .option("--data-dir <d>", "hub data directory")
    .description("revoke a member token")
    .action((keyId: string, opts) => {
      try {
        const store = openStore(opts.dataDir as string | undefined);
        const ok = store.revokeMember(keyId);
        if (ok) {
          console.log(`revoked ${keyId}`);
        } else {
          console.error(`no active member with key id ${keyId}`);
          process.exitCode = 1;
        }
        store.close();
      } catch (err) {
        console.error(`lg-hub fatal: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 2;
      }
    });

  member
    .command("ls")
    .option("--data-dir <d>", "hub data directory")
    .description("list members")
    .action((opts) => {
      try {
        const store = openStore(opts.dataDir as string | undefined);
        for (const m of store.listMembers()) {
          console.log(
            `${m.keyId}\t${m.member}${m.revokedAt !== null ? "\trevoked" : ""}`,
          );
        }
        store.close();
      } catch (err) {
        console.error(`lg-hub fatal: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 2;
      }
    });

  program
    .command("export")
    .option("--jsonl", "one JSON object per line on stdout")
    .option("--data-dir <d>", "hub data directory")
    .description("export ingested events; --jsonl writes one object per line")
    .action((opts) => {
      try {
        const store = openStore(opts.dataDir as string | undefined);
        for (const ev of store.allEvents()) {
          console.log(JSON.stringify({ member: ev.member, runId: ev.runId, json: ev.json }));
        }
        store.close();
      } catch (err) {
        console.error(`lg-hub fatal: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 2;
      }
    });

  return program.parseAsync();
}
