# loomgraph

Compose Claude Code, Codex, and OpenCode runs into a checkpointed graph — resumable, budgeted, auditable.

## The problem

A single agent loop is a scheduler with a ready-set of one.

- **Serial.** It does one thing at a time, even when three checks could run at once.
- **State-as-transcript.** The only record of progress is a conversation you cannot query, diff, or restart from.
- **All-or-nothing failure.** One bad step at minute 40 poisons everything after it.
- **No pause.** There is no way to stop for a human decision and come back later without holding the whole context open.

So the long run dies at 90% — a rate limit, a laptop lid, a `Ctrl-C` — and you start over from the top, paying for the first 90% a second time.

loomgraph makes the scheduler explicit. You write the pipeline as a graph: typed variables, nodes that shell out to the agent CLI you already use, and edges that fan out and fan back in. The engine checkpoints to disk after every edge crossing, so a killed run resumes from where it stopped, and every event lands in an append-only log you can grep.

It does not call a model itself. Your agent CLIs are the runtime.

## Install

```bash
npm i -g loomgraph
```

Requires Node >= 22. The binary is `lg`.

## 60-second quickstart

`examples/hello.yaml` is three shell commands — no model calls, zero cost:

```bash
lg run examples/hello.yaml
```

```
> run hello-20260814-184653-st0l (new)
> greet started (attempt 1)
> greet succeeded
> where started (attempt 1)
> where succeeded
> done started (attempt 1)
> done succeeded
> run succeeded

run     hello-20260814-184653-st0l
graph   hello
status  succeeded
cwd     /home/dat/workspace/loomgraph
updated 2026-08-14T18:46:53.885Z

node   status      attempts  cost usd    duration
greet  succeeded   1         0.0000      0.0s
where  succeeded   1         0.0000      0.0s
done   succeeded   1         0.0000      0.0s

budget  0.0000/0.0100 usd   0s/60s wall clock   3/5 node runs
note: adapters that do not report a price (codex, command) record 0.0000 usd - the number is not estimated.
```

Then:

```bash
lg ls                  # every run, with status and cost
lg status <runId>      # the table above, any time later
lg events <runId>      # the full audit trail as JSONL
```

## The graph file

```yaml
name: fix-failing-test

budget:                    # enforced before every node dispatch
  maxUsd: 2.00
  maxWallClockSec: 1800
  maxNodeRuns: 20

vars:
  ticket: ""               # override with: lg run … --var ticket="LG-42"

nodes:
  reproduce:
    type: agent            # shells out to a real agent CLI
    adapter: claude
    prompt: "Reproduce the failure described in: {{vars.ticket}}. Do not fix it."
    maxTurns: 8

  fix:
    type: agent
    adapter: claude
    prompt: "Fix the failure. Repro notes: {{nodes.reproduce.output}}"
    maxTurns: 20
    retries: 1             # exponential backoff, capped at 30s

  test:
    type: command          # just a shell command
    run: "npm test"

  lint:
    type: command
    run: "npm run lint --if-present"

  review:
    type: verifier         # fails the node unless the output contains `pass`
    adapter: codex
    prompt: "Review the diff for correctness and missing tests. Reply PASS or FAIL."
    pass: "PASS"

edges:
  - from: reproduce
    to: fix
  - from: fix
    to: [test, lint]       # fan-out: both dispatched concurrently
  - from: [test, lint]     # fan-in: waits for both
    to: review
    when: all_succeeded
  - from: review
    to: END
```

Templates resolve against run state: `{{vars.ticket}}` (or the shorthand `{{ticket}}`) and `{{nodes.<id>.output}}`. An unresolvable reference is an error, not an empty string and never a passthrough — which is why node ids are restricted to `[A-Za-z0-9_-]`, 1 to 64 characters. A dot would collide with the reference syntax itself, so `lg validate` rejects it rather than letting `{{nodes.my.node.output}}` mean nothing at run time.

