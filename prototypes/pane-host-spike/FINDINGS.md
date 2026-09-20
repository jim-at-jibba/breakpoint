# Phase 0 — pane host spike: findings

**Date:** 2026-09-20
**Branch:** `prototype/pane-host` (keep; Phase 1 tickets point here)
**Harness:** [`prototypes/pane-host-spike`](.) — `npm start -- --auto`
**Environment:** Electron 44.4.3 / Chromium 152.0.7977.130 / Node 24.21.0, macOS 26.6.2, Apple silicon, 2× Retina display
**Answers:** PRD §12 items 1, 2 and 3, against the thresholds in [`docs/handoffs/phase-0-pane-host.md`](../../docs/handoffs/phase-0-pane-host.md)

## Answer in one line

**`<webview>` holds up. All three conditions pass.** Phase 1 proceeds on §8.4 as written; no P0
requirement in §6.3 changes, and `WebContentsView` is not needed.

| # | Condition | Verdict |
|---|---|---|
| 1 | 6 panes, canvas at 50% and 25% | **Pass.** 6/6 panes hit the 44×44 target at 100%, 50% and 25%, max offset 1.2px |
| 2 | Real DevTools open on pane 2 | **Pass.** Our CDP session is never evicted |
| 3 | Cross-origin navigation | **Pass.** All four overrides survive a real renderer process swap with no reapply |

### Read this before trusting any of the numbers below

An early version of this harness set `display: block` on the `<webview>` element. Electron's
`<webview>` uses `display: flex` internally so its child iframe fills the container; overriding it
collapses the guest to a replaced element's default height. **Every pane was really 360×150,
390×150, 1440×150** — width filled, height did not.

The overrides hid it completely. `Emulation.setDeviceMetricsOverride` made `innerWidth`,
`innerHeight`, `devicePixelRatio` and `Page.getLayoutMetrics` all report the full declared
viewport, so every instrument in the harness read "perfect" while only the top 150 CSS px of each
pane was ever rendered or clickable.

**The lesson is bigger than the bug: CDP emulation will happily report a viewport the compositor
is not rendering.** §12 item 3's threshold — "`innerWidth` still reads the declared CSS width" —
is therefore *not* sufficient evidence that emulation is working. Verification needs a
raster-level or input-level check too. The one that caught it here:
`Emulation.clearDeviceMetricsOverride` then read `innerHeight`, which reports the guest's true
widget size.

All results below were re-measured after the fix.

---

## Condition 1 — six panes on a scaled canvas

Six §6.2 presets (Mobile S / Mobile / Mobile L / Tablet / Laptop / Desktop), covering DPR 1, 2
and 3 and both mobile-flag states, on one `transform: scale()`d canvas.

**Hit test: pass, automated.** The harness computes each target's centre in page coordinates,
converts it to host-window coordinates through the canvas scale, and dispatches via
`Input.dispatchMouseEvent` on the host window's own CDP session. Every pane, every zoom level:

```
Mobile S  100% 1/1 ±0.8   50% 1/1 ±1     25% 1/1 ±1.2
Mobile    100% 1/1 ±0.8   50% 1/1 ±1     25% 1/1 ±1.2
Mobile L  100% 1/1 ±0.8   50% 1/1 ±1     25% 1/1 ±1
Tablet    100% 1/1 ±0.8   50% 1/1 ±0.8   25% 1/1 ±1.2
Laptop                    50% 1/1 ±0.8   25% 1/1 ±1.2
Desktop                   50% 1/1 ±1     25% 1/1 ±1.2
```

Max offset from the target centre is **1.2px** at 25% zoom, which is coordinate-conversion
rounding in the harness, not input offset. Reproducible: two consecutive `--auto` runs give
identical results. (An earlier version missed intermittently at 100% zoom only — the canvas
scrolls furthest there, and the target's rect was being read mid-scroll, so the click was aimed at
stale geometry. `autoClickAll` now waits for the scroll to stop before measuring.) Laptop and Desktop have no 100% row because at 100%
zoom they are off-screen and the harness skips them; the thresholds only require 50% and 25%.

Human clicks route identically — confirmed during the manual pass, which is also how the sizing
bug surfaced (every human click registered, and every one missed, because the button was below
the dead region).

**Rendering: pass.** Layout is exact at every zoom — `Page.getLayoutMetrics` reports a layout
viewport, visual viewport and content size equal to the declared preset at the declared DPR with
`scale: 1` in all six panes. 12px text, 1px hairline borders, the 44×44 button, the input and the
link all render at 50%, and the hairlines stay single.
Evidence: [`evidence/canvas-at-50-percent.png`](evidence/canvas-at-50-percent.png),
[`evidence/layout-metrics.json`](evidence/layout-metrics.json).

**Caveat on @3x panes.** Panes raster at the display's scale, not the emulated one — a `@3x` preset
on a 2× display lays out and reports as 3× but is rastered at 2×. That is the correct trade for a
dev browser (the display has no more pixels to give) but it matters for screenshot fidelity, below.

---

## Condition 2 — real DevTools alongside the app's CDP session

Attach to all six panes, then `openDevTools({ mode: 'detach' })` on pane 2, hold 8s, close, hold
8s, then attempt an explicit reattach. Each pane logs a heartbeat every second and every mark
carries all six counts, so continuity is read directly rather than inferred.

**Our session is never evicted.**

