# No paused state while DevTools is open

§12 item 2 specified a fallback: "detect detach, show 'paused while DevTools is open',
reattach". The spike found nothing to detect. Opening real DevTools on a pane never evicted
our attachment — events kept firing, no `detach` arrived, no command timed out, and an
explicit reattach was refused with "Debugger is already attached to the target".

The paused state is dropped entirely.

## Consequences

The sharper reason to record this rather than simply deleting the requirement: **there is no
detach signal to build a fallback on.** If some future Electron does evict the attachment,
the evidence suggests it will go quiet rather than announce itself, so any future paused
state must key on heartbeat staleness, not on an event. One case remains untested — DevTools
opened *before* attach — which is worth a line of coverage in Phase 2.
