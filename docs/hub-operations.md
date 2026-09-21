# Hub operations runbook

Operator-facing. Everything here is run on the hub host as an administrator.
Member-facing material is in [hub-onboarding.md](./hub-onboarding.md).

The goal of this document is that someone who did not build the hub can restore
it from a backup and prove the restored database is intact, using nothing but
this page.

## The facts you need

This runbook is written against **your** deployment's addresses, which live in
`deploy/hub.env` (copy `deploy/hub.env.example`). Nothing here hardcodes them.
Export them once per shell and every command below pastes as written:

```bash
set -a; . /path/to/loomgraph/deploy/hub.env; set +a
HUB_IP="$LOOMGRAPH_HUB_IP"
```

| Thing | Value |
| --- | --- |
| Host | the mesh peer running `lg-hub` (developed against Ubuntu 25.04) |
| Public address | `$HUB_PUBLIC_IP` — the non-mesh fallback route, if you have one |
| Mesh address | `$HUB_IP` (WireGuard, interface `wt0` under NetBird) |
| Hub listener | `$HUB_IP:8369` — mesh only, never `0.0.0.0` |
| Service user | `lghub` |
| Data directory | `/var/lib/lghub` (mode 0750, owned `lghub:lghub`) |
| Database | `/var/lib/lghub/hub.db` plus `hub.db-wal` and `hub.db-shm` |
| systemd unit | `lg-hub.service` |
| Binary | `/usr/bin/lg-hub` (which is `dist/hub/cli.js`) |
| Health endpoint | `GET /v1/health` |

The hub never runs an agent. Agents run on each member's own machine under that
member's own credentials. A hub outage is a sync outage and nothing else.

Commands below are written with `sudo`; run them as root or via `sudo` as shown.

### The data directory is not optional on the command line

`lg-hub` resolves its data directory in this order: `--data-dir`, then the
`LOOMGRAPH_HUB_DIR` environment variable, then `~/.local/share/loomgraph-hub`.
There is no "current" database it can find on its own.

**Every `lg-hub` command you type by hand must name the data directory
explicitly.** If you forget, the command silently creates a second, empty
database in the invoking user's home directory and succeeds against it —
`member ls` prints nothing, `export` prints nothing, and neither is an error.
That is the single most common way to waste an hour here.

Throughout this document, commands are written as:

```bash
sudo -u lghub lg-hub <subcommand> --data-dir /var/lib/lghub
```

**Run every command that opens the database as `lghub`, never as root.** Opening a
WAL database creates `hub.db-wal` and `hub.db-shm` beside it, owned by whoever
opened it. A root-owned sidecar left behind by a careless `sqlite3` or `lg-hub`
invocation stops the service from writing, and the failure surfaces later as
unexplained ingest errors.

Confirm which directory the running service actually uses before trusting
anything else on this page:

```bash
systemctl cat lg-hub.service | grep -E 'ExecStart|Environment'
```

## Service

### Start, stop, restart, status

```bash
sudo systemctl start lg-hub
sudo systemctl stop lg-hub
sudo systemctl restart lg-hub
systemctl status lg-hub
sudo systemctl enable lg-hub     # start at boot
```

### Logs

The service logs to stdout and stderr, so everything lands in the journal.

```bash
journalctl -u lg-hub -n 100 --no-pager     # last 100 lines
journalctl -u lg-hub -f                    # follow
journalctl -u lg-hub --since "1 hour ago"
journalctl -u lg-hub -p err --no-pager     # errors only
```

### What a healthy start looks like

```
lg-hub serving on http://$HUB_IP:8369
web UI: http://$HUB_IP:8369/  (paste a token to connect)
```

`systemctl status lg-hub` shows `active (running)`, and:

```bash
ss -tln | grep 8369
# LISTEN 0 511 $HUB_IP:8369 0.0.0.0:*
```

The listener must be on `$HUB_IP`. Anything on `0.0.0.0:8369` means the
unit's `--host` is wrong and the hub is answering on the public interface — stop
the service and fix the unit before doing anything else.

Reachability, from the host itself or any mesh peer:

```bash
curl -s http://$HUB_IP:8369/v1/health
# {"ok":true,"version":"0.1.0"}
```

Use `/v1/health`, not `/healthz`. `/healthz` does not exist as an API route, and
because the web UI is served for any non-`/v1` GET, requesting it returns HTTP
200 with an HTML page. A `/healthz` check that only looks at the status code
passes even when the API is broken.

### What a bind failure looks like

**Refused bind (no transport flag).** `lg-hub serve` refuses any non-loopback
host unless `--behind-tls-proxy` is passed. If that flag is missing from the
unit:

```
refusing to bind $HUB_IP: a bearer token over plaintext non-loopback HTTP
would expose the hub's credentials. Pass --behind-tls-proxy if a trusted TLS
proxy terminates the connection in front of this address.
```