Check a graph before running it - `lg validate` catches unknown node ids, cycles, missing
budgets, bad adapters, and `{{nodes.<id>.output}}` references to a node the graph never
declares. Unknown *variable* references are not caught: `lg run --var` can supply a variable
the `vars:` block never declares, so an undeclared `{{vars.x}}` is not statically decidable
and stays a run-time error.

```bash
lg validate examples/fix-failing-test.yaml
lg run examples/fix-failing-test.yaml --dry-run   # prints the dispatch batches, spawns nothing
```

## Kill it and resume it

Start a run and interrupt it partway through:

```
$ lg run demo.yaml
> run slow-20260814-184710-y412 (new)
> fetch started (attempt 1)
> fetch succeeded
> work started (attempt 1)
^C
```

The checkpoint written after `fetch` is still on disk. Resume it:

```
$ lg resume slow-20260814-184710-y412
> run slow-20260814-184710-y412 (resumed)
> work started (attempt 1)
> work succeeded
> report started (attempt 1)
> report succeeded
> run succeeded
```

`fetch` is not re-run. Only the nodes that had not completed execute. The checkpoint is written atomically (temp file, then rename) after every edge crossing, so a process killed mid-write never leaves a corrupt state file. This is covered by an automated test — see `src/e2e.test.ts`.

A paused human node resumes the same way:

```bash
lg resume <runId> --answer approve="ship it"
```

The node id has to be one the run is actually paused on. An unknown id, or one that is not
awaiting an answer, exits 1 and names it - a typo used to be indistinguishable from a correct
answer.

### What cannot be resumed

Only a run that stopped without reaching a verdict is resumable: killed, interrupted, or
paused on a human node. A run whose status is already `failed` is not. `lg resume` on one
prints `run "<id>" is already failed and cannot be resumed` and exits 1, and the same applies
to a run that already succeeded.

That covers a node that failed all its retries and a run stopped by a budget ceiling. There is
no way to fix the cause and continue from the last checkpoint - you start a new run, from the
top, and pay for the completed nodes again. The failed run's checkpoint and event log stay on
disk so you can still read what happened. Resume rescues an interrupted run, not a failed one.

## Node types

| Type | What it does | Fails when |
| --- | --- | --- |
| `agent` | Runs an agent CLI non-interactively with the interpolated prompt | The CLI reports a non-success result |
| `command` | Runs a shell command in the run's cwd | Non-zero exit, or `timeoutSec` elapses |
| `verifier` | Runs an agent CLI, then checks the output for a literal `pass` string | The `pass` string is absent |
| `human` | Pauses the whole run and exits cleanly, holding zero context | Never — it waits |

Every node accepts `retries` (default 0), `timeoutSec` (default 900), and `cwd`. `timeoutSec`
kills the process *group*, not just the direct child, so a command that backgrounds a
grandchild still aborts at the deadline instead of holding the run open until the command ends
on its own.

A `human` node's field is `question`, not `prompt`. It is the one node type that dispatches
nothing, so there is no prompt to send; writing `prompt:` on it fails validation with
`question: Invalid input: expected string, received undefined`.

```yaml
approve:
  type: human
  question: "Ship the fix? Repro notes: {{nodes.reproduce.output}}"
```

The question is template-interpolated exactly like an agent prompt, so the reviewer reads the
resolved text rather than a raw `{{nodes.reproduce.output}}`.

A `command` node also accepts two optional assertions, because a shell command that exits 0
having done nothing is not a passing check: `expectNonEmpty: true` fails the node when the
command wrote no output, and `expect: "<literal>"` fails it when that substring is absent
from stdout. `npm run lint --if-present` in a repo with no lint script is the case these
exist for.

## Budgets

Three ceilings, all enforced *before every single node is dispatched* - each member of a
fan-out batch and each retry attempt separately - **and once more before a run is allowed to
finish successfully**, all recorded in the checkpoint:

- `maxUsd` — summed from what the adapters actually report.
- `maxWallClockSec` — measured from the run's creation, so it survives a resume.
- `maxNodeRuns` — counts every attempt, retries included.

