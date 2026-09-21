# One event log, one cursor, and gaps are allowed

§8.6 asks for a single append-only log with a monotonic cursor, and for per-pane ring
buffering at 10,000 entries. Those pull against each other: evicting one pane's old entries
punches holes in a globally ordered sequence.

We keep one log and one cursor, tag entries with their pane, and let eviction create gaps.
Reads return a `droppedBefore` marker so a reader can distinguish "nothing happened" from
"you were too slow".

## Consequences

Without the marker, §7.1's cursor-based promise would be quietly false — an agent polling
`since` would see a shorter list and conclude the app was quiet. Consumers must treat cursor
positions as ordered but not contiguous.

The log is built in Phase 1, before the console needs it, because pane lifecycle, navigation
and emulation are real producers and the cursor is better proven by them than by the console
discovering its flaws in Phase 2. The app's own errors go in the same log, untagged by pane.