The process exits 1 and systemd reports `status=1/FAILURE`. Fix: restore the flag
in the unit. There is no TLS proxy in this deployment and none is expected — the
flag is passed because the bind is on a WireGuard mesh address unreachable from
the public internet, and it changes exactly one thing, the startup bind check. It
affects no request-time behaviour: the server derives no identity, address or
scheme from request headers. If NetBird is ever removed, or this service is ever
rebound to a routable address, that reasoning is void and the flag must be
removed.

**Port already in use.**

```
lg-hub fatal: listen EADDRINUSE: address already in use $HUB_IP:8369
```

Exit code 2. Find the holder with `sudo ss -tlnp | grep 8369` — usually a previous
instance that systemd did not reap, or a hand-started `lg-hub serve`.

**Invalid port.** `invalid --port: <value>`, exit 1.

**`wt0` not up yet.** This does *not* produce a bind failure. The host has
`net.ipv4.ip_nonlocal_bind=1`, so the socket binds to `$HUB_IP` even
before NetBird assigns it. The service starts clean and looks healthy; it is
simply unreachable until the mesh is up. See "wt0 down at boot" below.

## Membership

Every member needs **two independent grants**, and neither is useful alone. A
token without mesh access cannot reach the port; mesh access without a token
gets a 401.

| Layer | Grants | Tool |
| --- | --- | --- |
| Network | Their peer may send packets to `$HUB_IP:8369` | `deploy/enroll-member.sh` (operator machine) |
| Identity | The hub accepts and answers their requests | `lg-hub member add` (hub host) |

Do the network half **first**. A token that exists before its owner can reach
the hub is a credential sitting in a chat window waiting for a network change to
make it live.

### 1. Add the NetBird peer

For a colleague with no peer yet, mint a one-off setup key that auto-joins the
members group. Dry-run first — every write in these scripts is opt-in:

```bash
deploy/enroll-member.sh --new hoang.luong            # dry-run, prints the API call
deploy/enroll-member.sh --new hoang.luong --apply    # creates it, prints the key ONCE
```

The key is single-use and expires in 24h (`LOOMGRAPH_SETUP_KEY_EXPIRY`). Its
`auto_groups` puts the peer into `loomgraph-members` at join time, so there is no
window in which a peer is on the mesh but ungrouped, and no second step to
forget.

For someone already on the mesh, add their existing peer instead:

```bash
deploy/enroll-member.sh --peer hoangs-mbp --apply    # by name, hostname, mesh IP or id
```

Check who is in the group at any time:

```bash
deploy/enroll-member.sh --list
```

An empty group right after issuing a setup key is normal — `auto_groups` applies
when the peer actually connects, not when the key is created.

### 2. Add the hub member

Do this only after the peer exists and is in the `loomgraph-members` group.

```bash
sudo -u lghub lg-hub member add alice --data-dir /var/lib/lghub
# lgt_1a2b3c4d.<secret>
# The token above is shown once and cannot be recovered. Store it somewhere safe.
```

Default scopes are `ingest,read`. Override with `--scopes`:

```bash
sudo -u lghub lg-hub member add alice --scopes ingest,read --data-dir /var/lib/lghub
```

The scopes that exist and what each permits:

| Scope | Grants |
| --- | --- |
| `ingest` | `POST /v1/events` — push runs |
| `read` | `GET /v1/feed`, `GET /v1/runs`, `GET /v1/runs/<member>/<runId>` — read every member's runs |
| `admin` | `GET/POST /v1/members`, `POST /v1/members/<keyId>/revoke` — list members, **mint new member tokens over HTTP**, revoke |

Grant `admin` to a person, not to a workstation, and only when you mean it: an
`admin` token can mint further tokens over the API without touching this host.

The printed token goes to stdout; the warning goes to stderr. Deliver the token
out-of-band, over a channel where the value can be destroyed afterwards — never
chat, email, a ticket, or a shared document. The store keeps only a SHA-256 hash
of the secret, so a lost token cannot be recovered, only revoked and reissued.

Tell the recipient two things when you hand it over:

- `lg enroll <url> <token>` puts the token in argv, so it lands in their shell
  history and process list. The alternative is the `LOOMGRAPH_HUB_URL` and
  `LOOMGRAPH_HUB_TOKEN` environment variables, which `lg` reads in preference to
  the config file — both must be set or neither is used.
- Pasting the token into the web UI stores it in that browser's `localStorage`, in
  clear, on a plain `http://` origin.

### 3. Hand it over

Send all four together:

1. [member-quickstart.md](./member-quickstart.md) — every command they run, in
   order, with troubleshooting
2. [hub-onboarding.md](./hub-onboarding.md) — what syncing actually shares.
   Point at this one explicitly: it gates step 5 of the quickstart, and it is
   the only irreversible decision in the process
3. The setup key — single use, 24h
4. The hub token — printed once

Their own command sequence is also printed by `enroll-member.sh --apply`. The step
that reliably goes wrong is `netbird up`: it silently ignores its flags when the
client is already connected, printing "Already connected" and dropping them.
`netbird down` first. There is no `netbird set`.

