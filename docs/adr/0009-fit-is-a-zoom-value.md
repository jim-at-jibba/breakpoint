# Fit is a zoom value, not a layout mode

§6.3 models Horizontal, Fit and Focus as three layout modes. Fit is not like the other two:
it does not arrange anything, it computes a zoom, and the moment the developer touches the
zoom control they are no longer in it.

Breakpoint has two layouts — Horizontal and Focus — and a zoom control whose value may be
`Fit`, the way a PDF reader does it.

## Consequences

Modelled as a mode, two controls own one value and will disagree: the zoom reads 43% while
the UI claims Fit, or changing zoom has to silently switch modes. Modelled as a zoom value,
there is one source of truth and the UI question answers itself.

Cheap now; a toolbar rewrite once the control exists.
