# Handoff: Phase 0 pane host spike → Phase 1

**Created:** 2026-09-20
**From:** the Phase 0 spike session on `prototype/pane-host`
**For:** the Phase 1 session — `/grill-with-docs`, then spec, tickets, implement
**Primary source:** branch `prototype/pane-host`, `prototypes/pane-host-spike/`
**Full findings:** [`prototypes/pane-host-spike/FINDINGS.md`](../../prototypes/pane-host-spike/FINDINGS.md)

## The answer

**`<webview>` holds up. Phase 1 proceeds on §8.4 as written.** No P0 requirement in §6.3
changes; the scrolling canvas (L1) and HTML overlays stay. `WebContentsView` is not needed.

Conditions 2 and 3 pass outright and by wider margins than §8.4 and §8.5 assume. Condition 1's
measurable half passes — six panes at mixed DPR hold exact CSS viewports at 25%, 50% and 100%
canvas zoom. Its click half is **not** settled, for a harness reason rather than a product one,
and needs one short human pass before Phase 1 locks the layout tickets.

## Do this first, before grilling

Run the harness by hand and finish condition 1. It takes about two minutes.

```
cd prototypes/pane-host-spike && npm install && npm start
```

Set zoom to 50%, then 25%. Click the blue 44×44 button in each of the six panes. The right-hand
panel records every click with its offset from the target centre. While you are there, judge by
eye whether the 12px paragraph is legible at 50% and whether the 1px hairlines stay single rather
than disappearing or doubling.

The automated version of this does not work and cannot be made to work from inside the app:
neither `webContents.sendInputEvent()` on the host window nor browser-side
`Input.dispatchMouseEvent` on the host's CDP session reaches a `<webview>` guest — 21 of 21
synthetic clicks produced no event, while the reporting channel was provably live. Both deliver to
the host's own widget; a guest is reached only through Chromium's hit-testing input router, which
real OS input enters and these do not. Do not spend Phase 1 time retrying this.

## Four things for the `/grill-with-docs` pass

These are the spike's contradictions with the PRD. The first two are candidate ADRs.

1. **§8.5 overstates reapplication.** It says overrides are reapplied "after any render-process
   swap". Measured on Electron 44: all six panes genuinely swapped renderer process (PIDs recorded
   before and after, including one navigation to `https://example.com`), the CDP session survived
   every swap, and all four overrides held **without** being reapplied. Keep the reapply as cheap
   insurance; do not build a visible reload, a flash, or a trust-destroying event around it.

2. **§12 item 2's fallback is unnecessary, and undetectable as designed.** Real DevTools open on
   pane 2 did not evict the app's session: heartbeats kept pace throughout, no `detach` event fired,
   no command timed out, and an explicit reattach was refused with "Debugger is already attached to
   the target". The sharper point: there is no detach signal to build a fallback on. If a paused
   state is ever needed, base it on **heartbeat staleness**, not on the `detach` event.

3. **A new risk that is not in §12: programmatic capture of `<webview>` content is unreliable.**
   Both `capturePage()` and CDP `Page.captureScreenshot` returned images contradicting the panes'
   own correct geometry — unwrapped and clipped text, content missing below ~130 CSS px, and tiled
   repeats. The same panes simultaneously reported exact layout metrics, so it is the capture path,
   not rendering. **§6.7's screenshot and composite-screenshot features and §13's "at most one
   composite screenshot" criterion both sit on this path.** Add it to §12 and spike it before Phase 4.

4. **An API detail worth a guard in `PaneService`.** `Emulation.setTouchEmulationEnabled` rejects
   `maxTouchPoints: 0` with "Touch points must be between 1 and 16" *even when `enabled: false`*.
   Pass `1` when disabling. In the spike's first run this threw mid-attach and silently cost the two
   desktop panes their whole probe path.

## Scope notes

- Keep the `PaneHost` abstraction, but for the §12 item 12 reason (Electron may change `<webview>`),
  not because this spike found a reason to switch.
- Spike #4 (`Input.dispatch*` into a scaled, emulated `<webview>`) is untouched and is now more
  interesting than it looked, given that neither host-side input path reaches a guest at all.
- The harness is throwaway and deliberately has no service layer, no project model and no React.
  Do not grow it. Phase 1 starts from a real architecture.
