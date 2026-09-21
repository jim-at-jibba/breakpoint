# Emulation overrides are not reapplied on renderer process swap

§8.5 says emulation is "reapplied on attach and after any render-process swap", and §12
item 3 rated a silent reset as trust-destroying. The Phase 0 spike measured the opposite:
across six panes, every one genuinely swapped renderer process — PIDs recorded either side,
including a navigation to a different origin — and in every case the attachment survived and
all four overrides held **without** being reapplied.

Overrides are therefore reapplied on attach and on `did-navigate` only. No process-swap
listener, no reload, no flash, no user-visible event.

## Consequences

This is a deliberate deviation from the PRD text, which is why it is written down: without
this record the next reader will "fix" the missing swap handling. Reapply on navigate is kept
as cheap insurance rather than because a failure was observed. Evidence:
`prototypes/pane-host-spike/FINDINGS.md`, issue #3.