### 4. Verify, from their machine

```bash
deploy/enroll-member.sh --list                  # operator: their peer appears
deploy/netbird-acl.sh --verify --from-member    # THEIR machine
```

`--from-member` is the only way to prove the negative criteria — that a member
reaches the hub on tcp/8369 and nothing else, including the operator MacBooks. It
proves nothing from the operator machine, which is in `personal macbooks` and is
supposed to reach everything.

### List members

```bash
sudo -u lghub lg-hub member ls --data-dir /var/lib/lghub
# 1a2b3c4d	alice
# 5e6f7a8b	bob	revoked
```

Columns are tab-separated: key id, member name, and the literal `revoked` when the
token has been revoked. Revoked rows are never removed — the roster is a history,
not a current-state list.

### Revoke a member

```bash
sudo -u lghub lg-hub member revoke 1a2b3c4d --data-dir /var/lib/lghub
# revoked 1a2b3c4d
```

Exit 1 with `no active member with key id <keyId>` if the key id is unknown or
already revoked. Revocation takes effect on the next request — every request
re-resolves the token against the members table, and there is no session cache or
token TTL to wait out. A revoked token is refused with 401 immediately, and its
syncs stop.

Revocation is the immediate response to any suspected token exposure. It costs
nothing: issue a new token and the member re-runs `lg enroll`.

### Offboarding checklist

A person leaving needs **both** halves removed. Revoking the hub token leaves them
on the mesh; removing the NetBird peer leaves a valid token that works again the
moment they get back on the mesh by any other route. Do both, in this order, and
record the date.

1. **Revoke the hub token.**
   `sudo -u lghub lg-hub member revoke <keyId> --data-dir /var/lib/lghub`
2. **Confirm the revocation landed.**
   `sudo -u lghub lg-hub member ls --data-dir /var/lib/lghub` — the row must show
   `revoked`.
3. **Revoke every other token that person holds.** Check `member ls` for more than
   one row with their name — a second machine means a second key id.
4. **Delete their NetBird peer** in the NetBird console (or via the API), and
   remove it from the `loomgraph-members` group. Deleting the peer is the
   authoritative step; group removal alone leaves a peer that a later policy
   change could re-admit.
5. **Expire or delete any unused setup key** that was issued for them.
6. **Verify they are gone from the mesh:** the peer no longer appears in
   `netbird status --detail` output from the operator machine, and a probe of
   `$HUB_IP:8369` from their machine fails at the network layer.
7. **Leave their data alone.** Events they pushed stay in the store. The events
   table is append-only, enforced by database triggers that abort any UPDATE or
   DELETE. There is no supported way to remove a member's history in phase 1, and
   attempting it breaks the hash chain. Say this out loud during offboarding so
   nobody is surprised later.

## Audit and export

Export is lossless: the stored line is the line the client sent, byte for byte,
never re-encoded. This was verified end to end against a live hub.

```bash
# every stored line to stdout, one per line, for grepping
sudo -u lghub lg-hub export --jsonl --data-dir /var/lib/lghub > /tmp/all-events.jsonl

# one file per run: <dir>/runs/<member>/<runId>/events.jsonl
sudo -u lghub lg-hub export --out /tmp/hub-export --data-dir /var/lib/lghub
```

Exactly one of `--jsonl` and `--out` is required; passing both or neither exits 1
with `export requires exactly one of --jsonl or --out`.

Which to use: `--jsonl` is a flat stream with nothing added, so member and run
identity are not representable in it — use it to grep for content. `--out` carries
identity structurally in the path, which is why it needs no envelope — use it when
you care about who ran what.

Examples:

```bash
# every failed node across every member
sudo -u lghub lg-hub export --jsonl --data-dir /var/lib/lghub | grep '"kind":"node_failed"'

# what one member ran
sudo -u lghub lg-hub export --out /tmp/hub-export --data-dir /var/lib/lghub
ls /tmp/hub-export/runs/alice/
```

### What is actually in those lines

Treat an export as sensitive material, not as a log file. The event lines are
stored exactly as the client sent them — the masking, path rewriting and
200-character cap that members may have been told about apply **only** to the
separate run-state projection, never to the event stream. Concretely, the lines
contain:

- `run_started.data.cwd` — the member's absolute repository path, un-rewritten,
  including their username and home directory layout.
- `node_finished.data.error` and `run_finished.data.error` — the raw error: no
  masking, no path rewriting, no length cap. When a `claude` node fails with
  `is_error`, this is the agent's entire result text; on a non-zero exit, both the
  `claude` and `codex` adapters append the process's full stderr.
- `human_requested.data.question` — the question *after* template interpolation, so
  any `{{vars.*}}` or `{{nodes.*.output}}` values are substituted into it.
- `human_resolved.data.answer` — whatever the reviewer typed.

Write exports somewhere only you can read, and delete them when you are done:

```bash
rm -rf /tmp/hub-export /tmp/all-events.jsonl
```

### Every read-scoped member already sees all of this

