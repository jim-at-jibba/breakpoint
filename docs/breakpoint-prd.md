# PRD: Breakpoint — a multi-viewport dev browser for developers and their coding agents

**Working title:** Breakpoint
**Status:** Draft v0.7 (Phase 0 spike answered; Phase 1 grilled)
**Date:** 19 September 2026
**Platform:** Electron
**Reference products:** [Polypane](https://polypane.app/), [Sizzy](https://sizzy.co/), Responsively App

---

## 1. Summary

Breakpoint is a desktop dev browser. You open a project and it renders your site in several viewports at once (mobile, tablet, laptop, desktop), keeps them in sync, and shows one console for every pane.

It is also **agent-native**: everything a developer can see or do in the window, a coding agent can see or do through a local MCP server and CLI. The agent edits code, then uses Breakpoint to check real renders, real console output and real layout at every breakpoint, without spinning up its own headless browser. The developer watches the same panes the agent is looking at.

### What changed in v0.7

Phase 0's spike (#1) and the Phase 1 grill corrected six things. Each amendment below links
the ADR carrying the reasoning; the ADRs are the record, this document is the requirement.

- **6.2 V3** — the pane header degrades through a six-tier ladder. As written it could not be
  satisfied at 25% zoom, where a mobile pane is ~100px wide. [ADR-0010](adr/0010-header-degradation-ladder.md)
- **6.3 L1-L3** — Fit is a zoom value, not a third layout mode. [ADR-0009](adr/0009-fit-is-a-zoom-value.md)
- **8.5** — emulation is not reapplied on renderer process swap. Measured: overrides survive
  swaps untouched. [ADR-0002](adr/0002-no-reapply-on-process-swap.md)
- **11, Phase 1** — the exit criterion no longer accepts an `innerWidth` assertion, which
  passed for three probe runs while every pane was 150px tall. [ADR-0004](adr/0004-pane-geometry-is-verified-host-side.md)
- **12 items 2 and 3** — the DevTools paused state is dropped; there is no detach signal to
  build it on. The `innerWidth` threshold is replaced. [ADR-0003](adr/0003-no-paused-state-for-devtools.md), [ADR-0004](adr/0004-pane-geometry-is-verified-host-side.md)
- **14 question 6** — resolved: CLI access is on by default. [ADR-0008](adr/0008-cli-access-on-by-default.md)

Vocabulary is now fixed in [`CONTEXT.md`](../CONTEXT.md). The debugging connection to a pane
is an **attachment**; **session** means the storage partition only. [ADR-0001](adr/0001-attachment-names-the-cdp-session.md)

### What changed in v0.6

- UI stack decided: shadcn/ui on Tailwind with Base UI primitives, plus the supporting libraries and Electron-specific UI conventions (new section 8.2).

### What changed in v0.5

- **The CLI is no longer one block of work.** The architecture that makes it cheap (service layer, event log, local socket) is built in Phase 1, and each command ships in the same phase as the feature it exposes. See the build rule in section 11.
- **Deferred out of v1:** `--headless`, guaranteed no-focus-steal launch, act commands, permission tiers, the Agent tab, and smart HMR detection. The agent phase shrinks to those parts and moves after polish.
- `settle` starts as a simple heuristic. The `RunAsNode` fuse stays enabled for now.

### What changed in v0.4

- **Standalone first.** The app is complete with no agent anywhere near it. Agent features are off by default, invisible until enabled, and nothing requires an account, API key or network call (section 3 and 7.1).
- **CLI is now the primary agent surface**, ahead of MCP. A harness like Claude Code already has a shell, so `breakpoint .` can launch the app and every other command works with zero configuration. MCP remains for harnesses without a shell or where typed tools are preferred (7.2, 7.3).
- The CLI can start the app, in the foreground, in the background without stealing focus, or headless.

### What changed in v0.3

- Agent integration moves from a P1 add-on to a design principle with its own section (7) and ships in v1.
- From Sizzy: projects tied to a repo path and dev command, an embedded terminal, click and input sync, isolated sessions per pane, inspect element across panes, and a command palette.
- New agent-oriented capabilities that neither reference product centres on: structured layout checks, a cursor-based "what changed since my edit" feed, and context packets ("Send to agent").

### Assumptions

- Primary user is a single developer testing their own sites, mostly `localhost` dev servers and staging URLs, often with a coding agent running alongside.
- macOS first. Windows and Linux render identically, but packaging and polish come later.
- Personal or open-source tool. No licensing, accounts or telemetry.

## 2. Problem

**For the developer.** Checking a responsive layout means dragging a window edge or cycling device presets one at a time. Bugs between breakpoints go unnoticed, and a console error that only fires at mobile width is missed because you are never at that width when it happens.

**For the agent.** A coding agent changing front-end code is mostly blind. It can run a type check, but it cannot see that the coupon field overflows at 390px, that dark mode lost contrast, or that the tablet layout throws a hydration error. Browser MCP servers exist, but they drive one viewport at a time in a separate browser the developer cannot see, with the developer's login state absent. The result is "it compiles, so it's done".

Breakpoint gives both the same window onto the app.

## 3. Goals and non-goals

### Goals

1. **Standalone first:** a complete, useful dev browser for a human with no agent installed. Agent support adds to it and never gates it.
2. See one URL at 3 to 6 viewport sizes simultaneously, with navigation, scroll, clicks and typing in sync.
3. One console showing everything Chrome DevTools would show, from all panes, labelled by pane.
4. Emulation good enough to trust: CSS viewport, DPR, touch, user agent, colour scheme.
5. **Agent parity:** every observation and action available in the UI is available as a CLI command and an MCP tool.
6. **Text before pixels:** agents get structured, compact answers (errors, layout issues, element geometry) first, and screenshots only when needed.
7. **Shared view, human in charge:** agent activity is visible, scoped and stoppable.

### Non-goals (v1)

- Reimplementing DevTools panels. Real DevTools opens per pane.
- Cross-engine testing. Chromium only.
- A custom AI chat UI. The agent is whatever CLI you already use; Breakpoint is its eyes and hands.
- Sizzy's wider surface: Photo Studio, video and GIF recording, API client, notes, todos, snippets, GitHub or Vercel timelines, reference tabs, in-page plugins.
- Polypane's audits: accessibility, SEO, social previews.
- Browser extension support.

## 4. Users and use cases

| # | As a… | I want to… | So that… |
|---|---|---|---|
| U1 | developer | open a project and have the URL, panes, sessions and dev server come back | setup is zero each morning |
| U2 | developer | see the page at several sizes, light and dark, at once | I catch layout and theme breaks as I code |
| U3 | developer | interact once and have every pane follow | I am not repeating every action N times |
| U4 | developer | see and filter console output from every pane in one place | width-specific errors are not missed |
| U5 | developer | be logged in as admin in one pane and customer in another | I test roles side by side |
| U6 | developer | right-click an error, element or pane and send it to my agent | the agent gets precise context, not my paraphrase |
| U7 | agent | ask what errors and layout problems exist right now, per pane | I find issues without vision or guesswork |
| U8 | agent | ask what changed since my last edit | I know whether my change fixed it or broke something else |
| U9 | agent | get one composite screenshot of all panes, or one element in every pane | I verify visually at low token cost |
| U10 | agent | navigate, click and type in the user's panes, within the project's origins | I can reach the state that reproduces the bug |
| U11 | developer | see what the agent is doing in my browser and stop it instantly | I stay in control |
| U12 | agent | run one shell command that opens the app on this repo, starting it if needed, without stealing the user's focus | I can begin verifying with no setup and no MCP config |
| U13 | developer | use the whole app with agent features switched off | it is a good dev browser on its own, and nothing agent-related clutters the UI |
| U14 | developer | run `breakpoint check` in a script or git hook | layout and console checks work without any AI involved |

## 5. Reference products: what to take

| | Polypane | Sizzy | Breakpoint v1 |
|---|---|---|---|
| Synced multi-viewport canvas | Yes | Yes | Yes |
| Unified console | Yes | Yes | Yes, CDP-based |
| Click and input sync | Yes | Yes | P1 |
| Isolated sessions per pane | Limited | Yes | P1 |
| Projects tied to repo and dev command | No | Yes | Yes |
| Terminals in the window | No | Yes | P1 |
| Agents | No | Embedded Claude Code and Codex sessions, screenshots attached to prompts | CLI first, MCP second, embedded terminal third; all optional |
| Audits, studio, API client and the rest | Yes | Yes | Out of scope |

Sizzy hosts the agent inside the browser. Breakpoint inverts that: the browser is a tool the agent uses, wherever the agent runs (terminal, tmux, editor, scripts). The embedded terminal then gives Sizzy's convenience for free, because the agent CLI running inside it calls the same `breakpoint` command.

## 6. Functional requirements

Priority: **P0** = required for v1, **P1** = fast follow, **P2** = later.

### 6.1 Projects

| ID | Requirement | Pri |
|---|---|---|
| J1 | A project stores: name, repo path, start URL, allowed origins, pane set, layout, sessions, dev command | P0 |
| J2 | `breakpoint .` from a repo opens or creates the project for that path | P0 |
| J3 | Project switcher (`⌘P`); last state restores exactly | P0 |
| J4 | Optional dev command runs as a managed process with output in a Processes tab; started and stopped with the project | P1 |
| J5 | Project config can live in the repo (`.breakpoint.json`) so panes and origins are shared and visible to agents | P1 |

### 6.2 Panes and emulation

| ID | Requirement | Pri |
|---|---|---|
| V1 | Default set: Mobile 390×844, Tablet 820×1180, Desktop 1440×900 | P0 |
| V2 | Add a pane from a preset or custom width × height; presets are user-editable JSON | P0 |
| V3 | Pane header: name, live CSS viewport, DPR, session, emulation badges, error count, degrading through the six-tier ladder as the pane narrows on screen ([ADR-0010](adr/0010-header-degradation-ladder.md)) | P0 |
| V4 | Resize by typing or dragging; rotate | P0 |
| V5 | Presets carry DPR, user agent and mobile flag | P0 |
| V6 | Per-pane colour scheme: light, dark, system. "Duplicate as dark" shortcut | P0 |
| V7 | Touch emulation, on by default for mobile presets | P1 |
| V8 | Per-pane reduced motion, forced colours, `prefers-contrast`, print media | P1 |
| V9 | Panes generated from the page's own CSS breakpoints | P2 |
| V10 | Network throttling, offline, JavaScript off, locale | P2 |

Default presets: Mobile S 360×800 @3x, Mobile 390×844 @3x, Mobile L 430×932 @3x, Tablet 820×1180 @2x, Laptop 1280×800 @2x, Desktop 1440×900 @1x, Desktop L 1920×1080 @1x. Mobile and tablet presets set the mobile flag and touch.

### 6.3 Layout

| ID | Requirement | Pri |
|---|---|---|
| L1 | Horizontal layout on a scrolling canvas with canvas zoom (25–100%) | P0 |
| L2 | Zoom accepts `Fit`: the zoom at which all panes fit without scrolling. A zoom value, not a layout mode ([ADR-0009](adr/0009-fit-is-a-zoom-value.md)) | P0 |
| L3 | Focus layout: one pane at 100%, others as a strip | P0 |
| L4 | Zoom scales rendering only; each pane's CSS viewport stays at its declared size | P0 |
| L5 | Drag to reorder; vertical layout | P1 |

### 6.4 Navigation and sync

| ID | Requirement | Pri |
|---|---|---|
| N1 | One address bar navigates all panes. Bare `3000` expands to `http://localhost:3000` | P0 |
| N2 | Back, forward, reload, hard reload apply to all panes | P0 |
| N3 | Navigation in any pane, including SPA route changes, propagates | P0 |
| N4 | Scroll sync, proportional, with a toggle | P0 |
| N5 | No loops or jitter: events carry origin pane ID; receivers suppress re-emission | P0 |
| N6 | `window.open` and `target=_blank` never spawn windows | P0 |
| N7 | Self-signed certificates: auto-trust `localhost`; one-time per-host prompt otherwise | P0 |
| N8 | Click, hover, typing and form input sync, matched by a robust element locator, each toggleable | P1 |
| N9 | HMR works untouched; each pane holds its own websocket | P0 |

### 6.5 Sessions

| ID | Requirement | Pri |
|---|---|---|
| E1 | All panes share one persistent session by default: log in once, logged in everywhere | P0 |
| E2 | Named isolated sessions (own cookies, cache, storage), per project or global, assignable per pane | P1 |
| E3 | Clear one session without touching others | P1 |
| E4 | Panes on different sessions still sync navigation and scroll; input sync skips auth forms | P1 |

### 6.6 Console

| ID | Requirement | Pri |
|---|---|---|
| C1 | Capture all `console.*` calls from every pane, including before app scripts run | P0 |
| C2 | Uncaught exceptions and unhandled rejections with stack traces | P0 |
| C3 | Browser-generated entries: network failures, CORS, mixed content, CSP, deprecations | P0 |
| C4 | Entry shows level, pane badge, timestamp, message, `file:line:col` | P0 |
| C5 | Source-mapped locations, resolved to repo-relative paths when the project has a repo path | P0 |
| C6 | Filter by pane, level, source and text | P0 |
| C7 | Identical messages from several panes collapse into one row with pane badges | P0 |
| C8 | Lazily expandable object trees backed by live remote objects; static previews kept across navigation | P0 |
| C9 | Clear, preserve log, copy entry, copy all as text or JSON | P0 |
| C10 | REPL in one pane or all, with top-level `await` and history | P0 |
| C11 | Open real DevTools per pane | P0 |
| C12 | Dockable bottom or right; pane header flashes on error | P0 |

C5 is P0 because agents need file paths, not bundle offsets.

### 6.7 Inspect, network, capture, terminal

| ID | Requirement | Pri |
|---|---|---|
| I1 | Inspect mode: hover highlights the matching element in every pane; click selects it | P1 |
| I2 | Selected element panel: selector, per-pane box size and position, key computed styles, per-pane visibility | P1 |
| R1 | Request list per pane with method, URL, status, type, size, duration; failed highlighted | P1 |
| R2 | Request detail with headers and body where retrievable; link from console network errors | P1 |
| S1 | Screenshot one pane to clipboard or file | P0 |
| S2 | Composite screenshot of all panes, labelled | P0 |
| S3 | Full-page and single-element screenshots | P1 |
| T1 | Terminal tabs (xterm.js and node-pty) opening in the project directory | P1 |
| T2 | Command palette for every action (`⌘⇧P`) | P1 |

S2 is P0 because it is the agent's cheapest visual check.

## 7. Agent integration

### 7.1 Principles

1. **Optional.** With agent access off (the default), the app has no open sockets beyond the CLI's launch channel, no Agent tab, no toolbar chips and no agent wording in menus. Layout checks, composite screenshots and context packets are still there, because they are useful to a human too: "Send to agent" simply becomes "Copy as Markdown".
2. **Parity.** UI actions and agent tools call the same main-process service layer. A feature is not done until it has a tool.
3. **Text before pixels.** Structured answers first. Images are opt-in, downscaled and composited.
4. **Cursor-based.** Every log entry, request, navigation and layout finding has a monotonic ID. Agents poll with `since` and get only what is new.
5. **Compact by default.** Deduped across panes, truncated with explicit markers, source-mapped to repo paths. Verbose is a flag.
6. **Shared view.** The agent uses the developer's panes and sessions, visibly.
7. **Scoped.** The agent can only reach the project's allowed origins. Page content is always treated as untrusted data.

### 7.2 Surfaces

| Surface | Purpose | Pri |
|---|---|---|
| **CLI** | The primary surface. Launches the app and exposes every tool as a shell command with JSON output. Works for any harness with a shell (Claude Code, Codex and others), for scripts and hooks, and for humans. No configuration step | P0 |
| **Agent guide** | `breakpoint agent-guide` prints a short, token-lean usage guide. "Set up for agents" offers to add it to the project's agent rules file or install it as a skill | P0 |
| **MCP server** | Same tools, typed. Streamable HTTP on `127.0.0.1` with a bearer token, plus `breakpoint mcp` as a stdio shim. For harnesses without a shell, or where typed tools are preferred | P1 |
| **Send to agent** | Context packets from the UI (7.5) | P0 |
| **Embedded terminal** | Run the agent CLI inside the window (T1) | P1 |
| **Agent workspace** | A hidden pane set the agent can drive without moving the developer's panes | P2 |

### 7.3 CLI

**Install.** "Install command line tool" in the app menu symlinks `breakpoint` onto the `PATH`, the way editors do. Also offered on first run.

**Launch behaviour**

| Command | Behaviour | Phase |
|---|---|---|
| `breakpoint .` or `breakpoint <path>` | Open or create the project for that repo. Starts the app if it is not running; otherwise hands off to the running instance | 1 |
| `breakpoint open <url>` | Open a URL in the current project, or an ad hoc one | 1 |
| `--wait` | Block until the project is loaded and settled, then print state. Lets an agent do `breakpoint . --wait --json` as its first step | 1 |
| `--no-launch` | Fail with exit code 3 if the app is not running, instead of starting it | 1 |
| `breakpoint quit` | Quit the app | 1 |
| `--background` | Start or hand off without activating the window. Best effort in Phase 1 (`open -g` on macOS); hardened in Phase 6, where it also becomes the default when stdout is not a TTY | 1, then 6 |
| `--headless` | Start with no visible window. Panes render offscreen; all commands work. For scripts, hooks and agent-only runs | 6 |

**Commands** (each maps one to one onto a tool in 7.4)

```
# Phase 1
breakpoint state                         # project, URL, panes, cursor
# Phase 2
breakpoint logs [--errors] [--pane M] [--since <cursor|5m>]
breakpoint changes --since <cursor>
# Phase 3
breakpoint nav <url> | reload [--hard] | back | forward
breakpoint settle [--timeout 10s]               # simple heuristic first
# Phase 4
breakpoint shot [--all | --pane M] [--selector …] [--full] [-o file.png]
breakpoint check [--pane M] [--selector …]      # layout findings
breakpoint assert-clean --since <cursor>
breakpoint agent-guide
# Phase 6 and later
breakpoint click|type|press|scroll|hover …      # act tier
breakpoint panes set … | emulate …              # act tier
breakpoint eval --pane M '<expr>'               # evaluate tier
breakpoint element <selector>
breakpoint outline [--pane M]
breakpoint network [--failed] [--since …]
```

**Conventions**

- Human-readable output on a TTY; `--json` (automatic when piped) gives the same schema as the MCP tool result, including the new cursor.
- Screenshots are written to a file and the path is printed, so harnesses that can read images do so by path and text-only ones skip them.
- Exit codes: `0` success or clean, `1` findings or assertion failed, `2` usage error, `3` app not running or unreachable, `4` denied by permission tier, `5` paused by user.
- `breakpoint check` and `assert-clean` are designed for non-AI use too: pre-push hooks, npm scripts, or a harness's post-edit hook.
- `--help` is short and example-led. The agent guide is under 60 lines.

**Permissions.** Until Phase 6 there is one switch: "Allow CLI access", off by default, prompting once the first time a command is refused. It covers everything shipped before then, all of which is read-only apart from navigation and reload, and those are held to the project's origin allow-list from the start. The three-tier model (Observe, Act, Evaluate in 7.7) arrives in Phase 6 together with the first commands that need it; a denied command exits `4` and says which toggle is off. Tier toggles live in user-level app settings only. They are never read from `.breakpoint.json`, so cloning a repo cannot grant an agent control of the browser.

### 7.4 Tools (CLI commands and MCP tools)

Tool names below are the MCP names; the CLI equivalents are listed in 7.3.

**Observe** (on when agent access is enabled)

| Tool | Returns |
|---|---|
| `get_state()` | Project, URL, panes (id, name, size, DPR, scheme, session), sync settings, latest cursor |
| `get_console({ pane?, level?, since?, limit? })` | Deduped entries with pane list, repo-relative source location, trimmed stack |
| `get_network({ pane?, failedOnly?, since? })` | Requests with status, timing and failure reason |
| `get_changes({ since })` | Everything new since a cursor: errors, failed requests, navigations, reloads, layout findings, resolved findings |
| `check_layout({ pane?, selector? })` | Structured layout findings per pane (7.6) |
| `get_element({ selector })` | Per pane: exists, visible, box, overflow state, key computed styles, text |
| `get_page_outline({ pane })` | Compact accessibility-tree outline: landmarks, headings, interactive elements with locators |
| `screenshot({ pane? , all?, selector?, fullPage?, maxSize? })` | Image, downscaled by default. `all` returns one labelled composite. `selector` returns that element cropped from every pane side by side |

**Act** (separate toggle, off by default)

| Tool | Notes |
|---|---|
| `navigate({ url })`, `reload({ hard? })`, `back()`, `forward()` | URL must match the project's allowed origins |
| `click`, `type`, `press`, `scroll`, `hover` with `{ pane?, locator }` | Dispatched as real input through CDP; follows the sync settings, so one call can drive all panes |
| `set_panes([...])`, `set_emulation({ pane, scheme?, touch?, … })` | Lets the agent add a 320px pane to chase a bug |
| `wait_for_settled({ timeout? })` | Resolves when HMR has applied, network is idle and no new logs for a short window. Returns the new cursor |

**Evaluate** (third toggle, off by default)

| Tool | Notes |
|---|---|
| `evaluate({ pane, expression })` | Arbitrary JS in the page. Separate because it can read anything the session can |

**Verify** (P1)

| Tool | Notes |
|---|---|
| `baseline({ name })`, `compare({ name })` | Per-pane screenshots stored, then pixel-diffed; returns changed regions and percentages per pane, with a diff image on request |
| `assert_clean({ since })` | Pass or fail: no new errors, failed requests or layout findings since the cursor |

The intended agent loop, in CLI form: `breakpoint . --wait --json` → edit code → `breakpoint settle` → `breakpoint changes --since $CURSOR` → `breakpoint check` → `breakpoint shot --all` only if needed → done when `breakpoint assert-clean` exits `0`.

### 7.5 Context packets ("Send to agent")

Right-click a console entry, an element, a failed request or a pane header and choose **Send to agent**. Breakpoint builds a packet:

- What: the error with source-mapped stack, or the element's selector and outer HTML (trimmed), or the request.
- Where: URL, the panes affected and the panes not affected, with sizes, DPR, scheme and session name.
- Evidence: element-cropped or pane screenshots saved to a project temp folder, referenced by path.
- For elements: per-pane box and the computed styles that differ between affected and unaffected panes. This difference is usually the bug.
- Optional developer note.

Delivery, in order of preference: pasted as a prompt into the focused embedded terminal, queued for pickup (`breakpoint context pop`, or `get_pending_context()` over MCP), or copied to the clipboard as Markdown with image paths. With agent access off, only the clipboard option is shown, labelled "Copy as Markdown".

P2: map an element to its component source file when the project's dev build exposes it (for example via a source-location Babel or SWC plugin). React 19 no longer exposes this by default, so it needs opt-in tooling.

### 7.6 Layout checks

Deterministic detectors that run in each pane and report findings as data. This is what lets an agent find responsive bugs without vision.

| Finding | Detection | Pri |
|---|---|---|
| Horizontal page overflow | Document `scrollWidth` exceeds viewport; reports the widest offending elements | P0 |
| Element overflows its container or the viewport | Box geometry against ancestors with clipping | P0 |
| Clipped or truncated text without ellipsis intent | `scrollWidth > clientWidth` on text containers with `overflow: hidden` | P1 |
| Overlapping interactive elements | Intersecting boxes of focusable elements | P1 |
| Tap targets under 44×44 CSS px on touch panes | Box size of interactive elements | P1 |
| Text under 12px on mobile panes | Computed font size | P1 |
| Content hidden in one pane but visible in others | Cross-pane visibility diff for the same locator | P1 |
| Images rendered far larger or smaller than intrinsic size | Natural size against box and DPR | P2 |

Each finding carries pane, locator, box, a one-line description and a stable ID so `get_changes` can report it as resolved. Findings also appear in a **Layout** tab in the panel for the developer, with click-to-highlight.

### 7.7 Human in the loop

- **Agent tab:** live log of tool calls with arguments, duration and result size. Click a call to see what was returned.
- **Presence:** panes show a coloured border and an "Agent" chip while an act tool is running. Agent-dispatched clicks show a brief ripple.
- **Stop:** `Esc Esc` or a toolbar button pauses all agent tools instantly; calls return a "paused by user" result.
- **Tiers:** Observe, Act and Evaluate are separate per-project toggles, shown in the toolbar.
- **Your input wins:** if the developer interacts with a pane during an agent action, the agent action is cancelled.

### 7.8 Agent-specific security

- **Origin allow-list.** Act tools and agent-initiated navigation are limited to the project's allowed origins (default: the start URL's origin and `localhost`). This stops a prompt-injected agent from driving the developer's logged-in sessions to arbitrary sites.
- **Untrusted content labelling.** Tool results that contain page-controlled text (console output, DOM text, network bodies) are wrapped and labelled as untrusted page data, and never mixed with tool instructions.
- **Secrets.** Cookies, `Authorization` headers and storage values are redacted from tool results by default.
- **Auth.** The CLI talks to the app over a Unix domain socket (named pipe on Windows) in the user's app data directory with owner-only permissions. The MCP HTTP server uses a random bearer token stored in the OS keychain, binds to loopback only, and is off until enabled.
- **No repo-granted permissions.** Tier toggles are user settings, never project config (7.3).
- **Session choice.** A project can pin the agent to a named session (E2), for example a low-privilege test user rather than the admin login.