The ceilings are exclusive: the limit itself is allowed, and only going over it stops the run.
`maxNodeRuns: 20` permits 20 node runs, and `maxUsd: 2.00` permits a run that spends exactly
2.00.

Crossing a ceiling stops the run with status `failed`, a `budget_exceeded` event naming the
ceiling, and exit code 3. Nothing further is dispatched, and that is literal: a fan-out stops
part-way through its batch, the nodes that were never admitted leave no side effect behind, and
a retry that would cross the ceiling is not attempted.

A ceiling breached by the final batch fails the run too. A node that already finished keeps
its result — the run fails, the work does not unwind — so `lg status` still shows what was
done and exactly how far over the line it went.

Cost numbers are never invented. Claude Code reports `total_cost_usd` and that number is used as-is; adapters that report no price record exactly `0.0000`, and `lg status` says so.

## Audit trail

Every run appends JSONL to `.loomgraph/runs/<runId>/events.jsonl`, unbuffered, so a killed process still leaves a complete log.

```
$ lg events slow-20260814-184710-y412 --kind node_finished
{"ts":"2026-08-14T18:47:10.056Z","runId":"slow-...","seq":3,"kind":"node_finished","nodeId":"fetch","data":{"status":"succeeded","attempts":1,"costUsd":0,"error":null}}
{"ts":"2026-08-14T18:47:17.216Z","runId":"slow-...","seq":10,"kind":"node_finished","nodeId":"work","data":{"status":"succeeded","attempts":1,"costUsd":0,"error":null}}
{"ts":"2026-08-14T18:47:17.221Z","runId":"slow-...","seq":14,"kind":"node_finished","nodeId":"report","data":{"status":"succeeded","attempts":1,"costUsd":0,"error":null}}
```

Event kinds: `run_started`, `node_started`, `node_finished`, `edge_crossed`, `budget_checked`, `budget_exceeded`, `human_requested`, `human_resolved`, `run_finished`.

## Adapters

| Adapter | Command it runs | Status |
| --- | --- | --- |
| `claude` | `claude -p <prompt> --output-format json --permission-mode acceptEdits --max-turns <n>` | Tested against Claude Code 2.1.232 and the array-form json output of 3.x |
| `codex` | `codex exec <prompt> --json --skip-git-repo-check --sandbox read-only -C <cwd>` | Tested against codex-cli 0.145.0 |
| `opencode` | `opencode run --format json [-m <model>] <prompt>` | Tested against opencode 1.18.17 |

Cost reporting differs by CLI: Claude Code reports `total_cost_usd`, and OpenCode reports a price per step under `--format json` — which is the only reason this adapter uses that format, since the default one prints prose and no price at all. Codex reports nothing, and loomgraph records `0` for it rather than estimating from a price table. Wall-clock and node-run ceilings still apply either way.

### Choosing a model

An `agent` or `verifier` node may name the model it wants, passed straight through to the CLI:

```yaml
review:
  type: verifier
  adapter: opencode
  model: "opencode-go/deepseek-v4-flash"
  prompt: "Review the diff. Reply PASS or FAIL."
  pass: "PASS"
```

Omit it and the CLI's own resolution decides, which is not always what the config says: with no `-m`, opencode ignored a configured `model` and fell through to a provider with no credentials. `OPENCODE_MODEL` is ignored — the flag is the only way. A `command` or `human` node that declares a `model` - or an `adapter` - is a validation error
rather than a silently ignored key.

### Environment

| Variable | Effect |
| --- | --- |
| `CLAUDE_CONFIG_DIR` | Which Claude Code credential directory to use. Set it when your default `~/.claude` session is expired or you keep several logins side by side. |
| `LOOMGRAPH_CODEX_SANDBOX` | Codex sandbox policy: `read-only` (default), `workspace-write`, or `bypass`. Any other value is a hard error naming those three, rather than a silently wider or narrower sandbox. |

### Two failure modes worth knowing

