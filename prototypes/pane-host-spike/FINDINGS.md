# Phase 0 — pane host spike: findings

**Date:** 2026-09-20
**Branch:** `prototype/pane-host` (keep; Phase 1 tickets point here)
**Harness:** [`prototypes/pane-host-spike`](.) — `npm start -- --auto`
**Environment:** Electron 44.4.3 / Chromium 152.0.7977.130 / Node 24.21.0, macOS 26.6.2, Apple silicon, 2× Retina display
**Answers:** PRD §12 items 1, 2 and 3, against the thresholds in [`docs/handoffs/phase-0-pane-host.md`](../../docs/handoffs/phase-0-pane-host.md)

## Answer in one line

**`<webview>` holds up.** Conditions 2 and 3 pass outright, and by wider margins than
§8.4 and §8.5 assume. Condition 1 is **not fully settled**: its measurable half passes,
but the click half could not be automated and needs one human pass through the harness,
about two minutes of work. Nothing found so far argues for the `WebContentsView` fallback.

| # | Condition | Verdict |
|---|---|---|
| 1 | 6 panes, canvas at 50% and 25% | **Partly answered.** Layout exact at every zoom; clicks and the visual judgements still need a human |
| 2 | Real DevTools open on pane 2 | **Pass.** Our CDP session is never evicted |
| 3 | Cross-origin navigation | **Pass.** All four overrides survive a real renderer process swap with no reapply |

---

## Condition 1 — six panes on a scaled canvas

Six §6.2 presets (Mobile S / Mobile / Mobile L / Tablet / Laptop / Desktop), covering
DPR 1, 2 and 3 and both mobile-flag states, on one `transform: scale()`d canvas at 100%,
50% and 25%.

**What passes.** Every pane's geometry is exactly right at every zoom level. `Page.getLayoutMetrics`
reports, per pane, a layout viewport, visual viewport and content size all equal to the declared
preset at the declared DPR with `scale: 1` — for example Mobile S `360×800 @3x` and Desktop
`1440×900 @1x` on a 2× display, which cannot be explained by the element's on-screen size.
`document.elementFromPoint()` at the centre of the 44×44 target returns `target` in all six panes.
This is L4 working: canvas zoom scales rendering only, and the CSS viewport is untouched.
Evidence: [`evidence/layout-metrics.json`](evidence/layout-metrics.json),
[`evidence/canvas-at-50-percent.png`](evidence/canvas-at-50-percent.png).

**What is not answered, and why.** The handoff's threshold is a *click* landing inside the target.
The harness computes each target's centre in page coordinates, converts it to host-window
coordinates through the canvas scale, and fires an event there. Neither available path reaches a
guest: **21 of 21 synthetic clicks produced no event**, using both
`webContents.sendInputEvent()` on the host window and browser-side `Input.dispatchMouseEvent`
on the host's own CDP session. This is a harness limitation, not a condition-1 failure — the
reporting channel is provably live (`typeof window.__spike === 'function'` in every pane, and the
fixture reports *any* click anywhere on the page, not just on the target). Both APIs deliver to
the host's own widget; a `<webview>` guest is a separate WebContents reached only through
Chromium's hit-testing input router, which real OS input enters and these two do not.

**To finish it** (about two minutes): `npm start`, set zoom to 50% then 25%, click the blue
44×44 button in each of the six panes, and read the offsets in the right-hand panel. While there,
judge by eye whether the 12px paragraph is legible at 50% and whether the 1px hairlines stay
single. The panel records every click with its offset from the target centre, so the result is a
number, not an impression.

### New risk found: programmatic capture of `<webview>` content is unreliable

Both `webContents.capturePage()` and CDP `Page.captureScreenshot` returned images that
**contradict the pane's own geometry**: body text rendered unwrapped and clipped, content below
roughly 130 CSS px missing, and in the per-pane CDP capture the top of the page tiled repeatedly
down the image ([`evidence/capture-artifact-pane1.png`](evidence/capture-artifact-pane1.png)).
The same panes simultaneously reported correct layout metrics and correct element rects, so this
is a capture-path problem, not a rendering or emulation one.

This is not in §12 and it matters: **§6.7's screenshot and composite-screenshot features, and the
agent's "at most one composite screenshot" success criterion in §13, both depend on this path.**
It also means screenshots cannot be used to settle condition 1's visual half — hence the human pass.
Recommend adding it to §12 as its own spike before Phase 4.

---

## Condition 2 — real DevTools alongside the app's CDP session

Probe: attach our session to all six panes, then `openDevTools({ mode: 'detach' })` on pane 2,
hold for 8s, close, hold for 8s, then attempt an explicit reattach. Each pane logs a heartbeat
every second; every mark in the log carries all six heartbeat counts, so continuity is read
directly rather than inferred.

**Our session is never evicted.**

