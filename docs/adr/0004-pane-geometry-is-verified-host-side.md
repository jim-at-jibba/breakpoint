# Pane geometry is verified host-side, not through CDP

A CSS `display` override in the Phase 0 harness collapsed every pane to 150px tall. It
survived three full probe runs because every instrument we had agreed it was fine:
`innerWidth`, `innerHeight`, `devicePixelRatio` and `Page.getLayoutMetrics` all reported the
declared viewport throughout. A human looking at the screen caught it.

The lesson generalises: **CDP reports the emulated viewport, which is not evidence that the
compositor is rendering it.** So the check is host-side — the renderer compares the pane
element's own `getBoundingClientRect()` against `preset size × zoom`. That costs no CDP call,
runs on every attach and resize, and cannot be fooled by emulation, because it never asks
emulation anything.

## Consequences

§11's Phase 1 exit criterion changes with it: "correct `innerWidth`, DPR and scheme" is
exactly the assertion that passed while the panes were broken. The acceptance test adds a
hit-test near a pane's bottom edge, where a round-trip is affordable.

On failure the pane is marked degraded and an entry is written. It is deliberately **not**
self-corrected: a mismatch means our model of the pane is wrong, and quietly resizing to
match is how the original bug stayed hidden.