There is no per-member filtering on any read route. A token with the `read` scope
lists every member's runs and fetches any member's events by naming that member in
the URL. The export gives you nothing the team cannot already read; its value is
that it is greppable and offline, not that it is privileged.

### When a member reports a leaked secret

The events table carries triggers that abort every UPDATE and DELETE. **There is
no supported way to remove a line from the store.** Deleting one would break the
hash chain even if you dismantled the triggers by hand, which would destroy the
one mechanism that tells you later whether the store was altered.

So the response is rotation, not redaction:

1. **Rotate the leaked credential itself**, immediately. This is the only step that
   actually reduces exposure.
2. Find the blast radius so the rotation is complete:
   `sudo -u lghub lg-hub export --jsonl --data-dir /var/lib/lghub | grep -c '<fragment>'`
   — and note which members and runs it appears in with `--out`.
3. Tell the team the value is in the store, is readable by every member, and is
   permanent. They need to know it was not quietly cleaned up.
4. Record it. The hub's value is that its history is intact and known; a leak that
   is documented is survivable, one that is silently assumed-deleted is not.
5. Fix the source — the script, test, or prompt that printed the secret into a
   failing node's output.

Do not offer to "remove it from the database". You cannot, and saying you will
leaves the team with a false belief about where their secret is.

## The hash chain

Every event row carries `prev_hash` and `row_hash`, where
`row_hash = sha256(prev_hash ‖ json)` and `json` is the client's line verbatim.
The chain starts at 32 zero bytes and its current end is stored in the
`chain_head` table (single row, `id = 1`). Rows are chained in insertion order,
which is `rowid` order.

This is what makes a partial or torn restore detectable. Verifying it is a step in
both the backup and the restore procedure, and it is not optional.

**There is no `lg-hub` subcommand that verifies the chain.** Use the script below.
Install it once on the host:

```bash
sudo tee /usr/local/sbin/lg-hub-verify-chain.mjs >/dev/null <<'NODE_EOF'
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

const dbPath = process.argv[2];
if (dbPath === undefined) {
  console.error("usage: node lg-hub-verify-chain.mjs <path-to-hub.db>");
  process.exit(2);
}

const GENESIS = Buffer.alloc(32);
const db = new DatabaseSync(dbPath);

let prev = GENESIS;
let count = 0;
let failed = false;

for (const row of db
  .prepare("SELECT rowid AS rid, prev_hash, row_hash, json FROM events ORDER BY rowid")
  .iterate()) {
  const storedPrev = row.prev_hash === null ? GENESIS : Buffer.from(row.prev_hash);
  if (!storedPrev.equals(prev)) {
    console.error(`BROKEN LINK at rowid ${row.rid}`);
    console.error(`  expected prev_hash ${prev.toString("hex")}`);
    console.error(`  stored   prev_hash ${storedPrev.toString("hex")}`);
    failed = true;
    break;
  }
  const expected = createHash("sha256").update(prev).update(row.json, "utf8").digest();
  const stored = Buffer.from(row.row_hash);
  if (!expected.equals(stored)) {
    console.error(`CONTENT MISMATCH at rowid ${row.rid}`);
    console.error(`  expected row_hash ${expected.toString("hex")}`);
    console.error(`  stored   row_hash ${stored.toString("hex")}`);
    failed = true;
    break;
  }
  prev = expected;
  count += 1;
}

if (!failed) {
  const head = db.prepare("SELECT head FROM chain_head WHERE id=1").get();
  if (head === undefined) {
    console.error("NO CHAIN HEAD: chain_head has no row with id=1");
    failed = true;
  } else {
    const storedHead = Buffer.from(head.head);
    if (!storedHead.equals(prev)) {
      console.error("HEAD MISMATCH: last row_hash is not the stored chain head");
      console.error(`  computed ${prev.toString("hex")}`);
      console.error(`  stored   ${storedHead.toString("hex")}`);
      failed = true;
    }
  }
}

db.close();

if (failed) {
  console.error(`chain verification FAILED after ${count} verified events`);
  process.exit(1);
}
console.log(`chain OK: ${count} events, head ${prev.toString("hex")}`);
NODE_EOF
sudo chmod 0755 /usr/local/sbin/lg-hub-verify-chain.mjs
```

Run it against a **snapshot**, never the live database — the live head moves while
you read, which produces a spurious HEAD MISMATCH:

```bash
sudo -u lghub node --no-warnings /usr/local/sbin/lg-hub-verify-chain.mjs \
  /var/backups/lghub/hub-20260921T030000Z.db
# chain OK: 41207 events, head 9f2c...
```

Exit codes: `0` chain verifies, `1` chain does not verify, `2` usage error.

There are three distinct failures, and they mean different things:

| Output | Meaning |
| --- | --- |
| `BROKEN LINK at rowid N` | Rows are missing from the middle, or were reordered. The file is not a faithful copy. |
| `CONTENT MISMATCH at rowid N` | A stored line or its hash was altered. Corruption or tampering. |
| `HEAD MISMATCH` | Every row links correctly, but the tail is short of the recorded head — rows are missing from the end. Typical of a snapshot taken mid-write, or a truncated copy. |

