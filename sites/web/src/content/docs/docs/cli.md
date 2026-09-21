---
title: CLI reference
description: The Breakpoint commands, flags, exit codes and routes that exist today.
---

The CLI is not a wrapper around the app — it is the same service layer the window calls,
reached through a local socket. Anything the UI can do, a command can do, and both see
the same state.

:::note[Only what exists]
Every command, flag, exit code, error code and route on this page is one the binary
accepts today. Commands from later phases — `open`, `nav`, `shot`, `check`, and the
rest — are deliberately absent until they ship, and this page grows in the same change
that ships them.
:::

## Commands

### `breakpoint .` and `breakpoint <path>`

Opens the project for that repo, creating it the first time and reusing it every time
after. If the app is not running it is started first; if it is, the running window
switches to the project.

```sh
breakpoint .              # the repo you are in
breakpoint ../store       # a sibling repo
breakpoint . --json       # print the project as JSON
```

A path is `.`, `..`, or anything containing a slash. A bare word is always read as a
command, so a typo is a usage error rather than a project called `stat`. Relative paths
resolve against the terminal's working directory, and every route to the same directory
— a symlink, a trailing slash, a `..` in the middle — is the same project.

A new project is named after its directory, starts on `http://localhost:3000`, allows
that origin, and has three panes: Mobile 390×844 @3x, Tablet 820×1180 @2x and Desktop
1440×900 @1x.

The path has to be a directory that exists, or the command fails with `INVALID_PARAMS`.
A project whose stored file this build will not read — one written by a newer
Breakpoint, or one that is corrupt — fails with `PROJECT_UNREADABLE`, and the file is
left exactly as it was.

### `breakpoint state`

Prints the open project: name, repo path, start URL, panes, and the event log cursor the
snapshot was taken at. With `--json` this is the snapshot the window itself renders from.

```sh
breakpoint state
breakpoint state --json | jq .project.panes
breakpoint state --json | jq .cursor        # hand this to `logs --since`
```

If nothing is open, `project` is `null` and the text output says so. The JSON payload
carries `cursor` either way.

### `breakpoint logs`

Prints what the event log holds after a cursor position. The log is one append-only
record of everything Breakpoint observes, and every entry carries a position on a single
monotonic cursor.

```sh
breakpoint logs                      # everything the log still holds
breakpoint logs --since 12           # only what followed position 12
breakpoint logs --since 12 --json | jq .entries
```

Take the cursor from `breakpoint state`, do some work, and ask from it: an agent reading
this way is told what happened and nothing it has already seen.

Every entry is tagged with the pane it came from, or with `null` when Breakpoint itself
produced it. The app's own failures are in here — a project that refuses to load is an
untagged entry — which is what makes the log the one channel worth polling.

```json
{
  "entries": [
    {
      "cursor": 1,
      "time": 1763731200000,
      "pane": null,
      "type": "project.openFailed",
      "path": "/Users/you/code/shop",
      "code": "PROJECT_UNREADABLE",
      "message": "/Users/you/code/shop: written by a newer Breakpoint"
    }
  ],
  "cursor": 1
}
```

`cursor` at the top level is the position to ask from next, whether or not anything was
read. It is there even when `entries` is empty, so a poll never has to read the last
entry to know where it got to.

Entries are ring-buffered per pane at 10,000, so a busy pane cannot push every other
pane's history out of the log. That means positions are ordered but **not contiguous**,
and a reader that falls far enough behind can be asking from a position whose entries
have been evicted. Then, and only then, the payload carries `droppedBefore`:

```json
{ "entries": [ … ], "cursor": 11481, "droppedBefore": 10482 }
```

From `droppedBefore` on, the read is everything there was. Below it, some entries are
gone and others are still returned — a quiet pane keeps its history while a busy one
evicts — so it marks where the read becomes complete and is never a line to trim the
entries at. No `droppedBefore` at all means the read is complete, which is what makes an
empty read genuinely quiet rather than possibly truncated. A read that is asking from a
position whose own entry was evicted has missed nothing and is not marked: the read
starts *after* that position.

One read carries at most 1,000 entries, because a response is one line of at most 1 MiB.
When there is more, `cursor` is the last entry returned rather than the head of the log,
so asking again from it continues where the last read stopped. Reading until `entries`
comes back empty is the way to drain it.

