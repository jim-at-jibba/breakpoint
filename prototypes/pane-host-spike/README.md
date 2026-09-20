# Pane host spike — THROWAWAY

Phase 0 spike for [Breakpoint](../../docs/breakpoint-prd.md). It answers PRD §12
items 1, 2 and 3 against the thresholds in
[`docs/handoffs/phase-0-pane-host.md`](../../docs/handoffs/phase-0-pane-host.md).

**This is not a `PaneHost`.** It is one Electron file, one host page and one
fixture, written to be read once and thrown away. The deliverable is
[`FINDINGS.md`](FINDINGS.md); this code is the primary source behind it.

## Run it

```
npm install
npm start            # drive it by hand
npm start -- --auto  # scripted run: every automatable probe, then writes out/ and quits
```

Two loopback origins start with the app: `http://127.0.0.1:4100` (A) and
`http://localhost:4101` (B). Different hostnames, so A→B is cross-origin and has
a chance of being cross-site. Whether a renderer process actually swapped is
measured from `webContents.getOSProcessId()`, never assumed.

## What's on screen

Six `<webview>`s — Mobile S, Mobile, Mobile L, Tablet, Laptop, Desktop from §6.2,
covering DPR 1/2/3 and both mobile-flag states — laid out in a row on a canvas
that is CSS-`transform: scale()`d, which is the L1/L4 model. Each pane gets its
own session partition and a CDP session over `webContents.debugger`, with
`Runtime`, `Log`, `Network` and `Page` enabled per §8.6 step 1 and the four §8.5
emulation overrides applied on attach.

The right-hand panel is the instrument. It shows, live: CDP attach state,
heartbeat age per pane, measured `innerWidth` against the declared width, the OS
process id, click hits and misses per zoom level, and the last 60 events.

## The three probes

**1 — hit test through canvas zoom.** The fixture reports every click through a
`Runtime.addBinding` channel with its offset from the centre of the 44×44 target.
*auto-click all panes* converts each target's page coordinates into host-window
coordinates through the canvas scale and fires a real input event at the window,
so the click travels Chromium's ordinary input path. Clicking by hand records the
same way. The legibility and hairline judgements are human; *screenshot* writes
`out/c1-zoom*.png` as the evidence for them.

**2 — real DevTools beside our CDP session.** The fixture logs a heartbeat every
second. If our session is evicted when DevTools attaches, pane 2's heartbeat age
climbs while its neighbours stay fresh. Every CDP command is wrapped in a 4s
timeout (`CDP_TIMEOUT_MS`), because a command that never answers is one of the
ways this can fail and must be recorded rather than awaited forever.

**3 — emulation across navigation.** `did-finish-load` records the process id
before and after, whether the CDP session survived, and the page's own
`innerWidth` — **without reapplying the overrides**, which is the whole question.
*reapply overrides* then exercises the §12 fallback.

## Output

`out/live-state.json` (rewritten every second in `--auto`), `out/state-*.json`
(full snapshot plus the complete event log) and `out/c1-zoom*.png`.
