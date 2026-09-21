---
title: CLI reference
description: The Breakpoint commands, flags, exit codes and routes that exist today.
---

The CLI is not a wrapper around the app — it is the same service layer the window calls,
reached through a local socket. Anything the UI can do, a command can do, and both see
the same state.

:::note[Only what exists]
Every command, flag, exit code, error code and route on this page is one the binary
accepts today. Commands from later phases — `open`, `state`, `logs`, `nav`, `shot`,
`check`, and the rest — are deliberately absent until they ship, and this page grows in
the same change that ships them.
:::

## Commands

### `breakpoint quit`

Shuts the app down cleanly, releasing the single-instance lock.

```sh
breakpoint quit
```

If nothing is running, `quit` starts the app and then quits it, because every command
connects first and launches second. Pass `--no-launch` when you want the check rather
than the launch:

```sh
breakpoint quit --no-launch   # exits 3 if the app is not running, and starts nothing
```

## Flags

| Flag | What it does |
| --- | --- |
| `--json` | Prints the route's payload object on stdout and nothing else |
| `--no-launch` | Exits 3 rather than starting the app if it is not running |
| `--verbose` | Prints diagnostics on stderr, where they cannot pollute stdout |
| `--help` | Prints the help and exits 0 |

`--json` has to be passed explicitly today. Turning it on automatically when stdout is
not a terminal arrives with the commands that print state worth piping.

## Output

One rule, and every command inherits it:

- **stdout carries the payload and nothing else.** With `--json` that is exactly the
  route's payload object, so `jq` never has to skip a line.
- **stderr carries everything else** — diagnostics, progress, and the message that goes
  with a non-zero exit.

Which means a verbose run still pipes cleanly:

```sh
breakpoint quit --json --verbose | jq .quitting
# stderr: breakpoint: socket /Users/you/Library/Application Support/Breakpoint/breakpoint.sock
# stderr: breakpoint: connected, calling app.quit
# stdout: true
```

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The command succeeded |
| `1` | An unexpected error |
| `2` | The arguments could not be parsed |
| `3` | The app is not running or is unreachable |
| `4` | Reserved. Denied by a permission tier, from Phase 6 |
| `5` | Reserved. Paused by the user, from Phase 6 |

## Error codes

Stable strings, so a script can branch on the failure rather than on its wording. The
first four come back from the app; the rest are raised by the command itself.

| Code | Exit | Meaning |
| --- | --- | --- |
| `unknown_route` | `1` | There is no route by that name |
| `invalid_request` | `1` | The request was not a route envelope |
| `invalid_params` | `1` | The params were not what the route takes |
| `internal_error` | `1` | The route failed |
| `invalid_usage` | `2` | The arguments could not be parsed |
| `app_not_running` | `3` | Nothing is listening, and `--no-launch` was passed |
| `launch_failed` | `1` | The app could not be started, or never opened its socket |
| `transport_error` | `1` | The connection failed, or the reply could not be read |

## Routes

Commands are a surface over the route table, and so are the window and — later — MCP.
Every route is reachable from every surface; there is no window-only behaviour.

| Route | Payload | Reached by |
| --- | --- | --- |
| `app.quit` | `{ "quitting": true }` | `breakpoint quit` |

## Using it from an agent

The socket lives in Breakpoint's own data directory with owner-only permissions, and it
is on by default — there is no configuration step and no first command that fails. The
observe-and-verify commands that make this genuinely useful — reading the console,
taking screenshots, running layout checks — arrive in later phases.
