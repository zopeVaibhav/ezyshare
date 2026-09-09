# Contributing

Thanks for taking a look. Issues and pull requests are both welcome.

## Getting set up

```bash
bun install     # installs dependencies and the git hooks
bun run build   # compiles the extension into dist/extension
bun test        # 69 tests, about two seconds
```

Then start a daemon and load the extension as the [README](README.md#install-do-this-on-every-machine) describes.

Testing a change to sharing usually needs two daemons. They can both run on one machine,
as long as they use different ports and their own state directories:

```bash
./start.sh --name Alpha --port 8787 --discovery-port 38477 --dir /tmp/a --peer 127.0.0.1:8788
./start.sh --name Beta  --port 8788 --discovery-port 38478 --dir /tmp/b --peer 127.0.0.1:8787
```

`--peer` is needed here because announces are only trusted from a real network interface,
so two daemons on loopback will not discover each other on their own.

## Layout

```
daemon/ezyshare.ts        entry point: parse flags, wire it up, start
daemon/src/               stores, guards, discovery, one handler per route
daemon/src/schemas/       zod schemas, one per boundary
extension/src/            side panel and service worker
tests/                    bun:test, mirrors the module it covers
scripts/                  build the extension
```

There is no build step for the daemon. bun runs the TypeScript directly, and Node 22.6+
does too. `tsc --noEmit` is what checks the types.

## Before you open a pull request

```bash
bun run check
```

That runs formatting, lint, types and tests — the same thing CI runs. The `pre-push` hook
runs it too, so a push that would fail CI is stopped locally.

## What the review looks for

- **A test for anything security-relevant.** If a change closes a hole, add the test that
  fails without it. `tests/url-filter.test.ts` and `tests/inbox-guard.test.ts` are the
  pattern to copy.
- **Validation at the boundary.** Anything arriving from the network or from disk goes
  through a zod schema, not a hand-written check.
- **Comments only where the code cannot speak.** Most of this codebase has none. The ones
  that exist explain why a line is there, usually because deleting it would quietly
  reintroduce a bug. Keep that bar.
- **Errors that do not leak.** The daemon deliberately returns vague failures on the send
  path, because a precise one turns a click into a port scanner.

## Style

Prettier and ESLint decide formatting and lint, so there is nothing to argue about: 4-space
indent, double quotes, 100 columns. Comment blocks look like this, indented with the code
they sit above:

```ts
/*
    First address and port win for the life of the entry, or anyone who overhears a
    broadcast can re-announce that id and quietly become that peer.
*/
```

Commit messages are lowercase and short: `fix remote crash, url bypasses and peer lockout`.

## Reporting security problems

Please do not open a public issue. [SECURITY.md](SECURITY.md) has the details, including
what is already known to be out of scope.
