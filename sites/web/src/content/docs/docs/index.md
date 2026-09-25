---
title: Breakpoint
description: A multi-viewport dev browser for developers and their coding agents.
---

Breakpoint is a desktop dev browser. You open a project and it renders your site in
several viewports at once — mobile, tablet, laptop, desktop — keeps them in sync, and
shows one console for every pane.

It is also agent-native. Everything you can see or do in the window, a coding agent can
see or do from the command line. The agent edits code, then checks real renders, real
console output and real layout at every breakpoint, in the window you are already
watching.

:::caution[Pre-release]
Breakpoint v0.1.0 is **Phase 1 of 7**. Panes, emulation, presets, layouts, projects and the
CLI foundations are built; the console, sync, screenshots and layout checks are not. These
docs describe what currently exists, not the finished product. Sections for features that
have not been built are absent rather than aspirational.
:::

## Where to start

- **[Install](/docs/install/)** — download it, get past Gatekeeper, and put the CLI on
  your `PATH`.
- **[Quickstart](/docs/quickstart/)** — open a project and get panes on screen.
- **[CLI reference](/docs/cli/)** — the commands that exist today.

## The shape of it

A **project** ties a repo path and a dev command together. Opening one restores the
**canvas**: the set of **panes** you had, at the zoom and layout mode you left them in.

Each pane is a real renderer with its own emulated viewport, device pixel ratio, touch
support, user agent and colour scheme — not an iframe. Service workers, storage and
devtools all behave the way they would in a normal browser tab.

Every pane carries a colour, drawn from a fixed palette of ten hues at one lightness and
one chroma. That colour tags the pane header, its console rows, its layout findings and
the border baked into composite screenshots, so a pane means the same thing everywhere
you see it.
