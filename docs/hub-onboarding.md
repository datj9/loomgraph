# Hub onboarding — read this before you enroll

You are about to join the loomgraph team hub. Read all of it before you run
`lg enroll`.

## The one thing you must understand first

**Anything that reaches the hub is readable by every other member and can never
be deleted.** The events table aborts every UPDATE and DELETE by database
trigger, so a secret that lands there cannot be retracted by any supported
means. Rotating the secret is the remedy; erasing it is not available.

Both things a sync pushes are filtered before they leave your machine — the run
state projection and the event lines alike. That filtering is an **allowlist of
shapes somebody thought of**, not a proof. It reliably removes what it
recognises: absolute paths, your username, your hostname, ANSI escapes, and
secrets matching known patterns, with everything capped at 200 characters. It
cannot recognise a credential format its rules do not describe.

So the question to ask is not "is it masked" but "if the masker missed this,
would I mind the whole team reading it, forever". The rest of this page gives
you what you need to answer that per repository.

## Claude Code still runs on your machine, under your credentials

loomgraph does not run agents. `lg run` starts the CLI you already installed —
`claude`, `codex`, `opencode` — as a child process on your own laptop, signed in
as you.

The hub never starts an agent. It has no code path that could. It stores what
members push and serves reads back out of that store. That absence is the design,
not a missing feature: a daemon that can only store and route is a store, not a
scheduler.

Consequences worth being explicit about:

- Nobody shares an account. You use your own Claude Code subscription or API key.
- Nobody's token or session is copied to the hub or to another member.
- If the hub is down, your runs are unaffected. A dead hub changes neither a run's
  exit code nor any node's outcome. Only the sync fails.

## Where the hub lives

One VPS on the team's WireGuard mesh, on port `8369`. It is reachable only over
that mesh — there is no public route to the port. You will be given a peer that
can reach exactly this one address and port, and nothing else on the mesh.

Your operator gives you the address; this page writes it as `$HUB_IP`. Set it
once and the commands below paste as written:

```bash
export HUB_IP=<the address your operator gave you>
```

The hub is one SQLite database behind an HTTP API. That is the whole thing.

## What a sync actually pushes

Two things, filtered by the same rules but assembled differently.

| | What it is | Filtered? |
| --- | --- | --- |
| **The projection** | A summary of run state, assembled field by field | **Yes** — hand-written allowlist of fields |
| **The event lines** | Your run's JSONL, rebuilt field by field against a per-kind allowlist | **Yes** — same strip/rewrite/mask/cap on every text field |

Your local `.loomgraph/runs/<runId>/events.jsonl` keeps its **raw** values — that
is your debugging record and it is never rewritten. The filtering happens at push
time, on the copy that crosses to the hub.

### The projection

Built field by field, so there is no field a variable value or a node's output
could ride in on:

- `vars` appear as key names only, never values.
- Node output is absent — there is no field for it.
- Node errors are control-stripped, path-rewritten (`/Users/you/work/repo/run.sh`
  becomes `${REPO_ROOT}/run.sh`, and your username and hostname likewise), have
  known secret shapes cut to their first four characters, and are capped at 200
  characters.

### The event lines

Each line is rebuilt against a list naming, per event kind, exactly which `data`
fields may be published. A field not on the list is dropped. A line whose kind
the list does not know is dropped whole, rather than passed through.

Fields carrying operator or environment text go through the same
strip → rewrite → mask → cap the projection applies:

| Event | Field | Treatment |
| --- | --- | --- |
| `run_started` | `data.cwd` | Path-rewritten: your home directory and username are replaced |
| `node_finished` | `data.error` | Stripped, path-rewritten, masked, capped at 200 characters |
| `run_finished` | `data.error` | Same |
| `human_requested` | `data.question` | Interpolated first (see below), then sanitised |
| `human_resolved` | `data.answer` | Whatever the reviewer typed, sanitised |

Everything else in an event — node ids, statuses, attempt counts, costs, budget
numbers, edge names — is published as-is. Those are engine- and graph-derived
identifiers, the same class of fact the projection already publishes.

### Why "node output never reaches the hub" needs a footnote

For a node that **succeeds**, it holds outright: no event carries the output
text, and the projection has no field for it.

For a node that **fails**, the adapters fold output into the error string:

- **claude**: when the CLI reports `is_error`, the error becomes
  `claude run reported is_error (<subtype>): <the agent's entire result text>`.
- **claude and codex**: on a non-zero exit, the process's full trimmed **stderr**
  is appended to the error.
- **command / verifier nodes**: an unmet `expect` puts the expected string into
  the error.

That error is sanitised and capped at 200 characters before it is pushed, in both
channels. But "sanitised" means the masker's rules ran — not that the first 200
characters of your agent's failure output are safe to share by construction.
Assume a teammate will read them.

