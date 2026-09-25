<!--
  These are the notes `release.yml` publishes, verbatim. Edit this file and commit it
  BEFORE tagging — the notes ship with the release because they are part of the commit
  the tag points at.

  The three sections below are not optional while Breakpoint is pre-v1: which phase this
  is, what is degraded per platform, and what macOS users have to type. Everything else
  is yours.
-->

## What this is

Breakpoint is **Phase 1 of 7**. Panes, emulation, presets, layouts, projects, certificates
and the CLI foundations work. The console, scroll and navigation sync, screenshots and
layout checks do not exist yet.

This is a pre-release. It is useful, and it is not finished.

## What changed

<!-- Written by hand. Auto-generated commit lists are noise at this stage. -->

- A real app icon: the three bars from the site's logo, replacing the Electron
  template's atom. The site's favicon is now the same mark.
- Build tooling no longer ships inside `app.asar`.

Nothing about how the app behaves has changed since 0.1.0.

## Installing on macOS

Breakpoint is not code-signed yet. After moving `Breakpoint.app` to `/Applications`:

```sh
xattr -dr com.apple.quarantine /Applications/Breakpoint.app
```

No `sudo`, once per install. The GUI alternative is **System Settings → Privacy & Security
→ Open Anyway**, which only appears for about an hour after the app is blocked. Right-click
→ Open no longer works — Apple removed that bypass in macOS 15.

One universal build covers Apple silicon and Intel, which is why it is ~217MB.

## Platforms

| Platform | Status |
| --- | --- |
| macOS 13+ | Supported |
| Windows | Builds and runs; untested in anger |
| Linux (AppImage, deb) | Builds and runs; untested in anger |

Known defects on Windows and Linux:

- The window shows a native title bar **and** Breakpoint's own toolbar, with an empty gap
  where the macOS traffic lights would be.
- There is no `breakpoint` launcher on Windows. On Linux, adapt the one in the README.

## Getting the CLI

The CLI ships inside the app; the README has the five-line launcher that puts `breakpoint`
on your `PATH`.

**[README](https://github.com/jim-at-jibba/breakpoint#readme)** ·
**[Docs](https://breakpoint-app.netlify.app/docs/)** ·
**[Report a bug](https://github.com/jim-at-jibba/breakpoint/issues)**
