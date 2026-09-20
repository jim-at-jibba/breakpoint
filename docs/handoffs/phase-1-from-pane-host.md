# Handoff: Phase 0 pane host spike → Phase 1

**Created:** 2026-09-20
**From:** the Phase 0 spike session on `prototype/pane-host`
**For:** the Phase 1 session — `/grill-with-docs`, then spec, tickets, implement
**Primary source:** branch `prototype/pane-host`, `prototypes/pane-host-spike/`
**Full findings:** [`prototypes/pane-host-spike/FINDINGS.md`](../../prototypes/pane-host-spike/FINDINGS.md)

## The answer

**`<webview>` holds up. All three conditions pass. Phase 1 proceeds on §8.4 as written.** No P0
requirement in §6.3 changes; the scrolling canvas (L1) and HTML overlays stay. `WebContentsView`
is not needed.

| # | Condition | Verdict |
|---|---|---|
| 1 | 6 panes, canvas at 50% and 25% | Pass — 6/6 panes hit the 44×44 target at 100%, 50% and 25%, max offset 1.2px |
| 2 | Real DevTools open on pane 2 | Pass — our CDP session is never evicted |
| 3 | Cross-origin navigation | Pass — all four overrides survive a real process swap with no reapply |

Nothing is outstanding. Phase 1 is unblocked.

## The one finding that should change how Phase 1 writes code

An early version of the harness set `display: block` on the `<webview>` element. Electron's
`<webview>` uses `display: flex` internally so its child iframe fills the container; overriding it
collapses the guest to a replaced element's default height. **Every pane was really 360×150,
390×150, 1440×150** — width filled, height did not.

The emulation overrides hid it completely. `innerWidth`, `innerHeight`, `devicePixelRatio` and
`Page.getLayoutMetrics` all reported the full declared viewport while only the top 150 CSS px of
each pane was rendered or clickable. Every instrument read "perfect" for three full probe runs.

**CDP emulation will report a viewport the compositor is not rendering.** §12 item 3's threshold —
"`innerWidth` still reads the declared CSS width" — is not sufficient evidence that emulation
works. Any emulation assertion in the real app needs a raster- or input-level confirmation:
`clearDeviceMetricsOverride` then read `innerHeight`, or a hit test near the bottom of the pane.

## Four things for the `/grill-with-docs` pass

1. **§8.5 overstates reapplication.** It says overrides are reapplied "after any render-process
   swap". Measured on Electron 44: all six panes genuinely swapped renderer process (PIDs recorded
   either side, including one navigation to `https://example.com`), the CDP session survived every
   swap, and all four overrides held **without** being reapplied. Keep the reapply as cheap
   insurance; do not build a visible reload, flash, or "trust-destroying event" around it.
   *Candidate ADR.*

2. **§12 item 2's fallback is unnecessary, and undetectable as designed.** Real DevTools open on
   pane 2 did not evict the app's session: heartbeats kept pace throughout, no `detach` event, no
   command timeouts, and an explicit reattach was refused with "Debugger is already attached to the
   target". There is no detach signal to build a fallback on — if a paused state is ever needed,
   base it on **heartbeat staleness**. *Candidate ADR.*

3. **§12 item 3's threshold should be strengthened**, per the sizing finding above.

4. **Capture fidelity needs its own spike.** `Page.captureScreenshot` returns an image sized from
   the *emulated* DPR but filled from a surface rastered at the *display* DPR, so the content wraps
   and tiles: a 360×800 `@3x` pane yields a 1080×2400 image whose content repeats on a 720×1600
   grid — exactly the 3:2 DPR ratio. Affects §6.7 capture and §13's composite-screenshot criterion.
   Phase 4 work, not a Phase 1 blocker.

## Implementation notes for `PaneService`

- **Never override `<webview>`'s `display`.** Only `inline-flex` is a safe substitute.
- `Emulation.setTouchEmulationEnabled` rejects `maxTouchPoints: 0` with "Touch points must be
  between 1 and 16" *even when `enabled: false`*. Pass `1` when disabling.
- Apply overrides per call in `try`/`catch` and register event listeners *before* emulation, so one
  rejected override degrades one capability instead of taking the pane's whole attach path down.
- For input into a pane, use CDP `Input.dispatchMouseEvent` on the host window's session.
  `webContents.sendInputEvent()` on the host does **not** reach a `<webview>` guest, even when
  sizing is correct. Relevant to how N8 input sync is built.

## Scope notes

- Keep the `PaneHost` abstraction, but for the §12 item 12 reason (Electron may change `<webview>`),
  not because this spike found a reason to switch.
- Spike #4 (`Input.dispatch*` into a scaled, emulated `<webview>`) is largely answered as a side
  effect: the CDP input path lands within 1.2px of the target centre at every zoom level in every
  pane. Worth confirming for keyboard and touch.
- The harness is throwaway and deliberately has no service layer, no project model and no React.
  Do not grow it. Phase 1 starts from a real architecture.