**An expired login does not look like an error.** Claude Code returns `subtype: "success"` *and* `is_error: true` when its OAuth session has lapsed, with the authentication message sitting in the `result` field. An adapter that trusts `subtype` alone records a node that spent nothing, changed nothing, and reported success. loomgraph checks both fields and fails the node with the message the CLI actually returned.

**A verifier that cannot read the tree must fail, not pass.** Codex sandboxes the commands it runs, and some containers cannot start that sandbox at all — every read fails with `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`. A review under those conditions is worthless, so any line
beginning `bwrap:` on either stderr or stdout fails the node and is quoted back in the error.
The exit code is not consulted for this: bubblewrap fails per tool call rather than at startup,
so the realistic shape is codex exiting 0 with a confident verdict from a run that read
nothing. Set `LOOMGRAPH_CODEX_SANDBOX=bypass` only when the host is already isolated.

Both agent adapters close stdin before spawning. Codex otherwise prints `Reading additional input from stdin...` and waits until the node's timeout fires, which is indistinguishable from a slow model.

## Commands

| Command | Behavior |
| --- | --- |
| `lg run <graph.yaml> [--var k=v] [--max-usd N] [--dry-run]` | Validate, create a run id, execute |
| `lg resume <runId> [--answer node=text]` | Continue from the last checkpoint |
| `lg status <runId>` | Per-node table plus the budget line |
| `lg ls` | Every run with status and cost |
| `lg validate <graph.yaml>` | Exit 0 if valid, else exit 1 with the specific error |
| `lg report <runId> [--out path] [--publish] [--title t] [--visibility private\|org]` | Render the run to a self-contained html file; `--publish` hosts it with the `enclave` cli |
| `lg events <runId> [--kind K]` | The JSONL audit trail, filterable |

`lg report --visibility` accepts only `private` or `org`; anything else exits 1 and nothing is
published. `lg events --kind` accepts only the nine kinds listed above; an unknown kind exits 1
rather than printing nothing, which used to be indistinguishable from "no such events".

Exit codes: `0` success, `1` validation or usage error, `2` run failed, `3` budget exceeded, `4` paused awaiting a human.

## Handoff

You spent two hours in a `claude` session narrowing a bug. Now someone else has to carry
it. `lg-handoff` turns that session into a short brief they can read in a minute - the
goal, the files, what was claimed done, what is still open, and the exact commit to start
from - then publishes it privately behind a link that expires.

It hands over the *understanding*, not the transcript. A transcript is a credential dump;
a brief is a handover note.

```bash
lg-handoff pack claude --title "LT-8451 null bank_code crash"   # -> ./handoff-bundle
lg-handoff push ./handoff-bundle                                # -> prints a share link
```

Send the link. They open it in a browser and start a fresh session on the commit named in
the brief. There is nothing to install on their side.

### What the recipient actually sees

The published page is this, rendered. Nothing was summarised by a model - every quote is
lifted verbatim from a turn, and the banner says so:

```markdown
# LT-8451 null bank_code crash

> This brief was distilled mechanically (quoted turns only - no model summarised it).
> Verify every claim against the repo before acting on it.

- adapter: claude          - created by: alice
- session: 9f2c            - turns: 3
- model: claude-opus-5

## Goal
> The loan submission crashes when bank_code is null. Find it and fix it.

## Repo
- remote: git@github.com:acme/api.git
- sha: 6d4584dddf395e6fe7f93f63b70475de45d85a3d
- branch: fix/LT-8451

## Files
- src/loan/disburse.ts
- src/loan/submit.ts
- tests/loan/submit.test.ts

## Done
Quoted from the last assistant turn. It is a claim, not a verified fact.
> Found it. src/loan/submit.ts:88 dereferences bank_code before the null guard.
> I added the guard and a regression test in tests/loan/submit.test.ts. Both pass.

## Open
> The same pattern probably exists in the disbursement path - check src/loan/disburse.ts next.
```

"It is a claim, not a verified fact" is deliberate. The tool cannot know whether the tests
really passed, so it refuses to imply that it does.