### Variable values have one door

A `human` node's question is a template resolved exactly like an agent prompt. A
question written as `Approve deploy with token {{vars.api_key}}?` is interpolated
*before* the `human_requested` event is written, so the value is in the text that
gets sanitised. If the value matches a known secret shape it is masked. If it does
not — an internal token format, a customer identifier, a connection string the
rules do not describe — it publishes. Do not interpolate a secret into a question.

### Masking is an allowlist, not a proof

The rules recognise the shapes they describe and nothing else. During development
a canary shaped `AKIA` plus 18 more characters passed through unmasked, because
the rule matches exactly 20 characters (`\bAKIA[0-9A-Z]{16}\b`). The canary was
malformed rather than the rule being wrong — which is the point: the rules are a
filter for shapes someone thought of, and your organisation's own token format is
probably not one of them.

### Every member reads everything

There is no per-member filtering on reads. Any token with the `read` scope lists
every member's runs and fetches any member's events by naming that member in the
URL. "Team-readable" means the whole team, not your own runs.

### Nothing is encrypted, and nothing can be deleted

`hub.db` is a plaintext SQLite file on the host's disk. No encryption at rest, no
per-item keys, and no masking on egress — whatever reached the hub is served back
exactly as stored.

The `events` table carries triggers that abort every UPDATE and DELETE. A secret
that lands there cannot be removed without dismantling the store's integrity
guarantee by hand. Treat a leak into the hub as permanent, and rotate the secret
rather than hoping to erase it.

### What this means in practice

Before you enable sync on a repository, ask:

1. If the masker missed something in my build's stderr, would every teammate
   reading it be a problem? That is the actual test — not whether masking exists.
2. Do my scripts, tests, or agent prompts print a token, connection string, or
   customer identifier on failure? Fix that first — it is worth fixing regardless
   of the hub.
3. Are my variable *names* sensitive on their own? Both channels publish names.
4. Do any of my human-review questions interpolate a variable that holds a secret?
   Rewrite the question.

If the answer to any of these is uncomfortable, do not enable sync for that
repository. The decision is yours, and it is per repository.

## Your token is your identity

`lg-hub member add <name>` prints a token like `lgt_1a2b3c4d.<long random string>`.
The hub stores only a SHA-256 hash of the secret half, so:

- It is printed **once**. It cannot be reprinted, recovered, or looked up. Not by
  you, not by the operator, not from the database.
- Possession equals identity. Anyone holding that string *is* you to the hub —
  they can push runs under your name and read everything every member pushed.
  There is no second factor and no device binding.

So:

- **Store it in your OS keychain** (macOS Keychain, `secret-tool` on Linux). Not in
  a dotfile you back up, not in a note app, not in a shared drive.
- **Never put it in chat, email, a ticket, or a screenshot.** It must be delivered
  to you over a channel where the value can be destroyed after use, and you should
  destroy it there once you have enrolled.
- **If you suspect anyone else has seen it, say so immediately.** The operator runs
  `lg-hub member revoke <keyId>` and issues a new one. Revocation takes effect on
  the next request — there is no session cache to wait out.

### Keep the token out of your shell history

`lg enroll <url> <token>` puts the token in the command line, so it lands in
`~/.zsh_history` or `~/.bash_history`, in your shell's process list while it runs,
and in any terminal recording. Prefer the environment variables, which `lg` reads
before it looks at the config file — set both or neither:

```bash
export LOOMGRAPH_HUB_URL=http://$HUB_IP:8369
export LOOMGRAPH_HUB_TOKEN=$(security find-generic-password -s loomgraph-hub -w)   # macOS
```

If you do run `lg enroll` with the token as an argument, prefix the command with a
space if your shell is configured to skip such lines, and scrub the entry
afterwards.

`lg enroll` writes `~/.config/loomgraph/hub.json` with mode 0600. That file is a
credential — treat it like `~/.ssh/id_ed25519`: not in a dotfiles repository, not
synced to a cloud drive, not copied to a second machine (ask for a second token
instead, so the two can be revoked independently).

## Enrolling

Steps 1 to 4 are the operator's; you do 5 and 6.

1. The operator creates a NetBird setup key scoped to the `loomgraph-members`
   group, with a short expiry and single use.
2. You install the NetBird client and join with that key.
3. The operator verifies from their own machine that your peer can reach
   `$HUB_IP:8369` and nothing else on the mesh.
4. The operator runs `lg-hub member add <you>` and delivers the token out-of-band.
5. You configure the identity — either the environment variables above, or:

   ```bash
   lg enroll http://$HUB_IP:8369 lgt_1a2b3c4d.<secret>
   ```

   This writes `~/.config/loomgraph/hub.json` (mode 0600) holding the url and
   token. It is your machine identity, written once for the whole machine — not
   per repository.

