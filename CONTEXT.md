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
A named set of viewport properties — size, DPR, user agent, mobile flag, touch — used to
create a pane. A template consulted at creation time, not a thing a pane belongs to.
Global and user-editable JSON, shared by every project.
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
Everything Breakpoint remembers about working on something — URL, panes, layout, allowed
origins, dev command. Identified by its absolute repo path when it has one. A project opened
by typing a URL has no repo path, and so no identity: it is never stored and lasts as long as
the window ([ADR-0015](docs/adr/0015-repo-less-projects-are-ephemeral.md)). A URL is never a
project's identity, because a port is a lease rather than a name.
_Avoid_: workspace, site, app, canvas (for the repo-less case — it is a project too)

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

### State

**Snapshot**:
Everything a surface renders from, at one moment: the open project and the revision it is
current to. Returned by one route to every surface; the window fetches it and then keeps it
current with patches. `project.state` is the route that returns one.
_Avoid_: store, model, projection

**Patch**:
One typed change to the snapshot, from a fixed set of kinds. Numbered by revision and pushed
to the window in batches, one batch per frame. Never a path-and-value edit.
_Avoid_: event, delta, update, diff

**Revision**:
The count of patches the app has announced. A snapshot carries the revision it reflects, and
a window that sees a gap in the sequence fetches a fresh snapshot rather than guessing.
_Avoid_: version (that is the stored file's), sequence number, generation

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

### The site

**Site**:
Breakpoint's public web presence: the landing page and the Docs, built and deployed as one
thing. Never a synonym for Project — a Project is a repo someone is working on, the Site is
the page that advertises Breakpoint.
_Avoid_: website, marketing site, docs site

**Docs**:
The public user documentation published under `/docs` on the Site.
_Avoid_: handbook, guide, user docs, public docs

**Internal docs**:
Everything under the repository's `docs/` directory — the PRD, ADRs, handoffs, agent
instructions and design prototypes. None of it is published.
_Avoid_: docs (unqualified — that always means the public ones)

**Design prototype**:
A `.dc.html` file under `docs/design/`, and the source of truth for the layout, tokens and
design decisions it covers.
_Avoid_: mockup, design file, comp

**Demo**:
The mock of the Breakpoint app window shown on the Site. A depiction of the product, never
the product itself.
_Avoid_: preview, playground, sandbox
