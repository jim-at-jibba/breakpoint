# Console rows are fixed-metric

Issue #5 set C4's five-column row against §10's 2,000 entries per second, and proposed fixing
every column but the message to a 22px line box while letting the message wrap. That narrows
what varies without removing measurement, and measuring every row is where the frame budget
goes.

Rows are therefore fixed height, with the message clamped to one line and expanded on click,
and wrapping available as a toggle. A list moving at 2,000 entries per second is unreadable at
any row height, so wrapping buys nothing while the stream is live; when it is quiet, one click
costs nothing. DevTools clamps for the same reason.

## Consequences

§8.2 chose react-virtuoso for "variable row heights and stick-to-bottom". The first reason is
now gone, so the console uses TanStack Virtual, which §8.2 already names as the alternative.
What remains hard is scroll anchoring under load — staying pinned to the bottom unless the
developer has scrolled up, and not jumping as entries evict — and that is the part worth
taking from a library.

The throughput claim is asserted as a deadline the app must answer a route within while 2,000
entries arrive, because "without jank" cannot be measured from outside the window, and an
unmeasurable criterion passes by default (ADR-0004).