What the log carries today is the app's own failures. Every other producer — pane
lifecycle, navigation, the console, network — arrives with the feature that observes it,
in this same payload and on this same cursor.

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
| `--since <cursor>` | `logs` only. Reads what followed that cursor position. `--since=12` is the same flag |
| `--no-launch` | Exits 3 rather than starting the app if it is not running |
| `--verbose` | Prints diagnostics on stderr, where they cannot pollute stdout |
| `--help`, `-h` | Prints the help and exits 0 |

`--json` has to be passed explicitly today, `state` included. Turning it on automatically
when stdout is not a terminal is a later change.

## Output

One rule, and every command inherits it:

- **stdout carries the payload and nothing else.** With `--json` that is exactly the
  route's payload object, so `jq` never has to skip a line.
- **stderr carries everything else** — diagnostics, progress, and the message that goes
  with a non-zero exit.

Failures include a stable error code. With `--json`, the error diagnostic on stderr is
`{ "error": { "code": "APP_NOT_RUNNING", "message": "the app is not running" } }`;
stdout stays empty. `--verbose` adds separate diagnostic lines on stderr.

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
first five come back from the app; the rest are raised by the command itself.

| Code | Exit | Meaning |
| --- | --- | --- |
| `UNKNOWN_ROUTE` | `1` | There is no route by that name |
| `INVALID_REQUEST` | `1` | The request was not a route envelope |
| `INVALID_PARAMS` | `1` | The params were not what the route takes |
| `INTERNAL_ERROR` | `1` | The route failed |
| `PROJECT_UNREADABLE` | `1` | The project's file is on disk but this build will not load it. `details.reason` is `newer` or `corrupt`, and `details.file` is the path |
| `INVALID_USAGE` | `2` | The arguments could not be parsed |
| `APP_NOT_RUNNING` | `3` | Nothing is listening, and `--no-launch` was passed |
| `LAUNCH_FAILED` | `1` | The app could not be started, or never opened its socket |
| `TIMEOUT` | `1` | The app accepted the connection but did not answer in time |
| `TRANSPORT_ERROR` | `1` | The connection failed, or the reply could not be read |

## Routes

Commands are a surface over the route table, and so are the window and — later — MCP.
Every route is reachable from every surface; there is no window-only behaviour.

| Route | Params | Payload | Reached by |
| --- | --- | --- | --- |
| `app.quit` | none | `{ "quitting": true }` | `breakpoint quit` |
| `log.read` | `{ "since": 12 }`, or none for the whole log | `{ "entries": [], "cursor": n, "droppedBefore"? }` | `breakpoint logs` |
| `project.open` | `{ "path": "/abs/repo" }` | the state snapshot | `breakpoint .`, `breakpoint <path>` |
| `project.state` | none | the state snapshot | `breakpoint state` |

The state snapshot is `{ "revision": n, "cursor": n, "project": … }`, where `project` is
`null` until one is opened, and otherwise carries `name`, `repoPath`, `startUrl`,
`allowedOrigins`, `panes`, `layout`, `zoom` and `sessions`. Each pane has an `id`,
`name`, `width`, `height`, `dpr`, `mobile` flag, `colorScheme`, `session` and the
`preset` it was made from. `revision` counts the changes the app has announced to its
window; a script can ignore it. `cursor` is the event log position the snapshot was
taken at.

`since` must be an integer of 0 or more; anything else is `INVALID_PARAMS` from the
route and a usage error from the command, which never sends it.

On the socket the exchange is one line of JSON each way. Each request or response line
is limited to 1 MiB of UTF-8, excluding the terminating newline. An oversized request
closes its connection; an oversized response causes the CLI to report `TRANSPORT_ERROR`.

For example:

```json
{ "id": "1", "route": "project.open", "params": { "path": "/Users/you/code/shop" } }
{ "id": "1", "ok": true, "data": { "revision": 1, "cursor": 0, "project": { "name": "shop", … } } }
```

and a failure carries the code instead:

```json
{ "id": "1", "ok": false, "error": { "code": "UNKNOWN_ROUTE", "message": "no route named nope.nope" } }
```

`--json` prints the `data` object alone — never the envelope around it.

## Using it from an agent

The socket lives in Breakpoint's own data directory with owner-only permissions, and it
is on by default — there is no configuration step and no first command that fails.

The shape a harness wants is already here: take `cursor` from `breakpoint state`, do the
work, then `breakpoint logs --since <cursor> --json`. What the log carries grows with
each phase — the console, network and layout producers arrive with the features that
observe them — and the cursor it is read by does not change.
