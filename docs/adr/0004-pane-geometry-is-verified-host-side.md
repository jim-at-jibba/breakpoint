# Pane geometry is verified host-side, not through CDP

A CSS `display` override in the Phase 0 harness collapsed every pane to 150px tall. It
survived three full probe runs because every instrument we had agreed it was fine:
`innerWidth`, `innerHeight`, `devicePixelRatio` and `Page.getLayoutMetrics` all reported the
declared viewport throughout. A human looking at the screen caught it.

The lesson generalises: **CDP reports the emulated viewport, which is not evidence that the
compositor is rendering it.** So the check is host-side — the renderer compares the
`getBoundingClientRect()` of the frame the guest is drawn into against `preset size × zoom`.
That costs no CDP call, runs on every attach and resize, and cannot be fooled by emulation,
because it never asks emulation anything.

## Consequences

§11's Phase 1 exit criterion changes with it: "correct `innerWidth`, DPR and scheme" is
exactly the assertion that passed while the panes were broken. The acceptance test adds a
hit-test near a pane's bottom edge, where a round-trip is affordable.

On failure the pane is marked degraded and an entry is written. It is deliberately **not**
self-corrected: a mismatch means our model of the pane is wrong, and quietly resizing to
match is how the original bug stayed hidden.

## Amended: measure the guest's frame, not the element (#42)

As first written, the check measured the `<webview>` element's own box, and it did not
catch the bug it was written for. `display: block` on the element leaves the element at
its declared size and collapses only the guest inside it, so the element measured right
and the pane read `geometry: 'ok'` while a click near its bottom edge missed. The tests
that seemed to cover it set the element's `style.height`, which is a different failure.

Electron draws the guest into an `<iframe>` in the element's open shadow root, sized by
the element's `display: flex`. That frame is what is measured now. Reading it costs one
`querySelector` per check, and the frame is observed for resizes alongside the element,
because a change to the element's layout resizes the frame and leaves the element alone.

If the frame cannot be found, it is measured as 0×0. A later Electron that builds the
element differently then degrades every pane loudly, rather than letting the check fall
back to the element and pass. The acceptance test puts `display: block` back on purpose
and asserts the mismatch.