## Backup

### The WAL constraint — read before writing any backup script

`hub.db` runs `PRAGMA journal_mode=WAL`, so committed data can live in
`hub.db-wal` rather than in `hub.db` itself. **`cp hub.db backup.db` produces a
file that is missing recent commits and may be internally inconsistent.** Copying
all three files with `cp` is no better: they are copied at different instants and
the set will not agree.

Take backups with `VACUUM INTO`, which writes a fully-checkpointed, consistent,
single-file copy from a live database without stopping the service.

### Taking a backup

```bash
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
sudo install -d -o lghub -g lghub -m 0750 /var/backups/lghub
sudo -u lghub sqlite3 /var/lib/lghub/hub.db \
  "VACUUM INTO '/var/backups/lghub/hub-${STAMP}.db'"
```

Install the CLI if it is missing: `sudo apt-get install -y sqlite3`. If you cannot
install it, node does the same thing — `node:sqlite` is built in:

```bash
sudo -u lghub node --no-warnings -e \
  'const {DatabaseSync}=require("node:sqlite");
   const db=new DatabaseSync(process.argv[1]);
   db.exec("VACUUM INTO \x27"+process.argv[2]+"\x27");
   db.close();' \
  /var/lib/lghub/hub.db "/var/backups/lghub/hub-${STAMP}.db"
```

(The destination path is interpolated into SQL, so keep backup paths free of
quote characters. The `sqlite3` form above is the preferred one.)

### Verifying a backup — a backup you have not verified is not a backup

Three checks, in this order. All three must pass.

```bash
B=/var/backups/lghub/hub-${STAMP}.db

# 1. the file opens and its pages are structurally sound
sudo -u lghub sqlite3 "$B" "PRAGMA integrity_check;"     # must print: ok

# 2. it is the schema version this hub expects
sudo -u lghub sqlite3 "$B" "PRAGMA user_version;"        # must print: 1

# 3. the hash chain is continuous end to end
sudo -u lghub node --no-warnings /usr/local/sbin/lg-hub-verify-chain.mjs "$B"
```

A backup that fails any of the three is deleted, and the backup is retaken. If it
fails twice in a row, treat it as an incident: stop and run the same three checks
against a fresh snapshot of the live database.

Prove the verification actually works, once, when you set this up: copy a good
backup, truncate the copy (`truncate -s -4096 /tmp/broken.db`), and confirm the
chain script exits non-zero on it. A verification step nobody has seen fail is a
verification step nobody should trust.

### Schedule and retention

- **Daily**, off-peak, via a systemd timer or cron running as `lghub`.
- **Destination** `/var/backups/lghub/`, mode 0750, owned `lghub:lghub`. These
  files are plaintext copies of the entire store — same sensitivity as `hub.db`
  itself.
- **Retention**: keep 14 daily copies, plus one monthly copy for 12 months. Prune
  the rest. With one hub and a 48 GB disk this is cheap; see "Disk growth".
- **Off-host copy**: at least one verified copy must live somewhere other than
  this VPS, or a lost VPS is a lost history. The copy is unencrypted — encrypt it
  in transit and at rest wherever it lands.

```bash
# prune everything but the 14 newest
ls -1t /var/backups/lghub/hub-*.db | tail -n +15 | xargs -r sudo rm --
```

## Restore

This is the procedure the runbook exists for. Read it through before starting.

You need: a backup file that passes all three verification checks, root on the
host, and a maintenance window — syncs fail while the service is down, which does
not affect anyone's runs.

### 1. Pick and verify the backup *before* touching the live database

```bash
B=/var/backups/lghub/hub-20260921T030000Z.db
sudo -u lghub sqlite3 "$B" "PRAGMA integrity_check;"     # ok
sudo -u lghub sqlite3 "$B" "PRAGMA user_version;"        # 1
sudo -u lghub node --no-warnings /usr/local/sbin/lg-hub-verify-chain.mjs "$B"
```

If any check fails, stop and pick an older backup. Never restore an unverified
file over a live one.

### 2. Stop the service

```bash
sudo systemctl stop lg-hub
systemctl is-active lg-hub      # inactive
sudo ss -tlnp | grep 8369       # nothing
```

The process must be gone, not just idle. A live writer during a restore produces
exactly the silent corruption this procedure exists to avoid.

### 3. Move the current database aside — do not delete it

```bash
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
sudo install -d -o lghub -g lghub -m 0750 /var/lib/lghub/preserved
sudo mv /var/lib/lghub/hub.db      /var/lib/lghub/preserved/hub.db.${STAMP}
sudo mv /var/lib/lghub/hub.db-wal  /var/lib/lghub/preserved/hub.db-wal.${STAMP} 2>/dev/null || true
sudo mv /var/lib/lghub/hub.db-shm  /var/lib/lghub/preserved/hub.db-shm.${STAMP} 2>/dev/null || true
```

