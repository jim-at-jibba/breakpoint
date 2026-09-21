# Breakpoint

A desktop dev browser that renders one URL at several viewport sizes at once, keeps them in
sync, and exposes everything it can see to a coding agent through a CLI. This glossary is the
project's vocabulary; use these words in code, issues, commits and docs.

## Language

### Panes and emulation

**Pane**:
One viewport rendering the project's URL at a declared size. The unit a developer thinks in,
and the unit almost everything else is keyed by.
_Avoid_: viewport, frame, window, device

**Preset**:
A named set of viewport properties — size, DPR, user agent, mobile flag — used to create a
pane. A template consulted at creation time, not a thing a pane belongs to.
_Avoid_: device, profile, template

**Attachment**:
The debugging connection between the app and one pane, over which all observation and
emulation travel. A pane with a broken attachment still renders.
_Avoid_: session, CDP session, debugger session, connection

**Emulation**:
The overrides that make a pane behave as its preset describes — viewport, DPR, user agent,
touch, colour scheme — rather than as the window it is drawn in.
_Avoid_: device mode, simulation, spoofing

**Pane colour scheme**:
Whether one pane renders the page as light or dark. A property of that pane, independent of
every other pane and of the app's own appearance.
_Avoid_: theme, dark mode

**App theme**:
Whether Breakpoint's own chrome is light or dark. Never affects page content, and shares no
mechanism with pane colour scheme.
_Avoid_: theme (unqualified), appearance

**Degraded**:
A pane that is rendering but whose attachment is missing or incomplete, so some observation
or emulation is unavailable. Distinct from a pane that failed to load.
_Avoid_: broken, errored, disconnected

### Canvas

**Canvas**:
The scrolling surface the panes are arranged on.
_Avoid_: stage, workspace, grid

**Zoom**:
How large the panes are drawn on the canvas. Changes rendered size only — a pane's viewport
stays at its declared size, which is the whole point.
_Avoid_: scale, page zoom

**Layout**:
How panes are arranged on the canvas: Horizontal or Focus. Fit is a zoom value, not a layout.
_Avoid_: mode, view, arrangement

### Projects and storage

**Project**:
A repo path plus everything Breakpoint remembers about working on it — URL, panes, layout,
allowed origins, dev command. Identified by its absolute repo path.
_Avoid_: workspace, site, app

**Session**:
An isolated store of cookies, cache and local storage that panes can share or be assigned
individually, so one pane can be an admin and another a customer.
_Avoid_: partition, profile, login, context

**Allowed origins**:
The origins a project's panes may be sent to programmatically. Constrains automation; never
constrains the developer.
_Avoid_: allowlist, whitelist, scope

### Observation

**Event log**:
The single append-only record of everything Breakpoint has observed — console output,
exceptions, network activity, navigation, pane lifecycle, and the app's own failures.
_Avoid_: history, buffer, stream, console

**Entry**:
One record in the event log, tagged with the pane it came from, or with nothing if the app
itself produced it.
_Avoid_: event, message, line, row

**Cursor**:
A monotonic position in the event log. A reader asks for everything after its cursor and is
told if anything was evicted before it arrived.
_Avoid_: offset, sequence, checkpoint, watermark

### Surfaces

**Surface**:
A way of driving Breakpoint: the UI, the CLI, and later MCP. Each surface can do everything
the others can.
_Avoid_: client, interface, frontend

**Adapter**:
The code that translates one surface's calls into routes. Holds no behaviour of its own.
_Avoid_: handler, controller, transport

**Route**:
One named operation in the single table every surface calls through. If a surface can cause
it, it is a route.
_Avoid_: command, endpoint, IPC channel, tool
