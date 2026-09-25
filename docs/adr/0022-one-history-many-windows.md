# One history, many windows

C9 asks for Clear and for preserve log. The obvious implementation truncates. But the log is
shared history that the CLI reads by cursor and MCP will, and ADR-0005 leaves nowhere to hide
a UI-only mutation — so a developer tidying their console would silently destroy the history
an agent was part-way through reading.

Clear therefore sets a **display floor**: the position below which one window shows nothing.
The log is untouched, and `breakpoint logs --since 0` still returns everything. The floor
belongs to that window alone and no read consults it; the CLI's equivalent is the `--since`
it passed.

## Consequences

Preserving the log across navigation is free, because preserving is simply what the log does.
*Not* preserving becomes a floor moved on navigate, which is the smaller feature and the one
that can be a setting.

The floor is a route and appears in the snapshot so a window can restore it — `app.setSwitcher`
is the precedent — but that is a window restoring its own view, never a surface publishing a
filter to other surfaces.

`PaneStatus.errors` follows the same rule and resets on its pane's navigation only. A count
that any view action can zero is a count no surface can trust.
