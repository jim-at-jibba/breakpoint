# Parity is a property of the route table, not of the CLI's commands

C10 puts the REPL in Phase 2; §7.3 holds `breakpoint eval` until Phase 6, behind the Evaluate
tier. Shipping the REPL therefore creates `panes.evaluate`, a route with no CLI command, which
looks like exactly the parity hole ADR-0005 exists to prevent. The alternative is deferring a
P0 console feature four phases to protect a tier that does not exist yet.

Parity means every surface can reach the route table. It does not mean every surface publishes
every route in every phase. A permission tier's entire job is to gate one surface's access to
a route that already exists — if a route had to wait for its tier, tiers would gate nothing.

So the REPL and `panes.evaluate` ship in Phase 2, and `breakpoint eval` ships in Phase 6 with
the tier that governs it.

## Consequences

This is the rule Phase 6 would otherwise relitigate under pressure, once act tools make the
same shape appear for click, type, press, scroll and hover. It is cheaper to settle now,
against a feature whose only user is the developer sitting in front of the window.

ADR-0005 is unchanged: there is still no UI-only route. `panes.evaluate` is reachable by every
surface. What differs is which surfaces have been handed a command for it.
