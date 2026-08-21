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

budget:                    # enforced before every dispatch batch
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

Check a graph before running it — `lg validate` catches unknown node ids, cycles, missing budgets, and bad adapters:

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

## Node types

| Type | What it does | Fails when |
| --- | --- | --- |
| `agent` | Runs an agent CLI non-interactively with the interpolated prompt | The CLI reports a non-success result |
| `command` | Runs a shell command in the run's cwd | Non-zero exit, or `timeoutSec` elapses |
| `verifier` | Runs an agent CLI, then checks the output for a literal `pass` string | The `pass` string is absent |
| `human` | Pauses the whole run and exits cleanly, holding zero context | Never — it waits |

Every node accepts `retries` (default 0), `timeoutSec` (default 900), and `cwd`.

A `command` node also accepts two optional assertions, because a shell command that exits 0
having done nothing is not a passing check: `expectNonEmpty: true` fails the node when the
command wrote no output, and `expect: "<literal>"` fails it when that substring is absent
from stdout. `npm run lint --if-present` in a repo with no lint script is the case these
exist for.

## Budgets

Three ceilings, all enforced *before* each dispatch batch **and once more before a run is
allowed to finish successfully**, all recorded in the checkpoint:

- `maxUsd` — summed from what the adapters actually report.
- `maxWallClockSec` — measured from the run's creation, so it survives a resume.
- `maxNodeRuns` — counts every attempt, retries included.

Hitting a ceiling stops the run with status `failed`, a `budget_exceeded` event naming the ceiling, and exit code 3. Nothing further is dispatched.

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

Omit it and the CLI's own resolution decides, which is not always what the config says: with no `-m`, opencode ignored a configured `model` and fell through to a provider with no credentials. `OPENCODE_MODEL` is ignored — the flag is the only way. A `command` or `human` node that declares a model is a validation error rather than a silently ignored key.

### Environment

| Variable | Effect |
| --- | --- |
| `CLAUDE_CONFIG_DIR` | Which Claude Code credential directory to use. Set it when your default `~/.claude` session is expired or you keep several logins side by side. |
| `LOOMGRAPH_CODEX_SANDBOX` | Codex sandbox policy: `read-only` (default), `workspace-write`, or `bypass`. |

### Two failure modes worth knowing

**An expired login does not look like an error.** Claude Code returns `subtype: "success"` *and* `is_error: true` when its OAuth session has lapsed, with the authentication message sitting in the `result` field. An adapter that trusts `subtype` alone records a node that spent nothing, changed nothing, and reported success. loomgraph checks both fields and fails the node with the message the CLI actually returned.

**A verifier that cannot read the tree must fail, not pass.** Codex sandboxes the commands it runs, and some containers cannot start that sandbox at all — every read fails with `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`. A review under those conditions is worthless, so the verifier node fails and says why. Set `LOOMGRAPH_CODEX_SANDBOX=bypass` only when the host is already isolated.

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

Exit codes: `0` success, `1` validation or usage error, `2` run failed, `3` budget exceeded, `4` paused awaiting a human.

## Handoff

`lg-handoff` is a second binary. It distils one `claude`, `codex` or `opencode` session
into a self-contained brief, scans that brief for secrets, and publishes it privately with
the `enclave` cli behind a time-boxed share link. It is how you hand a colleague enough
context to continue your work without handing them your transcript.

It is not a subcommand of `lg`, shares no state with a run, and is not a daemon.

| Command | What it does |
| --- | --- |
| `lg-handoff pack <claude\|codex\|opencode> [sessionRef] [--cwd dir] [--session-file path] [--out dir] [--title t]` | Distil a session into a bundle at `--out` (default `./handoff-bundle`) |
| `lg-handoff scan <bundleDir>` | Report secrets and residual absolute paths, with masked excerpts |
| `lg-handoff push <bundleDir> [--title t] [--expires 7d] [--dry-run]` | Scan, check the enclave limits, publish privately, mint a share link |

Exit codes for this bin: `0` success, `1` usage or file not found, `2` scan findings or
push refused. They are its own namespace, deliberately not `lg`'s.

```bash
lg-handoff pack claude --cwd . --title "auth refactor, where I got to"
lg-handoff scan ./handoff-bundle
lg-handoff push ./handoff-bundle --expires 7d
```

A bundle is four files: `index.html` (the page enclave serves), `handoff.md`, `meta.json`
and `files.txt`. `handoff-bundle/` and `SHARE-URL.txt` are gitignored: a share url grants
read access to the artifact, so committing one is worse than losing it. `push` refuses to invoke `enclave` at all if the scanner finds anything or
if the bundle breaks enclave's published limits, so a bad bundle fails locally with the
limit named rather than as an opaque server refusal. On success the share url is printed
and written to `<bundleDir>/SHARE-URL.txt`, because enclave prints it once and keeps only
its hash: lose the line and the link is unrecoverable.

The scanner covers URL-embedded credentials (`scheme://user:pass@host`), Anthropic,
OpenAI, Stripe, GitHub, GitLab, Slack, AWS, GCP, npm and SendGrid key shapes, JWTs, PEM
private keys, and token/secret/password assignments. It is an allowlist of shapes, not a
proof: a credential in a shape it does not know still gets through, so `--dry-run` and
reading the brief before you share the link are both still worth doing. The git remote is
special-cased - it is published verbatim and never passes through path rewriting, so any
`user:password@` in it is stripped at the source.

Two honest caveats. The distillation is mechanical and extractive - it quotes your turns
under fixed headings, it does not summarise, and the brief says so in a banner. And
discovering a transcript relies on an undocumented, version-dependent directory encoding,
so `pack` always prints which file it chose and `--session-file` is there to override a
wrong pick. Separately, the `enclave share create --json` parser is deliberately lenient
because that stdout shape has not yet been captured from a real invocation.

### What handoff is not

- **No `pull`.** `enclave` has no fetch subcommand, and a share url is print-once. The
  recipient opens the link; the brief *is* the page.
- **No raw transcript upload.** enclave allows 13 file extensions, `.jsonl` is not among
  them, and files are capped at 2 MB - a real session transcript is larger. Distilled is
  not a compromise here, it is the only thing that fits.
- **No cross-CLI replay and no session transplant.** Nothing writes into another person's
  home directory, and no adapter resumes someone else's session id.
- **`private` visibility only.** A transcript is production data. `--visibility org` and
  `public` are refused.
- **No signal bus, inbox, or daemon.** That would contradict "Not a workflow server"
  above, and an inbox that starts an agent on someone else's laptop is a different product
  with a much harder threat model.

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