## 8. Technical approach

### 8.1 Stack

- **Shell:** Electron (current stable), `electron-vite`, `electron-builder`.
- **UI renderer:** React, TypeScript, Zustand, Tailwind, shadcn/ui. Detail in 8.2.
- **Main process:** TypeScript. A service layer (`PaneService`, `ConsoleService`, `NetworkService`, `LayoutService`, `CaptureService`, `SyncService`, `ProjectService`) consumed by three thin adapters: UI IPC, MCP server, CLI socket.
- **CLI:** a small launcher script that runs a bundled `cli.js` under the app's own runtime in Node mode, the approach editors use, so there is no separate Node dependency. It connects to the app's local socket, and if none exists, starts the app (`open -g` on macOS for background launch) and waits for the socket. Single-instance lock with argv hand-off covers the double-launch case.
- **MCP:** official TypeScript SDK. **Terminal:** xterm.js and node-pty. **Image diff:** pixelmatch.
- **Persistence:** JSON in `userData`, plus optional `.breakpoint.json` in the repo.

### 8.2 UI stack

Electron's renderer is Chromium, so there is no Electron-specific UI kit to choose. The requirement is a dense, keyboard-driven desktop tool that does not look or feel like a web page.

**Decision: shadcn/ui on Tailwind, with Base UI primitives.**

