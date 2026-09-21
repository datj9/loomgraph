# Member quickstart — join the mesh, join the hub

For a new member. Start to finish in about fifteen minutes, most of it waiting
for installers.

Read [hub-onboarding.md](./hub-onboarding.md) **before step 5**. This page tells
you which commands to run; that one tells you what you are agreeing to share, and
it is the part you cannot undo.

## What you are joining

Two separate systems, and you need both.

| | What it is | What it gives you |
| --- | --- | --- |
| **NetBird** | A WireGuard mesh VPN | A private address that can reach the hub. Nothing else on the mesh. |
| **loomgraph hub** | An HTTP API over SQLite | Somewhere to push your run telemetry so the team can see it |

The hub is not on the public internet. There is no URL you can open from a café
without the mesh — that is deliberate, and it is what protects your token.

**The hub never runs an agent.** `lg run` starts `claude`, `codex` or `opencode`
on *your* laptop, as *you*, under your own subscription. Nobody shares an
account, no token or session of yours is copied anywhere, and if the hub is down
your runs are unaffected — only the sync fails.

## What your operator gives you

Three things. Ask for all three before you start; two of them can only be issued
once.

| | Looks like | Notes |
| --- | --- | --- |
| Management URL | `https://netbird.example.com` | NetBird control plane |
| Setup key | `A1B2C3D4-...` | **Single use, expires in 24h.** Not recoverable. |
| Hub token | `lgt_1a2b3c4d.<secret>` | **Printed once.** Not recoverable. |
| Hub address | `http://100.x.y.z:8369` | A mesh address; useless off the mesh |

Delete the setup key and the token from wherever they were sent to you as soon
as you have finished step 4.

## 1. Install NetBird

<https://docs.netbird.io/how-to/installation> — packages for macOS, Linux,
Windows, iOS and Android.

## 2. Join the mesh

```bash
netbird down
netbird up --setup-key <SETUP-KEY> --management-url <MANAGEMENT-URL>
```

`netbird down` first is not optional. **`netbird up` silently ignores its flags
when the client is already connected** — it prints `Already connected`, drops
your setup key and management URL, and leaves you attached to whatever it was
using before. There is no `netbird set`.

Check it worked:

```bash
netbird status --detail | grep -E "Management|Signal|Peers count"
```

You should see your own mesh IP and a peer count above zero.

## 3. Confirm you can reach the hub

```bash
curl -s http://<HUB-ADDRESS>/v1/health
# {"ok":true,"version":"0.1.0"}
```

That exact body is the test. A 200 alone proves nothing — see
[Troubleshooting](#troubleshooting).

You are expected to reach this one address on this one port and **nothing else**
on the mesh. That is not a restriction aimed at you; it is what lets the team run
a shared hub on a network that also has people's laptops on it.

## 4. Install loomgraph and enroll

loomgraph is not on npm. Build it from the repo:

```bash
git clone <REPO-URL> && cd loomgraph
npm install && npm run build
npm link
```

Then store your identity:

```bash
lg enroll http://<HUB-ADDRESS> <YOUR-HUB-TOKEN>
```

That writes `~/.config/loomgraph/hub.json`, mode 0600.

**Your token goes into your shell history this way.** If you would rather it did
not, skip `lg enroll` and export both of these instead — `lg` prefers them over
the config file, and both must be set or neither is used:

```bash
export LOOMGRAPH_HUB_URL=http://<HUB-ADDRESS>
export LOOMGRAPH_HUB_TOKEN=<YOUR-HUB-TOKEN>
```

Either way, put the token in your OS keychain as the master copy — macOS
Keychain, `secret-tool` on Linux. Not a dotfile you back up, not a note app, not
a shared drive.

**Possession equals identity.** Anyone holding that string *is* you to the hub.
There is no second factor and no device binding. If you think anyone else has
seen it, say so immediately — revocation is instant and costs nothing.

## 5. Read the onboarding doc, then opt in per repository

Stop here and read [hub-onboarding.md](./hub-onboarding.md). It is short, and it
is the only part of this process you cannot reverse.

The short version: **anything that reaches the hub is readable by every member
and can never be deleted.** The events table aborts UPDATE and DELETE by database
trigger. Filtering runs before anything leaves your machine — paths, usernames,
hostnames and known secret shapes are removed, and everything is capped at 200
characters — but it is an allowlist of shapes someone thought of, not a proof.
Your organisation's own token format is probably not one of them.

Nothing syncs until you opt in, and you opt in **per repository**:

```bash
cd ~/work/some-repo
lg sync --enable          # writes .loomgraph/hub.json
```

Without that file, `lg sync` refuses and pushes nothing. Enable it only on
repositories where you would be comfortable with the whole team reading your
build's stderr, forever.

## 6. Run something and push it

```bash
lg run examples/hello.yaml     # three shell commands, no model calls, zero cost
lg ls                          # find the run id
lg sync <runId>                # push that one run
lg sync --all                  # or every run in this repo
```

Runs also stream to the hub live as they execute, once the repo is opted in.

## Day-to-day

| Command | What it does |
| --- | --- |
| `lg run <graph.yaml>` | Execute a graph |
| `lg ls` | List your runs |
| `lg status <runId>` | Node and budget status |
| `lg resume <runId>` | Continue from the last checkpoint |
| `lg events <runId>` | The raw local JSONL trail |
| `lg report <runId>` | Self-contained HTML report |
| `lg sync <runId>` / `--all` | Push to the hub |

Your local `.loomgraph/runs/<runId>/events.jsonl` keeps **raw** values — that is
your debugging record, and it is never rewritten. Only the copy crossing to the
hub is filtered.

## Troubleshooting

**`curl` to the hub hangs or refuses.** Check `netbird status` first. If the
client is connected but the hub is unreachable, your peer may not be in the
members group yet — ask your operator to run `deploy/enroll-member.sh --list`.

**A 200 from the hub that is not JSON.** If the hub is running its web UI, any
non-`/v1` path returns HTML with a 200. `/healthz` looks healthy even when the
API is dead. Always probe `/v1/health` and read the body.

**`nc -z <peer> 22` says the port is closed, but `ssh` works.** Expected. NetBird
clients run their SSH server in userspace netstack, so it is not a host socket
and a raw port probe cannot see it. Test with the real client, not a probe.

**`dig` says `.netbird.selfhosted` does not resolve.** On macOS `dig` bypasses
scoped resolvers. Use `dscacheutil -q host -a name <name>` instead.

**`lg sync` says the repo is not enabled.** You have not run `lg sync --enable`
in *that* repository. It is per repo, deliberately.

**`lg sync` says the hub is not configured.** `lg enroll` has not run, or your
two environment variables are half-set — both `LOOMGRAPH_HUB_URL` and
`LOOMGRAPH_HUB_TOKEN`, or neither.

**401 from the hub.** Your token has been revoked, or you pasted it wrong. There
is no session cache to wait out; every request re-resolves the token.

## Verify the network boundary yourself

Once you are on the mesh, from *your* machine:

```bash
deploy/netbird-acl.sh --verify --from-member
```

This checks the part nobody else can: that your peer reaches the hub on its one
port and is blocked from everything else, including the operator's laptops. If
anything there FAILs, tell your operator before you sync anything.
