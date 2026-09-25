# Source maps resolve before the entry is appended

C5 is P0 because agents need file paths rather than bundle offsets. ADR-0006 froze stored
entries. Resolution is asynchronous. Those three cannot all be satisfied without choosing
where resolution happens: before the append, after it as a superseding entry, or at read time.

Read-time resolution has precedent — read-time truncation already mints a new frozen record
instead of editing the retained one — and is wrong anyway, because a source map is a live
artifact. The agent loop reads *after* an edit, which is exactly when the dev server has
rebuilt and the map that explained the error is gone. Superseding makes every reader implement
a join to obtain the field the requirement calls P0.

Resolution therefore happens before the append, bounded by a timeout. On timeout or failure
the entry appends with its raw location and a flag saying resolution failed. A late entry is
worse than an unresolved one: the console's ordering and the cursor's meaning both depend on
entries arriving when they happened.

Discovery is URL arithmetic first — a dev server asked for `/src/App.tsx` has already told you
the repo path — and only where that names no file on disk does it fetch the script and its
map. `Debugger.enable` would report `sourceMapURL` exactly, and is not worth a third domain
for a field a path join usually answers; it can be added later without changing the entry.

## Consequences

The resolution-failed flag is part of the contract rather than a diagnostic. `repoPath` is
null for repo-less projects (ADR-0015), so an unresolved location is an ordinary outcome and
never an error.

Both discovery paths need a fixture. One shaped only like a dev server would prove the
arithmetic and ship the fetch untested, with the first real webpack project as its test.