- Component source is copied into the repo and owned, so everything can be tightened to devtools density. Pre-styled kits (MUI, Mantine, Ant) resist that and read as web apps.
- Headless primitives supply focus management, keyboard navigation, menus and dialogs correctly without design opinions.
- Coding agents write shadcn and Tailwind fluently, which matters if an agent builds much of the app.
- Base UI has been the default primitive layer for new shadcn/ui projects since July 2026; Radix remains supported. A fresh project takes the default.

**Supporting libraries**

| Need | Choice | Notes |
|---|---|---|
| Console and network lists | react-virtuoso (or TanStack Virtual) | The performance-critical part of the UI. Needs variable row heights and stick-to-bottom, which Virtuoso handles out of the box |
| Panel splits | `react-resizable-panels` (shadcn Resizable) | Canvas and panel, bottom or right docking |
| Command palette and project switcher | `cmdk` (shadcn Command) | |
| Console object tree | Custom component | Existing JSON viewers assume the whole object is in memory; this one expands lazily over CDP (`Runtime.getProperties`) |
| Terminal | xterm.js with node-pty | |
| Icons | Lucide | |
| Toasts | Sonner (shadcn) | Screenshot saved, agent paused, certificate prompts |
| State | Zustand | UI state only. Source of truth stays in main-process services; the renderer holds a projection fed over IPC |

