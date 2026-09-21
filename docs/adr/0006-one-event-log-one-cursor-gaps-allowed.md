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

Three things fell out of building it (#9) that are worth keeping written down.

**`droppedBefore` marks the first intact position, not the reader's own.** A reader asks for
everything *after* its cursor, so a reader whose own position was evicted has missed nothing:
it already had that entry. The marker appears only when something *after* the position asked
from is gone, and it is the position from which the read is complete. Entries below it may
still be returned — a quiet pane keeps its history while a noisy one evicts — so it is a
completeness boundary, never a line to trim the returned entries at.

**A truncated read is never an empty one.** A ring that has evicted anything still holds the
entries above what it evicted, so the marker and an empty `entries` cannot occur together.
That is what makes an empty read unambiguously quiet.

**The log reaches the route table as a store, not behind a service.** PRD 8.1's service list
does not name one, and ADR-0005 asks that adapters hold no behaviour — not that every route
noun be a service. A `LogService` over this would be pure delegation, so `log.read` calls the
store. `AppService` is the reverse case and stays a service because quitting is behaviour.

**Read limits count bytes as well as entries.** A read stops at 1,000 entries or its
serialized UTF-8 byte budget, whichever comes first, and leaves its cursor at the last
returned entry. The budget reserves space for the success envelope and the largest
accepted request id (1 KiB of JSON-encoded UTF-8). Entry `path` and `message` fields are
shortened to 16 KiB of JSON-encoded UTF-8 on reads, with `truncated` naming the shortened
fields. This guarantees that even a single oversized project failure can be delivered
and passed by cursor. Text truncation does not change stored history or imply eviction.

**Stored entries are immutable.** Appending freezes the record; reads expose readonly,
frozen results. Read-time truncation creates a new frozen record instead of editing the
one retained in the log.