The `-wal` and `-shm` sidecars **must** be moved out too. A stale WAL left beside
a restored database is applied on the next open and will corrupt it.

### 4. Put the backup in place

```bash
sudo cp "$B" /var/lib/lghub/hub.db
sudo chown lghub:lghub /var/lib/lghub/hub.db
sudo chmod 0600 /var/lib/lghub/hub.db
ls -l /var/lib/lghub/
```

There must be no `hub.db-wal` or `hub.db-shm` in the directory at this point. A
`VACUUM INTO` output is a single self-contained file.

### 5. Verify the restored file in place, before starting the service

```bash
sudo -u lghub sqlite3 /var/lib/lghub/hub.db "PRAGMA integrity_check;"   # ok
sudo -u lghub sqlite3 /var/lib/lghub/hub.db "PRAGMA user_version;"      # 1
sudo -u lghub node --no-warnings /usr/local/sbin/lg-hub-verify-chain.mjs \
  /var/lib/lghub/hub.db
# chain OK: <n> events, head <hex>
```

Record the event count and head hex in your incident notes. If the chain does not
verify here, go to "When the chain does not verify" below and do not start the
service.

### 6. Start the service and check it

```bash
sudo systemctl start lg-hub
systemctl status lg-hub
journalctl -u lg-hub -n 20 --no-pager   # expect: lg-hub serving on http://$HUB_IP:8369
ss -tln | grep 8369                     # expect: $HUB_IP:8369
curl -s http://$HUB_IP:8369/v1/health
```

### 7. Verify the data came back

```bash
sudo -u lghub lg-hub member ls --data-dir /var/lib/lghub
sudo -u lghub lg-hub export --jsonl --data-dir /var/lib/lghub | wc -l
```

The roster must list the members you expect, and the line count must match the
event count the chain script reported in step 5. If the roster is empty, you are
almost certainly looking at a different data directory — re-read "The data
directory is not optional on the command line".

### 8. Re-verify the chain once the service has taken traffic

```bash
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
sudo -u lghub sqlite3 /var/lib/lghub/hub.db \
  "VACUUM INTO '/var/backups/lghub/post-restore-${STAMP}.db'"
sudo -u lghub node --no-warnings /usr/local/sbin/lg-hub-verify-chain.mjs \
  /var/backups/lghub/post-restore-${STAMP}.db
```

### 9. Tell the members

Anything pushed after the backup was taken is gone from the hub but still exists
on each member's machine. Ask every member to run `lg sync --all` in each opted-in
repository. Re-pushing is safe and idempotent: the hub deduplicates by
`(member, streamId, runId, seq)` and stores a given line once. Their local
`.loomgraph/sync/<runId>.cursor` may claim a higher acked sequence than the hub
now holds; deleting that file makes `lg sync` resend the run from the start, which
is the correct recovery.

Member tokens survive a restore — they are rows in the restored database. If you
restored to a database from *before* a member was added, that member's token is no
longer known to the hub and they will get 401. Add them again, which mints a new
token, and deliver it out-of-band.

### 10. Clean up

Once the hub has been healthy for a day, remove `/var/lib/lghub/preserved/`. Not
before — the preserved copy is your only path back if the restore turns out to be
the wrong choice.

### When the chain does not verify

Do not start the service, and do not attempt to repair the file. The events table
carries triggers that abort every UPDATE and DELETE, so in-place repair is not
possible by design, and there is no repair tool.

Work through these in order.

1. **`HEAD MISMATCH` only, every row links.** The copy is internally consistent
   but its tail is short of the recorded head — rows are missing from the end. The
   data present is trustworthy and the loss is bounded to the end of the stream.
   Prefer an older backup that verifies cleanly. If this is the only copy you
   have, it is usable: the missing tail is recoverable because members hold the
   authoritative event logs locally, and step 9's `lg sync --all` re-pushes it.
   Record explicitly in your notes that you accepted a head mismatch, what the
   computed and stored heads were, and when.
2. **`BROKEN LINK` or `CONTENT MISMATCH`.** The file is corrupt or has been
   altered. Discard it. Move to the next-older backup and start again at step 1.
   Do not put a file in this state into service — the chain is the only mechanism
   that would tell you later that something was wrong.
3. **No backup verifies.** Check the live database you preserved in step 3: it may
   still be intact and the restore may not have been necessary.
   `sudo -u lghub sqlite3 /var/lib/lghub/preserved/hub.db.<stamp> "PRAGMA integrity_check;"`
   then run the chain script on it. If it verifies, put it back using steps 4 to 8.
