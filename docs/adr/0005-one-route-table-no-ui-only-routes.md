# One service layer behind one route table, and no UI-only routes

All behaviour lives in main-process services. Every surface — the UI over IPC, the CLI over a
local socket, MCP later — calls the same service method through one route table mapping a
name to a method. Services take and return JSON-serialisable data; no Electron object crosses
the boundary.

The rule that matters, and the one that will be under pressure: **if a surface can cause a
service call, that call is a route.** There is no such thing as a UI-only route, even now,
when the UI is the only surface that exists.

## Consequences

The tempting shortcut is a direct IPC handler for something "only the UI needs". Every such
shortcut is a feature that silently has no CLI or MCP equivalent, and §7.1's parity promise
becomes a retrofit across the whole app rather than a property it always had.

Phase 1 builds two services, `ProjectService` and `PaneService`. The other five named in §8.1
are not stubbed — the expensive thing to retrofit is the boundary, not the file count, and
empty services are guesses that will be wrong.