```
C2 baseline before DevTools    beats p2=15 p3=15 p1=15 p4=15 p5=15 p6=15
C2 opening real DevTools       beats p2=18 p3=18 p1=18 p4=18 p5=18 p6=18
C2 sampled with DevTools open  beats p2=26 p3=26 p1=26 p4=26 p5=26 p6=26   <- p2 kept pace
C2 closing DevTools            beats p2=27 p3=27 p1=26 p4=26 p5=26 p6=26
C2 sampled after close         beats p2=35 p3=35 p1=34 p4=34 p5=34 p6=34
C2 explicit reattach           reattach-failed p2: "Debugger is already attached to the target"
```

`Runtime.consoleAPICalled` kept firing for pane 2 for the entire DevTools window and kept firing
for panes 1 and 3 throughout. No `detach` event, no CDP command timeouts on any pane, and nothing
happens on DevTools close. The refused reattach is the clincher: our session was still attached.
Chromium's multi-client debugging is doing its job.

**Consequences for the PRD.** §12's fallback — "detect detach, show paused, reattach" — is not
needed for this case. Note the sharper point behind it: because nothing detaches, there is also
**no detach signal to build a fallback on**. If some future Electron or DevTools combination does
evict the session, the evidence here suggests it would go quiet rather than announce itself, so any
paused-state detection should be built on **heartbeat staleness, not on the `detach` event**.

**Not tested:** the reverse order, opening DevTools first and attaching afterwards. Breakpoint
attaches at pane creation, so the tested order is the realistic one, but the reverse is worth one
line in a Phase 1 ticket.

---

## Condition 3 — emulation across cross-origin navigation and process swaps

Two loopback servers on *different hostnames* (`http://127.0.0.1:4100` and
`http://localhost:4101`) so the navigation is cross-site, plus `https://example.com` for a
guaranteed external swap. Process swaps are **measured** via `webContents.getOSProcessId()` before
and after, never assumed. Overrides are deliberately **not** reapplied.

```
Mobile S  -> localhost:4101    pid 9326->9657  swap=True  cdp=True  iw=360/360   dpr=3/3  ua=True touch=True
Mobile    -> example.com       pid 9655->9677  swap=True  cdp=True  iw=390/390   dpr=3/3  ua=True touch=True
Mobile L  -> localhost:4101    pid 9330->9656  swap=True  cdp=True  iw=430/430   dpr=3/3  ua=True touch=True
Tablet    -> localhost:4101    pid 9332->9658  swap=True  cdp=True  iw=820/820   dpr=2/2  ua=True touch=True
Laptop    -> localhost:4101    pid 9334->9659  swap=True  cdp=True  iw=1280/1280 dpr=2/2  ua=True touch=True
Desktop   -> localhost:4101    pid 9336->9660  swap=True  cdp=True  iw=1440/1440 dpr=1/1  ua=True touch=True
```

Every pane genuinely swapped renderer process. In every case the CDP session survived the swap and
**all four §8.5 overrides held without being reapplied**: device metrics, user agent, touch
emulation and emulated media.

`innerWidth` alone would prove nothing here, since it matches the `<webview>` element's own size
either way. The override is shown to be live by the values that *cannot* come from the element:
DPR 3 and DPR 1 panes on a 2× display, the iPhone user agent, and `maxTouchPoints: 5` with
`(pointer: coarse)` matching on the mobile presets. The harness asserts all four.

---

## Things that contradict or extend the PRD

1. **§8.5 overstates the need to reapply.** It says overrides are "reapplied on attach and after any
   render-process swap". Measured: on Electron 44 they survive a real swap untouched. Keep the
   reapply as cheap insurance, but do not build a visible reload or flash around it, and do not
   treat a swap as a trust-destroying event. *Candidate ADR.*
2. **§12 item 2's fallback is unnecessary as written, and undetectable as designed.** See condition 2.
   If a paused state is ever needed, base it on heartbeat staleness. *Candidate ADR.*
3. **§8.4 is vindicated.** `<webview>` in the DOM on a scaled canvas produced exact per-pane
   emulation at 25%, 50% and 100% with six panes at mixed DPR. No reason to spend the scrolling
   canvas and HTML overlays on `WebContentsView`. Keep the `PaneHost` abstraction for the §12
   item 12 reason (long-term support), not for this one.
4. **New spike for §12: programmatic capture of `<webview>` content.** See condition 1. Affects
   §6.7 and §13.
5. **API detail for §8.5.** `Emulation.setTouchEmulationEnabled` rejects `maxTouchPoints: 0` with
   "Touch points must be between 1 and 16" *even when `enabled: false`*. Pass `1` when disabling.
   In the first run this threw during attach and silently cost the two desktop panes their entire
   probe path — worth a guard in `PaneService`.

## Still open

- Condition 1's click and visual pass (human, ~2 minutes, instructions above).
- Spike #4 (`Input.dispatch*` into a scaled, emulated `<webview>`) is untouched and is now more
  interesting, because the two obvious host-side input paths do not reach a guest at all.
