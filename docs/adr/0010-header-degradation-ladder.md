# Pane headers hold screen size and degrade through a fixed ladder

§6.2 V3 requires the pane header to show name, viewport, DPR, session, emulation badges and
error count. §6.3 allows zooming to 25%, where a mobile pane is about 100 screen pixels wide.
Both are P0 and they cannot both be satisfied literally.

Headers hold a fixed screen size, are clipped by their own pane, and drop content through six
tiers keyed on the pane's width in screen pixels: DPR first, then the name, then the height,
then the scheme glyph, ending at colour tab and error count alone below 56px.

## Consequences

Two alternatives were rejected. Scaling the header with the canvas makes it unreadable at
exactly the zoom where six panes are visible at once. Floating the header outside the pane,
in canvas gutters, keeps it legible but severs the binding between label and pane — with six
panes the labels collide and identifying which is which becomes guesswork.

Clipping is what makes the binding structural: a header can never claim width its pane does
not have. The tier thresholds are in the design prototype and are not arbitrary — each is the
narrowest width at which the remaining content still draws without clipping.

Rotate and remove are in the header but not on the ladder: the ladder is what a header
says, and those are things it does. They come off above the widest tier's threshold,
because below that they would take the width that tier's own content was measured to
need. The colour tab and the error count are the two things no tier takes away.