**Density and look**

- Base font 12–13px, row height 24–28px, 4px spacing grid, monospace for console, locations and dimensions.
- Override shadcn's default sizes once in the copied components rather than per use.
- Theme through CSS variables, following the system via `nativeTheme`, with a manual override. Pane content is unaffected; per-pane colour scheme is emulation (8.5), not app theme.
- Pane badge colours are fixed per pane and reused everywhere: header, console rows, layout findings, composite screenshot labels.

**Electron-specific conventions**

- **Native menus** (`Menu.buildFromTemplate`) for the application menu and all right-click context menus, including "Send to agent" and "Copy as Markdown". They feel correct on macOS, and they still work if `PaneHost` ever falls back to `WebContentsView`, where HTML popovers cannot draw over panes.
- HTML popovers and dropdowns are kept inside the toolbar and panel regions wherever possible, for the same reason.
- `titleBarStyle: 'hiddenInset'` on macOS, toolbar as the drag region (`-webkit-app-region: drag`), controls marked `no-drag`.
- `user-select: none` on all chrome; selection enabled in the console, network detail and terminal.
- No web-style focus rings on mouse click; visible focus on keyboard navigation only (`:focus-visible`).
- All shortcuts registered once in a central keymap that feeds the native menu, the command palette and the in-app hint text, so they never drift apart.

