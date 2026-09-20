# Handoff: Phase 0 — pane host spike

**Created:** 2026-09-20
**For:** a fresh session, in its own directory, running `/prototype`
**Branch:** `prototype/pane-host`, cut from `main` and kept out of it

## The question

Does Electron's `<webview>` hold up as the pane host under the three conditions Breakpoint depends on? Answer yes or no, with evidence. If no, the fallback is `WebContentsView`, which costs the scrolling canvas and HTML overlays.

This runs before any Phase 1 work because the answer changes P0 requirements in PRD §6.3.

## Read first

In `docs/breakpoint-prd.md`:

- **§12 items 1, 2 and 3** — the three questions, why each matters, the fallback for each. Item 4 is out of scope here; it moved to Phase 6.
- **§8.4** — why `<webview>` was chosen and what the `PaneHost` abstraction is for.
- **§8.5** — the emulation calls: `Emulation.setDeviceMetricsOverride`, `setUserAgentOverride`, `setTouchEmulationEnabled`, `setEmulatedMedia`.
- **§8.6 step 1** — what to enable on attach: `Runtime`, `Log`, `Network`, `Page`.
- **§6.2** default presets, **§6.3** L1 and L4 for canvas zoom.

## Not in the PRD

Three decisions made outside the document. They are the reason this handoff exists.

### 1. One harness, three questions

The PRD lists the spikes as separate rows. Build them as one scaffold: an Electron shell hosting N `<webview>`s on a scaled canvas with CDP attached to each. All three questions are asked of that single harness. Building three separate probes wastes most of two days on setup.

### 2. Pass/fail thresholds

"Without input offset or blur" is not measurable as written. Use these:

| # | Condition | Passes when |
|---|---|---|
| 1 | 6 panes, canvas at 50% and 25% | A click aimed at a 44×44 CSS px target lands inside that element, in every pane, at both zoom levels. 12px text is legible at 50%. 1px borders do not disappear or double. |
| 2 | Real DevTools open on pane 2 | `Runtime.consoleAPICalled` still fires for pane 2 while DevTools is attached, and keeps firing for panes 1 and 3. Record what happens on DevTools close. |
| 3 | Cross-origin navigation | `innerWidth` still reads the declared CSS width after the navigation completes, without reapplying the override. Test a renderer process swap, not just a same-process route change. |

Condition 2 is the one most likely to fail. If the app's CDP session is evicted when DevTools attaches, record exactly how it fails — silent stop, error event, or detach event — because the fallback in §12 ("detect detach, show paused, reattach") depends on there being something to detect.

### 3. The fixture

Serve one local page containing: 12px body text, 1px-bordered boxes, a 44×44 button, a text input, and a link to a genuinely cross-origin URL. Nothing else. Do not point this at a real Next.js or Vite app — the dev server's own behaviour becomes a variable, and HMR isn't being tested until Phase 3.

Use six of the §6.2 presets so pane count, DPR variety and the mobile flag are all exercised at once.

## Scope guard

The deliverable is **an answer, not a pane host.** No `PaneHost` abstraction, no service layer, no project model, no React. Throwaway is a constraint on how the code is written, not a promise to delete it.

If condition 1 passes easily, resist widening the harness. The next step is Phase 1 with a real architecture, not a better spike.

## When it's done

1. Record the answer to each of the three conditions, with the evidence that settled it.
2. Keep the branch. It is a primary source and Phase 1 tickets will point at it.
3. `/handoff` the findings back to a Phase 1 session. Note anything that contradicts §8.4 or §8.5, because those become ADRs during the Phase 1 `/grill-with-docs` pass.

A failure here is a good outcome, found cheaply. Say so plainly rather than working around it.
