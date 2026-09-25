# Contributing

Breakpoint is MIT licensed and open to contribution. It is also pre-v1 and moving fast —
Phase 1 of seven is done, so expect churn.

## Issues are the most useful thing you can send

Bug reports and feature discussion live as [GitHub issues](https://github.com/jim-at-jibba/breakpoint/issues).
A report that names the pane size, the host OS and what the event log said is worth more
than a patch, because most of what is missing is still being designed rather than written.

If you are reporting something on Windows or Linux, check the known defects in the
[README](README.md#platform-support) first — several are already recorded.

## Before opening a pull request

Open an issue first for anything beyond a typo. The architecture is settled in
[`docs/adr/`](docs/adr/) and the vocabulary in [`CONTEXT.md`](CONTEXT.md); a change that
cuts across either is a conversation before it is a diff.

## Working in this repo

```sh
npm install
npm run dev
```

Run before pushing:

```sh
npm run lint
npm run typecheck
npm run test:unit
```

`npm run test:e2e` builds the app and drives it with Playwright. **Quit any running
Breakpoint first** — the app takes a single-instance lock, and a running instance makes the
Playwright launch time out in a way that looks like a regression.

## House rules

These are not style preferences; they are the ones that break things when ignored.

- **Use the vocabulary in [`CONTEXT.md`](CONTEXT.md)** in code, commits and issues. It lists
  what each term means and what to avoid calling it.
- **Never invent a design token.** Values come from `docs/design/breakpoint-prototype/globals.css`.
  Add it there first, then use it. No raw hex, no ad hoc pixel values.
- **shadcn/ui components are generated, never hand-written** — `npx shadcn@latest add <component>`.
- **The Docs may not fall behind the CLI.** `src/shared/cli-reference.test.ts` checks the
  reference at `sites/web/src/content/docs/docs/cli.md` against what the code declares, in
  both directions, and parses every `breakpoint …` example in the Docs and the README with
  the CLI's own parser. Add a flag, document it in the same change.

[`AGENTS.md`](AGENTS.md) has the longer version, and is worth reading if you are pointing a
coding agent at this repo.