**Considered and not chosen:** React Aria Components (most rigorous accessibility, more styling work; the fallback if Base UI disappoints), Mantine (batteries included, web-app look), Fluent and Ant (wrong aesthetic, heavy).

### 8.3 Process model

```
     coding agent / scripts / hooks               developer
     ┌────────┴──────────┐                            │
     │ CLI (local socket)│ MCP (optional)             │
┌────▼───────────────────▼────────────────────────────▼─────┐
│ main process                                              │
│  adapters:  CLI server │ MCP server │ UI IPC (typed)      │
│  services:  Pane  Console  Network  Layout  Capture  Sync │
│  stores:    event log with monotonic cursor               │
└────────┬──────────────────────────────────▲───────────────┘
         │ hosts                            │ CDP (webContents.debugger)
┌────────▼──────────┐             ┌─────────┴──────────────────┐
│ UI renderer       │  <webview>  │ pane webContents × N       │
│ canvas, panels    ├────────────▶│ sandboxed, no preload,     │
│ agent tab         │             │ no Node, session partition │
└───────────────────┘             └────────────────────────────┘
```

Pane content has no IPC channel. Everything the app learns from a pane arrives over CDP, which the page cannot see or spoof.

### 8.4 Hosting panes

**`<webview>` for v1**, behind a `PaneHost` abstraction. It lives in the DOM, so it scrolls with the canvas, can be clipped and overlaid by HTML (needed for agent presence borders, inspect highlights and click ripples), and is what Responsively App uses. Electron's docs advise considering alternatives because the underlying Chromium component may change, hence the abstraction. `WebContentsView` is the fallback, at the cost of the scrolling canvas and overlays. Both yield a normal `webContents`, so all CDP code is identical.

