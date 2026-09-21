# PaneHost is a seam, not an abstraction

§8.4 wants a `PaneHost` abstraction because Electron may change `<webview>` (§12 item 12).
The Phase 0 spike found no reason to switch to `WebContentsView`: all three conditions passed
on `<webview>`.

So `PaneHost` is one module that owns creating the element, attaching, and handing back a
`webContents` — not an interface with two implementations, and not a `WebContentsView`
implementation written speculatively.

## Consequences

Both hosts yield an ordinary `webContents`, so every line of observation and emulation code
is already portable; the real portability exists whether or not we write an interface. An
interface designed against a host nobody has run would freeze the wrong shape, and the cost
of introducing one later — when there is a second implementation to design against — is a
day.
