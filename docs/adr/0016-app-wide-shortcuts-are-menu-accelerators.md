# App-wide shortcuts are menu accelerators, and what they change is snapshot state

Keyboard shortcuts are bound on the application menu, in the main process. A shortcut's
item causes a route, exactly as the button beside it does, and the state it changes is in
the snapshot like every other piece of state.

The first of them is ⌘P for the project switcher, which is why this was decided (#38).

## Why the renderer cannot hold a shortcut

Every pane is an out-of-process `<webview>`. Once one has focus, key events are delivered
to the guest's `webContents` and never reach the host document, so a
`window.addEventListener('keydown')` in the renderer answers only while the app's own
chrome has focus. Clicking into a page is what Breakpoint is for, so that is the
exceptional case: a shortcut bound that way is dead almost all of the time.

A menu accelerator is answered before any `webContents` sees the key. It fixes every
future shortcut at once rather than one call site, and the app needs a real menu to ship
anyway — it ran on Electron's default until now.

The alternative was `before-input-event` on each pane's `webContents`. It works, but it
has to be re-wired for every new shortcut, and it puts a keyboard map in the pane host.

## Why that forces the state out of the renderer

An accelerator fires in the main process. The switcher's open state was renderer-local
`useState`, so the accelerator had nothing to reach — and a main-to-renderer message
saying "open the switcher" is exactly the UI-only channel
[ADR-0005](0005-one-route-table-no-ui-only-routes.md) exists to refuse.

So whether the switcher is showing is snapshot state. `app.setSwitcher` sets it, an
`app.switcher` patch announces it, and the accelerator, the toolbar button and Escape all
cause that one route. It belongs to `AppService` rather than to a project, because the
switcher is the way into a project and outlives the one that is open.

## Consequences

The snapshot now carries something whose only reader is the UI. That is the cost, and it
is the smaller one: the route table stays the only way a surface causes anything, and the
CLI and MCP can show the switcher for free rather than as a retrofit. The test for a new
piece of UI state is not "does anything but the window read it" — it is whether a surface
can cause it, and a surface can cause this.

Opening a switcher that is already open is no longer a change, so it no longer re-reads
the project list. The list is still read every time it opens, which is what mattered: the
project directory is the list.

**No synthesised key can reach a native menu accelerator.** Probed against this app on
macOS: neither Playwright's `page.keyboard.press`, which dispatches over CDP, nor
`webContents.sendInputEvent` fires one, while both reach a `before-input-event` listener.
So the suite exercises a shortcut by choosing its menu item, and asserts the chord bound
to that item as data. What stays untested is the window server delivering a real keystroke
to the menu, which is the platform's to get right. A test that presses the chord and
expects it to arrive is testing nothing, and should not be written.

A key the menu claims is a key the panes never see, so the menu claims as few as it can:
no Print — ⌘P is the switcher's — and no View menu, whose ⌘R would throw away the app's
own renderer rather than reload a page. Edit is kept and kept as `role`s, which are
delivered to whichever `webContents` has focus, so ⌘C and ⌘V work inside a pane.
