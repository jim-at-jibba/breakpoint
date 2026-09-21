# "Attachment" names the CDP session; "session" stays with the storage partition

Breakpoint has two things the PRD called a "session": the debugging connection to a pane
(§8.3, §8.6) and the isolated cookie and storage store panes can be assigned (§6.5). Every
pane and console ticket read ambiguously as a result.

**Session** keeps its meaning as the storage partition, because Electron's own API already
means storage by it — `session.fromPartition()` returns a `Session` — and fighting the
platform's vocabulary costs us at every call site. The debugging connection is an
**attachment**.

## Consequences

A reader coming from the CDP or Electron docs will see "attachment" where those docs say
"session". That is the intended trade: the ambiguity is pushed to the one boundary where a
reader is already switching vocabularies, instead of living inside our own codebase.
