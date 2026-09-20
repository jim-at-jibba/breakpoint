# Handoff: Phase 0 pane host spike → Phase 1

**Created:** 2026-09-20
**From:** the Phase 0 spike session on `prototype/pane-host`
**For:** the Phase 1 session — grill, then spec, tickets, implement
**Findings:** [`prototypes/pane-host-spike/FINDINGS.md`](../../prototypes/pane-host-spike/FINDINGS.md)
**Primary source:** branch `prototype/pane-host`, merged to `main` as `73c5bdd` (`--no-ff`) and retained
**Open follow-ups:** issues [#2](https://github.com/jim-at-jibba/breakpoint/issues/2), [#3](https://github.com/jim-at-jibba/breakpoint/issues/3), [#4](https://github.com/jim-at-jibba/breakpoint/issues/4) ([#1](https://github.com/jim-at-jibba/breakpoint/issues/1) closed)

## The answer

**`<webview>` holds up. All three conditions pass. Phase 1 proceeds on §8.4 as written.** No P0
requirement in §6.3 changes; the scrolling canvas (L1) and HTML overlays stay. `WebContentsView`
is not needed.

| # | Condition | Verdict |
|---|---|---|
| 1 | 6 panes, canvas at 50% and 25% | Pass — 6/6 panes hit the 44×44 target at every zoom they are on screen for, max offset 1.2px |
| 2 | Real DevTools open on pane 2 | Pass — our CDP session is never evicted |
| 3 | Cross-origin navigation | Pass — all four overrides survive a real process swap with no reapply |

Phase 0 is closed. Nothing blocks Phase 1.

---

## Start here, in this order

1. **Grill §8 against the three corrections in #3**, and produce the two artefacts that do not yet
   exist: **`CONTEXT.md` at the repo root** and **`docs/adr/`** (per `AGENTS.md`'s single-context
   convention).
2. **Settle the terminology in `CONTEXT.md` before any ticket is written.** "Session" is
   overloaded: the **CDP debugger session** (`webContents.debugger`, §8.3, §8.6) and the **per-pane
   storage partition** (`partition="persist:…"`, §6.5) are different things and the PRD uses one
   word for both. Every pane and console ticket will read ambiguously until they are separate
   terms.
3. **Decide the exit-criteria change below**, because it changes Phase 1's acceptance tests.
4. **Scaffold.** There is no `package.json` at the repo root — nothing is set up yet. electron-vite
   + TypeScript + React + Zustand + Tailwind + shadcn/Base UI, per §8.1–8.2.
5. **Build the four non-negotiable foundations from §11** before features: service layer, event log
   with a monotonic cursor, local socket and command router, single-instance lock with argv
   hand-off. These are the expensive-to-retrofit ones.
6. Then `PaneHost`, emulation, presets, layouts, projects, certs, and the Phase 1 CLI subset
   (`breakpoint .`, `open`, `state`, `quit`, `--wait`, `--no-launch`, best-effort `--background`,
   `--json`).

## Recommended change to Phase 1's exit criteria

§11 currently reads:

> Three panes render localhost with correct `innerWidth`, DPR and scheme at 50% zoom

**That assertion can pass while nothing is rendering.** It is exactly what the spike's
instrumentation reported for three full probe runs while every pane was 150 CSS px tall (see the
next section). `innerWidth`, `innerHeight`, `devicePixelRatio` and `Page.getLayoutMetrics` all read
correct throughout.

Strengthen it to require a **raster- or input-level** confirmation:

- `Emulation.clearDeviceMetricsOverride`, read `innerHeight`, compare to the declared height, then
  reapply; **or**
- hit-test an element near the *bottom* edge of the pane.

Decide in the grill whether this becomes a standing invariant `PaneService` checks on every attach,
or a test-only assertion. The PRD itself has not been edited — §11 and §12 changes belong to the
grill, and are tracked in #3.

## The finding that should change how Phase 1 writes code

An early version of the harness set `display: block` on the `<webview>` element. Electron's
`<webview>` uses `display: flex` internally so its child iframe fills the container; overriding it
collapses the guest to a replaced element's default height. **Every pane was really 360×150,
390×150, 1440×150** — width filled, height did not.

The emulation overrides hid it completely. Every CDP instrument reported the full declared viewport
while only the top 150 CSS px of each pane was rendered or clickable. It survived three probe runs
and was caught only by a human looking at the screen.

**CDP emulation will report a viewport the compositor is not rendering.** §12 item 3's threshold —
"`innerWidth` still reads the declared CSS width" — is not sufficient evidence that emulation works.

## Four things for the grill

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

3. **§12 item 3's threshold is too weak**, per the section above. Also the §11 exit criterion.

4. **Capture fidelity needs its own spike (#2).** `Page.captureScreenshot` sizes the image from the
   *emulated* DPR but fills it from a surface rastered at the *display* DPR, so content wraps and
   tiles: a 360×800 `@3x` pane yields a 1080×2400 image whose content repeats on a 720×1600 grid —
   exactly the 3:2 DPR ratio. Underneath it: **panes raster at the display's scale, not the emulated
   one**, which bounds what a screenshot can ever be worth for pixel comparison (relevant to §6.2
   V5). Affects §6.7 and §13. Phase 4 work, not a Phase 1 blocker.

## Implementation notes for `PaneService` (tracked in #4)

- **Never override `<webview>`'s `display`.** Only `inline-flex` is a safe substitute.
- `Emulation.setTouchEmulationEnabled` rejects `maxTouchPoints: 0` with "Touch points must be
  between 1 and 16" *even when `enabled: false`*. Pass `1` when disabling.
- Apply overrides per call in `try`/`catch`, and register event listeners **before** emulation, so
  one rejected override degrades one capability instead of taking the pane's whole attach path down.
- For input into a pane, use CDP `Input.dispatchMouseEvent` on the host window's session.
  `webContents.sendInputEvent()` on the host does **not** reach a `<webview>` guest, even when
  sizing is correct. Relevant to how N8 input sync and the §8.7 act-tool dispatch path get built.
- Assert a pane's size with a raster- or input-level check, never with `innerWidth` alone.

## Scope notes

- Keep the `PaneHost` abstraction, but for the §12 item 12 reason (Electron may change `<webview>`),
  not because this spike found a reason to switch.
- **Spike #4 is largely answered as a side effect**: CDP `Input.dispatchMouseEvent` lands within
  1.2px of the target centre at every zoom level in every pane. Worth confirming for keyboard and
  touch before N8.
- The harness in `prototypes/pane-host-spike/` is throwaway and stays that way. Do not grow it or
  lift code from it. Phase 1 starts from a real architecture.

## Re-running the spike

```
cd prototypes/pane-host-spike && npm install
npm start              # drive it by hand
npm start -- --auto    # scripted: every probe, writes out/, quits
npm start -- --diag    # one-shot layout and binding dump
npm start -- --isolate # guest true-size probe (the one that found the sizing bug)
```

`--auto` is deterministic — consecutive runs give identical results. If a click ever misses at 100%
zoom, that is the canvas-scroll settle path, not a product regression; see `FINDINGS.md`.