### Commands

| Command | What it does |
| --- | --- |
| `lg-handoff pack <claude\|codex\|opencode> [sessionRef]` | Distil a session into a bundle at `--out` (default `./handoff-bundle`) |
| `lg-handoff scan <bundleDir>` | Report secrets and residual absolute paths, with masked excerpts |
| `lg-handoff push <bundleDir>` | Scan, check the enclave limits, publish privately, mint a share link |

`pack` takes `--cwd <dir>` (the repo the session ran in, default `.`), `--session-file
<path>`, `--out <dir>`, `--title <t>`.
`push` takes `--title <t>`, `--expires <duration>` (default `7d`), `--visibility private`,
`--dry-run`.

`scan` runs automatically inside both `pack` and `push` - you only call it directly to
re-check a bundle you edited by hand.

### Exit codes, and what to do about each

Its own namespace, deliberately not `lg`'s.

| Code | Means | Do this |
| --- | --- | --- |
| `0` | Done | For `push`, save the printed link - see below |
| `1` | Usage error, session/bundle not found, or `--expires` is not a duration/date | Read the message; usually `--session-file` or a valid `--expires` |
| `2` | Secrets found, an enclave limit broke, or a remote enclave step failed | Read stderr. A local-gate 2 means nothing was uploaded. A 2 after enclave ran can mean the artifact is already published - the view url is on stdout |

Exit 2 at a local gate (scan findings or an enclave constraint) means enclave
was never invoked. Exit 2 after that means see stderr; a partial publish is
possible. Invalid `--expires` and a missing enclave binary are exit 1; the
latter also prints the view url when the artifact is already up.

### The share link is printed once

`enclave` prints a share url once and stores only its hash, so it cannot be recovered
later. `push` therefore also writes it to `<bundleDir>/SHARE-URL.txt` the moment it gets
it. Both `handoff-bundle/` and `SHARE-URL.txt` are gitignored - the link grants read
access to the artifact, so committing one is worse than losing it.

To hand over again later, `pack` and `push` again; you get a new link. To cut off access
early, `enclave share revoke <shareId>`.

### Picking the right session

`--session-file <path>` always wins, and is the reliable option. Without it:

- **claude** - most recent `*.jsonl` under `~/.claude/projects/<cwd with every
  non-alphanumeric character replaced by ->`.
- **codex** - most recent `*.jsonl` under `~/.codex/sessions/`, searched a few levels deep.
- **opencode** - no file search; runs `opencode export [sessionRef] --sanitize` and reads
  its stdout.

That claude directory encoding is undocumented and changes between versions, so discovery
is best-effort. `pack` always prints which file it chose and labels it as a guess. If the
brief looks like the wrong conversation, that line is why - re-run with `--session-file`.

### What gets stripped, and what does not

Before rendering, every home path becomes `${HOME}`, the repo root becomes
`${REPO_ROOT}`, and a standalone username token becomes `user`. Tool-result blobs, attachments,
file-history snapshots, codex `base_instructions`, MCP config and permission modes are
dropped by the readers and never reach the page at all.

Then the scanner runs, and `push` refuses on any hit. It knows URL-embedded credentials
(`scheme://user:pass@host`), `Authorization: Bearer` / `Basic` headers in both their plain-text
and JSON-encoded (`{"Authorization":"Bearer ..."}`) forms, `.netrc` rows
(`machine <host> login <user> password <secret>`), the OAuth material an opencode `auth.json`
stores under `refresh` / `access` / `credential`, Anthropic, OpenAI, Stripe (`sk_` and `rk_`),
GitHub, GitLab, Slack, AWS access key ids, GCP, HuggingFace (`hf_`), Google OAuth (`GOCSPX-`),
npm and SendGrid key shapes, JWTs, PEM private keys, and token / secret / password / api-key /
bare `key` assignments. The git remote is special-cased: it is published
verbatim and never passes through path rewriting, so a `user:password@` in it is stripped
at the source.

