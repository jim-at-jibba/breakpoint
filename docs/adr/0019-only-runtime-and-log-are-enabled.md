# Only Runtime and Log are enabled

§8.6 item 1 says the attachment enables `Runtime`, `Log`, `Network` and `Page`. Two of those
are unnecessary and one is the risk §12 item 8 already names — CDP event volume with six or
more panes, whose own mitigation is "enable `Network` lazily".

C3 asks for browser-generated entries: network failures, CORS, mixed content, CSP,
deprecations. Every one of them arrives as `Log.entryAdded` carrying a `source`. None needs
the `Network` domain, which exists to describe requests rather than to report their failure.
`Page` would be a second source of a truth the pane host already holds: `did-navigate` is
already the navigation signal and already drives the emulation reapply.

So the attachment enables `Runtime` and `Log`, and nothing else. `Network` arrives with
Phase 7's network panel, the first consumer that needs request objects. `Page` is enabled if
and when something needs a frame event Electron does not expose, and not before.

## Consequences

This amends §8.6. A network failure in Phase 2 carries no request id anything can correlate,
because nothing is listening for requests — the entry says what failed, not which request it
was. That is the whole of C3 and none of R1 and R2, which is the split the phases assume.

`Runtime.enable` replaying buffered messages is what satisfies C1's "including before app
scripts run", and it is the only thing that does. The replay is therefore load-bearing on the
attach path, including the retry after `did-stop-loading`.

The message listener is registered before the emulation calls, not after. Issue #4 recorded
one rejected `Emulation` call costing a pane the rest of its attach; the same ordering hazard
would cost it the console, which is worse — a degraded pane that renders is visible, and a
pane that silently reports nothing is not.
