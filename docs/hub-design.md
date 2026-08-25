# The team hub — design and threat model

Status: **proposal, not built.** Nothing in `src/hub/` exists yet.
Author decisions locked before this document was written are in [§1](#1-what-is-locked).
Open questions for the author: [§14](#14-open-questions-for-the-author).

**Revision 2.** Two questions were put to an adversarial pair of reviews: should the hub
hold a database, and should it hold full conversations? The answers went in opposite
directions and both changed this document. Storage is now SQLite-as-truth
([§6](#6-hub-storage), decision D-3) — revision 1 was wrong, and the specific error is
recorded rather than quietly fixed. Central conversation storage is refused
([§18](#18-decision-record-d-3-and-d-4), decision D-4), on measured evidence from a real
transcript corpus. Three defects the pro-database review found in revision 1's briefs are
fixed: owner-curated brief depth ([§7.2](#72-brief-depth-is-the-owners-choice)),
redaction-on-read ([§7.3](#73-redaction-on-read)), and the admission that this design's
top-ranked threat is uninvestigable with the data it retains
([§9.6](#96-what-this-design-cannot-investigate)). Federated search replaces the central
corpus as the answer to deep search ([§17](#17-federated-search)).

---

## 0. What stops being true

Three sentences the project can say today, and will not be able to say after this ships:

| Today | After the hub |
| --- | --- |
| "Not a workflow server. No daemon, no web UI, no cloud." | There is a daemon and a web UI. |
| "No signal bus, inbox, or daemon… an inbox that starts an agent on someone else's laptop is a different product with a much harder threat model." | This is that product. |
| Content leaves a machine only through a print-once, expiring link a human chose to send. | Content leaves on a schedule, to a box, and stays there. |

That third one is the real change, and the second one is the warning being cashed. The
README already reasoned its way to *not* building this and named exactly why. Building it
is legitimate — it is the author's project and the author's call — but the "much harder
threat model" has to be actually built, not waived by the phrase "approval-gated." Most of
[§9](#9-threat-model) exists because approval-gating answers a question the attack does not ask.

**What does not change:** loomgraph still makes zero model calls, still shells out to the
agent CLI you installed, and **the hub never runs an agent.** It stores and routes. Agents
run on member machines, under the member's own sandbox, started by the member.

---

## 1. What is locked

Decided by the author before design; not relitigated here.

1. **The inbox is approval-gated.** An inbound message never executes anything. It queues.
   A human runs `lg inbox accept <id>` for anything to happen. No auto-dispatch in v1.
2. **The hub ingests run events and distilled extractive briefs only.** No raw transcripts,
   under any flag. `src/handoff/scan.ts` is a hard gate on ingest.
3. **One central hub** on a shared server, per-member bearer tokens, each member's CLI
   talks to it.

Locked decision 3 is the single largest risk multiplier in this design: it converts
per-laptop compromise into team-wide compromise, and creates aggregation leaks no
per-brief scanner can see ([§9.4](#94-what-the-scanner-stops-buying-under-retention)). It stays,
so the rest of the architecture compensates: hold as little as possible, never execute on
the hub, and put the real anti-injection defense on the *consuming* machine.

---

## 2. Shape, in one paragraph

The hub does to the team what `events.jsonl` already does to a run: a server-stamped,
append-only record of what happened, greppable via `lg-hub export --jsonl` and queryable via
SQL. The client's existing event log doubles as the push outbox, so there is no queue and no
spool directory. The existing pure-renderer pattern doubles as the web UI, so there is no
build step and no client JS. `src/handoff/scan.ts` sits in front of everything that ingests
text, and now in front of everything that serves it too ([§7.3](#73-redaction-on-read)).
Only the hub's own storage is a new idiom; the rest is the existing three pointed at a
network.

---

## 3. Component boundaries

**A third binary, `lg-hub`.** Not folded into `lg` — a long-running daemon would poison
`lg`'s "you run it and it exits" contract. Not folded into `lg-handoff` — that subtree's
import purity is load-bearing.

```
src/hub/          the lg-hub bin -> dist/hub/cli.js
  cli.ts          commander wiring; the only argv reader
  server.ts       node:http binding; deliberately dumb (see §12 on testing)
  handlers.ts     (WireRequest, deps) -> WireResponse; where all behavior lives
  auth.ts         token hashing, member resolution, revocation
  storage.ts      HubStore: node:sqlite, WAL, one transaction per batch (§6)
  inbox.ts        message lifecycle transitions
  feed.ts         feed partitioning and cursor logic
  ui/*.ts         pure (data) -> html renderers
src/team/         client side
  transport.ts    the injected Fetch seam (mirrors handoff's Exec seam)
  sync.ts         cursor logic over events.jsonl
  fence.ts        untrusted-content fencing  <- security-critical, see §8.3
src/commands/     new thin files: enroll.ts, sync.ts, inbox.ts, wired into src/cli.ts
```

**Import rule.** `src/hub/` may import `src/core/` and may import `src/handoff/scan.ts`
one-way. `src/handoff/` still imports nothing outward, so AGENTS.md's rule holds as
written. **Do not copy the scanner.** The `buildEnclavePushArgs`-exists-twice precedent is
for a 20-line argv builder; a security gate must never fork. AGENTS.md needs a line saying
which direction the new arrow points.

Note what this costs: `src/handoff/types.ts:1-8` keeps the subtree extractable "once a team
fabric exists outside this repo." The fabric now exists *inside* it, so extraction later
means the hub depends on the extracted sibling. Acceptable, but the comment should be
updated rather than left to quietly become false.

**Exit codes.** `lg`'s team verbs reuse its namespace — sync/inbox failure is `2`, never
`3` or `4`, which stay budget and paused. `lg-hub` gets its own small namespace, per the
`lg-handoff` precedent: `0` clean exit, `1` config or usage, `2` fatal runtime (port bind,
corrupt data dir).

---

## 4. Wire protocol

HTTP/1.1 + JSON on `node:http`. Client uses global `fetch` (Node ≥ 22) behind the seam.
Zero new dependencies. `Authorization: Bearer <token>` on everything except `/v1/health`.

| Endpoint | Method | Notes |
| --- | --- | --- |
| `/v1/health` | GET | unauthenticated; `{ok, version}` |
| `/v1/events` | POST | `{runId, streamId, graphName, state, events[]}`, ordered by `seq` |
| `/v1/briefs` | POST | the four bundle files inline as strings |
| `/v1/feed?after=<cursor>&limit=50` | GET | newest-first page + `nextCursor`; keyset, see [§6.2](#62-pagination-is-keyset-not-byte-offsets) |
| `/v1/runs/:member/:runId` | GET | stored state + events |
| `/v1/inbox` | POST | send; schema in [§8](#8-the-inbox) |
| `/v1/inbox?state=queued` | GET | addressee is always the authenticated member |
| `/v1/inbox/:id/transition` | POST | `{to, runId?}` |
| `/v1/admin/members` | POST | enroll; admin token only |

**Idempotency uses natural keys, not an `Idempotency-Key` header.** Events already carry
`(runId, seq)` from `src/core/events.ts`. The hub keys them `(member, streamId, runId, seq)`
where `member` comes from the token and **never** from the body. A per-run high-water mark
acks-and-drops anything at or below it. Same seq with different content is `409` plus a
visible feed item — silence about divergence is worse than noise. Briefs are keyed by
`sha256(handoff.md)`. Inbox messages carry a client `crypto.randomUUID()`.

**Reserve `streamId` in phase 1 even though nothing reads it yet.** It is a random id
minted at `run_started`. Without it, `(runId, seq)` assumes one machine and one history per
run forever; a wiped `.loomgraph`, a copied repo directory, or any future multi-machine
resume produces same-key-different-content and the 409 policy fires noise exactly when the
user is already confused. Reserving the field now is free. Retrofitting it after real data
exists is not.

**The outbox already exists — do not build one.** `.loomgraph/runs/<id>/events.jsonl` is
append-only and unbuffered by hard rule, which is the definition of a durable outbox. Sync
is a cursor over it:

- `.loomgraph/sync/<runId>.cursor` holds the last acked seq, written temp-then-rename.
- `lg run` / `lg resume` hook the **existing** `onEvent` callback already threaded through
  `EngineDeps` and used in `src/commands/run.ts`. Batch every 10 events or 5 s, 1500 ms
  timeout, and **any failure is one line on stderr and nothing else.** A hub outage cannot
  affect a run, its checkpoints, or its exit code.
- `lg sync [runId]` replays from the cursor. **This is the only path that must be correct.**
  The live push is best-effort sugar over it.

The cursor advances only on a 2xx naming `highWaterSeq`, so a cut connection just resends.

**Ordering is by hub `receivedAt`, never by client `ts`.** Client clocks skew; the feed is
served from the hub's own arrival order. Client timestamps are displayed and labeled as
reported, and no cursor is ever derived from one ([§6.2](#62-pagination-is-keyset-not-byte-offsets)).

---

## 5. Identity and auth

Enrollment is admin-mediated and print-once, matching the enclave share-link aesthetic the
project already lives with:

```
# on the hub host
$ lg-hub member add alice
lgt_a1b2c3d4.<32 bytes base64url>        # printed once, never recoverable

# on alice's machine
$ lg enroll https://hub.internal lgt_a1b2c3d4.xxxx
wrote ~/.config/loomgraph/hub.json (0600)
```

The hub stores only `{member, keyId, tokenHash: sha256(secret), createdAt}`, appended to
`members.jsonl`. `LOOMGRAPH_HUB_URL` / `LOOMGRAPH_HUB_TOKEN` override the file, the same
pattern as `ENCLAVE_TOKEN`.

**Attribution is server-side, always.** Every stored record gets `member` stamped from the
token's keyId. `HandoffMeta.createdBy` — currently `userInfo().username` in
`src/handoff/commands.ts` — is displayed as *"claims created-by"* at most. Never trust a
client-supplied owner field; that is forgery vector A5.

**Revocation** appends `{revoked: keyId, ts}` to `members.jsonl`, replayed at startup and
on SIGHUP. A ten-person member file is trivially small.

**Add a scan rule for the hub token shape before the first token is minted.** This is
non-optional and easy to forget. Members will paste tokens into shells and configs; agents
will read those shells; `lg-handoff pack` will faithfully distil a session quoting one.
The pipeline is *designed* to republish exactly this, and `SCAN_RULES` in
`src/handoff/scan.ts` has no rule for a shape that does not exist yet. Choose the `lgt_`
prefix, add the rule in the same commit.

**Transport.** `lg-hub serve` refuses to bind a non-loopback address unless
`--behind-tls-proxy` is passed, and says why. Deploy behind Caddy, or on a WireGuard or
Tailscale interface. Bearer tokens over plaintext LAN HTTP are precisely the credential
class `scan.ts`'s `auth-header` rule exists to catch; the project should not ship the
vulnerability its own scanner names.

---

## 6. Hub storage

**SQLite (WAL, `node:sqlite`) is the hub's truth. JSONL is a derived export.**

Revision 1 said the opposite, and was wrong in a way worth recording rather than silently
correcting.

### 6.1 Why revision 1 was wrong

Revision 1 did not choose JSONL *over* SQLite. It chose **both**: JSONL as truth, plus a
SQLite index, plus `lg-hub reindex`, plus a phase-4 test proving the rebuild was
byte-identical. That is two storage engines, two write paths, and a consistency proof
between them — assembled to avoid one engine that ships inside Node 22. Simplicity was the
stated goal and was not what the design delivered.

Three specific errors:

- **"Append-only is a physical property" was false.** Nothing physically prevents `sed -i`
  on a `.jsonl` file. Append-only-ness of a file is discipline too. SQLite enforces it
  *harder*, because the prohibition can be declared:
  `CREATE TRIGGER … BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'append-only'); END;`
- **Tamper-evidence against the hub operator was zero in both designs.** An operator with
  root rewrites a JSONL line as easily as a row. The real mechanism is a hash chain, which
  revision 1 did not have; it is now a column.
- **`EventLog.read` skipping unparseable lines is correct on a laptop and wrong as server
  truth.** `src/core/events.ts` states the intent plainly — "A torn or corrupt line must
  not take down the audit trail" — which on a laptop is graceful degradation. As the
  server's only copy it means a torn line silently deletes an event from history, and a
  rebuild bakes the loss in. Loud corruption beats silent loss.

**What does not change: the laptop.** `.loomgraph/runs/<runId>/events.jsonl` stays exactly
as it is, unbuffered and append-only. AGENTS.md's invariant is about the run log, and the
run log is where the greppable-log property actually lives; revision 1 mistakenly read that
rule as binding on a component that did not exist when it was written. The hub is a
different component with a different job. **AGENTS.md needs one added line saying so**, and
saying that the hub's greppable artifact is a derived export, not its truth.

### 6.2 Pagination is keyset, not byte offsets

Revision 1's cursor was `base64({day, offset})` — a byte offset into a day-partitioned
file, handed to clients who hold it indefinitely. That is a public API made of the wrong
material:

- `reindex`, the design's own recovery mechanism, invalidated every outstanding cursor
  unless the rebuild was bit-perfect — which is precisely why that test had to exist. The
  escape hatch and the pagination scheme were at war.
- Tombstoning ([§11](#11-deletion--decision-d-2-revised)) shifts offsets, and compaction was
  rejected, so clients would page through tombstones forever.
- **A wrong byte offset is undetectable.** The client lands mid-line, or skips items, or
  repeats them, and nothing errors.

Cursors are now keyset over `(received_at, rowid)`, which survives rebuilds, retention
purges, schema evolution and reordering.

### 6.3 Schema

```sql
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

-- the verbatim client line is kept in `json`, so the export in §6.4 is lossless
CREATE TABLE events (
  member TEXT NOT NULL, stream_id TEXT NOT NULL, run_id TEXT NOT NULL, seq INTEGER NOT NULL,
  received_at TEXT NOT NULL, kind TEXT NOT NULL, node_id TEXT,
  json TEXT NOT NULL CHECK (json_valid(json)),
  prev_hash BLOB, row_hash BLOB NOT NULL,
  PRIMARY KEY (member, stream_id, run_id, seq)
) WITHOUT ROWID;
CREATE INDEX events_feed ON events(received_at);

CREATE TABLE runs (
  member TEXT NOT NULL, run_id TEXT NOT NULL, stream_id TEXT NOT NULL,
  graph_name TEXT, state_json TEXT, high_water_seq INTEGER NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (member, run_id));

CREATE TABLE briefs (
  brief_id TEXT PRIMARY KEY, member TEXT NOT NULL, sha256 TEXT UNIQUE NOT NULL,
  received_at TEXT NOT NULL, expires_at TEXT, revoked_at TEXT,
  key_id TEXT REFERENCES item_keys(key_id),   -- null only if encryption is off
  handoff_md BLOB, meta_json BLOB, html BLOB);
CREATE TABLE brief_files (brief_id TEXT, path TEXT, PRIMARY KEY (brief_id, path));
CREATE TABLE brief_shares (brief_id TEXT, grantee TEXT, granted_at TEXT, revoked_at TEXT,
  PRIMARY KEY (brief_id, grantee));

CREATE TABLE inbox (
  id TEXT PRIMARY KEY, from_member TEXT NOT NULL, to_member TEXT NOT NULL,
  subject TEXT, body TEXT, re_json TEXT, proposed_graph TEXT,
  state TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE inbox_history (id TEXT, to_state TEXT, ts TEXT, by TEXT, run_id TEXT);

CREATE TABLE members (
  key_id TEXT PRIMARY KEY, member TEXT NOT NULL, token_hash TEXT NOT NULL,
  scopes TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT);
CREATE TABLE sessions (sid TEXT PRIMARY KEY, member TEXT, expires_at TEXT);
CREATE TABLE read_marks (member TEXT, kind TEXT, ref TEXT, read_at TEXT,
  PRIMARY KEY (member, kind, ref));
CREATE TABLE access_log (ts TEXT, member TEXT, action TEXT, ref TEXT);
CREATE TABLE item_keys (key_id TEXT PRIMARY KEY, wrapped_key BLOB NOT NULL);

CREATE VIRTUAL TABLE search USING fts5(member, kind, ref, text);

CREATE TRIGGER events_no_update BEFORE UPDATE ON events
  BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events
  BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;
```

Everything revision 1 hand-rolled becomes a declared constraint: the high-water mark is a
primary key, 409-on-divergence is `INSERT OR IGNORE` plus a compare-on-conflict, the feed
is an index, receipts are columns, the members-file replay is a table, the §11 tombstone is
`revoked_at`. One ingest batch is one transaction — it happened or it did not — replacing
revision 1's four-file interleaving that had to be reasoned about by hand.

`row_hash = sha256(prev_hash || json)`, with the chain head published to members
periodically. This is the tamper-evidence revision 1 claimed from file semantics and did
not actually have.

### 6.4 The greppable artifact survives as an export

`lg-hub export --jsonl` emits exactly revision 1's directory layout — `events.jsonl` per
run, one JSON object per line — reconstructed from the `json` column, which holds the
verbatim client line. The grep audience loses nothing; the query audience gains
`lg metrics`, full-text search, unread state, threading, revocable share grants and
multi-day range queries, none of which are reachable by walking files.

**The law for AGENTS.md, inverted from revision 1:** the hub's database is truth; JSONL is
a rebuildable export. The laptop's `events.jsonl` is untouched and remains append-only.

### 6.5 Operations

- **Backup** is `VACUUM INTO 'snap.db'` — one statement, consistent. Revision 1's
  "`rsync` the data directory" was a live copy of dozens of files mid-write.
- **Recovery** at 2am: `PRAGMA integrity_check`, then restore the last snapshot and replay
  from members' local cursors, which are the real durable outbox ([§4](#4-wire-protocol))
  and are unaffected by hub state.
- **Migrations** are cheap because the event payload is an opaque verbatim `json` column;
  new client fields need no `ALTER TABLE`. Only hub-side projections migrate.
- **Postgres is not warranted.** One process, ten members at most, embedded synchronous
  access, zero-dependency ethos. Revisit at multiple hub nodes or roughly fifty members;
  arguing for it now would only discredit the SQLite case.

## 7. Visibility — decision D-1

**The two memos disagreed here, and this is the resolution.**

The architecture memo said every member reads everything; right-sized for a small team.
The threat memo said private-by-default with explicit scoped sharing, because
`lg-handoff` is private-only and *refuses* `--visibility org`, and because a flat pool
means one leaked token or one XSS drains the whole team's briefs.

**Resolution: the push is the sharing decision.**

- Nothing reaches the hub that a member did not push. Sync is **opt-in per repository**
  (`lg sync --enable` writes `.loomgraph/hub.json`), never on by default, never global.
  A member who never enables sync is invisible to the hub, and that must stay true.
- **Run events, once pushed, are team-readable.** This is the monitoring feature the author
  asked for, and enabling sync on a repo is the consent act. Making pushed runs private
  would make the feature pointless.
- **Briefs are private to the sender until explicitly shared** to named members, revocably.
  A brief is quoted session content — a different asset class from a status table.
- **An inbox message is readable only by its sender and its addressee.** No broadcast.

So the threat memo wins on briefs and inboxes; the architecture memo wins on run events;
and the granularity that makes both defensible is per-repo opt-in rather than per-item
prompting. What was given up: a member cannot enable sync on a repo and then hide one
embarrassing run in it. Retraction ([§11](#11-deletion--decision-d-2-revised)) is the answer to
that, not per-run visibility flags.

**Token scopes** (`ingest` / `read` / `admin`) are separate from this and should land by
phase 3. A CI token that pushes events should not be able to read everyone's briefs or send
inbox messages.

### 7.1 What "conversations" means here — decision D-4

The author asked whether the hub should hold a database to share **all conversations**
between members. The database half is [§6](#6-hub-storage); this half is refused, and the
evidence is in [§18](#18-decision-record-d-3-and-d-4). The short form: on the author's own
machine, 61% of real agent transcripts contain a credential shape the existing scanner
already recognises, which is a floor rather than an estimate. Centralising transcripts
means roughly six in ten uploads carrying a known credential shape, permanently, on one
shared box, readable by everyone with a token.

The counter-design — per-session opt-in, encryption at rest, short retention, access
logging, redaction-on-read — was argued well and defeated by its own requirement: server-side
search, redaction and rendering all need the hub to hold decryptable plaintext, so it
mitigates every threat except A4 while materially raising A4's payoff. Its author's summary
of the position was "I chose the honeypot." On a shared server, that is the wrong choice.

**What is kept from that argument is [§7.2](#72-brief-depth-is-the-owners-choice),
[§7.3](#73-redaction-on-read), [§9.6](#96-what-this-design-cannot-investigate) and
[§17](#17-federated-search)** — because the objection that briefs are too thin was correct
even though the proposed remedy was not.

### 7.2 Brief depth is the owner's choice

Revision 1 inherited `lg-handoff`'s fixed extraction: `firstTurn(user)`, `lastTurn(assistant)`,
`lastTurn(user)`, plus a file list. A sixty-turn session becomes three quoted turns, and the
load-bearing one — Done — is **the agent's summary of its own work**, which the README's own
failure-mode section teaches you to distrust: Claude Code returns `subtype: "success"` with
`is_error: true` on a lapsed session, and a sandboxed verifier can report PASS having read
nothing. The brief keeps the claim and discards the evidence, then tells the reader to
verify every claim against the repo.

That makes a fixed-shape brief the worst point on the curve: most of the retention risk,
little of the value. The fix is not more content by default — it is letting the person who
was there choose:

```bash
lg-handoff pack claude --turns 12-31,44 --include-tool-result 27 --session-file <path>
```

Still extractive, still no model call, still scanned, still owner-curated. What changes is
that the dead end at turn 23 — "we tried patching `disburse.ts` first and it broke
reconciliation" — can be carried, because that sentence is worth more to the next person
than the summary is. `--turns` without an explicit list keeps today's default.

The turns and tool-result blocks a reader can request are bounded by what the reader
already extracts; **this does not loosen "the readers drop, they do not carry."** Adding a
field to `DistilledSession` still means deciding it is safe to publish.

### 7.3 Redaction-on-read

Scanning only at ingest means a rule added later protects nothing already stored. The
`lgt_` token rule from [§5](#5-identity-and-auth) is the worked example: any token that
leaked before that rule existed is exposed for as long as the store keeps it.

So stored content is also served through `scanText` + `rewritePaths` masking **at egress**,
on every read path — API, web UI and export. Consequences worth stating: every rule added
in future retroactively protects all history; a finding at read time is logged and surfaced
to the owner rather than silently masked; and the ingest gate stays exactly as it is, since
egress masking is a second layer and not a replacement for refusing to store a secret.

Cost: reads are no longer a straight file copy. At this data volume that is not a
performance question.

---

## 8. The inbox

### 8.1 Message schema

```
{ v: 1, id: uuid, from: <stamped by hub>, to: { member: "bob" },
  subject: string, body: string,
  re: { member, runId } | { briefId } | null,
  proposedGraph: { source: <yaml>, vars: {...} } | null,
  createdAt, state, history: [{to, ts, by, runId?}] }
```

**Addressing is person-only.** A repo has no owner who can approve; a run has no inbox.
Both exist only as the optional `re:` context reference. Repo-addressing is the feature
that quietly turns this into a dispatch system, so it is deliberately absent.

**Ingest gates**, in this order, fail-closed, mirroring `pushCommand`: `scanText` over
`subject`, `body`, `proposedGraph.source` and every var value — reject with masked findings
on any hit; then `parseGraph` on any `proposedGraph`, rejecting invalid graphs at send time
so an acceptor never receives an unrunnable request. Validation stays loud, per AGENTS.md.

**Lifecycle:** `queued → seen → accepted | declined | expired`, then
`accepted → done | failed`, reported by the acceptor's own sync. Only the addressee's token
may transition its own messages.

### 8.2 What `accept` actually does — decision D-1b

The memos disagreed here too. The architecture memo had `accept` write the sender's graph
via `saveGraphSource` and enter the normal `runCommand` path. The threat memo said a
message must never be able to name the task, because that is attack A2 with a green light.

**Resolution: the acceptor names the graph. The message is only ever data inside it.**

```
$ lg inbox show 7f2a          # mandatory reading step; see §8.3
$ lg inbox accept 7f2a --graph ./graphs/triage.yaml
```

`--graph` points at a **local file the acceptor already has and trusts.** The message body
is exposed to that graph only as `{{inbox.body}}`, which is materialized pre-fenced
([§8.3](#83-fencing-is-the-load-bearing-control)). The sender's `proposedGraph` is inert by
default; running it requires `--use-proposed-graph`, which prints the full YAML plus
`renderPlan` and requires typing the message id to confirm. There is no flag that skips
`show`, and **there must never be an `--auto-accept`, a trusted-sender bypass, or an
accept triggered by an event.**

`--cwd` is always the acceptor's. A message may name a repo *remote* as a suggestion and
can never name a local path.

Inbox-sourced runs default to the most restricted sandbox available and never inherit
`workspace-write` or `bypass`. A message cannot name its own execution mode — sender-supplied
capability is the whole attack with permission attached.

Progress flows back to the sender through ordinary event sync. No new mechanism.

### 8.3 Fencing is the load-bearing control

**This is the most important section in this document.**

An inbox message is untrusted input authored by someone else's agent, which may itself have
been steered by a web page, a dependency README, or a PR body it read. Approval-gating is a
boolean on *ingestion*; the exploit is in *interpretation*. A human clicking accept is
saying "this looks like real work from a colleague," not auditing an instruction set they
were never shown as an instruction set. Habits decay into muscle memory within a week.

So `src/team/fence.ts` wraps every inbox-sourced value before any agent CLI sees it:

- an explicit, un-spoofable delimiter, with delimiter-lookalikes in the body neutralized;
- a preamble stating the content is untrusted third-party data and instructions inside it
  are not to be followed;
- every line prefixed, reusing the discipline in `src/handoff/render.ts` — whose `quote()`
  exists so "no line of transcript can break out of the quote," and which deliberately
  ships **no markdown engine** because an inline-link parser is a way to smuggle
  `javascript:` into a page. The same reasoning applies verbatim to inbox content.

`lg inbox show` renders with the same fence: sender, source run, timestamp, and the entire
body — untruncated — inside a visible quarantine frame labeled *"untrusted message from
&lt;member&gt;; loomgraph did not write this and cannot vouch for it."* No link activation,
no markdown, escape everything.

**Say plainly, in the README and in `show`'s own output, that fencing is mitigation and not
proof.** Nothing at the prompt layer is a hard boundary against a determined injection.
Fencing lowers the odds, the restricted sandbox bounds the blast radius, and the human is
the last check — the same posture the scanner section already takes.

---

## 9. Threat model

### 9.1 New trust boundaries

Today there are two: transcript → readers (the narrowing boundary in
`src/handoff/readers/*.ts`), and bundle → enclave (scan, then constraints, then spawn, in
`pushCommand`). The hub adds:

- **B1 member → hub.** Every run now has a network side effect, on a schedule, not per
  human decision.
- **B2 hub → member.** Entirely new direction. `lg-handoff` has "No pull" as a design
  point; this deletes it.
- **B3 member ↔ member, transitively.** Any teammate can author input to my machine. Since
  teammates run agents, this is really: **anything any teammate's agent ever read** can
  author input to my machine.
- **B4 browser ↔ hub.** A client class with cookies, a DOM, and adversarial text to render.
- **B5 storage at rest.** Aggregated team content, long-lived, on one box. A new asset class.
- **B6 hub operator and co-tenants.** Rooting my laptop gets you my sessions. Rooting the
  hub gets you the team's.
- **B7 token custody.** A new secret on N machines — and one the handoff pipeline is built
  to accidentally republish ([§5](#5-identity-and-auth)).

### 9.2 Attack paths, ranked

**A1 — prompt-injected teammate → my inbox → my agent. (High × Critical; not close.)**
Teammate's agent reads a poisoned page, is instructed to send a hub message, the message
queues, I accept because it reads like plausible colleague work, my agent consumes it as
instructions. Sender authenticated, transport intact, human approved: **every planned
control passes and the attack still lands.** Mitigated only by [§8.3](#83-fencing-is-the-load-bearing-control)
fencing + acceptor-named graph + restricted sandbox. This is what the README's warning was about.

**A2 — malicious accept. (High × Critical.)** A1's mechanism restated, because
approval-gating is designed as the defense against it and does not defend against it.
Accept gates whether a message enters the workflow; it says nothing about what the message
says once in. Approval authorizes the topic; the payload is in the details.

**A3 — compromised member token. (Medium × High.)** Possession equals identity, replayable
until noticed. Grants reads per [§7](#7-visibility--decision-d-1) plus forged messages to
every other member — feeding A1 from an authenticated sender, which clears reputation
checks. Uniquely here, the token can leak *through loomgraph's own handoff pipeline*.

**A4 — compromised hub. (Low × Catastrophic.)** Read everything ingested, impersonate
anyone, inject into every inbox with no injection needed, rewrite the log. The mitigation is
not "trust the hub" — it is that the hub holds as little as possible and cannot itself
execute, which is why A1's real defense lives on the consuming machine.

**A5 — replay or forgery of events. (Medium × Medium-High.)** Forged `run_finished`,
resurrected states, spoofed run ids. Corrupts the shared record and anything keyed off it.
Countered by server-side attribution and the natural-key high-water mark.

**A6 — XSS from brief content. (Medium-High × High.)** Briefs are arbitrary quoted model
and user text by construction, rendered in an authenticated origin holding the team's data.

**A7 — scanner miss, retained forever.** See below.

### 9.3 Why the scanner still earns its place

Keep it as a mandatory, **server-side, non-bypassable** ingest gate. It genuinely catches
URL-embedded credentials, `Authorization` headers, vendor-prefixed keys, JWTs, and
`TOKEN=`-style assignments, and — the part that matters most — `scanBundleDir` **fails
closed** via `UNREADABLE_RULE`, so "clean" means "looked and found nothing." Re-run it on
the server even when the client claims clean.

### 9.4 What the scanner stops buying under retention

Retention inverts the cost of a false negative. Under handoff a miss sat behind a link that
expired in 7 days and could be revoked. On the hub it sits indefinitely, readable by
everyone [§7](#7-visibility--decision-d-1) admits. Every named gap — AWS secret access
keys, header-less PEM bodies, hex client secrets, non-home absolute paths — becomes
permanent team-wide exposure instead of a week-long single-recipient one.

And aggregation creates leak shapes that are in no single brief, which a line-oriented
single-file scanner structurally cannot see:

- **The hub token itself**, until the rule from [§5](#5-identity-and-auth) exists.
- **Cross-brief correlation** — a hostname here, a username there, a ticket scheme in a
  third. Individually beneath notice; together, a map of the team's infrastructure.
- **The org graph.** `meta.json` carries `createdBy`, `createdAt`, and
  `repo.remote/sha/branch`. Across a team that is an accurate timestamped record of who
  touched what in which private repo. No rule flags it, and it is exactly what a departing
  employee or an attacker wants.
- **`files.txt` as a source-tree map.** The union of `filesTouched` sketches private
  codebases' structure.

Mitigation is minimization, not more rules: ingest the least identity that works, make
`repo.remote` and `files.txt` opt-in, and be able to actually delete.

### 9.5 Web UI surface

Requirements, all v1: contextual escaping on every interpolated value (the existing
`escapeHtml` in both renderers); **no markdown engine**, matching
`src/handoff/render.ts`'s stated rationale; no `innerHTML` on any brief-derived value;
strict CSP `default-src 'none'` with no inline script, so a missed escape cannot execute;
`<meta name="referrer" content="no-referrer">`, already present in the handoff page;
`X-Frame-Options: DENY` and `frame-ancestors 'none'` against clickjacking.

Note `svg` is in `ENCLAVE_ALLOWED_EXTENSIONS` and SVG is an XSS vector (inline `<script>`,
`on*` handlers). If the hub ever serves member-supplied SVG, sanitize it or serve it with a
non-rendering content type.

### 9.6 What this design cannot investigate

Stated plainly because the pro-database review was right to raise it: **A1, the
highest-ranked threat in this document, is uninvestigable with the data the hub retains.**

Establishing that a teammate's agent was prompt-injected means finding what it read — a web
page, a dependency README, a PR body — and that lives in a `tool_result` block, which
`src/handoff/readers/claude.ts` drops by design and which therefore never reaches the hub.
The hub can show that a message arrived, from whom, when, and what it said. It cannot show
why the sender's agent composed it.

This is accepted, not solved. The hub is not a forensics system and must not be described
as one. What v1 provides instead:

- The message, its sender, and its full transition history are retained, so the *fact* of
  the injection and its blast radius are reconstructable.
- A voluntary evidence path: the sender runs `lg-handoff pack --turns <range>` over the
  session in question and shares the brief with the investigator. The owner remains the
  access-control system.
- [§17](#17-federated-search) lets an investigator ask every machine "did you see this
  string?" without any machine surrendering its transcripts.

The alternative — retaining tool output centrally so that injections are investigable —
means building the corpus [§7.1](#71-what-conversations-means-here--decision-d-4) refuses,
and the measured secret density in [§18](#18-decision-record-d-3-and-d-4) is what that
would cost. Investigability is not worth a permanent team-wide credential store.

---

## 10. Web UI

**Server-rendered HTML from pure renderers, zero client JS, meta-refresh for liveness,
read-only in v1.**

- `src/hub/ui/*.ts` are `(data) → html` functions, exactly the `renderReportHtml` /
  `renderHandoffHtml` pattern. An inlined SPA would need a client data protocol and
  client-side escaping — a second place for injection bugs to live. Rejected.
- Liveness is `<meta http-equiv="refresh" content="10">`. SSE is a phase-5 upgrade;
  refresh is stateless, survives hub restarts, and needs no connection bookkeeping.
- Browser auth is a `/login` form that takes a member token and sets an
  **HttpOnly, Secure, SameSite=Strict** cookie holding a random session id, with the session
  server-side. The long-lived bearer token never reaches page JS — combining "renders
  adversarial content" with "holds a stealable god-token in JS reach" is the worst possible
  pairing.
- **The UI is read-only.** Accept, decline and send are CLI-only. This deletes the CSRF
  surface outright — a CSRF on `accept` would be A2 without even needing the human to
  click — and it keeps approval in the one place that shows the real prompt and runs the
  run.

Four screens: **Feed** (team timeline, filter by member), **Run** (the `renderStatus`
table, the event log, and a staleness banner from hub `receivedAt`), **Brief** (the stored
bundle's `index.html`, already self-contained by construction), **Inbox** (my queue, full
fenced body, and the `lg inbox accept` command printed as copyable text).

**Enclave can serve no live part of this.** It is a static host with print-once expiring
shares, no fetch API, and a 13-extension allowlist; a hub needs stable authenticated URLs,
an ingest hook, and liveness. The hub serves briefs itself. Enclave keeps its existing and
still-correct job: expiring handoffs to people *outside* the team. `lg-handoff push --to hub`
becomes an alternate destination, and `checkEnclaveConstraints`' limits are **adopted** as
the hub's ingest limits so one bundle is valid for both — a choice, not a constraint the hub
inherits ([§18](#18-decision-record-d-3-and-d-4) corrects the earlier claim that it did).

---

## 11. Deletion — decision D-2, revised

Revision 1 called this a collision with a load-bearing invariant and shipped a tombstone
that could not honestly be called deletion. [§6](#6-hub-storage) removes most of the
collision: the invariant belongs to the laptop's run log, which is untouched, and the hub
can now express deletion as schema rather than as an apology.

| Tier | Mechanism | Status |
| --- | --- | --- |
| Tombstone | `briefs.revoked_at` set; hidden from every read path and from `search` | v1, and still not erasure |
| Crypto-shred | Per-item DEK in `item_keys`; `DELETE FROM item_keys WHERE key_id = ?` | **v1** — it is one statement, so there is no reason to defer it |
| Purge | `DELETE` the row itself once retention expires | v1 for briefs; never for `events` (the triggers forbid it) |

Crypto-shredding was revision 1's "right answer, phase 5." Under a relational store it is a
single `DELETE` against `item_keys`, so it ships in v1: briefs are written encrypted under a
per-brief key, and destroying that key makes the ciphertext unrecoverable while the row and
its hash-chain position remain. The audit trail keeps its shape; the content is gone.

`events` remain undeletable by trigger. They carry status, cost and timing — not content —
so there is nothing in them that a member needs retracted, and their integrity is what the
hash chain in [§6.3](#63-schema) exists to protect.

Retention: briefs expire by default, mirroring `lg-handoff`'s `7d` instinct rather than
keeping forever. `lg hub retract <ref>` is a first-class member operation, not a favour
asked of the operator.

**The honest sentence for the README, now weaker than revision 1's because the mechanism is
stronger:** destroying a key makes stored content unrecoverable from this database, and says
nothing about backups taken before the key was destroyed, or about anyone who already read
it. A shared server you do not exclusively control cannot promise erasure.

## 12. Testing under the no-network rule

AGENTS.md forbids tests that spawn a CLI or make a network request. That shapes the
architecture, so it is a design section, not a testing afterthought.

`src/hub/server.ts` is a dumb binding: a routing table, a hard body-size cap, nothing else.
All behavior lives in `handlers.ts` as `(WireRequest, deps) → WireResponse` and is tested
directly. The client transport sits behind a `Fetch` seam exactly like handoff's `Exec`
seam. **The contract test wires the client's fake fetch straight to the handler functions
in-process** — a full client↔server test with zero sockets. `server.ts` and `cli.ts` stay
untested wiring, the same status `src/cli.ts` and `src/handoff/cli.ts` have today.

That discipline holds right up until someone puts chunked-body handling, SSE reconnect, or
slow-loris timeouts into `server.ts`, because that is where such code naturally goes — and
none of it would be covered. **Decide in phase 1, not phase 5:** either hold the line
ruthlessly (hard body cap, no streaming ingest, SSE frames built by pure functions) or amend
AGENTS.md with one explicit carve-out for in-process loopback on port 0. Deciding late is
the regret.

**[§6](#6-hub-storage) makes this easier, not harder.** `node:sqlite` opens `:memory:`, so a
handler test gets a real store with the real schema, real constraints and real triggers, in
microseconds, with no filesystem and no network — stricter than revision 1's fixture
directories and faster. Two tests become expressible that were awkward before: the
append-only triggers can be asserted directly (an `UPDATE` against `events` must throw), and
hash-chain continuity can be property-tested over a generated event sequence. Two tests
disappear: nothing needs to prove a rebuild is byte-identical, because nothing rebuilds
truth.

---

## 13. Phased plan

Each phase is independently shippable and independently useful.

**Phase 1 — event mirroring.** `lg-hub serve` (health, auth, `/v1/events`), `member
add/revoke`, `lg enroll`, `lg sync`, the `onEvent` batcher, the [§6.3](#63-schema) schema
with append-only triggers and hash chain, `streamId`, keyset cursors, the `lgt_` scan rule,
the inverted storage law in AGENTS.md, and the [§12](#12-testing-under-the-no-network-rule)
decision.
*Value:* team run visibility, queryable with `curl` alone.
*Tests:* auth (bad, revoked, valid); dedupe by primary key; 409 on divergent seq; an
`UPDATE` against `events` throws; hash-chain continuity over a generated sequence; client
cursor advance and replay against a fake fetch; the in-process contract test replaying a
real `events.jsonl` fixture into an in-memory database; a kill-mid-sync test in the spirit
of `src/e2e.test.ts` proving the cursor never passes the last ack.

**Phase 2 — briefs.** `/v1/briefs` with server-side re-scan, per-brief encryption and
`item_keys`, hub-served brief pages, `lg-handoff push --to hub`, private-by-default with
revocable scoped sharing, retention expiry, `lg hub retract`, redaction-on-read
([§7.3](#73-redaction-on-read)), and owner-curated depth
([§7.2](#72-brief-depth-is-the-owners-choice)).
*Tests:* planted secret shapes are rejected **even when the client claims clean**;
content-hash idempotency; a grant is readable by the grantee and not by a third member;
destroying a key makes a brief unrecoverable while its row survives; a rule added after
ingest masks already-stored content on read; `--turns 12-31` carries exactly those turns and
no others.

**Phase 3 — the inbox.** send / ls / show / accept / decline, `src/team/fence.ts`,
acceptor-named graph, restricted-sandbox default, token scopes, unread state.
*Tests:* transition legality (only addressee, only legal edges); scan gate on body, vars and
graph; `parseGraph` rejection at send; `show` output contains the body untruncated and inside
the fence; a body containing the fence delimiter is neutralised; accept refuses a
budget-less graph; `--use-proposed-graph` refuses without confirmation; **an inbox-sourced
run never receives `bypass`**.

**Phase 4 — web UI.** Login and sessions, the four read-only screens, meta-refresh, CSP and
the rest of [§9.5](#95-web-ui-surface).
*Tests:* renderers against hostile fixtures (node output containing `</td><script>`, a brief
title with quotes, a body with `javascript:` links); keyset cursor round-trip across a
retention purge; egress masking applied on every render path.

**Phase 5 — search and hardening.** FTS5 over briefs and events, `lg metrics` off the same
database, [§17](#17-federated-search), SSE, staleness banners, 409-divergence surfacing,
ingest rate limits, the access log surfaced to owners.
*Tests:* SSE framing as a pure event→frame function; `lg metrics` totals equal a direct sum
over `node_finished`; a federated query returns counts and ids and provably no content.

## 14. Open questions for the author

1. **Is a repo-level sync opt-in the right granularity** ([§7](#7-visibility--decision-d-1)),
   or do you want per-run `lg sync <runId>` only, with nothing automatic at all? The second
   is safer and much less useful for monitoring.
2. **The [§12](#12-testing-under-the-no-network-rule) decision:** hold `server.ts` to
   dumb-binding forever, or take one AGENTS.md carve-out for in-process loopback tests on
   port 0? Settle before phase 1 code exists.
3. **Where is the brief encryption key wrapped?** [§11](#11-deletion--decision-d-2-revised) shreds a
   per-item DEK, but `item_keys.wrapped_key` has to be wrapped by something. A key file on
   the hub host means an operator with root can unwrap everything, which is honest but makes
   encryption-at-rest a defence only against a stolen disk. A passphrase entered at
   `lg-hub serve` start means an unattended restart cannot serve briefs. Pick which
   inconvenience you want; there is no third option that keeps both.

## 15. Non-goals to write down as the old three come out

- **No auto-dispatch, ever, without a design document of its own.** No trusted-sender
  bypass, no accept-on-event, no flag that skips `lg inbox show`.
- **No raw transcripts, under any flag, and no central conversation store.** Decision D-4,
  [§7.1](#71-what-conversations-means-here--decision-d-4). Not "not yet" — the measured
  secret density in [§18](#18-decision-record-d-3-and-d-4) is what makes it permanent.
- **No cross-member execution.** The hub relays intent; it never issues commands, and it
  never runs an agent.
- **No message-specified execution mode, sandbox, or permissions.**
- **No blanket team-wide brief visibility; no `org` or `public` visibility.**
- **No public internet exposure without a TLS proxy.**
- **No silent pull that reaches a running agent.** Inbound content lands in a quarantined
  inbox that a human inspects.

## 16. The five likely regrets, ranked

1. **A future `--auto-accept`.** Everything in [§8](#8-the-inbox) is load-bearing against
   A1, and every one of those controls is one convenience flag away from being bypassed by a
   tired teammate.
2. **The scanner quietly promoted from "gate on a 7-day link" to "team-wide retention
   boundary"** it was never sized for. [§7.3](#73-redaction-on-read) softens this — later
   rules now reach back over stored content — but its self-described gaps are still gaps,
   and egress masking cannot mask a shape it does not recognise.
3. **Testing the daemon.** The dumb-binding discipline is correct and will be eroded by the
   first real HTTP edge case unless [§12](#12-testing-under-the-no-network-rule) is settled
   deliberately.
4. **`streamId` not reserved in phase 1**, making run identity unfixable once data exists.
5. **Pressure to relax D-4 one step at a time.** Nobody will propose a central transcript
   corpus. Someone will propose retaining tool output "just for failed runs," then "just for
   security investigations" ([§9.6](#96-what-this-design-cannot-investigate) is exactly the
   argument they will use, and it is a real argument). Each step is defensible and the
   destination is the honeypot. Decide it by measurement — the threshold is in
   [§18](#18-decision-record-d-3-and-d-4) — not by the next incident's urgency.

*Revision 1's fifth regret was "SQLite becoming truth because a query got slow." It is now
the design, so the regret is inverted and recorded in [§6.1](#61-why-revision-1-was-wrong)
instead.*

---

## 17. Federated search

The real want behind "share all conversations" is usually a search: *has anyone's agent hit
this error before?* That does not require a corpus.

```
$ lg search --team "bwrap: loopback: Failed RTM_NEWADDR"
alice   2 sessions   most recent 2026-08-21   (ask alice to pack 3f9c)
bob     0 sessions
carol   1 session    most recent 2026-07-30   (ask carol to pack 88ad)
```

The query travels; the content does not. A search request goes out through the existing
inbox as an ordinary addressed message. Each member's CLI answers **about its own machine** —
match counts, session ids, timestamps, and nothing else. The requester then asks an owner to
`lg-handoff pack` the session that matters, which routes the content through the scan gate,
the owner's judgement and the ordinary brief path.

Properties worth naming: no machine surrenders a transcript to answer; the owner stays the
access-control system, consistent with "the push is the sharing decision"
([§7](#7-visibility--decision-d-1)); a match count is not zero information, so answering is
itself opt-in per member; and it degrades honestly — an offline machine reports as unreachable
rather than as having no matches, because "silence read as zero" is the failure mode that
would make the feature lie.

What it costs, stated plainly: latency measured in hours rather than milliseconds, and
nothing at all from a wiped laptop. That is the same limitation as
[§18](#18-decision-record-d-3-and-d-4)'s conceded weak point, and it is the price of not
holding the corpus.

---

## 18. Decision record: D-3 and D-4

Both questions went to an adversarial pair of reviews — one arguing for a central database
holding full conversations, one against. They split, and each won the half it deserved.

### D-3 — the hub gets a database. SQLite as truth.

The argument that settled it: revision 1 had not chosen files over a database, it had chosen
both plus the glue. Details and the three specific errors are in
[§6.1](#61-why-revision-1-was-wrong). The case against — corruption blast radius, `rsync`
simplicity, migration cost — is answered by `VACUUM INTO`, by cursors that live on member
machines, and by keeping the event payload an opaque verbatim column.

### D-4 — no central conversation store.

Measured on the author's own machine rather than argued from principle. All 407 agent
transcripts under `~/.claude/projects`, `~/.ccs/instances/*/projects` and
`~/.codex/sessions`; 198 MB total; mean 0.5 MB; largest 8.7 MB. A deterministic spread of 80
of them (47 MB) was run through this repository's own `scanText`:

| Measure | Result |
| --- | --- |
| Transcripts with ≥1 credential-shaped finding (excluding home paths) | **49/80 — 61%** |
| Transcripts with ≥1 finding of any rule | 70/80 — 88% |
| `url-credentials` (`scheme://user:pass@host`) | 65 hits |
| `env-assignment` (`TOKEN=`, `SECRET=`, …) | 728 hits |
| `generic-sk-key` | 13 hits |
| `private-key` (PEM) | 2 hits |
| `auth-header` / `gitlab-token` / `jwt` | 18 / 1 / 1 |

**61% is a floor, not an estimate.** It counts only shapes `SCAN_RULES` already recognises,
and the README states the list is "an allowlist of shapes, not a proof" with named gaps: AWS
secret access keys, header-less PEM bodies, hex client secrets, non-home absolute paths. The
true rate is higher by an unknown margin.

Note also what the sample *understates*. `scanText` here ran over whole transcript files,
but the highest-density material — `tool_result` blocks, the output of every command an agent
ran — is what `src/handoff/readers/claude.ts` drops before any brief is built. A central
transcript store would retain precisely the part the current pipeline exists to discard, and
`src/handoff/readers/codex.ts` already refuses `inter_agent_communication` records with a
comment noting they carry paths and credentials from *other* sessions. Transcripts leak
across session boundaries before any hub exists.

One correction to an argument made earlier and repeated in revision 1's reasoning: the 2 MB
`ENCLAVE_MAX_FILE_BYTES` cap is **not** an independent reason against transcript ingest. That
limit is enclave's, and the hub replaces enclave in this flow, so it does not bind. The
security case stands on its own; the size case does not apply.

**Threshold that would reopen D-4.** Not an argument — evidence. Either (a) a quarter of real
use in which brief-insufficient handoffs are logged at roughly once per person per week,
which would show the utility premise wrong; or (b) a secret-detection approach that holds on
machine output — issuer-verified detection plus entropy analysis with a measured
false-negative rate on real transcripts, not more regexes. Absent one of those, D-4 stands.

**Conceded weakness, recorded so it is not forgotten.** Institutional memory dies with a
wiped laptop. Every session never packed into a brief is gone, and
[§17](#17-federated-search) only works while an owner is online and responsive. The bet is
that the unpacked residue was mostly noise. That bet is not proven, and it is the honest
cost of D-4.
