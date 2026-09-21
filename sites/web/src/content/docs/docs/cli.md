---
title: CLI reference
description: The Breakpoint commands and flags that exist today.
---

The CLI is not a wrapper around the app — it is the same service layer the window calls,
reached through a local socket. Anything the UI can do, a command can do, and both see
the same state.

:::note[Hand-written, for now]
This page is maintained by hand and covers the Phase 1 command set only. Once the command
router lands it will be generated from the router's own route table, so it cannot drift
from what the binary accepts. Commands from later phases — `logs`, `nav`, `shot`,
`check`, and the rest — are deliberately absent until they ship.
:::

## Commands

### `breakpoint <path>`

Opens the project at `<path>`, launching the app if it is not already running. `.` is the
common case.

```sh
breakpoint .
```

If an instance is already running, the arguments are handed to it rather than starting a
second one. There is a single-instance lock, so you never end up with two windows
fighting over the same project.

### `breakpoint open <url>`

Points the current project's panes at a URL.

```sh
breakpoint open http://localhost:3000/checkout
```

### `breakpoint state`

Prints the current state: the project, the panes, their viewports and the layout mode.

```sh
breakpoint state --json
```

This is the command to reach for from a script or an agent — it is the cheapest way to
find out what the window is showing.

### `breakpoint quit`

Shuts the app down cleanly, releasing the single-instance lock.

## Flags

| Flag | Applies to | What it does |
| --- | --- | --- |
| `--json` | all | Emits machine-readable output instead of formatted text |
| `--wait` | `breakpoint <path>` | Blocks until the app is ready and the panes have rendered, then returns |
| `--no-launch` | `breakpoint <path>` | Fails rather than starting the app if it is not already running |
| `--background` | `breakpoint <path>` | Best effort: starts the app without bringing it to the front |

### On `--background`

It is best effort and says so. Launching on macOS without stealing focus is awkward
enough that a guaranteed version was deferred; if focus matters to your workflow, treat
the current behaviour as a convenience rather than a contract.

## Using it from an agent

The pattern that works today is: launch and wait, then read.

```sh
breakpoint . --wait --json
breakpoint state --json
```

Both return structured output, so a coding agent can drive the window it shares with you
rather than spinning up a headless browser you cannot see. The observe-and-verify
commands that make this genuinely useful — reading the console, taking screenshots,
running layout checks — arrive in later phases.