4. **Nothing verifies anywhere — start clean.** Accept that the hub's history is
   gone and rebuild it from the members, who hold every event locally:

   ```bash
   sudo systemctl stop lg-hub
   sudo mv /var/lib/lghub/hub.db \
     /var/lib/lghub/preserved/hub.db.corrupt.$(date -u +%Y%m%dT%H%M%SZ)
   sudo rm -f /var/lib/lghub/hub.db-wal /var/lib/lghub/hub.db-shm
   sudo -u lghub lg-hub init --data-dir /var/lib/lghub
   sudo systemctl start lg-hub
   ```

   A fresh database has **no members**. Every token ever issued is now invalid. You
   must re-add every member (`lg-hub member add`) and redeliver every token
   out-of-band, and each member must re-run `lg enroll` and then `lg sync --all`.
   Keep the corrupt file — it is evidence, and losing a chain is worth
   understanding.

Whatever the outcome, write down what you did. The chain's value is that a break
is visible; that value is only realised if the break and the response are on
record.

## Disk growth

Events are append-only. Nothing prunes them, and **phase 1 ships no pruning,
retention, or archival command at all**. The database only grows.

Measure it:

```bash
du -sh /var/lib/lghub /var/backups/lghub
ls -l /var/lib/lghub/hub.db
df -h /var/lib

# how many events, and how they arrive over time
sudo -u lghub sqlite3 /var/lib/lghub/hub.db "SELECT count(*) FROM events;"
sudo -u lghub sqlite3 /var/lib/lghub/hub.db \
  "SELECT substr(received_at,1,10) AS day, count(*) FROM events
   GROUP BY day ORDER BY day DESC LIMIT 14;"

# largest contributors
sudo -u lghub sqlite3 /var/lib/lghub/hub.db \
  "SELECT member, count(*) FROM events GROUP BY member ORDER BY 2 DESC;"
```

What to watch:

- **`df -h /var/lib` below 20% free** — act. The disk is 48 GB and event lines are
  small (hundreds of bytes), so a small team will not approach this for a long
  time; a runaway graph emitting events in a loop will.
- **Backups grow with the database.** Fourteen daily copies means roughly fifteen
  times the live size on disk. Count `/var/backups/lghub` when you size headroom.
- **A day an order of magnitude above the trailing average** — look at the
  per-member counts and ask that member what they ran.

If you need space back, the only supported lever in phase 1 is backup retention:
prune older backups, or move them off-host. Deleting events is not supported and
breaks the chain.

## Upgrades

`PRAGMA user_version = 1` is the migration anchor. `HubStore` runs the full schema
only when it opens a database whose `user_version` is `0`; a database already at
`1` is opened as-is and never re-schema'd. A future release that changes the
schema will bump this number, and that bump is how you tell whether an upgrade
touched the database.

The procedure, in order. Do not reorder it.

1. **Back up and verify.** Take a `VACUUM INTO` snapshot and run all three checks
   from "Verifying a backup". Record the current `user_version` and the chain
   head. Do not proceed on an unverified backup.

   ```bash
   sudo -u lghub sqlite3 /var/lib/lghub/hub.db "PRAGMA user_version;"
   ```

2. **Read the release notes** for the version you are moving to. If it changes the
   schema, it says so and gives the new `user_version`.
3. **Stop the service.** `sudo systemctl stop lg-hub`
4. **Upgrade the binary to a pinned version**, never `@latest`:

   ```bash
   sudo npm install -g loomgraph@<exact-version>
   lg-hub --version
   ```

5. **Start the service and verify it.** `sudo systemctl start lg-hub`, then
   `systemctl status lg-hub`, then the journal lines and `ss -tln` from "What a
   healthy start looks like", then `curl -s http://$HUB_IP:8369/v1/health`
   and check the version in the response.
6. **Verify the chain.** Snapshot again with `VACUUM INTO` and run the chain
   script. The event count must be at least what it was before, and the chain must
   verify.

   ```bash
   sudo -u lghub sqlite3 /var/lib/lghub/hub.db "PRAGMA user_version;"
   ```

   If `user_version` changed and the release notes did not say it would, stop:
   restore the pre-upgrade backup and downgrade the binary to the pinned version
   you came from.
7. **Smoke test with a real member.** Have someone run `lg sync <runId>` and
   confirm it returns `synced <runId> (acked seq N)`.

Rolling back is the restore procedure above plus `npm install -g` of the previous
pinned version. Downgrade the binary before restoring the database, so the older
binary never opens a newer schema.

## Failure modes

### Hub down

**What breaks:** nothing on the member side except syncing. Verified end to end
against a live hub: killing the hub mid-run changed neither the run's exit code
nor any node's outcome. Members' agents run on their own machines and never
consult the hub to decide anything.

**What a member sees:** one stderr line per run —
`hub sync unavailable: N batches not pushed (run <runId>)` — and the run finishes
normally. A manual `lg sync` fails with exit 2 and a per-run message.

**Do syncs retry?** No. There is no automatic retry, no queue, and no backoff. A
failed batch is dropped rather than re-buffered, because the events are already
durable in the member's `.loomgraph/runs/<runId>/events.jsonl`. Catch-up is
manual: once the hub is back, members run `lg sync <runId>` or `lg sync --all`,
which re-sends from their local cursor. Re-sending is free — ingest is idempotent
by `(member, streamId, runId, seq)`.

