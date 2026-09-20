# Prompt: initial visual design for Breakpoint

Paste everything below into `claude design`.

---

Design the visual language for **Breakpoint**, a macOS Electron desktop app, and apply it to its main surfaces.

## What the app is

Breakpoint is a dev browser. You open a project (a local repo) and it renders one URL at 3–6 viewport sizes at once — Mobile 390×844, Tablet 820×1180, Desktop 1440×900 and so on — side by side on a horizontally scrolling canvas that zooms 25–100%. Navigation, scroll and clicks stay in sync across panes. One console shows output from every pane, labelled by which pane it came from. It is also driven by a CLI so a coding agent can use the same panes the developer is watching.

The audience is one developer, using it all day, next to their editor. Think Chrome DevTools, Linear, Zed, Ghostty — not a web app, not a marketing site.

## The central design tension

**Every pane is an arbitrary website the developer is building.** The chrome wraps content whose colours, type and density we do not control and cannot predict. So the chrome must recede completely: it is a frame and a set of labels, never a visual participant. At the same time the chrome must stay legible against a pane that might be pure white, pure black, or a neon gradient.

Solve that explicitly. It is the thing I most want an opinion on.

## Fixed constraints — design within these, do not relitigate them

- **Stack:** React + TypeScript + Tailwind + shadcn/ui, with **Base UI** primitives (unstyled). Component source is copied into the repo and owned, so overrides go into the copied components once, not per use site. Icons are **Lucide**. Everything you design must be expressible as Tailwind classes plus CSS custom properties.
- **Theme:** CSS variables, light and dark, following the OS via Electron's `nativeTheme`, with a manual override. Panes have their own emulated colour scheme independent of the app theme — a dark app can host a light pane and vice versa, and that combination must not look broken.
- **Density:** base font 12–13px, row height 24–28px, 4px spacing grid. Monospace for console output, source locations and pixel dimensions.
- **macOS conventions:** `titleBarStyle: 'hiddenInset'`, so the toolbar is the window drag region and sits to the right of the traffic lights. `user-select: none` on all chrome; selection enabled only in console, network detail and terminal. No focus ring on mouse click — `:focus-visible` only.
- **Right-click menus are native** (`Menu.buildFromTemplate`), so do not design context menus. Dropdowns and popovers stay inside the toolbar and panel regions; they cannot reliably draw over a pane.

## Two constraints that came out of a rendering spike — these are real, not hypothetical

1. **Panes are `<webview>` elements scaled with a CSS `transform`.** Any chrome drawn on top of a pane — error borders, inspect highlights, agent presence indicators, click ripples — lives in the HTML layer above it and is subject to that scale. A 1px border at 25% zoom is a quarter of a pixel. Decide whether overlay strokes counter-scale to stay constant on screen, or scale with the canvas, and say which and why.
2. **Pane headers must work at 25% zoom, where a desktop pane is ~360px wide on screen and a mobile pane ~100px.** Decide whether headers scale with the canvas or stay at a fixed screen size, and design the degradation: at what width does `Mobile 390×844 @3x ☾ ①` drop to `390 ☾ ①` and then to `①`?

## Pane identity — a system requirement, not decoration

Each pane gets a fixed colour reused everywhere it appears: pane header, console row badges, layout findings, and **baked into composite PNG screenshots**. Design that palette. It needs to:

- distinguish 6 panes at a glance, 10 at a push
- read correctly in both app themes
- survive as a 1–2px border over unpredictable page content
- work as a filled badge with a short label inside it
- stay distinguishable when rasterised into a screenshot a coding agent will look at

## Surfaces to design

Priority order — the first four are what is being built now.

1. **Toolbar.** Project switcher, back/forward/reload, address bar (accepts bare `3000`), scroll-sync toggle, canvas zoom control, add-pane. Later it also carries an agent status chip, so leave it room without designing it now.
2. **Canvas and pane headers.** The horizontal scrolling surface, the three layout modes (Horizontal, Fit — zoom so everything fits, Focus — one pane at 100% with the rest as a strip), and the pane header: name, live CSS viewport, DPR, colour-scheme indicator, emulation badges, error count.
3. **Pane states.** Loading, crashed (a reload overlay), off-screen at low zoom, error-count flash on the header, a pane whose emulated scheme differs from the app theme.
4. **Project switcher and command palette** (both `cmdk`-style; `⌘P` and `⌘⇧P`).
5. **Bottom panel**, dockable bottom or right, with tabs: Console, Layout, Network, Terminal, Processes. Console rows carry level icon, pane badges, timestamp, message and `file:line:col`. Identical messages from several panes collapse into one row with multiple badges. Rows are virtualised, variable height, stick-to-bottom, and must hold 2,000 entries/second without looking like a mess.
6. **Small surfaces:** toasts (Sonner), a certificate-trust prompt, settings, and the empty state before a project is open.

## Deliverables

1. **A token set** as CSS custom properties: colour (both themes), the pane palette, type scale, spacing, radii, borders, shadows, and the semantic layer on top (surface, chrome, border, muted, error, warn, info, success). Name them so they drop into a shadcn `globals.css`.
2. **Two or three genuinely different directions** for the chrome — not palette swaps of one idea. Different answers to "how does a tool frame content it does not own". Show each at the same surface so they can be compared, and recommend one with reasons.
3. **A single self-contained HTML file** I can open and click through, covering the chosen direction across the surfaces above and their states, with light/dark and a zoom control that demonstrates the header degradation. Fake pane content with static screenshots or coloured blocks — no real embedding.
4. **A short written rationale**: the recede-vs-legible answer, the overlay scaling decision, the header degradation ladder, and anything you think the PRD gets wrong.

## Explicitly not wanted

Marketing polish, hero sections, gradients-as-personality, generous whitespace, large rounded cards, animation beyond functional feedback, a logo or brand identity, custom context menus, any new component primitives beyond Base UI and shadcn, or a real React app. This is a dense professional tool. Err towards Chrome DevTools rather than towards a landing page.