### 8.5 Emulation

All via CDP, reapplied on attach and on `did-navigate`. **Not** reapplied on renderer process swap: overrides were measured surviving real swaps untouched, so no swap listener and no user-visible event ([ADR-0002](adr/0002-no-reapply-on-process-swap.md)). The overrides: `Emulation.setDeviceMetricsOverride` (true CSS viewport independent of on-screen size, which enables canvas zoom), `setUserAgentOverride` with client hints, `setTouchEmulationEnabled`, `setEmulatedMedia` for colour scheme, reduced motion, forced colours, contrast and print.

### 8.6 Event log and console pipeline

1. On attach: `Runtime.enable`, `Log.enable`, `Network.enable`, `Page.enable`. Enabling `Runtime` replays buffered messages, covering early logs.
2. `Runtime.consoleAPICalled`, `Runtime.exceptionThrown`, `Log.entryAdded` and `Network.*` events are normalised into one append-only event log with a monotonic cursor, ring-buffered per pane (10,000 entries).
3. Stack frames are source-mapped in main and resolved against the project's repo path.
4. The UI receives batches every 16 ms. MCP and CLI read the same log by cursor, with dedupe and truncation applied at read time.
5. Object expansion uses `Runtime.getProperties` on demand; previews are stored for after navigation.
6. REPL and `evaluate` use `Runtime.evaluate` with `replMode` and `awaitPromise`.

### 8.7 Sync and input

- **Navigation:** `did-navigate` and `did-navigate-in-page` cover full loads and SPA routes.
- **Scroll:** a script installed with `Page.addScriptToEvaluateOnNewDocument` in an isolated world reports a throttled scroll ratio through `Runtime.addBinding`.
- **Clicks and typing (P1):** the same isolated-world script captures events and computes a locator (test id, then role and name, then a stable CSS path). Other panes resolve the locator and receive real input through `Input.dispatchMouseEvent` and `Input.insertText`. Agent act tools use the same locator resolver and the same dispatch path.
- **Layout checks:** run in the isolated world on demand and after `wait_for_settled`; results diffed against the previous run for stable finding IDs.

### 8.8 Security model (app)

