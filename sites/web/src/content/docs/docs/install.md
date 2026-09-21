---
title: Install
description: Building and running Breakpoint from source.
---

There is no packaged build yet. Until one is notarised and published, Breakpoint runs
from source.

## Requirements

- **macOS 13 or later, Apple silicon.** Windows and Linux render identically but are not
  packaged or polished yet.
- **Node.js 22 or later.**
- **Git.**

## Build and run

```sh
git clone https://github.com/jim-at-jibba/breakpoint.git
cd breakpoint
npm install
npm run dev
```

`npm run dev` starts the app with hot reload for the renderer. The main process restarts
on change.

## Other scripts

| Command | What it does |
| --- | --- |
| `npm run build` | Type-checks, then builds main, preload and renderer |
| `npm run build:mac` | Builds and packages a macOS app with electron-builder |
| `npm run build:unpack` | Builds an unpacked directory, useful for debugging packaging |
| `npm run typecheck` | Type-checks the node and web projects |
| `npm run test:unit` | Vitest, over the shared module both processes import |
| `npm run test:e2e` | Builds, then Playwright launches the real app and drives it with the CLI |
| `npm test` | Both |
| `npm run lint` | ESLint across the repo |
| `npm run format` | Prettier across the repo |

## The `breakpoint` command

The CLI is the same binary as the app, so there is nothing separate to install. What
there is not yet is a launcher that puts itself on your `PATH` — "Install command line
tool" is a Phase 5 item. Until then the repo ships a shim you can symlink by hand:

```sh
npm run build
ln -s "$PWD/bin/breakpoint" /usr/local/bin/breakpoint
breakpoint --help
```

The shim runs the CLI under the app's own Electron runtime in Node mode, so it needs no
separate Node installation — but it does need `npm run build` to have produced
`out/main/cli.js`, and it will tell you so if it has not.

See the [CLI reference](/docs/cli/) for what the commands do.
