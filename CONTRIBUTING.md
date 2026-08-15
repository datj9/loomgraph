# Contributing

Thanks for looking at loomgraph. It is a small, boring TypeScript CLI on purpose.

## Setup

```bash
git clone <your fork>
cd loomgraph
npm ci
npm run typecheck && npm test && npm run build
node dist/cli.js run examples/hello.yaml
```

Node >= 22 is required (`execa` v10 uses `Set.prototype.union`, which lands in Node 22).

## Working on a change

1. Write the test first. Every behavior in `src/core/` and `src/adapters/` has one.
2. Keep tests offline: no test may spawn `claude`, `codex`, or `opencode`, or reach the network. Use fixture strings for adapters and stub adapters for the engine.
3. Run `npm run typecheck && npm test` before you commit — both must exit 0.
4. Use conventional commit messages (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).

The engineering rules that matter — checkpoint timing, cost honesty, adapter contract — are in [AGENTS.md](AGENTS.md). Read it before changing the engine or adding an adapter.

## Scope

v0.1 deliberately excludes: a web UI, a server or daemon, cloud execution, a plugin system, and any LLM API call made by loomgraph itself. Pull requests adding those will be asked to shrink.

Good first contributions: a new adapter with fixture-based tests, better error messages from graph validation, and `lg metrics` over the existing event log.

## Reporting bugs

Include the graph file, the `lg events <runId>` output, and the loomgraph and agent CLI versions. The event log is usually enough to reconstruct the failure.

## License

By contributing you agree that your contributions are licensed under the MIT License.