**This is an allowlist of shapes, not a proof.** A credential in a shape it has never seen
goes straight through. Known gaps include AWS secret access keys, PEM bodies without a
header, hex client secrets, and non-home absolute paths.

One gap is a deliberate trade: an *unquoted* assignment value shorter than eight characters is
not treated as a credential, so a YAML line like `password: abc123` is missed. The alternative
was a scanner that fires on ordinary prose - the line `Standalone token: user` blocked a real
pack. A quoted value is caught at any length, and a genuine credential in a `KEY=value` line is
longer than eight characters, so the `.env` shapes still fire.

Read the brief before you send
the link - it is one screen, and you are the last check. If the scanner cannot read a file
it was asked to scan, it reports that as a finding rather than staying quiet, so "clean"
always means "looked at and found nothing".

### Troubleshooting

| You see | Cause | Fix |
| --- | --- | --- |
| `no claude session file found for <dir>` | No transcript at the encoded path - common if the CLI stores sessions elsewhere, e.g. under a wrapper | `--session-file <path>` |
| `using discovered session file ... (discovery is best-effort)` and the brief looks wrong | Discovery picked the newest transcript, not the one you meant | `--session-file <path>` |
| `opencode not found on PATH` | `pack opencode` shells out to the real binary | Install it, or `opencode export --sanitize > s.json` elsewhere and pass `--session-file s.json` |
| `refusing to push: N scan finding(s)` | A secret shape in the brief | Fix the source, re-`pack`. Editing the bundle by hand works too - then `scan` it again |
| `<file>: extension .jsonl is not in the enclave allowlist` | Something not in the four-file bundle landed in the directory | Remove it; `--out` should be a directory the tool owns |
| `enclave not found on PATH` | Only `push` needs it | The bundle is still on disk; install `enclave` or hand the folder over another way |
| `unreadable-file` finding | The scanner could not open a file, so it refuses to call the bundle clean | Fix permissions and re-scan |

### What handoff is not

- **No `pull`.** `enclave` has no fetch subcommand, and a share url is print-once. The
  recipient opens the link; the brief *is* the page.
- **No raw transcript upload.** enclave allows 13 file extensions, `.jsonl` is not among
  them, and files are capped at 2 MB - a real session transcript is larger. Distilled is
  not a compromise here, it is the only thing that fits.
- **No cross-CLI replay and no session transplant.** Nothing writes into another person's
  home directory, and no adapter resumes someone else's session id.
- **No summarisation.** The distillation is extractive - it quotes turns under fixed
  headings. There is no model call, so `pack` works offline and cannot invent a claim.
- **`private` visibility only.** A transcript is production data. `--visibility org` and
  `public` are refused.
- **No signal bus, inbox, or daemon.** That would contradict "Not a workflow server"
  below, and an inbox that starts an agent on someone else's laptop is a different product
  with a much harder threat model.

Known rough edge: the `enclave share create --json` parser accepts several plausible field
names because that stdout shape has not yet been captured from a real invocation.

## What this is not

- **Not a model, and not an SDK for one.** loomgraph makes zero API calls of its own and has no LLM SDK dependency.
- **Not a replacement for your agent CLI.** It shells out to the CLI you already installed and authenticated.
- **Not a workflow server.** No daemon, no web UI, no cloud, no plugin system in v0.1.

`lg report --publish` does not change that: it writes a static file and shells out to the
`enclave` cli the same way a node shells out to `claude`. If `enclave` is not installed the
report is still written, and nothing is uploaded.

Concurrency caveat: fan-out nodes in v0.1 share one working directory. If two branches edit the same files, they will collide. Per-node git worktrees are phase 2.

## Roadmap

- `lg metrics` — completion rate, cost per run, and human-intervention count, read from the same event log.
- Per-node git worktrees so fan-out branches cannot collide.
- A real OpenCode verification pass.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md). In short: `npm ci`, then `npm run typecheck && npm test && npm run build`. Tests never spawn a real agent CLI.

## License

MIT © 2026 Dat Nguyen
