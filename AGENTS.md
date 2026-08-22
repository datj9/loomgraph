# AGENTS.md

Rules for any agent or contributor changing this repository.

## Commands

```bash
npm ci               # install
npm run typecheck    # tsc --noEmit, must exit 0 before any commit
npm test             # vitest run, must exit 0 before any commit
npm run build        # tsup, emits dist/
node dist/cli.js run examples/hello.yaml   # smoke test, zero cost
```

## Hard rules

- **Tests never spawn a real agent CLI.** No test may execute `claude`, `codex`, `opencode`, `enclave`, or `git`, and no test may make a network request. Adapter tests parse fixture strings; engine tests inject stub adapters through the registry argument; `src/handoff/` routes every spawn - including `opencode export` and `enclave push` - through an injected `Exec` seam that tests replace with a fake.
- **Never invent cost numbers.** If a CLI does not report a price, record `0`. Do not derive cost from a token count and a price table anywhere in this codebase.
- **Checkpoint after every edge crossing.** Not at the end of a batch, not at the end of the run. `CheckpointStore.save` writes a temp file and renames it; never write `state.json` in place.
- **The event log is append-only and unbuffered.** A killed process must leave a readable JSONL log. Do not add buffering or rewrite past lines.
- **Graph validation stays loud.** Unknown node ids, cycles, missing budgets and unknown adapters throw with the offending node id in the message. Do not downgrade a validation error to a warning.
- **No LLM SDK dependency.** The agent CLIs are the runtime. Adding an API client to `dependencies` is out of scope for this project.
- **Adapter output is a contract.** Every adapter returns `{ ok, text, costUsd, raw, error }`. Cost is recorded even when the run failed, because budget accounting depends on it.

## Adding an adapter

1. Export a pure parser (`parseXJson(stdout)`) and a pure argv builder (`buildXArgs(...)`).
2. Unit-test both against captured fixture strings from a real CLI invocation you ran by hand.
3. Register it in `src/adapters/registry.ts` and add it to `ADAPTER_NAMES` in `src/core/graph.ts`.
4. If you have not run the real binary, say so in a header comment and mark it experimental in the README.

## Layout

```
src/core/       types, store, events, graph, budget, engine  (no CLI concerns)
src/adapters/   one file per executor, plus the registry
src/commands/   CLI command implementations and pure renderers
src/handoff/    the `lg-handoff` bin: session readers, secret scanner, brief renderer
examples/       graph files that must stay valid (`lg validate`)
```

Nothing under `src/handoff/` may import from `src/core/` or `src/adapters/`. The subtree
owns its own enclave helpers so it stays extractable into a sibling package with a `git mv`.
That is why `buildEnclavePushArgs` exists twice and neither copy should be deduplicated
into a shared module.

Inside `src/handoff/`, one file per job, and the data flows one way:

```
readers/*.ts  transcript text  -> DistilledSession   pure; the narrowing boundary
scan.ts       text             -> ScanFinding[]      pure; also rewritePaths
render.ts     DistilledSession -> md / html / txt    pure; escapes everything
bundle.ts     the 4 files      -> disk               + the enclave limit check
enclave.ts    argv builders and stdout parsers       pure
commands.ts   pack / scan / push                     the only place that spawns
cli.ts        commander wiring                       the only place that reads argv
```

Two rules that are the point of the subtree, not incidental:

- **The readers drop, they do not carry.** Tool results, attachments, file-history
  snapshots, codex `base_instructions` and permission modes must never reach a
  `DistilledSession`. Adding a field to that type means deciding it is safe to publish.
- **The gates fail closed.** Anything the scanner cannot read becomes a finding, not a
  skip - an empty result means "safe to publish" to every caller. If you add a path
  where scanning can be skipped, `push` must refuse rather than proceed.

Pure functions (`readySet`, `interpolate`, `planLevels`, `renderStatus`, `checkBudget`, every parser) are exported so they can be unit-tested directly. Keep them pure.

## Forbidden paths

Never commit `dist/`, `node_modules/`, `.loomgraph/`, `.env`, or any token.

## Commits

Conventional commits: `feat:`, `fix:`, `test:`, `chore:`, `docs:`. Imperative mood, lowercase subject, no emoji, no trailers. One logical change per commit, with a green `npm run typecheck && npm test` behind it.