**Operator response:**

```bash
systemctl status lg-hub
journalctl -u lg-hub -n 100 --no-pager
df -h /var/lib                              # rule out a full disk first
sudo ss -tlnp | grep 8369                   # rule out a stale process
sudo systemctl restart lg-hub
curl -s http://$HUB_IP:8369/v1/health
```

Then tell members to run `lg sync --all` in each opted-in repository.

### `wt0` down at boot

`net.ipv4.ip_nonlocal_bind=1` is set on this host, so `lg-hub` binds
`$HUB_IP:8369` successfully even when NetBird has not yet assigned the
address. The service starts clean and the journal shows a normal startup. It is
simply unreachable until the mesh comes up. The unit orders itself after
`netbird.service` and `network-online.target`, which usually makes this invisible,
but ordering is not a guarantee that NetBird has finished negotiating.

**Symptom:** service `active (running)`, `ss -tln` shows the listener, but members
cannot reach it and `curl` from another mesh peer times out.

**Diagnose, on the hub host:**

```bash
systemctl status netbird
ip addr show wt0                                 # must show $HUB_IP
sudo netbird status --detail
curl -s http://$HUB_IP:8369/v1/health     # from the host itself
```

If `curl` on the host succeeds but mesh peers cannot reach it, the hub is fine and
the problem is NetBird or the ACL policy — check that `loomgraph-hub-access`
(`loomgraph-members -> hub`, tcp/8369) is enabled and that the member's peer is in
`loomgraph-members`.

**Fix:** `sudo systemctl restart netbird`, wait for `wt0` to carry the address,
then confirm. Restarting `lg-hub` is not required — the socket is already bound —
but it is harmless.

**Do not** work around this by binding a different address. A bind on a routable
address puts a bearer token on the public internet in plaintext.

### Disk full

SQLite cannot write when the filesystem is full. Ingest fails with
`SQLITE_FULL: database or disk is full`; the ingest transaction rolls back, so
nothing partial is committed and the hash chain is not damaged. Members see their
syncs fail; their local logs are unaffected. Reads may still work.

**Diagnose:**

```bash
df -h /var/lib /var/backups
du -sh /var/lib/lghub /var/backups/lghub
journalctl -u lg-hub -p err -n 50 --no-pager
```

**Recover, in this order:**

1. **Free space from backups first** — they are reproducible, the live database is
   not. Prune old copies or move them off-host:
   `ls -1t /var/backups/lghub/hub-*.db | tail -n +8 | xargs -r sudo rm --`
2. **Clear other consumers** — `sudo journalctl --vacuum-size=200M`, and remove any
   export directories left in `/tmp`.
3. **Do not delete events** to reclaim space. The table is append-only and the
   triggers will refuse; forcing it would break the chain.
4. **Restart the service** once there is headroom, and confirm a member can sync.
5. **Take a fresh backup and verify the chain** — a full disk during a write is
   exactly the condition worth proving you came through cleanly.
6. **Fix the cause.** If growth is organic, grow the volume. If one member's graph
   emitted events in a loop, fix the graph.

## Known gaps in phase 1

State these plainly when someone asks; none of them are bugs, all of them are
scope.

- **No chain-verification subcommand.** `lg-hub` has no `verify`. The script in
  this document is the procedure, and any backup script must implement the same
  check.
- **No backup or restore subcommand.** Backups are `VACUUM INTO`; restore is the
  manual procedure above.
- **No pruning, retention, or archival.** The store only grows.
- **No filtering of the event lines.** Only the run-state projection is masked,
  path-rewritten and capped. The event stream is stored verbatim, and it carries
  raw errors (including agent output and stderr from failed nodes), un-rewritten
  absolute paths, and interpolated variable values inside human-review questions.
  See "What is actually in those lines".
- **No egress masking.** Whatever reaches the hub is served back as stored.
- **No per-member read filtering.** Any `read` token sees every member's runs and
  events.
- **No encryption at rest.** `hub.db` and every backup are plaintext SQLite.
- **No deletion of anything.** The events table is append-only, enforced by
  triggers. A leaked secret is permanent; rotate it.
- **The per-repo opt-in does not gate manual syncs.** `.loomgraph/hub.json`
  (`lg sync --enable`) is checked only by the live batcher during `lg run`.
  `lg sync <runId>` and `lg sync --all` push regardless. Say this when you explain
  the opt-in to a member, or they will over-trust it.
- **A web UI ships and is on by default.** `lg-hub serve` serves a self-contained
  HTML page for any non-`/v1` GET, on the same origin as the API; `--no-ui`
  disables it and serves the JSON API only. The README's roadmap still lists a UI
  as phase 4 — the code is ahead of that text. The page has no login of its own: a
  member pastes a token, which the browser keeps in `localStorage` in clear on a
  plain `http://` origin. It grants no API access a token holder did not already
  have, but it does create a second place tokens come to rest. Consider `--no-ui`
  if nobody uses it.