- Panes: `sandbox: true`, `contextIsolation: true`, no Node, no preload. `will-attach-webview` enforces this regardless of renderer input.
- `webviewTag` only in the UI window; UI renderer context-isolated with a narrow typed preload.
- Popups denied; permission requests denied by default with a per-origin allow list.
- `http:` and `https:` only. Log text rendered as text nodes.
- Certificate overrides are per host, stored and visible in settings.
- Agent-specific controls are in 7.8.

## 9. UX outline

```
┌──────────────────────────────────────────────────────────────────┐
│ 🛒 storefront ▾  ◀ ▶ ⟳ [ localhost:3000/checkout ] ⇅sync 50% ＋  │
│                                    Agent: ● Observe ● Act ○ Eval │
├──────────────────────────────────────────────────────────────────┤
│ Mobile 390×844 @3x ☾ ①  Tablet 820×1180 @2x    Desktop 1440×900  │
│ ╔═══════╗ agent         ┌───────────┐          ┌─────────────────│
│ ║       ║               │           │          │                 │
│ ║       ║               │           │          │            ···▶ │
│ ╚═══════╝               └───────────┘          └─────────────────│
├──────────────────────────────────────────────────────────────────┤
│ Console │ Layout ② │ Network │ Agent │ Terminal │ Processes      │
│ ● M      12:04:02 TypeError: reading 'coupon'   Checkout.tsx:88  │
│ ▲ M T    12:04:02 .coupon-row overflows viewport by 34px         │
│ ⚙ agent  12:04:09 check_layout → 2 findings · 412 B · 38 ms      │
└──────────────────────────────────────────────────────────────────┘
```

Keyboard: `⌘P` projects, `⌘⇧P` palette, `⌘L` address bar, `⌘R` reload all, `⌘J` panel, `⌘1…9` focus pane, `⌘0` fit, `⌘K` clear, `⌘⌥I` DevTools, `⌘⇧S` screenshot all, `⌘⇧A` send selection to agent, `Esc Esc` stop agent.

## 10. Non-functional requirements

| Area | Target |
|---|---|
| Cold start to usable | < 2 s on Apple Silicon |
| Memory | Shell under 300 MB; per-pane memory shown in the pane menu |
| Console throughput | 2,000 entries/s across panes without jank |
| Sync latency | < 50 ms pane to pane |
| Pane count | Smooth with 6; usable with 10 |
| MCP latency | Observe tools < 100 ms; `screenshot({ all })` < 500 ms for 3 panes |
| Tool result size | Text tools default under ~2 KB; composite screenshot default 1,280 px on the long side |
| Crash isolation | A crashed pane shows a reload overlay; app, other panes and MCP server keep running |

## 11. Milestones

### Build rule

**No feature is done until it has a service method. A CLI command is added in the same phase when it costs under an hour on top of that method.** If it costs more, it is deferred and noted.

This keeps the CLI from becoming a project of its own, and makes it the test harness for the app while it is being built: every phase's exit criteria are checked from a terminal as well as by eye, and the agent loop is dogfooded from Phase 2 onwards.

### Foundations built in Phase 1 (non-negotiable)

- **Service layer.** All behaviour lives in main-process services. React components, IPC handlers and CLI handlers are thin callers. This is the decision that makes everything in section 7 cheap later, and the one that is expensive to retrofit.
- **Event log with a monotonic cursor.** The console needs it anyway; agents need it for `changes`.
- **Local socket and command router.** One JSON request and response protocol. A CLI command is a route name plus a service call.
- **Single-instance lock with argv hand-off**, and the `breakpoint` launcher script.

### Phases

| Phase | App scope | CLI shipped alongside | Exit criteria |
|---|---|---|---|
| **0. Spikes** (2 days) | Section 12, items 1–3 (item 4 moves to Phase 6) | None | Pane host chosen; emulation and CDP coexistence verified |
| **1. Panes and projects** (1.5 weeks) | Foundations above, PaneHost, emulation, presets, layouts, projects, certs | `breakpoint .`, `open`, `state`, `quit`, `--wait`, `--no-launch`, best-effort `--background`, `--json` | Three panes render localhost at 50% zoom with each pane's **rendered element size** matching its declared size × zoom, verified host-side, plus a hit test near a pane's bottom edge ([ADR-0004](adr/0004-pane-geometry-is-verified-host-side.md)); DPR and scheme correct; project restores; `breakpoint . --wait --json` from a terminal prints the pane set |
| **2. Console** (1 week) | Console pipeline on the event log, source maps, console UI, filters, dedupe, REPL, DevTools button | `logs`, `changes` | A CORS error and a mobile-only exception appear with repo-relative paths, in the UI and in `breakpoint logs --errors --json` |
| **3. Sync** (3 days) | Navigation and scroll sync, origin allow-list | `nav`, `reload`, `back`, `forward`, `settle` (network idle plus 500 ms of log silence) | Works on a Next.js app and a Vite SPA; `breakpoint nav` moves all panes |
| **4. Capture and checks** (1 week) | Pane and composite screenshots, P0 layout checks, Layout tab, "Copy as Markdown" context packets | `shot`, `check`, `assert-clean`, `agent-guide`, exit codes 0–3 | Claude Code in a terminal, with no MCP configured, fixes a seeded mobile overflow bug using only observe commands, navigation and one composite screenshot. `breakpoint check` works in a git hook |
| **5. Polish** (1 week) | Shortcuts, settings, crash overlay, "Install command line tool", packaging, notarisation | None | Daily-driver quality on macOS |
| **v1 ships here** | | | Roughly six weeks. Standalone-complete, and agent-usable for observe, navigate and verify |
| **6. Agent control** | Input sync (N8) and its locator and dispatch path first, then act commands on top of it; three permission tiers; Agent tab, presence borders, stop control; "Send to agent" delivery to terminal and queue; hardened `--background` and `--headless` | `click`, `type`, `press`, `scroll`, `hover`, `panes set`, `emulate`, `eval`, `context pop`, exit codes 4–5 | An agent reproduces a bug that needs a form filled in, while the developer watches and can stop it with `Esc Esc` |
| **7. Fast follows** | Sessions, inspect mode, network panel, terminal and processes, remaining layout checks, baseline and compare, palette, MCP server and stdio shim | `element`, `outline`, `network`, `baseline`, `compare`, `mcp` | |
| **Later** | Agent workspace, component source mapping, throttling, breakpoint detection, HMR-aware `settle` | | |