6. You opt a repository in, deliberately, one at a time:

   ```bash
   cd ~/work/some-repo
   lg sync --enable
   ```

   This writes `.loomgraph/hub.json` containing exactly `{"sync":true}`. It never
   contains a token. Two files share the name `hub.json` and never share a job: the
   one in your home directory is *who you are*, the one in the repository is *this
   repository consents to be synced*.

### The opt-in only gates the automatic push — read this carefully

`lg sync --enable` controls one thing: whether `lg run` pushes events live while a
run is in progress. In a repository that has not opted in, `lg run` pushes nothing.

**It does not gate a manual sync.** `lg sync <runId>` and `lg sync --all` never
check the opt-in file. If you are enrolled, running `lg sync --all` inside *any*
repository pushes that repository's local runs to the hub, opted in or not.

So the real rule is: **once you are enrolled, do not run `lg sync` in a repository
you have not decided to publish.** The flag protects you from pushing by accident
during a run; it does not protect you from pushing on purpose in the wrong
directory.

## Daily use

```bash
lg run examples/hello.yaml     # runs locally; live-pushes only if this repo is opted in
lg sync <runId>                # push one run explicitly — no opt-in check
lg sync --all                  # push every run under .loomgraph/runs/ — no opt-in check
```

When a repository is opted in, `lg run` pushes events to the hub as the run
proceeds, in batches. If the hub is unreachable you get one line on stderr —
`hub sync unavailable: N batches not pushed (run <runId>)` — and the run continues
and finishes normally. Failed batches are not retried automatically. Your events
are already durable in `.loomgraph/runs/<runId>/events.jsonl`, so once the hub is
back, `lg sync <runId>` pushes what was missed. Re-pushing is safe: the hub
deduplicates by run and sequence number.

`lg sync` exit codes: `0` everything synced, `1` a usage error or the hub is not
configured, `2` at least one run failed to sync.

## There is a web UI, and it is on by default

The hub serves a browser UI on the same origin as the API —
`http://$HUB_IP:8369/`. It has no login of its own: you paste your member
token into it, and it keeps that token in the browser's `localStorage` and sends it
as a bearer header. (Some project documentation still says a UI is a later phase.
That text is out of date; the UI ships.)

What that means for you:

- Pasting your token into the UI stores it, in clear, in the browser profile of
  whatever machine you used. Any other page you open from that origin, and anyone
  with access to that browser profile, can read it. The origin is plain `http://`,
  protected by the WireGuard mesh rather than TLS.
- Prefer a browser profile you control, and use the UI's logout, which clears the
  stored token.
- Do not paste your token into a shared or kiosk machine's browser. If you do,
  treat the token as exposed and ask for it to be revoked.

## loomgraph does not share sessions

To save you asking: there is no way to hand someone your live session.

- No transcript upload. Full transcripts are never published, to the hub or
  anywhere else — a transcript is a credential dump.
- No session transplant. Nothing writes into another person's home directory and no
  adapter resumes someone else's session id.
- No cross-CLI replay.

What you can hand over is understanding, not state: `lg-handoff pack` distills a
session into a brief — goal, files, claims, open questions, the exact commit —
quoting turns verbatim with no model summarising anything, and publishes it behind
a private, expiring link.

If you actually need two people in one live session, the answer is **tmux over mesh
SSH**: one person hosts the session on their machine, the other attaches over the
mesh. loomgraph is not involved and will not be.

## If something goes wrong

| Symptom | What it means | What to do |
| --- | --- | --- |
| `hub not configured - run: lg enroll <url> <token>` | No `~/.config/loomgraph/hub.json` and no `LOOMGRAPH_HUB_URL`/`LOOMGRAPH_HUB_TOKEN` set | Re-run `lg enroll`, or export both variables |
| `nothing to sync - pass a run id, or --all` | You ran `lg sync` with no argument | Pass a run id or `--all` |
| Sync fails with 401 | Token revoked, mistyped, or truncated | Ask the operator whether it was revoked; if not, request a new one |
| Sync fails with 403 | Your token lacks the scope for that call | Ask the operator to re-issue with the right scopes |
| Sync fails with a connection error | Mesh down, or the hub is down | `netbird status`; then tell the operator |
| `lg run` printed `hub sync unavailable` | Hub was unreachable during the run | The run is fine. Re-run `lg sync <runId>` later |
| Nothing syncs during a run and there is no error | The repository is not opted in | `lg sync --enable` — after re-reading "What a sync actually pushes" |
| **You pushed a secret** | It is in the event table, unmasked and undeletable | Tell the operator now, and **rotate the secret**. Do not wait for it to be removed — it cannot be |

Operator-side procedures — backup, restore, revocation, upgrades — are in
[hub-operations.md](./hub-operations.md).
