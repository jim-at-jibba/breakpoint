---
title: Quickstart
description: Open a project, get panes on screen, and drive them from a terminal.
---

This walks through what exists today: opening a project, getting panes rendering, and
checking them from a terminal.

## 1. Open a project

Start your dev server as you normally would, then point Breakpoint at the directory:

```sh
breakpoint .
```

A **project** is a repo path plus the dev command and URL that go with it. Opening one
restores the canvas you left: the same panes, the same zoom, the same layout mode.

If the app is already running, `breakpoint .` hands the arguments to the running
instance rather than starting a second one.

### Switching between projects

Every project Breakpoint has stored is in the switcher: press `⌘P` on macOS or `Ctrl+P` on
Windows and Linux, or click the project's name in the toolbar. Choosing one swaps the panes,
layout, zoom and URL to that project's stored state without restarting, and the project you
came from is waiting exactly as you left it when you switch back.

Entries are labelled by the last two segments of the repo path, so two git worktrees of one
repo — `breakpoint/main` and `breakpoint/feature-19` — read apart rather than alike. The whole
path is on hover.

The list is the project directory itself rather than an index kept beside it, so it never
disagrees with what is stored. A project whose file Breakpoint cannot read — one written by
a newer build, or one that has been damaged — is listed with the rest and says why when you
choose it, instead of quietly disappearing.

## 2. Read the canvas

Three panes open by default — mobile, tablet and desktop. Each has its own emulated
viewport width, device pixel ratio and colour scheme, and each carries a colour from the
pane palette.

There are two layouts:

- **Horizontal** lines the panes up so you can compare neighbours.
- **Focus** gives one pane full size and drops the rest to a strip.

Zoom is a separate control. Its value is a percentage, or `Fit`, which sizes the whole set
to the window the way a PDF reader does — and the moment you touch the zoom control you are
no longer fitted. Fit is a zoom value, not a third layout.

## 3. Navigate

There is one address bar, and it points every pane at the same URL. Type `3000` and press
Enter: a bare port is the dev server on this machine, so starting work is two keystrokes.

The same navigation is available from a terminal, which is how an agent reaches the state
that reproduces a bug:

```sh
breakpoint open 3000
breakpoint open localhost:3000/checkout --json
```

Navigation from a terminal is held to the project's **allowed origins**; typing in the
address bar and clicking links inside a pane never are. Edit the list from the **Origins**
button in the toolbar. The [CLI reference](/docs/cli/#allowed-origins) has the rules.

## 4. Check it from a terminal

Everything the window knows, the CLI can print:

```sh
breakpoint state --json
```

That is the contract the agent integration is built on: one service layer, called
identically by the UI and by the command router. If the window can do it, a command can
do it.

To wait for the app to be ready before reading state — useful in a script, and the way a
coding agent should drive it:

```sh
breakpoint . --wait --json
```

## Next

The [CLI reference](/docs/cli/) covers the commands and flags that exist today.