### Deliberately deferred, and why

| Item | Why it waits |
|---|---|
| `--headless` and guaranteed no-focus-steal launch | macOS windowing and offscreen rendering quirks; high time risk, low v1 value since the developer usually has the app open already |
| Act commands | Depend on the locator resolver and CDP input dispatch, which input sync needs anyway. Building them together avoids doing it twice |
| Three permission tiers, Agent tab, stop control | Nothing to gate or observe until act commands exist. One on/off switch is enough for read-only access |
| HMR-aware `settle` | Per-bundler heuristics are a rabbit hole. The simple version is good enough to learn whether it matters |
| Separate CLI executable | Only needed if the `RunAsNode` fuse is disabled. For a personal or early build, leave the fuse on |
| MCP server | The CLI covers every harness with a shell. MCP is a thin adapter over the same router whenever it is wanted |

## 12. Spikes and risks

| # | Question | Why it matters | Fallback |
|---|---|---|---|
| 1 | `<webview>` with 6+ panes, scaled, without input offset or blur | Layout architecture, overlays | `WebContentsView`, Fit and Focus only |
| 2 | ~~App attachment and real DevTools on one pane simultaneously~~ **Answered:** DevTools never evicts our attachment. No paused state; no detach signal exists to build one on ([ADR-0003](adr/0003-no-paused-state-for-devtools.md)) | | |
| 3 | ~~Emulation overrides across cross-origin navigations and process swaps~~ **Answered:** overrides survive process swaps untouched ([ADR-0002](adr/0002-no-reapply-on-process-swap.md)). Note `innerWidth` is *not* sufficient evidence — it reports the emulated viewport whether or not it is rendered ([ADR-0004](adr/0004-pane-geometry-is-verified-host-side.md)) | | |
| 4 | `Input.dispatch*` events land correctly in a CSS-scaled, emulated `<webview>` | Act tools and click sync | Dispatch via element-centre coordinates computed in page space; fall back to `element.click()` with a warning |
| 5 | `settle` reliability across Vite, Next and Webpack HMR | The agent loop depends on it | v1 ships the simple heuristic (network idle plus log quiet). If it proves flaky, add an optional per-project hook into the dev server's HMR websocket |
| 6 | Layout check false positives (carousels, intentional overflow, off-canvas menus) | Noise makes agents chase non-bugs | Ignore list in `.breakpoint.json`; `data-breakpoint-ignore`; severity levels |
| 7 | Locator stability across breakpoints when DOM differs per viewport | Sync, `get_element`, packets | Locator fallback chain; report "no match in pane X" as data, which is itself useful |
| 8 | CDP event volume with 6+ panes | Main-process responsiveness | Enable `Network` lazily; move CDP handling to a utility process |
| 9 | Prompt injection via page content | Agent safety | Controls in 7.8; act tier off by default |
| 10 | Running the CLI under the app's runtime in Node mode relies on Electron's `RunAsNode` fuse staying enabled, which hardening guides suggest disabling | CLI architecture; not a v1 concern | Leave the fuse enabled for v1. If distributing widely, ship the CLI as a separate single-file executable |
| 11 | Background and headless launch on macOS: no focus steal, no Dock bounce, offscreen panes still render and screenshot correctly | U12; agents must not interrupt the developer. Phase 6, not v1 | v1 uses best-effort `open -g`. Floor is a visible but unfocused window |
| 12 | `<webview>` long-term support | Electron may change it | `PaneHost` abstraction; revisit each major |

## 13. Success criteria

- It replaces manual resizing and DevTools device mode for daily responsive work within two weeks of Phase 2.
- With agent access off, nothing in the app hints that agents exist, and it is still the preferred way to do responsive work.
- An agent with only shell access resolves a responsive bug end to end, using text tools for diagnosis and at most one composite screenshot for confirmation.
- Agents stop declaring front-end work done while the console still has errors: `get_changes` after an edit becomes a habitual step in the agent's project rules.
- At least one width-specific or theme-specific bug is caught by `check_layout` before a human notices it.

## 14. Open questions

1. Personal tool or open source from day one? Affects signing, notarisation, auto-update and naming.
2. Should the agent default to the developer's panes (shared view) or its own hidden workspace? v1 assumes shared; heavy agent use may make hidden the better default.
3. Should Breakpoint ship agent rules (the agent guide in 7.2) and offer to add them to the project? Likely yes, and cheap.
4. How much act capability is really needed in v1? Observe plus `navigate`, `reload` and `wait_for_settled` may cover most value, with click and type following once input sync (N8) has proven the locator and dispatch path.
5. Is an embedded agent chat UI ever needed, or is terminal plus CLI enough? Sizzy built the former; this PRD bets on the latter.
6. ~~Should "Allow CLI access" be on by default?~~ **Resolved: on.** A same-user process can already read `userData` directly, so the socket widens nothing; off by default would make U12's zero-config promise false. Revisit in Phase 6, when act commands change the stakes ([ADR-0008](adr/0008-cli-access-on-by-default.md)).
