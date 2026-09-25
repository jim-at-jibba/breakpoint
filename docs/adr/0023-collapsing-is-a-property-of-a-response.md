# Collapsing is a property of a response, not of history

C7 collapses identical messages from several panes into one row carrying pane badges, and
§8.6 item 4 puts dedupe "at read time". Read as a property of history, that breaks the cursor:
a collapsed row spans several positions, and a group can gain a pane *after* a reader has been
handed it, so an incremental reader would have to treat data it already holds as mutable.

Collapsing therefore applies within the result set of one read and never across reads. A read
from position zero collapses fully; an incremental poll collapses little, which is correct,
because those messages did arrive separately. The window collapses continuously over the
entries it retains, which is a view doing what views do.

## Consequences

§8.6's "at read time" stands, narrowed to one read. Issue #5's "collapsing is the default
view, not a filter" holds for the console without becoming a property of the log.

Two surfaces can honestly disagree about how many rows there are while agreeing exactly about
what happened.
