# Presets are creation-time templates; panes store resolved snapshots

A pane could reference its preset by id and resolve size, DPR and user agent on every read.
Instead a pane stores its own resolved values, and remembers the preset id only for display.

## Consequences

The alternative means editing a preset silently reshapes every saved project that ever used
it — a developer adjusting "Mobile 390×844" would find last month's project laid out
differently with no action of their own and no record of why.

The cost is that a preset edit does not propagate to existing panes. That is the intended
behaviour: presets are a convenience for creating panes, not a live dependency of them.