```
C2 baseline before DevTools    beats p2=15 p1=15 p3=15 p4=15 p6=15 p5=14
C2 opening real DevTools       beats p2=18 p1=18 p3=18 p4=18 p6=17 p5=17
C2 sampled with DevTools open  beats p2=26 p1=26 p3=26 p4=26 p6=25 p5=25   <- p2 kept pace
C2 sampled after close         beats p2=35 p1=35 p3=35 p4=35 p6=34 p5=34
C2 explicit reattach           reattach-failed p2: "Debugger is already attached to the target"
```

`Runtime.consoleAPICalled` kept firing for pane 2 throughout the DevTools window and kept firing
for panes 1 and 3. No `detach` event, zero CDP command timeouts on any pane, and nothing happens
on DevTools close. The refused reattach is the clincher: our session was still attached.

**Consequences for the PRD.** §12's fallback — "detect detach, show paused, reattach" — is not
needed. The sharper point: because nothing detaches, **there is no detach signal to build a
fallback on**. If some future Electron or DevTools combination does evict the session, the
evidence suggests it would go quiet rather than announce itself, so any paused-state detection
should be built on **heartbeat staleness, not on the `detach` event**.

**Not tested:** the reverse order, DevTools open first then attach. Breakpoint attaches at pane
creation, so the tested order is the realistic one.

---

## Condition 3 — emulation across cross-origin navigation and process swaps

Two loopback servers on *different hostnames* (`http://127.0.0.1:4100`, `http://localhost:4101`)
plus `https://example.com`. Process swaps are **measured** via `webContents.getOSProcessId()`
before and after, never assumed. Overrides are deliberately **not** reapplied.

```
Mobile S  -> localhost:4101  swap=True  cdp=True  iw=360/360    dpr=3/3  ua=True touch=True
Mobile    -> example.com     swap=True  cdp=True  iw=390/390    dpr=3/3  ua=True touch=True
Mobile L  -> localhost:4101  swap=True  cdp=True  iw=430/430    dpr=3/3  ua=True touch=True
Tablet    -> localhost:4101  swap=True  cdp=True  iw=820/820    dpr=2/2  ua=True touch=True
Laptop    -> localhost:4101  swap=True  cdp=True  iw=1280/1280  dpr=2/2  ua=True touch=True
Desktop   -> localhost:4101  swap=True  cdp=True  iw=1440/1440  dpr=1/1  ua=True touch=True
```

Every pane genuinely swapped renderer process. In every case the CDP session survived and **all
four §8.5 overrides held without being reapplied**: device metrics, user agent, touch emulation
and emulated media.

`innerWidth` alone proves nothing here — it matches the element's own size either way, and as the
sizing bug showed, it can report a viewport that is not being rendered. The override is shown to
be live by the values that cannot come from the element: DPR 3 and DPR 1 panes on a 2× display,
the iPhone user agent, and `maxTouchPoints: 5` with `(pointer: coarse)` on the mobile presets.
The harness asserts all four, and the hit test at the bottom of each pane confirms the viewport is
real and not merely reported.

---

## Things that contradict or extend the PRD

1. **§8.5 overstates the need to reapply.** It says overrides are "reapplied on attach and after
   any render-process swap". Measured: on Electron 44 they survive a real swap untouched. Keep the
   reapply as cheap insurance, but do not build a visible reload or flash around it, and do not
   treat a swap as a trust-destroying event. *Candidate ADR.*
2. **§12 item 2's fallback is unnecessary as written, and undetectable as designed.** See
   condition 2. If a paused state is ever needed, base it on heartbeat staleness. *Candidate ADR.*
3. **§8.4 is vindicated.** `<webview>` on a scaled canvas gave exact per-pane emulation and
   sub-pixel-accurate hit testing at 25%, 50% and 100% with six panes at mixed DPR. Keep the
   `PaneHost` abstraction for the §12 item 12 reason (long-term support), not for this one.
4. **§12 item 3's threshold is too weak.** "`innerWidth` still reads the declared CSS width"
   passed for hours while the panes were 150px tall. Any emulation assertion in the real app needs
   a raster- or input-level confirmation, not just a reported value.
5. **Capture fidelity needs its own spike, narrower than first thought.** `Page.captureScreenshot`
   returns an image sized from the *emulated* DPR but filled from a surface rastered at the
   *display* DPR, so the content wraps and tiles — a 360×800 `@3x` pane yields a 1080×2400 image
   whose content repeats on a 720×1600 grid (3:2, exactly the DPR ratio). Affects §6.7 capture and
   §13's composite-screenshot criterion. See [`evidence/capture-tiling-pane1.png`](evidence/capture-tiling-pane1.png).

## Implementation notes for `PaneService`

- **Never override `<webview>`'s `display`.** Only `inline-flex` is a safe substitute for the
  internal `flex`. `display: block` silently collapses the guest to 150px tall while every CDP
  instrument continues to report the full declared viewport.
- `Emulation.setTouchEmulationEnabled` rejects `maxTouchPoints: 0` with "Touch points must be
  between 1 and 16" *even when `enabled: false`*. Pass `1` when disabling.
- Apply overrides per call in `try`/`catch` and register event listeners *before* emulation, so one
  rejected override degrades one capability instead of taking the pane's whole attach path down.
- Assert a pane's size with `clearDeviceMetricsOverride` + `innerHeight`, or with a hit test, not
  with `innerWidth`.

## Still open

- Spike #4 (`Input.dispatch*` into a scaled, emulated `<webview>`) is now largely answered as a
  side effect: `Input.dispatchMouseEvent` on the host window's CDP session lands within 1.2px of
  the target centre at every zoom level, in every pane. Worth confirming for keyboard and touch.
- `webContents.sendInputEvent()` on the host does **not** reach a guest even when sizing is
  correct; only the CDP input path does. Relevant to how N8 input sync is built.
