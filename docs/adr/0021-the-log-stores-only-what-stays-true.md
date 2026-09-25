# The log stores only what stays true

C8 wants lazily expandable object trees "backed by live remote objects", with static previews
kept across navigation. A `RemoteObjectId` is valid only while the execution context that
minted it lives, and ADR-0006 freezes entries permanently. Storing the handle on the entry
would put a field in the log that is right for seconds and wrong for the rest of history, in
a record an agent reads by cursor.

An entry therefore carries level, text, a preview per argument, source location and a trimmed
stack — data as true a week later as it was on arrival. Handles live in a side table in
`PaneService`, keyed by cursor and cleared on `Runtime.executionContextsCleared`. Expansion is
a route taking a cursor, answering with properties or with "no longer live".

## Consequences

"Previews survive navigation, expansion does not" becomes a property of the design rather than
a bug report someone files later.

Every stored entry stays JSON-serialisable, which ADR-0005 requires of everything crossing the
service boundary.

The rule generalises past objects: anything whose truth expires belongs beside the log rather
than in it.
